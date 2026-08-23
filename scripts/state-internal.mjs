#!/usr/bin/env node
import {
	closeSync,
	constants,
	fchmodSync,
	fstatSync,
	fsyncSync,
	lstatSync,
	linkSync,
	mkdirSync,
	openSync,
	readFileSync,
	readdirSync,
	realpathSync,
	renameSync,
	rmdirSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
	basename,
	dirname,
	isAbsolute,
	join,
	relative,
	resolve,
	sep,
} from "node:path";
import {
	PRIVATE_STATE_VERSION,
	StateKernelError,
	canonicalJson,
	parseStrictJsonBytes,
	validateActiveRun,
	validateCanonicalPath,
	validateGeneration,
	validateGitObjectId,
	validateId,
	validateJournalEntry,
	validateLockOwner,
	validateRepositoryDocument,
	validateRunState,
} from "./private-state-schema.mjs";

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const NOFOLLOW = constants.O_NOFOLLOW;
const DIRECTORY = constants.O_DIRECTORY ?? 0;

export function kernelError(code, message, cause) {
	const error = new StateKernelError(
		code,
		message,
		cause ? { cause } : undefined,
	);
	if (cause?.expectedIdentity !== undefined)
		error.expectedIdentity = cause.expectedIdentity;
	if (cause?.actualIdentity !== undefined)
		error.actualIdentity = cause.actualIdentity;
	return error;
}

export function checkpoint(fault, name) {
	if (typeof fault === "function") fault(name);
}

function currentUid() {
	if (typeof process.geteuid !== "function")
		throw kernelError("unsupported_platform", "effective uid is unavailable");
	return process.geteuid();
}

function requireNoFollow() {
	if (typeof NOFOLLOW !== "number")
		throw kernelError("unsupported_platform", "O_NOFOLLOW is unavailable");
}

export function lstat(path, code = "bookkeeping_unknown") {
	try {
		return lstatSync(path, { bigint: true });
	} catch (error) {
		if (error?.code === "ENOENT") return null;
		throw kernelError(code, "cannot inspect private state path", error);
	}
}

function assertPrivateDirectory(path) {
	const stats = lstat(path);
	if (!stats)
		throw kernelError(
			"bookkeeping_unknown",
			"private state directory is missing",
		);
	if (stats.isSymbolicLink())
		throw kernelError("state_symlink", "private state directory is a symlink");
	if (!stats.isDirectory())
		throw kernelError(
			"bookkeeping_unknown",
			"private state path is not a directory",
		);
	if (stats.uid !== BigInt(currentUid()))
		throw kernelError(
			"state_owner",
			"private state directory has a foreign owner",
		);
	if (Number(stats.mode & 0o777n) !== DIRECTORY_MODE) {
		throw kernelError(
			"state_permissions",
			"private state directory mode must be 0700",
		);
	}
	return stats;
}

function assertPrivateChain(root, target) {
	const resolvedRoot = resolve(root);
	const resolvedTarget = resolve(target);
	const suffix = relative(resolvedRoot, resolvedTarget);
	if (suffix === ".." || suffix.startsWith(`..${sep}`) || isAbsolute(suffix)) {
		throw kernelError(
			"bookkeeping_unknown",
			"private state path escapes its root",
		);
	}
	assertPrivateDirectory(resolvedRoot);
	let cursor = resolvedRoot;
	if (suffix) {
		for (const part of suffix.split(sep)) {
			cursor = join(cursor, part);
			assertPrivateDirectory(cursor);
		}
	}
}

export function fsyncDirectory(path) {
	requireNoFollow();
	let descriptor;
	try {
		descriptor = openSync(path, constants.O_RDONLY | NOFOLLOW | DIRECTORY);
		const stats = fstatSync(descriptor, { bigint: true });
		if (!stats.isDirectory())
			throw kernelError(
				"bookkeeping_unknown",
				"fsync target is not a directory",
			);
		fsyncSync(descriptor);
	} catch (error) {
		if (error instanceof StateKernelError) throw error;
		throw kernelError(
			"durability_unknown",
			"cannot fsync private state directory",
			error,
		);
	} finally {
		if (descriptor !== undefined) closeSync(descriptor);
	}
}

function ensurePrivateDirectory(path, { parentRoot = null, fault } = {}) {
	const existing = lstat(path);
	if (existing) return assertPrivateDirectory(path);
	if (parentRoot) assertPrivateChain(parentRoot, dirname(path));
	try {
		mkdirSync(path, { mode: DIRECTORY_MODE });
		checkpoint(fault, "after_directory_create");
		fsyncDirectory(dirname(path));
		checkpoint(fault, "after_directory_create_fsync");
	} catch (error) {
		if (error?.code === "EEXIST") return assertPrivateDirectory(path);
		if (error instanceof StateKernelError) throw error;
		throw kernelError(
			"durability_unknown",
			"cannot create private state directory",
			error,
		);
	}
	return assertPrivateDirectory(path);
}

function ensurePrivatePath(root, parts, fault) {
	ensurePrivateDirectory(root, { fault });
	let cursor = resolve(root);
	for (const part of parts) {
		if (!part || part === "." || part === ".." || part.includes(sep)) {
			throw kernelError(
				"invalid_state",
				"private state path component is invalid",
			);
		}
		cursor = join(cursor, part);
		ensurePrivateDirectory(cursor, { parentRoot: root, fault });
	}
	return cursor;
}

export function ensurePrivateSubdirectory(path, { root, fault } = {}) {
	if (!root)
		throw kernelError("invalid_state", "private directory root is required");
	const resolvedRoot = resolve(root);
	const resolvedPath = resolve(path);
	const suffix = relative(resolvedRoot, resolvedPath);
	if (
		!suffix ||
		suffix === ".." ||
		suffix.startsWith(`..${sep}`) ||
		isAbsolute(suffix)
	)
		throw kernelError(
			"path_mismatch",
			"private directory is outside its authority root",
		);
	return ensurePrivatePath(resolvedRoot, suffix.split(sep), fault);
}

function assertPrivateFileDescriptor(descriptor) {
	const stats = fstatSync(descriptor, { bigint: true });
	if (!stats.isFile())
		throw kernelError(
			"bookkeeping_unknown",
			"private state leaf is not a regular file",
		);
	if (stats.uid !== BigInt(currentUid()))
		throw kernelError("state_owner", "private state file has a foreign owner");
	if (Number(stats.mode & 0o777n) !== FILE_MODE)
		throw kernelError(
			"state_permissions",
			"private state file mode must be 0600",
		);
	if (stats.nlink !== 1n)
		throw kernelError(
			"bookkeeping_unknown",
			"private state file has an unexpected link count",
		);
	return stats;
}

export function readStablePrivateBytes(
	path,
	{ root, maxBytes = 1024 * 1024, allowEmpty = false } = {},
) {
	requireNoFollow();
	assertPrivateChain(root ?? dirname(path), dirname(path));
	let descriptor;
	try {
		descriptor = openSync(path, constants.O_RDONLY | NOFOLLOW);
		const before = assertPrivateFileDescriptor(descriptor);
		if (before.size > BigInt(maxBytes) || (!allowEmpty && before.size < 1n)) {
			throw kernelError("invalid_json", "private state file size is invalid");
		}
		const pathStats = lstatSync(path, { bigint: true });
		if (
			pathStats.isSymbolicLink() ||
			pathStats.dev !== before.dev ||
			pathStats.ino !== before.ino
		) {
			throw kernelError(
				"path_mismatch",
				"private state path no longer identifies the opened file",
			);
		}
		const bytes = readFileSync(descriptor);
		const after = assertPrivateFileDescriptor(descriptor);
		const finalPathStats = lstatSync(path, { bigint: true });
		if (
			before.dev !== after.dev ||
			before.ino !== after.ino ||
			before.size !== after.size ||
			BigInt(bytes.length) !== after.size ||
			finalPathStats.dev !== after.dev ||
			finalPathStats.ino !== after.ino
		) {
			throw kernelError(
				"bookkeeping_unknown",
				"private state file changed while reading",
			);
		}
		return Buffer.from(bytes);
	} catch (error) {
		if (error?.code === "ELOOP")
			throw kernelError(
				"state_symlink",
				"private state file is a symlink",
				error,
			);
		if (error?.code === "ENOENT")
			throw kernelError(
				"state_unknown",
				"private state file is missing",
				error,
			);
		if (error instanceof StateKernelError) throw error;
		throw kernelError(
			"bookkeeping_unknown",
			"cannot read private state file",
			error,
		);
	} finally {
		if (descriptor !== undefined) closeSync(descriptor);
	}
}

export function publishExclusivePrivateBytes(
	path,
	bytes,
	{ root, maxBytes = 1024 * 1024, fault, scope = "byte_publish" } = {},
) {
	requireNoFollow();
	if (!(bytes instanceof Uint8Array) || bytes.byteLength > maxBytes)
		throw kernelError(
			"invalid_contract",
			"private publication bytes are invalid",
		);
	const parent = dirname(path);
	assertPrivateChain(root ?? parent, parent);
	if (inspectExistingDestination(path))
		throw kernelError(
			"state_exists",
			"private state destination already exists",
		);
	let descriptor;
	let created = false;
	let synced = false;
	try {
		checkpoint(fault, `${scope}.before_open`);
		descriptor = openSync(
			path,
			constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW,
			FILE_MODE,
		);
		created = true;
		fchmodSync(descriptor, FILE_MODE);
		writeFileSync(descriptor, bytes);
		checkpoint(fault, `${scope}.after_write`);
		fsyncSync(descriptor);
		checkpoint(fault, `${scope}.after_file_fsync`);
		closeSync(descriptor);
		descriptor = undefined;
		const observed = readStablePrivateBytes(path, {
			root: root ?? parent,
			maxBytes,
			allowEmpty: true,
		});
		if (!observed.equals(Buffer.from(bytes)))
			throw kernelError("digest_mismatch", "published private bytes changed");
		fsyncDirectory(parent);
		synced = true;
		checkpoint(fault, `${scope}.after_directory_fsync`);
		return observed;
	} catch (error) {
		if (descriptor !== undefined) closeSync(descriptor);
		if (created) {
			const failure = kernelError(
				"durability_unknown",
				"exclusive private byte publication is uncertain",
				error,
			);
			failure.publicationDurable = synced;
			throw failure;
		}
		if (error instanceof StateKernelError) throw error;
		throw kernelError(
			"durability_unknown",
			"cannot publish private bytes",
			error,
		);
	}
}

export function copyExclusivePrivateBytes(
	sourcePath,
	destinationPath,
	{ sourceRoot, destinationRoot, maxBytes, fault, scope = "byte_copy" } = {},
) {
	const bytes = readStablePrivateBytes(sourcePath, {
		root: sourceRoot,
		maxBytes,
	});
	return publishExclusivePrivateBytes(destinationPath, bytes, {
		root: destinationRoot,
		maxBytes,
		fault,
		scope,
	});
}

export function scanExactDirectory(path, { root } = {}) {
	assertPrivateChain(root ?? path, path);
	const entries = readdirSync(path, { withFileTypes: true });
	return Object.freeze(
		entries
			.map((entry) => {
				const entryPath = join(path, entry.name);
				const stats = lstatSync(entryPath, { bigint: true });
				return Object.freeze({
					name: entry.name,
					type: entry.isDirectory()
						? "directory"
						: entry.isFile()
							? "file"
							: entry.isSymbolicLink()
								? "symlink"
								: "other",
					device: stats.dev.toString(10),
					inode: stats.ino.toString(10),
					mode: Number(stats.mode & 0o777n),
					owner: stats.uid.toString(10),
					linkCount: stats.nlink.toString(10),
					size: stats.size.toString(10),
				});
			})
			.sort((left, right) =>
				Buffer.compare(Buffer.from(left.name), Buffer.from(right.name)),
			),
	);
}

export function readPrivateJson(path, validator, { root, maxBytes } = {}) {
	requireNoFollow();
	if (typeof validator !== "function")
		throw kernelError("invalid_state", "state validator is required");
	assertPrivateChain(root ?? dirname(path), dirname(path));
	let descriptor;
	try {
		descriptor = openSync(path, constants.O_RDONLY | NOFOLLOW);
		const before = assertPrivateFileDescriptor(descriptor);
		if (before.size < 1n || before.size > BigInt(maxBytes ?? 1024 * 1024)) {
			throw kernelError("invalid_json", "private state file size is invalid");
		}
		const bytes = readFileSync(descriptor);
		const after = assertPrivateFileDescriptor(descriptor);
		if (
			before.dev !== after.dev ||
			before.ino !== after.ino ||
			before.size !== after.size ||
			BigInt(bytes.length) !== after.size
		) {
			throw kernelError(
				"bookkeeping_unknown",
				"private state file changed while reading",
			);
		}
		return validator(parseStrictJsonBytes(bytes, { maxBytes }));
	} catch (error) {
		if (error?.code === "ELOOP")
			throw kernelError(
				"state_symlink",
				"private state file is a symlink",
				error,
			);
		if (error?.code === "ENOENT")
			throw kernelError(
				"state_unknown",
				"private state file is missing",
				error,
			);
		if (error instanceof StateKernelError) throw error;
		throw kernelError(
			"bookkeeping_unknown",
			"cannot read private state file",
			error,
		);
	} finally {
		if (descriptor !== undefined) closeSync(descriptor);
	}
}

function inspectExistingDestination(path) {
	const stats = lstat(path);
	if (!stats) return null;
	if (stats.isSymbolicLink())
		throw kernelError(
			"state_symlink",
			"private state destination is a symlink",
		);
	if (!stats.isFile())
		throw kernelError(
			"bookkeeping_unknown",
			"private state destination is not a regular file",
		);
	if (stats.uid !== BigInt(currentUid()))
		throw kernelError(
			"state_owner",
			"private state destination has a foreign owner",
		);
	if (Number(stats.mode & 0o777n) !== FILE_MODE)
		throw kernelError(
			"state_permissions",
			"private state destination mode must be 0600",
		);
	if (stats.nlink !== 1n)
		throw kernelError(
			"bookkeeping_unknown",
			"private state destination has an unexpected link count",
		);
	return stats;
}

function writeJson(
	path,
	value,
	validator,
	{ root, exclusive, fault, scope = "write" } = {},
) {
	requireNoFollow();
	const checked = validator(value);
	const parent = dirname(path);
	assertPrivateChain(root ?? parent, parent);
	const existing = inspectExistingDestination(path);
	if (exclusive && existing)
		throw kernelError(
			"state_exists",
			"private state destination already exists",
		);
	const temp = join(
		parent,
		`.tmp-${basename(path)}-${process.pid}-${randomBytes(12).toString("hex")}`,
	);
	let descriptor;
	let published = false;
	let directorySynced = false;
	try {
		checkpoint(fault, `${scope}.before_temp_open`);
		descriptor = openSync(
			temp,
			constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW,
			FILE_MODE,
		);
		fchmodSync(descriptor, FILE_MODE);
		writeFileSync(descriptor, canonicalJson(checked), { encoding: "utf8" });
		checkpoint(fault, `${scope}.after_temp_write`);
		fsyncSync(descriptor);
		checkpoint(fault, `${scope}.after_file_fsync`);
		closeSync(descriptor);
		descriptor = undefined;
		if (exclusive) {
			try {
				linkSync(temp, path);
			} catch (error) {
				if (error?.code === "EEXIST")
					throw kernelError(
						"state_exists",
						"private state destination already exists",
						error,
					);
				throw error;
			}
			published = true;
			checkpoint(fault, `${scope}.after_publish`);
			unlinkSync(temp);
		} else {
			renameSync(temp, path);
			published = true;
			checkpoint(fault, `${scope}.after_publish`);
		}
		fsyncDirectory(parent);
		directorySynced = true;
		checkpoint(fault, `${scope}.after_directory_fsync`);
		return checked;
	} catch (error) {
		if (descriptor !== undefined) closeSync(descriptor);
		if (!published) {
			try {
				unlinkSync(temp);
			} catch (cleanupError) {
				if (cleanupError?.code !== "ENOENT")
					throw kernelError(
						"bookkeeping_unknown",
						"cannot clean private state temp file",
						cleanupError,
					);
			}
		}
		if (published) {
			const failure = kernelError(
				"durability_unknown",
				"private state publication durability is unknown",
				error,
			);
			failure.publicationDurable = directorySynced;
			throw failure;
		}
		if (error instanceof StateKernelError) throw error;
		throw kernelError(
			"durability_unknown",
			"private state write failed before publication",
			error,
		);
	}
}

export function writeAtomicJson(path, value, validator, options = {}) {
	return writeJson(path, value, validator, { ...options, exclusive: false });
}

export function publishExclusiveJson(path, value, validator, options = {}) {
	return writeJson(path, value, validator, { ...options, exclusive: true });
}

export function removePrivateGuard(path, { parent, fault, scope }) {
	let removed = false;
	try {
		checkpoint(fault, `${scope}.before_remove`);
		unlinkSync(path);
		removed = true;
		checkpoint(fault, `${scope}.after_remove`);
		fsyncDirectory(parent);
		checkpoint(fault, `${scope}.after_directory_fsync`);
	} catch (error) {
		const failure = kernelError(
			"durability_unknown",
			"private state guard removal is incomplete",
			error,
		);
		failure.finalStateDurable = true;
		failure.guardRemoved = removed;
		throw failure;
	}
}

function gitLine(repoPath, args) {
	let output;
	try {
		output = execFileSync("git", ["-C", repoPath, ...args], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});
	} catch (error) {
		throw kernelError(
			"invalid_repository",
			"cannot resolve Git repository identity",
			error,
		);
	}
	const lines = output.trimEnd().split("\n");
	if (lines.length !== 1 || !lines[0])
		throw kernelError(
			"invalid_repository",
			"Git returned ambiguous repository identity",
		);
	return lines[0];
}

function sha256(value) {
	return createHash("sha256").update(value).digest("hex");
}

export function resolveGitCommonDirectory(repoPath) {
	validateCanonicalPath(resolve(repoPath), "repository path");
	let repositoryRoot;
	let commonDirectory;
	try {
		repositoryRoot = realpathSync(
			gitLine(repoPath, ["rev-parse", "--show-toplevel"]),
		);
		commonDirectory = realpathSync(
			gitLine(repoPath, [
				"rev-parse",
				"--path-format=absolute",
				"--git-common-dir",
			]),
		);
	} catch (error) {
		if (error instanceof StateKernelError) throw error;
		throw kernelError(
			"invalid_repository",
			"cannot canonicalize Git repository identity",
			error,
		);
	}
	validateCanonicalPath(repositoryRoot, "repository root");
	validateCanonicalPath(commonDirectory, "Git common directory");
	const stats = statSync(commonDirectory, { bigint: true });
	if (!stats.isDirectory())
		throw kernelError(
			"invalid_repository",
			"Git common directory is not a directory",
		);
	const common = {
		path: commonDirectory,
		device: stats.dev.toString(10),
		inode: stats.ino.toString(10),
	};
	const key = sha256(
		`herdr-conductor-repository-v1\0${common.path}\0${common.device}\0${common.inode}`,
	);
	return {
		repository: { key, common_dir: common },
		repositoryRoot,
	};
}

export function sameRepository(left, right) {
	return (
		left.key === right.key &&
		left.common_dir.path === right.common_dir.path &&
		left.common_dir.device === right.common_dir.device &&
		left.common_dir.inode === right.common_dir.inode
	);
}

export function openRepositoryStore({ stateRoot, repoPath, fault } = {}) {
	if (!stateRoot || !repoPath)
		throw kernelError("invalid_state", "stateRoot and repoPath are required");
	const legacyRoot = resolve(stateRoot);
	const existingLegacyRoot = lstat(legacyRoot);
	if (existingLegacyRoot) {
		if (
			existingLegacyRoot.isSymbolicLink() ||
			!existingLegacyRoot.isDirectory()
		)
			throw kernelError(
				"state_symlink",
				"legacy state root is not a real directory",
			);
		if (existingLegacyRoot.uid !== BigInt(currentUid()))
			throw kernelError("state_owner", "legacy state root has a foreign owner");
	} else {
		try {
			mkdirSync(legacyRoot, { mode: DIRECTORY_MODE });
		} catch (error) {
			throw kernelError(
				"durability_unknown",
				"cannot create state parent",
				error,
			);
		}
	}
	const root = join(legacyRoot, "v1");
	ensurePrivateDirectory(root, { fault });
	const identity = resolveGitCommonDirectory(resolve(repoPath));
	const repositoriesDir = ensurePrivatePath(root, ["repositories"], fault);
	const repositoryDir = ensurePrivatePath(
		root,
		["repositories", identity.repository.key],
		fault,
	);
	const identityPath = join(repositoryDir, "identity.json");
	const document = {
		document_type: "herdr-conductor-repository",
		schema_version: PRIVATE_STATE_VERSION,
		repository: identity.repository,
	};
	try {
		publishExclusiveJson(identityPath, document, validateRepositoryDocument, {
			root,
			fault,
			scope: "repository_identity",
		});
	} catch (error) {
		if (error.code !== "state_exists") throw error;
		const recorded = readPrivateJson(identityPath, validateRepositoryDocument, {
			root,
		});
		if (!sameRepository(recorded.repository, identity.repository)) {
			throw kernelError(
				"foreign_repository",
				"private state belongs to another physical repository",
			);
		}
	}
	return Object.freeze({
		stateRoot: root,
		repositoriesDir,
		repositoryDir,
		repository: identity.repository,
		repositoryRoot: identity.repositoryRoot,
		lockDir: join(repositoryDir, "mutation.lock"),
	});
}

function workspaceKey(workspaceId) {
	validateId(workspaceId, "workspace id");
	return sha256(`herdr-conductor-workspace-v1\0${workspaceId}`);
}

export function workspacePaths(
	store,
	workspaceId,
	{ create = false, fault } = {},
) {
	const key = workspaceKey(workspaceId);
	const parts = ["workspaces", key];
	const directory = create
		? ensurePrivatePath(store.repositoryDir, parts, fault)
		: join(store.repositoryDir, ...parts);
	if (!create) assertPrivateChain(store.stateRoot, directory);
	const activeDir = create
		? ensurePrivatePath(store.repositoryDir, [...parts, "active"], fault)
		: join(directory, "active");
	const runsDir = create
		? ensurePrivatePath(store.repositoryDir, [...parts, "runs"], fault)
		: join(directory, "runs");
	if (!create) {
		assertPrivateChain(store.stateRoot, activeDir);
		assertPrivateChain(store.stateRoot, runsDir);
	}
	return { key, directory, activeDir, runsDir };
}

function strictEntries(path, predicate) {
	let entries;
	try {
		entries = readdirSync(path, { withFileTypes: true });
	} catch (error) {
		throw kernelError(
			"bookkeeping_unknown",
			"cannot enumerate private state",
			error,
		);
	}
	for (const entry of entries) {
		if (!predicate(entry))
			throw kernelError(
				"bookkeeping_unknown",
				"private state contains unexpected inventory",
			);
	}
	return entries;
}

function runPaths(
	workspace,
	runId,
	generation,
	{ create = false, store, fault } = {},
) {
	validateId(runId, "run id");
	validateGeneration(generation, "run generation");
	const relativeParts = [
		"workspaces",
		workspace.key,
		"runs",
		runId,
		generation,
	];
	const directory = create
		? ensurePrivatePath(store.repositoryDir, relativeParts, fault)
		: join(workspace.runsDir, runId, generation);
	const operationsDir = create
		? ensurePrivatePath(
				store.repositoryDir,
				[...relativeParts, "operations"],
				fault,
			)
		: join(directory, "operations");
	const operationGuardsDir = create
		? ensurePrivatePath(
				store.repositoryDir,
				[...relativeParts, "operation-guards"],
				fault,
			)
		: join(directory, "operation-guards");
	const stage2Directories = Object.fromEntries(
		[
			["contractsDir", ["contracts"]],
			["tasksDir", ["contracts", "tasks"]],
			["reportsDir", ["contracts", "reports"]],
			["outboxesDir", ["outboxes"]],
			["gateSourcesDir", ["gate-sources"]],
		].map(([name, suffix]) => [
			name,
			create
				? ensurePrivatePath(
						store.repositoryDir,
						[...relativeParts, ...suffix],
						fault,
					)
				: join(directory, ...suffix),
		]),
	);
	if (!create) {
		assertPrivateChain(store.stateRoot, directory);
		assertPrivateChain(store.stateRoot, operationsDir);
		assertPrivateChain(store.stateRoot, operationGuardsDir);
		for (const stage2Directory of Object.values(stage2Directories))
			assertPrivateChain(store.stateRoot, stage2Directory);
	}
	return {
		directory,
		operationsDir,
		operationGuardsDir,
		...stage2Directories,
		statePath: join(directory, "run.json"),
		activationGuardPath: join(directory, "activation.guard.json"),
	};
}

export function scanRunStates(store, workspace) {
	const results = [];
	for (const runEntry of strictEntries(
		workspace.runsDir,
		(entry) =>
			entry.isDirectory() &&
			(() => {
				try {
					validateId(entry.name, "run directory");
					return true;
				} catch {
					return false;
				}
			})(),
	)) {
		const runDir = join(workspace.runsDir, runEntry.name);
		assertPrivateChain(store.stateRoot, runDir);
		for (const generationEntry of strictEntries(
			runDir,
			(entry) => entry.isDirectory() && /^[a-f0-9]{32}$/.test(entry.name),
		)) {
			const paths = runPaths(workspace, runEntry.name, generationEntry.name, {
				store,
			});
			const state = readPrivateJson(paths.statePath, validateRunState, {
				root: store.stateRoot,
			});
			if (
				state.run_id !== runEntry.name ||
				state.generation !== generationEntry.name
			) {
				throw kernelError(
					"bookkeeping_unknown",
					"run document identity does not match its directory path",
				);
			}
			const guardStats = lstat(paths.activationGuardPath);
			let activationGuard = null;
			if (guardStats) {
				activationGuard = readPrivateJson(
					paths.activationGuardPath,
					validateActiveRun,
					{
						root: store.stateRoot,
					},
				);
				if (
					activationGuard.repository_key !== state.repository.key ||
					activationGuard.workspace_id !== state.workspace_id ||
					activationGuard.workspace_key !== state.workspace_key ||
					activationGuard.run_id !== state.run_id ||
					activationGuard.generation !== state.generation
				) {
					throw kernelError(
						"bookkeeping_unknown",
						"activation guard identity does not match its run path",
					);
				}
			}
			results.push({ state, paths, activationGuard });
		}
	}
	return results;
}

export function scanActivePointers(store, workspace) {
	return strictEntries(
		workspace.activeDir,
		(entry) => entry.isFile() && entry.name.endsWith(".json"),
	).map((entry) => {
		const value = readPrivateJson(
			join(workspace.activeDir, entry.name),
			validateActiveRun,
			{
				root: store.stateRoot,
			},
		);
		if (entry.name !== `${value.run_id}--${value.generation}.json`) {
			throw kernelError(
				"bookkeeping_unknown",
				"active pointer filename does not match its identity",
			);
		}
		return { path: join(workspace.activeDir, entry.name), value };
	});
}

export function compareRunIdentity(store, workspace, pointer, state) {
	if (
		pointer.repository_key !== store.repository.key ||
		!sameRepository(state.repository, store.repository)
	) {
		throw kernelError(
			"foreign_repository",
			"run state belongs to another physical repository",
		);
	}
	if (
		pointer.workspace_id !== state.workspace_id ||
		pointer.workspace_id === "" ||
		pointer.workspace_key !== workspace.key ||
		state.workspace_key !== workspace.key
	) {
		throw kernelError(
			"foreign_workspace",
			"run state belongs to another workspace",
		);
	}
	if (
		pointer.run_id !== state.run_id ||
		pointer.generation !== state.generation
	) {
		throw kernelError(
			"bookkeeping_unknown",
			"active pointer and run state disagree",
		);
	}
	if (state.repository_root !== store.repositoryRoot) {
		throw kernelError(
			"foreign_repository",
			"run state belongs to another repository worktree root",
		);
	}
}

export function journalEntryDigest(entry) {
	return sha256(
		canonicalJson({
			repository_key: entry.repository_key,
			workspace_id: entry.workspace_id,
			workspace_key: entry.workspace_key,
			run_id: entry.run_id,
			run_generation: entry.run_generation,
			sequence: entry.sequence,
			operation_id: entry.operation_id,
			operation_type: entry.operation_type,
			subject: entry.subject,
			request_digest: entry.request_digest,
			previous_digest: entry.previous_digest,
			phase: entry.phase,
			result_digest: entry.result_digest,
			observed_identity: entry.observed_identity,
			error_code: entry.error_code,
			created_at: entry.created_at,
			updated_at: entry.updated_at,
		}),
	);
}

export function scanJournal(
	store,
	active,
	{ allowGuards = false, allowArchiveTransition = false } = {},
) {
	const recordName = /^\d{10}-[A-Za-z0-9][A-Za-z0-9._:-]{0,127}\.json$/;
	const guardInventory = strictEntries(
		active.paths.operationGuardsDir,
		(entry) => entry.isFile() && recordName.test(entry.name),
	);
	const guards = guardInventory.map((entry) => {
		const value = readPrivateJson(
			join(active.paths.operationGuardsDir, entry.name),
			validateJournalEntry,
			{ root: store.stateRoot },
		);
		if (
			entry.name !==
			`${String(value.sequence).padStart(10, "0")}-${value.operation_id}.json`
		) {
			throw kernelError(
				"bookkeeping_unknown",
				"journal guard filename does not match its identity",
			);
		}
		return value;
	});
	if (guards.length > 0 && !allowGuards)
		throw kernelError(
			"recovery_required",
			"journal has a durable uncertainty guard",
		);
	const entries = strictEntries(
		active.paths.operationsDir,
		(entry) => entry.isFile() && recordName.test(entry.name),
	)
		.map((entry) => {
			const value = readPrivateJson(
				join(active.paths.operationsDir, entry.name),
				validateJournalEntry,
				{
					root: store.stateRoot,
				},
			);
			if (
				entry.name !==
				`${String(value.sequence).padStart(10, "0")}-${value.operation_id}.json`
			) {
				throw kernelError(
					"bookkeeping_unknown",
					"journal filename does not match its identity",
				);
			}
			return value;
		})
		.sort((left, right) => left.sequence - right.sequence);
	if (entries.length !== active.state.journal_sequence) {
		const last = entries.at(-1);
		const recoverableArchiveIntent =
			allowArchiveTransition &&
			entries.length === active.state.journal_sequence + 1 &&
			last?.operation_type === "run.archive" &&
			last.phase === "intent" &&
			last.sequence === entries.length &&
			last.previous_digest === active.state.journal_head;
		if (!recoverableArchiveIntent)
			throw kernelError(
				"bookkeeping_unknown",
				"journal inventory does not match the run high-water mark",
			);
	}
	const operations = new Set();
	let previousDigest = null;
	for (const [index, entry] of entries.entries()) {
		if (
			entry.repository_key !== store.repository.key ||
			entry.workspace_id !== active.state.workspace_id ||
			entry.workspace_key !== active.state.workspace_key ||
			entry.run_id !== active.state.run_id
		) {
			throw kernelError(
				"bookkeeping_unknown",
				"journal identity does not match the active run",
			);
		}
		if (entry.run_generation !== active.state.generation) {
			throw kernelError("stale_generation", "journal generation is stale");
		}
		if (
			entry.sequence !== index + 1 ||
			entry.previous_digest !== previousDigest
		) {
			throw kernelError(
				"bookkeeping_unknown",
				"journal sequence or digest chain is discontinuous",
			);
		}
		if (entry.entry_digest !== journalEntryDigest(entry)) {
			throw kernelError(
				"bookkeeping_unknown",
				"journal entry digest is invalid",
			);
		}
		if (operations.has(entry.operation_id)) {
			throw kernelError(
				"bookkeeping_unknown",
				"journal contains duplicate operation identity",
			);
		}
		operations.add(entry.operation_id);
		previousDigest = entry.entry_digest;
	}
	if (previousDigest !== active.state.journal_head) {
		const last = entries.at(-1);
		const guard = guards[0];
		const recoverableArchiveResult =
			allowArchiveTransition &&
			guards.length === 1 &&
			last?.operation_type === "run.archive" &&
			last.phase === "observed" &&
			guard.operation_id === last.operation_id &&
			guard.sequence === last.sequence &&
			guard.phase === "intent" &&
			active.state.journal_head === guard.entry_digest;
		const recoverableArchiveIntent =
			allowArchiveTransition &&
			last?.operation_type === "run.archive" &&
			last.phase === "intent" &&
			last.sequence === active.state.journal_sequence + 1 &&
			last.previous_digest === active.state.journal_head;
		if (!recoverableArchiveResult && !recoverableArchiveIntent)
			throw kernelError(
				"bookkeeping_unknown",
				"journal head does not match the run state",
			);
	}
	Object.defineProperty(entries, "guards", {
		value: guards,
		enumerable: false,
	});
	return entries;
}

export function loadActiveRun(
	store,
	{ workspaceId, expectedRunId, expectedGeneration } = {},
) {
	const workspace = workspacePaths(store, workspaceId);
	const pointers = scanActivePointers(store, workspace);
	if (pointers.length > 1)
		throw kernelError(
			"duplicate_active",
			"workspace has multiple active-run pointers",
		);
	const runStates = scanRunStates(store, workspace);
	const activeStates = runStates.filter(
		({ state }) => state.status === "active",
	);
	const nonArchivedStates = runStates.filter(
		({ state }) => state.status !== "archived",
	);
	if (runStates.some(({ activationGuard }) => activationGuard !== null)) {
		throw kernelError(
			"recovery_required",
			"workspace has an unresolved activation guard",
		);
	}
	if (pointers.length === 0) {
		if (runStates.some(({ state }) => state.status !== "archived")) {
			throw kernelError(
				"bookkeeping_unknown",
				"non-archived run state has no active pointer",
			);
		}
		throw kernelError("state_unknown", "workspace has no active run");
	}
	if (activeStates.length !== 1 || nonArchivedStates.length !== 1) {
		throw kernelError(
			"bookkeeping_unknown",
			"active pointer does not have one exclusive non-archived run state",
		);
	}
	const pointer = pointers[0].value;
	const active = activeStates[0];
	compareRunIdentity(store, workspace, pointer, active.state);
	if (expectedRunId !== undefined && pointer.run_id !== expectedRunId) {
		throw kernelError(
			"foreign_run",
			"active run id does not match the request",
		);
	}
	if (
		expectedGeneration !== undefined &&
		pointer.generation !== expectedGeneration
	) {
		throw kernelError("stale_generation", "active run generation is stale");
	}
	const result = {
		store,
		workspace,
		pointer,
		pointerPath: pointers[0].path,
		state: active.state,
		paths: active.paths,
		journal: [],
	};
	result.journal = scanJournal(store, result);
	if (result.journal.some((entry) => entry.phase !== "observed")) {
		throw kernelError(
			"recovery_required",
			"active run has an unresolved operation",
		);
	}
	return result;
}

export function loadArchivedRun(store, { workspaceId } = {}) {
	const workspace = workspacePaths(store, workspaceId);
	const pointers = scanActivePointers(store, workspace);
	if (pointers.length !== 0)
		throw kernelError(
			"bookkeeping_unknown",
			"archived status cannot coexist with an active pointer",
		);
	const states = scanRunStates(store, workspace);
	if (states.some(({ activationGuard }) => activationGuard !== null))
		throw kernelError(
			"recovery_required",
			"workspace has an unresolved activation guard",
		);
	if (states.some(({ state }) => state.status !== "archived"))
		throw kernelError(
			"bookkeeping_unknown",
			"non-archived run state has no active pointer",
		);
	const terminals = [];
	for (const selected of states) {
		const candidate = {
			store,
			workspace,
			pointer: null,
			pointerPath: join(
				workspace.activeDir,
				`${selected.state.run_id}--${selected.state.generation}.json`,
			),
			state: selected.state,
			paths: selected.paths,
			journal: [],
		};
		candidate.journal = scanJournal(store, candidate, {
			allowGuards: true,
			allowArchiveTransition: true,
		});
		const archives = candidate.journal.filter(
			(entry) => entry.operation_type === "run.archive",
		);
		if (
			archives.length === 1 &&
			archives[0].phase === "observed" &&
			candidate.journal.guards.length === 0
		)
			terminals.push(candidate);
	}
	if (terminals.length === 0)
		throw kernelError("state_unknown", "workspace has no archived terminal");
	terminals.sort((left, right) =>
		Buffer.from(right.state.updated_at).compare(
			Buffer.from(left.state.updated_at),
		),
	);
	if (
		terminals.length > 1 &&
		terminals[0].state.updated_at === terminals[1].state.updated_at
	)
		throw kernelError(
			"bookkeeping_unknown",
			"latest archived terminal is ambiguous",
		);
	return terminals[0];
}

function inspectLock(store) {
	const stats = lstat(store.lockDir, "lock_unknown");
	if (!stats) return { status: "unlocked" };
	try {
		assertPrivateDirectory(store.lockDir);
		const owner = readPrivateJson(
			join(store.lockDir, "owner.json"),
			validateLockOwner,
			{
				root: store.stateRoot,
			},
		);
		if (owner.repository_key !== store.repository.key)
			throw kernelError("lock_unknown", "lock belongs to another repository");
		return { status: "locked", owner, stats };
	} catch (error) {
		if (error instanceof StateKernelError && error.code === "lock_unknown")
			throw error;
		throw kernelError(
			"lock_unknown",
			"repository lock cannot be verified",
			error,
		);
	}
}

export function inspectRepositoryLock(store) {
	return inspectLock(store);
}

export function reclaimDeadRepositoryLock(store, { operationId, fault } = {}) {
	validateId(operationId, "lock operation id");
	const existing = inspectLock(store);
	if (existing.status === "locked") {
		let dead = false;
		try {
			process.kill(existing.owner.pid, 0);
		} catch (error) {
			if (error?.code !== "ESRCH") throw error;
			dead = true;
		}
		if (!dead)
			throw kernelError(
				"lock_busy",
				"repository mutation lock is already held",
			);
		if (existing.owner.operation_id !== operationId)
			throw kernelError(
				"recovery_required",
				"operation_uncertain: retained dead-process lock requires recovery",
			);
		try {
			unlinkSync(join(store.lockDir, "owner.json"));
			rmdirSync(store.lockDir);
			fsyncDirectory(store.repositoryDir);
		} catch (error) {
			throw kernelError(
				"lock_unknown",
				"dead repository lock cannot be reclaimed",
				error,
			);
		}
	}
	return acquireRepositoryLock(store, { operationId, fault });
}

export function acquireRepositoryLock(store, { operationId, fault } = {}) {
	validateId(operationId, "lock operation id");
	try {
		mkdirSync(store.lockDir, { mode: DIRECTORY_MODE });
	} catch (error) {
		if (error?.code === "EEXIST") {
			const existing = inspectLock(store);
			if (existing.status === "locked")
				throw kernelError(
					"lock_busy",
					"repository mutation lock is already held",
				);
		}
		throw kernelError(
			"lock_unknown",
			"cannot acquire repository mutation lock",
			error,
		);
	}
	try {
		checkpoint(fault, "lock.after_mkdir");
		fsyncDirectory(store.repositoryDir);
	} catch (error) {
		if (error instanceof StateKernelError) throw error;
		throw kernelError(
			"durability_unknown",
			"repository lock publication is incomplete",
			error,
		);
	}
	const stats = assertPrivateDirectory(store.lockDir);
	const owner = {
		document_type: "herdr-conductor-repository-lock",
		schema_version: PRIVATE_STATE_VERSION,
		repository_key: store.repository.key,
		lock_id: randomBytes(16).toString("hex"),
		operation_id: operationId,
		pid: process.pid,
		acquired_at: new Date().toISOString(),
	};
	publishExclusiveJson(
		join(store.lockDir, "owner.json"),
		owner,
		validateLockOwner,
		{
			root: store.stateRoot,
			fault,
			scope: "lock_owner",
		},
	);
	checkpoint(fault, "lock.after_owner_publish");
	return Object.freeze({
		store,
		owner: validateLockOwner(owner),
		device: stats.dev.toString(10),
		inode: stats.ino.toString(10),
	});
}

export function assertLock(handle) {
	if (!handle?.store || !handle.owner)
		throw kernelError("lock_unknown", "repository lock handle is invalid");
	const current = inspectLock(handle.store);
	if (current.status !== "locked")
		throw kernelError("lock_unknown", "repository lock is not held");
	if (
		current.owner.lock_id !== handle.owner.lock_id ||
		current.stats.dev.toString(10) !== handle.device ||
		current.stats.ino.toString(10) !== handle.inode
	) {
		throw kernelError("lock_unknown", "repository lock ownership changed");
	}
	return current.owner;
}

export function releaseRepositoryLock(handle) {
	assertLock(handle);
	const ownerPath = join(handle.store.lockDir, "owner.json");
	try {
		unlinkSync(ownerPath);
		fsyncDirectory(handle.store.lockDir);
		rmdirSync(handle.store.lockDir);
		fsyncDirectory(handle.store.repositoryDir);
	} catch (error) {
		throw kernelError(
			"lock_unknown",
			"repository lock release is incomplete",
			error,
		);
	}
}

export function createRun(
	handle,
	{
		workspaceId,
		runId,
		generation = randomBytes(16).toString("hex"),
		forkSha,
		fault,
	} = {},
) {
	assertLock(handle);
	validateId(workspaceId, "workspace id");
	validateId(runId, "run id");
	validateGeneration(generation, "run generation");
	validateGitObjectId(forkSha, "fork sha");
	const { store } = handle;
	const workspace = workspacePaths(store, workspaceId, { create: true, fault });
	const pointers = scanActivePointers(store, workspace);
	const states = scanRunStates(store, workspace);
	if (pointers.length > 0)
		throw kernelError(
			"duplicate_active",
			"workspace already has an active pointer",
		);
	if (states.some(({ state }) => state.status !== "archived")) {
		throw kernelError(
			"bookkeeping_unknown",
			"workspace has an unresolved non-archived run state",
		);
	}
	const paths = runPaths(workspace, runId, generation, {
		create: true,
		store,
		fault,
	});
	const now = new Date().toISOString();
	const state = {
		document_type: "herdr-conductor-run",
		schema_version: PRIVATE_STATE_VERSION,
		revision: 0,
		repository: store.repository,
		repository_root: store.repositoryRoot,
		workspace_id: workspaceId,
		workspace_key: workspace.key,
		run_id: runId,
		generation,
		fork_sha: forkSha,
		status: "initializing",
		journal_sequence: 0,
		journal_head: null,
		created_at: now,
		updated_at: now,
	};
	publishExclusiveJson(paths.statePath, state, validateRunState, {
		root: store.stateRoot,
		fault,
		scope: "run_state",
	});
	try {
		checkpoint(fault, "run.after_state_durable");
	} catch (error) {
		throw kernelError(
			"durability_unknown",
			"run activation stopped after state publication",
			error,
		);
	}
	const pointer = {
		document_type: "herdr-conductor-active-run",
		schema_version: PRIVATE_STATE_VERSION,
		revision: 0,
		repository_key: store.repository.key,
		workspace_id: workspaceId,
		workspace_key: workspace.key,
		run_id: runId,
		generation,
		created_at: now,
	};
	const pointerPath = join(workspace.activeDir, `${runId}--${generation}.json`);
	publishExclusiveJson(paths.activationGuardPath, pointer, validateActiveRun, {
		root: store.stateRoot,
		fault,
		scope: "activation_guard",
	});
	publishExclusiveJson(pointerPath, pointer, validateActiveRun, {
		root: store.stateRoot,
		fault,
		scope: "active_pointer",
	});
	const activeState = {
		...state,
		revision: state.revision + 1,
		status: "active",
		updated_at: new Date().toISOString(),
	};
	writeAtomicJson(paths.statePath, activeState, validateRunState, {
		root: store.stateRoot,
		fault,
		scope: "run_activate",
	});
	removePrivateGuard(paths.activationGuardPath, {
		parent: paths.directory,
		fault,
		scope: "activation_guard",
	});
	return {
		workspace,
		paths,
		pointerPath,
		state: validateRunState(activeState),
		pointer: validateActiveRun(pointer),
	};
}

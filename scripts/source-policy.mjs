#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { StateKernelError } from "./private-state-schema.mjs";
import { validateRelativePath } from "./task-report-schema.mjs";
import { resolveGitCommonDirectory } from "./state-kernel.mjs";

function fail(code, message, cause) {
	throw new StateKernelError(code, message, cause ? { cause } : undefined);
}

function run(repo, args, { exec = execFileSync, encoding = null } = {}) {
	try {
		return exec("git", ["-C", repo, ...args], {
			encoding,
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...process.env, LC_ALL: "C", LANG: "C" },
		});
	} catch (error) {
		fail("stale_source", `git ${args[0]} failed`, error);
	}
}

function line(repo, args, options) {
	const value = run(repo, args, { ...options, encoding: "utf8" }).trimEnd();
	if (!value || value.includes("\n"))
		fail("stale_source", `git ${args[0]} returned ambiguous output`);
	return value;
}

function zeroDelimited(buffer, label) {
	if (!Buffer.isBuffer(buffer)) buffer = Buffer.from(buffer);
	if (buffer.length === 0) return [];
	if (buffer.at(-1) !== 0)
		fail("source_policy_violation", `${label} is not NUL terminated`);
	const paths = buffer.subarray(0, -1).toString("utf8").split("\0");
	for (const path of paths) validateRelativePath(path, label);
	return paths;
}

function sorted(values) {
	return [...values].sort((left, right) =>
		Buffer.compare(Buffer.from(left), Buffer.from(right)),
	);
}

function hash(value) {
	return createHash("sha256").update(value).digest("hex");
}

export function computeChangedPaths(
	repository,
	baseSha,
	outputSha,
	options = {},
) {
	const bytes = run(
		repository,
		[
			"-c",
			"diff.renames=false",
			"diff",
			"--name-only",
			"-z",
			"--no-renames",
			"--no-ext-diff",
			baseSha,
			outputSha,
			"--",
		],
		options,
	);
	const paths = zeroDelimited(bytes, "computed changed path");
	const unique = new Set(paths);
	if (unique.size !== paths.length)
		fail("source_policy_violation", "computed changed paths are duplicated");
	return Object.freeze(sorted(paths));
}

function prefixMatches(prefix, path) {
	return path === prefix || path.startsWith(`${prefix}/`);
}

export function validateProducerPathPolicy(
	computedPaths,
	reportedPaths,
	assignment,
) {
	const computed = sorted(computedPaths);
	const reported = sorted(reportedPaths);
	if (
		computed.length !== reported.length ||
		computed.some((path, index) => path !== reported[index])
	)
		fail(
			"source_policy_violation",
			"reported changed paths do not equal the collector-computed Git diff",
		);
	for (const path of computed) {
		validateRelativePath(path, "changed path");
		const owners = assignment.owned_paths.filter((prefix) =>
			prefixMatches(prefix, path),
		);
		if (
			owners.length !== 1 ||
			assignment.forbidden_paths.some((prefix) => prefixMatches(prefix, path))
		)
			fail(
				"source_policy_violation",
				`changed path is not uniquely owned: ${path}`,
			);
	}
	return Object.freeze(computed);
}

function inventory(repo, args, options) {
	return run(repo, args, options);
}

export function inspectProducerSource(
	taskSource,
	reportSource,
	assignment,
	options = {},
) {
	let root;
	try {
		root = realpathSync(reportSource.root);
	} catch (error) {
		fail("stale_source", "producer source root is unavailable", error);
	}
	const repository = resolveGitCommonDirectory(root);
	const actualCommon = repository.repository.common_dir;
	const headSha = line(root, ["rev-parse", "HEAD"], options);
	const fullRef = line(root, ["symbolic-ref", "-q", "HEAD"], options);
	const refSha = line(root, ["rev-parse", taskSource.branch_ref], options);
	const headTreeSha = line(root, ["rev-parse", "HEAD^{tree}"], options);
	const indexTreeSha = line(root, ["write-tree"], options);
	const tracked = inventory(
		root,
		["status", "--porcelain=v1", "-z", "--untracked-files=no"],
		options,
	);
	const untracked = inventory(
		root,
		["ls-files", "--others", "--exclude-standard", "-z"],
		options,
	);
	const ignored = inventory(
		root,
		["ls-files", "--others", "--ignored", "--exclude-standard", "-z"],
		options,
	);
	const changedPaths = computeChangedPaths(
		root,
		taskSource.fork_sha,
		headSha,
		options,
	);
	const observation = Object.freeze({
		canonical_path: root,
		common_directory: actualCommon,
		full_ref: fullRef,
		head_sha: headSha,
		head_tree_sha: headTreeSha,
		index_tree_sha: indexTreeSha,
		tracked_status_sha256: hash(tracked),
		untracked_inventory_sha256: hash(untracked),
		ignored_inventory_sha256: hash(ignored),
		computed_changed_paths_sha256: hash(
			Buffer.from(`${changedPaths.join("\0")}\0`),
		),
		observed_at: (options.now ?? (() => new Date()))().toISOString(),
	});
	const reject = (code, message) => {
		const error = new StateKernelError(code, message);
		error.sourceObservation = observation;
		throw error;
	};
	if (root !== taskSource.root || root !== reportSource.root)
		reject("stale_source", "producer source root changed");
	const expectedCommon = taskSource.common_dir;
	if (
		actualCommon.path !== expectedCommon.path ||
		actualCommon.device !== expectedCommon.device ||
		actualCommon.inode !== expectedCommon.inode
	)
		reject("foreign_repository", "producer source common directory changed");
	if (
		fullRef !== taskSource.branch_ref ||
		headSha !== refSha ||
		headSha !== reportSource.expected_sha ||
		headTreeSha !== reportSource.tree_sha
	)
		reject("stale_source", "producer ref, head, or tree differs from the report");
	if (indexTreeSha !== headTreeSha)
		reject(
			"source_policy_violation",
			"producer index differs from the reported head tree",
		);
	try {
		run(
			root,
			["merge-base", "--is-ancestor", taskSource.fork_sha, headSha],
			options,
		);
	} catch {
		reject(
			"stale_source",
			"producer output is not descended from its fixed fork",
		);
	}
	if (tracked.length !== 0 || untracked.length !== 0 || ignored.length !== 0)
		reject(
			"source_policy_violation",
			"producer source is not clean at collection",
		);
	try {
		validateProducerPathPolicy(
			changedPaths,
			reportSource.changed_paths ?? changedPaths,
			assignment,
		);
	} catch (error) {
		error.sourceObservation = observation;
		throw error;
	}
	return Object.freeze({
		observation,
		changedPaths,
		headSha,
		treeSha: headTreeSha,
	});
}

export function inspectGateSource(source, options = {}) {
	let root;
	try {
		root = realpathSync(source.root);
	} catch (error) {
		fail("stale_source", "gate source root is unavailable", error);
	}
	if (root !== source.root) fail("stale_source", "gate source root changed");
	const repository = resolveGitCommonDirectory(root);
	if (
		repository.repository.common_dir.path !== source.common_dir.path ||
		repository.repository.common_dir.device !== source.common_dir.device ||
		repository.repository.common_dir.inode !== source.common_dir.inode
	)
		fail("foreign_repository", "gate source common directory changed");
	const head = line(root, ["rev-parse", "HEAD"], options);
	const tree = line(root, ["rev-parse", "HEAD^{tree}"], options);
	const indexTree = line(root, ["write-tree"], options);
	const symbolic = line(root, ["rev-parse", "--abbrev-ref", "HEAD"], options);
	if (
		symbolic !== "HEAD" ||
		head !== source.integration_sha ||
		tree !== source.tree_sha ||
		indexTree !== tree
	)
		fail(
			"source_policy_violation",
			"gate source is not the exact detached integration snapshot",
		);
	const tracked = zeroDelimited(
		run(root, ["ls-files", "-z"], options),
		"tracked gate path",
	);
	const trackedStatus = run(
		root,
		["status", "--porcelain=v1", "-z", "--untracked-files=no"],
		options,
	);
	const untracked = run(
		root,
		["ls-files", "--others", "--exclude-standard", "-z"],
		options,
	);
	const ignored = run(
		root,
		["ls-files", "--others", "--ignored", "--exclude-standard", "-z"],
		options,
	);
	const observation = Object.freeze({
		canonical_path: root,
		common_directory: repository.repository.common_dir,
		head_sha: head,
		head_tree_sha: tree,
		index_tree_sha: indexTree,
		tracked_status_sha256: hash(trackedStatus),
		untracked_inventory_sha256: hash(untracked),
		ignored_inventory_sha256: hash(ignored),
	});
	const rejectInventory = (message) => {
		const error = new StateKernelError("source_policy_violation", message);
		error.gateSourceObservation = observation;
		throw error;
	};
	if (
		trackedStatus.length !== 0 ||
		untracked.length !== 0 ||
		ignored.length !== 0
	)
		rejectInventory("gate source content or inventory changed");
	const owner = process.geteuid();
	const directories = new Set([root]);
	for (const path of tracked) {
		const absolute = join(root, path);
		for (
			let parent = dirname(absolute);
			parent !== root;
			parent = dirname(parent)
		)
			directories.add(parent);
		const stats = lstatSync(absolute);
		if (stats.uid !== owner)
			fail("source_policy_violation", "gate source ownership changed");
		if (stats.isSymbolicLink()) continue;
		if (!stats.isFile())
			fail(
				"capability_unavailable",
				"gate source contains an unsupported tracked type",
			);
		if (stats.nlink !== 1)
			fail("source_policy_violation", "gate source file link count changed");
		const executable = Number(stats.mode & 0o111) !== 0;
		if (Number(stats.mode & 0o777) !== (executable ? 0o555 : 0o444))
			fail("source_policy_violation", "gate source file modes changed");
	}
	for (const directory of directories) {
		const stats = lstatSync(directory);
		if (
			!stats.isDirectory() ||
			stats.isSymbolicLink() ||
			stats.uid !== owner ||
			Number(stats.mode & 0o777) !== 0o555
		)
			fail("source_policy_violation", "gate source directory changed");
	}
	const admin = lstatSync(join(root, ".git"));
	if (
		!admin.isFile() ||
		admin.isSymbolicLink() ||
		admin.uid !== owner ||
		admin.nlink !== 1 ||
		Number(admin.mode & 0o777) !== 0o444
	)
		fail("source_policy_violation", "gate source administrative file changed");
	return Object.freeze({
		headSha: head,
		treeSha: tree,
		trackedPaths: Object.freeze(tracked),
		observation,
	});
}

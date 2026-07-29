#!/usr/bin/env node
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	realpathSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { runtimeStateRoot } from "./state-root.mjs";
import {
	StateKernelError,
	canonicalJson,
	parseStrictJsonBytes,
	validateGeneration,
	validateGitObjectId,
	validateId,
} from "./private-state-schema.mjs";
import {
	acquireRepositoryLock,
	archiveActiveRun,
	createRun,
	findRecoverableArchive,
	loadActiveRun,
	openRepositoryStore,
	performJournaledOperation,
	releaseRepositoryLock,
	resolveGitCommonDirectory,
} from "./state-kernel.mjs";
import {
	bindIntegrationTarget,
	liveIntegrationTarget,
	liveSourceIdentity,
	mergeImmutableSource,
	observeCreatedWorktree,
	validateMergeResultPublication,
} from "./git-reconcile.mjs";
import {
	herdrJson,
	liveCloseIdentity,
	paneCreationIdentity,
	paneFrom,
	readHerdrIdentity,
	requireAnchor,
	requireHerdrRuntime,
	observeStartedAgent,
	startAgentWhenReady,
} from "./herdr-identity.mjs";

const ROLE_NAME = /^[a-z][a-z0-9_-]{0,31}$/;
const KIND = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MODES = new Set(["write", "gated", "read-only"]);

function fail(code, message, cause) {
	throw new StateKernelError(code, message, cause ? { cause } : undefined);
}

function openExistingStore({ stateRoot, repoPath }) {
	const identity = resolveGitCommonDirectory(repoPath);
	const identityPath = join(
		stateRoot,
		"v1",
		"repositories",
		identity.repository.key,
		"identity.json",
	);
	if (!existsSync(identityPath))
		fail("state_unknown", "repository has no Conductor state authority");
	return openRepositoryStore({ stateRoot, repoPath });
}

function plain(value, label) {
	if (value === null || typeof value !== "object" || Array.isArray(value))
		fail("invalid_context", `${label} must be an object`);
	return value;
}

function string(value, label, pattern = null) {
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		value.length > 4096 ||
		/[\0\r\n]/.test(value) ||
		(pattern && !pattern.test(value))
	) {
		fail("invalid_context", `${label} is invalid`);
	}
	return value;
}

function exactKeys(value, allowed, required, label) {
	plain(value, label);
	for (const key of Object.keys(value))
		if (!allowed.includes(key))
			fail("invalid_config", `${label} has unknown field ${key}`);
	for (const key of required)
		if (!(key in value)) fail("invalid_config", `${label} is missing ${key}`);
}

export function parsePluginContext(
	contextJson,
	{ requireFocusedPane = false } = {},
) {
	if (typeof contextJson !== "string" || contextJson.length === 0)
		fail("context_unavailable", "HERDR_PLUGIN_CONTEXT_JSON is required");
	let raw;
	try {
		raw = parseStrictJsonBytes(Buffer.from(contextJson), {
			maxBytes: 64 * 1024,
		});
	} catch (error) {
		throw new StateKernelError(
			"invalid_context",
			"HERDR_PLUGIN_CONTEXT_JSON is malformed",
			{ cause: error },
		);
	}
	plain(raw, "plugin context");
	const workspaceId = string(
		raw.workspace_id,
		"workspace_id",
		/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/,
	);
	const workspaceCwd = string(raw.workspace_cwd, "workspace_cwd");
	if (!isAbsolute(workspaceCwd))
		fail("invalid_context", "workspace_cwd must be absolute");
	let canonicalCwd;
	try {
		canonicalCwd = realpathSync(workspaceCwd);
	} catch (error) {
		fail("invalid_context", "workspace_cwd cannot be canonicalized", error);
	}
	const focusedPaneId =
		raw.focused_pane_id === undefined
			? null
			: string(
					raw.focused_pane_id,
					"focused_pane_id",
					/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/,
				);
	if (requireFocusedPane && focusedPaneId === null)
		fail("capability_unavailable", "focused_pane_id is required to assemble");
	return Object.freeze({
		workspaceId,
		workspaceCwd: canonicalCwd,
		focusedPaneId,
	});
}

function parseConfig(path) {
	let value;
	try {
		value = parseStrictJsonBytes(readFileSync(path), { maxBytes: 256 * 1024 });
	} catch (error) {
		fail(
			"invalid_config",
			`team config is not valid strict JSON: ${path}`,
			error,
		);
	}
	exactKeys(
		value,
		["version", "worktree_root", "roles"],
		["version", "roles"],
		"team config",
	);
	if (
		value.version !== 1 ||
		!Array.isArray(value.roles) ||
		value.roles.length === 0 ||
		value.roles.length > 64
	) {
		fail("invalid_config", "team config requires version 1 and 1-64 roles");
	}
	const seen = new Set();
	const roles = value.roles.map((role, index) => {
		exactKeys(
			role,
			["name", "kind", "mode", "launch_args"],
			["name", "kind"],
			`roles[${index}]`,
		);
		const name = string(role.name, `roles[${index}].name`, ROLE_NAME);
		if (seen.has(name)) fail("invalid_config", `duplicate role name: ${name}`);
		seen.add(name);
		const kind = string(role.kind, `roles[${index}].kind`, KIND);
		const mode = role.mode ?? "write";
		if (!MODES.has(mode))
			fail("invalid_config", `role ${name} has invalid mode`);
		const launchArgs = role.launch_args ?? [];
		if (
			!Array.isArray(launchArgs) ||
			launchArgs.length > 32 ||
			launchArgs.some((arg) => typeof arg !== "string" || /[\0\r\n]/.test(arg))
		) {
			fail("invalid_config", `role ${name} has invalid launch_args`);
		}
		return Object.freeze({
			name,
			kind,
			mode,
			launchArgs: Object.freeze([...launchArgs]),
			worktree: mode !== "read-only",
		});
	});
	const worktreeRoot = value.worktree_root ?? ".conductor-worktrees";
	string(worktreeRoot, "worktree_root");
	if (
		isAbsolute(worktreeRoot) ||
		worktreeRoot.split(/[\\/]/).some((part) => part === "..")
	)
		fail(
			"invalid_config",
			"worktree_root must be relative and contained in the repository",
		);
	return Object.freeze({ roles: Object.freeze(roles), worktreeRoot });
}

function sha256(value) {
	return createHash("sha256")
		.update(typeof value === "string" ? value : canonicalJson(value))
		.digest("hex");
}

function defaultExec(command, args, options = {}) {
	try {
		return execFileSync(command, args, {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
			timeout: 60_000,
			killSignal: "SIGKILL",
			...options,
		}).trim();
	} catch (error) {
		const stderr =
			typeof error?.stderr === "string"
				? error.stderr.trim().slice(0, 4096)
				: "";
		fail(
			"external_operation_failed",
			`${command} ${args.join(" ")} failed${stderr ? `: ${stderr}` : ""}`,
			error,
		);
	}
}

function gitLine(exec, repo, args) {
	const output = exec("git", ["-C", repo, ...args]);
	if (typeof output !== "string" || !output || output.includes("\n"))
		fail(
			"invalid_repository",
			`git ${args.join(" ")} returned ambiguous output`,
		);
	return output;
}

function randomToken(bytes, random = randomBytes) {
	return random(bytes).toString("hex");
}

function operationFault(fault, operationType) {
	if (typeof fault !== "function") return undefined;
	return (name) => {
		fault(`${operationType}:${name}`);
		fault(name);
	};
}

function inspectWorktreeTarget(
	repositoryRoot,
	target,
	{ createParents = false } = {},
) {
	const relativeTarget = relative(repositoryRoot, target);
	if (
		relativeTarget === "" ||
		relativeTarget === ".." ||
		relativeTarget.startsWith(`..${sep}`) ||
		isAbsolute(relativeTarget)
	)
		fail("invalid_config", "worktree target escapes the repository");
	let cursor = repositoryRoot;
	const parts = relativeTarget.split(/[\\/]/);
	for (const [index, part] of parts.entries()) {
		cursor = join(cursor, part);
		let stats;
		try {
			stats = lstatSync(cursor);
		} catch (error) {
			if (error?.code !== "ENOENT")
				fail("invalid_config", "worktree path cannot be inspected", error);
			if (!createParents || index === parts.length - 1) {
				for (const remainder of parts.slice(index + 1))
					cursor = join(cursor, remainder);
				break;
			}
			mkdirSync(cursor, { mode: 0o700 });
			stats = lstatSync(cursor);
		}
		if (stats) {
			if (stats.isSymbolicLink())
				fail("invalid_config", "worktree path must not contain symlinks");
			if (index === parts.length - 1)
				fail("invalid_config", "worktree target already exists");
			if (!stats.isDirectory())
				fail("invalid_config", "worktree parent is not a directory");
		}
	}
	if (resolve(target) !== target)
		fail("invalid_config", "worktree target is not normalized");
}

export async function assemble({
	contextJson = process.env.HERDR_PLUGIN_CONTEXT_JSON,
	stateRoot = runtimeStateRoot(),
	configPath,
	herdrBin = process.env.HERDR_BIN_PATH ?? "herdr",
	exec = defaultExec,
	random = randomBytes,
	fault,
} = {}) {
	const context = parsePluginContext(contextJson, { requireFocusedPane: true });
	const repository = resolveGitCommonDirectory(context.workspaceCwd);
	if (repository.repositoryRoot !== context.workspaceCwd)
		fail(
			"foreign_repository",
			"workspace_cwd must be the canonical repository root",
		);
	const config = parseConfig(
		configPath ?? join(repository.repositoryRoot, ".herdr-conductor.json"),
	);
	const runId = `r-${randomToken(12, random)}`;
	const generation = randomToken(16, random);
	validateId(runId, "run id");
	validateGeneration(generation, "run generation");
	const plannedWorktrees = config.roles
		.filter((role) => role.worktree)
		.map((role) => ({
			role,
			path: resolve(
				repository.repositoryRoot,
				config.worktreeRoot,
				runId,
				role.name,
			),
		}));
	for (const planned of plannedWorktrees)
		inspectWorktreeTarget(repository.repositoryRoot, planned.path);
	requireHerdrRuntime(exec, herdrBin);
	requireAnchor(exec, herdrBin, context);
	const store = openRepositoryStore({
		stateRoot,
		repoPath: context.workspaceCwd,
		fault,
	});
	const forkSha = gitLine(exec, store.repositoryRoot, ["rev-parse", "HEAD"]);
	validateGitObjectId(forkSha, "fork SHA");
	const lock = acquireRepositoryLock(store, {
		operationId: `assemble-${runId}`,
		fault,
	});
	try {
		const created = createRun(lock, {
			workspaceId: context.workspaceId,
			runId,
			generation,
			forkSha,
			fault,
		});
		let active = { store, state: created.state };
		const integrationTarget = bindIntegrationTarget(active, exec);
		await performJournaledOperation(lock, {
			workspaceId: context.workspaceId,
			runId,
			runGeneration: generation,
			operationId: `integration-${generation.slice(0, 12)}`,
			operationType: "integration.bind",
			subject: { kind: "git", id: "integration", generation },
			requestDigest: sha256(integrationTarget),
			fault:
				typeof fault === "function"
					? (name) => fault(`integration.bind:${name}`)
					: undefined,
			effect: async () => {
				const observedIdentity = bindIntegrationTarget(active, exec);
				if (
					canonicalJson(observedIdentity) !== canonicalJson(integrationTarget)
				)
					fail("foreign_or_stale", "integration target changed during binding");
				return {
					resultDigest: sha256(observedIdentity),
					observedIdentity,
				};
			},
		});
		active = loadActiveRun(store, { workspaceId: context.workspaceId });
		const rows = [];
		for (const [index, role] of config.roles.entries()) {
			let cwd = store.repositoryRoot;
			if (role.worktree) {
				const resourceGeneration = randomToken(16, random);
				const branchRef = `refs/heads/conductor/${runId}/${role.name}`;
				const worktreePath = plannedWorktrees.find(
					(planned) => planned.role === role,
				).path;
				const request = {
					path: worktreePath,
					branch_ref: branchRef,
					fork_sha: forkSha,
				};
				await performJournaledOperation(lock, {
					workspaceId: context.workspaceId,
					runId,
					runGeneration: generation,
					operationId: `worktree-${index}-${resourceGeneration.slice(0, 12)}`,
					operationType: "worktree.create",
					subject: {
						kind: "worktree",
						id: role.name,
						generation: resourceGeneration,
					},
					requestDigest: sha256(request),
					fault: operationFault(fault, "worktree.create"),
					effect: async () => {
						inspectWorktreeTarget(store.repositoryRoot, worktreePath, {
							createParents: true,
						});
						inspectWorktreeTarget(store.repositoryRoot, worktreePath);
						exec("git", [
							"-C",
							store.repositoryRoot,
							"worktree",
							"add",
							"-b",
							branchRef.slice("refs/heads/".length),
							worktreePath,
							forkSha,
						]);
						const observedIdentity = observeCreatedWorktree(
							worktreePath,
							branchRef,
							forkSha,
							store.repository,
							exec,
						);
						return { resultDigest: sha256(observedIdentity), observedIdentity };
					},
				});
				cwd = realpathSync(worktreePath);
			}
			const paneGeneration = randomToken(16, random);
			let paneId;
			await performJournaledOperation(lock, {
				workspaceId: context.workspaceId,
				runId,
				runGeneration: generation,
				operationId: `pane-${index}-${paneGeneration.slice(0, 12)}`,
				operationType: "pane.create",
				subject: { kind: "pane", id: role.name, generation: paneGeneration },
				requestDigest: sha256({ anchor: context.focusedPaneId, cwd }),
				fault: operationFault(fault, "pane.create"),
				effect: async () => {
					requireAnchor(exec, herdrBin, context);
					const split = paneFrom(
						herdrJson(exec, herdrBin, [
							"pane",
							"split",
							context.focusedPaneId,
							"--direction",
							"right",
							"--cwd",
							cwd,
							"--no-focus",
						]),
					);
					paneId = string(split.pane_id, "split pane_id", KIND);
					const observed = paneFrom(
						herdrJson(exec, herdrBin, ["pane", "get", paneId]),
					);
					const observedIdentity = paneCreationIdentity(
						observed,
						active,
						paneGeneration,
						cwd,
					);
					if (
						observedIdentity.workspace_id !== context.workspaceId ||
						observedIdentity.pane_id !== paneId ||
						observedIdentity.cwd !== cwd
					) {
						fail(
							"foreign_or_stale",
							"new pane identity does not match its intent",
						);
					}
					return { resultDigest: sha256(observedIdentity), observedIdentity };
				},
			});
			const agentName = `${role.name.slice(0, 14)}-${randomToken(6, random)}`;
			await performJournaledOperation(lock, {
				workspaceId: context.workspaceId,
				runId,
				runGeneration: generation,
				operationId: `agent-${index}-${paneGeneration.slice(0, 12)}`,
				operationType: "agent.start",
				subject: { kind: "agent", id: role.name, generation: paneGeneration },
				requestDigest: sha256({
					pane_id: paneId,
					name: agentName,
					kind: role.kind,
					args: role.launchArgs,
				}),
				fault: operationFault(fault, "agent.start"),
				effect: async () => {
					startAgentWhenReady(exec, herdrBin, [
						"agent",
						"start",
						agentName,
						"--kind",
						role.kind,
						"--pane",
						paneId,
						"--timeout",
						"60000",
						...(role.launchArgs.length ? ["--", ...role.launchArgs] : []),
					]);
					exec(herdrBin, [
						"pane",
						"report-metadata",
						paneId,
						"--source",
						"structupath.conductor",
						"--token",
						`conductor_run_id=${runId}`,
						"--token",
						`conductor_generation=${paneGeneration}`,
					]);
					const observedIdentity = observeStartedAgent(exec, herdrBin, {
						workspaceId: context.workspaceId,
						paneId,
						agentName,
						agentKind: role.kind,
						runId,
						generation: paneGeneration,
						cwd,
					});
					return { resultDigest: sha256(observedIdentity), observedIdentity };
				},
			});
			rows.push({
				role: role.name,
				kind: role.kind,
				cwd,
				agent_name: agentName,
				pane_id: paneId,
			});
		}
		return { run_id: runId, generation, fork_sha: forkSha, workers: rows };
	} finally {
		releaseRepositoryLock(lock);
	}
}

function exactObservedEntries(active, operationType) {
	const entries = active.journal.filter(
		(entry) =>
			entry.operation_type === operationType && entry.phase === "observed",
	);
	const identities = new Set();
	for (const entry of entries) {
		if (entry.observed_identity === null)
			fail(
				"bookkeeping_unknown",
				`${operationType} is missing observed identity`,
			);
		const key = entry.subject.id;
		if (identities.has(key))
			fail("bookkeeping_unknown", `${operationType} authority is duplicated`);
		identities.add(key);
	}
	return entries;
}

function existingObserved(active, operationId, operationType) {
	const matching = active.journal.filter(
		(entry) =>
			entry.operation_id === operationId &&
			entry.operation_type === operationType,
	);
	if (matching.length > 1)
		fail("bookkeeping_unknown", "operation authority is duplicated");
	return matching[0]?.phase === "observed" ? matching[0] : null;
}

export async function reconcile({
	contextJson = process.env.HERDR_PLUGIN_CONTEXT_JSON,
	stateRoot = runtimeStateRoot(),
	herdrBin = process.env.HERDR_BIN_PATH ?? "herdr",
	exec = defaultExec,
	fault,
} = {}) {
	const context = parsePluginContext(contextJson);
	requireHerdrRuntime(exec, herdrBin);
	const store = openExistingStore({
		stateRoot,
		repoPath: context.workspaceCwd,
	});
	if (store.repositoryRoot !== context.workspaceCwd)
		fail(
			"foreign_repository",
			"workspace_cwd must be the canonical repository root",
		);
	const lock = acquireRepositoryLock(store, {
		operationId: `harvest-${sha256(context.workspaceId).slice(0, 24)}`,
		fault,
	});
	try {
		let active = loadActiveRun(store, { workspaceId: context.workspaceId });
		const sources = exactObservedEntries(active, "worktree.create");
		const targets = exactObservedEntries(active, "integration.bind");
		if (targets.length !== 1)
			fail(
				"bookkeeping_unknown",
				"run must have exactly one integration target binding",
			);
		for (const sourceEntry of sources)
			liveSourceIdentity(sourceEntry.observed_identity, active, exec);
		let expectedTarget = liveIntegrationTarget(
			targets[0].observed_identity,
			active,
			exec,
		);
		const results = [];
		for (const sourceEntry of sources) {
			const operationId = `merge-${sourceEntry.subject.id}-${sourceEntry.subject.generation.slice(0, 12)}`;
			const prior = existingObserved(active, operationId, "git.merge");
			if (prior) {
				await performJournaledOperation(lock, {
					workspaceId: context.workspaceId,
					runId: active.state.run_id,
					runGeneration: active.state.generation,
					operationId,
					operationType: "git.merge",
					subject: sourceEntry.subject,
					requestDigest: prior.request_digest,
					effect: async () => {
						throw new Error("observed merge replayed");
					},
				});
				expectedTarget = prior.observed_identity.target;
				liveIntegrationTarget(expectedTarget, active, exec);
				results.push({
					role: sourceEntry.subject.id,
					replayed: true,
					result_digest: prior.result_digest,
				});
				continue;
			}
			const source = liveSourceIdentity(
				sourceEntry.observed_identity,
				active,
				exec,
			);
			const target = liveIntegrationTarget(expectedTarget, active, exec);
			const requestDigest = sha256({
				source,
				target,
				fork_sha: active.state.fork_sha,
			});
			const mergeFault = operationFault(fault, "git.merge");
			const result = await performJournaledOperation(lock, {
				workspaceId: context.workspaceId,
				runId: active.state.run_id,
				runGeneration: active.state.generation,
				operationId,
				operationType: "git.merge",
				subject: sourceEntry.subject,
				requestDigest,
				fault: mergeFault,
				effect: async () => {
					const merged = mergeImmutableSource({
						active,
						recordedSource: sourceEntry.observed_identity,
						expectedTarget: target,
						exec,
						fault: mergeFault,
					});
					return {
						resultDigest: sha256(merged.result),
						observedIdentity: merged.result,
					};
				},
				validateBeforeResultPublication: async (observation) => {
					validateMergeResultPublication({
						active,
						result: observation.observedIdentity,
						exec,
					});
				},
			});
			results.push({
				role: sourceEntry.subject.id,
				replayed: result.replayed,
				result_digest: result.resultDigest,
			});
			active = loadActiveRun(store, { workspaceId: context.workspaceId });
			const observed = existingObserved(active, operationId, "git.merge");
			if (!observed)
				fail("bookkeeping_unknown", "successful merge result is missing");
			expectedTarget = observed.observed_identity.target;
		}
		return {
			run_id: active.state.run_id,
			workspace_id: context.workspaceId,
			merges: results,
		};
	} finally {
		releaseRepositoryLock(lock);
	}
}

export async function standDown({
	contextJson = process.env.HERDR_PLUGIN_CONTEXT_JSON,
	stateRoot = runtimeStateRoot(),
	herdrBin = process.env.HERDR_BIN_PATH ?? "herdr",
	exec = defaultExec,
	fault,
} = {}) {
	const context = parsePluginContext(contextJson);
	requireHerdrRuntime(exec, herdrBin);
	const store = openExistingStore({
		stateRoot,
		repoPath: context.workspaceCwd,
	});
	if (store.repositoryRoot !== context.workspaceCwd)
		fail(
			"foreign_repository",
			"workspace_cwd must be the canonical repository root",
		);
	const lock = acquireRepositoryLock(store, {
		operationId: `stand-down-${sha256(context.workspaceId).slice(0, 24)}`,
		fault,
	});
	try {
		let active;
		try {
			active = loadActiveRun(store, { workspaceId: context.workspaceId });
		} catch (error) {
			if (
				!(error instanceof StateKernelError) ||
				error.code !== "state_unknown"
			)
				throw error;
			const recovery = findRecoverableArchive(store, {
				workspaceId: context.workspaceId,
			});
			if (!recovery) throw error;
			const archiveEntry = recovery.entry;
			archiveActiveRun(lock, {
				workspaceId: context.workspaceId,
				runId: recovery.active.state.run_id,
				runGeneration: recovery.active.state.generation,
				operationId: archiveEntry.operation_id,
				subject: archiveEntry.subject,
				requestDigest: archiveEntry.request_digest,
				fault: operationFault(fault, "run.archive"),
			});
			const closedSubjects = new Set(
				recovery.active.journal
					.filter(
						(entry) =>
							entry.operation_type === "pane.close" &&
							entry.phase === "observed",
					)
					.map((entry) => `${entry.subject.id}:${entry.subject.generation}`),
			);
			const closed = recovery.active.journal
				.filter(
					(entry) =>
						entry.operation_type === "agent.start" &&
						closedSubjects.has(
							`${entry.subject.id}:${entry.subject.generation}`,
						),
				)
				.map((entry) => entry.observed_identity.pane_id);
			return {
				run_id: recovery.active.state.run_id,
				workspace_id: context.workspaceId,
				closed,
				archived: true,
			};
		}
		const panes = exactObservedEntries(active, "agent.start");
		const pendingPanes = panes.filter((paneEntry) => {
			const operationId = `close-${paneEntry.subject.id}-${paneEntry.subject.generation.slice(0, 12)}`;
			return !existingObserved(active, operationId, "pane.close");
		});
		for (const paneEntry of pendingPanes)
			liveCloseIdentity(active, paneEntry.observed_identity, exec, herdrBin);
		const closed = panes
			.filter((paneEntry) => !pendingPanes.includes(paneEntry))
			.map((paneEntry) => paneEntry.observed_identity.pane_id);
		for (const paneEntry of pendingPanes) {
			const recorded = paneEntry.observed_identity;
			const operationId = `close-${paneEntry.subject.id}-${paneEntry.subject.generation.slice(0, 12)}`;
			liveCloseIdentity(active, recorded, exec, herdrBin);
			const subject = {
				kind: "pane",
				id: paneEntry.subject.id,
				generation: paneEntry.subject.generation,
			};
			const requestDigest = sha256(recorded);
			await performJournaledOperation(lock, {
				workspaceId: context.workspaceId,
				runId: active.state.run_id,
				runGeneration: active.state.generation,
				operationId,
				operationType: "pane.close",
				subject,
				requestDigest,
				fault: operationFault(fault, "pane.close"),
				effect: async () => {
					liveCloseIdentity(active, recorded, exec, herdrBin);
					herdrJson(exec, herdrBin, ["pane", "close", recorded.pane_id]);
					return {
						resultDigest: sha256({ pane_id: recorded.pane_id, closed: true }),
					};
				},
			});
			closed.push(recorded.pane_id);
			active = loadActiveRun(store, { workspaceId: context.workspaceId });
		}
		const archiveOperationId = `archive-${active.state.generation.slice(0, 12)}`;
		const archiveSubject = {
			kind: "run",
			id: active.state.run_id,
			generation: active.state.generation,
		};
		const archiveDigest = sha256({
			run_id: active.state.run_id,
			generation: active.state.generation,
		});
		archiveActiveRun(lock, {
			workspaceId: context.workspaceId,
			runId: active.state.run_id,
			runGeneration: active.state.generation,
			operationId: archiveOperationId,
			subject: archiveSubject,
			requestDigest: archiveDigest,
			fault: operationFault(fault, "run.archive"),
		});
		return {
			run_id: active.state.run_id,
			workspace_id: context.workspaceId,
			closed,
			archived: true,
		};
	} finally {
		releaseRepositoryLock(lock);
	}
}

export function readStatus({
	contextJson = process.env.HERDR_PLUGIN_CONTEXT_JSON,
	stateRoot = runtimeStateRoot(),
	herdrBin = process.env.HERDR_BIN_PATH ?? "herdr",
	exec = defaultExec,
} = {}) {
	const context = parsePluginContext(contextJson);
	requireHerdrRuntime(exec, herdrBin);
	const store = openExistingStore({
		stateRoot,
		repoPath: context.workspaceCwd,
	});
	if (store.repositoryRoot !== context.workspaceCwd)
		fail(
			"foreign_repository",
			"workspace_cwd must be the canonical repository root",
		);
	const active = loadActiveRun(store, { workspaceId: context.workspaceId });
	if (
		active.journal.some(
			(entry) =>
				new Set(["worktree.create", "pane.create", "agent.start"]).has(
					entry.operation_type,
				) &&
				entry.phase === "observed" &&
				entry.observed_identity === null,
		)
	) {
		fail(
			"bookkeeping_unknown",
			"B2 creation journal is missing exact observed identity",
		);
	}
	const workers = active.journal
		.filter(
			(entry) =>
				entry.operation_type === "agent.start" && entry.phase === "observed",
		)
		.map((entry) => {
			const recorded = entry.observed_identity;
			let liveStatus = "unavailable";
			try {
				liveStatus = readHerdrIdentity(
					active,
					recorded,
					exec,
					herdrBin,
				).agentStatus;
			} catch (error) {
				liveStatus =
					error instanceof StateKernelError && error.code === "foreign_or_stale"
						? "foreign_or_stale"
						: "unavailable";
			}
			return {
				role: entry.subject.id,
				kind: recorded.agent_kind,
				pane: recorded.pane_id,
				agent: recorded.agent_name,
				cwd: recorded.cwd,
				status: liveStatus,
			};
		});
	return {
		run: active.state.run_id,
		generation: active.state.generation,
		repository_key: store.repository.key,
		workspace_id: context.workspaceId,
		fork_sha: active.state.fork_sha,
		workers,
	};
}

function printTable(status) {
	console.log(
		`run ${status.run}  workspace ${status.workspace_id}  fork ${status.fork_sha}`,
	);
	console.log(
		"ROLE              KIND      PANE            STATUS             CWD",
	);
	for (const worker of status.workers)
		console.log(
			`${worker.role.padEnd(17)} ${worker.kind.padEnd(9)} ${worker.pane.padEnd(15)} ${worker.status.padEnd(18)} ${worker.cwd}`,
		);
}

async function main() {
	const command = process.argv[2];
	if (command === "assemble")
		console.log(canonicalJson(await assemble()).trimEnd());
	else if (command === "status") printTable(readStatus());
	else if (command === "board")
		console.log(canonicalJson(readStatus()).trimEnd());
	else if (command === "harvest")
		console.log(canonicalJson(await reconcile()).trimEnd());
	else if (command === "stand-down")
		console.log(canonicalJson(await standDown()).trimEnd());
	else {
		console.error(
			"usage: stage1-runtime.mjs assemble|board|status|harvest|stand-down",
		);
		process.exitCode = 64;
	}
}

if (
	process.argv[1] &&
	resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
	main().catch((error) => {
		console.error(
			`herdr-conductor: ${error.code ?? "internal_error"}: ${error.message}`,
		);
		process.exitCode = 1;
	});
}

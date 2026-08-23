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
import { stateRootForConfig } from "./state-root.mjs";
import {
	StateKernelError,
	canonicalJson,
	parseStrictJsonBytes,
	validateGeneration,
	validateGitObjectId,
	validateId,
	validateStage3ApplyIdentity,
	validateStage3ConsumptionIdentity,
	validateStage3PreviewIdentity,
} from "./private-state-schema.mjs";
import {
	parseReportBytes,
	parseStage2ConfigBytes,
	parseTaskBytes,
	taskDigest,
	validateTask,
} from "./task-report-schema.mjs";
import {
	loadAuthoritativeTaskByExactPath,
	publishTaskAuthority,
} from "./task-authority.mjs";
import { harvestCommittedReport } from "./report-harvest.mjs";
import {
	scanStage2Authority,
	standDownReasonForState,
} from "./stage2-lifecycle.mjs";
import { inspectProducerSource } from "./source-policy.mjs";
import {
	acquireRepositoryLock,
	archiveActiveRun,
	createRun,
	inspectArchiveUncertainty,
	inspectRepositoryLock,
	loadActiveRun,
	loadArchivedRun,
	openRepositoryStore,
	performJournaledOperation,
	readStablePrivateBytes,
	releaseRepositoryLock,
	resolveGitCommonDirectory,
	resolveUncertainApplyPublication,
} from "./state-kernel.mjs";
import {
	observeStage3ApplyTarget,
	publishStage3ApplyCas,
	resolveStage3ApplyOutcome,
	stage3ApplyTargetRef,
} from "./stage3-apply.mjs";
import { createGateSource, validateGateSource } from "./gate-source.mjs";
import {
	bindIntegrationTarget,
	buildOrderedProducerSelection,
	liveIntegrationTarget,
	liveSourceIdentity,
	observeCreatedWorktree,
	planCompleteIntegration,
	publishIntegrationCas,
	synchronizeIntegrationTarget,
	validateIntegrationPublication,
} from "./git-reconcile.mjs";
import {
	herdrJson,
	liveCloseIdentity,
	livePaneCreationIdentity,
	paneCreationIdentity,
	paneFrom,
	readHerdrIdentity,
	requireAnchor,
	requireHerdrRuntime,
	observeStartedAgent,
	startAgentWhenReady,
} from "./herdr-identity.mjs";

const KIND = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function fail(code, message, cause) {
	throw new StateKernelError(code, message, cause ? { cause } : undefined);
}

function refuseDeadRepositoryLock(store) {
	const lock = inspectRepositoryLock(store);
	if (lock.status !== "locked") return;
	try {
		process.kill(lock.owner.pid, 0);
	} catch (error) {
		if (error?.code !== "ESRCH") throw error;
		fail(
			"recovery_required",
			"operation_uncertain: retained dead-process lock requires recovery",
		);
	}
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
	let checked;
	try {
		checked = parseStage2ConfigBytes(readFileSync(path));
	} catch (error) {
		if (error instanceof StateKernelError) throw error;
		fail(
			"invalid_contract",
			`team config is not valid Stage 2 configuration: ${path}`,
			error,
		);
	}
	const roles = checked.roles.map((role) =>
		Object.freeze({
			...role,
			launchArgs: Object.freeze([]),
			worktree:
				role.contract_role === "builder" ||
				role.contract_role === "test_author",
		}),
	);
	return Object.freeze({
		version: checked.version,
		roles: Object.freeze(roles),
		path: resolve(path),
		stateRoot: stateRootForConfig(checked),
		worktreeRoot: checked.worktree_root,
		digest: sha256(checked),
		raw: checked,
	});
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

function validateRuntimeIntegrationPublication(
	exec,
	repository,
	targetRef,
	expectedSha,
) {
	const refSha = gitLine(exec, repository, ["rev-parse", targetRef]);
	const headSha = gitLine(exec, repository, ["rev-parse", "HEAD"]);
	const expectedTree = gitLine(exec, repository, [
		"rev-parse",
		`${expectedSha}^{tree}`,
	]);
	const headTree = gitLine(exec, repository, ["rev-parse", "HEAD^{tree}"]);
	const indexTree = gitLine(exec, repository, ["write-tree"]);
	const trackedStatus = exec("git", [
		"-C",
		repository,
		"status",
		"--porcelain=v1",
		"--untracked-files=no",
	]);
	if (
		refSha !== expectedSha ||
		headSha !== expectedSha ||
		headTree !== expectedTree ||
		indexTree !== expectedTree ||
		trackedStatus !== ""
	)
		fail(
			"stale_source",
			"integration ref, HEAD, tree, index, or tracked worktree changed",
		);
	return expectedSha;
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
	const stateRoot = config.stateRoot;
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
			requestDigest: sha256({
				configuration_digest: config.digest,
				integration_target: integrationTarget,
			}),
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
		const producerRoles = config.roles.filter((role) => role.worktree);
		for (const [index, role] of producerRoles.entries()) {
			let cwd = store.repositoryRoot;
			const resourceGeneration = randomToken(16, random);
			if (role.worktree) {
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
			active = loadActiveRun(store, { workspaceId: context.workspaceId });
			const worktreeEntry = active.journal.find(
				(entry) =>
					entry.operation_type === "worktree.create" &&
					entry.phase === "observed" &&
					entry.subject.id === role.name &&
					entry.subject.generation === resourceGeneration,
			);
			if (!worktreeEntry)
				fail("bookkeeping_unknown", "observed producer source is missing");
			const paneGeneration = randomToken(16, random);
			const agentGeneration = randomToken(16, random);
			const taskGeneration = randomToken(16, random);
			const outboxGeneration = randomToken(16, random);
			const agentName = `${role.name.slice(0, 14)}-${randomToken(6, random)}`;
			const paneOperationId = `pane-${index}-${paneGeneration.slice(0, 12)}`;
			const agentOperationId = `agent-${index}-${agentGeneration.slice(0, 12)}`;
			const agentRequestDigest = sha256({
				name: agentName,
				kind: role.kind,
				args: [],
				pane_operation_id: paneOperationId,
				pane_generation: paneGeneration,
				agent_generation: agentGeneration,
			});
			const sourceTree = gitLine(exec, cwd, ["rev-parse", "HEAD^{tree}"]);
			const roleIdentity = {
				name: role.name,
				contract_role: role.contract_role,
				agent_kind: role.kind,
				configured_mode: role.mode,
				source_generation: resourceGeneration,
				pane_generation: paneGeneration,
				agent_generation: agentGeneration,
				pane_operation_id: paneOperationId,
				agent_operation_id: agentOperationId,
				agent_request_digest: agentRequestDigest,
				agent_name: agentName,
			};
			const source = {
				kind: "role_worktree",
				root: cwd,
				common_dir: worktreeEntry.observed_identity.common_dir,
				branch_ref: worktreeEntry.observed_identity.branch_ref,
				fork_sha: forkSha,
				expected_sha: forkSha,
				tree_sha: sourceTree,
				worktree_generation: resourceGeneration,
				worktree_entry_digest: worktreeEntry.entry_digest,
				registered: true,
			};
			const outboxRoot = join(
				active.paths.outboxesDir,
				role.name,
				resourceGeneration,
				taskGeneration,
				outboxGeneration,
			);
			const taskBase = {
				document_type: "herdr-conductor-task",
				schema_version: 1,
				task_id: `task-${role.name}`,
				task_generation: taskGeneration,
				scope: {
					repository: active.state.repository,
					repository_root: active.state.repository_root,
					workspace_id: active.state.workspace_id,
					workspace_key: active.state.workspace_key,
					run_id: active.state.run_id,
					run_generation: active.state.generation,
				},
				role: roleIdentity,
				source,
				outbox: {
					outbox_id: `outbox-${role.name}`,
					outbox_generation: outboxGeneration,
					root: outboxRoot,
					slot_name: `report-task-${role.name}-${taskGeneration}-${outboxGeneration}`,
					payload_filename: "report.json",
					commit_filename: "COMMITTED.json",
				},
				assignment: role.assignment,
				validator_artifacts: [],
				created_at: new Date().toISOString(),
			};
			const task = validateTask({
				...taskBase,
				task_digest: taskDigest(taskBase),
			});
			const taskAuthority = await publishTaskAuthority(lock, {
				workspaceId: context.workspaceId,
				runId,
				runGeneration: generation,
				task,
				configurationDigest: config.digest,
				fault: operationFault(fault, "task.publish"),
			});
			const publisherCommand = `node ${JSON.stringify(fileURLToPath(new URL("./report-publisher.mjs", import.meta.url)))} publish --config ${JSON.stringify(config.path)} --task ${JSON.stringify(taskAuthority.taskPath)}`;
			let paneId;
			await performJournaledOperation(lock, {
				workspaceId: context.workspaceId,
				runId,
				runGeneration: generation,
				operationId: paneOperationId,
				operationType: "pane.create",
				subject: { kind: "pane", id: role.name, generation: paneGeneration },
				requestDigest: sha256({
					anchor: context.focusedPaneId,
					cwd,
					task_digest: task.task_digest,
				}),
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
			fault?.("producer.after_pane_observed");
			await performJournaledOperation(lock, {
				workspaceId: context.workspaceId,
				runId,
				runGeneration: generation,
				operationId: agentOperationId,
				operationType: "agent.start",
				subject: { kind: "agent", id: role.name, generation: agentGeneration },
				requestDigest: agentRequestDigest,
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
				task_path: taskAuthority.taskPath,
				outbox_slot: taskAuthority.slotPath,
				publisher_command: publisherCommand,
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

function validateRunConfiguration(active, config) {
	const bindings = exactObservedEntries(active, "integration.bind");
	if (bindings.length !== 1)
		fail("bookkeeping_unknown", "run configuration binding is missing");
	const expected = sha256({
		configuration_digest: config.digest,
		integration_target: bindings[0].observed_identity,
	});
	if (bindings[0].request_digest !== expected)
		fail("stale_task", "active run configuration digest changed");
	return bindings[0];
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

function taskPathForRole(active, roleName) {
	const entries = active.journal.filter(
		(entry) =>
			entry.operation_type === "task.publish" &&
			entry.phase === "observed" &&
			entry.subject.id === roleName,
	);
	if (entries.length !== 1)
		fail("bookkeeping_unknown", "role task authority is missing or duplicated");
	return join(
		active.paths.tasksDir,
		roleName,
		`${entries[0].subject.generation}.json`,
	);
}

function gateTaskSource(sourceEntry) {
	const observed = sourceEntry.observed_identity;
	return {
		kind: "integration_snapshot",
		root: observed.root,
		common_dir: observed.common_dir,
		head_mode: observed.head_mode,
		base_sha: observed.base_sha,
		integration_sha: observed.integration_sha,
		tree_sha: observed.tree_sha,
		snapshot_generation: observed.snapshot_generation,
		snapshot_entry_digest: sourceEntry.entry_digest,
		integration_entry_digest: observed.integration_entry_digest,
		registered: observed.registered,
	};
}

async function provisionAndCollectGates({
	lock,
	context,
	config,
	stateRoot,
	herdrBin,
	exec,
	random,
	fault,
}) {
	let active = loadActiveRun(lock.store, { workspaceId: context.workspaceId });
	const integrationEntries = active.journal.filter(
		(entry) =>
			entry.operation_type === "integration.harvest" &&
			entry.phase === "observed",
	);
	if (integrationEntries.length !== 1)
		fail(
			"bookkeeping_unknown",
			"gate provisioning requires one integration harvest",
		);
	const integrationEntry = integrationEntries[0];
	const integration = integrationEntry.observed_identity;
	const gateRoles = config.roles
		.filter(
			(role) =>
				role.contract_role === "reviewer" || role.contract_role === "validator",
		)
		.sort((left, right) =>
			Buffer.compare(Buffer.from(left.name), Buffer.from(right.name)),
		);
	if (gateRoles.length === 0)
		return {
			run_id: active.state.run_id,
			workspace_id: context.workspaceId,
			lifecycle: "integration_harvested_no_gates",
			integration,
			gate_workers: [],
		};
	const initialRefusals = gateSourceRefusals(active, config, exec);
	if (initialRefusals.length > 0)
		return {
			run_id: active.state.run_id,
			workspace_id: context.workspaceId,
			lifecycle: "gate_source_refused",
			integration,
			source_refused: initialRefusals,
			gate_workers: [],
		};
	const execFile =
		exec === defaultExec
			? undefined
			: (command, args, options = {}) => exec(command, args, options);
	const validateAllGateSources = () => {
		const current = loadActiveRun(lock.store, {
			workspaceId: context.workspaceId,
		});
		for (const role of gateRoles) {
			const entries = current.journal.filter(
				(entry) =>
					entry.operation_type === "gate-source.create" &&
					entry.phase === "observed" &&
					entry.subject.id === role.name,
			);
			if (entries.length !== 1)
				fail(
					"bookkeeping_unknown",
					"gate source barrier is incomplete or duplicated",
				);
			validateGateSource(
				gateTaskSource(entries[0]),
				execFile ? { exec: execFile } : undefined,
			);
		}
		return current;
	};
	for (const role of gateRoles) {
		active = loadActiveRun(lock.store, { workspaceId: context.workspaceId });
		const existing = active.journal.filter(
			(entry) =>
				entry.operation_type === "gate-source.create" &&
				entry.subject.id === role.name,
		);
		if (existing.length > 1)
			fail("bookkeeping_unknown", "gate source authority is duplicated");
		if (existing[0]?.phase === "observed") continue;
		if (existing.length)
			fail("recovery_required", "gate source creation is uncertain");
		const sourceGeneration = randomToken(16, random);
		const destination = resolve(
			lock.store.repositoryRoot,
			config.worktreeRoot,
			active.state.run_id,
			role.name,
		);
		inspectWorktreeTarget(lock.store.repositoryRoot, destination);
		const request = {
			role_name: role.name,
			destination,
			base_sha: integration.starting_sha,
			integration_sha: integration.final_sha,
			integration_entry_digest: integrationEntry.entry_digest,
		};
		await performJournaledOperation(lock, {
			workspaceId: context.workspaceId,
			runId: active.state.run_id,
			runGeneration: active.state.generation,
			operationId: `gate-source-${role.name}-${sourceGeneration}`,
			operationType: "gate-source.create",
			subject: {
				kind: "snapshot",
				id: role.name,
				generation: sourceGeneration,
			},
			requestDigest: sha256(request),
			fault: operationFault(fault, "gate-source.create"),
			effect: async () => {
				inspectWorktreeTarget(lock.store.repositoryRoot, destination, {
					createParents: true,
				});
				inspectWorktreeTarget(lock.store.repositoryRoot, destination);
				const observedIdentity = createGateSource({
					repository: lock.store.repositoryRoot,
					destination,
					integrationSha: integration.final_sha,
					baseSha: integration.starting_sha,
					generation: sourceGeneration,
					integrationEntryDigest: integrationEntry.entry_digest,
					execFile,
				});
				return {
					resultDigest: sha256(observedIdentity),
					observedIdentity,
				};
			},
			validateBeforeResultPublication: async (_result) => {
				validateGateSource(
					{
						kind: "integration_snapshot",
						root: destination,
						common_dir: lock.store.repository.common_dir,
						integration_sha: integration.final_sha,
						tree_sha: gitLine(exec, destination, ["rev-parse", "HEAD^{tree}"]),
					},
					execFile ? { exec: execFile } : undefined,
				);
			},
		});
	}
	validateAllGateSources();
	for (const [index, role] of gateRoles.entries()) {
		active = validateAllGateSources();
		const taskEntries = active.journal.filter(
			(entry) =>
				entry.operation_type === "task.publish" &&
				entry.subject.id === role.name,
		);
		if (taskEntries.length > 1)
			fail("bookkeeping_unknown", "gate task authority is duplicated");
		if (taskEntries[0]?.phase === "observed") continue;
		if (taskEntries.length)
			fail("recovery_required", "gate task publication is uncertain");
		const sourceEntry = active.journal.find(
			(entry) =>
				entry.operation_type === "gate-source.create" &&
				entry.phase === "observed" &&
				entry.subject.id === role.name,
		);
		const source = gateTaskSource(sourceEntry);
		const paneGeneration = randomToken(16, random);
		const agentGeneration = randomToken(16, random);
		const taskGeneration = randomToken(16, random);
		const outboxGeneration = randomToken(16, random);
		const agentName = `${role.name.slice(0, 14)}-${randomToken(6, random)}`;
		const paneOperationId = `gate-pane-${index}-${paneGeneration.slice(0, 12)}`;
		const agentOperationId = `gate-agent-${index}-${agentGeneration.slice(0, 12)}`;
		const agentRequestDigest = sha256({
			name: agentName,
			kind: role.kind,
			args: [],
			pane_operation_id: paneOperationId,
			pane_generation: paneGeneration,
			agent_generation: agentGeneration,
			task_generation: taskGeneration,
		});
		const roleIdentity = {
			name: role.name,
			contract_role: role.contract_role,
			agent_kind: role.kind,
			configured_mode: role.mode,
			source_generation: source.snapshot_generation,
			pane_generation: paneGeneration,
			agent_generation: agentGeneration,
			pane_operation_id: paneOperationId,
			agent_operation_id: agentOperationId,
			agent_request_digest: agentRequestDigest,
			agent_name: agentName,
		};
		const outboxRoot = join(
			active.paths.outboxesDir,
			role.name,
			source.snapshot_generation,
			taskGeneration,
			outboxGeneration,
		);
		const taskBase = {
			document_type: "herdr-conductor-task",
			schema_version: 1,
			task_id: `task-${role.name}`,
			task_generation: taskGeneration,
			scope: {
				repository: active.state.repository,
				repository_root: active.state.repository_root,
				workspace_id: active.state.workspace_id,
				workspace_key: active.state.workspace_key,
				run_id: active.state.run_id,
				run_generation: active.state.generation,
			},
			role: roleIdentity,
			source,
			outbox: {
				outbox_id: `outbox-${role.name}`,
				outbox_generation: outboxGeneration,
				root: outboxRoot,
				slot_name: `report-task-${role.name}-${taskGeneration}-${outboxGeneration}`,
				payload_filename: "report.json",
				commit_filename: "COMMITTED.json",
			},
			assignment: role.assignment,
			validator_artifacts: [],
			created_at: new Date().toISOString(),
		};
		const task = validateTask({
			...taskBase,
			task_digest: taskDigest(taskBase),
		});
		await publishTaskAuthority(lock, {
			workspaceId: context.workspaceId,
			runId: active.state.run_id,
			runGeneration: active.state.generation,
			task,
			configurationDigest: config.digest,
			fault: operationFault(fault, "task.publish"),
		});
	}
	const gateTasks = () => {
		const current = validateAllGateSources();
		return gateRoles.map((role) => {
			const path = taskPathForRole(current, role.name);
			return loadAuthoritativeTaskByExactPath(path, stateRoot, {
				active: current,
				configurationDigest: config.digest,
				requireAttachedAgent: false,
			});
		});
	};
	let authorities = gateTasks();
	const revalidateAuthoritySources = () => {
		for (const authority of authorities)
			validateGateSource(
				authority.task.source,
				execFile ? { exec: execFile } : undefined,
			);
	};
	if (!context.focusedPaneId)
		fail(
			"capability_unavailable",
			"focused_pane_id is required for gate panes",
		);
	requireAnchor(exec, herdrBin, context);
	for (const authority of authorities) {
		active = loadActiveRun(lock.store, { workspaceId: context.workspaceId });
		const task = authority.task;
		const existingPane = existingObserved(
			active,
			task.role.pane_operation_id,
			"pane.create",
		);
		if (existingPane) continue;
		if (
			active.journal.some(
				(entry) => entry.operation_id === task.role.pane_operation_id,
			)
		)
			fail("recovery_required", "gate pane creation is uncertain");
		gateTasks();
		let paneId;
		await performJournaledOperation(lock, {
			workspaceId: context.workspaceId,
			runId: active.state.run_id,
			runGeneration: active.state.generation,
			operationId: task.role.pane_operation_id,
			operationType: "pane.create",
			subject: {
				kind: "pane",
				id: task.role.name,
				generation: task.role.pane_generation,
			},
			requestDigest: sha256({
				anchor: context.focusedPaneId,
				cwd: task.source.root,
				task_digest: task.task_digest,
			}),
			fault: operationFault(fault, "pane.create"),
			effect: async () => {
				revalidateAuthoritySources();
				requireAnchor(exec, herdrBin, context);
				const split = paneFrom(
					herdrJson(exec, herdrBin, [
						"pane",
						"split",
						context.focusedPaneId,
						"--direction",
						"right",
						"--cwd",
						task.source.root,
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
					task.role.pane_generation,
					task.source.root,
				);
				return {
					resultDigest: sha256(observedIdentity),
					observedIdentity,
				};
			},
		});
	}
	authorities = gateTasks();
	fault?.("gate.after_panes_observed");
	for (const authority of authorities) {
		active = loadActiveRun(lock.store, { workspaceId: context.workspaceId });
		const task = authority.task;
		const existingAgent = existingObserved(
			active,
			task.role.agent_operation_id,
			"agent.start",
		);
		if (existingAgent) continue;
		if (
			active.journal.some(
				(entry) => entry.operation_id === task.role.agent_operation_id,
			)
		)
			fail("recovery_required", "gate agent start is uncertain");
		const paneEntry = active.journal.find(
			(entry) =>
				entry.operation_id === task.role.pane_operation_id &&
				entry.operation_type === "pane.create" &&
				entry.phase === "observed",
		);
		if (!paneEntry)
			fail("bookkeeping_unknown", "gate pane barrier is incomplete");
		gateTasks();
		await performJournaledOperation(lock, {
			workspaceId: context.workspaceId,
			runId: active.state.run_id,
			runGeneration: active.state.generation,
			operationId: task.role.agent_operation_id,
			operationType: "agent.start",
			subject: {
				kind: "agent",
				id: task.role.name,
				generation: task.role.agent_generation,
			},
			requestDigest: task.role.agent_request_digest,
			fault: operationFault(fault, "agent.start"),
			effect: async () => {
				revalidateAuthoritySources();
				startAgentWhenReady(exec, herdrBin, [
					"agent",
					"start",
					task.role.agent_name,
					"--kind",
					task.role.agent_kind,
					"--pane",
					paneEntry.observed_identity.pane_id,
					"--timeout",
					"60000",
				]);
				exec(herdrBin, [
					"pane",
					"report-metadata",
					paneEntry.observed_identity.pane_id,
					"--source",
					"structupath.conductor",
					"--token",
					`conductor_run_id=${active.state.run_id}`,
					"--token",
					`conductor_generation=${task.role.pane_generation}`,
				]);
				const observedIdentity = observeStartedAgent(exec, herdrBin, {
					workspaceId: context.workspaceId,
					paneId: paneEntry.observed_identity.pane_id,
					agentName: task.role.agent_name,
					agentKind: task.role.agent_kind,
					runId: active.state.run_id,
					generation: task.role.pane_generation,
					cwd: task.source.root,
				});
				return {
					resultDigest: sha256(observedIdentity),
					observedIdentity,
				};
			},
		});
	}
	active = loadActiveRun(lock.store, { workspaceId: context.workspaceId });
	for (const role of gateRoles) {
		const taskPath = taskPathForRole(active, role.name);
		const terminal = active.journal.find(
			(entry) =>
				["report.harvest", "report.reject"].includes(entry.operation_type) &&
				entry.phase === "observed" &&
				entry.subject.id === role.name,
		);
		if (!terminal) {
			try {
				await harvestCommittedReport(lock, {
					workspaceId: context.workspaceId,
					runId: active.state.run_id,
					runGeneration: active.state.generation,
					taskPath,
					configurationDigest: config.digest,
					fault: operationFault(fault, "report.harvest"),
				});
			} catch (error) {
				if (
					!(error instanceof StateKernelError) ||
					error.code !== "state_unknown"
				)
					throw error;
			}
			active = loadActiveRun(lock.store, {
				workspaceId: context.workspaceId,
			});
		}
	}
	const acceptedReports = deriveRetainedReportAuthority(active, stateRoot);
	const lifecycle = scanStage2Authority(active, config.raw, {
		acceptedReports,
	});
	return {
		run_id: active.state.run_id,
		workspace_id: context.workspaceId,
		lifecycle: lifecycle.state,
		integration,
		accepted_gate_reports: gateRoles.filter(
			(role) => acceptedReports[role.name],
		).length,
		expected_gate_reports: gateRoles.length,
		gate_workers: gateRoles.map((role) => {
			const task = loadAuthoritativeTaskByExactPath(
				taskPathForRole(active, role.name),
				stateRoot,
				{
					active,
					configurationDigest: config.digest,
					requireAttachedAgent: true,
				},
			).task;
			const agent = active.journal.find(
				(entry) =>
					entry.operation_id === task.role.agent_operation_id &&
					entry.phase === "observed",
			);
			return {
				role: role.name,
				cwd: task.source.root,
				task_path: taskPathForRole(active, role.name),
				outbox_slot: join(task.outbox.root, task.outbox.slot_name),
				publisher_command: `node ${JSON.stringify(fileURLToPath(new URL("./report-publisher.mjs", import.meta.url)))} publish --config ${JSON.stringify(config.path)} --task ${JSON.stringify(taskPathForRole(active, role.name))}`,
				pane_id: agent.observed_identity.pane_id,
				agent_name: task.role.agent_name,
			};
		}),
	};
}

export async function reconcile({
	contextJson = process.env.HERDR_PLUGIN_CONTEXT_JSON,
	configPath,
	herdrBin = process.env.HERDR_BIN_PATH ?? "herdr",
	exec = defaultExec,
	random = randomBytes,
	fault,
} = {}) {
	const context = parsePluginContext(contextJson);
	const config = parseConfig(
		configPath ?? join(context.workspaceCwd, ".herdr-conductor.json"),
	);
	const stateRoot = config.stateRoot;
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
	refuseDeadRepositoryLock(store);
	validateRunConfiguration(
		loadActiveRun(store, { workspaceId: context.workspaceId }),
		config,
	);
	const lock = acquireRepositoryLock(store, {
		operationId: `harvest-${sha256(context.workspaceId).slice(0, 24)}`,
		fault,
	});
	try {
		let active = loadActiveRun(store, { workspaceId: context.workspaceId });
		validateRunConfiguration(active, config);
		const existingHarvest = active.journal.find(
			(entry) =>
				entry.operation_type === "integration.harvest" &&
				entry.phase === "observed",
		);
		if (existingHarvest)
			return await provisionAndCollectGates({
				lock,
				context,
				config,
				stateRoot,
				herdrBin,
				exec,
				random,
				fault,
			});
		const producerRoles = config.roles
			.filter((role) => role.worktree)
			.sort((left, right) =>
				Buffer.compare(Buffer.from(left.name), Buffer.from(right.name)),
			);
		const targets = exactObservedEntries(active, "integration.bind");
		if (targets.length !== 1)
			fail(
				"bookkeeping_unknown",
				"run must have exactly one integration target binding",
			);
		liveIntegrationTarget(targets[0].observed_identity, active, exec);
		const taskAuthorities = [];
		for (const role of producerRoles) {
			const taskEntry = active.journal.find(
				(entry) =>
					entry.operation_type === "task.publish" &&
					entry.phase === "observed" &&
					entry.subject.id === role.name,
			);
			if (!taskEntry)
				fail(
					"bookkeeping_unknown",
					`producer ${role.name} is missing task authority`,
				);
			const taskPath = join(
				active.paths.tasksDir,
				role.name,
				`${taskEntry.subject.generation}.json`,
			);
			const authority = loadAuthoritativeTaskByExactPath(taskPath, stateRoot, {
				active,
				configurationDigest: config.digest,
				requireAttachedAgent: true,
			});
			taskAuthorities.push(authority);
			const terminal = active.journal.find(
				(entry) =>
					["report.harvest", "report.reject"].includes(entry.operation_type) &&
					entry.phase === "observed" &&
					entry.subject.id === role.name,
			);
			if (!terminal) {
				try {
					await harvestCommittedReport(lock, {
						workspaceId: context.workspaceId,
						runId: active.state.run_id,
						runGeneration: active.state.generation,
						taskPath,
						configurationDigest: config.digest,
						fault: operationFault(fault, "report.harvest"),
					});
				} catch (error) {
					if (
						!(error instanceof StateKernelError) ||
						error.code !== "state_unknown"
					)
						throw error;
				}
				active = loadActiveRun(store, { workspaceId: context.workspaceId });
			}
		}
		const rejection = active.journal.find(
			(entry) =>
				entry.operation_type === "report.reject" && entry.phase === "observed",
		);
		if (rejection)
			return {
				run_id: active.state.run_id,
				workspace_id: context.workspaceId,
				lifecycle: "delivery_report_rejected",
				rejection_digest: rejection.result_digest,
			};
		const accepted = active.journal.filter(
			(entry) =>
				entry.operation_type === "report.harvest" && entry.phase === "observed",
		);
		if (accepted.length < producerRoles.length)
			return {
				run_id: active.state.run_id,
				workspace_id: context.workspaceId,
				lifecycle: "delivery_waiting_reports",
				accepted_reports: accepted.length,
				expected_reports: producerRoles.length,
			};
		const collected = [];
		for (const authority of taskAuthorities) {
			const entry = accepted.find(
				(candidate) => candidate.subject.id === authority.task.role.name,
			);
			if (!entry)
				fail(
					"bookkeeping_unknown",
					"accepted producer report set is incomplete",
				);
			const reportPath = join(
				active.paths.reportsDir,
				authority.task.role.name,
				authority.task.task_generation,
				`${entry.subject.generation}.json`,
			);
			const report = parseReportBytes(
				readStablePrivateBytes(reportPath, {
					root: stateRoot,
					maxBytes: 1_048_576,
				}),
				{ task: authority.task },
			);
			if (
				report.status !== "completed" ||
				report.result?.kind !== "delivery" ||
				report.result?.verdict !== "delivered"
			)
				return {
					run_id: active.state.run_id,
					workspace_id: context.workspaceId,
					lifecycle: "delivery_nonprogressable",
				};
			collected.push({ authority, report });
		}
		const collectPreflight = () => {
			const target = liveIntegrationTarget(
				targets[0].observed_identity,
				active,
				exec,
			);
			const producers = collected.map(({ authority, report }) => {
				const sourceEntry = active.journal.find(
					(entry) =>
						entry.operation_type === "worktree.create" &&
						entry.phase === "observed" &&
						entry.subject.id === authority.task.role.name &&
						entry.subject.generation === authority.task.role.source_generation,
				);
				if (!sourceEntry)
					fail("bookkeeping_unknown", "producer source authority is missing");
				const source = liveSourceIdentity(
					sourceEntry.observed_identity,
					active,
					exec,
				);
				const inspection = inspectProducerSource(
					authority.task.source,
					report.source,
					authority.task.assignment,
				);
				if (
					source.path !== inspection.observation.canonical_path ||
					source.head_sha !== inspection.headSha
				)
					fail("stale_source", "producer source changed after collection");
				return {
					role_name: authority.task.role.name,
					task_digest: authority.task.task_digest,
					report_digest: report.report_digest,
					source_sha: inspection.headSha,
					tree_sha: inspection.treeSha,
					source_generation: authority.task.role.source_generation,
				};
			});
			return { target, selection: buildOrderedProducerSelection(producers) };
		};
		const initial = collectPreflight();
		const execFile =
			exec === defaultExec
				? undefined
				: (command, args, options) => exec(command, args, options);
		const plan = planCompleteIntegration({
			repository: store.repositoryRoot,
			targetSha: initial.target.head_sha,
			producers: initial.selection,
			execFile,
		});
		const identity = {
			document_type: "herdr-conductor-stage2-integration",
			schema_version: 1,
			target_ref: initial.target.branch_ref,
			starting_sha: initial.target.head_sha,
			final_sha: plan.finalSha,
			selection: plan.selection,
			cas_count: plan.casRequired ? 1 : 0,
		};
		const reconcileResult = await performJournaledOperation(lock, {
			workspaceId: context.workspaceId,
			runId: active.state.run_id,
			runGeneration: active.state.generation,
			operationId: `integration-reconcile-${active.state.generation}`,
			operationType: "integration.reconcile",
			subject: {
				kind: "git",
				id: "integration",
				generation: active.state.generation,
			},
			requestDigest: sha256({ configuration_digest: config.digest, identity }),
			fault: operationFault(fault, "integration.reconcile"),
			effect: async () => {
				const published = publishIntegrationCas({
					repository: store.repositoryRoot,
					targetRef: identity.target_ref,
					expectedTargetSha: identity.starting_sha,
					plan,
					preflight: collectPreflight,
					execFile,
					fault: operationFault(fault, "integration.reconcile"),
				});
				if (published.casCount === 1)
					synchronizeIntegrationTarget({
						expectedTarget: targets[0].observed_identity,
						finalSha: plan.finalSha,
						active,
						exec,
						fault: operationFault(fault, "integration.reconcile"),
					});
				validateIntegrationPublication({
					repository: store.repositoryRoot,
					targetRef: identity.target_ref,
					expectedSha: plan.finalSha,
					execFile,
				});
				validateRuntimeIntegrationPublication(
					exec,
					store.repositoryRoot,
					identity.target_ref,
					plan.finalSha,
				);
				return { resultDigest: sha256(identity), observedIdentity: identity };
			},
			validateBeforeResultPublication: async () => {
				validateIntegrationPublication({
					repository: store.repositoryRoot,
					targetRef: identity.target_ref,
					expectedSha: plan.finalSha,
					execFile,
				});
				validateRuntimeIntegrationPublication(
					exec,
					store.repositoryRoot,
					identity.target_ref,
					plan.finalSha,
				);
			},
		});
		active = loadActiveRun(store, { workspaceId: context.workspaceId });
		const reconciled = active.journal.find(
			(entry) =>
				entry.operation_type === "integration.reconcile" &&
				entry.phase === "observed",
		);
		if (!reconciled)
			fail(
				"bookkeeping_unknown",
				"integration reconciliation observation is missing",
			);
		await performJournaledOperation(lock, {
			workspaceId: context.workspaceId,
			runId: active.state.run_id,
			runGeneration: active.state.generation,
			operationId: `integration-harvest-${active.state.generation}`,
			operationType: "integration.harvest",
			subject: {
				kind: "git",
				id: "integration",
				generation: active.state.generation,
			},
			requestDigest: sha256(reconciled.observed_identity),
			fault: operationFault(fault, "integration.harvest"),
			effect: async () => ({
				resultDigest: reconciled.result_digest,
				observedIdentity: reconciled.observed_identity,
			}),
		});
		const gateResult = await provisionAndCollectGates({
			lock,
			context,
			config,
			stateRoot,
			herdrBin,
			exec,
			random,
			fault,
		});
		return { ...gateResult, replayed: reconcileResult.replayed };
	} finally {
		releaseRepositoryLock(lock);
	}
}

function gateSourceRefusals(active, config, exec = defaultExec) {
	const refused = [];
	const execFile =
		exec === defaultExec
			? undefined
			: (command, args, options = {}) => exec(command, args, options);
	for (const role of config.roles.filter(
		(entry) =>
			entry.contract_role === "reviewer" || entry.contract_role === "validator",
	)) {
		const entries = active.journal.filter(
			(entry) =>
				entry.operation_type === "gate-source.create" &&
				entry.phase === "observed" &&
				entry.subject.id === role.name,
		);
		if (entries.length > 1)
			fail("bookkeeping_unknown", "gate source authority is duplicated");
		if (entries.length === 0) continue;
		try {
			validateGateSource(
				gateTaskSource(entries[0]),
				execFile ? { exec: execFile } : undefined,
			);
		} catch (error) {
			if (
				error instanceof StateKernelError &&
				error.code === "source_policy_violation"
			)
				refused.push(role.name);
			else throw error;
		}
	}
	return refused;
}

function deriveRetainedReportAuthorityUnchecked(active, stateRoot) {
	if (
		!active?.paths?.tasksDir ||
		!active?.paths?.reportsDir ||
		!active?.journal
	)
		fail("bookkeeping_unknown", "retained report paths are unavailable");
	const tasks = Object.create(null);
	for (const entry of active.journal.filter(
		(candidate) =>
			candidate.operation_type === "task.publish" &&
			candidate.phase === "observed",
	)) {
		if (Object.hasOwn(tasks, entry.subject.id))
			fail("bookkeeping_unknown", "retained task authority is duplicated");
		validateId(entry.subject.id, "retained task role");
		validateGeneration(entry.subject.generation, "retained task generation");
		if (
			entry.subject.kind !== "task" ||
			entry.operation_id !==
				`task-publish-${entry.subject.id}-${entry.subject.generation}`
		)
			fail("bookkeeping_unknown", "retained task journal subject is invalid");
		const taskPath = join(
			active.paths.tasksDir,
			entry.subject.id,
			`${entry.subject.generation}.json`,
		);
		const taskBytes = readStablePrivateBytes(taskPath, {
			root: stateRoot,
			maxBytes: 262_144,
		});
		const task = parseTaskBytes(taskBytes);
		if (!taskBytes.equals(Buffer.from(canonicalJson(task))))
			fail("bookkeeping_unknown", "retained task bytes are not canonical");
		if (
			task.role.name !== entry.subject.id ||
			task.task_generation !== entry.subject.generation ||
			task.task_digest !== entry.result_digest ||
			task.scope.repository.key !== active.state.repository.key ||
			task.scope.workspace_id !== active.state.workspace_id ||
			task.scope.run_id !== active.state.run_id ||
			task.scope.run_generation !== active.state.generation
		)
			fail(
				"bookkeeping_unknown",
				"retained task bytes do not match journal and run authority",
			);
		tasks[entry.subject.id] = Object.freeze({ entry, task });
	}
	const reports = Object.create(null);
	for (const entry of active.journal.filter(
		(candidate) =>
			candidate.operation_type === "report.harvest" &&
			candidate.phase === "observed",
	)) {
		if (Object.hasOwn(reports, entry.subject.id))
			fail("bookkeeping_unknown", "accepted report authority is duplicated");
		validateId(entry.subject.id, "accepted report role");
		validateGeneration(entry.subject.generation, "accepted report generation");
		if (
			entry.subject.kind !== "report" ||
			entry.operation_id !==
				`report-harvest-${entry.subject.id}-${entry.subject.generation}`
		)
			fail("bookkeeping_unknown", "accepted report journal subject is invalid");
		const taskAuthority = tasks[entry.subject.id];
		if (!taskAuthority)
			fail("bookkeeping_unknown", "accepted report task authority is missing");
		const { entry: taskEntry, task } = taskAuthority;
		const reportPath = join(
			active.paths.reportsDir,
			entry.subject.id,
			taskEntry.subject.generation,
			`${entry.subject.generation}.json`,
		);
		const reportBytes = readStablePrivateBytes(reportPath, {
			root: stateRoot,
			maxBytes: 1_048_576,
		});
		const report = parseReportBytes(reportBytes, { task });
		if (!reportBytes.equals(Buffer.from(canonicalJson(report))))
			fail("bookkeeping_unknown", "retained report bytes are not canonical");
		if (
			report.role.name !== entry.subject.id ||
			report.task.id !== task.task_id ||
			report.task.generation !== taskEntry.subject.generation ||
			report.task.digest !== task.task_digest ||
			report.report_generation !== entry.subject.generation ||
			report.report_digest !== entry.result_digest
		)
			fail(
				"bookkeeping_unknown",
				"accepted report bytes do not match journal and path authority",
			);
		reports[entry.subject.id] = report;
	}
	return Object.freeze(reports);
}

export function deriveRetainedReportAuthority(active, stateRoot) {
	try {
		return deriveRetainedReportAuthorityUnchecked(active, stateRoot);
	} catch (error) {
		if (
			error instanceof StateKernelError &&
			error.code === "bookkeeping_unknown"
		)
			throw error;
		fail(
			"bookkeeping_unknown",
			"retained task or report authority is invalid",
			error,
		);
	}
}

function retainedPaneAuthority(active) {
	return exactObservedEntries(active, "pane.create")
		.map((paneEntry) => {
			const matchingAgents = active.journal.filter(
				(entry) =>
					entry.operation_type === "agent.start" &&
					entry.phase === "observed" &&
					entry.subject.id === paneEntry.subject.id &&
					entry.observed_identity?.pane_id ===
						paneEntry.observed_identity.pane_id,
			);
			if (matchingAgents.length > 1)
				fail("bookkeeping_unknown", "pane has duplicate attached agents");
			return {
				subject: paneEntry.subject,
				paneEntry,
				agentEntry: matchingAgents[0] ?? null,
				observedIdentity:
					matchingAgents[0]?.observed_identity ?? paneEntry.observed_identity,
			};
		})
		.sort((left, right) => {
			const leftKey = `${left.subject.id}\0${left.subject.generation}\0${left.paneEntry.operation_id}\0${left.observedIdentity.pane_id}\0${left.observedIdentity.terminal_id}\0${left.observedIdentity.cwd}`;
			const rightKey = `${right.subject.id}\0${right.subject.generation}\0${right.paneEntry.operation_id}\0${right.observedIdentity.pane_id}\0${right.observedIdentity.terminal_id}\0${right.observedIdentity.cwd}`;
			return Buffer.compare(Buffer.from(leftKey), Buffer.from(rightKey));
		});
}

function retainedCloseSet(panes) {
	return panes.map((entry) => ({
		role_name: entry.subject.id,
		pane_generation: entry.subject.generation,
		pane_entry_digest: entry.paneEntry.entry_digest,
		pane_id: entry.observedIdentity.pane_id,
		terminal_id: entry.observedIdentity.terminal_id,
		cwd: entry.observedIdentity.cwd,
		close_operation_id: `close-${entry.subject.id}-${entry.subject.generation}`,
	}));
}

export function archivedStandDownReplay(archived, workspaceId, suppliedReason) {
	const standDownEntries = archived.journal.filter(
		(entry) =>
			entry.operation_type === "run.stand-down.begin" &&
			entry.phase === "observed",
	);
	const archiveEntries = archived.journal.filter(
		(entry) =>
			entry.operation_type === "run.archive" && entry.phase === "observed",
	);
	if (standDownEntries.length !== 1 || archiveEntries.length !== 1)
		fail(
			"bookkeeping_unknown",
			"archived stand-down terminal authority is missing or duplicated",
		);
	const standDownEntry = standDownEntries[0];
	const archiveEntry = archiveEntries[0];
	const identity = standDownEntry.observed_identity;
	if (
		!identity ||
		typeof identity !== "object" ||
		Array.isArray(identity) ||
		canonicalJson(Object.keys(identity).sort()) !==
			canonicalJson([
				"archive_operation_id",
				"close_set",
				"document_type",
				"outcome",
				"reason",
				"schema_version",
				"source_journal_head",
				"source_state",
			]) ||
		identity.document_type !== "herdr-conductor-stage2-stand-down" ||
		identity.schema_version !== 1 ||
		!Array.isArray(identity.close_set) ||
		identity.close_set.length > 64
	)
		fail("bookkeeping_unknown", "archived stand-down identity is invalid");
	const expectedOperationId = `stand-down-begin-${archived.state.generation}`;
	if (
		identity.source_journal_head !== standDownEntry.previous_digest ||
		standDownEntry.operation_id !== expectedOperationId ||
		standDownEntry.subject.kind !== "run" ||
		standDownEntry.subject.id !== archived.state.run_id ||
		standDownEntry.subject.generation !== archived.state.generation ||
		standDownEntry.request_digest !== sha256(identity) ||
		standDownEntry.result_digest !== sha256(identity)
	)
		fail(
			"bookkeeping_unknown",
			"archived stand-down request identity does not match authority",
		);
	try {
		standDownReasonForState(identity.source_state, identity.reason);
	} catch (error) {
		fail("bookkeeping_unknown", "archived stand-down reason is invalid", error);
	}
	if (suppliedReason !== undefined) {
		try {
			standDownReasonForState(identity.source_state, suppliedReason);
		} catch (error) {
			fail("operation_conflict", "stand-down replay reason is invalid", error);
		}
		if (suppliedReason !== identity.reason)
			fail(
				"operation_conflict",
				"stand-down replay reason differs from observed authority",
			);
	}
	if (
		identity.outcome !==
			(identity.reason === "normal_completion" ? "completed" : "abandoned") ||
		identity.archive_operation_id !== archiveEntry.operation_id
	)
		fail("bookkeeping_unknown", "archived stand-down outcome is inconsistent");
	const panes = retainedPaneAuthority(archived);
	const expectedCloseSet = retainedCloseSet(panes);
	if (canonicalJson(identity.close_set) !== canonicalJson(expectedCloseSet))
		fail(
			"bookkeeping_unknown",
			"archived close set does not match retained pane authority",
		);
	const archiveDigest = sha256({
		run_id: archived.state.run_id,
		generation: archived.state.generation,
	});
	if (
		archiveEntry.subject.kind !== "run" ||
		archiveEntry.subject.id !== archived.state.run_id ||
		archiveEntry.subject.generation !== archived.state.generation ||
		archiveEntry.request_digest !== archiveDigest ||
		archiveEntry.result_digest !== archiveDigest
	)
		fail("bookkeeping_unknown", "archived terminal result is inconsistent");
	const closeEntries = archived.journal.filter(
		(entry) =>
			entry.operation_type === "pane.close" && entry.phase === "observed",
	);
	const expectedArchivePrevious =
		closeEntries.at(-1)?.entry_digest ?? standDownEntry.entry_digest;
	if (
		archiveEntry.previous_digest !== expectedArchivePrevious ||
		archived.state.journal_head !== archiveEntry.entry_digest
	)
		fail("bookkeeping_unknown", "archived journal terminal binding is invalid");
	const closed = [];
	const seenOperations = new Set();
	for (const expected of identity.close_set) {
		if (
			!expected ||
			typeof expected !== "object" ||
			Array.isArray(expected) ||
			canonicalJson(Object.keys(expected).sort()) !==
				canonicalJson([
					"close_operation_id",
					"cwd",
					"pane_entry_digest",
					"pane_generation",
					"pane_id",
					"role_name",
					"terminal_id",
				]) ||
			seenOperations.has(expected.close_operation_id)
		)
			fail(
				"bookkeeping_unknown",
				"archived close set is invalid or duplicated",
			);
		seenOperations.add(expected.close_operation_id);
		const matching = closeEntries.filter(
			(entry) =>
				entry.operation_id === expected.close_operation_id &&
				entry.subject.kind === "pane" &&
				entry.subject.id === expected.role_name &&
				entry.subject.generation === expected.pane_generation,
		);
		if (matching.length !== 1)
			fail(
				"bookkeeping_unknown",
				"archived close result is missing or duplicated",
			);
		const pane = panes.find(
			(candidate) =>
				candidate.subject.id === expected.role_name &&
				candidate.subject.generation === expected.pane_generation,
		);
		if (
			!pane ||
			matching[0].request_digest !== sha256(pane.observedIdentity) ||
			matching[0].result_digest !==
				sha256({ pane_id: expected.pane_id, closed: true })
		)
			fail("bookkeeping_unknown", "archived close digests are inconsistent");
		closed.push(expected.pane_id);
	}
	if (closeEntries.length !== closed.length)
		fail(
			"bookkeeping_unknown",
			"archived close results exceed the durable close set",
		);
	return Object.freeze({
		run_id: archived.state.run_id,
		workspace_id: workspaceId,
		closed: Object.freeze(closed),
		archived: true,
		replayed: true,
	});
}

export async function standDown({
	contextJson = process.env.HERDR_PLUGIN_CONTEXT_JSON,
	configPath,
	reason,
	herdrBin = process.env.HERDR_BIN_PATH ?? "herdr",
	exec = defaultExec,
	fault,
} = {}) {
	const context = parsePluginContext(contextJson);
	const config = parseConfig(
		configPath ?? join(context.workspaceCwd, ".herdr-conductor.json"),
	);
	const stateRoot = config.stateRoot;
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
	const archiveRestart = inspectArchiveUncertainty(store, {
		workspaceId: context.workspaceId,
	});
	if (archiveRestart)
		throw new StateKernelError(
			archiveRestart.error_code,
			`${archiveRestart.classification}: retained archive authority requires recovery`,
		);
	let initialActive = null;
	try {
		initialActive = loadActiveRun(store, { workspaceId: context.workspaceId });
	} catch (error) {
		if (!(error instanceof StateKernelError) || error.code !== "state_unknown")
			throw error;
		const archived = loadArchivedRun(store, {
			workspaceId: context.workspaceId,
		});
		validateRunConfiguration(archived, config);
		deriveRetainedReportAuthority(archived, stateRoot);
		return archivedStandDownReplay(archived, context.workspaceId, reason);
	}
	refuseDeadRepositoryLock(store);
	validateRunConfiguration(
		initialActive ?? loadActiveRun(store, { workspaceId: context.workspaceId }),
		config,
	);
	const lock = acquireRepositoryLock(store, {
		operationId: `stand-down-${sha256(context.workspaceId).slice(0, 24)}`,
		fault,
	});
	try {
		let active = loadActiveRun(store, { workspaceId: context.workspaceId });
		validateRunConfiguration(active, config);
		const panes = retainedPaneAuthority(active);
		const closeSet = retainedCloseSet(panes);
		const standDownOperationId = `stand-down-begin-${active.state.generation}`;
		const priorStandDown = existingObserved(
			active,
			standDownOperationId,
			"run.stand-down.begin",
		);
		const lifecycle = scanStage2Authority(active, config.raw, {
			acceptedReports: deriveRetainedReportAuthority(active, stateRoot),
			sourceRefused: gateSourceRefusals(active, config, exec),
		});
		let standDownIdentity = priorStandDown?.observed_identity ?? null;
		if (priorStandDown) {
			if (reason !== undefined && reason !== standDownIdentity.reason)
				fail(
					"operation_conflict",
					"stand-down restart reason differs from observed authority",
				);
		} else {
			const selectedReason = reason ?? "operator_abandoned";
			standDownReasonForState(lifecycle.state, selectedReason);
			standDownIdentity = {
				document_type: "herdr-conductor-stage2-stand-down",
				schema_version: 1,
				source_state: lifecycle.state,
				source_journal_head: active.state.journal_head,
				reason: selectedReason,
				outcome:
					selectedReason === "normal_completion" ? "completed" : "abandoned",
				close_set: closeSet,
				archive_operation_id: `archive-${active.state.generation}`,
			};
			await performJournaledOperation(lock, {
				workspaceId: context.workspaceId,
				runId: active.state.run_id,
				runGeneration: active.state.generation,
				operationId: standDownOperationId,
				operationType: "run.stand-down.begin",
				subject: {
					kind: "run",
					id: active.state.run_id,
					generation: active.state.generation,
				},
				requestDigest: sha256(standDownIdentity),
				fault: operationFault(fault, "run.stand-down.begin"),
				effect: async () => ({
					resultDigest: sha256(standDownIdentity),
					observedIdentity: standDownIdentity,
				}),
			});
			active = loadActiveRun(store, { workspaceId: context.workspaceId });
		}
		if (canonicalJson(standDownIdentity.close_set) !== canonicalJson(closeSet))
			fail(
				"bookkeeping_unknown",
				"stand-down close set no longer matches pane authority",
			);
		let observedCloseCount = 0;
		let sawGap = false;
		for (const paneEntry of panes) {
			const operationId = `close-${paneEntry.subject.id}-${paneEntry.subject.generation}`;
			const observed = existingObserved(active, operationId, "pane.close");
			if (!observed) sawGap = true;
			else {
				if (sawGap)
					fail(
						"bookkeeping_unknown",
						"observed pane closes are not the stand-down prefix",
					);
				observedCloseCount++;
			}
		}
		const pendingPanes = panes.slice(observedCloseCount);
		const prefixLifecycle = scanStage2Authority(active, config.raw, {
			acceptedReports: deriveRetainedReportAuthority(active, stateRoot),
		});
		if (
			prefixLifecycle.detail?.closed !== observedCloseCount ||
			prefixLifecycle.detail?.total !== panes.length
		)
			fail(
				"bookkeeping_unknown",
				"stand-down lifecycle prefix is inconsistent",
			);
		const validatePaneForClose = (entry) =>
			entry.agentEntry
				? liveCloseIdentity(active, entry.observedIdentity, exec, herdrBin)
				: livePaneCreationIdentity(
						active,
						entry.observedIdentity,
						exec,
						herdrBin,
					);
		for (const paneEntry of pendingPanes) validatePaneForClose(paneEntry);
		const closed = panes
			.filter((paneEntry) => !pendingPanes.includes(paneEntry))
			.map((paneEntry) => paneEntry.observedIdentity.pane_id);
		for (const paneEntry of pendingPanes) {
			const recorded = paneEntry.observedIdentity;
			const operationId = `close-${paneEntry.subject.id}-${paneEntry.subject.generation}`;
			validatePaneForClose(paneEntry);
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
					validatePaneForClose(paneEntry);
					herdrJson(exec, herdrBin, ["pane", "close", recorded.pane_id]);
					return {
						resultDigest: sha256({ pane_id: recorded.pane_id, closed: true }),
					};
				},
			});
			closed.push(recorded.pane_id);
			active = loadActiveRun(store, { workspaceId: context.workspaceId });
			const afterClose = scanStage2Authority(active, config.raw, {
				acceptedReports: deriveRetainedReportAuthority(active, stateRoot),
			});
			if (afterClose.detail?.closed !== closed.length)
				fail(
					"bookkeeping_unknown",
					"pane close did not advance the exact stand-down prefix",
				);
		}
		const readyArchive = scanStage2Authority(active, config.raw, {
			acceptedReports: deriveRetainedReportAuthority(active, stateRoot),
		});
		if (readyArchive.state !== "stand_down_ready_archive")
			fail("bookkeeping_unknown", "stand-down is not ready to archive");
		const archiveOperationId = `archive-${active.state.generation}`;
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

function stage3IntegrationAuthority(active) {
	const entries = exactObservedEntries(active, "integration.harvest");
	if (entries.length !== 1)
		fail("bookkeeping_unknown", "stage3 requires one observed integration harvest");
	return {
		integration: entries[0].observed_identity,
		integrationEntryDigest: entries[0].entry_digest,
	};
}

function stage3GateBinding(active, config, stateRoot) {
	const acceptedReports = deriveRetainedReportAuthority(active, stateRoot);
	const gateRoles = config.roles
		.filter(
			(role) =>
				role.contract_role === "reviewer" || role.contract_role === "validator",
		)
		.sort((left, right) =>
			Buffer.compare(Buffer.from(left.name), Buffer.from(right.name)),
		);
	return gateRoles.map((role) => {
		const report = acceptedReports[role.name];
		if (!report)
			fail(
				"operation_conflict",
				`gate ${role.name} has no accepted report for preview`,
			);
		if (report.status !== "completed" || report.result === null)
			fail(
				"operation_conflict",
				`gate ${role.name} report is not completed and cannot be previewed`,
			);
		return {
			role_name: role.name,
			contract_role: role.contract_role,
			task_digest: report.task.digest,
			report_digest: report.report_digest,
			status: report.status,
			result_kind: report.result.kind,
			verdict: report.result.verdict,
		};
	});
}

function stage3AttemptAuthority(active) {
	const observed = (type) =>
		active.journal.filter(
			(entry) => entry.operation_type === type && entry.phase === "observed",
		);
	const previews = observed("apply.preview");
	if (previews.length === 0) return null;
	const newest = previews.at(-1);
	const generation = newest.subject.generation;
	const one = (entries, label) => {
		const matching = entries.filter(
			(entry) => entry.subject.generation === generation,
		);
		if (matching.length > 1)
			fail("bookkeeping_unknown", `stage3 ${label} authority is duplicated`);
		return matching[0] ?? null;
	};
	return {
		generation,
		attemptCount: previews.length,
		previewEntry: newest,
		approvalEntry: one(observed("approval.record"), "approval"),
		consumptionEntry: one(observed("approval.consume"), "consumption"),
		publicationEntry: one(observed("apply.publish"), "publication"),
	};
}

function buildStage3PreviewIdentity({
	active,
	store,
	config,
	targetRef,
	attemptGeneration,
	stateRoot,
	exec,
}) {
	const { integration, integrationEntryDigest } = stage3IntegrationAuthority(active);
	const gates = stage3GateBinding(active, config, stateRoot);
	const applyObservation = observeStage3ApplyTarget({
		repository: store.repositoryRoot,
		targetRef,
		integration: {
			target_ref: integration.target_ref,
			starting_sha: integration.starting_sha,
			final_sha: integration.final_sha,
		},
		exec,
	});
	const identity = {
		document_type: "herdr-conductor-stage3-preview",
		schema_version: 1,
		repository_key: store.repository.key,
		workspace_id: active.state.workspace_id,
		run_id: active.state.run_id,
		run_generation: active.state.generation,
		attempt_generation: attemptGeneration,
		integration: {
			target_ref: integration.target_ref,
			starting_sha: integration.starting_sha,
			final_sha: integration.final_sha,
			integration_entry_digest: integrationEntryDigest,
		},
		gates,
		apply: {
			target_ref: applyObservation.target_ref,
			observed_sha: applyObservation.observed_sha,
			final_sha: applyObservation.final_sha,
			diff_name_status_sha256: applyObservation.diff_name_status_sha256,
			changed_path_count: applyObservation.changed_path_count,
		},
	};
	return validateStage3PreviewIdentity(identity, "stage3 preview");
}

function stage3LiveApplyObservation(store, previewIdentity, exec) {
	const observed = observeStage3ApplyTarget({
		repository: store.repositoryRoot,
		targetRef: previewIdentity.apply.target_ref,
		integration: {
			target_ref: previewIdentity.integration.target_ref,
			starting_sha: previewIdentity.integration.starting_sha,
			final_sha: previewIdentity.integration.final_sha,
		},
		exec,
	});
	if (canonicalJson({ ...observed }) !== canonicalJson(previewIdentity.apply))
		fail(
			"stale_source",
			"apply target observation no longer matches the previewed authority",
		);
	return observed;
}

function stage3ApprovalCommand(config) {
	return `node ${JSON.stringify(fileURLToPath(new URL("./approval-recorder.mjs", import.meta.url)))} record --config ${JSON.stringify(config.path)}`;
}

function requireStage3Target(config) {
	const targetRef = stage3ApplyTargetRef(config.raw);
	if (!targetRef)
		fail(
			"capability_unavailable",
			"configuration does not declare a Stage 3 apply target",
		);
	return targetRef;
}

export async function preview({
	contextJson = process.env.HERDR_PLUGIN_CONTEXT_JSON,
	configPath,
	herdrBin = process.env.HERDR_BIN_PATH ?? "herdr",
	exec = defaultExec,
	random = randomBytes,
	fault,
} = {}) {
	const context = parsePluginContext(contextJson);
	const config = parseConfig(
		configPath ?? join(context.workspaceCwd, ".herdr-conductor.json"),
	);
	const stateRoot = config.stateRoot;
	requireHerdrRuntime(exec, herdrBin);
	const store = openExistingStore({ stateRoot, repoPath: context.workspaceCwd });
	if (store.repositoryRoot !== context.workspaceCwd)
		fail(
			"foreign_repository",
			"workspace_cwd must be the canonical repository root",
		);
	const targetRef = requireStage3Target(config);
	refuseDeadRepositoryLock(store);
	validateRunConfiguration(
		loadActiveRun(store, { workspaceId: context.workspaceId }),
		config,
	);
	const lock = acquireRepositoryLock(store, {
		operationId: `preview-${sha256(context.workspaceId).slice(0, 24)}`,
		fault,
	});
	try {
		let active = loadActiveRun(store, { workspaceId: context.workspaceId });
		validateRunConfiguration(active, config);
		const lifecycle = scanStage2Authority(active, config.raw, {
			acceptedReports: deriveRetainedReportAuthority(active, stateRoot),
			sourceRefused: gateSourceRefusals(active, config, exec),
		});
		const attempt = stage3AttemptAuthority(active);
		if (
			["apply_previewed", "apply_approved", "apply_consumed"].includes(
				lifecycle.state,
			)
		)
			return {
				run_id: active.state.run_id,
				workspace_id: context.workspaceId,
				lifecycle: lifecycle.state,
				preview: attempt.previewEntry.observed_identity,
				preview_entry_digest: attempt.previewEntry.entry_digest,
				approval_command: stage3ApprovalCommand(config),
				replayed: true,
			};
		if (lifecycle.state === "applied")
			return {
				run_id: active.state.run_id,
				workspace_id: context.workspaceId,
				lifecycle: "applied",
				apply: attempt.publicationEntry.observed_identity,
				replayed: true,
			};
		if (
			!["gate_reports_collected", "integration_harvested_no_gates"].includes(
				lifecycle.state,
			) &&
			!["apply_rejected", "apply_voided"].includes(lifecycle.state)
		)
			fail(
				"operation_conflict",
				`preview is not legal in lifecycle ${lifecycle.state}`,
			);
		if ((attempt?.attemptCount ?? 0) >= 8)
			fail("operation_conflict", "stage3 attempt limit is exhausted");
		const attemptGeneration = randomToken(16, random);
		const identity = buildStage3PreviewIdentity({
			active,
			store,
			config,
			targetRef,
			attemptGeneration,
			stateRoot,
			exec,
		});
		await performJournaledOperation(lock, {
			workspaceId: context.workspaceId,
			runId: active.state.run_id,
			runGeneration: active.state.generation,
			operationId: `apply-preview-${attemptGeneration}`,
			operationType: "apply.preview",
			subject: { kind: "apply", id: "apply", generation: attemptGeneration },
			requestDigest: sha256({
				configuration_digest: config.digest,
				identity,
			}),
			fault: operationFault(fault, "apply.preview"),
			effect: async () => {
				const reobserved = buildStage3PreviewIdentity({
					active,
					store,
					config,
					targetRef,
					attemptGeneration,
					stateRoot,
					exec,
				});
				if (canonicalJson(reobserved) !== canonicalJson(identity))
					fail("foreign_or_stale", "apply preview changed during binding");
				return { resultDigest: sha256(identity), observedIdentity: identity };
			},
		});
		active = loadActiveRun(store, { workspaceId: context.workspaceId });
		const recorded = stage3AttemptAuthority(active);
		if (recorded?.generation !== attemptGeneration)
			fail("bookkeeping_unknown", "recorded preview authority is missing");
		return {
			run_id: active.state.run_id,
			workspace_id: context.workspaceId,
			lifecycle: "apply_previewed",
			preview: recorded.previewEntry.observed_identity,
			preview_entry_digest: recorded.previewEntry.entry_digest,
			approval_command: stage3ApprovalCommand(config),
			replayed: false,
		};
	} finally {
		releaseRepositoryLock(lock);
	}
}

function stage3PublishRequest(previewIdentity, consumptionEntryDigest) {
	return {
		consumption_entry_digest: consumptionEntryDigest,
		target_ref: previewIdentity.apply.target_ref,
		expected_sha: previewIdentity.apply.observed_sha,
		final_sha: previewIdentity.apply.final_sha,
		attempt_generation: previewIdentity.attempt_generation,
	};
}

async function resolveStage3Uncertainty({ lock, store, context, exec, fault }) {
	return resolveUncertainApplyPublication(lock, {
		workspaceId: context.workspaceId,
		fault,
		resolve: (entry, uncertainActive) => {
			const previewEntry = uncertainActive.journal.find(
				(candidate) =>
					candidate.operation_type === "apply.preview" &&
					candidate.phase === "observed" &&
					candidate.subject.generation === entry.subject.generation,
			);
			const consumptionEntry = uncertainActive.journal.find(
				(candidate) =>
					candidate.operation_type === "approval.consume" &&
					candidate.phase === "observed" &&
					candidate.subject.generation === entry.subject.generation,
			);
			if (!previewEntry || !consumptionEntry)
				fail(
					"bookkeeping_unknown",
					"uncertain apply publication is missing its attempt authority",
				);
			const previewIdentity = previewEntry.observed_identity;
			if (
				entry.request_digest !==
				sha256(stage3PublishRequest(previewIdentity, consumptionEntry.entry_digest))
			)
				fail(
					"bookkeeping_unknown",
					"uncertain apply publication does not bind its attempt",
				);
			const outcome = resolveStage3ApplyOutcome({
				repository: store.repositoryRoot,
				targetRef: previewIdentity.apply.target_ref,
				expectedSha: previewIdentity.apply.observed_sha,
				finalSha: previewIdentity.apply.final_sha,
				exec,
			});
			const identity = validateStage3ApplyIdentity(
				{
					document_type: "herdr-conductor-stage3-apply",
					schema_version: 1,
					repository_key: store.repository.key,
					workspace_id: uncertainActive.state.workspace_id,
					run_id: uncertainActive.state.run_id,
					run_generation: uncertainActive.state.generation,
					attempt_generation: entry.subject.generation,
					consumption_entry_digest: consumptionEntry.entry_digest,
					target_ref: previewIdentity.apply.target_ref,
					expected_sha: previewIdentity.apply.observed_sha,
					final_sha: previewIdentity.apply.final_sha,
					cas_count: outcome.cas_count,
					outcome: outcome.outcome,
				},
				"stage3 apply resolution",
			);
			return { resultDigest: sha256(identity), observedIdentity: identity };
		},
	});
}

export async function applyStage3({
	contextJson = process.env.HERDR_PLUGIN_CONTEXT_JSON,
	configPath,
	herdrBin = process.env.HERDR_BIN_PATH ?? "herdr",
	exec = defaultExec,
	fault,
} = {}) {
	const context = parsePluginContext(contextJson);
	const config = parseConfig(
		configPath ?? join(context.workspaceCwd, ".herdr-conductor.json"),
	);
	const stateRoot = config.stateRoot;
	requireHerdrRuntime(exec, herdrBin);
	const store = openExistingStore({ stateRoot, repoPath: context.workspaceCwd });
	if (store.repositoryRoot !== context.workspaceCwd)
		fail(
			"foreign_repository",
			"workspace_cwd must be the canonical repository root",
		);
	requireStage3Target(config);
	refuseDeadRepositoryLock(store);
	const lock = acquireRepositoryLock(store, {
		operationId: `apply-${sha256(context.workspaceId).slice(0, 24)}`,
		fault,
	});
	try {
		let resolution = null;
		try {
			loadActiveRun(store, { workspaceId: context.workspaceId });
		} catch (error) {
			if (
				!(error instanceof StateKernelError) ||
				error.code !== "recovery_required"
			)
				throw error;
			resolution = await resolveStage3Uncertainty({
				lock,
				store,
				context,
				exec,
				fault,
			});
		}
		let active = loadActiveRun(store, { workspaceId: context.workspaceId });
		validateRunConfiguration(active, config);
		const lifecycle = scanStage2Authority(active, config.raw, {
			acceptedReports: deriveRetainedReportAuthority(active, stateRoot),
			sourceRefused: gateSourceRefusals(active, config, exec),
		});
		const attempt = stage3AttemptAuthority(active);
		if (lifecycle.state === "applied")
			return {
				run_id: active.state.run_id,
				workspace_id: context.workspaceId,
				lifecycle: "applied",
				apply: attempt.publicationEntry.observed_identity,
				replayed: resolution === null,
				resolved: resolution !== null,
			};
		if (lifecycle.state === "apply_voided")
			return {
				run_id: active.state.run_id,
				workspace_id: context.workspaceId,
				lifecycle: "apply_voided",
				apply: attempt.publicationEntry.observed_identity,
				resolved: resolution !== null,
			};
		if (!["apply_approved", "apply_consumed"].includes(lifecycle.state))
			fail(
				"operation_conflict",
				`apply is not legal in lifecycle ${lifecycle.state}`,
			);
		const previewIdentity = attempt.previewEntry.observed_identity;
		if (attempt.approvalEntry.observed_identity.decision !== "approve")
			fail("operation_conflict", "apply requires an approve receipt");
		if (
			attempt.approvalEntry.observed_identity.preview_entry_digest !==
			attempt.previewEntry.entry_digest
		)
			fail(
				"bookkeeping_unknown",
				"approval receipt does not bind the previewed authority",
			);
		stage3LiveApplyObservation(store, previewIdentity, exec);
		const consumptionIdentity = validateStage3ConsumptionIdentity(
			{
				document_type: "herdr-conductor-stage3-consumption",
				schema_version: 1,
				repository_key: store.repository.key,
				workspace_id: active.state.workspace_id,
				run_id: active.state.run_id,
				run_generation: active.state.generation,
				attempt_generation: attempt.generation,
				approval_entry_digest: attempt.approvalEntry.entry_digest,
				preview_entry_digest: attempt.previewEntry.entry_digest,
			},
			"stage3 consumption",
		);
		await performJournaledOperation(lock, {
			workspaceId: context.workspaceId,
			runId: active.state.run_id,
			runGeneration: active.state.generation,
			operationId: `apply-consume-${attempt.generation}`,
			operationType: "approval.consume",
			subject: {
				kind: "approval",
				id: "apply",
				generation: attempt.generation,
			},
			requestDigest: sha256(consumptionIdentity),
			fault: operationFault(fault, "approval.consume"),
			effect: async () => {
				stage3LiveApplyObservation(store, previewIdentity, exec);
				return {
					resultDigest: sha256(consumptionIdentity),
					observedIdentity: consumptionIdentity,
				};
			},
		});
		active = loadActiveRun(store, { workspaceId: context.workspaceId });
		const consumed = stage3AttemptAuthority(active);
		if (
			consumed?.generation !== attempt.generation ||
			!consumed.consumptionEntry
		)
			fail("bookkeeping_unknown", "consumption authority is missing");
		stage3LiveApplyObservation(store, previewIdentity, exec);
		const publishRequest = stage3PublishRequest(
			previewIdentity,
			consumed.consumptionEntry.entry_digest,
		);
		const applyIdentity = validateStage3ApplyIdentity(
			{
				document_type: "herdr-conductor-stage3-apply",
				schema_version: 1,
				repository_key: store.repository.key,
				workspace_id: active.state.workspace_id,
				run_id: active.state.run_id,
				run_generation: active.state.generation,
				attempt_generation: attempt.generation,
				consumption_entry_digest: consumed.consumptionEntry.entry_digest,
				target_ref: previewIdentity.apply.target_ref,
				expected_sha: previewIdentity.apply.observed_sha,
				final_sha: previewIdentity.apply.final_sha,
				cas_count: 1,
				outcome: "applied",
			},
			"stage3 apply",
		);
		await performJournaledOperation(lock, {
			workspaceId: context.workspaceId,
			runId: active.state.run_id,
			runGeneration: active.state.generation,
			operationId: `apply-publish-${attempt.generation}`,
			operationType: "apply.publish",
			subject: { kind: "apply", id: "apply", generation: attempt.generation },
			requestDigest: sha256(publishRequest),
			fault: operationFault(fault, "apply.publish"),
			effect: async () => {
				publishStage3ApplyCas({
					repository: store.repositoryRoot,
					targetRef: previewIdentity.apply.target_ref,
					expectedSha: previewIdentity.apply.observed_sha,
					finalSha: previewIdentity.apply.final_sha,
					preflight: () =>
						stage3LiveApplyObservation(store, previewIdentity, exec),
					exec,
					fault: operationFault(fault, "apply.publish"),
				});
				return {
					resultDigest: sha256(applyIdentity),
					observedIdentity: applyIdentity,
				};
			},
			validateBeforeResultPublication: async () => {
				if (
					gitLine(exec, store.repositoryRoot, [
						"rev-parse",
						previewIdentity.apply.target_ref,
					]) !== previewIdentity.apply.final_sha
				)
					fail(
						"durability_unknown",
						"published apply ref changed before result publication",
					);
			},
		});
		active = loadActiveRun(store, { workspaceId: context.workspaceId });
		const published = stage3AttemptAuthority(active);
		if (
			published?.publicationEntry?.observed_identity?.outcome !== "applied"
		)
			fail("bookkeeping_unknown", "published apply authority is missing");
		return {
			run_id: active.state.run_id,
			workspace_id: context.workspaceId,
			lifecycle: "applied",
			apply: published.publicationEntry.observed_identity,
			replayed: false,
			resolved: resolution !== null,
		};
	} finally {
		releaseRepositoryLock(lock);
	}
}

export function readStatus({
	contextJson = process.env.HERDR_PLUGIN_CONTEXT_JSON,
	configPath,
	herdrBin = process.env.HERDR_BIN_PATH ?? "herdr",
	exec = defaultExec,
} = {}) {
	const context = parsePluginContext(contextJson);
	const config = parseConfig(
		configPath ?? join(context.workspaceCwd, ".herdr-conductor.json"),
	);
	const stateRoot = config.stateRoot;
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
	let active;
	try {
		active = loadActiveRun(store, { workspaceId: context.workspaceId });
	} catch (error) {
		if (!(error instanceof StateKernelError) || error.code !== "state_unknown")
			throw error;
		const uncertainty = inspectArchiveUncertainty(store, {
			workspaceId: context.workspaceId,
		});
		if (uncertainty)
			throw new StateKernelError(
				uncertainty.error_code,
				`${uncertainty.classification}: retained archive authority requires recovery`,
			);
		const archived = loadArchivedRun(store, {
			workspaceId: context.workspaceId,
		});
		validateRunConfiguration(archived, config);
		deriveRetainedReportAuthority(archived, stateRoot);
		return {
			run: archived.state.run_id,
			generation: archived.state.generation,
			repository_key: store.repository.key,
			workspace_id: context.workspaceId,
			fork_sha: archived.state.fork_sha,
			lifecycle: "archived",
			legal_next_operations: ["status"],
			workers: [],
			archived: true,
		};
	}
	validateRunConfiguration(active, config);
	const acceptedReports = deriveRetainedReportAuthority(active, stateRoot);
	const lifecycle = scanStage2Authority(active, config.raw, {
		acceptedReports,
		sourceRefused: gateSourceRefusals(active, config, exec),
	});
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
		lifecycle: lifecycle.state,
		legal_next_operations: lifecycle.legalNextOperations,
		workers,
	};
}

function printTable(status) {
	const lines = [
		`run ${status.run}  workspace ${status.workspace_id}  fork ${status.fork_sha}`,
		"ROLE              KIND      PANE            STATUS             CWD",
		...status.workers.map(
			(worker) =>
				`${worker.role.padEnd(17)} ${worker.kind.padEnd(9)} ${worker.pane.padEnd(15)} ${worker.status.padEnd(18)} ${worker.cwd}`,
		),
	];
	process.stdout.write(`${lines.join("\n")}\n`);
}

async function main() {
	const command = process.argv[2];
	if (command === "assemble")
		process.stdout.write(canonicalJson(await assemble()));
	else if (command === "status") printTable(readStatus());
	else if (command === "board")
		process.stdout.write(canonicalJson(readStatus()));
	else if (command === "harvest")
		process.stdout.write(canonicalJson(await reconcile()));
	else if (command === "preview")
		process.stdout.write(canonicalJson(await preview()));
	else if (command === "apply")
		process.stdout.write(canonicalJson(await applyStage3()));
	else if (command === "stand-down")
		process.stdout.write(canonicalJson(await standDown()));
	else {
		process.stderr.write(
			"usage: stage1-runtime.mjs assemble|board|status|harvest|preview|apply|stand-down\n",
		);
		process.exitCode = 64;
	}
}

if (
	process.argv[1] &&
	resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
	main().catch((error) => {
		process.stderr.write(
			`herdr-conductor: ${error.code ?? "internal_error"}: ${error.message}\n`,
		);
		process.exitCode = 1;
	});
}

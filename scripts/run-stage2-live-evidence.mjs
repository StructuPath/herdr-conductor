#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import {
	chmodSync,
	closeSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	readlinkSync,
	realpathSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	canonicalJson,
	parseStrictJsonBytes,
} from "./private-state-schema.mjs";
import {
	assertSanitizedEvidence,
	buildStage2SourceManifest,
	externalReviewDigest,
	outputParentBinding,
	publishPrivateEvidenceTrio,
	renderStage2EvidenceReport,
	STAGE2_EVIDENCE_PATHS,
	validateExternalReviewRecord,
} from "./stage2-evidence-contract.mjs";
import {
	createHarnessControlPlane,
	validatePrivateOutputParent as openPrivateOutputParent,
} from "./harness-teardown.mjs";
import {
	computeChangedPaths,
	inspectProducerSource,
	validateProducerPathPolicy,
} from "./source-policy.mjs";
import { validateGateSource } from "./gate-source.mjs";
import { reportDigest, parseTaskBytes } from "./task-report-schema.mjs";

const OPT_IN = "I_UNDERSTAND_THIS_USES_LOCAL_HERDR";
const PLUGIN_ID = "structupath.conductor";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const STAGE2_LIVE_EXECUTION_PLAN = Object.freeze([
	Object.freeze({
		id: "assemble",
		kind: "installed_action",
		action: "assemble",
	}),
	Object.freeze({ id: "board", kind: "installed_action", action: "board" }),
	Object.freeze({ id: "status", kind: "installed_action", action: "status" }),
	Object.freeze({ id: "foreign_workspace_refusals", kind: "refusal_probe" }),
	Object.freeze({ id: "producer_path_refusal", kind: "refusal_probe" }),
	Object.freeze({ id: "producer_source_refusal", kind: "refusal_probe" }),
	Object.freeze({ id: "producer_digest_refusal", kind: "refusal_probe" }),
	Object.freeze({ id: "producer_publish", kind: "effect_evidence" }),
	Object.freeze({ id: "producer_replay_refusal", kind: "refusal_probe" }),
	Object.freeze({
		id: "producer_harvest",
		kind: "installed_action",
		action: "harvest",
	}),
	Object.freeze({ id: "gate_source_refusal", kind: "refusal_probe" }),
	Object.freeze({ id: "gate_digest_refusal", kind: "refusal_probe" }),
	Object.freeze({ id: "gate_publish", kind: "effect_evidence" }),
	Object.freeze({
		id: "gate_harvest",
		kind: "installed_action",
		action: "harvest",
	}),
	Object.freeze({
		id: "stand_down",
		kind: "installed_action",
		action: "stand-down",
	}),
	Object.freeze({ id: "retained_effect_evidence", kind: "effect_evidence" }),
]);
export const STAGE2_LIVE_ACTION_SEQUENCE = Object.freeze(
	STAGE2_LIVE_EXECUTION_PLAN.filter(
		({ kind }) => kind === "installed_action",
	).map(({ action }) => action),
);

export function createStage2LivePlanDriver(installedAction) {
	if (typeof installedAction !== "function")
		throw new TypeError("installed action boundary is required");
	let index = 0;
	const observed = [];
	return Object.freeze({
		run(stepId, operation) {
			const step = STAGE2_LIVE_EXECUTION_PLAN[index];
			if (!step || step.id !== stepId)
				throw new Error(
					`live execution plan expected ${step?.id ?? "completion"}, received ${stepId}`,
				);
			index++;
			const result =
				step.kind === "installed_action"
					? installedAction(step.action)
					: operation?.();
			observed.push(step);
			return result;
		},
		finish() {
			if (index !== STAGE2_LIVE_EXECUTION_PLAN.length)
				throw new Error(
					`live execution plan stopped before ${STAGE2_LIVE_EXECUTION_PLAN[index].id}`,
				);
			return Object.freeze({
				steps: Object.freeze(observed.map(({ id }) => id)),
				actionSequence: STAGE2_LIVE_ACTION_SEQUENCE,
			});
		},
	});
}

function sha256(value) {
	return createHash("sha256").update(value).digest("hex");
}
function command(name, args, options = {}) {
	return execFileSync(name, args, {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		timeout: 180_000,
		...options,
	}).trim();
}
function git(repository, ...args) {
	return command("git", ["-C", repository, ...args]);
}
function parseArguments(argv) {
	const values = {};
	for (let index = 0; index < argv.length; index += 2) {
		const name = argv[index];
		const value = argv[index + 1];
		if (
			!new Set(["--candidate", "--review-record", "--output-parent"]).has(
				name,
			) ||
			!value
		)
			throw new Error(
				"usage: run-stage2-live-evidence --candidate <sha> --review-record <json> --output-parent <empty-0700-directory>",
			);
		if (Object.hasOwn(values, name))
			throw new Error(`duplicate argument: ${name}`);
		values[name] = value;
	}
	for (const name of ["--candidate", "--review-record", "--output-parent"])
		if (!values[name]) throw new Error(`missing argument: ${name}`);
	if (!/^[a-f0-9]{40}$/.test(values["--candidate"]))
		throw new Error("candidate must be one full lowercase SHA-1 commit");
	return {
		candidate: values["--candidate"],
		reviewRecordPath: resolve(values["--review-record"]),
		outputParentPath: resolve(values["--output-parent"]),
	};
}
function findObject(value, predicate) {
	if (value && typeof value === "object") {
		if (!Array.isArray(value) && predicate(value)) return value;
		for (const child of Object.values(value)) {
			const found = findObject(child, predicate);
			if (found) return found;
		}
	}
	return null;
}
function walk(value, visit) {
	visit(value);
	if (value && typeof value === "object")
		for (const child of Object.values(value)) walk(child, visit);
}
function runHerdr(args, { allowFailure = false } = {}) {
	const result = spawnSync("herdr", args, {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		timeout: 180_000,
	});
	if (result.error) throw result.error;
	const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
	let payload = null;
	for (const text of [result.stdout, result.stderr]) {
		try {
			payload = JSON.parse(text);
			break;
		} catch {
			// Herdr may place human diagnostics beside one JSON stream.
		}
	}
	const failed = result.status !== 0;
	if (failed !== allowFailure)
		throw new Error(
			`herdr ${args.join(" ")} ${failed ? "failed" : "unexpectedly succeeded"}: ${output.slice(0, 2048)}`,
		);
	return { payload, output, status: result.status };
}
function collectObjects(value, predicate, results = []) {
	if (value && typeof value === "object") {
		if (!Array.isArray(value) && predicate(value)) results.push(value);
		for (const child of Object.values(value))
			collectObjects(child, predicate, results);
	}
	return results;
}

export function observedPluginState(payload) {
	const matches = collectObjects(
		payload,
		(value) =>
			value.plugin_id === PLUGIN_ID && typeof value.enabled === "boolean",
	);
	if (matches.length === 0) return Object.freeze({ presence: "absent" });
	if (matches.length !== 1)
		throw Object.assign(new Error("Conductor plugin state is ambiguous"), {
			code: "capability_unavailable",
		});
	const plugin = matches[0];
	const sourceKeys =
		plugin.source && typeof plugin.source === "object"
			? Object.keys(plugin.source).sort()
			: [];
	if (
		canonicalJson(sourceKeys) !== canonicalJson(["kind"]) ||
		plugin.source.kind !== "local" ||
		typeof plugin.plugin_root !== "string" ||
		plugin.plugin_root.length === 0
	)
		throw Object.assign(
			new Error("prior Conductor plugin source cannot be restored exactly"),
			{ code: "capability_unavailable" },
		);
	let pluginRoot;
	try {
		pluginRoot = realpathSync(plugin.plugin_root);
	} catch (error) {
		throw Object.assign(
			new Error("prior Conductor plugin root cannot be restored exactly", {
				cause: error,
			}),
			{ code: "capability_unavailable" },
		);
	}
	return Object.freeze({
		presence: "local",
		plugin_id: PLUGIN_ID,
		plugin_root: pluginRoot,
		enabled: plugin.enabled,
		source: Object.freeze({ kind: "local" }),
		record_sha256: sha256(canonicalJson(plugin)),
	});
}

function currentPluginState() {
	return observedPluginState(runHerdr(["plugin", "list", "--json"]).payload);
}

export function pluginRestorationArguments(prior) {
	if (prior?.presence === "absent")
		return Object.freeze(["plugin", "unlink", PLUGIN_ID]);
	if (
		prior?.presence === "local" &&
		canonicalJson(Object.keys(prior).sort()) ===
			canonicalJson([
				"enabled",
				"plugin_id",
				"plugin_root",
				"presence",
				"record_sha256",
				"source",
			]) &&
		prior.plugin_id === PLUGIN_ID &&
		canonicalJson(prior.source) === canonicalJson({ kind: "local" }) &&
		typeof prior.plugin_root === "string" &&
		typeof prior.enabled === "boolean" &&
		/^[a-f0-9]{64}$/.test(prior.record_sha256)
	)
		return Object.freeze([
			"plugin",
			"link",
			prior.plugin_root,
			prior.enabled ? "--enabled" : "--disabled",
		]);
	throw Object.assign(
		new Error("prior plugin state is not exactly restorable"),
		{
			code: "capability_unavailable",
		},
	);
}

function restorePluginState(prior) {
	runHerdr(pluginRestorationArguments(prior));
	const restored = currentPluginState();
	if (canonicalJson(restored) !== canonicalJson(prior))
		throw new Error(
			"Conductor plugin state restoration did not verify exactly",
		);
}

export function workspaceAbsentObservation(
	workspaceId,
	listPayload,
	getResult,
) {
	const listed = collectObjects(
		listPayload,
		(value) => typeof value.workspace_id === "string",
	).some((workspace) => workspace.workspace_id === workspaceId);
	const getError = findObject(
		getResult.payload,
		(value) => value.code === "workspace_not_found",
	);
	if (listed || getResult.status === 0 || !getError)
		throw new Error(`workspace ${workspaceId} absence was not proven`);
	return true;
}

function closeAndVerifyWorkspace(workspaceId) {
	runHerdr(["workspace", "close", workspaceId]);
	const listed = runHerdr(["workspace", "list"]);
	const fetched = runHerdr(["workspace", "get", workspaceId], {
		allowFailure: true,
	});
	return workspaceAbsentObservation(workspaceId, listed.payload, fetched);
}

export function createForbiddenEffectTracker(snapshot) {
	if (typeof snapshot !== "function")
		throw new TypeError("forbidden-effect snapshot function is required");
	const observations = [];
	let forbiddenEffectCount = 0;
	return Object.freeze({
		probe(id, action) {
			const before = snapshot();
			const result = action();
			const after = snapshot();
			const changed = [
				...new Set([...Object.keys(before), ...Object.keys(after)]),
			]
				.filter(
					(surface) =>
						canonicalJson(before[surface]) !== canonicalJson(after[surface]),
				)
				.sort();
			forbiddenEffectCount += changed.length;
			observations.push({
				id,
				before_sha256: sha256(canonicalJson(before)),
				after_sha256: sha256(canonicalJson(after)),
				changed,
			});
			if (changed.length > 0)
				throw Object.assign(
					new Error(
						`refusal probe mutated forbidden surfaces: ${changed.join(", ")}`,
					),
					{ code: "forbidden_effect_observed" },
				);
			return result;
		},
		get forbiddenEffectCount() {
			return forbiddenEffectCount;
		},
		get observationDigest() {
			return sha256(canonicalJson(observations));
		},
	});
}

const INVENTORY_CONTENT_LIMIT = 1_048_576;

function gitBytes(repository, ...args) {
	return execFileSync("git", ["-C", repository, ...args], {
		encoding: null,
		stdio: ["ignore", "pipe", "pipe"],
		timeout: 180_000,
	});
}

function nulInventory(repository, args) {
	const bytes = gitBytes(repository, ...args);
	if (bytes.length === 0) return [];
	if (bytes.at(-1) !== 0)
		throw new Error(`git ${args[0]} inventory is not NUL terminated`);
	return bytes.subarray(0, -1).toString("utf8").split("\0").sort();
}

function pathEffectObservation(worktree, path, { bounded = false } = {}) {
	const absolute = join(worktree, path);
	const stats = lstatSync(absolute);
	const mode = Number(stats.mode & 0o7777);
	if (stats.isSymbolicLink())
		return Object.freeze({
			path,
			kind: "symlink",
			mode,
			content_sha256: sha256(Buffer.from(readlinkSync(absolute))),
		});
	if (!stats.isFile())
		return Object.freeze({ path, kind: "unsupported", mode, size: stats.size });
	if (bounded && stats.size > INVENTORY_CONTENT_LIMIT)
		throw Object.assign(
			new Error(`worktree inventory file exceeds snapshot bound: ${path}`),
			{ code: "capability_unavailable" },
		);
	return Object.freeze({
		path,
		kind: "file",
		mode,
		size: stats.size,
		content_sha256: sha256(readFileSync(absolute)),
	});
}

function sourceModeInventory(worktree, paths) {
	const directories = new Set([worktree]);
	for (const path of paths) {
		let parent = dirname(join(worktree, path));
		while (parent.startsWith(`${worktree}/`)) {
			directories.add(parent);
			parent = dirname(parent);
		}
	}
	return Object.freeze(
		[...directories]
			.sort()
			.map((path) => [
				relative(worktree, path) || ".",
				Number(lstatSync(path).mode & 0o7777),
			]),
	);
}

function worktreeEffectSnapshot(worktree) {
	const canonicalPath = realpathSync(worktree);
	const symbolic = spawnSync(
		"git",
		["-C", canonicalPath, "symbolic-ref", "-q", "HEAD"],
		{ encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
	);
	if (![0, 1].includes(symbolic.status))
		throw new Error("git symbolic-ref failed while snapshotting worktree");
	const tracked = nulInventory(canonicalPath, ["ls-files", "-z"]);
	const untracked = nulInventory(canonicalPath, [
		"ls-files",
		"--others",
		"--exclude-standard",
		"-z",
	]);
	const ignored = nulInventory(canonicalPath, [
		"ls-files",
		"--others",
		"--ignored",
		"--exclude-standard",
		"-z",
	]);
	return Object.freeze({
		identity: canonicalPath,
		head: git(canonicalPath, "rev-parse", "HEAD"),
		ref: symbolic.status === 0 ? symbolic.stdout.trim() : null,
		index_tree: git(canonicalPath, "write-tree"),
		index_stages_sha256: sha256(
			gitBytes(canonicalPath, "ls-files", "--stage", "-z"),
		),
		tracked_status_sha256: sha256(
			gitBytes(
				canonicalPath,
				"status",
				"--porcelain=v1",
				"-z",
				"--untracked-files=no",
			),
		),
		source_modes: Object.freeze({
			directories: sourceModeInventory(canonicalPath, [
				...tracked,
				...untracked,
				...ignored,
			]),
			admin: Number(lstatSync(join(canonicalPath, ".git")).mode & 0o7777),
		}),
		tracked: Object.freeze(
			tracked.map((path) => pathEffectObservation(canonicalPath, path)),
		),
		untracked: Object.freeze(
			untracked.map((path) =>
				pathEffectObservation(canonicalPath, path, { bounded: true }),
			),
		),
		ignored: Object.freeze(
			ignored.map((path) =>
				pathEffectObservation(canonicalPath, path, { bounded: true }),
			),
		),
	});
}

function gitEffectSnapshot(repository, registeredWorktreePaths = []) {
	const worktreeList = git(repository, "worktree", "list", "--porcelain");
	const worktreePaths = worktreeList
		.split("\n")
		.filter((line) => line.startsWith("worktree "))
		.map((line) => realpathSync(line.slice("worktree ".length)))
		.sort();
	const registered = [...registeredWorktreePaths]
		.map((path) => realpathSync(path))
		.sort();
	for (const path of registered)
		if (!worktreePaths.includes(path))
			throw Object.assign(
				new Error(`registered worktree is absent from Git inventory: ${path}`),
				{ code: "capability_unavailable" },
			);
	return Object.freeze({
		common_directory: realpathSync(
			resolve(repository, git(repository, "rev-parse", "--git-common-dir")),
		),
		refs: git(
			repository,
			"for-each-ref",
			"--format=%(refname):%(objectname)",
		).split("\n"),
		worktree_list: worktreeList,
		registered_worktree_identities: Object.freeze(registered),
		worktrees: Object.freeze(worktreePaths.map(worktreeEffectSnapshot)),
	});
}

export function liveForbiddenEffectSnapshot({
	repository,
	stateRepositoryPath,
	outputParentPath,
	candidatePath,
	pluginPayload,
	workspacePayload,
	registeredWorktreePaths = [],
}) {
	const gitState = gitEffectSnapshot(repository, registeredWorktreePaths);
	const retained = inventory(stateRepositoryPath);
	const candidate = gitEffectSnapshot(candidatePath);
	const output = inventory(outputParentPath);
	const plugin = sha256(canonicalJson(observedPluginState(pluginPayload)));
	const workspaces = sha256(canonicalJson(workspacePayload));
	return Object.freeze({
		git_refs_head_index_worktree: gitState,
		task_outbox_accepted_files: retained.digest,
		journal: retained.digest,
		cas_sync: gitState,
		gate_pane_close_archive: [retained.digest, workspaces],
		plugin_workspace_state: [plugin, workspaces],
		removal_prune_apply: [
			gitState.refs,
			gitState.worktree_list,
			retained.digest,
		],
		out_of_root: [candidate, output.digest],
	});
}

export function exactObservedProducerSelection(entries, expectedProducers) {
	const reconciliations = entries.filter(
		(entry) =>
			entry.operation_type === "integration.reconcile" &&
			entry.phase === "observed",
	);
	if (reconciliations.length !== 1)
		throw new Error("evidence requires exactly one observed reconciliation");
	const selection = reconciliations[0].observed_identity?.selection;
	if (!Array.isArray(selection) || selection.length === 0)
		throw new Error("observed producer selection is empty or missing");
	const expected = [...expectedProducers].sort((left, right) =>
		Buffer.from(left.role_name).compare(Buffer.from(right.role_name)),
	);
	if (canonicalJson(selection) !== canonicalJson(expected))
		throw new Error("observed producer selection is renamed or incomplete");
	return Object.freeze(selection);
}

function embeddedJson(result, predicate) {
	const direct = findObject(result.payload, predicate);
	if (direct) return direct;
	const candidates = [result.output];
	walk(result.payload, (value) => {
		if (typeof value === "string") candidates.push(value);
	});
	for (const text of candidates)
		for (const candidate of [text.trim(), ...text.split("\n")]) {
			if (!candidate.startsWith("{")) continue;
			try {
				const found = findObject(JSON.parse(candidate), predicate);
				if (found) return found;
			} catch {
				// Not a standalone JSON value.
			}
		}
	throw new Error("Herdr action omitted its structured result");
}
function invokeLog(actionId) {
	const invoked = runHerdr([
		"plugin",
		"action",
		"invoke",
		actionId,
		"--plugin",
		PLUGIN_ID,
	]);
	const invocation = findObject(
		invoked.payload,
		(value) =>
			value?.log &&
			typeof value.log.log_id === "string" &&
			value.action?.action_id === actionId,
	);
	if (!invocation)
		throw new Error(`Herdr omitted ${actionId} action log identity`);
	const deadline = Date.now() + 180_000;
	let log;
	while (Date.now() < deadline) {
		const listed = runHerdr([
			"plugin",
			"log",
			"list",
			"--plugin",
			PLUGIN_ID,
			"--limit",
			"100",
		]);
		log = findObject(
			listed.payload,
			(value) => value.log_id === invocation.log.log_id,
		);
		if (log && log.status !== "running") break;
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
	}
	if (!log || log.status === "running")
		throw new Error(`Herdr ${actionId} did not reach a terminal state`);
	return {
		payload: log,
		output: `${log.stdout ?? ""}\n${log.stderr ?? ""}`.trim(),
	};
}
function invoke(actionId) {
	const result = invokeLog(actionId);
	if (result.payload.status !== "succeeded" || result.payload.exit_code !== 0)
		throw new Error(`Herdr ${actionId} did not complete successfully`);
	return result;
}
function invokeRefusal(actionId) {
	const result = invokeLog(actionId);
	if (result.payload.status === "succeeded" || result.payload.exit_code === 0)
		throw new Error(`Herdr ${actionId} isolation probe unexpectedly succeeded`);
	return sha256(
		canonicalJson({
			action_id: actionId,
			status: result.payload.status,
			exit_code: result.payload.exit_code,
			output_sha256: sha256(result.output),
		}),
	);
}
function createRepository(path, stateRoot) {
	command("git", ["init", "-q", "-b", "main", path]);
	git(path, "config", "user.name", "Herdr Conductor Evidence");
	git(path, "config", "user.email", "conductor-evidence@local.invalid");
	writeFileSync(join(path, "base.txt"), "stage2 live evidence\n");
	writeFileSync(
		join(path, ".herdr-conductor.json"),
		canonicalJson({
			version: 2,
			state_root: { kind: "absolute", path: stateRoot },
			worktree_root: ".conductor-worktrees",
			roles: [
				{
					name: "builder",
					contract_role: "builder",
					kind: "pi",
					mode: "write",
					assignment: {
						title: "Build retained Stage 2 evidence fixture",
						mission: "Create the one owned deterministic source file.",
						acceptance_criteria: [
							{ id: "owned-file", text: "The owned source file is committed." },
						],
						owned_paths: ["src"],
						forbidden_paths: ["forbidden"],
						required_commands: [],
					},
					validator_artifacts: [],
				},
				{
					name: "validator",
					contract_role: "validator",
					kind: "pi",
					mode: "gated",
					assignment: {
						title: "Validate exact integration evidence",
						mission:
							"Inspect the exact integration snapshot without source output.",
						acceptance_criteria: [
							{
								id: "exact-sha",
								text: "The gate source is the expected integration SHA.",
							},
						],
						owned_paths: [],
						forbidden_paths: [],
						required_commands: [],
					},
					validator_artifacts: [],
				},
			],
		}),
	);
	git(path, "add", "base.txt", ".herdr-conductor.json");
	command("git", ["-C", path, "commit", "-qm", "stage2 evidence base"], {
		env: {
			...process.env,
			GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
			GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
		},
	});
	return realpathSync(path);
}
function repositoryKey(repository) {
	const commonPath = realpathSync(
		git(repository, "rev-parse", "--path-format=absolute", "--git-common-dir"),
	);
	const stats = statSync(commonPath, { bigint: true });
	return sha256(
		`herdr-conductor-repository-v1\0${commonPath}\0${stats.dev}\0${stats.ino}`,
	);
}
function workspaceKey(workspaceId) {
	return sha256(`herdr-conductor-workspace-v1\0${workspaceId}`);
}
function journalEntries(stateRepositoryPath, workspaceId, assembled) {
	const directory = join(
		stateRepositoryPath,
		"workspaces",
		workspaceKey(workspaceId),
		"runs",
		assembled.run_id,
		assembled.generation,
		"operations",
	);
	return readdirSync(directory)
		.filter((name) => name.endsWith(".json"))
		.sort()
		.map((name) => parseStrictJsonBytes(readFileSync(join(directory, name))));
}
function buildReport(worker, stateRepositoryPath, workspaceId, assembled) {
	const task = parseTaskBytes(readFileSync(worker.task_path));
	const agent = journalEntries(
		stateRepositoryPath,
		workspaceId,
		assembled,
	).find(
		(entry) =>
			entry.operation_type === "agent.start" &&
			entry.phase === "observed" &&
			entry.subject.id === task.role.name,
	);
	assert.ok(agent, "report requires observed task-bound agent authority");
	const producer = task.source.kind === "role_worktree";
	const output = producer ? git(task.source.root, "rev-parse", "HEAD") : null;
	const source = producer
		? {
				...task.source,
				expected_sha: output,
				tree_sha: git(task.source.root, "rev-parse", "HEAD^{tree}"),
			}
		: task.source;
	const changedPaths = producer
		? computeChangedPaths(task.source.root, task.source.fork_sha, output)
		: [];
	const requirementResults = [
		...task.assignment.required_commands.map((requirement) => ({
			requirement_kind: "command",
			requirement_id: requirement.id,
			assertion: "passed",
			evidence_kind: "worker_assertion",
			command: requirement.command,
			exit_code: 0,
			output_sha256: sha256("sanitized successful command assertion"),
			note: "Unauthenticated worker assertion recorded for live contract coverage.",
		})),
		...task.assignment.acceptance_criteria.map((requirement) => ({
			requirement_kind: "criterion",
			requirement_id: requirement.id,
			assertion: "passed",
			evidence_kind: "worker_assertion",
			command: null,
			exit_code: null,
			output_sha256: null,
			note: "Unauthenticated worker assertion recorded for live contract coverage.",
		})),
	];
	const draft = {
		document_type: "herdr-conductor-report",
		schema_version: 1,
		report_id: `evidence-${task.role.name}`,
		report_generation: sha256(`report\0${task.task_digest}`).slice(0, 32),
		task: {
			id: task.task_id,
			generation: task.task_generation,
			digest: task.task_digest,
		},
		scope: task.scope,
		role: task.role,
		source,
		agent_observation: {
			operation_id: task.role.agent_operation_id,
			entry_digest: agent.entry_digest,
			agent_generation: task.role.agent_generation,
			pane_generation: task.role.pane_generation,
			agent_name: task.role.agent_name,
		},
		status: "completed",
		result:
			task.role.contract_role === "validator"
				? { kind: "validation", verdict: "pass" }
				: { kind: "delivery", verdict: "delivered" },
		summary: "Sanitized attended Stage 2 contract result.",
		findings: [],
		requirement_results: requirementResults,
		changed_paths: changedPaths,
		artifacts: [],
		completed_at: "2026-07-28T00:00:00.000Z",
	};
	return { task, report: { ...draft, report_digest: reportDigest(draft) } };
}
function runReportPublisher(pluginCheckout, worker, report) {
	return spawnSync(
		process.execPath,
		[
			join(pluginCheckout, "scripts/report-publisher.mjs"),
			"publish",
			"--config",
			join(report.scope.repository_root, ".herdr-conductor.json"),
			"--task",
			worker.task_path,
		],
		{
			cwd: worker.cwd,
			input: canonicalJson(report),
			encoding: "utf8",
			timeout: 120_000,
		},
	);
}
function publishReport(pluginCheckout, worker, report) {
	const result = runReportPublisher(pluginCheckout, worker, report);
	if (result.status !== 0) throw new Error("report publication failed");
}
function refuseReport(pluginCheckout, worker, report) {
	const before = readdirSync(worker.outbox_slot).sort();
	const result = runReportPublisher(pluginCheckout, worker, report);
	if (result.status === 0)
		throw new Error("invalid or duplicate report publication succeeded");
	const after = readdirSync(worker.outbox_slot).sort();
	assert.deepEqual(after, before);
	return sha256(canonicalJson({ before, after, failed: true }));
}
function inventory(path) {
	const rows = [];
	function visit(directory) {
		for (const entry of readdirSync(directory, { withFileTypes: true }).sort(
			(a, b) => Buffer.from(a.name).compare(Buffer.from(b.name)),
		)) {
			const child = join(directory, entry.name);
			const stats = lstatSync(child);
			let type = "other";
			if (entry.isDirectory()) type = "directory";
			else if (entry.isFile()) type = "file";
			const item = {
				path_sha256: sha256(relative(path, child)),
				type,
				mode: (stats.mode & 0o777).toString(8).padStart(4, "0"),
			};
			if (entry.isFile()) item.content_sha256 = sha256(readFileSync(child));
			rows.push(item);
			if (entry.isDirectory()) visit(child);
		}
	}
	visit(path);
	return { count: rows.length, digest: sha256(canonicalJson(rows)) };
}
function refusalDigest(fn, expectedCodes) {
	try {
		fn();
	} catch (error) {
		if (!expectedCodes.includes(error.code))
			throw new Error(
				`negative probe returned ${error.code ?? "unknown_error"}`,
			);
		return sha256(canonicalJson({ code: error.code, refused: true }));
	}
	throw new Error("negative probe unexpectedly succeeded");
}
export async function runLiveStage2Evidence({
	candidate,
	reviewRecordPath,
	outputParentPath,
}) {
	if (process.env.CONDUCTOR_STAGE2_LIVE_EVIDENCE !== OPT_IN)
		throw new Error(
			`refusing live evidence: set CONDUCTOR_STAGE2_LIVE_EVIDENCE=${OPT_IN}`,
		);
	if (
		git(root, "rev-parse", "HEAD") !== candidate ||
		git(root, "status", "--porcelain", "--untracked-files=all") !== ""
	)
		throw new Error(
			"candidate checkout must be clean and exactly match --candidate",
		);
	const sourceManifest = buildStage2SourceManifest(root, candidate);
	const sourceBytes = Buffer.from(canonicalJson(sourceManifest));
	const review = validateExternalReviewRecord(
		parseStrictJsonBytes(readFileSync(reviewRecordPath)),
		{ candidate, sourceManifest },
	);
	if (review.review_record_sha256 !== externalReviewDigest(review))
		throw new Error("external review digest differs");
	const outputParent = openPrivateOutputParent(outputParentPath, {
		candidateCheckout: root,
	});
	const plane = await createHarnessControlPlane({ candidateCheckout: root });
	let priorPluginState = null;
	let pluginMutated = false;
	let pluginRestored = false;
	let workspaceId = null;
	const openWorkspaceIds = new Set();
	const absentWorkspaceIds = new Set();
	try {
		const pluginCheckout = join(
			plane.rootPath,
			"repositories",
			"plugin-candidate",
		);
		command("git", ["clone", "-q", "--no-local", root, pluginCheckout]);
		git(pluginCheckout, "checkout", "-q", "--detach", candidate);
		assert.equal(
			git(pluginCheckout, "status", "--porcelain", "--untracked-files=all"),
			"",
		);
		assert.equal(
			JSON.parse(readFileSync(join(pluginCheckout, "package.json"))).version,
			"0.3.0",
		);
		assert.match(
			readFileSync(join(pluginCheckout, "herdr-plugin.toml"), "utf8"),
			/^version = "0\.3\.0"$/m,
		);
		assert.equal(command("herdr", ["--version"]), "herdr 0.7.5");
		const server = command("herdr", ["status", "server"]);
		assert.match(server, /^status: running$/m);
		assert.match(server, /^version: 0\.7\.5$/m);
		assert.match(server, /^protocol: 17$/m);
		const api = JSON.parse(command("herdr", ["api", "schema", "--json"]));
		assert.deepEqual(
			{ protocol: api.protocol, schema: api.schema_version },
			{ protocol: 17, schema: 1 },
		);
		priorPluginState = currentPluginState();
		command("herdr", ["plugin", "link", pluginCheckout, "--enabled"]);
		pluginMutated = true;
		const linkedPluginState = currentPluginState();
		assert.deepEqual(
			{
				presence: linkedPluginState.presence,
				plugin_id: linkedPluginState.plugin_id,
				plugin_root: linkedPluginState.plugin_root,
				enabled: linkedPluginState.enabled,
				source: linkedPluginState.source,
			},
			{
				presence: "local",
				plugin_id: PLUGIN_ID,
				plugin_root: realpathSync(pluginCheckout),
				enabled: true,
				source: { kind: "local" },
			},
		);
		assert.match(linkedPluginState.record_sha256, /^[a-f0-9]{64}$/);
		const stateRoot = realpathSync(join(plane.rootPath, "state"));
		const repository = createRepository(
			join(plane.rootPath, "repositories", "product"),
			stateRoot,
		);
		const repositoryKeyValue = repositoryKey(repository);
		const stateRepositoriesParent = join(stateRoot, "v1", "repositories");
		const workspace = runHerdr([
			"workspace",
			"create",
			"--cwd",
			repository,
			"--label",
			"Conductor Stage 2 exact-A evidence",
			"--focus",
		]);
		workspaceId = findObject(
			workspace.payload,
			(value) => typeof value.workspace_id === "string",
		)?.workspace_id;
		if (!workspaceId)
			throw new Error("Herdr workspace.create omitted workspace identity");
		openWorkspaceIds.add(workspaceId);
		await plane.appendWorkspaceIdentity(workspaceId);
		const livePlan = createStage2LivePlanDriver(invoke);
		const assembledAction = livePlan.run("assemble");
		const assembled = embeddedJson(
			assembledAction,
			(value) =>
				typeof value.run_id === "string" && Array.isArray(value.workers),
		);
		assert.equal(assembled.workers.length, 1);
		livePlan.run("board");
		livePlan.run("status");
		const stateRepositoryPath = join(
			stateRepositoriesParent,
			repositoryKeyValue,
		);
		const refusalDigests = [];
		const isolationWorkspace = runHerdr([
			"workspace",
			"create",
			"--cwd",
			repository,
			"--label",
			"Conductor Stage 2 isolation probe",
			"--focus",
		]);
		const isolationWorkspaceId = findObject(
			isolationWorkspace.payload,
			(value) => typeof value.workspace_id === "string",
		)?.workspace_id;
		if (!isolationWorkspaceId)
			throw new Error("Herdr isolation workspace omitted identity");
		openWorkspaceIds.add(isolationWorkspaceId);
		await plane.appendWorkspaceIdentity(isolationWorkspaceId);
		const builder = assembled.workers[0];
		const registeredWorktreePaths = new Set([builder.cwd]);
		const effectTracker = createForbiddenEffectTracker(() =>
			liveForbiddenEffectSnapshot({
				repository,
				stateRepositoryPath,
				outputParentPath: outputParent.canonicalPath,
				candidatePath: root,
				pluginPayload: runHerdr(["plugin", "list", "--json"]).payload,
				workspacePayload: runHerdr(["workspace", "list"]).payload,
				registeredWorktreePaths,
			}),
		);
		const stateBeforeIsolation = inventory(stateRepositoryPath).digest;
		livePlan.run("foreign_workspace_refusals", () =>
			effectTracker.probe("foreign_workspace_refusals", () => {
				for (const actionId of ["board", "status", "harvest", "stand-down"])
					refusalDigests.push(invokeRefusal(actionId));
				assert.equal(
					inventory(stateRepositoryPath).digest,
					stateBeforeIsolation,
				);
			}),
		);
		closeAndVerifyWorkspace(isolationWorkspaceId);
		absentWorkspaceIds.add(isolationWorkspaceId);
		openWorkspaceIds.delete(isolationWorkspaceId);
		runHerdr(["workspace", "focus", workspaceId]);
		mkdirSync(join(builder.cwd, "src"));
		writeFileSync(
			join(builder.cwd, "src", "live-evidence.txt"),
			"attended Stage 2 evidence\n",
		);
		git(builder.cwd, "add", "src/live-evidence.txt");
		command(
			"git",
			["-C", builder.cwd, "commit", "-qm", "add Stage 2 live evidence fixture"],
			{
				env: {
					...process.env,
					GIT_AUTHOR_DATE: "2000-01-01T00:01:00Z",
					GIT_COMMITTER_DATE: "2000-01-01T00:01:00Z",
				},
			},
		);
		const builderReport = buildReport(
			builder,
			stateRepositoryPath,
			workspaceId,
			assembled,
		);
		livePlan.run("producer_path_refusal", () =>
			effectTracker.probe("producer_path_refusal", () =>
				refusalDigests.push(
					refusalDigest(
						() =>
							validateProducerPathPolicy(
								["forbidden/probe"],
								["forbidden/probe"],
								builderReport.task.assignment,
							),
						["source_policy_violation"],
					),
				),
			),
		);
		const builderRef = builderReport.task.source.branch_ref;
		const reportedHead = builderReport.report.source.expected_sha;
		const driftHead = builderReport.task.source.fork_sha;
		git(builder.cwd, "update-ref", builderRef, driftHead, reportedHead);
		try {
			livePlan.run("producer_source_refusal", () =>
				effectTracker.probe("producer_source_refusal", () =>
					refusalDigests.push(
						refusalDigest(
							() =>
								inspectProducerSource(
									builderReport.task.source,
									builderReport.report.source,
									builderReport.task.assignment,
									{ reportedPaths: builderReport.report.changed_paths },
								),
							["stale_source", "foreign_repository"],
						),
					),
				),
			);
		} finally {
			git(builder.cwd, "update-ref", builderRef, reportedHead, driftHead);
		}
		livePlan.run("producer_digest_refusal", () =>
			effectTracker.probe("producer_digest_refusal", () =>
				refusalDigests.push(
					refuseReport(pluginCheckout, builder, {
						...builderReport.report,
						report_digest: "0".repeat(64),
					}),
				),
			),
		);
		livePlan.run("producer_publish", () =>
			publishReport(pluginCheckout, builder, builderReport.report),
		);
		livePlan.run("producer_replay_refusal", () =>
			effectTracker.probe("producer_replay_refusal", () =>
				refusalDigests.push(
					refuseReport(pluginCheckout, builder, builderReport.report),
				),
			),
		);
		const firstHarvestAction = livePlan.run("producer_harvest");
		const firstHarvest = embeddedJson(
			firstHarvestAction,
			(value) =>
				value.lifecycle === "gate_waiting_reports" &&
				Array.isArray(value.gate_workers),
		);
		assert.equal(firstHarvest.gate_workers.length, 1);
		const validator = firstHarvest.gate_workers[0];
		registeredWorktreePaths.add(validator.cwd);
		assert.equal(
			git(validator.cwd, "rev-parse", "HEAD"),
			firstHarvest.integration.final_sha,
		);
		const gateSha = git(validator.cwd, "rev-parse", "HEAD");
		const validatorTask = parseTaskBytes(readFileSync(validator.task_path));
		const gateProbePath = join(validator.cwd, "base.txt");
		chmodSync(gateProbePath, 0o644);
		try {
			livePlan.run("gate_source_refusal", () =>
				effectTracker.probe("gate_source_refusal", () =>
					refusalDigests.push(
						refusalDigest(
							() => validateGateSource(validatorTask.source),
							["stale_source", "source_policy_violation"],
						),
					),
				),
			);
		} finally {
			chmodSync(gateProbePath, 0o444);
		}
		validateGateSource(validatorTask.source);
		const validatorReport = buildReport(
			validator,
			stateRepositoryPath,
			workspaceId,
			assembled,
		);
		livePlan.run("gate_digest_refusal", () =>
			effectTracker.probe("gate_digest_refusal", () =>
				refusalDigests.push(
					refuseReport(pluginCheckout, validator, {
						...validatorReport.report,
						report_digest: "0".repeat(64),
					}),
				),
			),
		);
		livePlan.run("gate_publish", () =>
			publishReport(pluginCheckout, validator, validatorReport.report),
		);
		const secondHarvestAction = livePlan.run("gate_harvest");
		const secondHarvest = embeddedJson(
			secondHarvestAction,
			(value) => value.lifecycle === "gate_reports_collected",
		);
		assert.equal(
			secondHarvest.integration.final_sha,
			firstHarvest.integration.final_sha,
		);
		const standDownAction = livePlan.run("stand_down");
		const standDown = embeddedJson(
			standDownAction,
			(value) => value.archived === true,
		);
		assert.equal(standDown.archived, true);
		const entries = journalEntries(stateRepositoryPath, workspaceId, assembled);
		const taskReports = [builderReport, validatorReport]
			.map(({ task, report }) => ({
				role: task.role.name,
				task_digest: task.task_digest,
				report_digest: report.report_digest,
				assertion_strength: "unauthenticated_worker_assertion",
			}))
			.sort((left, right) =>
				Buffer.from(left.role).compare(Buffer.from(right.role)),
			);
		const producerSelection = exactObservedProducerSelection(entries, [
			{
				role_name: builderReport.task.role.name,
				task_digest: builderReport.task.task_digest,
				report_digest: builderReport.report.report_digest,
				source_sha: builderReport.report.source.expected_sha,
				tree_sha: builderReport.report.source.tree_sha,
				source_generation: builderReport.task.role.source_generation,
			},
		]);
		const retained = inventory(stateRepositoryPath);
		const productRetained = inventory(repository);
		livePlan.run("retained_effect_evidence", () => {
			assert.ok(retained.count > 0);
			assert.ok(productRetained.count > 0);
			assert.ok(refusalDigests.length >= 8);
			assert.equal(effectTracker.forbiddenEffectCount, 0);
		});
		const observedPlan = livePlan.finish();
		closeAndVerifyWorkspace(workspaceId);
		absentWorkspaceIds.add(workspaceId);
		openWorkspaceIds.delete(workspaceId);
		workspaceId = null;
		restorePluginState(priorPluginState);
		pluginRestored = true;
		await plane.recordDisposableTree();
		for (const [logicalId, sequence, path] of [
			["source_manifest", 1, STAGE2_EVIDENCE_PATHS[0]],
			["human_report", 2, STAGE2_EVIDENCE_PATHS[2]],
			["machine_evidence", 3, STAGE2_EVIDENCE_PATHS[1]],
		])
			await plane.appendOutputIntent({
				logical_id: logicalId,
				parent_path: outputParent.canonicalPath,
				parent_device: outputParent.device,
				parent_inode: outputParent.inode,
				filename: basename(path),
				logical_sequence: sequence,
			});
		await plane.sealHarnessManifest();
		const filesystemCleanup = await plane.teardownHarness();
		if (absentWorkspaceIds.size !== 2)
			throw new Error(
				"not every registered disposable workspace was proven absent",
			);
		const cleanupResult = {
			...filesystemCleanup,
			workspace_absent: true,
		};
		const machinePreimage = {
			document_type: "herdr-conductor-stage2-live-evidence",
			schema_version: 1,
			candidate_sha: candidate,
			run_id: assembled.run_id,
			source_manifest_sha256: sha256(sourceBytes),
			output_parent_binding: outputParentBinding({
				candidateSha: candidate,
				runId: assembled.run_id,
				canonicalPath: outputParent.canonicalPath,
				device: outputParent.device,
				inode: outputParent.inode,
				owner: outputParent.owner,
			}),
			output_files: {
				source_manifest: basename(STAGE2_EVIDENCE_PATHS[0]),
				human_report: basename(STAGE2_EVIDENCE_PATHS[2]),
				machine_evidence: basename(STAGE2_EVIDENCE_PATHS[1]),
			},
			cleanup_result: cleanupResult,
			external_review: review,
			external_review_digest: review.review_record_sha256,
			runtime_summary: {
				herdr_version: "0.7.5",
				protocol_version: 17,
				api_schema_version: 1,
				action_sequence: observedPlan.actionSequence,
				producer_selection_sha256: sha256(canonicalJson(producerSelection)),
				final_integration_sha: firstHarvest.integration.final_sha,
				gate_shas: [gateSha],
				task_report_digests: taskReports,
				task_count: taskReports.length,
				report_count: taskReports.length,
				gate_count: 1,
				journal_head: entries.at(-1).entry_digest,
				journal_entry_count: entries.length,
				retained_inventory_sha256: sha256(
					canonicalJson([retained.digest, productRetained.digest]),
				),
				retained_inventory_count: retained.count + productRetained.count,
				refusal_snapshot_sha256: sha256(
					canonicalJson([refusalDigests, effectTracker.observationDigest]),
				),
				integration_cas_count: firstHarvest.integration.cas_count,
				forbidden_effect_count: effectTracker.forbiddenEffectCount,
			},
		};
		const humanBytes = renderStage2EvidenceReport(machinePreimage);
		const machine = {
			...machinePreimage,
			human_report_sha256: sha256(humanBytes),
		};
		const machineBytes = Buffer.from(canonicalJson(machine));
		assertSanitizedEvidence(machine, humanBytes, {
			localPaths: [
				dirname(plane.rootPath),
				plane.rootPath,
				root,
				pluginCheckout,
				repository,
				stateRoot,
				stateRepositoriesParent,
				stateRepositoryPath,
				outputParent.canonicalPath,
				dirname(outputParent.canonicalPath),
				homedir(),
			],
			localValues: [process.env.USER],
		});
		const result = publishPrivateEvidenceTrio(outputParent, {
			sourceBytes,
			humanBytes,
			machineBytes,
		});
		return result.completionDigest;
	} finally {
		let cleanupFailure = null;
		for (const pendingWorkspaceId of openWorkspaceIds) {
			try {
				closeAndVerifyWorkspace(pendingWorkspaceId);
				absentWorkspaceIds.add(pendingWorkspaceId);
			} catch (error) {
				cleanupFailure ??= error;
			}
		}
		if (pluginMutated && !pluginRestored && priorPluginState) {
			try {
				restorePluginState(priorPluginState);
				pluginRestored = true;
			} catch (error) {
				cleanupFailure ??= error;
			}
		}
		plane.stop();
		closeSync(outputParent.descriptor);
		if (cleanupFailure) throw cleanupFailure;
	}
}

async function main() {
	const options = parseArguments(process.argv.slice(2));
	const completionDigest = await runLiveStage2Evidence(options);
	process.stdout.write(`Stage 2 live evidence complete: ${completionDigest}\n`);
}

if (
	process.argv[1] &&
	resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
	main().catch((error) => {
		process.stderr.write(
			`herdr-conductor: ${error.code ?? "live_evidence_failed"}: ${error.message}\n`,
		);
		process.exitCode = 1;
	});

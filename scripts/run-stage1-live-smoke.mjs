#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	canonicalJson,
	parseStrictJsonBytes,
} from "./private-state-schema.mjs";
import {
	ISOLATION_ACTION_IDS,
	ISOLATION_CONTEXTS,
	RETAINED_FILES,
	buildCandidateRuntimeSourceManifest,
	buildRuntimeSourceManifest,
	renderEvidenceReport,
	sha256,
	validateCandidatePreflight,
	validateEvidence,
	validateRuntimeSourceManifest,
} from "./stage1-evidence-contract.mjs";
import { requireLiveHarnessStateRoot } from "./state-root.mjs";

const OPT_IN = "I_UNDERSTAND_THIS_USES_LOCAL_HERDR";
const PLUGIN_ID = "structupath.conductor";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceManifestPath = join(
	root,
	"docs/evidence/stage1-runtime-source-manifest.json",
);
const evidenceJsonPath = join(
	root,
	"docs/evidence/2026-07-28-stage1-b4-live-smoke.json",
);
const evidenceReportPath = join(
	root,
	"docs/evidence/2026-07-28-stage1-b4-live-smoke.md",
);

if (process.env.CONDUCTOR_STAGE1_LIVE_SMOKE !== OPT_IN) {
	process.stderr.write(
		`refusing live smoke: set CONDUCTOR_STAGE1_LIVE_SMOKE=${OPT_IN}\n`,
	);
	process.exit(64);
}
let sharedStateRoot;
try {
	sharedStateRoot = requireLiveHarnessStateRoot();
} catch (error) {
	process.stderr.write(`${error.message}\n`);
	process.exit(64);
}

function command(commandName, args, options = {}) {
	return execFileSync(commandName, args, {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		timeout: 120_000,
		...options,
	}).trim();
}

function git(repository, ...args) {
	return command("git", ["-C", repository, ...args]);
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
		if (!text?.trim()) continue;
		try {
			payload = JSON.parse(text);
			break;
		} catch {
			// Some Herdr commands include non-JSON diagnostics on one stream.
		}
	}
	const failed = result.status !== 0;
	if (failed && !allowFailure)
		throw new Error(`herdr ${args.join(" ")} failed: ${output.slice(0, 4096)}`);
	if (!failed && allowFailure)
		throw new Error(`herdr ${args.join(" ")} unexpectedly succeeded`);
	return { payload, output, status: result.status };
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
	if (value === null || typeof value !== "object") {
		visit(value);
		return;
	}
	for (const child of Object.values(value)) walk(child, visit);
}

function embeddedJson(result, predicate) {
	const direct = findObject(result.payload, predicate);
	if (direct) return direct;
	const strings = [];
	walk(result.payload, (value) => {
		if (typeof value === "string") strings.push(value);
	});
	strings.push(result.output);
	for (const text of strings) {
		for (const candidate of [text.trim(), ...text.split("\n")]) {
			if (!candidate.startsWith("{")) continue;
			try {
				const found = findObject(JSON.parse(candidate), predicate);
				if (found) return found;
			} catch {
				// Not standalone JSON.
			}
		}
	}
	throw new Error("Herdr action did not expose the expected structured result");
}

function listObjects(kind, identity) {
	const listed = runHerdr([kind, "list"]);
	const found = [];
	function collect(value) {
		if (!value || typeof value !== "object") return;
		if (!Array.isArray(value) && typeof value[identity] === "string")
			found.push(value);
		for (const child of Object.values(value)) collect(child);
	}
	collect(listed.payload);
	return [...new Map(found.map((entry) => [entry[identity], entry])).values()];
}

function globalIdentityInventory() {
	return {
		workspace_ids: listObjects("workspace", "workspace_id")
			.map((entry) => entry.workspace_id)
			.sort(),
		pane_ids: listObjects("pane", "pane_id")
			.map((entry) => entry.pane_id)
			.sort(),
		agent_names: listObjects("agent", "name")
			.map((entry) => entry.name)
			.sort(),
	};
}

function workspaceSnapshot() {
	const listed = runHerdr(["workspace", "list"]);
	const workspaces = [];
	walk(listed.payload, (value) => {
		if (value && typeof value === "object") return;
	});
	function collect(value) {
		if (!value || typeof value !== "object") return;
		if (
			!Array.isArray(value) &&
			typeof value.workspace_id === "string" &&
			typeof value.focused === "boolean"
		)
			workspaces.push(value);
		for (const child of Object.values(value)) collect(child);
	}
	collect(listed.payload);
	const unique = [
		...new Map(workspaces.map((entry) => [entry.workspace_id, entry])).values(),
	];
	return {
		ids: unique.map((entry) => entry.workspace_id).sort(),
		focused: unique.find((entry) => entry.focused)?.workspace_id ?? null,
	};
}

function createRepository(path, label) {
	command("git", ["init", "-q", "-b", "main", path]);
	git(path, "config", "user.name", "Conductor Live Smoke");
	git(path, "config", "user.email", "conductor-live-smoke@example.invalid");
	writeFileSync(join(path, "base.txt"), `${label}\n`);
	git(path, "add", "base.txt");
	command("git", ["-C", path, "commit", "-qm", "deterministic smoke base"], {
		env: {
			...process.env,
			GIT_AUTHOR_DATE: "2026-07-28T00:00:00Z",
			GIT_COMMITTER_DATE: "2026-07-28T00:00:00Z",
		},
	});
	return realpathSync(path);
}

function createWorkspace(repository, label) {
	const result = runHerdr([
		"workspace",
		"create",
		"--cwd",
		repository,
		"--label",
		label,
		"--focus",
	]);
	const workspace = findObject(
		result.payload,
		(value) => typeof value.workspace_id === "string",
	);
	if (!workspace) throw new Error("workspace.create omitted workspace_id");
	return workspace.workspace_id;
}

function focus(workspaceId) {
	runHerdr(["workspace", "focus", workspaceId]);
}

function invoke(actionId, context, expectFailure = false) {
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
		throw new Error(`Herdr omitted the ${actionId} action log id`);
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
		throw new Error(`Herdr ${actionId} action did not finish before timeout`);
	const failed = log.status !== "succeeded" || log.exit_code !== 0;
	if (failed !== expectFailure)
		throw new Error(
			`Herdr ${actionId} ${log.status}; expected ${expectFailure ? "refusal" : "success"}`,
		);
	const output = `${log.stdout ?? ""}\n${log.stderr ?? ""}`.trim();
	if (
		expectFailure &&
		!/state_unknown|bookkeeping_unknown|no active run/i.test(output)
	)
		throw new Error(`${actionId} did not fail closed`);
	return {
		raw: { payload: log, output },
		record: {
			action_id: actionId,
			context,
			log_id_sha256: sha256(log.log_id),
			terminal_status: log.status,
			exit_code: log.exit_code,
			output_sha256: sha256(output),
			result_sha256: sha256(
				canonicalJson({
					status: log.status,
					exit_code: log.exit_code,
					stdout: log.stdout ?? "",
					stderr: log.stderr ?? "",
				}),
			),
		},
	};
}

function treeDigest(path) {
	const entries = [];
	function visit(directory) {
		for (const entry of readdirSync(directory, { withFileTypes: true }).sort(
			(a, b) => a.name.localeCompare(b.name),
		)) {
			const child = join(directory, entry.name);
			if (entry.isDirectory()) visit(child);
			else entries.push([relative(path, child), sha256(readFileSync(child))]);
		}
	}
	visit(path);
	return sha256(canonicalJson(entries));
}

function gitInventory(repository) {
	return sha256(
		canonicalJson({
			head: git(repository, "rev-parse", "HEAD"),
			status: git(repository, "status", "--porcelain", "--untracked-files=all"),
			refs: git(
				repository,
				"for-each-ref",
				"--format=%(refname) %(objectname)",
			),
			worktrees: git(repository, "worktree", "list", "--porcelain"),
		}),
	);
}

function pathDigest(path) {
	return existsSync(path) ? treeDigest(path) : sha256("absent");
}

function exactLiveTuple(writer) {
	const pane = embeddedJson(
		runHerdr(["pane", "get", writer.pane_id]),
		(value) => value.pane_id === writer.pane_id,
	);
	const agent = embeddedJson(
		runHerdr(["agent", "get", writer.agent_name]),
		(value) => value.name === writer.agent_name,
	);
	return sha256(canonicalJson({ pane, agent }));
}

function workspaceKey(workspaceId) {
	return sha256(`herdr-conductor-workspace-v1\0${workspaceId}`);
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

function journalSummary(runDirectory) {
	const entries = readdirSync(join(runDirectory, "operations"))
		.filter((name) => name.endsWith(".json"))
		.sort()
		.map((name) =>
			parseStrictJsonBytes(
				readFileSync(join(runDirectory, "operations", name)),
			),
		);
	return {
		entries: entries.map((entry) => ({
			sequence: entry.sequence,
			operation_type: entry.operation_type,
			entry_digest: entry.entry_digest,
			result_digest: entry.result_digest,
		})),
		head: entries.at(-1)?.entry_digest ?? null,
	};
}

const createdWorkspaces = [];
const stateRecords = [];
const initialWorkspace = workspaceSnapshot();
const initialGlobalInventory = globalIdentityInventory();
const tempRoot = mkdtempSync(join(tmpdir(), "conductor-stage1-b4-"));
const startedAt = new Date().toISOString();
let cleanupComplete = false;

function cleanup() {
	if (cleanupComplete) return;
	for (const workspaceId of createdWorkspaces.toReversed()) {
		try {
			runHerdr(["workspace", "close", workspaceId]);
		} catch (error) {
			process.stderr.write(`cleanup warning: ${error.message}\n`);
		}
	}
	if (initialWorkspace.focused) {
		try {
			focus(initialWorkspace.focused);
		} catch (error) {
			process.stderr.write(`focus restoration warning: ${error.message}\n`);
		}
	}
	for (const record of stateRecords)
		rmSync(record.path, { recursive: true, force: true });
	rmSync(tempRoot, { recursive: true, force: true });
	cleanupComplete = true;
}

try {
	const candidateCommit = git(root, "rev-parse", "HEAD");
	const sourceManifest = parseStrictJsonBytes(readFileSync(sourceManifestPath));
	const currentManifest = buildRuntimeSourceManifest(root);
	const candidateManifest = buildCandidateRuntimeSourceManifest(
		root,
		candidateCommit,
	);
	validateCandidatePreflight({
		status: git(root, "status", "--porcelain", "--untracked-files=all"),
		commit: candidateCommit,
		sourceManifest,
		currentManifest,
	});
	assert.equal(
		canonicalJson(sourceManifest),
		canonicalJson(candidateManifest),
		"candidate Git tree differs from retained source manifest",
	);
	const sourceManifestDigest = validateRuntimeSourceManifest(
		sourceManifest,
		root,
	);
	assert.match(command("herdr", ["--version"]), /^herdr 0\.7\.5$/);
	const serverStatus = command("herdr", ["status", "server"]);
	assert.match(serverStatus, /^status: running$/m);
	assert.match(serverStatus, /^version: 0\.7\.5$/m);
	assert.match(serverStatus, /^protocol: 17$/m);
	const schema = JSON.parse(command("herdr", ["api", "schema", "--json"]));
	assert.deepEqual(
		{ protocol: schema.protocol, schema_version: schema.schema_version },
		{ protocol: 17, schema_version: 1 },
	);
	const pluginList = command("herdr", ["plugin", "list"]);
	assert.match(pluginList, /structupath\.conductor.*enabled.*local:/);
	assert.ok(
		pluginList.includes(root),
		"Conductor is not linked to this checkout",
	);

	const primaryRepository = createRepository(
		join(tempRoot, "primary"),
		"primary",
	);
	const secondRepository = createRepository(join(tempRoot, "second"), "second");
	const stateParent = sharedStateRoot;
	writeFileSync(
		join(primaryRepository, ".herdr-conductor.json"),
		`${JSON.stringify({ version: 1, worktree_root: ".conductor-worktrees", roles: [{ name: "writer", kind: "pi", mode: "write" }] }, null, 2)}\n`,
	);
	const primaryKey = repositoryKey(primaryRepository);
	const secondKey = repositoryKey(secondRepository);
	for (const key of [primaryKey, secondKey]) {
		const path = join(stateParent, "v1", "repositories", key);
		assert.equal(
			existsSync(path),
			false,
			"disposable repository collided with existing private state",
		);
		stateRecords.push({ key, path });
	}

	const primaryWorkspace = createWorkspace(
		primaryRepository,
		"Conductor B4 primary disposable",
	);
	createdWorkspaces.push(primaryWorkspace);
	const sameRepositoryWorkspace = createWorkspace(
		primaryRepository,
		"Conductor B4 same-repo disposable",
	);
	createdWorkspaces.push(sameRepositoryWorkspace);
	const secondRepositoryWorkspace = createWorkspace(
		secondRepository,
		"Conductor B4 second-repo disposable",
	);
	createdWorkspaces.push(secondRepositoryWorkspace);

	const primaryInvocations = [];
	focus(primaryWorkspace);
	const assembledAction = invoke("assemble", "primary");
	primaryInvocations.push(assembledAction.record);
	const assembled = embeddedJson(
		assembledAction.raw,
		(value) =>
			typeof value.run_id === "string" &&
			typeof value.generation === "string" &&
			Array.isArray(value.workers),
	);
	assert.equal(assembled.workers.length, 1);
	const writer = assembled.workers[0];
	assert.equal(writer.role, "writer");
	assert.equal(realpathSync(writer.cwd), writer.cwd);
	const runDirectory = join(
		stateRecords[0].path,
		"workspaces",
		workspaceKey(primaryWorkspace),
		"runs",
		assembled.run_id,
		assembled.generation,
	);
	assert.ok(
		existsSync(runDirectory),
		"workspace environment did not isolate state",
	);

	const boardAction = invoke("board", "primary");
	primaryInvocations.push(boardAction.record);
	const board = embeddedJson(
		boardAction.raw,
		(value) => typeof value.run === "string" && Array.isArray(value.workers),
	);
	assert.equal(board.run, assembled.run_id);
	assert.equal(board.workspace_id, primaryWorkspace);
	assert.equal(board.repository_key, primaryKey);
	assert.equal(board.workers[0].pane, writer.pane_id);
	const statusAction = invoke("status", "primary");
	primaryInvocations.push(statusAction.record);
	assert.match(statusAction.raw.output, new RegExp(`run ${assembled.run_id}`));

	mkdirSync(join(writer.cwd, "retained"), { recursive: true });
	for (const [path, content] of RETAINED_FILES)
		writeFileSync(join(writer.cwd, path), content);
	git(writer.cwd, "add", "retained");
	command(
		"git",
		["-C", writer.cwd, "commit", "-qm", "add retained smoke artifacts"],
		{
			env: {
				...process.env,
				GIT_AUTHOR_DATE: "2026-07-28T00:01:00Z",
				GIT_COMMITTER_DATE: "2026-07-28T00:01:00Z",
			},
		},
	);
	const sourceHead = git(writer.cwd, "rev-parse", "HEAD");
	const writerRef = git(writer.cwd, "symbolic-ref", "-q", "HEAD");
	assert.match(
		writerRef,
		new RegExp(`^refs/heads/conductor/${assembled.run_id}/writer$`),
	);

	const primaryWorkspaceState = join(
		stateRecords[0].path,
		"workspaces",
		workspaceKey(primaryWorkspace),
	);
	const activeDirectory = join(primaryWorkspaceState, "active");
	function authoritySnapshot() {
		const journal = journalSummary(runDirectory);
		const disposableWorkspaces = listObjects(
			"workspace",
			"workspace_id",
		).filter((entry) => createdWorkspaces.includes(entry.workspace_id));
		const disposablePanes = listObjects("pane", "pane_id").filter((entry) =>
			createdWorkspaces.includes(entry.workspace_id),
		);
		const disposableAgents = listObjects("agent", "name").filter((entry) =>
			createdWorkspaces.includes(entry.workspace_id),
		);
		return {
			disposable_workspace_inventory_sha256: sha256(
				canonicalJson(disposableWorkspaces),
			),
			disposable_pane_inventory_sha256: sha256(canonicalJson(disposablePanes)),
			disposable_agent_inventory_sha256: sha256(
				canonicalJson(disposableAgents),
			),
			primary_git_sha256: gitInventory(primaryRepository),
			secondary_git_sha256: gitInventory(secondRepository),
			primary_repository_state_sha256: pathDigest(stateRecords[0].path),
			secondary_repository_state_sha256: pathDigest(stateRecords[1].path),
			workspace_state_sha256: pathDigest(primaryWorkspaceState),
			active_pointer_sha256: pathDigest(activeDirectory),
			pane_tuple_sha256: exactLiveTuple(writer),
			close_count: journal.entries.filter(
				(entry) => entry.operation_type === "pane.close",
			).length,
			cas_count: journal.entries.filter(
				(entry) => entry.operation_type === "git.merge",
			).length,
		};
	}
	const baseline = authoritySnapshot();
	const isolationInvocations = [];
	const probes = [];
	for (const [context, workspaceId] of [
		[ISOLATION_CONTEXTS[0], sameRepositoryWorkspace],
		[ISOLATION_CONTEXTS[1], secondRepositoryWorkspace],
	]) {
		focus(workspaceId);
		for (const actionId of ISOLATION_ACTION_IDS) {
			const before = authoritySnapshot();
			const refused = invoke(actionId, context, true);
			isolationInvocations.push(refused.record);
			const after = authoritySnapshot();
			assert.deepEqual(
				after,
				before,
				`${context} ${actionId} mutated authority`,
			);
			probes.push({ context, action_id: actionId, before, after });
		}
	}

	focus(primaryWorkspace);
	const harvestAction = invoke("harvest", "primary");
	primaryInvocations.push(harvestAction.record);
	const harvest = embeddedJson(
		harvestAction.raw,
		(value) => typeof value.run_id === "string" && Array.isArray(value.merges),
	);
	assert.equal(harvest.run_id, assembled.run_id);
	assert.equal(harvest.workspace_id, primaryWorkspace);
	assert.equal(harvest.merges.length, 1);
	const finalTargetRef = git(primaryRepository, "symbolic-ref", "-q", "HEAD");
	const finalTargetHead = git(primaryRepository, "rev-parse", "HEAD");
	assert.equal(
		git(primaryRepository, "rev-parse", `${finalTargetHead}^2`),
		sourceHead,
	);

	const standDownAction = invoke("stand-down", "primary");
	primaryInvocations.push(standDownAction.record);
	const standDown = embeddedJson(
		standDownAction.raw,
		(value) => value.archived === true && Array.isArray(value.closed),
	);
	assert.deepEqual(standDown.closed, [writer.pane_id]);
	const absentPane = runHerdr(["pane", "get", writer.pane_id], {
		allowFailure: true,
	});
	assert.match(absentPane.output, /pane_not_found|not found/i);
	const runState = JSON.parse(readFileSync(join(runDirectory, "run.json")));
	assert.equal(runState.status, "archived");
	assert.equal(readdirSync(activeDirectory).length, 0);
	assert.equal(git(primaryRepository, "rev-parse", writerRef), sourceHead);
	assert.ok(
		git(primaryRepository, "worktree", "list", "--porcelain").includes(
			`worktree ${writer.cwd}`,
		),
	);
	const retention = [...RETAINED_FILES].map(([path, content]) => {
		assert.equal(readFileSync(join(writer.cwd, path), "utf8"), content);
		return { path, sha256: sha256(content) };
	});
	const journal = journalSummary(runDirectory);
	assert.equal(journal.head, runState.journal_head);
	const mergeEntry = journal.entries.find(
		(entry) => entry.operation_type === "git.merge",
	);
	assert.equal(harvest.merges[0].result_digest, mergeEntry.result_digest);

	cleanup();
	const finalWorkspace = workspaceSnapshot();
	const finalGlobalInventory = globalIdentityInventory();
	const workspaceInventoryRestored =
		JSON.stringify(finalWorkspace.ids) === JSON.stringify(initialWorkspace.ids);
	const focusRestored = finalWorkspace.focused === initialWorkspace.focused;
	const paneInventoryRestored =
		canonicalJson(finalGlobalInventory.pane_ids) ===
		canonicalJson(initialGlobalInventory.pane_ids);
	const agentInventoryRestored =
		canonicalJson(finalGlobalInventory.agent_names) ===
		canonicalJson(initialGlobalInventory.agent_names);
	const stateRecordsAbsent = stateRecords.every(
		(record) => !existsSync(record.path),
	);
	const temporaryRootAbsent = !existsSync(tempRoot);
	assert.equal(
		workspaceInventoryRestored,
		true,
		"workspace inventory was not restored",
	);
	assert.equal(focusRestored, true, "workspace focus was not restored");
	assert.equal(paneInventoryRestored, true, "pane inventory was not restored");
	assert.equal(
		agentInventoryRestored,
		true,
		"agent inventory was not restored",
	);
	assert.equal(stateRecordsAbsent, true, "private state residue remains");
	assert.equal(
		temporaryRootAbsent,
		true,
		"temporary repository residue remains",
	);

	const evidence = {
		document_type: "herdr-conductor-stage1-b4-live-smoke",
		schema_version: 3,
		result: "passed",
		timestamps: {
			started_at: startedAt,
			completed_at: new Date().toISOString(),
		},
		candidate: {
			commit: candidateCommit,
			source_manifest_sha256: sourceManifestDigest,
		},
		herdr: {
			client_version: "0.7.5",
			server_version: "0.7.5",
			protocol: 17,
			schema_version: 1,
		},
		identities: {
			primary_workspace_sha256: sha256(primaryWorkspace),
			same_repository_workspace_sha256: sha256(sameRepositoryWorkspace),
			second_repository_workspace_sha256: sha256(secondRepositoryWorkspace),
			primary_repository_key: primaryKey,
			second_repository_key: secondKey,
			run_id_sha256: sha256(assembled.run_id),
			generation_sha256: sha256(assembled.generation),
			writer_pane_sha256: sha256(writer.pane_id),
		},
		invocations: [...primaryInvocations, ...isolationInvocations],
		isolation: { baseline, probes },
		harvest: {
			writer_ref_sha256: sha256(writerRef),
			source_head: sourceHead,
			target_ref: finalTargetRef,
			final_target_head: finalTargetHead,
			result_digest: harvest.merges[0].result_digest,
			journal_result_digest: mergeEntry.result_digest,
			second_parent_is_source: true,
		},
		stand_down: {
			closed_count: standDown.closed.length,
			close_journal_count: journal.entries.filter(
				(entry) => entry.operation_type === "pane.close",
			).length,
			exact_pane_absent: true,
			run_archived: true,
			active_pointer_absent: true,
		},
		journal: {
			entry_count: journal.entries.length,
			entries: journal.entries,
			head: journal.head,
			chain_summary_sha256: sha256(canonicalJson(journal.entries)),
		},
		retention: {
			writer_branch_observed: true,
			writer_worktree_observed: true,
			files: retention,
		},
		cleanup: {
			closed_workspace_sha256: createdWorkspaces.map(sha256),
			removed_state_record_sha256: stateRecords.map((record) =>
				sha256(`state-record\0${record.key}`),
			),
			prior_disposable_state_record_count_removed: 2,
			temporary_repository_count: 2,
			workspace_inventory_restored: workspaceInventoryRestored,
			pane_inventory_restored: paneInventoryRestored,
			agent_inventory_restored: agentInventoryRestored,
			focus_restored: focusRestored,
			temporary_root_absent: temporaryRootAbsent,
			state_records_absent: stateRecordsAbsent,
			zero_residue:
				workspaceInventoryRestored &&
				paneInventoryRestored &&
				agentInventoryRestored &&
				focusRestored &&
				temporaryRootAbsent &&
				stateRecordsAbsent,
		},
		privacy: {
			sanitized: true,
			operator_observed_local: true,
			remote_attestation: false,
			same_uid_authentication: false,
			excluded: [
				"raw action log identifiers",
				"terminal output",
				"agent transcripts",
				"prompts",
				"environment",
				"socket contents",
				"tokens",
				"private data",
				"filesystem paths",
			],
		},
	};
	evidence.claims_sha256 = sha256(canonicalJson(evidence));
	evidence.human_report_sha256 = sha256(renderEvidenceReport(evidence));
	validateEvidence(evidence, { sourceManifestDigest });
	const report = renderEvidenceReport(evidence);
	writeFileSync(evidenceJsonPath, canonicalJson(evidence));
	writeFileSync(evidenceReportPath, report);
	process.stdout.write(
		canonicalJson({
			result: "passed",
			candidate_commit: candidateCommit,
			source_manifest_sha256: sourceManifestDigest,
			workspace_sha256: createdWorkspaces.map(sha256),
			cleanup_zero_residue: true,
			evidence: [
				relative(root, evidenceJsonPath),
				relative(root, evidenceReportPath),
			],
		}),
	);
} finally {
	cleanup();
}

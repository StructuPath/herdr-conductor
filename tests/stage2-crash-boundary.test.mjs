import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
	mkdtempSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJson } from "../scripts/private-state-schema.mjs";
import {
	PRODUCTION_LITERAL_CHECKPOINTS,
	PRODUCER_PANE_BARRIER_CHECKPOINTS,
	PUBLISHER_CHECKPOINTS,
	STAGE2_CHECKPOINT_CATALOG,
} from "../scripts/stage2-checkpoint-catalog.mjs";
import { openRepositoryStore } from "../scripts/state-kernel.mjs";
import { parseTaskBytes } from "../scripts/task-report-schema.mjs";
import {
	assembledFixture,
	buildWorkerReport,
	git,
	privateDocuments,
	publishWorkerReport,
	assemble,
	config,
	context,
	deterministicRandom,
	FakeHerdr,
	privateStateRoot,
	readStatus,
	repo,
	snapshotTree,
	temp,
} from "./stage1-runtime-helpers.mjs";

const fixtureChild = fileURLToPath(
	new URL("./fixtures/stage2-crash-child.mjs", import.meta.url),
);
const roles = [
	{
		name: "builder",
		contract_role: "builder",
		kind: "codex",
		mode: "write",
	},
];
const gateRole = {
	name: "validator",
	contract_role: "validator",
	kind: "codex",
	mode: "gated",
};
const lifecycleChild = fileURLToPath(
	new URL("./fixtures/b3-crash-child.mjs", import.meta.url),
);
const assembleChild = fileURLToPath(
	new URL("./fixtures/stage1-crash-child.mjs", import.meta.url),
);

function runChild(args, timeoutMs) {
	return new Promise((resolvePromise, rejectPromise) => {
		const child = spawn(process.execPath, args, {
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		let settled = false;
		let timeoutError = null;
		let killGraceTimer = null;
		const onStdout = (bytes) => (stdout += bytes);
		const onStderr = (bytes) => (stderr += bytes);
		const cleanup = () => {
			clearTimeout(timer);
			if (killGraceTimer) clearTimeout(killGraceTimer);
			child.stdout?.off("data", onStdout);
			child.stderr?.off("data", onStderr);
			child.off("close", onClose);
			child.off("error", onError);
		};
		const finish = (callback, value) => {
			if (settled) return;
			settled = true;
			cleanup();
			callback(value);
		};
		const onClose = (status, signal) => {
			if (timeoutError) finish(rejectPromise, timeoutError);
			else finish(resolvePromise, { status, signal, stdout, stderr });
		};
		const onError = (error) => finish(rejectPromise, error);
		const timer = setTimeout(() => {
			timeoutError = new Error(
				`child timed out after ${timeoutMs}ms: ${args.join(" ")}`,
			);
			if (!child.kill("SIGKILL")) {
				finish(rejectPromise, timeoutError);
				return;
			}
			killGraceTimer = setTimeout(
				() => finish(rejectPromise, timeoutError),
				1_000,
			);
		}, timeoutMs);
		child.stdout?.on("data", onStdout);
		child.stderr?.on("data", onStderr);
		child.once("close", onClose);
		child.once("error", onError);
	});
}

test("exported checkpoint catalogs cover every literal production fault call", () => {
	const scripts = fileURLToPath(new URL("../scripts", import.meta.url));
	const sources = readdirSync(scripts)
		.filter(
			(name) =>
				name.endsWith(".mjs") && name !== "stage2-checkpoint-catalog.mjs",
		)
		.map((name) => readFileSync(join(scripts, name), "utf8"));
	const literals = new Set();
	for (const source of sources)
		for (const match of source.matchAll(
			/(?:checkpoint\(fault,\s*|fault\?\.\()"([^"]+)"/g,
		))
			literals.add(match[1]);
	for (const literal of literals)
		assert.ok(
			PRODUCTION_LITERAL_CHECKPOINTS.includes(literal),
			`uncataloged production checkpoint: ${literal}`,
		);
	assert.deepEqual(PRODUCER_PANE_BARRIER_CHECKPOINTS, [
		"producer.after_pane_observed",
	]);
	assert.ok(
		STAGE2_CHECKPOINT_CATALOG.gate_pane.includes("gate.after_panes_observed"),
	);
	for (const [operation, checkpoints] of Object.entries(
		STAGE2_CHECKPOINT_CATALOG,
	)) {
		assert.ok(checkpoints.length > 0, operation);
		assert.equal(new Set(checkpoints).size, checkpoints.length, operation);
	}
});

test("true SIGKILL covers producer pane barrier, lock acquisition, and run activation owners exactly", async () => {
	for (const [owner, boundary] of [
		...STAGE2_CHECKPOINT_CATALOG.producer_pane_barrier.map((name) => [
			"producer_pane_barrier",
			name,
		]),
		...STAGE2_CHECKPOINT_CATALOG.lock_acquisition.map((name) => [
			"lock_acquisition",
			name,
		]),
		...STAGE2_CHECKPOINT_CATALOG.run_activation.map((name) => [
			"run_activation",
			name,
		]),
	]) {
		const repository = repo();
		const stateRoot = privateStateRoot("conductor-stage2-owner-state-");
		const effectsPath = join(
			temp("conductor-stage2-owner-effects-"),
			"effects.log",
		);
		writeFileSync(effectsPath, "");
		const configPath = config(
			repository,
			[{ name: "builder", kind: "codex", mode: "write" }],
			{},
			stateRoot,
		);
		const crashed = await runChild(
			[assembleChild, repository, stateRoot, configPath, effectsPath, boundary],
			20_000,
		);
		assert.equal(crashed.signal, "SIGKILL", `${owner}:${boundary}`);
		const effects = readFileSync(effectsPath, "utf8")
			.trim()
			.split("\n")
			.filter(Boolean);
		assert.equal(
			effects.length,
			owner === "producer_pane_barrier" ? 2 : 0,
			`${owner}:${boundary}: exact effect inventory`,
		);
		const documents = privateDocuments(stateRoot);
		const operationTypes = documents
			.filter(
				({ value }) =>
					value.document_type === "herdr-conductor-operation" &&
					value.phase === "observed",
			)
			.map(({ value }) => value.operation_type);
		assert.deepEqual(
			operationTypes,
			owner === "producer_pane_barrier"
				? ["integration.bind", "worktree.create", "task.publish", "pane.create"]
				: [],
			`${owner}:${boundary}: exact journal inventory`,
		);
		assert.equal(
			documents.filter(
				({ value }) => value.document_type === "herdr-conductor-run",
			).length,
			owner === "lock_acquisition" ? 0 : 1,
			`${owner}:${boundary}: run file inventory`,
		);
		const before = snapshotTree(stateRoot);
		const store = openRepositoryStore({ stateRoot, repoPath: repository });
		if (owner === "lock_acquisition") {
			const fake = new FakeHerdr();
			await assert.rejects(
				() =>
					assemble({
						contextJson: context(repository, "wCrash"),
						configPath,
						herdrBin: "fake",
						exec: fake.exec,
						random: deterministicRandom(50),
					}),
				(error) =>
					error.code ===
					(boundary === "lock.after_owner_publish"
						? "lock_busy"
						: "lock_unknown"),
				`${owner}:${boundary}: exact restart classification`,
			);
			assert.equal(fake.effects, 0, `${owner}:${boundary}: restart effects`);
		} else {
			rmSync(store.lockDir, { recursive: true, force: true });
			const afterLockRemoval = snapshotTree(stateRoot);
			const runtimeExec = (_command, args) => {
				if (args.length === 1 && args[0] === "--version") return "herdr 0.7.5";
				if (args[0] === "api" && args[1] === "schema")
					return JSON.stringify({ protocol: 17, schema_version: 1 });
				throw new Error(`unexpected read-only command: ${args.join(" ")}`);
			};
			if (owner === "run_activation")
				assert.throws(
					() =>
						readStatus({
							contextJson: context(repository, "wCrash"),
							configPath,
							exec: runtimeExec,
						}),
					(error) => error.code === "bookkeeping_unknown",
					`${owner}:${boundary}: exact read-only classification`,
				);
			else {
				const status = readStatus({
					contextJson: context(repository, "wCrash"),
					configPath,
					exec: runtimeExec,
				});
				assert.equal(status.lifecycle, "delivery_provisioning", boundary);
			}
			assert.deepEqual(snapshotTree(stateRoot), afterLockRemoval, boundary);
		}
		if (owner === "lock_acquisition")
			assert.deepEqual(snapshotTree(stateRoot), before, boundary);
	}
});

test("catalog-driven true SIGKILL covers every producer task-publication checkpoint", async () => {
	for (const boundary of STAGE2_CHECKPOINT_CATALOG.task_publication) {
		const repository = repo();
		const targetHead = git(repository, "rev-parse", "HEAD");
		const stateRoot = privateStateRoot("conductor-stage2-task-owner-state-");
		const effectsPath = join(
			temp("conductor-stage2-task-owner-effects-"),
			"effects.log",
		);
		writeFileSync(effectsPath, "");
		const configPath = config(
			repository,
			[{ name: "builder", kind: "codex", mode: "write" }],
			{},
			stateRoot,
		);
		const occurrence = boundary.startsWith("after_directory_create")
			? 17
			: boundary.startsWith("journal")
				? 2
				: 1;
		const crashed = await runChild(
			[
				assembleChild,
				repository,
				stateRoot,
				configPath,
				effectsPath,
				boundary,
				"1",
				String(occurrence),
			],
			20_000,
		);
		assert.equal(crashed.signal, "SIGKILL", `task_publication:${boundary}`);
		const effectsAfterCrash = readFileSync(effectsPath, "utf8");
		const effects = effectsAfterCrash
			.trim()
			.split("\n")
			.filter(Boolean)
			.map(JSON.parse);
		assert.equal(effects.length, 1, `${boundary}: exact effect count`);
		assert.deepEqual(
			effects.map(({ command, args }) => [command, args[2], args[3]]),
			[["git", "worktree", "add"]],
			`${boundary}: exact effect inventory`,
		);
		assert.equal(git(repository, "rev-parse", "HEAD"), targetHead, boundary);
		const branches = git(
			repository,
			"for-each-ref",
			"--format=%(refname):%(objectname)",
			"refs/heads",
		)
			.split("\n")
			.filter(Boolean);
		assert.deepEqual(
			branches,
			[
				`refs/heads/conductor/r-010101010101010101010101/builder:${targetHead}`,
				`refs/heads/main:${targetHead}`,
			],
			`${boundary}: exact ref inventory`,
		);
		const documents = privateDocuments(stateRoot);
		const observedTypes = documents
			.filter(
				({ path, value }) =>
					path.includes("/operations/") &&
					value.document_type === "herdr-conductor-operation" &&
					value.phase === "observed",
			)
			.map(({ value }) => value.operation_type);
		const taskObserved =
			boundary === "journal_result.after_publish" ||
			boundary === "journal_result.after_directory_fsync" ||
			boundary.startsWith("journal_result_head.") ||
			boundary.startsWith("journal_guard_remove.");
		assert.deepEqual(
			observedTypes,
			taskObserved
				? ["integration.bind", "worktree.create", "task.publish"]
				: ["integration.bind", "worktree.create"],
			`${boundary}: exact observed journal inventory`,
		);
		const taskFiles = documents.filter(({ path }) =>
			path.includes("/contracts/tasks/"),
		);
		const taskBytesPublished =
			boundary.startsWith("task_publish.after_") ||
			boundary === "journal.after_effect" ||
			boundary.startsWith("journal_result.") ||
			boundary.startsWith("journal_result_head.") ||
			boundary.startsWith("journal_guard_remove.");
		assert.equal(
			taskFiles.length,
			taskBytesPublished ? 1 : 0,
			`${boundary}: exact task-file inventory`,
		);
		const store = openRepositoryStore({ stateRoot, repoPath: repository });
		rmSync(store.lockDir, { recursive: true, force: true });
		const afterLockRemoval = snapshotTree(stateRoot);
		const runtimeExec = (_command, args) => {
			if (args.length === 1 && args[0] === "--version") return "herdr 0.7.5";
			if (args[0] === "api" && args[1] === "schema")
				return JSON.stringify({ protocol: 17, schema_version: 1 });
			throw new Error(`unexpected read-only command: ${args.join(" ")}`);
		};
		const terminalReadOnly =
			boundary.startsWith("after_directory_create") ||
			boundary === "journal_intent.before_temp_open" ||
			boundary === "journal_guard_remove.after_remove" ||
			boundary === "journal_guard_remove.after_directory_fsync";
		if (terminalReadOnly) {
			const status = readStatus({
				contextJson: context(repository, "wCrash"),
				configPath,
				exec: runtimeExec,
			});
			assert.equal(status.lifecycle, "delivery_provisioning", boundary);
		} else {
			const bookkeepingPrefix =
				boundary === "journal_intent.after_temp_write" ||
				boundary === "journal_intent.after_file_fsync" ||
				boundary === "journal_intent.after_publish" ||
				boundary === "journal_intent.after_directory_fsync" ||
				boundary.startsWith("journal_head.before_") ||
				boundary === "journal_head.after_temp_write" ||
				boundary === "journal_head.after_file_fsync" ||
				boundary === "journal_guard_publish.after_temp_write" ||
				boundary === "journal_guard_publish.after_file_fsync" ||
				boundary === "journal_guard_publish.after_publish";
			assert.throws(
				() =>
					readStatus({
						contextJson: context(repository, "wCrash"),
						configPath,
						exec: runtimeExec,
					}),
				(error) =>
					error.code ===
					(bookkeepingPrefix ? "bookkeeping_unknown" : "recovery_required"),
				`${boundary}: exact read-only classification`,
			);
		}
		assert.deepEqual(snapshotTree(stateRoot), afterLockRemoval, boundary);
		assert.equal(
			readFileSync(effectsPath, "utf8"),
			effectsAfterCrash,
			boundary,
		);
	}
});

function expectedPublisherInventory(boundary, stagingName) {
	const guard = ".publishing.json";
	const orderedStages = [
		["publisher_guard.before_open", []],
		["publisher_guard.after_write", [guard]],
		["publisher_guard.after_file_fsync", [guard]],
		["publisher_guard.after_directory_fsync", [guard]],
		["publisher.before_staging_open", [guard]],
		["publisher.after_staging_write", [guard, stagingName]],
		["publisher.after_staging_fsync", [guard, stagingName]],
		["publisher_payload.before_open", [guard, stagingName]],
		["publisher_payload.after_write", [guard, stagingName, "report.json"]],
		["publisher_payload.after_file_fsync", [guard, stagingName, "report.json"]],
		[
			"publisher_payload.after_directory_fsync",
			[guard, stagingName, "report.json"],
		],
		["publisher_marker.before_open", [guard, stagingName, "report.json"]],
		[
			"publisher_marker.after_write",
			[guard, stagingName, "report.json", "COMMITTED.json"],
		],
		[
			"publisher_marker.after_file_fsync",
			[guard, stagingName, "report.json", "COMMITTED.json"],
		],
		[
			"publisher_marker.after_directory_fsync",
			[guard, stagingName, "report.json", "COMMITTED.json"],
		],
		[
			"publisher.after_staging_unlink",
			[guard, "report.json", "COMMITTED.json"],
		],
		["publisher.after_guard_unlink", ["report.json", "COMMITTED.json"]],
	];
	return orderedStages.find(([name]) => name === boundary)?.[1];
}

for (const boundary of PUBLISHER_CHECKPOINTS) {
	test(`true SIGKILL at ${boundary} never creates accepted report or target CAS`, async () => {
		const fixture = await assembledFixture({ roles });
		const worker = fixture.result.workers[0];
		mkdirSync(join(worker.cwd, "src"));
		writeFileSync(join(worker.cwd, "src", "crash.mjs"), "export default 1;\n");
		git(worker.cwd, "add", "src/crash.mjs");
		git(worker.cwd, "commit", "-qm", "crash fixture");
		const { report } = await buildWorkerReport(fixture, worker);
		const directory = mkdtempSync(join(tmpdir(), "conductor-stage2-crash-"));
		const reportPath = join(directory, "report.json");
		writeFileSync(reportPath, canonicalJson(report));
		const targetBefore = git(fixture.repository, "rev-parse", "HEAD");
		const task = parseTaskBytes(readFileSync(worker.task_path));
		const rawSlot = join(task.outbox.root, task.outbox.slot_name);
		const configPath = join(fixture.repository, ".herdr-conductor.json");
		const child = await runChild(
			[fixtureChild, worker.task_path, configPath, reportPath, boundary],
			10_000,
		);
		assert.equal(child.signal, "SIGKILL", `${boundary}: ${child.stderr}`);
		assert.deepEqual(
			readdirSync(rawSlot).sort(),
			expectedPublisherInventory(
				boundary,
				readdirSync(rawSlot).find((name) => name.startsWith("payload.part-")),
			).sort(),
			boundary,
		);
		assert.equal(git(fixture.repository, "rev-parse", "HEAD"), targetBefore);
		assert.equal(
			privateDocuments(fixture.stateRoot).filter(({ path }) =>
				path.includes("/contracts/reports/"),
			).length,
			0,
		);
		const inventoryAfterCrash = privateDocuments(fixture.stateRoot).map(
			({ path, value }) => [path, value],
		);
		const restart = await runChild(
			[fixtureChild, worker.task_path, configPath, reportPath, "never"],
			10_000,
		);
		assert.equal(restart.status, 1, boundary);
		assert.match(
			restart.stderr,
			/recovery_required:publication_uncertain/,
			boundary,
		);
		assert.deepEqual(
			privateDocuments(fixture.stateRoot).map(({ path, value }) => [
				path,
				value,
			]),
			inventoryAfterCrash,
		);
		assert.equal(git(fixture.repository, "rev-parse", "HEAD"), targetBefore);
	});
}

const lifecycleScenarios = [
	{
		name: "report harvest",
		owner: "report_harvest",
		journalType: "report.harvest",
		faultPrefix: "report.harvest",
		gate: false,
		rejected: false,
		baseEffects: 0,
		effectDelta: 0,
	},
	{
		name: "report reject",
		owner: "report_rejection",
		journalType: "report.reject",
		faultPrefix: "report.harvest",
		gate: false,
		rejected: true,
		baseEffects: 0,
		effectDelta: 0,
	},
	{
		name: "integration reconcile",
		owner: "integration_reconcile",
		journalType: "integration.reconcile",
		faultPrefix: "integration.reconcile",
		gate: false,
		rejected: false,
		baseEffects: 0,
		effectDelta: 1,
	},
	{
		name: "integration harvest",
		owner: "integration_harvest",
		journalType: "integration.harvest",
		faultPrefix: "integration.harvest",
		gate: false,
		rejected: false,
		baseEffects: 1,
		effectDelta: 0,
	},
	{
		name: "gate source",
		owner: "gate_source",
		journalType: "gate-source.create",
		faultPrefix: "gate-source.create",
		gate: true,
		rejected: false,
		baseEffects: 1,
		effectDelta: 1,
	},
	{
		name: "gate task",
		owner: "gate_task",
		journalType: "task.publish",
		faultPrefix: "task.publish",
		gate: true,
		rejected: false,
		baseEffects: 2,
		effectDelta: 0,
	},
	{
		name: "gate pane",
		owner: "gate_pane",
		journalType: "pane.create",
		faultPrefix: "pane.create",
		gate: true,
		rejected: false,
		baseEffects: 2,
		effectDelta: 1,
	},
	{
		name: "gate agent",
		owner: "gate_agent",
		journalType: "agent.start",
		faultPrefix: "agent.start",
		gate: true,
		rejected: false,
		baseEffects: 3,
		effectDelta: 2,
	},
	{
		name: "pane close",
		owner: "pane_close",
		journalType: "pane.close",
		faultPrefix: "pane.close",
		operation: "stand",
		gate: false,
		rejected: false,
		baseEffects: 0,
		effectDelta: 1,
	},
	{
		name: "stand-down begin",
		owner: "stand_down_begin",
		journalType: "run.stand-down.begin",
		faultPrefix: "run.stand-down.begin",
		operation: "stand",
		gate: false,
		rejected: false,
		baseEffects: 0,
		effectDelta: 0,
	},
];

const terminalLifecycle = Object.freeze({
	report_harvest: ["delivery_waiting_reports", "delivery_ready_reconcile"],
	report_rejection: ["delivery_waiting_reports", "delivery_report_rejected"],
	integration_reconcile: [
		"delivery_ready_reconcile",
		"integration_pending_harvest",
	],
	integration_harvest: [
		"integration_pending_harvest",
		"integration_harvested_no_gates",
	],
	gate_source: [
		"gate_source_task_provisioning",
		"gate_source_task_provisioning",
	],
	gate_task: ["gate_source_task_provisioning", "gate_agent_provisioning"],
	gate_pane: ["gate_agent_provisioning", "gate_agent_provisioning"],
	gate_agent: ["gate_agent_provisioning", "gate_waiting_reports"],
	pane_close: ["abandoned_closing", "stand_down_ready_archive"],
	stand_down_begin: ["delivery_waiting_reports", "abandoned_closing"],
});

const lifecycleCrashCases = lifecycleScenarios.flatMap((scenario) =>
	STAGE2_CHECKPOINT_CATALOG[scenario.owner].map((boundary) => ({
		scenario,
		boundary,
	})),
);
for (const scenario of lifecycleScenarios)
	assert.deepEqual(
		lifecycleCrashCases
			.filter((entry) => entry.scenario === scenario)
			.map(({ boundary }) => boundary),
		STAGE2_CHECKPOINT_CATALOG[scenario.owner],
		scenario.owner,
	);

for (const { scenario, boundary } of lifecycleCrashCases)
	test(`true SIGKILL ${scenario.name} ${boundary} has exact retained-authority classification`, async () => {
		const fixture = await assembledFixture({
			roles: scenario.gate ? [...roles, gateRole] : roles,
		});
		const worker = fixture.result.workers[0];
		mkdirSync(join(worker.cwd, "src"));
		writeFileSync(
			join(worker.cwd, "src", "lifecycle-crash.mjs"),
			"export default 1;\n",
		);
		git(worker.cwd, "add", "src/lifecycle-crash.mjs");
		git(worker.cwd, "commit", "-qm", "lifecycle crash fixture");
		await publishWorkerReport(
			fixture,
			worker,
			scenario.rejected ? { changed_paths: [] } : {},
		);
		const directory = mkdtempSync(
			join(tmpdir(), "conductor-stage2-lifecycle-kill-"),
		);
		const livePath = join(directory, "live.json");
		const effectsPath = join(directory, "effects.log");
		writeFileSync(
			livePath,
			JSON.stringify({
				panes: {
					...Object.fromEntries(fixture.fake.panes),
					[`${fixture.workspace}:p0`]: {
						workspace_id: fixture.workspace,
						pane_id: `${fixture.workspace}:p0`,
					},
				},
				agents: Object.fromEntries(fixture.fake.agents),
			}),
		);
		writeFileSync(effectsPath, "");
		const directBarrier = boundary === "gate.after_panes_observed";
		const fault = directBarrier
			? boundary
			: `${scenario.faultPrefix}:${boundary}`;
		const args = [
			lifecycleChild,
			scenario.operation ?? (scenario.rejected ? "reject" : "lifecycle"),
			fixture.repository,
			fixture.stateRoot,
			fixture.workspace,
			livePath,
			effectsPath,
			fault,
		];
		const crashed = await runChild(args, 20_000);
		assert.equal(crashed.signal, "SIGKILL", `${fault}: ${crashed.stderr}`);
		const effectsAfterCrash = readFileSync(effectsPath, "utf8");
		const effectCount = effectsAfterCrash.trim()
			? effectsAfterCrash.trim().split("\n").length
			: 0;
		const afterEffect =
			boundary === "journal.after_effect" ||
			boundary.startsWith("journal_result.") ||
			boundary.startsWith("journal_result_head.") ||
			boundary.startsWith("journal_guard_remove.") ||
			boundary === "integration.after_cas" ||
			boundary === "integration.before_sync" ||
			boundary === "integration.during_sync" ||
			boundary === "integration.before_observed_publication" ||
			directBarrier;
		assert.equal(
			effectCount,
			scenario.baseEffects + (afterEffect ? scenario.effectDelta : 0),
			fault,
		);
		const documentsAfterCrash = privateDocuments(fixture.stateRoot);
		const operationDocuments = documentsAfterCrash.filter(
			({ value }) =>
				value.operation_type === scenario.journalType &&
				(!scenario.gate || value.subject?.id === gateRole.name),
		);
		const preIntent =
			(scenario.owner === "gate_task" &&
				boundary.startsWith("after_directory_create")) ||
			boundary === "journal_intent.before_temp_open" ||
			boundary === "journal_intent.after_temp_write" ||
			boundary === "journal_intent.after_file_fsync";
		assert.equal(operationDocuments.length > 0, !preIntent, fault);
		if (!preIntent) {
			const retainedResult = operationDocuments.find(({ path }) =>
				path.includes("/operations/"),
			);
			assert.ok(retainedResult, fault);
			const observed =
				boundary === "journal_result.after_publish" ||
				boundary === "journal_result.after_directory_fsync" ||
				boundary.startsWith("journal_result_head.") ||
				boundary.startsWith("journal_guard_remove.") ||
				directBarrier;
			assert.equal(
				retainedResult.value.phase,
				observed ? "observed" : "intent",
				fault,
			);
		}
		const store = openRepositoryStore({
			stateRoot: fixture.stateRoot,
			repoPath: fixture.repository,
		});
		rmSync(store.lockDir, { recursive: true, force: true });
		const authorityBeforeStatus = privateDocuments(fixture.stateRoot);
		const status = await runChild(
			[lifecycleChild, "status", ...args.slice(2, -1), "never"],
			20_000,
		);
		const terminalReadOnly =
			(scenario.owner === "gate_task" &&
				boundary.startsWith("after_directory_create")) ||
			boundary === "journal_intent.before_temp_open" ||
			boundary === "journal_guard_remove.after_remove" ||
			boundary === "journal_guard_remove.after_directory_fsync" ||
			directBarrier;
		const bookkeepingPrefix =
			boundary === "journal_intent.after_temp_write" ||
			boundary === "journal_intent.after_file_fsync" ||
			boundary === "journal_intent.after_publish" ||
			boundary === "journal_intent.after_directory_fsync" ||
			boundary.startsWith("journal_head.before_") ||
			boundary === "journal_head.after_temp_write" ||
			boundary === "journal_head.after_file_fsync" ||
			boundary === "journal_guard_publish.after_temp_write" ||
			boundary === "journal_guard_publish.after_file_fsync" ||
			boundary === "journal_guard_publish.after_publish";
		if (terminalReadOnly) {
			assert.equal(status.status, 0, `${fault}: read-only status`);
			const payload = JSON.parse(status.stdout);
			const observed =
				boundary === "journal_guard_remove.after_remove" ||
				boundary === "journal_guard_remove.after_directory_fsync" ||
				directBarrier;
			assert.equal(
				payload.lifecycle,
				terminalLifecycle[scenario.owner][observed ? 1 : 0],
				`${fault}: exact read-only lifecycle`,
			);
		} else {
			const expectedCode = bookkeepingPrefix
				? "bookkeeping_unknown"
				: "recovery_required";
			assert.equal(status.status, 1, `${fault}: read-only status exit`);
			assert.equal(
				status.stderr.split(":", 1)[0],
				expectedCode,
				`${fault}: retained-authority classification`,
			);
		}
		assert.equal(readFileSync(effectsPath, "utf8"), effectsAfterCrash, fault);
		assert.deepEqual(
			privateDocuments(fixture.stateRoot),
			authorityBeforeStatus,
			fault,
		);
	});

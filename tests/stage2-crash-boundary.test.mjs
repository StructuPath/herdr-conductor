import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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
	GATE_TASK_CHECKPOINTS,
	INTEGRATION_RECONCILE_CHECKPOINTS,
	JOURNALED_OPERATION_CHECKPOINTS,
	PRODUCTION_LITERAL_CHECKPOINTS,
	PRODUCER_PANE_BARRIER_CHECKPOINTS,
	PUBLISHER_CHECKPOINTS,
	REPORT_HARVEST_CHECKPOINTS,
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
		const child = spawnSync(
			process.execPath,
			[fixtureChild, worker.task_path, configPath, reportPath, boundary],
			{ encoding: "utf8", timeout: 10_000 },
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
		const restart = spawnSync(
			process.execPath,
			[fixtureChild, worker.task_path, configPath, reportPath, "never"],
			{ encoding: "utf8", timeout: 10_000 },
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
];

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
		const crashed = spawnSync(process.execPath, args, {
			encoding: "utf8",
			timeout: 20_000,
		});
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
		const status = spawnSync(
			process.execPath,
			[lifecycleChild, "status", ...args.slice(2, -1), "never"],
			{ encoding: "utf8", timeout: 20_000 },
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
			assert.doesNotThrow(() => JSON.parse(status.stdout), fault);
		} else {
			const expectedCode = bookkeepingPrefix
				? "bookkeeping_unknown"
				: "recovery_required";
			assert.equal(status.status, 1, `${fault}: read-only status exit`);
			assert.match(
				status.stderr,
				new RegExp(`^${expectedCode}:`),
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

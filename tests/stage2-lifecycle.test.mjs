import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	classifyCleanDelivery,
	classifyCleanGates,
	classifyStandDownPrefix,
	scanStage2Authority,
	standDownReasonForState,
} from "../scripts/stage2-lifecycle.mjs";
import {
	canonicalJson,
	StateKernelError,
} from "../scripts/private-state-schema.mjs";
import {
	deriveRetainedReportAuthority,
	reconcile,
} from "../scripts/stage1-runtime.mjs";
import { harvestCommittedReport } from "../scripts/report-harvest.mjs";
import {
	loadActiveRun,
	openRepositoryStore,
} from "../scripts/state-kernel.mjs";
import {
	acquireRepositoryLock,
	releaseRepositoryLock,
} from "../scripts/state-internal.mjs";
import {
	parseReportBytes,
	parseTaskBytes,
	reportDigest,
	taskDigest,
} from "../scripts/task-report-schema.mjs";
import {
	assembledFixture,
	context,
	git,
	privateDocuments,
	publishWorkerReport,
} from "./stage1-runtime-helpers.mjs";

const producer = (name, prefix, report = null, reportRejected = false) => ({
	name,
	source: prefix >= 1,
	task: prefix >= 2,
	pane: prefix >= 3,
	agent: prefix >= 4,
	report:
		prefix >= 5
			? (report ?? {
					status: "completed",
					result: { kind: "delivery", verdict: "delivered" },
				})
			: null,
	reportRejected,
});
const gate = (name, prefix, report = null, sourceRefused = false) => ({
	name,
	source: prefix >= 1,
	task: prefix >= 2,
	pane: prefix >= 3,
	agent: prefix >= 4,
	report:
		prefix >= 5
			? (report ?? {
					status: "completed",
					result: { kind: "validation", verdict: "pass" },
				})
			: null,
	sourceRefused,
});
function code(expected, fn) {
	assert.throws(
		fn,
		(error) => error instanceof StateKernelError && error.code === expected,
	);
}

test("delivery states cover empty, every clean prefix, failures, and observed rejection", () => {
	assert.equal(classifyCleanDelivery([]), "delivery_ready_reconcile");
	assert.equal(
		classifyCleanDelivery([producer("a", 0)]),
		"delivery_provisioning",
	);
	assert.equal(
		classifyCleanDelivery([producer("a", 4)]),
		"delivery_waiting_reports",
	);
	assert.equal(
		classifyCleanDelivery([producer("a", 5)]),
		"delivery_ready_reconcile",
	);
	assert.equal(
		classifyCleanDelivery([
			producer("a", 5, { status: "blocked", result: null }),
		]),
		"delivery_nonprogressable",
	);
	assert.equal(
		classifyCleanDelivery([{ ...producer("a", 4), reportRejected: true }]),
		"delivery_report_rejected",
	);
	code("bookkeeping_unknown", () =>
		classifyCleanDelivery([{ ...producer("a", 2), pane: false, agent: true }]),
	);
});

test("gate states enforce all-task and all-agent barriers", () => {
	assert.equal(classifyCleanGates([]), "integration_harvested_no_gates");
	assert.equal(
		classifyCleanGates([gate("v", 0)]),
		"gate_source_task_provisioning",
	);
	assert.equal(classifyCleanGates([gate("v", 2)]), "gate_agent_provisioning");
	assert.equal(classifyCleanGates([gate("v", 4)]), "gate_waiting_reports");
	assert.equal(classifyCleanGates([gate("v", 5)]), "gate_reports_collected");
	assert.equal(
		classifyCleanGates([{ ...gate("v", 4), sourceRefused: true }]),
		"gate_source_refused",
	);
	code("bookkeeping_unknown", () =>
		classifyCleanGates([gate("a", 3), gate("b", 1)]),
	);
});

test("uncertainty outranks clean state and stand-down covers every close prefix", () => {
	assert.equal(
		scanStage2Authority(null, null, {
			facts: {
				producers: [producer("a", 5)],
				gates: [],
				reconciliation: null,
				integrationHarvest: null,
				uncertainty: "publication_uncertain",
			},
		}).state,
		"publication_uncertain",
	);
	assert.equal(
		classifyStandDownPrefix({
			outcome: "abandoned",
			closeSet: [{ id: "a" }, { id: "b" }],
			closes: [],
		}).state,
		"abandoned_closing",
	);
	assert.equal(
		classifyStandDownPrefix({
			outcome: "completed",
			closeSet: [{ id: "a" }],
			closes: ["a"],
		}).state,
		"stand_down_ready_archive",
	);
	code("bookkeeping_unknown", () =>
		classifyStandDownPrefix({
			outcome: "abandoned",
			closeSet: [{ id: "a" }, { id: "b" }],
			closes: ["b"],
		}),
	);
});

test("stand-down reasons map only to their approved lifecycle states", () => {
	const approved = [
		["report_rejected", "delivery_report_rejected"],
		["normal_completion", "integration_harvested_no_gates"],
		["normal_completion", "gate_reports_collected"],
		["nonprogressable_delivery", "delivery_nonprogressable"],
		["source_policy_refusal", "gate_source_refused"],
		["clean_provisioning_failure", "delivery_provisioning"],
		["clean_provisioning_failure", "gate_source_task_provisioning"],
		["clean_provisioning_failure", "gate_agent_provisioning"],
		["missing_report", "delivery_waiting_reports"],
		["missing_report", "gate_waiting_reports"],
	];
	for (const [reason, state] of approved)
		assert.equal(standDownReasonForState(state, reason), reason);
	const invalidState = {
		report_rejected: "delivery_waiting_reports",
		normal_completion: "delivery_provisioning",
		nonprogressable_delivery: "delivery_waiting_reports",
		source_policy_refusal: "delivery_waiting_reports",
		clean_provisioning_failure: "gate_reports_collected",
		missing_report: "gate_agent_provisioning",
	};
	for (const [reason] of approved)
		code("bookkeeping_unknown", () =>
			standDownReasonForState(invalidState[reason], reason),
		);
	for (const state of [
		"delivery_provisioning",
		"delivery_waiting_reports",
		"delivery_ready_reconcile",
		"delivery_nonprogressable",
		"delivery_report_rejected",
		"integration_pending_harvest",
		"integration_harvested_no_gates",
		"gate_source_task_provisioning",
		"gate_agent_provisioning",
		"gate_waiting_reports",
		"gate_reports_collected",
		"gate_source_refused",
	])
		assert.equal(
			standDownReasonForState(state, "operator_abandoned"),
			"operator_abandoned",
		);
});

test("role-symmetric cardinalities 0 through 64 and every stand-down prefix classify exactly once", () => {
	for (let count = 0; count <= 64; count++) {
		const names = Array.from(
			{ length: count },
			(_, index) => `role-${index.toString().padStart(2, "0")}`,
		);
		for (let prefix = 0; prefix <= 5; prefix++) {
			const producers = names.map((name) => producer(name, prefix));
			const expectedDelivery =
				count === 0 || prefix === 5
					? "delivery_ready_reconcile"
					: prefix === 4
						? "delivery_waiting_reports"
						: "delivery_provisioning";
			assert.equal(classifyCleanDelivery(producers), expectedDelivery);
			assert.equal(
				classifyCleanDelivery([...producers].reverse()),
				expectedDelivery,
			);
			const gates = names.map((name) => gate(name, prefix));
			const expectedGate =
				count === 0
					? "integration_harvested_no_gates"
					: prefix <= 1
						? "gate_source_task_provisioning"
						: prefix <= 3
							? "gate_agent_provisioning"
							: prefix === 4
								? "gate_waiting_reports"
								: "gate_reports_collected";
			assert.equal(classifyCleanGates(gates), expectedGate);
			assert.equal(classifyCleanGates([...gates].reverse()), expectedGate);
		}
		const closeSet = names.map((id) => ({ id }));
		for (let prefix = 0; prefix <= count; prefix++) {
			const classified = classifyStandDownPrefix({
				outcome: "abandoned",
				closeSet,
				closes: names.slice(0, prefix),
			});
			assert.equal(
				classified.state,
				prefix === count ? "stand_down_ready_archive" : "abandoned_closing",
			);
			assert.equal(classified.closed, prefix);
		}
	}
});

function independentOracle({
	phase,
	roles,
	prefixes,
	outcomes,
	rejected,
	refused,
}) {
	if (phase === "uncertain") return "operation_uncertain";
	if (phase === "archive_uncertain") return "archive_uncertain";
	if (phase === "archived") return "archived";
	if (phase === "integration_pending") return "integration_pending_harvest";
	const relevant = roles
		.map((role, index) => ({
			...role,
			prefix: prefixes[index],
			outcome: outcomes[index],
			rejected: rejected.has(role.name),
			refused: refused.has(role.name),
		}))
		.filter(({ contract_role: kind }) =>
			phase === "delivery"
				? kind === "builder" || kind === "test_author"
				: kind === "reviewer" || kind === "validator",
		);
	const reportCount = relevant.filter(({ prefix }) => prefix === 5).length;
	const missingAgent = relevant.some(({ prefix }) => prefix < 4);
	if (phase === "delivery") {
		if (relevant.some(({ rejected: value }) => value)) {
			if (reportCount > 0) return "invalid";
			return "delivery_report_rejected";
		}
		if (relevant.some(({ refused: value }) => value)) return "invalid";
		if (reportCount > 0 && missingAgent) return "invalid";
		if (reportCount === 0 && missingAgent)
			return relevant.length === 0
				? "delivery_ready_reconcile"
				: "delivery_provisioning";
		if (reportCount < relevant.length) return "delivery_waiting_reports";
		return relevant.every(({ outcome }) => outcome === "delivered")
			? "delivery_ready_reconcile"
			: "delivery_nonprogressable";
	}
	if (relevant.length === 0) return "integration_harvested_no_gates";
	if (
		relevant.some(
			({ refused: value, rejected: rejection }) => value || rejection,
		)
	)
		return "gate_source_refused";
	if (relevant.some(({ prefix }) => prefix < 2)) {
		if (relevant.some(({ prefix }) => prefix > 2)) return "invalid";
		return "gate_source_task_provisioning";
	}
	if (missingAgent) {
		if (reportCount > 0) return "invalid";
		return "gate_agent_provisioning";
	}
	return reportCount < relevant.length
		? "gate_waiting_reports"
		: "gate_reports_collected";
}

test("real production task publication, bounded publisher, harvester, accepted copy, and journal drive every mixed 0..64 delivery class", async () => {
	const configuredRoles = Array.from({ length: 64 }, (_, index) => ({
		name: `role-${index.toString().padStart(2, "0")}`,
		contract_role: index % 2 ? "test_author" : "builder",
		kind: "codex",
		mode: "write",
	}));
	const fixture = await assembledFixture({ roles: configuredRoles });
	for (const [index, worker] of fixture.result.workers.entries())
		await publishWorkerReport(
			fixture,
			worker,
			index % 2 ? { status: "blocked", result: null } : {},
		);
	const harvested = await reconcile({
		contextJson: context(fixture.repository, fixture.workspace),
		herdrBin: "fake",
		exec: fixture.fake.exec,
	});
	assert.equal(harvested.lifecycle, "delivery_nonprogressable");
	const production = loadActiveRun(
		openRepositoryStore({
			stateRoot: fixture.stateRoot,
			repoPath: fixture.repository,
		}),
		{ workspaceId: fixture.workspace },
	);
	const reportOutcome = Object.fromEntries(
		Object.entries(
			deriveRetainedReportAuthority(production, fixture.stateRoot),
		).map(([name, report]) => [
			name,
			report.status === "blocked" ? "blocked" : "delivered",
		]),
	);
	const sequence = [
		"worktree.create",
		"task.publish",
		"pane.create",
		"agent.start",
		"report.harvest",
	];
	const prefixPairs = [
		[0, 0],
		[1, 2],
		[2, 4],
		[4, 5],
		[5, 4],
		[5, 5],
	];
	const authorityCache = new Map();
	let vectors = 0;
	for (let count = 0; count <= 64; count++) {
		const selections = [
			configuredRoles.slice(0, count),
			configuredRoles.slice(64 - count),
		];
		for (const roles of selections)
			for (const [leftPrefix, rightPrefix] of prefixPairs)
				for (const split of new Set([
					0,
					1,
					Math.floor(count / 2),
					count - 1,
					count,
				])) {
					if (split < 0 || split > count) continue;
					const selected = new Map(
						roles.map((role, index) => [role.name, index]),
					);
					const prefixes = roles.map((_, index) =>
						index < split ? leftPrefix : rightPrefix,
					);
					const journal = production.journal.filter((entry) => {
						if (entry.operation_type === "integration.bind") return true;
						const index = selected.get(entry.subject.id);
						if (index === undefined) return false;
						const operationIndex = sequence.indexOf(entry.operation_type);
						return operationIndex >= 0 && operationIndex < prefixes[index];
					});
					const active = { ...production, journal };
					const outcomes = roles.map(({ name }) => reportOutcome[name]);
					const expected = independentOracle({
						phase: "delivery",
						roles,
						prefixes,
						outcomes,
						rejected: new Set(),
						refused: new Set(),
					});
					const scan = () => {
						const authorityKey = roles
							.filter((_, index) => prefixes[index] === 5)
							.map(({ name }) => name)
							.join("\0");
						let acceptedReports = authorityCache.get(authorityKey);
						if (!acceptedReports) {
							acceptedReports = deriveRetainedReportAuthority(
								active,
								fixture.stateRoot,
							);
							authorityCache.set(authorityKey, acceptedReports);
						}
						return scanStage2Authority(active, { roles }, { acceptedReports })
							.state;
					};
					if (expected === "invalid") code("bookkeeping_unknown", scan);
					else
						assert.equal(
							scan(),
							expected,
							`${count}:${leftPrefix}:${rightPrefix}:${split}`,
						);
					vectors++;
				}
	}
	assert.ok(
		vectors > 3_000,
		`production oracle covered only ${vectors} vectors`,
	);
});

test("real production gate publication and harvesting drive every reduced gate class at bounded symmetric cardinalities", async () => {
	// Gate provisioning creates and seals one detached Git source per role. The
	// 0..64 classifier matrix above proves cardinality symmetry; these bounded
	// production representatives exercise every mixed prefix/outcome class
	// without turning the required repeated Stage 2 gate into a 15+ minute test.
	const configuredRoles = Array.from({ length: 8 }, (_, index) => ({
		name: `gate-${index.toString().padStart(2, "0")}`,
		contract_role: index % 2 ? "validator" : "reviewer",
		kind: "codex",
		mode: index % 2 ? "gated" : "read-only",
	}));
	const fixture = await assembledFixture({ roles: configuredRoles });
	const provisioned = await reconcile({
		contextJson: context(fixture.repository, fixture.workspace),
		herdrBin: "fake",
		exec: fixture.fake.exec,
	});
	assert.equal(provisioned.gate_workers.length, configuredRoles.length);
	for (const [index, worker] of provisioned.gate_workers.entries())
		await publishWorkerReport(
			fixture,
			worker,
			index % 2 ? { status: "blocked", result: null } : {},
		);
	const store = openRepositoryStore({
		stateRoot: fixture.stateRoot,
		repoPath: fixture.repository,
	});
	const lock = acquireRepositoryLock(store, {
		operationId: "oracle-gate-report-harvest",
	});
	const beforeHarvest = loadActiveRun(store, {
		workspaceId: fixture.workspace,
	});
	const configurationDigest = createHash("sha256")
		.update(
			canonicalJson(
				JSON.parse(
					readFileSync(
						join(fixture.repository, ".herdr-conductor.json"),
						"utf8",
					),
				),
			),
		)
		.digest("hex");
	try {
		for (const worker of provisioned.gate_workers)
			await harvestCommittedReport(lock, {
				workspaceId: fixture.workspace,
				runId: beforeHarvest.state.run_id,
				runGeneration: beforeHarvest.state.generation,
				taskPath: worker.task_path,
				configurationDigest,
				inspectSource: ({ task }) => ({
					observation: { production_oracle_role: task.role.name },
				}),
			});
	} finally {
		releaseRepositoryLock(lock);
	}
	const production = loadActiveRun(store, { workspaceId: fixture.workspace });
	const reportOutcome = Object.fromEntries(
		Object.entries(
			deriveRetainedReportAuthority(production, fixture.stateRoot),
		).map(([name, report]) => [
			name,
			report.status === "blocked" ? "fail" : "pass",
		]),
	);
	const sequence = [
		"gate-source.create",
		"task.publish",
		"pane.create",
		"agent.start",
		"report.harvest",
	];
	const prefixPairs = [
		[0, 0],
		[1, 2],
		[2, 4],
		[4, 5],
		[5, 4],
		[5, 5],
	];
	const authorityCache = new Map();
	let vectors = 0;
	for (const count of [0, 1, 2, 4, configuredRoles.length]) {
		const selections = [
			configuredRoles.slice(0, count),
			configuredRoles.slice(configuredRoles.length - count),
		];
		for (const roles of selections)
			for (const [leftPrefix, rightPrefix] of prefixPairs)
				for (const split of new Set([
					0,
					1,
					Math.floor(count / 2),
					count - 1,
					count,
				])) {
					if (split < 0 || split > count) continue;
					const selected = new Map(
						roles.map((role, index) => [role.name, index]),
					);
					const prefixes = roles.map((_, index) =>
						index < split ? leftPrefix : rightPrefix,
					);
					const journal = production.journal.filter((entry) => {
						if (
							[
								"integration.bind",
								"integration.reconcile",
								"integration.harvest",
							].includes(entry.operation_type)
						)
							return true;
						const index = selected.get(entry.subject.id);
						if (index === undefined) return false;
						const operationIndex = sequence.indexOf(entry.operation_type);
						return operationIndex >= 0 && operationIndex < prefixes[index];
					});
					const active = { ...production, journal };
					const outcomes = roles.map(({ name }) => reportOutcome[name]);
					const expected = independentOracle({
						phase: "gates",
						roles,
						prefixes,
						outcomes,
						rejected: new Set(),
						refused: new Set(),
					});
					const scan = () => {
						const authorityKey = roles
							.filter((_, index) => prefixes[index] === 5)
							.map(({ name }) => name)
							.join("\0");
						let acceptedReports = authorityCache.get(authorityKey);
						if (!acceptedReports) {
							acceptedReports = deriveRetainedReportAuthority(
								active,
								fixture.stateRoot,
							);
							authorityCache.set(authorityKey, acceptedReports);
						}
						return scanStage2Authority(active, { roles }, { acceptedReports })
							.state;
					};
					if (expected === "invalid") code("bookkeeping_unknown", scan);
					else
						assert.equal(
							scan(),
							expected,
							`${count}:${leftPrefix}:${rightPrefix}:${split}`,
						);
					vectors++;
				}
	}
	assert.ok(
		vectors >= 192,
		`production gate oracle covered only ${vectors} vectors`,
	);
});

test("production journal-to-path retained authority strictly parses real report bytes", async () => {
	const fixture = await assembledFixture();
	const worker = fixture.result.workers[0];
	mkdirSync(join(worker.cwd, "src"));
	writeFileSync(
		join(worker.cwd, "src", "authority.mjs"),
		"export default 1;\n",
	);
	git(worker.cwd, "add", "src/authority.mjs");
	git(worker.cwd, "commit", "-qm", "authority fixture");
	await publishWorkerReport(fixture, worker);
	await reconcile({
		contextJson: context(fixture.repository, fixture.workspace),
		herdrBin: "fake",
		exec: fixture.fake.exec,
	});
	const active = loadActiveRun(
		openRepositoryStore({
			stateRoot: fixture.stateRoot,
			repoPath: fixture.repository,
		}),
		{ workspaceId: fixture.workspace },
	);
	assert.equal(
		deriveRetainedReportAuthority(active, fixture.stateRoot).builder.role.name,
		"builder",
	);
	for (const mutate of [
		(entry) => (entry.subject.id = "../escape"),
		(entry) => (entry.subject.generation = "f".repeat(32)),
	]) {
		const journal = structuredClone(active.journal);
		const entry = journal.find(
			(value) => value.operation_type === "report.harvest",
		);
		mutate(entry);
		assert.throws(() =>
			deriveRetainedReportAuthority({ ...active, journal }, fixture.stateRoot),
		);
	}
	const documents = privateDocuments(fixture.stateRoot);
	const taskFile = documents.find(({ path }) =>
		path.includes("/contracts/tasks/"),
	);
	const accepted = documents.find(({ path }) =>
		path.includes("/contracts/reports/"),
	);
	const taskBytes = readFileSync(taskFile.path);
	const reportBytes = readFileSync(accepted.path);
	for (const [label, path, corrupted] of [
		["malformed task", taskFile.path, Buffer.from("{malformed")],
		[
			"noncanonical task",
			taskFile.path,
			Buffer.concat([taskBytes, Buffer.from("\n")]),
		],
		["malformed report", accepted.path, Buffer.from("{malformed")],
		[
			"noncanonical report",
			accepted.path,
			Buffer.concat([reportBytes, Buffer.from("\n")]),
		],
	]) {
		const original = readFileSync(path);
		writeFileSync(path, corrupted);
		assert.throws(
			() => deriveRetainedReportAuthority(active, fixture.stateRoot),
			undefined,
			label,
		);
		writeFileSync(path, original);
	}
	for (const [label, path] of [
		["missing task path", taskFile.path],
		["missing report path", accepted.path],
	]) {
		const moved = `${path}.missing`;
		renameSync(path, moved);
		assert.throws(
			() => deriveRetainedReportAuthority(active, fixture.stateRoot),
			undefined,
			label,
		);
		renameSync(moved, path);
	}
	const originalTask = parseTaskBytes(taskBytes);
	for (const [label, mutate] of [
		["task generation", (task) => (task.task_generation = "e".repeat(32))],
		["task digest", (task) => (task.task_id = "other-task")],
	]) {
		const changed = structuredClone(originalTask);
		mutate(changed);
		delete changed.task_digest;
		changed.task_digest = taskDigest(changed);
		writeFileSync(taskFile.path, canonicalJson(changed));
		assert.throws(
			() => deriveRetainedReportAuthority(active, fixture.stateRoot),
			undefined,
			label,
		);
		writeFileSync(taskFile.path, taskBytes);
	}
	const originalReport = parseReportBytes(reportBytes, { task: originalTask });
	const crossRole = structuredClone(originalReport);
	crossRole.role.name = "other-role";
	delete crossRole.report_digest;
	crossRole.report_digest = reportDigest(crossRole);
	writeFileSync(accepted.path, canonicalJson(crossRole));
	assert.throws(
		() => deriveRetainedReportAuthority(active, fixture.stateRoot),
		undefined,
		"cross-role report",
	);
	writeFileSync(accepted.path, reportBytes);
	for (const operationType of ["task.publish", "report.harvest"]) {
		const journal = structuredClone(active.journal);
		journal.push(
			structuredClone(
				journal.find((entry) => entry.operation_type === operationType),
			),
		);
		assert.throws(
			() =>
				deriveRetainedReportAuthority(
					{ ...active, journal },
					fixture.stateRoot,
				),
			undefined,
			`duplicate ${operationType}`,
		);
	}
});

test("integration transitions are disjoint and terminal archive wins", () => {
	const ready = {
		producers: [producer("a", 5)],
		gates: [],
		uncertainty: null,
		standDown: null,
		archived: false,
		archiveUncertain: false,
	};
	assert.equal(
		scanStage2Authority(null, null, {
			facts: { ...ready, reconciliation: null, integrationHarvest: null },
		}).state,
		"delivery_ready_reconcile",
	);
	assert.equal(
		scanStage2Authority(null, null, {
			facts: {
				...ready,
				reconciliation: { observed: true },
				integrationHarvest: null,
			},
		}).state,
		"integration_pending_harvest",
	);
	assert.equal(
		scanStage2Authority(null, null, {
			facts: {
				...ready,
				reconciliation: { observed: true },
				integrationHarvest: { observed: true },
			},
		}).state,
		"integration_harvested_no_gates",
	);
	assert.equal(
		scanStage2Authority(null, null, {
			facts: {
				...ready,
				archived: true,
				reconciliation: null,
				integrationHarvest: null,
			},
		}).state,
		"archived",
	);
});

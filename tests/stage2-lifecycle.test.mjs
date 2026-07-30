import test from "node:test";
import assert from "node:assert/strict";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
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
	validateJournalEntry,
} from "../scripts/private-state-schema.mjs";
import {
	deriveRetainedReportAuthority,
	reconcile,
} from "../scripts/stage1-runtime.mjs";
import {
	loadActiveRun,
	openRepositoryStore,
} from "../scripts/state-kernel.mjs";
import { journalEntryDigest } from "../scripts/state-internal.mjs";
import {
	parseReportBytes,
	parseTaskBytes,
	reportDigest,
	taskDigest,
} from "../scripts/task-report-schema.mjs";
import { stage2ContractFixture } from "./stage2-runtime-helpers.mjs";
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

const subjectKind = {
	"worktree.create": "worktree",
	"gate-source.create": "snapshot",
	"task.publish": "task",
	"pane.create": "pane",
	"agent.start": "agent",
	"report.harvest": "report",
	"report.reject": "report",
	"integration.reconcile": "git",
	"integration.harvest": "git",
};

function normalizedJournal(operations, authorities = {}) {
	let previous = null;
	return operations.map(({ type, role }, index) => {
		const authority = authorities[role];
		const generation =
			(type === "task.publish"
				? authority?.task.task_generation
				: type === "report.harvest"
					? authority?.report.report_generation
					: null) ?? "2".repeat(32);
		const operationId =
			type === "task.publish"
				? `task-publish-${role}-${generation}`
				: type === "report.harvest"
					? `report-harvest-${role}-${generation}`
					: `oracle-${index + 1}`;
		const resultDigest =
			(type === "task.publish"
				? authority?.task.task_digest
				: type === "report.harvest"
					? authority?.report.report_digest
					: null) ?? "d".repeat(64);
		const base = {
			document_type: "herdr-conductor-operation",
			schema_version: 1,
			repository_key: "a".repeat(64),
			workspace_id: "workspace-oracle",
			workspace_key: "b".repeat(64),
			run_id: "run-oracle",
			run_generation: "1".repeat(32),
			sequence: index + 1,
			operation_id: operationId,
			operation_type: type,
			subject: {
				kind: subjectKind[type],
				id: role,
				generation,
			},
			request_digest: "c".repeat(64),
			previous_digest: previous,
			entry_digest: "0".repeat(64),
			phase: "observed",
			result_digest: resultDigest,
			observed_identity: null,
			error_code: null,
			created_at: "2026-07-29T00:00:00.000Z",
			updated_at: "2026-07-29T00:00:00.000Z",
		};
		base.entry_digest = journalEntryDigest(base);
		previous = base.entry_digest;
		return validateJournalEntry(base);
	});
}

function retainedReport(role, outcome, index) {
	const taskDigest = index.toString(16).padStart(64, "0");
	const task = {
		role: { name: role },
		task_generation: 1,
		task_digest: taskDigest,
	};
	const report = {
		role: { name: role },
		task_generation: 1,
		task_digest: taskDigest,
		status: outcome === "blocked" ? "blocked" : "completed",
		result:
			outcome === "blocked"
				? null
				: {
						kind: outcome === "pass" ? "validation" : "delivery",
						verdict: outcome,
					},
	};
	return { task, report };
}

function productionAuthorityFixture(stateRoot, roles, phase) {
	const tasksDir = join(stateRoot, "contracts", "tasks");
	const reportsDir = join(stateRoot, "contracts", "reports");
	mkdirSync(tasksDir, { recursive: true, mode: 0o700 });
	mkdirSync(reportsDir, { recursive: true, mode: 0o700 });
	const authorities = Object.create(null);
	for (const role of roles) {
		const outboxRoot = join(stateRoot, "outboxes", role.name);
		const base = stage2ContractFixture({ outboxRoot });
		const task = structuredClone(base.task);
		task.task_id = `task-${role.name}`;
		task.scope = {
			...task.scope,
			repository_root: stateRoot,
			workspace_id: "workspace-oracle",
			run_id: "run-oracle",
			run_generation: "1".repeat(32),
		};
		task.role = {
			...task.role,
			name: role.name,
			contract_role: role.contract_role,
			configured_mode:
				role.contract_role === "reviewer"
					? "read-only"
					: role.contract_role === "validator"
						? "gated"
						: "write",
			pane_operation_id: `pane-${role.name}`,
			agent_operation_id: `agent-${role.name}`,
			agent_name: `agent-${role.name}`,
		};
		if (phase === "gates")
			task.source = {
				kind: "integration_snapshot",
				root: join(stateRoot, "sources", role.name),
				common_dir: task.scope.repository.common_dir,
				head_mode: "detached",
				base_sha: "1".repeat(40),
				integration_sha: "2".repeat(40),
				tree_sha: "3".repeat(40),
				snapshot_generation: task.role.source_generation,
				snapshot_entry_digest: "2".repeat(64),
				integration_entry_digest: "3".repeat(64),
				registered: true,
			};
		else
			task.source = {
				...task.source,
				root: join(stateRoot, "sources", role.name),
				worktree_generation: task.role.source_generation,
			};
		task.outbox = {
			...task.outbox,
			root: outboxRoot,
			slot_name: `report-${task.task_id}-${task.task_generation}-${task.outbox.outbox_generation}`,
		};
		delete task.task_digest;
		task.task_digest = taskDigest(task);
		const taskDirectory = join(tasksDir, role.name);
		mkdirSync(taskDirectory, { recursive: true, mode: 0o700 });
		writeFileSync(
			join(taskDirectory, `${task.task_generation}.json`),
			canonicalJson(task),
			{ mode: 0o600 },
		);
		const outcomes =
			phase === "delivery" ? ["delivered", "blocked"] : ["pass", "fail"];
		authorities[role.name] = Object.create(null);
		for (const [outcomeIndex, outcome] of outcomes.entries()) {
			const report = structuredClone(base.report);
			report.report_id = `report-${role.name}-${outcome}`;
			report.report_generation = (6 + outcomeIndex).toString().repeat(32);
			report.task = {
				id: task.task_id,
				generation: task.task_generation,
				digest: task.task_digest,
			};
			report.scope = task.scope;
			report.role = task.role;
			report.source = task.source;
			report.agent_observation = {
				...report.agent_observation,
				operation_id: task.role.agent_operation_id,
				agent_name: task.role.agent_name,
			};
			report.changed_paths = phase === "delivery" ? ["src/index.mjs"] : [];
			report.findings = [];
			if (outcome === "blocked") {
				report.status = "blocked";
				report.result = null;
				report.requirement_results = report.requirement_results.map(
					(result) => ({
						...result,
						assertion: "not_run",
						exit_code: null,
						output_sha256: null,
					}),
				);
			} else if (phase === "delivery")
				report.result = { kind: "delivery", verdict: "delivered" };
			else if (role.contract_role === "reviewer") {
				report.result = {
					kind: "review",
					verdict: outcome === "pass" ? "approve" : "request_changes",
				};
				if (outcome === "fail")
					report.findings = [
						{
							id: "finding",
							severity: "medium",
							path: null,
							line: null,
							message: "Review finding",
							evidence_kind: "worker_assertion",
						},
					];
			} else {
				report.result = { kind: "validation", verdict: outcome };
				if (outcome === "fail")
					report.requirement_results[0] = {
						...report.requirement_results[0],
						assertion: "failed",
						exit_code: 1,
					};
			}
			delete report.report_digest;
			report.report_digest = reportDigest(report);
			const reportDirectory = join(reportsDir, role.name, task.task_generation);
			mkdirSync(reportDirectory, { recursive: true, mode: 0o700 });
			writeFileSync(
				join(reportDirectory, `${report.report_generation}.json`),
				canonicalJson(report),
				{ mode: 0o600 },
			);
			authorities[role.name][outcome] = { task, report };
		}
	}
	return { tasksDir, reportsDir, authorities };
}

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

test("normalized-journal and retained-inventory lifecycle oracle covers mixed 0..64 vectors", () => {
	let vectors = 0;
	for (let count = 0; count <= 64; count++) {
		const splits = new Set([0, 1, Math.floor(count / 2), count - 1, count]);
		for (const phase of ["delivery", "gates"])
			for (const [leftPrefix, rightPrefix] of [
				[0, 0],
				[1, 2],
				[2, 4],
				[4, 5],
				[5, 4],
				[5, 5],
			])
				for (const split of splits) {
					if (split < 0 || split > count) continue;
					const roles = Array.from({ length: count }, (_, index) => ({
						name: `role-${index.toString().padStart(2, "0")}`,
						contract_role:
							phase === "delivery"
								? index % 2
									? "test_author"
									: "builder"
								: index % 2
									? "validator"
									: "reviewer",
					}));
					const prefixes = roles.map((_, index) =>
						index < split ? leftPrefix : rightPrefix,
					);
					const outcomes = roles.map((_, index) =>
						phase === "delivery"
							? index < split
								? "delivered"
								: "blocked"
							: index < split
								? "pass"
								: "fail",
					);
					const operations = [];
					if (phase === "gates") {
						operations.push(
							{ type: "integration.reconcile", role: "integration" },
							{ type: "integration.harvest", role: "integration" },
						);
					}
					const reportInventory = [];
					roles.forEach((role, index) => {
						const sequence =
							phase === "delivery"
								? [
										"worktree.create",
										"task.publish",
										"pane.create",
										"agent.start",
										"report.harvest",
									]
								: [
										"gate-source.create",
										"task.publish",
										"pane.create",
										"agent.start",
										"report.harvest",
									];
						for (const type of sequence.slice(0, prefixes[index]))
							operations.push({ type, role: role.name });
						if (prefixes[index] === 5)
							reportInventory.push(
								retainedReport(role.name, outcomes[index], index + 1),
							);
					});
					const expected = independentOracle({
						phase,
						roles,
						prefixes,
						outcomes,
						rejected: new Set(),
						refused: new Set(),
					});
					const permutations = [roles, [...roles].reverse()];
					for (const orderedRoles of permutations) {
						const scan = () =>
							scanStage2Authority(
								{
									journal: normalizedJournal(operations),
									state: { status: "active" },
								},
								{ roles: orderedRoles },
								{ reportInventory },
							).state;
						if (expected === "invalid") code("bookkeeping_unknown", scan);
						else assert.equal(scan(), expected);
						vectors++;
					}
				}
	}
	assert.ok(vectors > 3_000, `mixed oracle covered only ${vectors} vectors`);

	const roles = [
		{ name: "builder", contract_role: "builder" },
		{ name: "validator", contract_role: "validator" },
	];
	const rejectionJournal = normalizedJournal([
		...["worktree.create", "task.publish", "pane.create", "agent.start"].map(
			(type) => ({ type, role: "builder" }),
		),
		{ type: "report.reject", role: "builder" },
	]);
	assert.equal(
		scanStage2Authority(
			{ journal: rejectionJournal, state: { status: "active" } },
			{ roles },
			{ reportInventory: [] },
		).state,
		"delivery_report_rejected",
	);
	const gateRefusal = normalizedJournal([
		{ type: "integration.reconcile", role: "integration" },
		{ type: "integration.harvest", role: "integration" },
		{ type: "report.reject", role: "validator" },
	]);
	assert.equal(
		scanStage2Authority(
			{ journal: gateRefusal, state: { status: "active" } },
			{ roles },
			{ reportInventory: [] },
		).state,
		"gate_source_refused",
	);
	for (const [options, expected] of [
		[{ uncertainty: "operation_uncertain" }, "operation_uncertain"],
		[
			{ archiveUncertain: true, uncertainty: "operation_uncertain" },
			"archive_uncertain",
		],
	])
		assert.equal(
			scanStage2Authority(
				{ journal: [], state: { status: "active" } },
				{ roles: [] },
				{ reportInventory: [], ...options },
			).state,
			expected,
		);
});

test("production retained-authority path drives symmetry-reduced mixed 0..64 lifecycle oracle", () => {
	const root = mkdtempSync(join(tmpdir(), "conductor-lifecycle-authority-"));
	try {
		for (const phase of ["delivery", "gates"]) {
			const allRoles = Array.from({ length: 64 }, (_, index) => ({
				name: `role-${index.toString().padStart(2, "0")}`,
				contract_role:
					phase === "delivery"
						? index % 2
							? "test_author"
							: "builder"
						: index % 2
							? "validator"
							: "reviewer",
			}));
			const stateRoot = join(root, phase);
			mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
			const files = productionAuthorityFixture(stateRoot, allRoles, phase);
			for (let count = 0; count <= 64; count++) {
				const roles = allRoles.slice(0, count);
				const split = Math.floor(count / 2);
				const prefixPairs = [
					[0, 0],
					[1, 2],
					[2, 4],
					[4, 5],
					[5, 4],
					[5, 5],
				];
				const [leftPrefix, rightPrefix] =
					prefixPairs[count % prefixPairs.length];
				const prefixes = roles.map((_, index) =>
					index < split ? leftPrefix : rightPrefix,
				);
				const outcomes = roles.map((_, index) =>
					phase === "delivery"
						? index < split
							? "delivered"
							: "blocked"
						: index < split
							? "pass"
							: "fail",
				);
				const operations = [];
				if (phase === "gates")
					operations.push(
						{ type: "integration.reconcile", role: "integration" },
						{ type: "integration.harvest", role: "integration" },
					);
				const selected = Object.create(null);
				roles.forEach((role, index) => {
					selected[role.name] = files.authorities[role.name][outcomes[index]];
					const sequence =
						phase === "delivery"
							? [
									"worktree.create",
									"task.publish",
									"pane.create",
									"agent.start",
									"report.harvest",
								]
							: [
									"gate-source.create",
									"task.publish",
									"pane.create",
									"agent.start",
									"report.harvest",
								];
					for (const type of sequence.slice(0, prefixes[index]))
						operations.push({ type, role: role.name });
				});
				const active = {
					journal: normalizedJournal(operations, selected),
					state: {
						status: "active",
						repository: { key: "a".repeat(64) },
						workspace_id: "workspace-oracle",
						run_id: "run-oracle",
						generation: "1".repeat(32),
					},
					paths: {
						tasksDir: files.tasksDir,
						reportsDir: files.reportsDir,
					},
				};
				const expected = independentOracle({
					phase,
					roles,
					prefixes,
					outcomes,
					rejected: new Set(),
					refused: new Set(),
				});
				const scan = () => {
					const acceptedReports = deriveRetainedReportAuthority(
						active,
						stateRoot,
					);
					return scanStage2Authority(active, { roles }, { acceptedReports })
						.state;
				};
				if (expected === "invalid") code("bookkeeping_unknown", scan);
				else assert.equal(scan(), expected, `${phase}:${count}`);
			}
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
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

import test from "node:test";
import assert from "node:assert/strict";
import {
	commitMarkerDigest,
	parseStage2ConfigBytes,
	publishingGuardDigest,
	reportDigest,
	taskDigest,
	validateCommitMarker,
	validatePublishingGuard,
	validateReport,
	validateReportDraft,
	validateTask,
} from "../scripts/task-report-schema.mjs";
import {
	canonicalJson,
	StateKernelError,
} from "../scripts/private-state-schema.mjs";

const g = (c) => c.repeat(32);
const d = (c) => c.repeat(64);
const s = (c) => c.repeat(40);
const now = "2026-07-28T00:00:00.000Z";
const common = { path: "/repo/.git", device: "1", inode: "2" };
const scope = {
	repository: { key: d("a"), common_dir: common },
	repository_root: "/repo",
	workspace_id: "workspace",
	workspace_key: d("b"),
	run_id: "run",
	run_generation: g("c"),
};
const role = {
	name: "builder",
	contract_role: "builder",
	agent_kind: "codex",
	configured_mode: "write",
	source_generation: g("d"),
	pane_generation: g("e"),
	agent_generation: g("f"),
	pane_operation_id: "pane-builder",
	agent_operation_id: "agent-builder",
	agent_request_digest: d("1"),
	agent_name: "builder-agent",
};
const source = {
	kind: "role_worktree",
	root: "/repo/worktrees/builder",
	common_dir: common,
	branch_ref: "refs/heads/conductor/builder",
	fork_sha: s("1"),
	expected_sha: s("2"),
	tree_sha: s("3"),
	worktree_generation: role.source_generation,
	worktree_entry_digest: d("2"),
	registered: true,
};
const assignment = {
	title: "Build",
	mission: "Implement the task",
	acceptance_criteria: [{ id: "criterion", text: "Result is correct" }],
	owned_paths: ["src"],
	forbidden_paths: ["secrets"],
	required_commands: [{ id: "test", command: "npm test" }],
};
const taskWithoutDigest = {
	document_type: "herdr-conductor-task",
	schema_version: 1,
	task_id: "task",
	task_generation: g("4"),
	scope,
	role,
	source,
	outbox: {
		outbox_id: "outbox",
		outbox_generation: g("5"),
		root: "/state/outboxes/builder",
		slot_name: `report-task-${g("4")}-${g("5")}`,
		payload_filename: "report.json",
		commit_filename: "COMMITTED.json",
	},
	assignment,
	validator_artifacts: [],
	created_at: now,
};
const task = {
	...taskWithoutDigest,
	task_digest: taskDigest(taskWithoutDigest),
};
const draft = {
	document_type: "herdr-conductor-report",
	schema_version: 1,
	report_id: "report",
	report_generation: g("6"),
	task: {
		id: task.task_id,
		generation: task.task_generation,
		digest: task.task_digest,
	},
	scope,
	role,
	source,
	agent_observation: {
		operation_id: role.agent_operation_id,
		entry_digest: d("3"),
		agent_generation: role.agent_generation,
		pane_generation: role.pane_generation,
		agent_name: role.agent_name,
	},
	status: "completed",
	result: { kind: "delivery", verdict: "delivered" },
	summary: "Done",
	findings: [],
	requirement_results: [
		{
			requirement_kind: "command",
			requirement_id: "test",
			assertion: "passed",
			evidence_kind: "worker_assertion",
			command: "npm test",
			exit_code: 0,
			output_sha256: d("4"),
			note: "worker assertion",
		},
		{
			requirement_kind: "criterion",
			requirement_id: "criterion",
			assertion: "passed",
			evidence_kind: "worker_assertion",
			command: null,
			exit_code: null,
			output_sha256: null,
			note: "worker assertion",
		},
	],
	changed_paths: ["src/index.mjs"],
	artifacts: [],
	completed_at: now,
};
const report = { ...draft, report_digest: reportDigest(draft) };

function code(expected, fn) {
	assert.throws(
		fn,
		(error) => error instanceof StateKernelError && error.code === expected,
	);
}

test("configuration v2 is closed and artifact allowlists are empty", () => {
	const config = {
		version: 2,
		state_root: { kind: "default" },
		worktree_root: ".conductor-worktrees",
		roles: [
			{
				name: "builder",
				contract_role: "builder",
				kind: "codex",
				mode: "write",
				assignment,
				validator_artifacts: [],
			},
		],
	};
	assert.equal(
		parseStage2ConfigBytes(Buffer.from(canonicalJson(config))).version,
		2,
	);
	code("wrong_version", () =>
		parseStage2ConfigBytes(
			Buffer.from('{"version":1,"worktree_root":"x","roles":[]}'),
		),
	);
	code("duplicate_json_key", () =>
		parseStage2ConfigBytes(
			Buffer.from('{"version":2,"version":2,"worktree_root":"x","roles":[]}'),
		),
	);
	code("invalid_contract", () =>
		parseStage2ConfigBytes(
			Buffer.from(
				canonicalJson({
					...config,
					roles: [{ ...config.roles[0], validator_artifacts: ["out"] }],
				}),
			),
		),
	);
	const { state_root: _stateRoot, ...withoutStateRoot } = config;
	code("invalid_contract", () =>
		parseStage2ConfigBytes(Buffer.from(canonicalJson(withoutStateRoot))),
	);
	code("invalid_contract", () =>
		parseStage2ConfigBytes(
			Buffer.from(
				canonicalJson({
					...config,
					state_root: { kind: "absolute", path: "relative" },
				}),
			),
		),
	);
	code("invalid_contract", () =>
		parseStage2ConfigBytes(
			Buffer.from(canonicalJson({ ...config, apply: null })),
		),
	);
});

test("configuration v3 requires one explicit apply member", () => {
	const v3 = {
		version: 3,
		state_root: { kind: "default" },
		worktree_root: ".conductor-worktrees",
		apply: { target_ref: "refs/heads/release" },
		roles: [
			{
				name: "builder",
				contract_role: "builder",
				kind: "codex",
				mode: "write",
				assignment,
				validator_artifacts: [],
			},
		],
	};
	assert.equal(
		parseStage2ConfigBytes(Buffer.from(canonicalJson(v3))).apply.target_ref,
		"refs/heads/release",
	);
	assert.equal(
		parseStage2ConfigBytes(
			Buffer.from(canonicalJson({ ...v3, apply: null })),
		).apply,
		null,
	);
	const { apply: _apply, ...withoutApply } = v3;
	code("invalid_contract", () =>
		parseStage2ConfigBytes(Buffer.from(canonicalJson(withoutApply))),
	);
	code("invalid_contract", () =>
		parseStage2ConfigBytes(
			Buffer.from(canonicalJson({ ...v3, apply: {} })),
		),
	);
	for (const targetRef of [
		"main",
		"refs//heads/release",
		"refs/heads/../release",
		"refs/heads/./release",
		"refs\\heads\\release",
		"refs/heads/re lease",
	])
		code("invalid_contract", () =>
			parseStage2ConfigBytes(
				Buffer.from(canonicalJson({ ...v3, apply: { target_ref: targetRef } })),
			),
		);
	code("invalid_contract", () =>
		parseStage2ConfigBytes(
			Buffer.from(
				canonicalJson({
					...v3,
					apply: { target_ref: "refs/heads/release", mode: "fast-forward" },
				}),
			),
		),
	);
});

test("task and report digests are domain separated and validated", () => {
	assert.equal(validateTask(task).task_digest, task.task_digest);
	assert.equal(validateReportDraft(draft, { task }).report_id, "report");
	assert.equal(
		validateReport(report, { task }).report_digest,
		report.report_digest,
	);
	assert.notEqual(task.task_digest, report.report_digest);
	code("digest_mismatch", () => validateTask({ ...task, task_digest: d("9") }));
	code("invalid_contract", () =>
		validateReport({ ...report, artifacts: ["out"] }, { task }),
	);
	code("invalid_contract", () =>
		validateReport(
			{
				...report,
				requirement_results: report.requirement_results.slice(0, 1),
			},
			{ task },
		),
	);
});

test("publisher guard and marker bind every report byte", () => {
	const payload = Buffer.from(canonicalJson(report));
	const guardBase = {
		document_type: "herdr-conductor-report-publishing-guard",
		schema_version: 1,
		scope,
		task: {
			id: task.task_id,
			generation: task.task_generation,
			digest: task.task_digest,
		},
		outbox: {
			id: task.outbox.outbox_id,
			generation: task.outbox.outbox_generation,
			root: task.outbox.root,
			slot_name: task.outbox.slot_name,
		},
		filenames: {
			guard: ".publishing.json",
			staging: `payload.part-${g("7")}`,
			payload: "report.json",
			commit: "COMMITTED.json",
		},
		publisher_nonce: g("7"),
		report: {
			id: report.report_id,
			generation: report.report_generation,
			digest: report.report_digest,
		},
		payload_byte_length: payload.length,
		payload_sha256: d("8"),
	};
	const guard = {
		...guardBase,
		guard_digest: publishingGuardDigest(guardBase),
	};
	assert.equal(validatePublishingGuard(guard).guard_digest, guard.guard_digest);
	const markerBase = {
		document_type: "herdr-conductor-report-committed",
		schema_version: 1,
		scope,
		task: guard.task,
		outbox: guard.outbox,
		filenames: { payload: "report.json", commit: "COMMITTED.json" },
		publisher_nonce: guard.publisher_nonce,
		report: guard.report,
		payload_byte_length: payload.length,
		payload_sha256: guard.payload_sha256,
		publishing_guard_digest: guard.guard_digest,
	};
	const marker = {
		...markerBase,
		marker_digest: commitMarkerDigest(markerBase),
	};
	assert.equal(
		validateCommitMarker(marker).marker_digest,
		marker.marker_digest,
	);
	code("invalid_contract", () =>
		validatePublishingGuard({
			...guard,
			filenames: { ...guard.filenames, staging: "payload.part-bad" },
		}),
	);
});

import { taskDigest, reportDigest } from "../scripts/task-report-schema.mjs";
const g = (c) => c.repeat(32);
const d = (c) => c.repeat(64);
const s = (c) => c.repeat(40);
export function stage2ContractFixture({
	outboxRoot = "/state/outboxes/builder",
	changedPaths = ["src/index.mjs"],
} = {}) {
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
	const taskBase = {
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
			root: outboxRoot,
			slot_name: `report-task-${g("4")}-${g("5")}`,
			payload_filename: "report.json",
			commit_filename: "COMMITTED.json",
		},
		assignment,
		validator_artifacts: [],
		created_at: "2026-07-28T00:00:00.000Z",
	};
	const task = { ...taskBase, task_digest: taskDigest(taskBase) };
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
		changed_paths: changedPaths,
		artifacts: [],
		completed_at: "2026-07-28T00:00:00.000Z",
	};
	return {
		task,
		draft,
		report: { ...draft, report_digest: reportDigest(draft) },
	};
}

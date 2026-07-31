import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { assembledFixture, git, context } from "./stage1-runtime-helpers.mjs";
import { canonicalJson } from "../scripts/private-state-schema.mjs";
import { reportDigest, validateTask } from "../scripts/task-report-schema.mjs";
import { publishReportFromStdin } from "../scripts/report-publisher.mjs";
import { harvestCommittedReport } from "../scripts/report-harvest.mjs";
import {
	acquireRepositoryLock,
	loadActiveRun,
	openRepositoryStore,
	releaseRepositoryLock,
} from "../scripts/state-kernel.mjs";
const sha = (value) => createHash("sha256").update(value).digest("hex");
async function setup(reportedPath = "src/result.txt") {
	const fixture = await assembledFixture({
		roles: [{ name: "builder", kind: "pi", mode: "write" }],
	});
	const worker = fixture.result.workers[0];
	const path = join(worker.cwd, "src/result.txt");
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, "result\n");
	git(worker.cwd, "add", "src/result.txt");
	git(worker.cwd, "commit", "-qm", "result");
	const task = validateTask(JSON.parse(readFileSync(worker.task_path, "utf8")));
	const head = git(worker.cwd, "rev-parse", "HEAD");
	const tree = git(worker.cwd, "rev-parse", "HEAD^{tree}");
	const store = openRepositoryStore({
		stateRoot: fixture.stateRoot,
		repoPath: fixture.repository,
	});
	const active = loadActiveRun(store, { workspaceId: fixture.workspace });
	const agent = active.journal.find(
		(entry) =>
			entry.operation_type === "agent.start" && entry.subject.id === "builder",
	);
	const base = {
		document_type: "herdr-conductor-report",
		schema_version: 1,
		report_id: "report-builder",
		report_generation: "9".repeat(32),
		task: {
			id: task.task_id,
			generation: task.task_generation,
			digest: task.task_digest,
		},
		scope: task.scope,
		role: task.role,
		agent_observation: {
			operation_id: task.role.agent_operation_id,
			entry_digest: agent.entry_digest,
			agent_generation: task.role.agent_generation,
			pane_generation: task.role.pane_generation,
			agent_name: task.role.agent_name,
		},
		source: { ...task.source, expected_sha: head, tree_sha: tree },
		status: "completed",
		result: { kind: "delivery", verdict: "delivered" },
		summary: "Delivered as an unauthenticated worker assertion",
		findings: [],
		requirement_results: [],
		changed_paths: [reportedPath],
		artifacts: [],
		completed_at: "2026-07-29T12:00:00.000Z",
	};
	const report = { ...base, report_digest: reportDigest(base) };
	await publishReportFromStdin({
		input: (async function* () {
			yield Buffer.from(canonicalJson(report));
		})(),
		stateRoot: fixture.stateRoot,
		authorizeTask: () => ({ task }),
	});
	const config = JSON.parse(
		readFileSync(join(fixture.repository, ".herdr-conductor.json"), "utf8"),
	);
	const configurationDigest = sha(canonicalJson(config));
	return { ...fixture, task, store, configurationDigest };
}
test("collector accepts a complete stable producer report and exact replay does not duplicate authority", async () => {
	const fixture = await setup();
	const lock = acquireRepositoryLock(fixture.store, { operationId: "collect" });
	try {
		const first = await harvestCommittedReport(lock, {
			workspaceId: fixture.workspace,
			runId: fixture.result.run_id,
			runGeneration: fixture.result.generation,
			taskPath: fixture.result.workers[0].task_path,
			configurationDigest: fixture.configurationDigest,
		});
		assert.equal(first.disposition, "harvested");
		const second = await harvestCommittedReport(lock, {
			workspaceId: fixture.workspace,
			runId: fixture.result.run_id,
			runGeneration: fixture.result.generation,
			taskPath: fixture.result.workers[0].task_path,
			configurationDigest: fixture.configurationDigest,
		});
		assert.equal(second.replayed, true);
	} finally {
		releaseRepositoryLock(lock);
	}
});
test("complete path-policy mismatch becomes durable rejection with zero accepted report", async () => {
	const fixture = await setup("src/wrong.txt");
	const lock = acquireRepositoryLock(fixture.store, { operationId: "reject" });
	try {
		const result = await harvestCommittedReport(lock, {
			workspaceId: fixture.workspace,
			runId: fixture.result.run_id,
			runGeneration: fixture.result.generation,
			taskPath: fixture.result.workers[0].task_path,
			configurationDigest: fixture.configurationDigest,
		});
		assert.equal(result.disposition, "rejected");
		assert.equal(result.failureClass, "path_policy");
		const active = loadActiveRun(fixture.store, {
			workspaceId: fixture.workspace,
		});
		assert.equal(
			active.journal.filter(
				(entry) =>
					entry.operation_type === "report.reject" &&
					entry.phase === "observed",
			).length,
			1,
		);
		assert.equal(
			active.journal.filter(
				(entry) => entry.operation_type === "report.harvest",
			).length,
			0,
		);
	} finally {
		releaseRepositoryLock(lock);
	}
});

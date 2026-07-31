import test from "node:test";
import assert from "node:assert/strict";
import {
	chmodSync,
	mkdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
	assembledFixture,
	context,
	deterministicRandom,
	git,
	publishWorkerReport,
	readJournals,
	reconcile,
} from "./stage1-runtime-helpers.mjs";

const roles = [
	{
		name: "builder",
		contract_role: "builder",
		kind: "pi",
		mode: "write",
	},
	{
		name: "reviewer",
		contract_role: "reviewer",
		kind: "codex",
		mode: "read-only",
	},
	{
		name: "validator",
		contract_role: "validator",
		kind: "codex",
		mode: "gated",
	},
];

async function producerReadyFixture() {
	const fixture = await assembledFixture({ roles });
	const producer = fixture.result.workers[0];
	mkdirSync(join(producer.cwd, "src"));
	writeFileSync(
		join(producer.cwd, "src", "feature.mjs"),
		"export default 1;\n",
	);
	git(producer.cwd, "add", "src/feature.mjs");
	git(producer.cwd, "commit", "-qm", "feature");
	await publishWorkerReport(fixture, producer);
	return { fixture, producer };
}

async function integratedGateFixture() {
	const { fixture, producer } = await producerReadyFixture();
	const harvested = await reconcile({
		contextJson: context(fixture.repository, fixture.workspace),
		stateRoot: fixture.stateRoot,
		exec: fixture.fake.exec,
		herdrBin: "fake",
		random: deterministicRandom(80),
	});
	return { fixture, producer, harvested };
}

test("harvest provisions exact-SHA gates behind task and agent barriers, then collects reports", async () => {
	const { fixture, harvested } = await integratedGateFixture();
	assert.equal(harvested.lifecycle, "gate_waiting_reports");
	assert.equal(harvested.gate_workers.length, 2);
	assert.equal(new Set(harvested.gate_workers.map(({ cwd }) => cwd)).size, 2);
	for (const worker of harvested.gate_workers) {
		assert.equal(
			git(worker.cwd, "rev-parse", "HEAD"),
			harvested.integration.final_sha,
		);
		assert.equal(Number(statSync(worker.cwd).mode & 0o777), 0o555);
		assert.equal(worker.outbox_slot.startsWith(worker.cwd), false);
	}
	const journal = readJournals(fixture.stateRoot);
	const gateSources = journal.filter(
		(entry) => entry.operation_type === "gate-source.create",
	);
	const gateTasks = journal.filter(
		(entry) =>
			entry.operation_type === "task.publish" && entry.subject.id !== "builder",
	);
	const gatePanes = journal.filter(
		(entry) =>
			entry.operation_type === "pane.create" && entry.subject.id !== "builder",
	);
	const gateAgents = journal.filter(
		(entry) =>
			entry.operation_type === "agent.start" && entry.subject.id !== "builder",
	);
	assert.equal(gateSources.length, 2);
	assert.equal(gateTasks.length, 2);
	assert.equal(gatePanes.length, 2);
	assert.equal(gateAgents.length, 2);
	assert.ok(
		Math.max(...gateSources.map(({ sequence }) => sequence)) <
			Math.min(...gateTasks.map(({ sequence }) => sequence)),
	);
	assert.ok(
		Math.max(...gateTasks.map(({ sequence }) => sequence)) <
			Math.min(...gatePanes.map(({ sequence }) => sequence)),
	);
	assert.ok(
		Math.max(...gatePanes.map(({ sequence }) => sequence)) <
			Math.min(...gateAgents.map(({ sequence }) => sequence)),
	);
	for (const worker of harvested.gate_workers)
		await publishWorkerReport(fixture, worker);
	const effectsBefore = fixture.fake.effects;
	const completed = await reconcile({
		contextJson: context(fixture.repository, fixture.workspace),
		stateRoot: fixture.stateRoot,
		exec: fixture.fake.exec,
		herdrBin: "fake",
	});
	assert.equal(completed.lifecycle, "gate_reports_collected");
	assert.equal(completed.accepted_gate_reports, 2);
	assert.equal(fixture.fake.effects, effectsBefore);
});

test("empty producer sets record zero-CAS integration before gate dispatch", async () => {
	const fixture = await assembledFixture({ roles: [roles[1]] });
	assert.equal(fixture.result.workers.length, 0);
	const harvested = await reconcile({
		contextJson: context(fixture.repository, fixture.workspace),
		stateRoot: fixture.stateRoot,
		exec: fixture.fake.exec,
		herdrBin: "fake",
		random: deterministicRandom(120),
	});
	assert.equal(harvested.integration.cas_count, 0);
	assert.equal(harvested.lifecycle, "gate_waiting_reports");
	assert.equal(harvested.gate_workers.length, 1);
	await publishWorkerReport(fixture, harvested.gate_workers[0]);
	const completed = await reconcile({
		contextJson: context(fixture.repository, fixture.workspace),
		stateRoot: fixture.stateRoot,
		exec: fixture.fake.exec,
		herdrBin: "fake",
	});
	assert.equal(completed.lifecycle, "gate_reports_collected");
});

test("gate mutation before task barrier creates zero gate task, pane, or agent authority", async () => {
	const { fixture } = await producerReadyFixture();
	let mutated = false;
	await assert.rejects(() =>
		reconcile({
			contextJson: context(fixture.repository, fixture.workspace),
			exec: fixture.fake.exec,
			herdrBin: "fake",
			fault(name) {
				if (name !== "gate-source.create:journal.after_effect" || mutated)
					return;
				mutated = true;
				const gateRoot = [...fixture.fake.worktrees].find(
					(path) => path.endsWith("/reviewer") || path.endsWith("/validator"),
				);
				const tracked = join(gateRoot, "base.txt");
				chmodSync(tracked, 0o644);
				writeFileSync(tracked, "mutated before task\n");
			},
		}),
	);
	assert.equal(mutated, true);
	const gateEntries = readJournals(fixture.stateRoot).filter(
		(entry) => entry.subject.id !== "builder",
	);
	assert.equal(
		gateEntries.filter((entry) => entry.operation_type === "task.publish")
			.length,
		0,
	);
	assert.equal(
		gateEntries.filter((entry) => entry.operation_type === "pane.create")
			.length,
		0,
	);
	assert.equal(
		gateEntries.filter((entry) => entry.operation_type === "agent.start")
			.length,
		0,
	);
});

test("gate mutation after pane observation blocks the agent barrier", async () => {
	const { fixture } = await producerReadyFixture();
	let mutated = false;
	await assert.rejects(() =>
		reconcile({
			contextJson: context(fixture.repository, fixture.workspace),
			exec: fixture.fake.exec,
			herdrBin: "fake",
			fault(name) {
				if (name !== "pane.create:journal.after_effect" || mutated) return;
				mutated = true;
				const gateRoot = [...fixture.fake.worktrees].find(
					(path) => path.endsWith("/reviewer") || path.endsWith("/validator"),
				);
				const tracked = join(gateRoot, "base.txt");
				chmodSync(tracked, 0o644);
				writeFileSync(tracked, "mutated before agent\n");
			},
		}),
	);
	assert.equal(mutated, true);
	const gateEntries = readJournals(fixture.stateRoot).filter(
		(entry) => entry.subject.id !== "builder",
	);
	assert.ok(
		gateEntries.some((entry) => entry.operation_type === "pane.create"),
	);
	assert.equal(
		gateEntries.filter((entry) => entry.operation_type === "agent.start")
			.length,
		0,
	);
});

test("gate source mutation becomes a stable source-policy refusal without target or pane effects", async () => {
	const { fixture, harvested } = await integratedGateFixture();
	const [worker] = harvested.gate_workers;
	const tracked = join(worker.cwd, "src", "feature.mjs");
	chmodSync(tracked, 0o644);
	writeFileSync(tracked, "mutated\n");
	const effectsBefore = fixture.fake.effects;
	const refused = await reconcile({
		contextJson: context(fixture.repository, fixture.workspace),
		stateRoot: fixture.stateRoot,
		exec: fixture.fake.exec,
		herdrBin: "fake",
	});
	assert.equal(refused.lifecycle, "gate_source_refused");
	assert.deepEqual(refused.source_refused, [worker.role]);
	assert.equal(fixture.fake.effects, effectsBefore);
	assert.equal(readFileSync(tracked, "utf8"), "mutated\n");
});

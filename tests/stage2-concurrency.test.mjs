import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJson } from "../scripts/private-state-schema.mjs";
import { reconcile, standDown } from "../scripts/stage1-runtime.mjs";
import {
	assembledFixture,
	buildWorkerReport,
	context,
	deterministicRandom,
	git,
	privateDocuments,
} from "./stage1-runtime-helpers.mjs";

const publisherChild = fileURLToPath(
	new URL("./fixtures/stage2-crash-child.mjs", import.meta.url),
);
const lifecycleChild = fileURLToPath(
	new URL("./fixtures/b3-crash-child.mjs", import.meta.url),
);
const roles = [
	{
		name: "builder",
		contract_role: "builder",
		kind: "codex",
		mode: "write",
	},
];
function runChild(childPath, args) {
	return new Promise((resolvePromise) => {
		const child = spawn(process.execPath, [childPath, ...args], {
			stdio: ["ignore", "ignore", "pipe"],
		});
		let stderr = "";
		child.stderr.on("data", (bytes) => (stderr += bytes));
		child.on("exit", (code, signal) =>
			resolvePromise({ code, signal, stderr }),
		);
	});
}
function runPublisher(args) {
	return runChild(publisherChild, args);
}
async function reportFixture() {
	const fixture = await assembledFixture({ roles });
	const worker = fixture.result.workers[0];
	mkdirSync(join(worker.cwd, "src"));
	writeFileSync(join(worker.cwd, "src", "race.mjs"), "export default 1;\n");
	git(worker.cwd, "add", "src/race.mjs");
	git(worker.cwd, "commit", "-qm", "race fixture");
	const { report } = await buildWorkerReport(fixture, worker);
	const directory = mkdtempSync(join(tmpdir(), "conductor-stage2-race-"));
	const reportPath = join(directory, "report.json");
	writeFileSync(reportPath, canonicalJson(report));
	return { fixture, worker, reportPath };
}

test("publisher/publisher barrier produces one winner and one exact loser", async () => {
	const { fixture, worker, reportPath } = await reportFixture();
	const configPath = join(fixture.repository, ".herdr-conductor.json");
	const barrier = mkdtempSync(join(tmpdir(), "conductor-publisher-barrier-"));
	const ready = join(barrier, "ready");
	const release = join(barrier, "release");
	const winner = runPublisher([
		worker.task_path,
		configPath,
		reportPath,
		"publisher_guard.before_open",
		ready,
		release,
	]);
	for (let attempt = 0; attempt < 500 && !existsSync(ready); attempt++)
		await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
	assert.equal(existsSync(ready), true, "publisher did not reach barrier");
	const loser = await runPublisher([
		worker.task_path,
		configPath,
		reportPath,
		"never",
	]);
	assert.equal(loser.code, 1);
	assert.match(loser.stderr, /^lock_busy:/);
	writeFileSync(release, "release\n");
	assert.deepEqual(await winner, { code: 0, signal: null, stderr: "" });
	assert.deepEqual(
		privateDocuments(fixture.stateRoot)
			.filter(({ path }) => path.endsWith("/report.json"))
			.map(({ path }) => path),
		[worker.outbox_slot + "/report.json"],
	);
	assert.equal(
		privateDocuments(fixture.stateRoot).filter(
			({ value }) => value.operation_type === "report.harvest",
		).length,
		0,
	);
});

test("publisher/collector barrier gives one lock winner and later exactly one harvest", async () => {
	const { fixture, worker, reportPath } = await reportFixture();
	const barrier = mkdtempSync(
		join(tmpdir(), "conductor-publish-collect-barrier-"),
	);
	const ready = join(barrier, "ready");
	const release = join(barrier, "release");
	const publisher = runPublisher([
		worker.task_path,
		join(fixture.repository, ".herdr-conductor.json"),
		reportPath,
		"publisher_guard.before_open",
		ready,
		release,
	]);
	for (let attempt = 0; attempt < 500 && !existsSync(ready); attempt++)
		await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
	assert.equal(existsSync(ready), true, "publisher did not reach barrier");
	await assert.rejects(
		reconcile({
			contextJson: context(fixture.repository, fixture.workspace),
			herdrBin: "fake",
			exec: fixture.fake.exec,
		}),
		(error) => error.code === "lock_busy",
	);
	writeFileSync(release, "release\n");
	assert.deepEqual(await publisher, { code: 0, signal: null, stderr: "" });
	const collected = await reconcile({
		contextJson: context(fixture.repository, fixture.workspace),
		herdrBin: "fake",
		exec: fixture.fake.exec,
	});
	assert.equal(collected.integration.cas_count, 1);
	assert.equal(
		privateDocuments(fixture.stateRoot).filter(
			({ value }) =>
				value.operation_type === "report.harvest" && value.phase === "observed",
		).length,
		1,
	);
	assert.equal(
		privateDocuments(fixture.stateRoot).filter(
			({ value }) =>
				value.operation_type === "integration.reconcile" &&
				value.phase === "observed",
		).length,
		1,
	);
});

test("concurrent collectors converge on one accepted copy and one observed harvest", async () => {
	const { fixture, worker, reportPath } = await reportFixture();
	const published = await runPublisher([
		worker.task_path,
		join(fixture.repository, ".herdr-conductor.json"),
		reportPath,
		"never",
	]);
	assert.equal(published.code, 0);
	const activeOptions = {
		contextJson: context(fixture.repository, fixture.workspace),
		stateRoot: fixture.stateRoot,
		herdrBin: "fake",
		exec: fixture.fake.exec,
	};
	const [first, second] = await Promise.allSettled([
		reconcile({ ...activeOptions, random: deterministicRandom(140) }),
		reconcile({ ...activeOptions, random: deterministicRandom(160) }),
	]);
	assert.equal(
		[first.status, second.status].filter((status) => status === "fulfilled")
			.length,
		1,
	);
	const harvestEntries = privateDocuments(fixture.stateRoot).filter(
		({ value }) =>
			value.operation_type === "report.harvest" && value.phase === "observed",
	);
	assert.equal(harvestEntries.length, 1);
	assert.equal(
		privateDocuments(fixture.stateRoot).filter(
			({ path }) =>
				path.includes("/contracts/reports/") && path.endsWith(".json"),
		).length,
		1,
	);
});

async function lifecycleBarrier(fixture, boundary, operation = "lifecycle") {
	const directory = mkdtempSync(join(tmpdir(), "conductor-lifecycle-race-"));
	const livePath = join(directory, "live.json");
	const effectsPath = join(directory, "effects.log");
	const ready = join(directory, "ready");
	const release = join(directory, "release");
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
	const child = runChild(lifecycleChild, [
		operation,
		fixture.repository,
		fixture.stateRoot,
		fixture.workspace,
		livePath,
		effectsPath,
		boundary,
		ready,
		release,
	]);
	for (let attempt = 0; attempt < 1_000 && !existsSync(ready); attempt++)
		await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
	assert.equal(existsSync(ready), true, `${boundary}: barrier not reached`);
	return { child, effectsPath, release };
}

async function publishedRaceFixture() {
	const result = await reportFixture();
	const published = await runPublisher([
		result.worker.task_path,
		join(result.fixture.repository, ".herdr-conductor.json"),
		result.reportPath,
		"never",
	]);
	assert.deepEqual(published, { code: 0, signal: null, stderr: "" });
	return result;
}

function reconciliationEntries(fixture) {
	return privateDocuments(fixture.stateRoot).filter(
		({ value }) => value.operation_type === "integration.reconcile",
	);
}

test("child barrier source replacement loses before CAS with exact retained journal", async () => {
	const { fixture, worker } = await publishedRaceFixture();
	const targetBefore = git(fixture.repository, "rev-parse", "HEAD");
	const barrier = await lifecycleBarrier(
		fixture,
		"integration.reconcile:integration.before_cas",
	);
	writeFileSync(join(worker.cwd, "src", "racer.mjs"), "export default 2;\n");
	git(worker.cwd, "add", "src/racer.mjs");
	git(worker.cwd, "commit", "-qm", "competing source replacement");
	const sourceWinner = git(worker.cwd, "rev-parse", "HEAD");
	writeFileSync(barrier.release, "release\n");
	const loser = await barrier.child;
	assert.equal(loser.code, 1);
	assert.match(loser.stderr, /^recovery_required:/);
	assert.equal(git(fixture.repository, "rev-parse", "HEAD"), targetBefore);
	assert.equal(git(worker.cwd, "rev-parse", "HEAD"), sourceWinner);
	assert.equal(readFileSync(barrier.effectsPath, "utf8"), "");
	const entries = reconciliationEntries(fixture);
	assert.equal(entries.length, 1);
	assert.equal(entries[0].value.phase, "needs_attention");
	assert.equal(entries[0].value.error_code, "external_effect_unknown");
});

test("child barrier target drift preserves competing winner bytes and performs no CAS", async () => {
	const { fixture } = await publishedRaceFixture();
	const targetBefore = git(fixture.repository, "rev-parse", "HEAD");
	const barrier = await lifecycleBarrier(
		fixture,
		"integration.reconcile:integration.before_cas",
	);
	const tree = git(fixture.repository, "rev-parse", "HEAD^{tree}");
	const competing = git(
		fixture.repository,
		"commit-tree",
		tree,
		"-p",
		targetBefore,
		"-m",
		"competing target",
	);
	git(
		fixture.repository,
		"update-ref",
		"refs/heads/main",
		competing,
		targetBefore,
	);
	writeFileSync(barrier.release, "release\n");
	const loser = await barrier.child;
	assert.equal(loser.code, 1);
	assert.match(loser.stderr, /^recovery_required:/);
	assert.equal(git(fixture.repository, "rev-parse", "HEAD"), competing);
	assert.equal(readFileSync(barrier.effectsPath, "utf8"), "");
	assert.equal(
		reconciliationEntries(fixture)[0].value.phase,
		"needs_attention",
	);
});

test("reconcile versus stand-down barrier has one lock winner and one exact loser", async () => {
	const { fixture } = await publishedRaceFixture();
	const barrier = await lifecycleBarrier(
		fixture,
		"integration.reconcile:integration.before_cas",
	);
	let standDownError;
	try {
		await standDown({
			contextJson: context(fixture.repository, fixture.workspace),
			herdrBin: "fake",
			exec: fixture.fake.exec,
		});
	} catch (error) {
		standDownError = error;
	} finally {
		writeFileSync(barrier.release, "release\n");
	}
	assert.equal(standDownError?.code, "recovery_required");
	assert.match(
		standDownError.message,
		/unresolved operation|uncertainty guard/,
	);
	assert.deepEqual(await barrier.child, { code: 0, signal: null, stderr: "" });
	assert.equal(
		readFileSync(barrier.effectsPath, "utf8").trim().split("\n").filter(Boolean)
			.length,
		1,
	);
	assert.equal(reconciliationEntries(fixture)[0].value.phase, "observed");
});

test("barrier-controlled stand-down callers have one exact loser and one archive effect", async () => {
	const fixture = await assembledFixture({ roles });
	const barrier = await lifecycleBarrier(
		fixture,
		"run.stand-down.begin:journal.after_guard_durable",
		"stand",
	);
	const bytesBeforeLoser = canonicalJson(privateDocuments(fixture.stateRoot));
	const targetBeforeLoser = git(fixture.repository, "rev-parse", "HEAD");
	const effectsBeforeLoser = fixture.fake.effects;
	await assert.rejects(
		() =>
			standDown({
				contextJson: context(fixture.repository, fixture.workspace),
				herdrBin: "fake",
				exec: fixture.fake.exec,
			}),
		(error) =>
			error.code === "recovery_required" &&
			/unresolved operation|uncertainty guard/.test(error.message),
	);
	assert.equal(
		canonicalJson(privateDocuments(fixture.stateRoot)),
		bytesBeforeLoser,
	);
	assert.equal(git(fixture.repository, "rev-parse", "HEAD"), targetBeforeLoser);
	assert.equal(fixture.fake.effects, effectsBeforeLoser);
	writeFileSync(barrier.release, "release\n");
	assert.deepEqual(await barrier.child, { code: 0, signal: null, stderr: "" });
	assert.equal(
		readFileSync(barrier.effectsPath, "utf8").trim().split("\n").filter(Boolean)
			.length,
		1,
	);
	assert.equal(
		privateDocuments(fixture.stateRoot).filter(
			({ value }) =>
				value.operation_type === "run.archive" && value.phase === "observed",
		).length,
		1,
	);
});

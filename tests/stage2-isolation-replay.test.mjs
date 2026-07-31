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
import { reconcile } from "../scripts/stage1-runtime.mjs";
import { canonicalJson } from "../scripts/private-state-schema.mjs";
import { parseTaskBytes } from "../scripts/task-report-schema.mjs";
import {
	assembledFixture,
	context,
	deterministicRandom,
	git,
	privateDocuments,
	publishWorkerReport,
} from "./stage1-runtime-helpers.mjs";

const lifecycleChild = fileURLToPath(
	new URL("./fixtures/b3-crash-child.mjs", import.meta.url),
);
function runChild(args) {
	return new Promise((resolvePromise) => {
		const child = spawn(process.execPath, [lifecycleChild, ...args], {
			stdio: ["ignore", "ignore", "pipe"],
		});
		let stderr = "";
		child.stderr.on("data", (bytes) => (stderr += bytes));
		child.on("exit", (code, signal) =>
			resolvePromise({ code, signal, stderr }),
		);
	});
}
function containsWorkspace(value, workspace) {
	if (!value || typeof value !== "object") return false;
	if (!Array.isArray(value) && value.workspace_id === workspace) return true;
	return Object.values(value).some((child) =>
		containsWorkspace(child, workspace),
	);
}

const roles = [
	{
		name: "builder",
		contract_role: "builder",
		kind: "codex",
		mode: "write",
	},
];
async function deliveredFixture(seed) {
	const fixture = await assembledFixture({ roles, seed });
	const worker = fixture.result.workers[0];
	mkdirSync(join(worker.cwd, "src"));
	writeFileSync(
		join(worker.cwd, "src", "delivery.mjs"),
		`export default ${seed};\n`,
	);
	git(worker.cwd, "add", "src/delivery.mjs");
	git(worker.cwd, "commit", "-qm", "delivery");
	await publishWorkerReport(fixture, worker);
	return fixture;
}

test("colliding logical role names remain isolated across physical repositories", async () => {
	const first = await deliveredFixture(21);
	const second = await deliveredFixture(41);
	const secondBefore = canonicalJson(privateDocuments(second.stateRoot));
	await reconcile({
		contextJson: context(first.repository, first.workspace),
		stateRoot: first.stateRoot,
		exec: first.fake.exec,
		herdrBin: "fake",
		random: deterministicRandom(200),
	});
	assert.equal(canonicalJson(privateDocuments(second.stateRoot)), secondBefore);
	assert.notEqual(
		git(first.repository, "rev-parse", "HEAD"),
		git(second.repository, "rev-parse", "HEAD"),
	);
});

test("two active workspaces sharing one repository isolate colliding task/report generations through collection", async () => {
	const collidingRandom = (runByte) => {
		let calls = 0;
		return (size) => {
			const call = calls++;
			return Buffer.alloc(size, call === 0 ? runByte : 0x70 + call);
		};
	};
	const first = await assembledFixture({
		workspace: "workspace-a",
		random: collidingRandom(0x21),
	});
	const second = await assembledFixture({
		repository: first.repository,
		stateRoot: first.stateRoot,
		workspace: "workspace-b",
		random: collidingRandom(0x41),
	});
	const firstWorker = first.result.workers[0];
	const secondWorker = second.result.workers[0];
	const firstTask = parseTaskBytes(readFileSync(firstWorker.task_path));
	const secondTask = parseTaskBytes(readFileSync(secondWorker.task_path));
	assert.equal(firstWorker.role, secondWorker.role);
	assert.notEqual(first.result.run_id, second.result.run_id);
	assert.equal(firstTask.task_generation, secondTask.task_generation);
	assert.equal(firstTask.report_generation, secondTask.report_generation);
	for (const [fixture, worker, value] of [
		[first, firstWorker, 21],
		[second, secondWorker, 41],
	]) {
		mkdirSync(join(worker.cwd, "src"));
		writeFileSync(
			join(worker.cwd, "src", "delivery.mjs"),
			`export default ${value};\n`,
		);
		git(worker.cwd, "add", "src/delivery.mjs");
		git(worker.cwd, "commit", "-qm", `workspace ${value}`);
		await publishWorkerReport(fixture, worker);
	}
	const workspaceBytes = (workspace) =>
		canonicalJson(
			privateDocuments(first.stateRoot).filter(({ value }) =>
				containsWorkspace(value, workspace),
			),
		);
	const sharedBytes = () =>
		canonicalJson({
			head: git(first.repository, "rev-parse", "HEAD"),
			refs: git(
				first.repository,
				"for-each-ref",
				"--format=%(refname):%(objectname)",
			),
			documents: privateDocuments(first.stateRoot).filter(
				({ value }) =>
					!containsWorkspace(value, first.workspace) &&
					!containsWorkspace(value, second.workspace),
			),
		});
	const directory = mkdtempSync(join(tmpdir(), "conductor-isolation-barrier-"));
	const livePath = join(directory, "live.json");
	const effectsPath = join(directory, "effects.log");
	const ready = join(directory, "ready");
	const release = join(directory, "release");
	writeFileSync(
		livePath,
		JSON.stringify({
			panes: {
				...Object.fromEntries(first.fake.panes),
				...Object.fromEntries(second.fake.panes),
			},
			agents: {
				...Object.fromEntries(first.fake.agents),
				...Object.fromEntries(second.fake.agents),
			},
		}),
	);
	writeFileSync(effectsPath, "");
	const winner = runChild([
		"lifecycle",
		first.repository,
		first.stateRoot,
		first.workspace,
		livePath,
		effectsPath,
		"integration.reconcile:integration.before_cas",
		ready,
		release,
	]);
	for (let attempt = 0; attempt < 1_000 && !existsSync(ready); attempt++)
		await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
	assert.equal(existsSync(ready), true, "winner did not reach CAS barrier");
	const loserBefore = workspaceBytes(second.workspace);
	const winnerBeforeLoser = workspaceBytes(first.workspace);
	const sharedBeforeLoser = sharedBytes();
	await assert.rejects(
		() =>
			reconcile({
				contextJson: context(second.repository, second.workspace),
				stateRoot: second.stateRoot,
				exec: second.fake.exec,
				herdrBin: "fake",
				random: deterministicRandom(220),
			}),
		(error) => error.code === "lock_busy",
	);
	assert.equal(workspaceBytes(second.workspace), loserBefore);
	assert.equal(workspaceBytes(first.workspace), winnerBeforeLoser);
	assert.equal(sharedBytes(), sharedBeforeLoser);
	writeFileSync(release, "release\n");
	assert.deepEqual(await winner, { code: 0, signal: null, stderr: "" });
	assert.equal(
		readFileSync(effectsPath, "utf8").trim().split("\n").filter(Boolean).length,
		1,
	);
	assert.equal(
		privateDocuments(first.stateRoot).filter(
			({ value }) =>
				value.operation_type === "integration.reconcile" &&
				value.phase === "observed",
		).length,
		1,
	);
});

test("exact observed integration replay returns stable authority without a second target movement", async () => {
	const fixture = await deliveredFixture(61);
	const options = {
		contextJson: context(fixture.repository, fixture.workspace),
		stateRoot: fixture.stateRoot,
		exec: fixture.fake.exec,
		herdrBin: "fake",
		random: deterministicRandom(220),
	};
	const first = await reconcile(options);
	const target = git(fixture.repository, "rev-parse", "HEAD");
	const operationCount = privateDocuments(fixture.stateRoot).filter(
		({ value }) => value.operation_type === "integration.reconcile",
	).length;
	const second = await reconcile(options);
	assert.equal(git(fixture.repository, "rev-parse", "HEAD"), target);
	assert.equal(second.integration.final_sha, first.integration.final_sha);
	assert.equal(
		privateDocuments(fixture.stateRoot).filter(
			({ value }) => value.operation_type === "integration.reconcile",
		).length,
		operationCount,
	);
});

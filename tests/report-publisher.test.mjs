import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import {
	canonicalJson,
	StateKernelError,
} from "../scripts/private-state-schema.mjs";
import {
	digestReportDraftFromStdin,
	publishReportFromCliStdin,
	publishReportFromStdin,
	readBoundedReportInput,
	scanRawReportSlot,
} from "../scripts/report-publisher.mjs";
import { stage2ContractFixture } from "./stage2-runtime-helpers.mjs";
import {
	assembledFixture,
	buildWorkerReport,
} from "./stage1-runtime-helpers.mjs";
import {
	acquireRepositoryLock,
	inspectRepositoryLock,
	openRepositoryStore,
	releaseRepositoryLock,
} from "../scripts/state-kernel.mjs";

const roots = [];
function fixture() {
	const root = mkdtempSync(join(tmpdir(), "conductor-stage2-publisher-"));
	roots.push(root);
	const outbox = join(root, "outbox");
	mkdirSync(outbox, { mode: 0o700 });
	const contract = stage2ContractFixture({ outboxRoot: outbox });
	const slot = join(outbox, contract.task.outbox.slot_name);
	mkdirSync(slot, { mode: 0o700 });
	return {
		root,
		slot,
		...contract,
		authorizeTask: () => ({ task: contract.task }),
	};
}
process.on("exit", () =>
	roots.forEach((path) => rmSync(path, { recursive: true, force: true })),
);
const input = (bytes) => Readable.from([bytes]);
function code(expected, promise) {
	return assert.rejects(
		promise,
		(error) => error instanceof StateKernelError && error.code === expected,
	);
}

test("bounded stdin requires actual EOF and maps oversize/read errors", async () => {
	assert.equal(
		(await readBoundedReportInput(input(Buffer.from("ok")))).toString(),
		"ok",
	);
	await code(
		"input_too_large",
		readBoundedReportInput(input(Buffer.alloc(12)), { maxBytes: 11 }),
	);
	await code(
		"input_read_error",
		readBoundedReportInput(
			(async function* () {
				yield Buffer.from("prefix");
				throw new Error("aborted");
			})(),
		),
	);
});

test("digest is read-only and publish validates everything before outbox mutation", async () => {
	const value = fixture();
	assert.equal(
		await digestReportDraftFromStdin({
			input: input(Buffer.from(canonicalJson(value.draft))),
			authorizeTask: value.authorizeTask,
		}),
		`${value.report.report_digest}\n`,
	);
	assert.deepEqual(readdirSync(value.slot), []);
	await code(
		"invalid_json",
		publishReportFromStdin({
			input: input(Buffer.from("{")),
			authorizeTask: value.authorizeTask,
			stateRoot: value.root,
		}),
	);
	assert.deepEqual(readdirSync(value.slot), []);
	await code(
		"digest_mismatch",
		publishReportFromStdin({
			input: input(Buffer.from(JSON.stringify(value.report))),
			authorizeTask: value.authorizeTask,
			stateRoot: value.root,
		}),
	);
	assert.deepEqual(readdirSync(value.slot), []);
});

test("publisher CLI holds the physical repository lock through validation and publication", async () => {
	const assembled = await assembledFixture();
	const worker = assembled.result.workers[0];
	const store = openRepositoryStore({
		stateRoot: assembled.stateRoot,
		repoPath: assembled.repository,
	});
	const held = acquireRepositoryLock(store, {
		operationId: "publisher-contention",
	});
	await code(
		"lock_busy",
		publishReportFromCliStdin({
			taskPath: worker.task_path,
			configPath: join(assembled.repository, ".herdr-conductor.json"),
			input: input(Buffer.from("{}\n")),
		}),
	);
	releaseRepositoryLock(held);
	const { report } = await buildWorkerReport(assembled, worker);
	let lockedPublicationCheckpoints = 0;
	const published = await publishReportFromCliStdin({
		taskPath: worker.task_path,
		configPath: join(assembled.repository, ".herdr-conductor.json"),
		input: input(Buffer.from(canonicalJson(report))),
		fault(name) {
			if (!name.startsWith("publisher_")) return;
			lockedPublicationCheckpoints++;
			assert.equal(inspectRepositoryLock(store).status, "locked");
		},
	});
	assert.equal(published.reportDigest, report.report_digest);
	assert.ok(lockedPublicationCheckpoints > 0);
	assert.equal(inspectRepositoryLock(store).status, "unlocked");
});

test("publisher commits exact payload and marker and refuses replay", async () => {
	const value = fixture();
	const result = await publishReportFromStdin({
		input: input(Buffer.from(canonicalJson(value.report))),
		authorizeTask: value.authorizeTask,
		stateRoot: value.root,
		random: () => Buffer.alloc(16, 7),
	});
	assert.equal(result.reportDigest, value.report.report_digest);
	assert.deepEqual(readdirSync(value.slot).sort(), [
		"COMMITTED.json",
		"report.json",
	]);
	assert.equal(
		scanRawReportSlot(value.slot, { stateRoot: value.root, task: value.task })
			.state,
		"raw_committed",
	);
	await code(
		"replay_refused",
		publishReportFromStdin({
			input: input(Buffer.from(canonicalJson(value.report))),
			authorizeTask: value.authorizeTask,
			stateRoot: value.root,
		}),
	);
});

import test from "node:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import {
	applyStage3,
	preview,
	reconcile,
} from "../scripts/stage1-runtime.mjs";
import { recordApprovalFromStdin } from "../scripts/approval-recorder.mjs";
import {
	STAGE3_APPROVAL_STATEMENTS,
	canonicalJson,
} from "../scripts/private-state-schema.mjs";
import {
	assert,
	assembledFixture,
	context,
	deterministicRandom,
	expectCodeAsync,
	git,
	publishWorkerReport,
} from "./stage1-runtime-helpers.mjs";

const APPLY_TARGET = "refs/heads/release";
const producerRoles = () => [
	{ name: "builder", contract_role: "builder", kind: "pi", mode: "write" },
];
const applyOverrides = { version: 3, apply: { target_ref: APPLY_TARGET } };

async function harvestedApplyFixture(seed = 1) {
	const fixture = await assembledFixture({
		roles: producerRoles(),
		seed,
		configOverrides: structuredClone(applyOverrides),
	});
	git(fixture.repository, "update-ref", APPLY_TARGET, fixture.result.fork_sha);
	const producer = fixture.result.workers[0];
	mkdirSync(join(producer.cwd, "src"));
	writeFileSync(join(producer.cwd, "src", "feature.mjs"), "export default 1;\n");
	git(producer.cwd, "add", "src/feature.mjs");
	git(producer.cwd, "commit", "-qm", "feature");
	await publishWorkerReport(fixture, producer);
	const harvested = await reconcile({
		contextJson: context(fixture.repository, fixture.workspace),
		exec: fixture.fake.exec,
		herdrBin: "fake",
		random: deterministicRandom(40 + seed),
	});
	assert.equal(harvested.lifecycle, "integration_harvested_no_gates");
	return { fixture, harvested };
}

function invocation(fixture, extra = {}) {
	return {
		contextJson: context(fixture.repository, fixture.workspace),
		exec: fixture.fake.exec,
		herdrBin: "fake",
		...extra,
	};
}

function receiptFor(previewResult, decision) {
	const identity = previewResult.preview;
	return {
		document_type: "herdr-conductor-stage3-approval",
		schema_version: 1,
		repository_key: identity.repository_key,
		workspace_id: identity.workspace_id,
		run_id: identity.run_id,
		run_generation: identity.run_generation,
		attempt_generation: identity.attempt_generation,
		preview_entry_digest: previewResult.preview_entry_digest,
		decision,
		statement: STAGE3_APPROVAL_STATEMENTS[decision],
	};
}

function record(fixture, receipt) {
	return recordApprovalFromStdin({
		configPath: join(fixture.repository, ".herdr-conductor.json"),
		input: Readable.from([Buffer.from(canonicalJson(receipt))]),
		exec: fixture.fake.exec,
	});
}

function applyCasCount(fixture) {
	return fixture.fake.log.filter(
		({ command, args }) =>
			command === "git" &&
			args.includes("update-ref") &&
			args.includes(APPLY_TARGET),
	).length;
}

test("preview, approval, consumption, and apply move the target exactly once", async () => {
	const { fixture, harvested } = await harvestedApplyFixture(1);
	const effectsBeforePreview = fixture.fake.effects;
	const previewed = await preview(invocation(fixture));
	assert.equal(previewed.lifecycle, "apply_previewed");
	assert.equal(fixture.fake.effects, effectsBeforePreview);
	assert.equal(previewed.replayed, false);
	assert.equal(
		previewed.preview.integration.final_sha,
		harvested.integration.final_sha,
	);
	assert.equal(
		previewed.preview.apply.observed_sha,
		harvested.integration.starting_sha,
	);
	assert.equal(previewed.preview.apply.changed_path_count, 1);
	assert.deepEqual(previewed.preview.gates, []);
	assert.match(previewed.approval_command, /approval-recorder\.mjs/);
	const replayedPreview = await preview(invocation(fixture));
	assert.equal(replayedPreview.replayed, true);
	assert.equal(
		replayedPreview.preview_entry_digest,
		previewed.preview_entry_digest,
	);
	const recorded = await record(fixture, receiptFor(previewed, "approve"));
	assert.equal(recorded.decision, "approve");
	await expectCodeAsync("replay_refused", () =>
		record(fixture, receiptFor(previewed, "approve")),
	);
	await expectCodeAsync("operation_conflict", () =>
		record(fixture, receiptFor(previewed, "reject")),
	);
	const applied = await applyStage3(invocation(fixture));
	assert.equal(applied.lifecycle, "applied");
	assert.equal(applied.apply.outcome, "applied");
	assert.equal(applied.apply.cas_count, 1);
	assert.equal(
		git(fixture.repository, "rev-parse", APPLY_TARGET),
		harvested.integration.final_sha,
	);
	assert.equal(applyCasCount(fixture), 1);
	const replayedApply = await applyStage3(invocation(fixture));
	assert.equal(replayedApply.lifecycle, "applied");
	assert.equal(replayedApply.replayed, true);
	assert.equal(applyCasCount(fixture), 1);
	const appliedPreview = await preview(invocation(fixture));
	assert.equal(appliedPreview.lifecycle, "applied");
	assert.equal(appliedPreview.replayed, true);
});

test("stage3 actions refuse configuration v2 and premature lifecycles", async () => {
	const v2 = await assembledFixture({ roles: producerRoles(), seed: 7 });
	await expectCodeAsync("capability_unavailable", () =>
		preview(invocation(v2)),
	);
	await expectCodeAsync("capability_unavailable", () =>
		applyStage3(invocation(v2)),
	);
	const v3 = await assembledFixture({
		roles: producerRoles(),
		seed: 8,
		configOverrides: structuredClone(applyOverrides),
	});
	git(v3.repository, "update-ref", APPLY_TARGET, v3.result.fork_sha);
	await expectCodeAsync("operation_conflict", () => preview(invocation(v3)));
	await expectCodeAsync("operation_conflict", () =>
		applyStage3(invocation(v3)),
	);
});

test("a reject receipt closes the attempt and a fresh attempt applies", async () => {
	const { fixture, harvested } = await harvestedApplyFixture(2);
	const previewed = await preview(invocation(fixture));
	const rejected = await record(fixture, receiptFor(previewed, "reject"));
	assert.equal(rejected.decision, "reject");
	await expectCodeAsync("operation_conflict", () =>
		applyStage3(invocation(fixture)),
	);
	const second = await preview(invocation(fixture));
	assert.equal(second.lifecycle, "apply_previewed");
	assert.notEqual(
		second.preview.attempt_generation,
		previewed.preview.attempt_generation,
	);
	await record(fixture, receiptFor(second, "approve"));
	const applied = await applyStage3(invocation(fixture));
	assert.equal(applied.lifecycle, "applied");
	assert.equal(
		git(fixture.repository, "rev-parse", APPLY_TARGET),
		harvested.integration.final_sha,
	);
	assert.equal(applyCasCount(fixture), 1);
});

test("approval and apply refuse a drifted target with zero CAS", async () => {
	const { fixture, harvested } = await harvestedApplyFixture(3);
	const previewed = await preview(invocation(fixture));
	git(fixture.repository, "update-ref", APPLY_TARGET, harvested.integration.final_sha);
	await expectCodeAsync("stale_source", () =>
		record(fixture, receiptFor(previewed, "approve")),
	);
	const rejected = await record(fixture, receiptFor(previewed, "reject"));
	assert.equal(rejected.decision, "reject");
	assert.equal(applyCasCount(fixture), 0);
	const drifted = await harvestedApplyFixture(4);
	const driftedPreview = await preview(invocation(drifted.fixture));
	await record(drifted.fixture, receiptFor(driftedPreview, "approve"));
	git(
		drifted.fixture.repository,
		"update-ref",
		APPLY_TARGET,
		drifted.harvested.integration.final_sha,
	);
	await expectCodeAsync("stale_source", () =>
		applyStage3(invocation(drifted.fixture)),
	);
	assert.equal(applyCasCount(drifted.fixture), 0);
});

test("stale receipts and foreign digests are refused exactly", async () => {
	const { fixture } = await harvestedApplyFixture(5);
	const previewed = await preview(invocation(fixture));
	await expectCodeAsync("digest_mismatch", () =>
		record(fixture, {
			...receiptFor(previewed, "approve"),
			preview_entry_digest: "9".repeat(64),
		}),
	);
	await expectCodeAsync("stale_task", () =>
		record(fixture, {
			...receiptFor(previewed, "approve"),
			attempt_generation: "9".repeat(32),
		}),
	);
	await expectCodeAsync("invalid_state", () =>
		record(fixture, {
			...receiptFor(previewed, "approve"),
			statement: STAGE3_APPROVAL_STATEMENTS.reject,
		}),
	);
	await expectCodeAsync("digest_mismatch", () =>
		recordApprovalFromStdin({
			configPath: join(fixture.repository, ".herdr-conductor.json"),
			input: Readable.from([
				Buffer.from(`${JSON.stringify(receiptFor(previewed, "approve"))}`),
			]),
			exec: fixture.fake.exec,
		}),
	);
});

test("a crash before the CAS voids the attempt and recovery re-arms apply", async () => {
	const { fixture, harvested } = await harvestedApplyFixture(6);
	const previewed = await preview(invocation(fixture));
	await record(fixture, receiptFor(previewed, "approve"));
	await expectCodeAsync("recovery_required", () =>
		applyStage3(
			invocation(fixture, {
				fault: (name) => {
					if (name === "apply.before_cas") throw new Error("killed before CAS");
				},
			}),
		),
	);
	assert.equal(
		git(fixture.repository, "rev-parse", APPLY_TARGET),
		harvested.integration.starting_sha,
	);
	const resolved = await applyStage3(invocation(fixture));
	assert.equal(resolved.lifecycle, "apply_voided");
	assert.equal(resolved.resolved, true);
	assert.equal(resolved.apply.outcome, "unapplied");
	assert.equal(resolved.apply.cas_count, 0);
	assert.equal(applyCasCount(fixture), 0);
	const second = await preview(invocation(fixture));
	assert.equal(second.lifecycle, "apply_previewed");
	await record(fixture, receiptFor(second, "approve"));
	const applied = await applyStage3(invocation(fixture));
	assert.equal(applied.lifecycle, "applied");
	assert.equal(
		git(fixture.repository, "rev-parse", APPLY_TARGET),
		harvested.integration.final_sha,
	);
	assert.equal(applyCasCount(fixture), 1);
});

test("a crash after the CAS resolves to applied without a second CAS", async () => {
	const { fixture, harvested } = await harvestedApplyFixture(9);
	const previewed = await preview(invocation(fixture));
	await record(fixture, receiptFor(previewed, "approve"));
	await expectCodeAsync("recovery_required", () =>
		applyStage3(
			invocation(fixture, {
				fault: (name) => {
					if (name === "apply.after_cas") throw new Error("killed after CAS");
				},
			}),
		),
	);
	assert.equal(
		git(fixture.repository, "rev-parse", APPLY_TARGET),
		harvested.integration.final_sha,
	);
	const resolved = await applyStage3(invocation(fixture));
	assert.equal(resolved.lifecycle, "applied");
	assert.equal(resolved.resolved, true);
	assert.equal(resolved.apply.outcome, "applied");
	assert.equal(resolved.apply.cas_count, 1);
	assert.equal(applyCasCount(fixture), 1);
	const replayed = await applyStage3(invocation(fixture));
	assert.equal(replayed.lifecycle, "applied");
	assert.equal(applyCasCount(fixture), 1);
});

import test from "node:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
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
	acquireRepositoryLock,
	loadActiveRun,
	openRepositoryStore,
	releaseRepositoryLock,
} from "../scripts/state-kernel.mjs";
import {
	assert,
	assembledFixture,
	context,
	deterministicRandom,
	expectCode,
	expectCodeAsync,
	git,
	privateDocuments,
	publishWorkerReport,
} from "./stage1-runtime-helpers.mjs";

const fixtureChild = fileURLToPath(
	new URL("./fixtures/stage3-crash-child.mjs", import.meta.url),
);
const APPLY_TARGET = "refs/heads/release";

async function approvedApplyFixture(seed) {
	const fixture = await assembledFixture({
		roles: [
			{ name: "builder", contract_role: "builder", kind: "pi", mode: "write" },
		],
		seed,
		configOverrides: {
			version: 3,
			apply: { target_ref: APPLY_TARGET },
		},
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
		random: deterministicRandom(90 + seed),
	});
	assert.equal(harvested.lifecycle, "integration_harvested_no_gates");
	const invocation = {
		contextJson: context(fixture.repository, fixture.workspace),
		exec: fixture.fake.exec,
		herdrBin: "fake",
	};
	const previewed = await preview(invocation);
	const identity = previewed.preview;
	await recordApprovalFromStdin({
		configPath: join(fixture.repository, ".herdr-conductor.json"),
		input: Readable.from([
			Buffer.from(
				canonicalJson({
					document_type: "herdr-conductor-stage3-approval",
					schema_version: 1,
					repository_key: identity.repository_key,
					workspace_id: identity.workspace_id,
					run_id: identity.run_id,
					run_generation: identity.run_generation,
					attempt_generation: identity.attempt_generation,
					preview_entry_digest: previewed.preview_entry_digest,
					decision: "approve",
					statement: STAGE3_APPROVAL_STATEMENTS.approve,
				}),
			),
		]),
		exec: fixture.fake.exec,
	});
	return { fixture, harvested, invocation };
}

function killedApply(fixture, boundary) {
	const child = spawnSync(
		process.execPath,
		[fixtureChild, fixture.repository, fixture.workspace, boundary],
		{ encoding: "utf8", timeout: 30_000 },
	);
	assert.equal(child.signal, "SIGKILL", `${boundary}: ${child.stderr}`);
	return child;
}

function retainedApplyPublication(fixture) {
	const documents = privateDocuments(fixture.stateRoot);
	const entries = documents.filter(
		({ path, value }) =>
			path.includes("/operations/") &&
			value.operation_type === "apply.publish",
	);
	const guards = documents.filter(
		({ path, value }) =>
			path.includes("/operation-guards/") &&
			value.operation_type === "apply.publish",
	);
	return { entries, guards };
}

test("true SIGKILL before the apply CAS retains an exact resolvable intent", async () => {
	const { fixture, harvested, invocation } = await approvedApplyFixture(21);
	killedApply(fixture, "apply.before_cas");
	assert.equal(
		git(fixture.repository, "rev-parse", APPLY_TARGET),
		harvested.integration.starting_sha,
	);
	const retained = retainedApplyPublication(fixture);
	assert.equal(retained.entries.length, 1);
	assert.equal(retained.entries[0].value.phase, "intent");
	assert.equal(retained.guards.length, 1);
	const store = openRepositoryStore({
		stateRoot: fixture.stateRoot,
		repoPath: fixture.repository,
	});
	expectCode("recovery_required", () =>
		loadActiveRun(store, { workspaceId: fixture.workspace }),
	);
	const resolved = await applyStage3(invocation);
	assert.equal(resolved.lifecycle, "apply_voided");
	assert.equal(resolved.resolved, true);
	assert.equal(resolved.apply.outcome, "unapplied");
	assert.equal(resolved.apply.cas_count, 0);
	assert.equal(
		git(fixture.repository, "rev-parse", APPLY_TARGET),
		harvested.integration.starting_sha,
	);
	const after = retainedApplyPublication(fixture);
	assert.equal(after.entries[0].value.phase, "observed");
	assert.equal(after.guards.length, 0);
});

test("true SIGKILL after the apply CAS resolves to applied without replay", async () => {
	const { fixture, harvested, invocation } = await approvedApplyFixture(22);
	killedApply(fixture, "apply.after_cas");
	assert.equal(
		git(fixture.repository, "rev-parse", APPLY_TARGET),
		harvested.integration.final_sha,
	);
	const retained = retainedApplyPublication(fixture);
	assert.equal(retained.entries.length, 1);
	assert.equal(retained.entries[0].value.phase, "intent");
	assert.equal(retained.guards.length, 1);
	const resolved = await applyStage3(invocation);
	assert.equal(resolved.lifecycle, "applied");
	assert.equal(resolved.resolved, true);
	assert.equal(resolved.apply.outcome, "applied");
	assert.equal(resolved.apply.cas_count, 1);
	assert.equal(
		git(fixture.repository, "rev-parse", APPLY_TARGET),
		harvested.integration.final_sha,
	);
	const replayed = await applyStage3(invocation);
	assert.equal(replayed.lifecycle, "applied");
	assert.equal(replayed.replayed, true);
});

test("true SIGKILL at the durable intent resolves without a guard", async () => {
	const { fixture, harvested, invocation } = await approvedApplyFixture(23);
	killedApply(fixture, "apply.publish:journal.after_intent_durable");
	assert.equal(
		git(fixture.repository, "rev-parse", APPLY_TARGET),
		harvested.integration.starting_sha,
	);
	const retained = retainedApplyPublication(fixture);
	assert.equal(retained.entries.length, 1);
	assert.equal(retained.entries[0].value.phase, "intent");
	assert.equal(retained.guards.length, 0);
	const resolved = await applyStage3(invocation);
	assert.equal(resolved.lifecycle, "apply_voided");
	assert.equal(resolved.apply.outcome, "unapplied");
});

test("a foreign SHA on the uncertain apply target refuses resolution forever", async () => {
	const { fixture, harvested, invocation } = await approvedApplyFixture(24);
	killedApply(fixture, "apply.before_cas");
	const startingTree = git(
		fixture.repository,
		"rev-parse",
		`${harvested.integration.starting_sha}^{tree}`,
	);
	const foreign = git(
		fixture.repository,
		"commit-tree",
		startingTree,
		"-p",
		harvested.integration.starting_sha,
		"-m",
		"foreign",
	);
	git(fixture.repository, "update-ref", APPLY_TARGET, foreign);
	await expectCodeAsync("foreign_or_stale", () => applyStage3(invocation));
	const retained = retainedApplyPublication(fixture);
	assert.equal(retained.entries[0].value.phase, "intent");
	assert.equal(retained.guards.length, 1);
	git(
		fixture.repository,
		"update-ref",
		APPLY_TARGET,
		harvested.integration.starting_sha,
	);
	const resolved = await applyStage3(invocation);
	assert.equal(resolved.lifecycle, "apply_voided");
});

test("a held repository lock refuses preview and apply without effects", async () => {
	const { fixture, harvested, invocation } = await approvedApplyFixture(25);
	const store = openRepositoryStore({
		stateRoot: fixture.stateRoot,
		repoPath: fixture.repository,
	});
	const lock = acquireRepositoryLock(store, { operationId: "competing-owner" });
	try {
		await expectCodeAsync("lock_busy", () => applyStage3(invocation));
		await expectCodeAsync("lock_busy", () => preview(invocation));
	} finally {
		releaseRepositoryLock(lock);
	}
	assert.equal(
		git(fixture.repository, "rev-parse", APPLY_TARGET),
		harvested.integration.starting_sha,
	);
	const applied = await applyStage3(invocation);
	assert.equal(applied.lifecycle, "applied");
});

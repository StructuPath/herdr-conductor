import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import {
	chmodSync,
	closeSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	realpathSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJson } from "../scripts/private-state-schema.mjs";
import {
	buildStage2SourceManifest,
	STAGE2_RUNTIME_SOURCE_DEFINITION,
	STAGE2_EVIDENCE_PATHS,
	assertSanitizedEvidence,
	evidenceCompletionDigest,
	externalReviewDigest,
	finalizePrivateEvidenceTrio,
	outputParentBinding,
	publishPrivateEvidenceTrio,
	renderStage2EvidenceReport,
	stage2SourceDefinitionDigest,
	validateEvidenceBytes,
	validateExternalReviewRecord,
	sensitivePathComponents,
} from "../scripts/stage2-evidence-contract.mjs";
import { checkCommittedEvidence } from "../scripts/check-stage2-live-evidence.mjs";
import { validatePrivateOutputParent } from "../scripts/harness-teardown.mjs";
import {
	STAGE2_LIVE_ACTION_SEQUENCE,
	STAGE2_LIVE_EXECUTION_PLAN,
	createForbiddenEffectTracker,
	createStage2LivePlanDriver,
	exactObservedProducerSelection,
	liveForbiddenEffectSnapshot,
	observedPluginState,
	pluginRestorationArguments,
	workspaceAbsentObservation,
} from "../scripts/run-stage2-live-evidence.mjs";
const hash = (value) => createHash("sha256").update(value).digest("hex");
const candidate = "1".repeat(40);
function trio(
	candidateSha = candidate,
	sourceOverride = null,
	binding = "b".repeat(64),
) {
	const source = sourceOverride ?? {
		document_type: "herdr-conductor-stage2-runtime-source-manifest",
		schema_version: 1,
		source_definition_id: STAGE2_RUNTIME_SOURCE_DEFINITION.id,
		source_definition_version: 1,
		source_definition_sha256: stage2SourceDefinitionDigest(),
		candidate_sha: candidateSha,
		entry_count: STAGE2_RUNTIME_SOURCE_DEFINITION.paths.length,
		files: STAGE2_RUNTIME_SOURCE_DEFINITION.paths.map((path) => ({
			path,
			sha256: "a".repeat(64),
		})),
	};
	const sourceBytes = Buffer.from(canonicalJson(source));
	const paths = source.files.map(({ path }) => path);
	const reviewBase = {
		document_type: "herdr-conductor-external-review",
		schema_version: 1,
		review_id: "stage2-independent-human-go-review",
		candidate: {
			commit_sha: candidateSha,
			source_definition_id: STAGE2_RUNTIME_SOURCE_DEFINITION.id,
			source_definition_version: 1,
			source_definition_sha256: stage2SourceDefinitionDigest(),
			source_manifest_filename: "stage2-runtime-source-manifest.json",
			source_manifest_sha256: hash(sourceBytes),
			source_manifest_entry_count: source.entry_count,
		},
		reviewed_scope: {
			kind: "complete_candidate_source_manifest",
			paths,
			scope_sha256: createHash("sha256")
				.update("herdr-conductor-review-scope-v1\0")
				.update(canonicalJson(paths))
				.digest("hex"),
		},
		reviewer_assertions: {
			reviewer_kind: "independent_external_human",
			independence: "independent_of_implementation_authorship",
			decision: "go",
		},
		findings: [],
		completed_at: "2026-07-29T12:00:00.000Z",
	};
	const review = {
		...reviewBase,
		review_record_sha256: externalReviewDigest(reviewBase),
	};
	const preimage = {
		document_type: "herdr-conductor-stage2-live-evidence",
		schema_version: 1,
		candidate_sha: candidateSha,
		run_id: "run-1",
		source_manifest_sha256: hash(sourceBytes),
		output_parent_binding: binding,
		output_files: {
			source_manifest: "stage2-runtime-source-manifest.json",
			human_report: "2026-07-28-stage2-live-contracts.md",
			machine_evidence: "2026-07-28-stage2-live-contracts.json",
		},
		cleanup_result: {
			status: "passed",
			root_absent: true,
			workspace_absent: true,
			state_absent: true,
			out_of_root_deletion_count: 0,
			unlisted_residue_count: 0,
		},
		external_review: review,
		external_review_digest: review.review_record_sha256,
		runtime_summary: {
			herdr_version: "0.7.5",
			protocol_version: 17,
			api_schema_version: 1,
			action_sequence: [
				"assemble",
				"board",
				"status",
				"harvest",
				"harvest",
				"stand-down",
			],
			producer_selection_sha256: "c".repeat(64),
			final_integration_sha: "2".repeat(40),
			gate_shas: ["2".repeat(40)],
			task_report_digests: [
				{
					role: "builder",
					task_digest: "1".repeat(64),
					report_digest: "2".repeat(64),
					assertion_strength: "unauthenticated_worker_assertion",
				},
				{
					role: "validator",
					task_digest: "3".repeat(64),
					report_digest: "4".repeat(64),
					assertion_strength: "unauthenticated_worker_assertion",
				},
			],
			task_count: 2,
			report_count: 2,
			gate_count: 1,
			journal_head: "d".repeat(64),
			journal_entry_count: 10,
			retained_inventory_sha256: "e".repeat(64),
			retained_inventory_count: 20,
			refusal_snapshot_sha256: "f".repeat(64),
			integration_cas_count: 1,
			forbidden_effect_count: 0,
		},
	};
	const humanBytes = renderStage2EvidenceReport(preimage);
	const machine = { ...preimage, human_report_sha256: hash(humanBytes) };
	const machineBytes = Buffer.from(canonicalJson(machine));
	return { sourceBytes, humanBytes, machineBytes, review };
}
test("recording installed-action seam executes the complete declarative live plan", () => {
	const actions = [];
	const evidence = [];
	const driver = createStage2LivePlanDriver((action) => {
		actions.push(action);
		return { action, installed: true };
	});
	for (const step of STAGE2_LIVE_EXECUTION_PLAN)
		driver.run(
			step.id,
			step.kind === "installed_action"
				? undefined
				: () => evidence.push({ id: step.id, kind: step.kind }),
		);
	const observed = driver.finish();
	assert.deepEqual(actions, [
		"assemble",
		"board",
		"status",
		"harvest",
		"harvest",
		"stand-down",
	]);
	assert.deepEqual(observed.actionSequence, STAGE2_LIVE_ACTION_SEQUENCE);
	assert.equal(actions.filter((action) => action === "harvest").length, 2);
	assert.equal(actions.at(-1), "stand-down");
	assert.deepEqual(
		evidence.filter(({ kind }) => kind === "refusal_probe").map(({ id }) => id),
		[
			"foreign_workspace_refusals",
			"producer_path_refusal",
			"producer_source_refusal",
			"producer_digest_refusal",
			"producer_replay_refusal",
			"gate_source_refusal",
			"gate_digest_refusal",
		],
	);
	assert.deepEqual(
		evidence
			.filter(({ kind }) => kind === "effect_evidence")
			.map(({ id }) => id),
		["producer_publish", "gate_publish", "retained_effect_evidence"],
	);
});

test("realistic reconciliation evidence requires the exact complete producer selection", () => {
	const expected = [
		{
			role_name: "builder",
			task_digest: "1".repeat(64),
			report_digest: "2".repeat(64),
			source_sha: "3".repeat(40),
			tree_sha: "4".repeat(40),
			source_generation: "5".repeat(32),
		},
	];
	const entries = [
		{
			operation_type: "integration.reconcile",
			phase: "observed",
			observed_identity: { selection: expected },
		},
	];
	assert.deepEqual(exactObservedProducerSelection(entries, expected), expected);
	for (const selection of [
		[],
		[{ ...expected[0], role_name: "renamed" }],
		[
			{
				role_name: expected[0].role_name,
				task_digest: expected[0].task_digest,
				report_digest: expected[0].report_digest,
				source_sha: expected[0].source_sha,
				source_generation: expected[0].source_generation,
			},
		],
	]) {
		const mutated = structuredClone(entries);
		mutated[0].observed_identity.selection = selection;
		assert.throws(() => exactObservedProducerSelection(mutated, expected));
	}
});

test("external Herdr observations distinguish restorable plugin and workspace states", () => {
	const local = mkdtempSync(join(tmpdir(), "conductor-plugin-state-"));
	assert.deepEqual(observedPluginState({ result: { plugins: [] } }), {
		presence: "absent",
	});
	assert.deepEqual(pluginRestorationArguments({ presence: "absent" }), [
		"plugin",
		"unlink",
		"structupath.conductor",
	]);
	for (const enabled of [true, false]) {
		const plugin = {
			plugin_id: "structupath.conductor",
			enabled,
			plugin_root: realpathSync(local),
			source: { kind: "local" },
			version: "0.3.0",
			name: "Conductor",
			actions: [],
		};
		assert.deepEqual(observedPluginState({ result: { plugins: [plugin] } }), {
			presence: "local",
			plugin_id: "structupath.conductor",
			plugin_root: realpathSync(local),
			enabled,
			source: { kind: "local" },
			record_sha256: hash(canonicalJson(plugin)),
		});
	}
	for (const enabled of [true, false])
		assert.deepEqual(
			pluginRestorationArguments({
				presence: "local",
				plugin_id: "structupath.conductor",
				plugin_root: realpathSync(local),
				enabled,
				source: { kind: "local" },
				record_sha256: "1".repeat(64),
			}),
			[
				"plugin",
				"link",
				realpathSync(local),
				enabled ? "--enabled" : "--disabled",
			],
		);
	for (const enabled of [true, false])
		for (const source of [
			{ kind: "registry" },
			{
				kind: "local",
				requested_ref: "main",
				resolved_commit: "1".repeat(40),
			},
			{ kind: "local", install_provenance: "git" },
		])
			assert.throws(
				() =>
					observedPluginState({
						result: {
							plugins: [
								{
									plugin_id: "structupath.conductor",
									enabled,
									plugin_root: local,
									source,
								},
							],
						},
					}),
				(error) => error.code === "capability_unavailable",
			);
	assert.equal(
		workspaceAbsentObservation(
			"wGone",
			{ result: { workspaces: [{ workspace_id: "wOther" }] } },
			{ status: 1, payload: { error: { code: "workspace_not_found" } } },
		),
		true,
	);
	assert.throws(() =>
		workspaceAbsentObservation(
			"wGone",
			{ result: { workspaces: [{ workspace_id: "wGone" }] } },
			{ status: 0, payload: { workspace_id: "wGone" } },
		),
	);
});

test("actual plan and production snapshot reject linked producer or gate byte mutation before publication", () => {
	const base = mkdtempSync(join(tmpdir(), "conductor-live-worktrees-"));
	const repository = join(base, "repository");
	const linked = join(base, "linked");
	const state = join(base, "state");
	const output = join(base, "output");
	mkdirSync(repository);
	mkdirSync(state);
	mkdirSync(output);
	execFileSync("git", ["init", "-q", "-b", "main", repository]);
	execFileSync("git", ["-C", repository, "config", "user.name", "Test"]);
	execFileSync("git", [
		"-C",
		repository,
		"config",
		"user.email",
		"test@example.invalid",
	]);
	writeFileSync(join(repository, "tracked.txt"), "original\n");
	execFileSync("git", ["-C", repository, "add", "tracked.txt"]);
	execFileSync("git", ["-C", repository, "commit", "-qm", "base"]);
	execFileSync("git", [
		"-C",
		repository,
		"worktree",
		"add",
		"-q",
		"-b",
		"producer",
		linked,
	]);
	const pluginRoot = realpathSync(repository);
	const snapshot = () =>
		liveForbiddenEffectSnapshot({
			repository,
			stateRepositoryPath: state,
			outputParentPath: output,
			candidatePath: repository,
			pluginPayload: {
				result: {
					plugins: [
						{
							plugin_id: "structupath.conductor",
							enabled: true,
							plugin_root: pluginRoot,
							source: { kind: "local" },
						},
					],
				},
			},
			workspacePayload: { result: { workspaces: [] } },
			registeredWorktreePaths: [linked],
		});
	const before = snapshot();
	writeFileSync(join(linked, "tracked.txt"), "mutated!\n");
	assert.notDeepEqual(snapshot(), before);
	writeFileSync(join(linked, "tracked.txt"), "original\n");

	let published = false;
	const tracker = createForbiddenEffectTracker(snapshot);
	const driver = createStage2LivePlanDriver(() => ({}));
	for (const step of STAGE2_LIVE_EXECUTION_PLAN) {
		if (step.id === "producer_source_refusal") {
			assert.throws(
				() =>
					driver.run(step.id, () =>
						tracker.probe(step.id, () => {
							writeFileSync(join(linked, "tracked.txt"), "mutated!\n");
						}),
					),
				(error) => error.code === "forbidden_effect_observed",
			);
			break;
		}
		driver.run(step.id, () => ({}));
	}
	if (tracker.forbiddenEffectCount === 0) published = true;
	assert.equal(published, false);
});

test("actual plan effect tracking fails before publication on any forbidden delta", () => {
	let value = 0;
	const tracker = createForbiddenEffectTracker(() => ({
		git_refs_head_index_worktree: value,
		task_outbox_accepted_files: "stable",
	}));
	assert.equal(
		tracker.probe("stable-refusal", () => "refused"),
		"refused",
	);
	assert.throws(
		() => tracker.probe("mutating-refusal", () => value++),
		(error) => error.code === "forbidden_effect_observed",
	);
	assert.equal(tracker.forbiddenEffectCount, 1);
});

test("fixed source-definition and sanitized output-parent binding vectors remain stable", () => {
	assert.equal(
		stage2SourceDefinitionDigest(),
		"7e8a822ea2f38dc59e57d9e7ca2b26130de081db8f7122e384561458b8123551",
	);
	assert.equal(
		outputParentBinding({
			candidateSha: candidate,
			runId: "run-1",
			canonicalPath: "/private/tmp/stage2-output",
			device: "123",
			inode: "456",
			owner: "501",
		}),
		"bacaf481c3691981f0d893e8c7107330b81d5d2844f2d89386f98f9c8bd50c8b",
	);
});

test("external review and exact trio validate with a deterministic completion digest", () => {
	const value = trio();
	validateExternalReviewRecord(value.review);
	const first = validateEvidenceBytes(
		value.sourceBytes,
		value.humanBytes,
		value.machineBytes,
		candidate,
	);
	assert.equal(
		first.completionDigest,
		evidenceCompletionDigest(
			value.sourceBytes,
			value.humanBytes,
			value.machineBytes,
			first.machine,
		),
	);
	assert.equal(
		validateEvidenceBytes(
			value.sourceBytes,
			value.humanBytes,
			value.machineBytes,
			candidate,
		).completionDigest,
		first.completionDigest,
	);
});
test("sanitization rejects structural path leakage without substring collisions", () => {
	const roots = [
		"/opt/private/reviewer",
		"/srv/build/reviewer",
		"/data/run/reviewer",
		"/nix/store/reviewer",
		"C:\\private\\reviewer",
		"\\\\server\\share\\reviewer",
		"file:///private/reviewer",
		"~/private/reviewer",
	];
	for (const token of roots) {
		const value = trio();
		const machine = JSON.parse(value.machineBytes);
		machine.run_id = `run:${token}`;
		delete machine.human_report_sha256;
		const humanBytes = renderStage2EvidenceReport(machine);
		machine.human_report_sha256 = hash(humanBytes);
		assert.throws(() =>
			validateEvidenceBytes(
				value.sourceBytes,
				humanBytes,
				Buffer.from(canonicalJson(machine)),
				candidate,
			),
		);
	}
	const localPaths = [
		"/Volumes/private-mount-token/tmp-root-token",
		"/Users/local-user-token/checkout-token/repository-token/state-token/output-token",
	];
	assert.deepEqual(sensitivePathComponents(localPaths), [
		"checkout-token",
		"local-user-token",
		"output-token",
		"private-mount-token",
		"repository-token",
		"state-token",
		"tmp-root-token",
	]);
	for (const token of [
		...sensitivePathComponents(localPaths),
		"a",
		"abc",
		"deadbeef",
	]) {
		const value = trio();
		const machine = JSON.parse(value.machineBytes);
		machine.run_id = `run-${token}`;
		machine.runtime_summary.producer_selection_sha256 = /^[a-f0-9]+$/.test(
			token,
		)
			? token.repeat(64).slice(0, 64).padEnd(64, "a")
			: hash(token);
		delete machine.human_report_sha256;
		const humanBytes = renderStage2EvidenceReport(machine);
		machine.human_report_sha256 = hash(humanBytes);
		assert.doesNotThrow(() =>
			validateEvidenceBytes(
				value.sourceBytes,
				humanBytes,
				Buffer.from(canonicalJson(machine)),
				candidate,
				{ localPaths, localValues: [token] },
			),
		);
	}
	const value = trio();
	const leaked = JSON.parse(value.machineBytes);
	leaked.canonical_path = "/Users/local-user-token/private-output";
	assert.throws(() =>
		assertSanitizedEvidence(leaked, value.humanBytes, { localPaths }),
	);
});

test("trio rejects stale candidate, human drift, review findings, and in-band machine self fields", () => {
	const value = trio();
	assert.throws(() =>
		validateEvidenceBytes(
			value.sourceBytes,
			Buffer.concat([value.humanBytes, Buffer.from("x")]),
			value.machineBytes,
			candidate,
		),
	);
	assert.throws(() =>
		validateEvidenceBytes(
			value.sourceBytes,
			value.humanBytes,
			value.machineBytes,
			"f".repeat(40),
		),
	);
	const machine = JSON.parse(value.machineBytes);
	machine.machine_evidence_sha256 = "f".repeat(64);
	assert.throws(() =>
		validateEvidenceBytes(
			value.sourceBytes,
			value.humanBytes,
			Buffer.from(canonicalJson(machine)),
			candidate,
		),
	);
	const review = structuredClone(value.review);
	review.findings = [
		{ id: "f1", severity: "high", path: null, line: null, message: "block" },
	];
	review.review_record_sha256 = externalReviewDigest(review);
	assert.throws(
		() => validateExternalReviewRecord(review),
		/must have no findings/,
	);
});
function rewriteTrio(value, mutate) {
	const machine = JSON.parse(value.machineBytes);
	mutate(machine);
	machine.external_review.review_record_sha256 = externalReviewDigest(
		machine.external_review,
	);
	machine.external_review_digest = machine.external_review.review_record_sha256;
	delete machine.human_report_sha256;
	const humanBytes = renderStage2EvidenceReport(machine);
	machine.human_report_sha256 = hash(humanBytes);
	return {
		sourceBytes: value.sourceBytes,
		humanBytes,
		machineBytes: Buffer.from(canonicalJson(machine)),
	};
}

function commitTrio(repo, parent, value, label) {
	execFileSync("git", ["-C", repo, "checkout", "-qfB", label, parent]);
	const bytes = [value.sourceBytes, value.machineBytes, value.humanBytes];
	STAGE2_EVIDENCE_PATHS.forEach((path, index) => {
		mkdirSync(join(repo, path, ".."), { recursive: true });
		writeFileSync(join(repo, path), bytes[index]);
	});
	execFileSync("git", ["-C", repo, "add", ...STAGE2_EVIDENCE_PATHS]);
	execFileSync("git", ["-C", repo, "commit", "-qm", label]);
	return execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], {
		encoding: "utf8",
	}).trim();
}

test("Commit B checker reads immutable exact Git-tree blobs and rejects checkout drift or extra paths", () => {
	const repo = mkdtempSync(join(tmpdir(), "conductor-evidence-git-"));
	execFileSync("git", ["init", "-q", "-b", "main", repo]);
	execFileSync("git", ["-C", repo, "config", "user.name", "Test"]);
	execFileSync("git", [
		"-C",
		repo,
		"config",
		"user.email",
		"test@example.invalid",
	]);
	writeFileSync(join(repo, "base"), "base\n");
	for (const path of STAGE2_RUNTIME_SOURCE_DEFINITION.paths) {
		mkdirSync(join(repo, path, ".."), { recursive: true });
		writeFileSync(join(repo, path), `candidate source: ${path}\n`);
	}
	execFileSync("git", ["-C", repo, "add", "."]);
	execFileSync("git", ["-C", repo, "commit", "-qm", "A"]);
	const a = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], {
		encoding: "utf8",
	}).trim();
	const value = trio(a, buildStage2SourceManifest(repo, a));
	const b = commitTrio(repo, a, value, "evidence-valid");
	writeFileSync(join(repo, STAGE2_EVIDENCE_PATHS[2]), "dirty checkout\n");
	assert.match(
		checkCommittedEvidence(repo, a, b).completionDigest,
		/^[a-f0-9]{64}$/,
	);

	const genericRoots = [
		"/opt/local",
		"/srv/local",
		"/data/local",
		"/nix/store/local",
	];
	for (const [index, rootPath] of genericRoots.entries()) {
		const mutated = rewriteTrio(value, (machine) => {
			machine.run_id = `run:${rootPath}`;
		});
		const commit = commitTrio(repo, a, mutated, `generic-root-${index}`);
		assert.throws(
			() => checkCommittedEvidence(repo, a, commit),
			undefined,
			rootPath,
		);
	}

	const closedReviewMutations = [
		["review-id", (review) => (review.review_id = "private-mount-token")],
		[
			"reviewer-kind",
			(review) =>
				(review.reviewer_assertions.reviewer_kind = "private-mount-token"),
		],
		[
			"independence",
			(review) =>
				(review.reviewer_assertions.independence = "private-mount-token"),
		],
		[
			"decision",
			(review) => (review.reviewer_assertions.decision = "private-mount-token"),
		],
		[
			"former-identity",
			(review) => (review.reviewer_assertions.identity = "private-mount-token"),
		],
		[
			"finding-fields",
			(review) =>
				(review.findings = [
					{
						id: "private-mount-token",
						severity: "info",
						path: "private-mount-token",
						line: 501,
						message: "private-mount-token",
					},
				]),
		],
	];
	for (const [label, mutate] of closedReviewMutations) {
		const mutated = rewriteTrio(value, (machine) =>
			mutate(machine.external_review),
		);
		const commit = commitTrio(repo, a, mutated, label);
		assert.throws(
			() => checkCommittedEvidence(repo, a, commit),
			undefined,
			label,
		);
	}

	const numericCollision = rewriteTrio(value, (machine) => {
		machine.output_parent_binding = "50116777234987654321".padEnd(64, "a");
		machine.runtime_summary.producer_selection_sha256 = "501".padEnd(64, "b");
		machine.runtime_summary.retained_inventory_sha256 = "16777234".padEnd(
			64,
			"c",
		);
		machine.runtime_summary.refusal_snapshot_sha256 = "987654321".padEnd(
			64,
			"d",
		);
	});
	const collisionCommit = commitTrio(
		repo,
		a,
		numericCollision,
		"numeric-collision",
	);
	assert.match(
		checkCommittedEvidence(repo, a, collisionCommit).completionDigest,
		/^[a-f0-9]{64}$/,
	);

	writeFileSync(join(repo, "extra"), "x");
	execFileSync("git", ["-C", repo, "add", "extra"]);
	execFileSync("git", ["-C", repo, "commit", "-qm", "extra"]);
	const c = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], {
		encoding: "utf8",
	}).trim();
	assert.throws(
		() => checkCommittedEvidence(repo, a, c),
		/exact three evidence paths/,
	);
});

test("private exact-trio publication and attended finalization converge without exposing parent metadata", () => {
	const parent = mkdtempSync(join(tmpdir(), "conductor-evidence-private-"));
	chmodSync(parent, 0o700);
	const output = validatePrivateOutputParent(realpathSync(parent));
	const value = trio(
		candidate,
		null,
		outputParentBinding({
			candidateSha: candidate,
			runId: "run-1",
			canonicalPath: output.canonicalPath,
			device: output.device,
			inode: output.inode,
			owner: output.owner,
		}),
	);
	assertSanitizedEvidence(JSON.parse(value.machineBytes), value.humanBytes, {
		localPaths: [output.canonicalPath],
		localValues: [output.device, output.inode, output.owner],
	});
	const published = publishPrivateEvidenceTrio(output, value);
	const finalized = finalizePrivateEvidenceTrio(
		realpathSync(parent),
		candidate,
	);
	assert.equal(finalized.completionDigest, published.completionDigest);
	assert.deepEqual(
		readdirSync(parent).sort(),
		STAGE2_EVIDENCE_PATHS.map((path) => path.split("/").at(-1)).sort(),
	);
	for (const name of readdirSync(parent))
		assert.equal(statSync(join(parent, name)).mode & 0o777, 0o600);
	closeSync(output.descriptor);
});

test("true SIGKILL output prefixes fail closed while a complete trio finalizes to one digest", () => {
	const child = fileURLToPath(
		new URL("./fixtures/evidence-publication-child.mjs", import.meta.url),
	);
	const boundaries = [
		"after_create:stage2-runtime-source-manifest.json",
		"after_parent_fsync:2026-07-28-stage2-live-contracts.md",
		"after_fsync:2026-07-28-stage2-live-contracts.json",
		"after_parent_fsync:2026-07-28-stage2-live-contracts.json",
	];
	for (const boundary of boundaries) {
		const staging = mkdtempSync(join(tmpdir(), "conductor-evidence-publish-"));
		const outputPath = join(staging, "output");
		mkdirSync(outputPath, { mode: 0o700 });
		const output = validatePrivateOutputParent(realpathSync(outputPath));
		const value = trio(
			candidate,
			null,
			outputParentBinding({
				candidateSha: candidate,
				runId: "run-1",
				canonicalPath: output.canonicalPath,
				device: output.device,
				inode: output.inode,
				owner: output.owner,
			}),
		);
		closeSync(output.descriptor);
		const inputPaths = ["source", "human", "machine"].map((name) =>
			join(staging, name),
		);
		[value.sourceBytes, value.humanBytes, value.machineBytes].forEach(
			(bytes, index) => writeFileSync(inputPaths[index], bytes),
		);
		const result = spawnSync(
			process.execPath,
			[child, output.canonicalPath, ...inputPaths, boundary],
			{ encoding: "utf8", timeout: 10_000 },
		);
		assert.equal(result.signal, "SIGKILL", boundary);
		if (boundary.endsWith("stage2-live-contracts.json")) {
			assert.match(
				finalizePrivateEvidenceTrio(realpathSync(outputPath), candidate)
					.completionDigest,
				/^[a-f0-9]{64}$/,
			);
		} else {
			assert.throws(() =>
				finalizePrivateEvidenceTrio(realpathSync(outputPath), candidate),
			);
		}
	}
});

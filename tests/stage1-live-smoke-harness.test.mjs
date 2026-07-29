import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { checkCandidateProvenance } from "../scripts/check-stage1-live-smoke-evidence.mjs";
import { canonicalJson } from "../scripts/private-state-schema.mjs";
import {
	ACTION_IDS,
	ISOLATION_ACTION_IDS,
	ISOLATION_CONTEXTS,
	OPERATION_TYPES,
	RETAINED_FILES,
	buildCandidateRuntimeSourceManifest,
	evidenceClaimMaterial,
	renderEvidenceReport,
	sha256,
	validateCandidatePreflight,
	validateEvidence,
} from "../scripts/stage1-evidence-contract.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const digest = (label) => sha256(label);

function snapshot(label = "snapshot") {
	return {
		disposable_workspace_inventory_sha256: digest(`${label}-workspaces`),
		disposable_pane_inventory_sha256: digest(`${label}-panes`),
		disposable_agent_inventory_sha256: digest(`${label}-agents`),
		primary_git_sha256: digest(`${label}-primary-git`),
		secondary_git_sha256: digest(`${label}-secondary-git`),
		primary_repository_state_sha256: digest(`${label}-primary-state`),
		secondary_repository_state_sha256: digest(`${label}-secondary-state`),
		workspace_state_sha256: digest(`${label}-workspace-state`),
		active_pointer_sha256: digest(`${label}-active`),
		pane_tuple_sha256: digest(`${label}-pane-tuple`),
		close_count: 0,
		cas_count: 0,
	};
}

function validEvidence() {
	const entries = OPERATION_TYPES.map((operation_type, index) => ({
		sequence: index + 1,
		operation_type,
		entry_digest: digest(`entry-${index}`),
		result_digest: digest(`result-${index}`),
	}));
	const invocationPairs = [
		...ACTION_IDS.map((actionId) => ["primary", actionId]),
		...ISOLATION_CONTEXTS.flatMap((context) =>
			ISOLATION_ACTION_IDS.map((actionId) => [context, actionId]),
		),
	];
	const baseline = snapshot();
	const evidence = {
		document_type: "herdr-conductor-stage1-b4-live-smoke",
		schema_version: 3,
		result: "passed",
		timestamps: {
			started_at: "2026-07-28T00:00:00.000Z",
			completed_at: "2026-07-28T00:01:00.000Z",
		},
		candidate: {
			commit: "a".repeat(40),
			source_manifest_sha256: digest("manifest"),
		},
		herdr: {
			client_version: "0.7.5",
			server_version: "0.7.5",
			protocol: 17,
			schema_version: 1,
		},
		identities: {
			primary_workspace_sha256: digest("primary"),
			same_repository_workspace_sha256: digest("same"),
			second_repository_workspace_sha256: digest("second"),
			primary_repository_key: digest("primary-repo"),
			second_repository_key: digest("second-repo"),
			run_id_sha256: digest("run"),
			generation_sha256: digest("generation"),
			writer_pane_sha256: digest("writer-pane"),
		},
		invocations: invocationPairs.map(([context, action_id], index) => ({
			action_id,
			context,
			log_id_sha256: digest(`log-${index}`),
			terminal_status: context === "primary" ? "succeeded" : "failed",
			exit_code: context === "primary" ? 0 : 1,
			output_sha256: digest(`output-${index}`),
			result_sha256: digest(`invocation-result-${index}`),
		})),
		isolation: {
			baseline,
			probes: invocationPairs.slice(5).map(([context, action_id]) => ({
				context,
				action_id,
				before: structuredClone(baseline),
				after: structuredClone(baseline),
			})),
		},
		harvest: {
			writer_ref_sha256: digest("writer-ref"),
			source_head: "b".repeat(40),
			target_ref: "refs/heads/main",
			final_target_head: "c".repeat(40),
			result_digest: entries[4].result_digest,
			journal_result_digest: entries[4].result_digest,
			second_parent_is_source: true,
		},
		stand_down: {
			closed_count: 1,
			close_journal_count: 1,
			exact_pane_absent: true,
			run_archived: true,
			active_pointer_absent: true,
		},
		journal: {
			entry_count: entries.length,
			entries,
			head: entries.at(-1).entry_digest,
			chain_summary_sha256: sha256(canonicalJson(entries)),
		},
		retention: {
			writer_branch_observed: true,
			writer_worktree_observed: true,
			files: [...RETAINED_FILES].map(([path, content]) => ({
				path,
				sha256: sha256(content),
			})),
		},
		cleanup: {
			closed_workspace_sha256: [
				digest("workspace-1"),
				digest("workspace-2"),
				digest("workspace-3"),
			],
			removed_state_record_sha256: [digest("record-1"), digest("record-2")],
			prior_disposable_state_record_count_removed: 2,
			temporary_repository_count: 2,
			workspace_inventory_restored: true,
			pane_inventory_restored: true,
			agent_inventory_restored: true,
			focus_restored: true,
			temporary_root_absent: true,
			state_records_absent: true,
			zero_residue: true,
		},
		privacy: {
			sanitized: true,
			operator_observed_local: true,
			remote_attestation: false,
			same_uid_authentication: false,
			excluded: [
				"raw action log identifiers",
				"terminal output",
				"agent transcripts",
				"prompts",
				"environment",
				"socket contents",
				"tokens",
				"private data",
				"filesystem paths",
			],
		},
	};
	evidence.claims_sha256 = sha256(
		canonicalJson(evidenceClaimMaterial(evidence)),
	);
	evidence.human_report_sha256 = sha256(renderEvidenceReport(evidence));
	return evidence;
}

function resign(evidence) {
	evidence.claims_sha256 = sha256(
		canonicalJson(evidenceClaimMaterial(evidence)),
	);
	evidence.human_report_sha256 = sha256(renderEvidenceReport(evidence));
	return evidence;
}

function rejected(mutator, pattern) {
	const evidence = validEvidence();
	mutator(evidence);
	assert.throws(
		() =>
			validateEvidence(resign(evidence), {
				sourceManifestDigest: digest("manifest"),
			}),
		pattern,
	);
}

test("live smoke refuses without the exact explicit opt-in", () => {
	for (const value of [
		undefined,
		"yes",
		"I_UNDERSTAND_THIS_USES_LOCAL_HERDR ",
	]) {
		const env = { ...process.env };
		if (value === undefined) delete env.CONDUCTOR_STAGE1_LIVE_SMOKE;
		else env.CONDUCTOR_STAGE1_LIVE_SMOKE = value;
		const result = spawnSync(
			process.execPath,
			[join(root, "scripts/run-stage1-live-smoke.mjs")],
			{ cwd: root, env, encoding: "utf8" },
		);
		assert.equal(result.status, 64);
		assert.equal(result.stdout, "");
		assert.match(result.stderr, /^refusing live smoke:/);
	}
});

test("live smoke refuses state-root overrides before creating resources", () => {
	const forbiddenRoot = join(
		mkdtempSync(join(tmpdir(), "conductor-override-parent-")),
		"must-not-be-created",
	);
	const result = spawnSync(
		process.execPath,
		[join(root, "scripts/run-stage1-live-smoke.mjs")],
		{
			cwd: root,
			env: {
				...process.env,
				CONDUCTOR_STAGE1_LIVE_SMOKE: "I_UNDERSTAND_THIS_USES_LOCAL_HERDR",
				CONDUCTOR_STATE_DIR: forbiddenRoot,
			},
			encoding: "utf8",
		},
	);
	assert.equal(result.status, 64);
	assert.match(result.stderr, /CONDUCTOR_STATE_DIR is not forwarded/);
	assert.equal(existsSync(forbiddenRoot), false);
});

test("strict evidence fixture and clean candidate preflight pass", () => {
	assert.equal(
		validateEvidence(validEvidence(), {
			sourceManifestDigest: digest("manifest"),
		}),
		true,
	);
	assert.equal(
		validateCandidatePreflight({
			status: "",
			commit: "a".repeat(40),
			sourceManifest: { exact: true },
			currentManifest: { exact: true },
		}),
		"a".repeat(40),
	);
});

test("candidate preflight rejects dirty source", () => {
	assert.throws(
		() =>
			validateCandidatePreflight({
				status: " M package.json",
				commit: "a".repeat(40),
				sourceManifest: {},
				currentManifest: {},
			}),
		/must be clean/,
	);
});

test("candidate provenance uses real Git commits and rejects invalid ancestry or divergence", () => {
	const repository = mkdtempSync(join(tmpdir(), "conductor-provenance-"));
	execFileSync("git", ["init", "-q", "-b", "main", repository]);
	execFileSync("git", ["-C", repository, "config", "user.name", "Test"]);
	execFileSync("git", [
		"-C",
		repository,
		"config",
		"user.email",
		"test@example.invalid",
	]);
	for (const path of [
		"scripts/run-stage1-live-smoke.mjs",
		"scripts/stage1-evidence-contract.mjs",
		"scripts/check-stage1-live-smoke-evidence.mjs",
		"scripts/check-evidence-inventory.mjs",
		"scripts/check-b0-identity-evidence.mjs",
		"scripts/state-root.mjs",
		"scripts/stage1-runtime.mjs",
		"scripts/private-state-schema.mjs",
		"scripts/state-kernel.mjs",
		"scripts/state-internal.mjs",
		"scripts/operation-journal.mjs",
		"scripts/operation-policy.mjs",
		"scripts/git-reconcile.mjs",
		"scripts/herdr-identity.mjs",
		"scripts/assemble.sh",
		"scripts/board.sh",
		"scripts/status.sh",
		"scripts/harvest.sh",
		"scripts/stand-down.sh",
		"scripts/board-pane.sh",
		"bin/renderer.mjs",
		"herdr-plugin.toml",
		"package.json",
	]) {
		mkdirSync(dirname(join(repository, path)), { recursive: true });
		writeFileSync(join(repository, path), `${path}\n`);
	}
	execFileSync("git", ["-C", repository, "add", "."]);
	execFileSync("git", ["-C", repository, "commit", "-qm", "candidate"]);
	const candidate = execFileSync(
		"git",
		["-C", repository, "rev-parse", "HEAD"],
		{ encoding: "utf8" },
	).trim();
	const manifest = buildCandidateRuntimeSourceManifest(repository, candidate);
	assert.equal(manifest.files.length, 23);
	assert.deepEqual(
		checkCandidateProvenance(repository, candidate, manifest),
		manifest,
	);
	assert.throws(
		() => buildCandidateRuntimeSourceManifest(repository, "f".repeat(40)),
		/does not exist/,
	);
	writeFileSync(join(repository, "package.json"), "diverged\n");
	assert.throws(
		() => checkCandidateProvenance(repository, candidate, manifest),
		/current checkout runtime source/,
	);
	execFileSync("git", ["-C", repository, "add", "package.json"]);
	execFileSync("git", ["-C", repository, "commit", "-qm", "divergent source"]);
	const divergent = execFileSync(
		"git",
		["-C", repository, "rev-parse", "HEAD"],
		{ encoding: "utf8" },
	).trim();
	assert.throws(
		() => checkCandidateProvenance(repository, divergent, manifest),
		/retained runtime source manifest/,
	);
	execFileSync("git", ["-C", repository, "checkout", "--orphan", "foreign"]);
	execFileSync("git", ["-C", repository, "rm", "-qrf", "."]);
	writeFileSync(join(repository, "foreign.txt"), "foreign\n");
	execFileSync("git", ["-C", repository, "add", "."]);
	execFileSync("git", ["-C", repository, "commit", "-qm", "foreign"]);
	assert.throws(
		() => buildCandidateRuntimeSourceManifest(repository, candidate),
		/not an ancestor/,
	);
});

test("schema rejects missing and extra nested keys", () => {
	rejected((evidence) => {
		delete evidence.invocations[0].result_sha256;
	}, /fields/);
	rejected((evidence) => {
		evidence.cleanup.extra = true;
	}, /fields/);
});

test("schema rejects empty identities", () => {
	rejected((evidence) => {
		evidence.identities.run_id_sha256 = "";
	}, /run_id_sha256/);
});

test("schema rejects duplicate and omitted retention paths", () => {
	rejected((evidence) => {
		evidence.retention.files[1].path = evidence.retention.files[0].path;
	}, /duplicate retention path/);
	rejected((evidence) => {
		evidence.retention.files.pop();
	}, /retention path count/);
});

test("schema rejects bad action status and digests", () => {
	rejected((evidence) => {
		evidence.invocations[0].terminal_status = "failed";
	}, /status/);
	rejected((evidence) => {
		evidence.invocations[0].output_sha256 = "bad";
	}, /output/);
});

test("schema rejects cross-field harvest and journal mismatches", () => {
	rejected((evidence) => {
		evidence.harvest.journal_result_digest = digest("wrong");
	}, /harvest result\/journal mismatch/);
	rejected((evidence) => {
		evidence.isolation.probes[0].after.cas_count = 1;
	}, /mutated authority/);
});

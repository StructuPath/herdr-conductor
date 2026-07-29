#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalJson } from "./private-state-schema.mjs";

export const ACTION_IDS = [
	"assemble",
	"board",
	"status",
	"harvest",
	"stand-down",
];
export const ISOLATION_ACTION_IDS = [
	"board",
	"status",
	"harvest",
	"stand-down",
];
export const ISOLATION_CONTEXTS = [
	"same_repository_foreign_workspace",
	"second_repository_workspace",
];
export const OPERATION_TYPES = [
	"integration.bind",
	"worktree.create",
	"pane.create",
	"agent.start",
	"git.merge",
	"pane.close",
	"run.archive",
];
export const RETAINED_FILES = new Map([
	["retained/marker.txt", "conductor-stage1-b4-marker\n"],
	[
		"retained/report.json",
		'{"result":"stage1-b4-live-smoke","status":"retained"}\n',
	],
	["retained/live-smoke.log", "sanitized lifecycle marker: retained\n"],
	["retained/Guard-observation.txt", "Guard-like retained artifact\n"],
]);
export const RUNTIME_SOURCE_PATHS = [
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
];

const DIGEST = /^[a-f0-9]{64}$/;
const GIT_OBJECT = /^[a-f0-9]{40}$/;
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export function sha256(value) {
	return createHash("sha256").update(value).digest("hex");
}

function exactKeys(value, expected, label) {
	assert.ok(
		value && typeof value === "object" && !Array.isArray(value),
		`${label} must be an object`,
	);
	assert.deepEqual(
		Object.keys(value).sort(),
		[...expected].sort(),
		`${label} fields`,
	);
}

function digest(value, label) {
	assert.match(value, DIGEST, label);
}

function booleanTrue(value, label) {
	assert.equal(value, true, label);
}

export function validateCandidatePreflight({
	status,
	commit,
	sourceManifest,
	currentManifest,
}) {
	assert.equal(status, "", "candidate checkout must be clean");
	assert.match(commit, GIT_OBJECT, "candidate commit");
	assert.equal(
		canonicalJson(sourceManifest),
		canonicalJson(currentManifest),
		"canonical source manifest is stale",
	);
	return commit;
}

export function buildRuntimeSourceManifest(
	root,
	readSource = (path) => readFileSync(join(root, path)),
) {
	return {
		document_type: "herdr-conductor-stage1-runtime-source-manifest",
		schema_version: 1,
		files: RUNTIME_SOURCE_PATHS.map((path) => ({
			path,
			sha256: sha256(readSource(path)),
		})),
	};
}

export function resolveCandidateCommit(root, candidate) {
	assert.match(candidate, GIT_OBJECT, "candidate commit");
	let resolved;
	try {
		resolved = execFileSync(
			"git",
			["-C", root, "rev-parse", "--verify", `${candidate}^{commit}`],
			{ encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
		).trim();
	} catch {
		assert.fail("candidate commit does not exist as a commit");
	}
	assert.match(resolved, GIT_OBJECT, "resolved candidate commit");
	try {
		execFileSync(
			"git",
			["-C", root, "merge-base", "--is-ancestor", resolved, "HEAD"],
			{ stdio: "ignore" },
		);
	} catch {
		assert.fail("candidate commit is not an ancestor of the evidence head");
	}
	return resolved;
}

export function buildCandidateRuntimeSourceManifest(root, candidate) {
	const resolved = resolveCandidateCommit(root, candidate);
	return buildRuntimeSourceManifest(root, (path) =>
		execFileSync("git", ["-C", root, "show", `${resolved}:${path}`]),
	);
}

export function validateRuntimeSourceManifest(manifest, root) {
	exactKeys(
		manifest,
		["document_type", "schema_version", "files"],
		"source manifest",
	);
	assert.equal(
		manifest.document_type,
		"herdr-conductor-stage1-runtime-source-manifest",
	);
	assert.equal(manifest.schema_version, 1);
	assert.equal(manifest.files.length, RUNTIME_SOURCE_PATHS.length);
	assert.deepEqual(
		manifest.files.map((entry) => entry.path),
		RUNTIME_SOURCE_PATHS,
	);
	for (const [index, entry] of manifest.files.entries()) {
		exactKeys(entry, ["path", "sha256"], `source manifest file ${index}`);
		digest(entry.sha256, `source manifest digest ${entry.path}`);
		assert.equal(
			entry.sha256,
			sha256(readFileSync(join(root, entry.path))),
			`${entry.path} differs from the attested runtime source`,
		);
	}
	return sha256(canonicalJson(manifest));
}

function expectedInvocations() {
	return [
		...ACTION_IDS.map((actionId) => ["primary", actionId]),
		...ISOLATION_CONTEXTS.flatMap((context) =>
			ISOLATION_ACTION_IDS.map((actionId) => [context, actionId]),
		),
	];
}

function validateSnapshot(snapshot, label) {
	const digestKeys = [
		"disposable_workspace_inventory_sha256",
		"disposable_pane_inventory_sha256",
		"disposable_agent_inventory_sha256",
		"primary_git_sha256",
		"secondary_git_sha256",
		"primary_repository_state_sha256",
		"secondary_repository_state_sha256",
		"workspace_state_sha256",
		"active_pointer_sha256",
		"pane_tuple_sha256",
	];
	exactKeys(snapshot, [...digestKeys, "close_count", "cas_count"], label);
	for (const key of digestKeys) digest(snapshot[key], `${label}.${key}`);
	assert.ok(
		Number.isInteger(snapshot.close_count) && snapshot.close_count >= 0,
		`${label}.close_count`,
	);
	assert.ok(
		Number.isInteger(snapshot.cas_count) && snapshot.cas_count >= 0,
		`${label}.cas_count`,
	);
}

export function evidenceClaimMaterial(evidence) {
	const material = structuredClone(evidence);
	delete material.claims_sha256;
	delete material.human_report_sha256;
	return material;
}

export function renderEvidenceReport(evidence) {
	const retention = evidence.retention.files
		.map((item) => `| \`${item.path}\` | \`${item.sha256}\` |`)
		.join("\n");
	return `# Conductor 0.2.0 Stage 1 B4 — opt-in live smoke evidence

- **Started:** ${evidence.timestamps.started_at}
- **Completed:** ${evidence.timestamps.completed_at}
- **Clean candidate commit:** \`${evidence.candidate.commit}\`
- **Runtime source manifest:** \`${evidence.candidate.source_manifest_sha256}\`
- **Herdr client/server:** \`${evidence.herdr.client_version}\` / \`${evidence.herdr.server_version}\`, protocol \`${evidence.herdr.protocol}\`, schema \`${evidence.herdr.schema_version}\`
- **Result:** PASS

## Scope, provenance, and privacy

This is sanitized, operator-observed local evidence anchored to the named candidate
commit, its Git tree, the retained source manifest, and this checker. It is not a
cryptographic remote attestation and does not authenticate against fabrication by
a process running as the same OS user.

The explicitly opted-in harness invoked all five installed \`structupath.conductor\`
actions through Herdr 0.7.5. Every retained invocation record contains only the
action, bounded context, terminal status, exit code, and SHA-256 digests of its
log identifier and output/result. No raw log identifier or terminal output is retained.

## Verified lifecycle and isolation

- Assemble, board, status, harvest, and stand-down succeeded in the primary disposable workspace.
- Board, status, harvest, and stand-down each refused both a foreign workspace in the same repository and a workspace in a second repository.
- Fresh before/after reads of global disposable workspace/pane/agent inventories, both repositories' refs/worktrees/status/heads, both exact repository-state records, primary workspace state, active pointer, full live pane/agent tuple, pane-close count, and Git compare-and-swap count matched after every refusal.
- Harvest's result digest equals the observed \`git.merge\` journal result digest.
- Stand-down archived the run and closed exactly the observed writer pane.
- The original workspace inventory and focus were restored.

## Retention inventory captured before cleanup

| Retained path (inside the disposable writer worktree) | SHA-256 |
|---|---|
${retention}

Before this candidate was committed, the operator removed 2 strictly validated
identity-only records left by prior disposable B4 runs; no private paths are retained.
After retention facts were captured, this harness closed only its exact disposable
workspaces and removed only its two temporary repositories and exact repository-keyed
private-state records. The cleanup receipt reports zero residue.

This report is generated deterministically from the machine evidence. Commit B may
retain this evidence, but the attested runtime source manifest is the exact manifest
from candidate Commit A; the checker requires the current checkout to reproduce it.
`;
}

export function validateEvidence(
	evidence,
	{ sourceManifestDigest, reportBytes } = {},
) {
	exactKeys(
		evidence,
		[
			"document_type",
			"schema_version",
			"result",
			"timestamps",
			"candidate",
			"herdr",
			"identities",
			"invocations",
			"isolation",
			"harvest",
			"stand_down",
			"journal",
			"retention",
			"cleanup",
			"privacy",
			"claims_sha256",
			"human_report_sha256",
		],
		"evidence",
	);
	assert.equal(evidence.document_type, "herdr-conductor-stage1-b4-live-smoke");
	assert.equal(evidence.schema_version, 3);
	assert.equal(evidence.result, "passed");
	exactKeys(evidence.timestamps, ["started_at", "completed_at"], "timestamps");
	assert.match(evidence.timestamps.started_at, RFC3339);
	assert.match(evidence.timestamps.completed_at, RFC3339);
	assert.ok(
		Date.parse(evidence.timestamps.completed_at) >=
			Date.parse(evidence.timestamps.started_at),
		"completion precedes start",
	);

	exactKeys(
		evidence.candidate,
		["commit", "source_manifest_sha256"],
		"candidate",
	);
	assert.match(evidence.candidate.commit, GIT_OBJECT, "candidate commit");
	digest(
		evidence.candidate.source_manifest_sha256,
		"candidate source manifest digest",
	);
	if (sourceManifestDigest !== undefined)
		assert.equal(
			evidence.candidate.source_manifest_sha256,
			sourceManifestDigest,
			"evidence source manifest differs from current checkout",
		);

	exactKeys(
		evidence.herdr,
		["client_version", "server_version", "protocol", "schema_version"],
		"herdr",
	);
	assert.deepEqual(
		{ ...evidence.herdr },
		{
			client_version: "0.7.5",
			server_version: "0.7.5",
			protocol: 17,
			schema_version: 1,
		},
	);
	exactKeys(
		evidence.identities,
		[
			"primary_workspace_sha256",
			"same_repository_workspace_sha256",
			"second_repository_workspace_sha256",
			"primary_repository_key",
			"second_repository_key",
			"run_id_sha256",
			"generation_sha256",
			"writer_pane_sha256",
		],
		"identities",
	);
	for (const [key, value] of Object.entries(evidence.identities))
		digest(value, `identities.${key}`);

	const expected = expectedInvocations();
	assert.equal(
		evidence.invocations.length,
		expected.length,
		"invocation count",
	);
	const seen = new Set();
	for (const [index, invocation] of evidence.invocations.entries()) {
		exactKeys(
			invocation,
			[
				"action_id",
				"context",
				"log_id_sha256",
				"terminal_status",
				"exit_code",
				"output_sha256",
				"result_sha256",
			],
			`invocation ${index}`,
		);
		assert.deepEqual(
			[invocation.context, invocation.action_id],
			expected[index],
			`invocation ${index} identity`,
		);
		assert.ok(
			!seen.has(`${invocation.context}\0${invocation.action_id}`),
			`duplicate invocation ${index}`,
		);
		seen.add(`${invocation.context}\0${invocation.action_id}`);
		digest(invocation.log_id_sha256, `invocation ${index} log id`);
		digest(invocation.output_sha256, `invocation ${index} output`);
		digest(invocation.result_sha256, `invocation ${index} result`);
		const primary = invocation.context === "primary";
		assert.equal(
			invocation.terminal_status,
			primary ? "succeeded" : "failed",
			`invocation ${index} status`,
		);
		assert.equal(
			invocation.exit_code,
			primary ? 0 : 1,
			`invocation ${index} exit code`,
		);
	}

	exactKeys(evidence.isolation, ["baseline", "probes"], "isolation");
	validateSnapshot(evidence.isolation.baseline, "isolation baseline");
	assert.equal(evidence.isolation.probes.length, 8, "isolation probe count");
	for (const [index, probe] of evidence.isolation.probes.entries()) {
		exactKeys(
			probe,
			["context", "action_id", "before", "after"],
			`isolation probe ${index}`,
		);
		assert.deepEqual(
			[probe.context, probe.action_id],
			expected.slice(5)[index],
			`isolation probe ${index} identity`,
		);
		validateSnapshot(probe.before, `isolation probe ${index} before`);
		validateSnapshot(probe.after, `isolation probe ${index} after`);
		assert.deepEqual(
			probe.after,
			probe.before,
			`isolation probe ${index} mutated authority`,
		);
	}

	exactKeys(
		evidence.harvest,
		[
			"writer_ref_sha256",
			"source_head",
			"target_ref",
			"final_target_head",
			"result_digest",
			"journal_result_digest",
			"second_parent_is_source",
		],
		"harvest",
	);
	digest(evidence.harvest.writer_ref_sha256, "writer ref digest");
	assert.match(evidence.harvest.source_head, GIT_OBJECT);
	assert.equal(evidence.harvest.target_ref, "refs/heads/main");
	assert.match(evidence.harvest.final_target_head, GIT_OBJECT);
	digest(evidence.harvest.result_digest, "harvest result digest");
	digest(
		evidence.harvest.journal_result_digest,
		"harvest journal result digest",
	);
	assert.equal(
		evidence.harvest.result_digest,
		evidence.harvest.journal_result_digest,
		"harvest result/journal mismatch",
	);
	booleanTrue(
		evidence.harvest.second_parent_is_source,
		"harvest second parent",
	);

	exactKeys(
		evidence.stand_down,
		[
			"closed_count",
			"close_journal_count",
			"exact_pane_absent",
			"run_archived",
			"active_pointer_absent",
		],
		"stand_down",
	);
	assert.equal(evidence.stand_down.closed_count, 1);
	assert.equal(evidence.stand_down.close_journal_count, 1);
	for (const key of [
		"exact_pane_absent",
		"run_archived",
		"active_pointer_absent",
	])
		booleanTrue(evidence.stand_down[key], `stand_down.${key}`);

	exactKeys(
		evidence.journal,
		["entry_count", "entries", "head", "chain_summary_sha256"],
		"journal",
	);
	assert.equal(evidence.journal.entry_count, OPERATION_TYPES.length);
	assert.equal(evidence.journal.entries.length, OPERATION_TYPES.length);
	for (const [index, entry] of evidence.journal.entries.entries()) {
		exactKeys(
			entry,
			["sequence", "operation_type", "entry_digest", "result_digest"],
			`journal entry ${index}`,
		);
		assert.equal(entry.sequence, index + 1);
		assert.equal(entry.operation_type, OPERATION_TYPES[index]);
		digest(entry.entry_digest, `journal entry ${index} digest`);
		digest(entry.result_digest, `journal entry ${index} result`);
	}
	assert.equal(
		evidence.journal.head,
		evidence.journal.entries.at(-1).entry_digest,
	);
	assert.equal(
		evidence.journal.chain_summary_sha256,
		sha256(canonicalJson(evidence.journal.entries)),
	);
	assert.equal(
		evidence.harvest.journal_result_digest,
		evidence.journal.entries[4].result_digest,
		"harvest/journal cross-field mismatch",
	);

	exactKeys(
		evidence.retention,
		["writer_branch_observed", "writer_worktree_observed", "files"],
		"retention",
	);
	booleanTrue(
		evidence.retention.writer_branch_observed,
		"retained writer branch",
	);
	booleanTrue(
		evidence.retention.writer_worktree_observed,
		"retained writer worktree",
	);
	assert.equal(
		evidence.retention.files.length,
		RETAINED_FILES.size,
		"retention path count",
	);
	assert.equal(
		new Set(evidence.retention.files.map((entry) => entry.path)).size,
		RETAINED_FILES.size,
		"duplicate retention path",
	);
	assert.deepEqual(
		evidence.retention.files.map((entry) => entry.path).sort(),
		[...RETAINED_FILES.keys()].sort(),
		"retention paths",
	);
	for (const [index, entry] of evidence.retention.files.entries()) {
		exactKeys(entry, ["path", "sha256"], `retention file ${index}`);
		assert.equal(
			entry.sha256,
			sha256(RETAINED_FILES.get(entry.path)),
			`retention digest ${entry.path}`,
		);
	}

	exactKeys(
		evidence.cleanup,
		[
			"closed_workspace_sha256",
			"removed_state_record_sha256",
			"prior_disposable_state_record_count_removed",
			"temporary_repository_count",
			"workspace_inventory_restored",
			"pane_inventory_restored",
			"agent_inventory_restored",
			"focus_restored",
			"temporary_root_absent",
			"state_records_absent",
			"zero_residue",
		],
		"cleanup",
	);
	assert.equal(evidence.cleanup.closed_workspace_sha256.length, 3);
	assert.equal(new Set(evidence.cleanup.closed_workspace_sha256).size, 3);
	assert.equal(evidence.cleanup.removed_state_record_sha256.length, 2);
	assert.equal(new Set(evidence.cleanup.removed_state_record_sha256).size, 2);
	for (const value of [
		...evidence.cleanup.closed_workspace_sha256,
		...evidence.cleanup.removed_state_record_sha256,
	])
		digest(value, "cleanup identity");
	assert.equal(evidence.cleanup.prior_disposable_state_record_count_removed, 2);
	assert.equal(evidence.cleanup.temporary_repository_count, 2);
	for (const key of [
		"workspace_inventory_restored",
		"pane_inventory_restored",
		"agent_inventory_restored",
		"focus_restored",
		"temporary_root_absent",
		"state_records_absent",
		"zero_residue",
	])
		booleanTrue(evidence.cleanup[key], `cleanup.${key}`);

	exactKeys(
		evidence.privacy,
		[
			"sanitized",
			"operator_observed_local",
			"remote_attestation",
			"same_uid_authentication",
			"excluded",
		],
		"privacy",
	);
	booleanTrue(evidence.privacy.sanitized, "privacy.sanitized");
	booleanTrue(
		evidence.privacy.operator_observed_local,
		"privacy.operator_observed_local",
	);
	assert.equal(
		evidence.privacy.remote_attestation,
		false,
		"privacy.remote_attestation",
	);
	assert.equal(
		evidence.privacy.same_uid_authentication,
		false,
		"privacy.same_uid_authentication",
	);
	assert.deepEqual(evidence.privacy.excluded, [
		"raw action log identifiers",
		"terminal output",
		"agent transcripts",
		"prompts",
		"environment",
		"socket contents",
		"tokens",
		"private data",
		"filesystem paths",
	]);
	digest(evidence.claims_sha256, "claims digest");
	assert.equal(
		evidence.claims_sha256,
		sha256(canonicalJson(evidenceClaimMaterial(evidence))),
		"claims digest mismatch",
	);
	const rendered = renderEvidenceReport(evidence);
	assert.equal(
		evidence.human_report_sha256,
		sha256(rendered),
		"human report semantic digest mismatch",
	);
	if (reportBytes !== undefined)
		assert.equal(
			reportBytes.toString("utf8"),
			rendered,
			"human report is not the deterministic rendering of evidence",
		);
	return true;
}

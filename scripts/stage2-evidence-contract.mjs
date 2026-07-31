#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
	closeSync,
	constants,
	fsyncSync,
	fstatSync,
	openSync,
	readFileSync,
	readSync,
	readdirSync,
	realpathSync,
	writeSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import {
	canonicalJson,
	parseStrictJsonBytes,
	StateKernelError,
} from "./private-state-schema.mjs";
import { validateRelativePath } from "./task-report-schema.mjs";

const SHA = /^[a-f0-9]{40}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const EXTERNAL_REVIEW_ID = "stage2-independent-human-go-review";
const REVIEWER_KIND = "independent_external_human";
const REVIEW_INDEPENDENCE = "independent_of_implementation_authorship";
const REVIEW_DECISION = "go";
export const STAGE2_EVIDENCE_PATHS = Object.freeze([
	"docs/evidence/stage2-runtime-source-manifest.json",
	"docs/evidence/2026-07-28-stage2-live-contracts.json",
	"docs/evidence/2026-07-28-stage2-live-contracts.md",
]);
export const STAGE2_RUNTIME_SOURCE_DEFINITION = Object.freeze({
	id: "herdr-conductor-stage2-runtime-sources",
	version: 1,
	paths: Object.freeze([
		".gitignore",
		"package.json",
		"herdr-plugin.toml",
		"README.md",
		"SECURITY.md",
		"CONTRIBUTING.md",
		"docs/private-state-v1.md",
		"docs/herdr-plugins-cheatsheet.md",
		".github/workflows/ci.yml",
		"bin/renderer.mjs",
		"roles/builder-engine.md",
		"roles/builder-ui.md",
		"roles/test-author.md",
		"roles/reviewer.md",
		"roles/validator.md",
		"scripts/assemble.sh",
		"scripts/board-pane.sh",
		"scripts/board.sh",
		"scripts/harvest.sh",
		"scripts/stand-down.sh",
		"scripts/status.sh",
		"scripts/check-docs.mjs",
		"scripts/check-evidence-inventory.mjs",
		"scripts/check-manifest.mjs",
		"scripts/check-stage1-live-smoke-evidence.mjs",
		"scripts/check-stage2-live-evidence.mjs",
		"scripts/finalize-stage2-live-evidence.mjs",
		"scripts/gate-source.mjs",
		"scripts/git-reconcile.mjs",
		"scripts/harness-fs-helper.py",
		"scripts/harness-teardown.mjs",
		"scripts/herdr-identity.mjs",
		"scripts/operation-journal.mjs",
		"scripts/operation-policy.mjs",
		"scripts/private-state-schema.mjs",
		"scripts/report-harvest.mjs",
		"scripts/report-publisher.mjs",
		"scripts/run-stage1-live-smoke.mjs",
		"scripts/run-stage2-live-evidence.mjs",
		"scripts/source-policy.mjs",
		"scripts/stage1-evidence-contract.mjs",
		"scripts/stage1-runtime.mjs",
		"scripts/stage2-checkpoint-catalog.mjs",
		"scripts/stage2-evidence-contract.mjs",
		"scripts/stage2-lifecycle.mjs",
		"scripts/state-internal.mjs",
		"scripts/state-kernel.mjs",
		"scripts/state-root.mjs",
		"scripts/task-authority.mjs",
		"scripts/task-report-schema.mjs",
		"tests/board.test.mjs",
		"tests/docs.test.mjs",
		"tests/evidence-gates.test.mjs",
		"tests/harness-teardown.test.mjs",
		"tests/manifest.test.mjs",
		"tests/private-state-schema.test.mjs",
		"tests/report-publisher.test.mjs",
		"tests/stage1-live-smoke-harness.test.mjs",
		"tests/stage1-runtime-assemble.test.mjs",
		"tests/stage1-runtime-crash-boundary.test.mjs",
		"tests/stage1-runtime-helpers.mjs",
		"tests/stage1-runtime-reconcile.test.mjs",
		"tests/stage1-runtime-stand-down-archive.test.mjs",
		"tests/stage2-actions.test.mjs",
		"tests/stage2-concurrency.test.mjs",
		"tests/stage2-crash-boundary.test.mjs",
		"tests/stage2-effect-isolation.test.mjs",
		"tests/stage2-error-mapping.test.mjs",
		"tests/stage2-filesystem.test.mjs",
		"tests/stage2-isolation-replay.test.mjs",
		"tests/stage2-lifecycle.test.mjs",
		"tests/stage2-live-evidence.test.mjs",
		"tests/stage2-reconcile-determinism.test.mjs",
		"tests/stage2-report-harvest.test.mjs",
		"tests/stage2-runtime-helpers.mjs",
		"tests/stage2-source-policy.test.mjs",
		"tests/state-kernel.test.mjs",
		"tests/task-report-schema.test.mjs",
		"tests/fixtures/b3-crash-child.mjs",
		"tests/fixtures/evidence-publication-child.mjs",
		"tests/fixtures/fake-herdr.mjs",
		"tests/fixtures/harness-preteardown-failure-child.mjs",
		"tests/fixtures/harness-teardown-child.mjs",
		"tests/fixtures/stage1-crash-child.mjs",
		"tests/fixtures/stage2-crash-child.mjs",
		"tests/fixtures/state-lock-child.mjs",
	]),
});

function fail(code, message, cause) {
	throw new StateKernelError(code, message, cause ? { cause } : undefined);
}
function hash(domain, value) {
	let bytes = value;
	if (!Buffer.isBuffer(bytes) && typeof bytes !== "string")
		bytes = canonicalJson(bytes);
	return createHash("sha256").update(domain).update(bytes).digest("hex");
}
function exact(value, keys, label) {
	if (!value || typeof value !== "object" || Array.isArray(value))
		fail("invalid_contract", `${label} must be an object`);
	if (Object.keys(value).sort().join("\0") !== [...keys].sort().join("\0"))
		fail("invalid_contract", `${label} has missing or unknown fields`);
}
function digest(value, label) {
	if (!DIGEST.test(value)) fail("digest_mismatch", `${label} is invalid`);
}
function sha(value, label) {
	if (!SHA.test(value)) fail("invalid_contract", `${label} is invalid`);
}
function id(value, label) {
	if (!ID.test(value)) fail("invalid_contract", `${label} is invalid`);
}
function containsLocalPathForm(value) {
	return (
		/(?:^|[^A-Za-z0-9._~%+/])\/(?!\/)/.test(value) ||
		/(?:^|[\s"'`([{=,:;-])(?:[A-Za-z]:[\\/]|\\\\[^\\\s]+\\)/.test(value) ||
		/(?:^|[\s"'`([{=,:;-])(?:file:\/\/|~[\\/])/i.test(value)
	);
}

function positive(value, label) {
	if (!Number.isSafeInteger(value) || value < 1)
		fail("invalid_contract", `${label} is invalid`);
}
function without(value, field) {
	const copy = structuredClone(value);
	delete copy[field];
	return copy;
}

export function stage2SourceDefinitionDigest() {
	return hash(
		"herdr-conductor/stage2-source-definition/v1\n",
		STAGE2_RUNTIME_SOURCE_DEFINITION,
	);
}

export function buildStage2SourceManifest(repository, candidate) {
	sha(candidate, "candidate SHA");
	const definitionDigest = stage2SourceDefinitionDigest();
	const files = STAGE2_RUNTIME_SOURCE_DEFINITION.paths.map((path) => {
		let bytes;
		try {
			bytes = execFileSync(
				"git",
				["-C", repository, "show", `${candidate}:${path}`],
				{ stdio: ["ignore", "pipe", "pipe"] },
			);
		} catch (error) {
			fail("candidate_mismatch", `candidate is missing ${path}`, error);
		}
		return { path, sha256: hash("", bytes) };
	});
	return Object.freeze({
		document_type: "herdr-conductor-stage2-runtime-source-manifest",
		schema_version: 1,
		source_definition_id: STAGE2_RUNTIME_SOURCE_DEFINITION.id,
		source_definition_version: STAGE2_RUNTIME_SOURCE_DEFINITION.version,
		source_definition_sha256: definitionDigest,
		candidate_sha: candidate,
		entry_count: files.length,
		files,
	});
}

function validateStage2SourceManifest(value, expected = {}) {
	exact(
		value,
		[
			"document_type",
			"schema_version",
			"source_definition_id",
			"source_definition_version",
			"source_definition_sha256",
			"candidate_sha",
			"entry_count",
			"files",
		],
		"source manifest",
	);
	if (
		value.document_type !== "herdr-conductor-stage2-runtime-source-manifest" ||
		value.schema_version !== 1
	)
		fail("wrong_version", "source manifest type/version is unsupported");
	if (
		value.source_definition_id !== STAGE2_RUNTIME_SOURCE_DEFINITION.id ||
		value.source_definition_version !== 1 ||
		value.source_definition_sha256 !== stage2SourceDefinitionDigest()
	)
		fail("candidate_mismatch", "source definition binding is stale");
	sha(value.candidate_sha, "source manifest candidate");
	if (expected.candidate && value.candidate_sha !== expected.candidate)
		fail("candidate_mismatch", "source manifest candidate differs");
	if (
		!Array.isArray(value.files) ||
		value.entry_count !== value.files.length ||
		value.files.length !== STAGE2_RUNTIME_SOURCE_DEFINITION.paths.length
	)
		fail("invalid_contract", "source manifest cardinality differs");
	value.files.forEach((entry, index) => {
		exact(entry, ["path", "sha256"], `source manifest file ${index}`);
		if (entry.path !== STAGE2_RUNTIME_SOURCE_DEFINITION.paths[index])
			fail("candidate_mismatch", "source manifest path order differs");
		digest(entry.sha256, `source manifest file ${index} digest`);
	});
	return Object.freeze(structuredClone(value));
}

function reviewScopeDigest(paths) {
	return hash("herdr-conductor-review-scope-v1\0", paths);
}
export function externalReviewDigest(review) {
	return hash(
		"herdr-conductor-external-review-record-v1\0",
		without(review, "review_record_sha256"),
	);
}

export function validateExternalReviewRecord(value, expected = {}) {
	exact(
		value,
		[
			"document_type",
			"schema_version",
			"review_id",
			"review_record_sha256",
			"candidate",
			"reviewed_scope",
			"reviewer_assertions",
			"findings",
			"completed_at",
		],
		"external review",
	);
	if (
		value.document_type !== "herdr-conductor-external-review" ||
		value.schema_version !== 1
	)
		fail("wrong_version", "external review type/version is unsupported");
	if (value.review_id !== EXTERNAL_REVIEW_ID)
		fail("invalid_contract", "review id is not the fixed release token");
	digest(value.review_record_sha256, "review digest");
	exact(
		value.candidate,
		[
			"commit_sha",
			"source_definition_id",
			"source_definition_version",
			"source_definition_sha256",
			"source_manifest_filename",
			"source_manifest_sha256",
			"source_manifest_entry_count",
		],
		"review candidate",
	);
	sha(value.candidate.commit_sha, "review candidate SHA");
	digest(
		value.candidate.source_definition_sha256,
		"review source definition digest",
	);
	digest(
		value.candidate.source_manifest_sha256,
		"review source manifest digest",
	);
	positive(
		value.candidate.source_manifest_entry_count,
		"review source entry count",
	);
	if (
		value.candidate.source_definition_id !==
			STAGE2_RUNTIME_SOURCE_DEFINITION.id ||
		value.candidate.source_definition_version !== 1 ||
		value.candidate.source_definition_sha256 !==
			stage2SourceDefinitionDigest() ||
		value.candidate.source_manifest_filename !==
			"stage2-runtime-source-manifest.json"
	)
		fail("candidate_mismatch", "review source binding is stale");
	exact(
		value.reviewed_scope,
		["kind", "paths", "scope_sha256"],
		"reviewed scope",
	);
	if (
		value.reviewed_scope.kind !== "complete_candidate_source_manifest" ||
		!Array.isArray(value.reviewed_scope.paths)
	)
		fail("invalid_contract", "reviewed scope is invalid");
	value.reviewed_scope.paths.forEach((path) =>
		validateRelativePath(path, "reviewed scope path"),
	);
	if (
		new Set(value.reviewed_scope.paths).size !==
			value.reviewed_scope.paths.length ||
		value.reviewed_scope.scope_sha256 !==
			reviewScopeDigest(value.reviewed_scope.paths)
	)
		fail("digest_mismatch", "reviewed scope digest differs");
	exact(
		value.reviewer_assertions,
		["reviewer_kind", "independence", "decision"],
		"reviewer assertions",
	);
	if (
		value.reviewer_assertions.reviewer_kind !== REVIEWER_KIND ||
		value.reviewer_assertions.independence !== REVIEW_INDEPENDENCE ||
		value.reviewer_assertions.decision !== REVIEW_DECISION
	)
		fail("invalid_contract", "review assertions differ from fixed GO tokens");
	if (!Array.isArray(value.findings) || value.findings.length !== 0)
		fail("review_rejected", "a GO release review must have no findings");
	if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.completed_at))
		fail("invalid_contract", "review timestamp is invalid");
	if (value.review_record_sha256 !== externalReviewDigest(value))
		fail("digest_mismatch", "external review digest differs");
	if (expected.candidate && value.candidate.commit_sha !== expected.candidate)
		fail("candidate_mismatch", "external review candidate differs");
	if (expected.sourceManifest) {
		const manifest = validateStage2SourceManifest(expected.sourceManifest, {
			candidate: expected.candidate,
		});
		if (
			value.candidate.source_manifest_sha256 !==
				hash("", canonicalJson(manifest)) ||
			value.candidate.source_manifest_entry_count !== manifest.entry_count ||
			canonicalJson(value.reviewed_scope.paths) !==
				canonicalJson(manifest.files.map(({ path }) => path))
		)
			fail(
				"candidate_mismatch",
				"external review scope/manifest binding differs",
			);
	}
	return Object.freeze(structuredClone(value));
}

export function outputParentBinding({
	candidateSha,
	runId,
	canonicalPath,
	device,
	inode,
	owner,
	mode = "0700",
}) {
	sha(candidateSha, "output binding candidate");
	id(runId, "output binding run id");
	if (typeof canonicalPath !== "string" || !canonicalPath.startsWith("/"))
		fail("path_mismatch", "output parent path is invalid");
	for (const [label, value] of [
		["device", device],
		["inode", inode],
		["owner", owner],
	])
		if (!/^\d+$/.test(String(value)))
			fail("invalid_contract", `output parent ${label} is invalid`);
	if (mode !== "0700")
		fail("invalid_contract", "output parent mode is invalid");
	return hash("herdr-conductor/output-parent-binding/v1\n", {
		candidate_sha: candidateSha,
		run_id: runId,
		canonical_path: canonicalPath,
		device: String(device),
		inode: String(inode),
		owner: String(owner),
		mode,
	});
}

export function renderStage2EvidenceReport(machinePreimage) {
	const candidate = machinePreimage.candidate_sha;
	const review = machinePreimage.external_review;
	return Buffer.from(
		[
			"# Conductor Stage 2 live contracts evidence",
			"",
			`- Candidate: \`${candidate}\``,
			`- Cleanup: **${machinePreimage.cleanup_result.status}**`,
			`- External review: \`${review.review_id}\` (${review.review_record_sha256})`,
			"- Review assertion: independent external human, independent of implementation authorship, GO with zero findings; unauthenticated and not a signature or remote attestation.",
			`- Integration: \`${machinePreimage.runtime_summary.final_integration_sha}\``,
			`- Completion scope: ${machinePreimage.runtime_summary.task_count} tasks, ${machinePreimage.runtime_summary.report_count} reports, ${machinePreimage.runtime_summary.gate_count} gates.`,
			"",
			"This report is a deterministic rendering of the retained machine evidence.",
			"",
		].join("\n"),
	);
}

function validateMachine(machine, source, expectedCandidate) {
	exact(
		machine,
		[
			"document_type",
			"schema_version",
			"candidate_sha",
			"run_id",
			"source_manifest_sha256",
			"human_report_sha256",
			"output_parent_binding",
			"output_files",
			"cleanup_result",
			"external_review",
			"external_review_digest",
			"runtime_summary",
		],
		"machine evidence",
	);
	if (
		machine.document_type !== "herdr-conductor-stage2-live-evidence" ||
		machine.schema_version !== 1
	)
		fail("wrong_version", "machine evidence type/version is unsupported");
	sha(machine.candidate_sha, "machine candidate");
	id(machine.run_id, "machine run id");
	if (expectedCandidate && machine.candidate_sha !== expectedCandidate)
		fail("candidate_mismatch", "machine candidate differs");
	for (const field of [
		"source_manifest_sha256",
		"human_report_sha256",
		"output_parent_binding",
		"external_review_digest",
	])
		digest(machine[field], `machine ${field}`);
	if (machine.source_manifest_sha256 !== hash("", source))
		fail("digest_mismatch", "machine source manifest digest differs");
	exact(
		machine.output_files,
		["source_manifest", "human_report", "machine_evidence"],
		"machine output files",
	);
	if (
		canonicalJson(machine.output_files) !==
		canonicalJson({
			source_manifest: basename(STAGE2_EVIDENCE_PATHS[0]),
			human_report: basename(STAGE2_EVIDENCE_PATHS[2]),
			machine_evidence: basename(STAGE2_EVIDENCE_PATHS[1]),
		})
	)
		fail("invalid_contract", "machine output filenames differ");
	exact(
		machine.cleanup_result,
		[
			"status",
			"root_absent",
			"workspace_absent",
			"state_absent",
			"out_of_root_deletion_count",
			"unlisted_residue_count",
		],
		"cleanup result",
	);
	if (
		machine.cleanup_result.status !== "passed" ||
		machine.cleanup_result.root_absent !== true ||
		machine.cleanup_result.workspace_absent !== true ||
		machine.cleanup_result.state_absent !== true ||
		machine.cleanup_result.out_of_root_deletion_count !== 0 ||
		machine.cleanup_result.unlisted_residue_count !== 0
	)
		fail("cleanup_failed", "cleanup proof did not pass");
	validateExternalReviewRecord(machine.external_review, {
		candidate: machine.candidate_sha,
		sourceManifest: parseStrictJsonBytes(source),
	});
	if (
		machine.external_review_digest !==
		machine.external_review.review_record_sha256
	)
		fail("digest_mismatch", "machine review digest differs");
	exact(
		machine.runtime_summary,
		[
			"herdr_version",
			"protocol_version",
			"api_schema_version",
			"action_sequence",
			"producer_selection_sha256",
			"final_integration_sha",
			"gate_shas",
			"task_report_digests",
			"task_count",
			"report_count",
			"gate_count",
			"journal_head",
			"journal_entry_count",
			"retained_inventory_sha256",
			"retained_inventory_count",
			"refusal_snapshot_sha256",
			"integration_cas_count",
			"forbidden_effect_count",
		],
		"runtime summary",
	);
	if (
		machine.runtime_summary.herdr_version !== "0.7.5" ||
		machine.runtime_summary.protocol_version !== 17 ||
		machine.runtime_summary.api_schema_version !== 1
	)
		fail("wrong_version", "runtime evidence version differs");
	if (
		canonicalJson(machine.runtime_summary.action_sequence) !==
		canonicalJson([
			"assemble",
			"board",
			"status",
			"harvest",
			"harvest",
			"stand-down",
		])
	)
		fail("invalid_contract", "runtime action sequence differs");
	for (const field of [
		"producer_selection_sha256",
		"journal_head",
		"retained_inventory_sha256",
		"refusal_snapshot_sha256",
	])
		digest(machine.runtime_summary[field], `runtime ${field}`);
	sha(machine.runtime_summary.final_integration_sha, "runtime integration SHA");
	if (
		!Array.isArray(machine.runtime_summary.gate_shas) ||
		machine.runtime_summary.gate_shas.some((value) => !SHA.test(value))
	)
		fail("invalid_contract", "runtime gate SHAs are invalid");
	if (!Array.isArray(machine.runtime_summary.task_report_digests))
		fail("invalid_contract", "runtime task/report digests are invalid");
	let priorRole = "";
	for (const entry of machine.runtime_summary.task_report_digests) {
		exact(
			entry,
			["role", "task_digest", "report_digest", "assertion_strength"],
			"runtime task/report digest",
		);
		id(entry.role, "runtime task/report role");
		if (entry.role <= priorRole)
			fail(
				"invalid_contract",
				"runtime task/report roles are not unique sorted",
			);
		priorRole = entry.role;
		digest(entry.task_digest, "runtime task digest");
		digest(entry.report_digest, "runtime report digest");
		if (entry.assertion_strength !== "unauthenticated_worker_assertion")
			fail("invalid_contract", "runtime assertion strength differs");
	}
	for (const field of [
		"task_count",
		"report_count",
		"gate_count",
		"journal_entry_count",
		"retained_inventory_count",
		"integration_cas_count",
		"forbidden_effect_count",
	])
		if (
			!Number.isSafeInteger(machine.runtime_summary[field]) ||
			machine.runtime_summary[field] < 0
		)
			fail("invalid_contract", `runtime ${field} is invalid`);
	if (
		machine.runtime_summary.gate_count !==
			machine.runtime_summary.gate_shas.length ||
		machine.runtime_summary.task_count !==
			machine.runtime_summary.task_report_digests.length ||
		machine.runtime_summary.report_count !==
			machine.runtime_summary.task_report_digests.length ||
		machine.runtime_summary.integration_cas_count !== 1 ||
		machine.runtime_summary.forbidden_effect_count !== 0
	)
		fail("invalid_contract", "runtime summary count differs");
	return machine;
}

export function evidenceCompletionDigest(
	sourceBytes,
	humanBytes,
	machineBytes,
	machine,
) {
	return hash("herdr-conductor/evidence-trio-completion/v1\n", {
		candidate_sha: machine.candidate_sha,
		source_manifest_sha256: hash("", sourceBytes),
		human_report_sha256: hash("", humanBytes),
		machine_evidence_sha256: hash("", machineBytes),
		cleanup_result_digest: hash("", machine.cleanup_result),
		external_review_digest: machine.external_review.review_record_sha256,
	});
}

export function validateEvidenceBytes(
	sourceBytes,
	humanBytes,
	machineBytes,
	expectedCandidate,
	{ localPaths = [], localValues = [] } = {},
) {
	const source = Buffer.from(sourceBytes);
	const human = Buffer.from(humanBytes);
	const machineRaw = Buffer.from(machineBytes);
	const sourceObject = validateStage2SourceManifest(
		parseStrictJsonBytes(source),
		{ candidate: expectedCandidate },
	);
	if (!source.equals(Buffer.from(canonicalJson(sourceObject))))
		fail("digest_mismatch", "source manifest bytes are not canonical");
	const machine = validateMachine(
		parseStrictJsonBytes(machineRaw),
		source,
		expectedCandidate,
	);
	if (!machineRaw.equals(Buffer.from(canonicalJson(machine))))
		fail("digest_mismatch", "machine evidence bytes are not canonical");
	if (machine.human_report_sha256 !== hash("", human))
		fail("digest_mismatch", "human report digest differs");
	const rendered = renderStage2EvidenceReport(
		without(machine, "human_report_sha256"),
	);
	if (!rendered.equals(human))
		fail("digest_mismatch", "human report rerender differs");
	assertSanitizedEvidence(machine, human, { localPaths, localValues });
	return Object.freeze({
		completionDigest: evidenceCompletionDigest(
			source,
			human,
			machineRaw,
			machine,
		),
		machine,
		source: sourceObject,
	});
}

export function assertSanitizedEvidence(
	machine,
	humanBytes,
	{ localPaths = [], localValues = [] } = {},
) {
	const strings = [];
	const forbiddenFields = new Set([
		"output_parent",
		"canonical_path",
		"device",
		"inode",
		"owner",
	]);
	const visit = (value) => {
		if (typeof value === "string") strings.push(value);
		else if (Array.isArray(value)) value.forEach(visit);
		else if (value && typeof value === "object")
			for (const [key, child] of Object.entries(value)) {
				if (forbiddenFields.has(key))
					fail("invalid_contract", `machine evidence exposes ${key}`);
				visit(child);
			}
	};
	visit(machine);
	const human = Buffer.from(humanBytes).toString("utf8");
	strings.push(human);
	if (strings.some(containsLocalPathForm))
		fail("invalid_contract", "evidence contains a local path form");
	// Local values are accepted only as a compatibility input to callers. Evidence
	// contains closed schemas of fixed tokens, IDs, digests, and SHAs, so raw
	// substring scans would make valid digests depend on short local names.
	void localPaths;
	void localValues;
	return true;
}

export function sensitivePathComponents(paths) {
	const fixedRepresentation = canonicalJson({
		source: STAGE2_RUNTIME_SOURCE_DEFINITION,
		review: {
			review_id: EXTERNAL_REVIEW_ID,
			reviewer_kind: REVIEWER_KIND,
			independence: REVIEW_INDEPENDENCE,
			decision: REVIEW_DECISION,
		},
	});
	const structural = new Set([
		"Users",
		"home",
		"private",
		"Volumes",
		"mnt",
		"media",
		"tmp",
		"var",
		"folders",
		"opt",
		"srv",
		"data",
		"nix",
		"store",
		"dev",
		"T",
		"repositories",
		"repository",
		"state",
		"output",
		"outputs",
		"checkout",
		"workspace",
		"workspaces",
	]);
	const components = new Set();
	for (const path of paths.map(String).filter(Boolean))
		for (const component of path.split(/[\\/]+/)) {
			if (
				component.length < 3 ||
				structural.has(component) ||
				/^\d+$/.test(component) ||
				/^[a-f0-9]{40}$/.test(component) ||
				/^[a-f0-9]{64}$/.test(component) ||
				fixedRepresentation.includes(component)
			)
				continue;
			components.add(component);
		}
	return Object.freeze([...components].sort());
}

function readDescriptor(descriptor, size) {
	const bytes = Buffer.alloc(size);
	let offset = 0;
	while (offset < size) {
		const count = readSync(descriptor, bytes, offset, size - offset, offset);
		if (count === 0) fail("input_read_error", "evidence file was truncated");
		offset += count;
	}
	return bytes;
}

function verifyOutputParent(handle, expectedNames) {
	const stats = fstatSync(handle.descriptor, { bigint: true });
	if (
		!stats.isDirectory() ||
		Number(stats.mode & 0o777n) !== 0o700 ||
		String(stats.dev) !== String(handle.device) ||
		String(stats.ino) !== String(handle.inode) ||
		String(stats.uid) !== String(handle.owner)
	)
		fail("path_mismatch", "held output parent identity differs");
	const actual = readdirSync(handle.canonicalPath).sort();
	if (actual.join("\0") !== [...expectedNames].sort().join("\0"))
		fail("path_mismatch", "output parent inventory differs");
}

export function publishPrivateEvidenceTrio(
	outputParent,
	{ sourceBytes, humanBytes, machineBytes },
	{ checkpoint = () => {} } = {},
) {
	const outputs = [
		[basename(STAGE2_EVIDENCE_PATHS[0]), Buffer.from(sourceBytes)],
		[basename(STAGE2_EVIDENCE_PATHS[2]), Buffer.from(humanBytes)],
		[basename(STAGE2_EVIDENCE_PATHS[1]), Buffer.from(machineBytes)],
	];
	const created = [];
	for (const [name, bytes] of outputs) {
		verifyOutputParent(outputParent, created);
		checkpoint(`before_create:${name}`);
		const descriptor = openSync(
			join(outputParent.canonicalPath, name),
			constants.O_RDWR |
				constants.O_CREAT |
				constants.O_EXCL |
				constants.O_NOFOLLOW,
			0o600,
		);
		try {
			checkpoint(`after_create:${name}`);
			let offset = 0;
			while (offset < bytes.length)
				offset += writeSync(descriptor, bytes, offset, bytes.length - offset);
			checkpoint(`after_write:${name}`);
			fsyncSync(descriptor);
			checkpoint(`after_fsync:${name}`);
			const stats = fstatSync(descriptor);
			if (
				!stats.isFile() ||
				stats.nlink !== 1 ||
				(stats.mode & 0o777) !== 0o600 ||
				stats.uid !== process.getuid() ||
				stats.size !== bytes.length ||
				!readDescriptor(descriptor, bytes.length).equals(bytes)
			)
				fail("durability_unknown", `evidence output ${name} readback differs`);
			checkpoint(`after_readback:${name}`);
		} finally {
			closeSync(descriptor);
		}
		fsyncSync(outputParent.descriptor);
		created.push(name);
		checkpoint(`after_parent_fsync:${name}`);
	}
	verifyOutputParent(
		outputParent,
		outputs.map(([name]) => name),
	);
	return finalizePrivateEvidenceTrio(
		outputParent.canonicalPath,
		parseStrictJsonBytes(machineBytes).candidate_sha,
	);
}

function privateFile(parent, name) {
	const descriptor = openSync(
		join(parent, name),
		constants.O_RDONLY | constants.O_NOFOLLOW,
	);
	const stats = fstatSync(descriptor);
	if (
		!stats.isFile() ||
		stats.nlink !== 1 ||
		(stats.mode & 0o777) !== 0o600 ||
		stats.uid !== process.getuid()
	) {
		closeSync(descriptor);
		fail("path_mismatch", `evidence file ${name} identity differs`);
	}
	return { descriptor, stats };
}

export function finalizePrivateEvidenceTrio(
	outputParentPath,
	expectedCandidate,
) {
	const parent = realpathSync(outputParentPath);
	if (parent !== resolve(outputParentPath))
		fail("path_mismatch", "output parent path is not canonical");
	const parentFd = openSync(
		parent,
		constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
	);
	const parentStats = fstatSync(parentFd, { bigint: true });
	if (
		!parentStats.isDirectory() ||
		Number(parentStats.mode & 0o777n) !== 0o700 ||
		Number(parentStats.uid) !== process.getuid()
	) {
		closeSync(parentFd);
		fail("path_mismatch", "output parent identity differs");
	}
	const expectedNames = [
		basename(STAGE2_EVIDENCE_PATHS[0]),
		basename(STAGE2_EVIDENCE_PATHS[2]),
		basename(STAGE2_EVIDENCE_PATHS[1]),
	].sort();
	const opened = [];
	try {
		if (readdirSync(parent).sort().join("\0") !== expectedNames.join("\0"))
			fail("path_mismatch", "output parent is not an exact evidence trio");
		for (const name of expectedNames)
			opened.push([name, privateFile(parent, name)]);
		const byName = Object.fromEntries(opened);
		const source = readFileSync(
			byName[basename(STAGE2_EVIDENCE_PATHS[0])].descriptor,
		);
		const human = readFileSync(
			byName[basename(STAGE2_EVIDENCE_PATHS[2])].descriptor,
		);
		const machineBytes = readFileSync(
			byName[basename(STAGE2_EVIDENCE_PATHS[1])].descriptor,
		);
		const parsed = parseStrictJsonBytes(machineBytes);
		const binding = outputParentBinding({
			candidateSha: expectedCandidate,
			runId: parsed.run_id,
			canonicalPath: parent,
			device: parentStats.dev,
			inode: parentStats.ino,
			owner: parentStats.uid,
		});
		if (parsed.output_parent_binding !== binding)
			fail("path_mismatch", "historical output parent binding differs");
		const result = validateEvidenceBytes(
			source,
			human,
			machineBytes,
			expectedCandidate,
		);
		opened.forEach(([, entry]) => fsyncSync(entry.descriptor));
		fsyncSync(parentFd);
		return result;
	} finally {
		opened.forEach(([, entry]) => closeSync(entry.descriptor));
		closeSync(parentFd);
	}
}

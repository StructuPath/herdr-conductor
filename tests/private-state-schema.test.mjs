import { test } from "node:test";
import assert from "node:assert/strict";
import {
	STAGE3_APPROVAL_STATEMENTS,
	StateKernelError,
	canonicalJson,
	parseStrictJsonBytes,
	validateActiveRun,
	validateJournalEntry,
	validateLockOwner,
	validateRepositoryDocument,
	validateRunState,
	validateStage3ApplyIdentity,
	validateStage3ApprovalIdentity,
	validateStage3ConsumptionIdentity,
	validateStage3PreviewIdentity,
} from "../scripts/private-state-schema.mjs";

const REPO_KEY = "a".repeat(64);
const WORKSPACE_KEY = "b".repeat(64);
const GENERATION = "c".repeat(32);
const SHA = "d".repeat(40);
const DIGEST = "e".repeat(64);
const TIME = "2026-07-28T22:30:00.000Z";
const COMMON_DIR = { path: "/private/tmp/repo/.git", device: "1", inode: "2" };
const REPOSITORY = { key: REPO_KEY, common_dir: COMMON_DIR };

function clone(value) {
	return structuredClone(value);
}

function expectCode(code, fn) {
	assert.throws(
		fn,
		(error) => error instanceof StateKernelError && error.code === code,
	);
}

function repositoryDocument() {
	return {
		document_type: "herdr-conductor-repository",
		schema_version: 1,
		repository: REPOSITORY,
	};
}

function activeRun() {
	return {
		document_type: "herdr-conductor-active-run",
		schema_version: 1,
		revision: 0,
		repository_key: REPO_KEY,
		workspace_id: "wB0",
		workspace_key: WORKSPACE_KEY,
		run_id: "run-b1",
		generation: GENERATION,
		created_at: TIME,
	};
}

function runState() {
	return {
		document_type: "herdr-conductor-run",
		schema_version: 1,
		revision: 0,
		repository: clone(REPOSITORY),
		repository_root: "/private/tmp/repo",
		workspace_id: "wB0",
		workspace_key: WORKSPACE_KEY,
		run_id: "run-b1",
		generation: GENERATION,
		fork_sha: SHA,
		status: "active",
		journal_sequence: 0,
		journal_head: null,
		created_at: TIME,
		updated_at: TIME,
	};
}

function lockOwner() {
	return {
		document_type: "herdr-conductor-repository-lock",
		schema_version: 1,
		repository_key: REPO_KEY,
		lock_id: GENERATION,
		operation_id: "create-run",
		pid: 123,
		acquired_at: TIME,
	};
}

function journalEntry(phase = "intent") {
	return {
		document_type: "herdr-conductor-operation",
		schema_version: 1,
		repository_key: REPO_KEY,
		workspace_id: "wB0",
		workspace_key: WORKSPACE_KEY,
		run_id: "run-b1",
		run_generation: GENERATION,
		sequence: 1,
		operation_id: "create-pane",
		operation_type: "pane.create",
		subject: { kind: "pane", id: "builder", generation: "f".repeat(32) },
		request_digest: DIGEST,
		previous_digest: null,
		entry_digest: "f".repeat(64),
		phase,
		result_digest: phase === "observed" ? "1".repeat(64) : null,
		observed_identity: null,
		error_code: phase === "needs_attention" ? "external_effect_unknown" : null,
		created_at: TIME,
		updated_at: TIME,
	};
}

test("strict JSON rejects duplicate keys, malformed input, BOM, invalid UTF-8, and lone surrogates", () => {
	expectCode("duplicate_json_key", () =>
		parseStrictJsonBytes(Buffer.from('{"a":1,"a":2}')),
	);
	expectCode("duplicate_json_key", () =>
		parseStrictJsonBytes(Buffer.from('{"a":{"b":1,"b":2}}')),
	);
	expectCode("invalid_json", () => parseStrictJsonBytes(Buffer.from('{"a":')));
	expectCode("invalid_json", () =>
		parseStrictJsonBytes(Buffer.from("\ufeff{}")),
	);
	expectCode("invalid_json", () => parseStrictJsonBytes(Buffer.from([0xff])));
	expectCode("invalid_json", () =>
		parseStrictJsonBytes(Buffer.from('{"a":"\\ud800"}')),
	);
});

test("strict JSON enforces bounds and does not permit prototype mutation", () => {
	expectCode("invalid_json", () =>
		parseStrictJsonBytes(Buffer.alloc(1024 * 1024 + 1, 0x20)),
	);
	const value = parseStrictJsonBytes(
		Buffer.from('{"__proto__":{"polluted":true},"safe":1}'),
	);
	assert.equal(Object.getPrototypeOf(value), null);
	assert.equal({}.polluted, undefined);
	assert.deepEqual(Object.keys(value).sort(), ["__proto__", "safe"]);
});

test("repository and active-run validators reject extra keys and wrong versions", () => {
	assert.deepEqual(
		validateRepositoryDocument(repositoryDocument()),
		repositoryDocument(),
	);
	assert.deepEqual(validateActiveRun(activeRun()), activeRun());
	const extra = repositoryDocument();
	extra.command = "touch /tmp/never";
	expectCode("invalid_state", () => validateRepositoryDocument(extra));
	const wrongVersion = activeRun();
	wrongVersion.schema_version = 2;
	expectCode("wrong_version", () => validateActiveRun(wrongVersion));
});

test("run state rejects the removed resource projection and returns frozen data", () => {
	const validated = validateRunState(runState());
	assert.ok(Object.isFrozen(validated));
	const legacyProjection = { ...runState(), resources: [] };
	expectCode("invalid_state", () => validateRunState(legacyProjection));
});

test("lock and journal validators enforce exact fields and phase conditionals", () => {
	assert.deepEqual(validateLockOwner(lockOwner()), lockOwner());
	for (const phase of ["intent", "observed", "needs_attention"]) {
		assert.deepEqual(
			validateJournalEntry(journalEntry(phase)),
			journalEntry(phase),
		);
	}
	const intentWithResult = journalEntry("intent");
	intentWithResult.result_digest = DIGEST;
	expectCode("invalid_state", () => validateJournalEntry(intentWithResult));
	const observedWithError = journalEntry("observed");
	observedWithError.error_code = "bad";
	expectCode("invalid_state", () => validateJournalEntry(observedWithError));
	const unknownOperation = journalEntry();
	unknownOperation.operation_type = "shell.exec";
	expectCode("invalid_state", () => validateJournalEntry(unknownOperation));
});

function stage3Scope() {
	return {
		repository_key: REPO_KEY,
		workspace_id: "wB0",
		run_id: "run-b1",
		run_generation: GENERATION,
		attempt_generation: "9".repeat(32),
	};
}

function stage3Preview() {
	return {
		document_type: "herdr-conductor-stage3-preview",
		schema_version: 1,
		...stage3Scope(),
		integration: {
			target_ref: "refs/heads/main",
			starting_sha: SHA,
			final_sha: "e".repeat(40),
			integration_entry_digest: DIGEST,
		},
		gates: [
			{
				role_name: "reviewer",
				contract_role: "reviewer",
				task_digest: DIGEST,
				report_digest: DIGEST,
				status: "completed",
				result_kind: "review",
				verdict: "approve",
			},
			{
				role_name: "validator",
				contract_role: "validator",
				task_digest: DIGEST,
				report_digest: DIGEST,
				status: "completed",
				result_kind: "validation",
				verdict: "pass",
			},
		],
		apply: {
			target_ref: "refs/heads/release",
			observed_sha: SHA,
			final_sha: "e".repeat(40),
			diff_name_status_sha256: DIGEST,
			changed_path_count: 3,
		},
	};
}

function stage3Approval(decision = "approve") {
	return {
		document_type: "herdr-conductor-stage3-approval",
		schema_version: 1,
		...stage3Scope(),
		preview_entry_digest: DIGEST,
		decision,
		statement: STAGE3_APPROVAL_STATEMENTS[decision],
	};
}

function stage3Apply(outcome = "applied") {
	return {
		document_type: "herdr-conductor-stage3-apply",
		schema_version: 1,
		...stage3Scope(),
		consumption_entry_digest: DIGEST,
		target_ref: "refs/heads/release",
		expected_sha: SHA,
		final_sha: "e".repeat(40),
		cas_count: outcome === "applied" ? 1 : 0,
		outcome,
	};
}

test("stage3 preview identity binds integration, gates, and the apply target", () => {
	const label = "preview";
	assert.deepEqual(
		validateStage3PreviewIdentity(stage3Preview(), label),
		stage3Preview(),
	);
	const wrongOrder = stage3Preview();
	wrongOrder.gates.reverse();
	expectCode("invalid_state", () =>
		validateStage3PreviewIdentity(wrongOrder, label),
	);
	const sameRef = stage3Preview();
	sameRef.apply.target_ref = sameRef.integration.target_ref;
	expectCode("invalid_state", () =>
		validateStage3PreviewIdentity(sameRef, label),
	);
	const drifted = stage3Preview();
	drifted.apply.observed_sha = "f".repeat(40);
	expectCode("invalid_state", () =>
		validateStage3PreviewIdentity(drifted, label),
	);
	const emptyMove = stage3Preview();
	emptyMove.integration.final_sha = emptyMove.integration.starting_sha;
	emptyMove.apply.final_sha = emptyMove.apply.observed_sha;
	expectCode("invalid_state", () =>
		validateStage3PreviewIdentity(emptyMove, label),
	);
	const zeroPaths = stage3Preview();
	zeroPaths.apply.changed_path_count = 0;
	expectCode("invalid_state", () =>
		validateStage3PreviewIdentity(zeroPaths, label),
	);
	const wrongVerdict = stage3Preview();
	wrongVerdict.gates[0].verdict = "pass";
	expectCode("invalid_state", () =>
		validateStage3PreviewIdentity(wrongVerdict, label),
	);
	const blockedGate = stage3Preview();
	blockedGate.gates[0].status = "blocked";
	expectCode("invalid_state", () =>
		validateStage3PreviewIdentity(blockedGate, label),
	);
});

test("stage3 approval, consumption, and apply identities are closed and bound", () => {
	const label = "stage3";
	assert.deepEqual(
		validateStage3ApprovalIdentity(stage3Approval(), label),
		stage3Approval(),
	);
	assert.deepEqual(
		validateStage3ApprovalIdentity(stage3Approval("reject"), label),
		stage3Approval("reject"),
	);
	const crossedStatement = stage3Approval();
	crossedStatement.statement = STAGE3_APPROVAL_STATEMENTS.reject;
	expectCode("invalid_state", () =>
		validateStage3ApprovalIdentity(crossedStatement, label),
	);
	const freeText = stage3Approval();
	freeText.statement = "I approve";
	expectCode("invalid_state", () =>
		validateStage3ApprovalIdentity(freeText, label),
	);
	const consumption = {
		document_type: "herdr-conductor-stage3-consumption",
		schema_version: 1,
		...stage3Scope(),
		approval_entry_digest: DIGEST,
		preview_entry_digest: DIGEST,
	};
	assert.deepEqual(
		validateStage3ConsumptionIdentity(consumption, label),
		consumption,
	);
	expectCode("invalid_state", () =>
		validateStage3ConsumptionIdentity(
			{ ...consumption, extra: true },
			label,
		),
	);
	assert.deepEqual(validateStage3ApplyIdentity(stage3Apply(), label), stage3Apply());
	assert.deepEqual(
		validateStage3ApplyIdentity(stage3Apply("unapplied"), label),
		stage3Apply("unapplied"),
	);
	const casMismatch = stage3Apply();
	casMismatch.cas_count = 0;
	expectCode("invalid_state", () =>
		validateStage3ApplyIdentity(casMismatch, label),
	);
	const noMove = stage3Apply();
	noMove.final_sha = noMove.expected_sha;
	expectCode("invalid_state", () => validateStage3ApplyIdentity(noMove, label));
});

test("stage3 journal entries validate their observed identities by policy", () => {
	const base = journalEntry("observed");
	const previewEntry = {
		...base,
		operation_id: "apply-preview-attempt",
		operation_type: "apply.preview",
		subject: { kind: "apply", id: "apply", generation: "9".repeat(32) },
		observed_identity: stage3Preview(),
	};
	assert.deepEqual(validateJournalEntry(previewEntry), previewEntry);
	const approvalEntry = {
		...base,
		operation_id: "apply-approve-attempt",
		operation_type: "approval.record",
		subject: { kind: "approval", id: "apply", generation: "9".repeat(32) },
		observed_identity: stage3Approval(),
	};
	assert.deepEqual(validateJournalEntry(approvalEntry), approvalEntry);
	const applyEntry = {
		...base,
		operation_id: "apply-publish-attempt",
		operation_type: "apply.publish",
		subject: { kind: "apply", id: "apply", generation: "9".repeat(32) },
		observed_identity: stage3Apply(),
	};
	assert.deepEqual(validateJournalEntry(applyEntry), applyEntry);
	expectCode("invalid_state", () =>
		validateJournalEntry({
			...applyEntry,
			observed_identity: stage3Approval(),
		}),
	);
	expectCode("invalid_state", () =>
		validateJournalEntry({
			...applyEntry,
			subject: { ...applyEntry.subject, kind: "approval" },
		}),
	);
	expectCode("invalid_state", () =>
		validateJournalEntry({ ...applyEntry, observed_identity: null }),
	);
	expectCode("invalid_state", () =>
		validateJournalEntry({
			...applyEntry,
			observed_identity: {
				...stage3Apply(),
				attempt_generation: "8".repeat(32),
			},
		}),
	);
	expectCode("invalid_state", () =>
		validateJournalEntry({
			...applyEntry,
			observed_identity: { ...stage3Apply(), run_id: "run-b2" },
		}),
	);
	expectCode("invalid_state", () =>
		validateJournalEntry({
			...applyEntry,
			observed_identity: { ...stage3Apply(), workspace_id: "wOther" },
		}),
	);
});

test("canonical JSON recursively sorts keys and terminates with one newline", () => {
	assert.equal(
		canonicalJson({ z: 1, a: { y: 2, b: 3 } }),
		'{\n  "a": {\n    "b": 3,\n    "y": 2\n  },\n  "z": 1\n}\n',
	);
});

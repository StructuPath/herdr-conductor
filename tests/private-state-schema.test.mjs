import { test } from "node:test";
import assert from "node:assert/strict";
import {
	StateKernelError,
	canonicalJson,
	parseStrictJsonBytes,
	validateActiveRun,
	validateJournalEntry,
	validateLockOwner,
	validateRepositoryDocument,
	validateRunState,
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

test("canonical JSON recursively sorts keys and terminates with one newline", () => {
	assert.equal(
		canonicalJson({ z: 1, a: { y: 2, b: 3 } }),
		'{\n  "a": {\n    "b": 3,\n    "y": 2\n  },\n  "z": 1\n}\n',
	);
});

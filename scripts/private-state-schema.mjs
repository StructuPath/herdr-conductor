#!/usr/bin/env node
import { isAbsolute, resolve } from "node:path";
import { TextDecoder } from "node:util";
import {
	OPERATION_TYPES,
	RESOURCE_KINDS,
	operationPolicy,
} from "./operation-policy.mjs";

export const PRIVATE_STATE_VERSION = 1;
export const MAX_STATE_BYTES = 1024 * 1024;

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const KEY = /^[a-f0-9]{64}$/;
const GENERATION = /^[a-f0-9]{32}$/;
const GIT_OBJECT = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const DECIMAL = /^(?:0|[1-9][0-9]{0,39})$/;
const RFC3339_MILLIS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const SAFE_PATH = /^[^\0-\x1f\x7f]{1,4096}$/;
const FULL_REF = /^refs\/[\x21-\x7e]{1,507}$/;

export class StateKernelError extends Error {
	constructor(code, message, options = {}) {
		super(message, options);
		this.name = "StateKernelError";
		this.code = code;
	}
}

function fail(code, message) {
	throw new StateKernelError(code, message);
}

function plainObject(value, label) {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		fail("invalid_state", `${label} must be an object`);
	}
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) {
		fail("invalid_state", `${label} must be a plain object`);
	}
	return value;
}

function exactKeys(value, keys, label) {
	plainObject(value, label);
	const actual = Object.keys(value).sort();
	const expected = [...keys].sort();
	if (
		actual.length !== expected.length ||
		actual.some((key, index) => key !== expected[index])
	) {
		fail("invalid_state", `${label} has missing or unknown fields`);
	}
}

function stringMatching(value, pattern, label) {
	if (typeof value !== "string" || !pattern.test(value)) {
		fail("invalid_state", `${label} is invalid`);
	}
	return value;
}

function safeInteger(value, label, minimum = 0) {
	if (!Number.isSafeInteger(value) || value < minimum) {
		fail("invalid_state", `${label} must be a safe integer >= ${minimum}`);
	}
	return value;
}

function enumValue(value, allowed, label) {
	if (!allowed.has(value)) fail("invalid_state", `${label} is invalid`);
	return value;
}

function timestamp(value, label) {
	stringMatching(value, RFC3339_MILLIS, label);
	const parsed = new Date(value);
	if (!Number.isFinite(parsed.valueOf()) || parsed.toISOString() !== value) {
		fail("invalid_state", `${label} is invalid`);
	}
	return value;
}

function deepFreeze(value) {
	if (value && typeof value === "object" && !Object.isFrozen(value)) {
		Object.freeze(value);
		for (const child of Object.values(value)) deepFreeze(child);
	}
	return value;
}

function normalized(value) {
	return deepFreeze(structuredClone(value));
}

export function validateId(value, label = "id") {
	return stringMatching(value, ID, label);
}

export function validateKey(value, label = "key") {
	return stringMatching(value, KEY, label);
}

export function validateGeneration(value, label = "generation") {
	return stringMatching(value, GENERATION, label);
}

export function validateGitObjectId(value, label = "git object") {
	return stringMatching(value, GIT_OBJECT, label);
}

export function validateCanonicalPath(value, label = "path") {
	stringMatching(value, SAFE_PATH, label);
	if (!isAbsolute(value) || resolve(value) !== value)
		fail("invalid_state", `${label} must be canonical and absolute`);
	return value;
}

export function validateFullRef(value, label = "ref") {
	stringMatching(value, FULL_REF, label);
	if (
		value.includes("\\") ||
		value
			.split("/")
			.some((part) => part === "" || part === "." || part === "..")
	) {
		fail("invalid_state", `${label} is invalid`);
	}
	return value;
}

function validateCommonDirectory(value, label) {
	exactKeys(value, ["path", "device", "inode"], label);
	validateCanonicalPath(value.path, `${label}.path`);
	stringMatching(value.device, DECIMAL, `${label}.device`);
	stringMatching(value.inode, DECIMAL, `${label}.inode`);
	return value;
}

export function validateRepositoryIdentity(value, label = "repository") {
	exactKeys(value, ["key", "common_dir"], label);
	validateKey(value.key, `${label}.key`);
	validateCommonDirectory(value.common_dir, `${label}.common_dir`);
	return normalized(value);
}

function validateAgentSession(value, label) {
	exactKeys(value, ["agent", "kind", "source", "value"], label);
	validateId(value.agent, `${label}.agent`);
	validateId(value.kind, `${label}.kind`);
	validateId(value.source, `${label}.source`);
	if (
		typeof value.value !== "string" ||
		value.value.length < 1 ||
		value.value.length > 4096 ||
		/[\0\r\n]/.test(value.value)
	) {
		fail("invalid_state", `${label}.value is invalid`);
	}
	return value;
}

function validatePaneCreationIdentity(value, label) {
	exactKeys(
		value,
		["workspace_id", "pane_id", "terminal_id", "cwd", "run_id", "generation"],
		label,
	);
	validateId(value.workspace_id, `${label}.workspace_id`);
	validateId(value.pane_id, `${label}.pane_id`);
	validateId(value.terminal_id, `${label}.terminal_id`);
	validateCanonicalPath(value.cwd, `${label}.cwd`);
	validateId(value.run_id, `${label}.run_id`);
	validateGeneration(value.generation, `${label}.generation`);
	return value;
}

function validatePaneIdentity(value, label) {
	exactKeys(
		value,
		[
			"workspace_id",
			"pane_id",
			"terminal_id",
			"agent_name",
			"agent_kind",
			"agent_session",
			"cwd",
			"run_id",
			"generation",
		],
		label,
	);
	validateId(value.workspace_id, `${label}.workspace_id`);
	validateId(value.pane_id, `${label}.pane_id`);
	validateId(value.terminal_id, `${label}.terminal_id`);
	validateId(value.agent_name, `${label}.agent_name`);
	validateId(value.agent_kind, `${label}.agent_kind`);
	validateAgentSession(value.agent_session, `${label}.agent_session`);
	validateCanonicalPath(value.cwd, `${label}.cwd`);
	validateId(value.run_id, `${label}.run_id`);
	validateGeneration(value.generation, `${label}.generation`);
	return value;
}

function validateWorktreeIdentity(value, label) {
	exactKeys(
		value,
		["path", "common_dir", "branch_ref", "fork_sha", "head_sha", "registered"],
		label,
	);
	validateCanonicalPath(value.path, `${label}.path`);
	validateCommonDirectory(value.common_dir, `${label}.common_dir`);
	validateFullRef(value.branch_ref, `${label}.branch_ref`);
	validateGitObjectId(value.fork_sha, `${label}.fork_sha`);
	validateGitObjectId(value.head_sha, `${label}.head_sha`);
	if (typeof value.registered !== "boolean")
		fail("invalid_state", `${label}.registered must be boolean`);
	return value;
}

function validateMergeIdentity(value, label) {
	exactKeys(value, ["source_head_sha", "target"], label);
	validateGitObjectId(value.source_head_sha, `${label}.source_head_sha`);
	validateWorktreeIdentity(value.target, `${label}.target`);
	return value;
}

export function validateRepositoryDocument(value) {
	exactKeys(
		value,
		["document_type", "schema_version", "repository"],
		"repository document",
	);
	if (value.document_type !== "herdr-conductor-repository")
		fail("invalid_state", "wrong repository document type");
	if (value.schema_version !== PRIVATE_STATE_VERSION)
		fail("wrong_version", "unsupported repository schema version");
	validateRepositoryIdentity(value.repository);
	return normalized(value);
}

export function validateActiveRun(value) {
	exactKeys(
		value,
		[
			"document_type",
			"schema_version",
			"revision",
			"repository_key",
			"workspace_id",
			"workspace_key",
			"run_id",
			"generation",
			"created_at",
		],
		"active run",
	);
	if (value.document_type !== "herdr-conductor-active-run")
		fail("invalid_state", "wrong active-run document type");
	if (value.schema_version !== PRIVATE_STATE_VERSION)
		fail("wrong_version", "unsupported active-run schema version");
	safeInteger(value.revision, "active run revision");
	validateKey(value.repository_key, "active repository key");
	validateId(value.workspace_id, "active workspace id");
	validateKey(value.workspace_key, "active workspace key");
	validateId(value.run_id, "active run id");
	validateGeneration(value.generation, "active generation");
	timestamp(value.created_at, "active created_at");
	return normalized(value);
}

export function validateRunState(value) {
	exactKeys(
		value,
		[
			"document_type",
			"schema_version",
			"revision",
			"repository",
			"repository_root",
			"workspace_id",
			"workspace_key",
			"run_id",
			"generation",
			"fork_sha",
			"status",
			"journal_sequence",
			"journal_head",
			"created_at",
			"updated_at",
		],
		"run state",
	);
	if (value.document_type !== "herdr-conductor-run")
		fail("invalid_state", "wrong run document type");
	if (value.schema_version !== PRIVATE_STATE_VERSION)
		fail("wrong_version", "unsupported run schema version");
	safeInteger(value.revision, "run revision");
	validateRepositoryIdentity(value.repository);
	validateCanonicalPath(value.repository_root, "run repository_root");
	validateId(value.workspace_id, "run workspace_id");
	validateKey(value.workspace_key, "run workspace_key");
	validateId(value.run_id, "run id");
	validateGeneration(value.generation, "run generation");
	validateGitObjectId(value.fork_sha, "run fork_sha");
	enumValue(
		value.status,
		new Set(["initializing", "active", "needs_attention", "archived"]),
		"run status",
	);
	safeInteger(value.journal_sequence, "run journal_sequence");
	if (value.journal_sequence > 9_999_999_999)
		fail("invalid_state", "run journal_sequence exceeds its filename bound");
	if (value.journal_sequence === 0) {
		if (value.journal_head !== null)
			fail("invalid_state", "empty run journal has a head digest");
	} else {
		validateKey(value.journal_head, "run journal_head");
	}
	timestamp(value.created_at, "run created_at");
	timestamp(value.updated_at, "run updated_at");
	return normalized(value);
}

export function validateLockOwner(value) {
	exactKeys(
		value,
		[
			"document_type",
			"schema_version",
			"repository_key",
			"lock_id",
			"operation_id",
			"pid",
			"acquired_at",
		],
		"lock owner",
	);
	if (value.document_type !== "herdr-conductor-repository-lock")
		fail("invalid_state", "wrong lock document type");
	if (value.schema_version !== PRIVATE_STATE_VERSION)
		fail("wrong_version", "unsupported lock schema version");
	validateKey(value.repository_key, "lock repository key");
	validateGeneration(value.lock_id, "lock id");
	validateId(value.operation_id, "lock operation id");
	safeInteger(value.pid, "lock pid", 1);
	timestamp(value.acquired_at, "lock acquired_at");
	return normalized(value);
}

export function validateJournalEntry(value) {
	exactKeys(
		value,
		[
			"document_type",
			"schema_version",
			"repository_key",
			"workspace_id",
			"workspace_key",
			"run_id",
			"run_generation",
			"sequence",
			"operation_id",
			"operation_type",
			"subject",
			"request_digest",
			"previous_digest",
			"entry_digest",
			"phase",
			"result_digest",
			"observed_identity",
			"error_code",
			"created_at",
			"updated_at",
		],
		"journal entry",
	);
	if (value.document_type !== "herdr-conductor-operation")
		fail("invalid_state", "wrong journal document type");
	if (value.schema_version !== PRIVATE_STATE_VERSION)
		fail("wrong_version", "unsupported journal schema version");
	validateKey(value.repository_key, "journal repository key");
	validateId(value.workspace_id, "journal workspace id");
	validateKey(value.workspace_key, "journal workspace key");
	validateId(value.run_id, "journal run id");
	validateGeneration(value.run_generation, "journal run generation");
	safeInteger(value.sequence, "journal sequence", 1);
	if (value.sequence > 9_999_999_999)
		fail("invalid_state", "journal sequence exceeds its filename bound");
	validateId(value.operation_id, "journal operation id");
	enumValue(
		value.operation_type,
		new Set(OPERATION_TYPES),
		"journal operation type",
	);
	exactKeys(value.subject, ["kind", "id", "generation"], "journal subject");
	enumValue(
		value.subject.kind,
		new Set(RESOURCE_KINDS),
		"journal subject kind",
	);
	const policy = operationPolicy(value.operation_type);
	if (value.subject.kind !== policy.subjectKind)
		fail(
			"invalid_state",
			"journal subject kind is incompatible with operation",
		);
	validateId(value.subject.id, "journal subject id");
	validateGeneration(value.subject.generation, "journal subject generation");
	validateKey(value.request_digest, "journal request digest");
	if (value.sequence === 1) {
		if (value.previous_digest !== null)
			fail("invalid_state", "first journal entry has a previous digest");
	} else {
		validateKey(value.previous_digest, "journal previous digest");
	}
	validateKey(value.entry_digest, "journal entry digest");
	enumValue(
		value.phase,
		new Set(["intent", "observed", "needs_attention"]),
		"journal phase",
	);
	if (value.phase === "intent") {
		if (
			value.result_digest !== null ||
			value.observed_identity !== null ||
			value.error_code !== null
		) {
			fail("invalid_state", "intent journal has terminal fields");
		}
	} else if (value.phase === "observed") {
		validateKey(value.result_digest, "journal result digest");
		if (value.observed_identity !== null) {
			if (policy.observedIdentity === "worktree")
				validateWorktreeIdentity(
					value.observed_identity,
					"journal observed_identity",
				);
			else if (policy.observedIdentity === "pane-creation")
				validatePaneCreationIdentity(
					value.observed_identity,
					"journal observed_identity",
				);
			else if (policy.observedIdentity === "pane")
				validatePaneIdentity(
					value.observed_identity,
					"journal observed_identity",
				);
			else if (policy.observedIdentity === "merge")
				validateMergeIdentity(
					value.observed_identity,
					"journal observed_identity",
				);
			else fail("invalid_state", "operation does not permit observed identity");
		}
		if (value.error_code !== null)
			fail("invalid_state", "observed journal has an error code");
	} else {
		if (value.result_digest !== null || value.observed_identity !== null)
			fail("invalid_state", "needs-attention journal has observed fields");
		validateId(value.error_code, "journal error code");
	}
	timestamp(value.created_at, "journal created_at");
	timestamp(value.updated_at, "journal updated_at");
	return normalized(value);
}

function rejectLoneSurrogates(value) {
	for (let index = 0; index < value.length; index++) {
		const code = value.charCodeAt(index);
		if (code >= 0xd800 && code <= 0xdbff) {
			const next = value.charCodeAt(index + 1);
			if (!(next >= 0xdc00 && next <= 0xdfff))
				fail("invalid_json", "JSON string contains a lone surrogate");
			index++;
		} else if (code >= 0xdc00 && code <= 0xdfff) {
			fail("invalid_json", "JSON string contains a lone surrogate");
		}
	}
	return value;
}

class StrictJsonParser {
	constructor(text) {
		this.text = text;
		this.index = 0;
		this.depth = 0;
	}

	parse() {
		this.space();
		const value = this.value();
		this.space();
		if (this.index !== this.text.length)
			fail("invalid_json", "JSON has trailing content");
		return value;
	}

	space() {
		while (/[\t\n\r ]/.test(this.text[this.index] ?? "")) this.index++;
	}

	value() {
		if (++this.depth > 64)
			fail("invalid_json", "JSON nesting exceeds 64 levels");
		try {
			const char = this.text[this.index];
			if (char === "{") return this.object();
			if (char === "[") return this.array();
			if (char === '"') return this.string();
			if (char === "t" && this.consume("true")) return true;
			if (char === "f" && this.consume("false")) return false;
			if (char === "n" && this.consume("null")) return null;
			return this.number();
		} finally {
			this.depth--;
		}
	}

	consume(token) {
		if (!this.text.startsWith(token, this.index)) return false;
		this.index += token.length;
		return true;
	}

	object() {
		this.index++;
		this.space();
		const result = Object.create(null);
		const keys = new Set();
		if (this.text[this.index] === "}") {
			this.index++;
			return result;
		}
		for (;;) {
			if (this.text[this.index] !== '"')
				fail("invalid_json", "JSON object key must be a string");
			const key = this.string();
			if (keys.has(key))
				fail("duplicate_json_key", "JSON object contains a duplicate key");
			keys.add(key);
			this.space();
			if (this.text[this.index++] !== ":")
				fail("invalid_json", "JSON object is missing a colon");
			this.space();
			result[key] = this.value();
			this.space();
			const delimiter = this.text[this.index++];
			if (delimiter === "}") return result;
			if (delimiter !== ",")
				fail("invalid_json", "JSON object is missing a comma");
			this.space();
		}
	}

	array() {
		this.index++;
		this.space();
		const result = [];
		if (this.text[this.index] === "]") {
			this.index++;
			return result;
		}
		for (;;) {
			if (result.length >= 1024)
				fail("invalid_json", "JSON array exceeds 1024 items");
			result.push(this.value());
			this.space();
			const delimiter = this.text[this.index++];
			if (delimiter === "]") return result;
			if (delimiter !== ",")
				fail("invalid_json", "JSON array is missing a comma");
			this.space();
		}
	}

	string() {
		const start = this.index++;
		let escaped = false;
		for (; this.index < this.text.length; this.index++) {
			const char = this.text[this.index];
			if (!escaped && char === '"') {
				this.index++;
				try {
					return rejectLoneSurrogates(
						JSON.parse(this.text.slice(start, this.index)),
					);
				} catch (error) {
					if (error instanceof StateKernelError) throw error;
					fail("invalid_json", "JSON string is invalid");
				}
			}
			if (!escaped && char.charCodeAt(0) < 0x20)
				fail("invalid_json", "JSON string contains a control character");
			if (!escaped && char === "\\") escaped = true;
			else escaped = false;
		}
		fail("invalid_json", "JSON string is truncated");
	}

	number() {
		const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(
			this.text.slice(this.index),
		);
		if (!match) fail("invalid_json", "JSON value is invalid");
		this.index += match[0].length;
		const value = Number(match[0]);
		if (!Number.isFinite(value))
			fail("invalid_json", "JSON number is not finite");
		return value;
	}
}

export function parseStrictJsonBytes(
	bytes,
	{ maxBytes = MAX_STATE_BYTES } = {},
) {
	if (!(bytes instanceof Uint8Array))
		fail("invalid_json", "state input must be bytes");
	if (bytes.byteLength === 0 || bytes.byteLength > maxBytes)
		fail("invalid_json", "state file size is invalid");
	if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
		fail("invalid_json", "state file must not contain a BOM");
	}
	let text;
	try {
		text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch (error) {
		throw new StateKernelError(
			"invalid_json",
			"state file is not valid UTF-8",
			{ cause: error },
		);
	}
	if (text.charCodeAt(0) === 0xfeff)
		fail("invalid_json", "state file must not contain a BOM");
	return new StrictJsonParser(text).parse();
}

function sortValue(value) {
	if (Array.isArray(value)) return value.map(sortValue);
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.keys(value)
				.sort()
				.map((key) => [key, sortValue(value[key])]),
		);
	}
	return value;
}

export function canonicalJson(value) {
	return `${JSON.stringify(sortValue(value), null, 2)}\n`;
}

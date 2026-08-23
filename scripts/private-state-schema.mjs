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

function validateReportRejectionIdentity(value, label) {
	exactKeys(
		value,
		[
			"document_type",
			"schema_version",
			"repository_key",
			"workspace_id",
			"run_id",
			"run_generation",
			"role_name",
			"task_id",
			"task_generation",
			"task_digest",
			"report_generation",
			"raw_payload_sha256",
			"committed_marker_digest",
			"failure_class",
			"validation_input_digest",
			"source_observation",
		],
		label,
	);
	if (
		value.document_type !== "herdr-conductor-report-rejection" ||
		value.schema_version !== 1
	)
		fail("invalid_state", `${label} has the wrong document type or version`);
	validateKey(value.repository_key, `${label}.repository_key`);
	validateId(value.workspace_id, `${label}.workspace_id`);
	validateId(value.run_id, `${label}.run_id`);
	validateGeneration(value.run_generation, `${label}.run_generation`);
	stringMatching(
		value.role_name,
		/^[a-z][a-z0-9_-]{0,31}$/,
		`${label}.role_name`,
	);
	validateId(value.task_id, `${label}.task_id`);
	validateGeneration(value.task_generation, `${label}.task_generation`);
	validateKey(value.task_digest, `${label}.task_digest`);
	validateGeneration(value.report_generation, `${label}.report_generation`);
	validateKey(value.raw_payload_sha256, `${label}.raw_payload_sha256`);
	validateKey(
		value.committed_marker_digest,
		`${label}.committed_marker_digest`,
	);
	enumValue(
		value.failure_class,
		new Set([
			"report_mismatch",
			"source_identity",
			"source_dirty",
			"path_policy",
			"task_stale",
			"requirement_contract",
		]),
		`${label}.failure_class`,
	);
	validateKey(
		value.validation_input_digest,
		`${label}.validation_input_digest`,
	);
	if (value.source_observation !== null) {
		exactKeys(
			value.source_observation,
			[
				"canonical_path",
				"common_directory",
				"full_ref",
				"head_sha",
				"head_tree_sha",
				"index_tree_sha",
				"tracked_status_sha256",
				"untracked_inventory_sha256",
				"ignored_inventory_sha256",
				"computed_changed_paths_sha256",
				"observed_at",
			],
			`${label}.source_observation`,
		);
		const observed = value.source_observation;
		validateCanonicalPath(
			observed.canonical_path,
			`${label}.source_observation.canonical_path`,
		);
		validateCommonDirectory(
			observed.common_directory,
			`${label}.source_observation.common_directory`,
		);
		validateFullRef(observed.full_ref, `${label}.source_observation.full_ref`);
		validateGitObjectId(
			observed.head_sha,
			`${label}.source_observation.head_sha`,
		);
		validateGitObjectId(
			observed.head_tree_sha,
			`${label}.source_observation.head_tree_sha`,
		);
		if (observed.index_tree_sha !== null)
			validateGitObjectId(
				observed.index_tree_sha,
				`${label}.source_observation.index_tree_sha`,
			);
		for (const field of [
			"tracked_status_sha256",
			"untracked_inventory_sha256",
			"ignored_inventory_sha256",
			"computed_changed_paths_sha256",
		])
			validateKey(observed[field], `${label}.source_observation.${field}`);
		timestamp(observed.observed_at, `${label}.source_observation.observed_at`);
	}
	return value;
}

function validateGateSourceIdentity(value, label) {
	exactKeys(
		value,
		[
			"document_type",
			"schema_version",
			"root",
			"common_dir",
			"head_mode",
			"base_sha",
			"integration_sha",
			"tree_sha",
			"snapshot_generation",
			"integration_entry_digest",
			"registered",
		],
		label,
	);
	if (
		value.document_type !== "herdr-conductor-gate-source" ||
		value.schema_version !== 1
	)
		fail("invalid_state", `${label} has the wrong document type or version`);
	validateCanonicalPath(value.root, `${label}.root`);
	validateCommonDirectory(value.common_dir, `${label}.common_dir`);
	if (value.head_mode !== "detached")
		fail("invalid_state", `${label}.head_mode is invalid`);
	for (const field of ["base_sha", "integration_sha", "tree_sha"])
		validateGitObjectId(value[field], `${label}.${field}`);
	validateGeneration(value.snapshot_generation, `${label}.snapshot_generation`);
	validateKey(
		value.integration_entry_digest,
		`${label}.integration_entry_digest`,
	);
	if (value.registered !== true)
		fail("invalid_state", `${label}.registered is invalid`);
	return value;
}

function validateStage2IntegrationIdentity(value, label) {
	exactKeys(
		value,
		[
			"document_type",
			"schema_version",
			"target_ref",
			"starting_sha",
			"final_sha",
			"selection",
			"cas_count",
		],
		label,
	);
	if (
		value.document_type !== "herdr-conductor-stage2-integration" ||
		value.schema_version !== 1
	)
		fail("invalid_state", `${label} has the wrong document type or version`);
	validateFullRef(value.target_ref, `${label}.target_ref`);
	validateGitObjectId(value.starting_sha, `${label}.starting_sha`);
	validateGitObjectId(value.final_sha, `${label}.final_sha`);
	if (!Array.isArray(value.selection) || value.selection.length > 64)
		fail("invalid_state", `${label}.selection is invalid`);
	for (const [index, entry] of value.selection.entries()) {
		exactKeys(
			entry,
			[
				"role_name",
				"task_digest",
				"report_digest",
				"source_sha",
				"tree_sha",
				"source_generation",
			],
			`${label}.selection[${index}]`,
		);
		stringMatching(
			entry.role_name,
			/^[a-z][a-z0-9_-]{0,31}$/,
			`${label}.selection[${index}].role_name`,
		);
		validateKey(entry.task_digest, `${label}.selection[${index}].task_digest`);
		validateKey(
			entry.report_digest,
			`${label}.selection[${index}].report_digest`,
		);
		validateGitObjectId(
			entry.source_sha,
			`${label}.selection[${index}].source_sha`,
		);
		validateGitObjectId(
			entry.tree_sha,
			`${label}.selection[${index}].tree_sha`,
		);
		validateGeneration(
			entry.source_generation,
			`${label}.selection[${index}].source_generation`,
		);
	}
	if (value.cas_count !== (value.selection.length === 0 ? 0 : 1))
		fail("invalid_state", `${label}.cas_count is invalid`);
	return value;
}

function validateStandDownIdentity(value, label) {
	exactKeys(
		value,
		[
			"document_type",
			"schema_version",
			"source_state",
			"source_journal_head",
			"reason",
			"outcome",
			"close_set",
			"archive_operation_id",
		],
		label,
	);
	if (
		value.document_type !== "herdr-conductor-stage2-stand-down" ||
		value.schema_version !== 1
	)
		fail("invalid_state", `${label} has the wrong document type or version`);
	validateId(value.source_state, `${label}.source_state`);
	validateKey(value.source_journal_head, `${label}.source_journal_head`);
	enumValue(
		value.reason,
		new Set([
			"operator_abandoned",
			"nonprogressable_delivery",
			"source_policy_refusal",
			"clean_provisioning_failure",
			"missing_report",
			"normal_completion",
			"report_rejected",
		]),
		`${label}.reason`,
	);
	enumValue(
		value.outcome,
		new Set(["abandoned", "completed"]),
		`${label}.outcome`,
	);
	if (!Array.isArray(value.close_set) || value.close_set.length > 64)
		fail("invalid_state", `${label}.close_set is invalid`);
	const operationIds = new Set();
	for (const [index, entry] of value.close_set.entries()) {
		exactKeys(
			entry,
			[
				"role_name",
				"pane_generation",
				"pane_entry_digest",
				"pane_id",
				"terminal_id",
				"cwd",
				"close_operation_id",
			],
			`${label}.close_set[${index}]`,
		);
		validateId(entry.role_name, `${label}.close_set[${index}].role_name`);
		validateGeneration(
			entry.pane_generation,
			`${label}.close_set[${index}].pane_generation`,
		);
		validateKey(
			entry.pane_entry_digest,
			`${label}.close_set[${index}].pane_entry_digest`,
		);
		validateId(entry.pane_id, `${label}.close_set[${index}].pane_id`);
		validateId(entry.terminal_id, `${label}.close_set[${index}].terminal_id`);
		validateCanonicalPath(entry.cwd, `${label}.close_set[${index}].cwd`);
		validateId(
			entry.close_operation_id,
			`${label}.close_set[${index}].close_operation_id`,
		);
		if (operationIds.has(entry.close_operation_id))
			fail("invalid_state", `${label}.close_set is duplicated`);
		operationIds.add(entry.close_operation_id);
	}
	validateId(value.archive_operation_id, `${label}.archive_operation_id`);
	return value;
}

function validateMergeIdentity(value, label) {
	exactKeys(value, ["source_head_sha", "target"], label);
	validateGitObjectId(value.source_head_sha, `${label}.source_head_sha`);
	validateWorktreeIdentity(value.target, `${label}.target`);
	return value;
}

export const STAGE3_APPROVAL_STATEMENTS = Object.freeze({
	approve: "I_ATTENDED_THIS_EXACT_PREVIEW_AND_APPROVE",
	reject: "I_ATTENDED_THIS_EXACT_PREVIEW_AND_REJECT",
});

function validateStage3RunScope(value, label) {
	validateKey(value.repository_key, `${label}.repository_key`);
	validateId(value.workspace_id, `${label}.workspace_id`);
	validateId(value.run_id, `${label}.run_id`);
	validateGeneration(value.run_generation, `${label}.run_generation`);
	validateGeneration(value.attempt_generation, `${label}.attempt_generation`);
}

export function validateStage3PreviewIdentity(value, label) {
	exactKeys(
		value,
		[
			"document_type",
			"schema_version",
			"repository_key",
			"workspace_id",
			"run_id",
			"run_generation",
			"attempt_generation",
			"integration",
			"gates",
			"apply",
		],
		label,
	);
	if (
		value.document_type !== "herdr-conductor-stage3-preview" ||
		value.schema_version !== 1
	)
		fail("invalid_state", `${label} has the wrong document type or version`);
	validateStage3RunScope(value, label);
	exactKeys(
		value.integration,
		["target_ref", "starting_sha", "final_sha", "integration_entry_digest"],
		`${label}.integration`,
	);
	validateFullRef(value.integration.target_ref, `${label}.integration.target_ref`);
	validateGitObjectId(
		value.integration.starting_sha,
		`${label}.integration.starting_sha`,
	);
	validateGitObjectId(
		value.integration.final_sha,
		`${label}.integration.final_sha`,
	);
	validateKey(
		value.integration.integration_entry_digest,
		`${label}.integration.integration_entry_digest`,
	);
	if (!Array.isArray(value.gates) || value.gates.length > 64)
		fail("invalid_state", `${label}.gates is invalid`);
	for (const [index, gate] of value.gates.entries()) {
		const gateLabel = `${label}.gates[${index}]`;
		exactKeys(
			gate,
			[
				"role_name",
				"contract_role",
				"task_digest",
				"report_digest",
				"status",
				"result_kind",
				"verdict",
			],
			gateLabel,
		);
		stringMatching(
			gate.role_name,
			/^[a-z][a-z0-9_-]{0,31}$/,
			`${gateLabel}.role_name`,
		);
		enumValue(
			gate.contract_role,
			new Set(["reviewer", "validator"]),
			`${gateLabel}.contract_role`,
		);
		validateKey(gate.task_digest, `${gateLabel}.task_digest`);
		validateKey(gate.report_digest, `${gateLabel}.report_digest`);
		enumValue(gate.status, new Set(["completed"]), `${gateLabel}.status`);
		const expectedKind =
			gate.contract_role === "reviewer" ? "review" : "validation";
		if (gate.result_kind !== expectedKind)
			fail("invalid_state", `${gateLabel}.result_kind is invalid`);
		enumValue(
			gate.verdict,
			gate.contract_role === "reviewer"
				? new Set(["approve", "request_changes"])
				: new Set(["pass", "fail"]),
			`${gateLabel}.verdict`,
		);
		if (
			index > 0 &&
			Buffer.compare(
				Buffer.from(value.gates[index - 1].role_name),
				Buffer.from(gate.role_name),
			) >= 0
		)
			fail("invalid_state", `${label}.gates is not byte-ordered and unique`);
	}
	exactKeys(
		value.apply,
		[
			"target_ref",
			"observed_sha",
			"final_sha",
			"diff_name_status_sha256",
			"changed_path_count",
		],
		`${label}.apply`,
	);
	validateFullRef(value.apply.target_ref, `${label}.apply.target_ref`);
	validateGitObjectId(value.apply.observed_sha, `${label}.apply.observed_sha`);
	validateGitObjectId(value.apply.final_sha, `${label}.apply.final_sha`);
	validateKey(
		value.apply.diff_name_status_sha256,
		`${label}.apply.diff_name_status_sha256`,
	);
	safeInteger(value.apply.changed_path_count, `${label}.apply.changed_path_count`, 1);
	if (
		value.apply.target_ref === value.integration.target_ref ||
		value.apply.observed_sha !== value.integration.starting_sha ||
		value.apply.final_sha !== value.integration.final_sha ||
		value.apply.observed_sha === value.apply.final_sha
	)
		fail("invalid_state", `${label}.apply does not bind its integration`);
	return value;
}

export function validateStage3ApprovalIdentity(value, label) {
	exactKeys(
		value,
		[
			"document_type",
			"schema_version",
			"repository_key",
			"workspace_id",
			"run_id",
			"run_generation",
			"attempt_generation",
			"preview_entry_digest",
			"decision",
			"statement",
		],
		label,
	);
	if (
		value.document_type !== "herdr-conductor-stage3-approval" ||
		value.schema_version !== 1
	)
		fail("invalid_state", `${label} has the wrong document type or version`);
	validateStage3RunScope(value, label);
	validateKey(value.preview_entry_digest, `${label}.preview_entry_digest`);
	enumValue(
		value.decision,
		new Set(["approve", "reject"]),
		`${label}.decision`,
	);
	if (value.statement !== STAGE3_APPROVAL_STATEMENTS[value.decision])
		fail("invalid_state", `${label}.statement is invalid`);
	return value;
}

export function validateStage3ConsumptionIdentity(value, label) {
	exactKeys(
		value,
		[
			"document_type",
			"schema_version",
			"repository_key",
			"workspace_id",
			"run_id",
			"run_generation",
			"attempt_generation",
			"approval_entry_digest",
			"preview_entry_digest",
		],
		label,
	);
	if (
		value.document_type !== "herdr-conductor-stage3-consumption" ||
		value.schema_version !== 1
	)
		fail("invalid_state", `${label} has the wrong document type or version`);
	validateStage3RunScope(value, label);
	validateKey(value.approval_entry_digest, `${label}.approval_entry_digest`);
	validateKey(value.preview_entry_digest, `${label}.preview_entry_digest`);
	return value;
}

export function validateStage3ApplyIdentity(value, label) {
	exactKeys(
		value,
		[
			"document_type",
			"schema_version",
			"repository_key",
			"workspace_id",
			"run_id",
			"run_generation",
			"attempt_generation",
			"consumption_entry_digest",
			"target_ref",
			"expected_sha",
			"final_sha",
			"cas_count",
			"outcome",
		],
		label,
	);
	if (
		value.document_type !== "herdr-conductor-stage3-apply" ||
		value.schema_version !== 1
	)
		fail("invalid_state", `${label} has the wrong document type or version`);
	validateStage3RunScope(value, label);
	validateKey(
		value.consumption_entry_digest,
		`${label}.consumption_entry_digest`,
	);
	validateFullRef(value.target_ref, `${label}.target_ref`);
	validateGitObjectId(value.expected_sha, `${label}.expected_sha`);
	validateGitObjectId(value.final_sha, `${label}.final_sha`);
	enumValue(
		value.outcome,
		new Set(["applied", "unapplied"]),
		`${label}.outcome`,
	);
	if (
		value.expected_sha === value.final_sha ||
		value.cas_count !== (value.outcome === "applied" ? 1 : 0)
	)
		fail("invalid_state", `${label} outcome does not bind its effect`);
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
			else if (policy.observedIdentity === "report-rejection")
				validateReportRejectionIdentity(
					value.observed_identity,
					"journal observed_identity",
				);
			else if (policy.observedIdentity === "stage2-integration")
				validateStage2IntegrationIdentity(
					value.observed_identity,
					"journal observed_identity",
				);
			else if (policy.observedIdentity === "gate-source")
				validateGateSourceIdentity(
					value.observed_identity,
					"journal observed_identity",
				);
			else if (policy.observedIdentity === "stand-down")
				validateStandDownIdentity(
					value.observed_identity,
					"journal observed_identity",
				);
			else if (policy.observedIdentity === "stage3-preview")
				validateStage3PreviewIdentity(
					value.observed_identity,
					"journal observed_identity",
				);
			else if (policy.observedIdentity === "stage3-approval")
				validateStage3ApprovalIdentity(
					value.observed_identity,
					"journal observed_identity",
				);
			else if (policy.observedIdentity === "stage3-consumption")
				validateStage3ConsumptionIdentity(
					value.observed_identity,
					"journal observed_identity",
				);
			else if (policy.observedIdentity === "stage3-apply")
				validateStage3ApplyIdentity(
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

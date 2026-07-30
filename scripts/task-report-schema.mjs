#!/usr/bin/env node
import { createHash } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import {
	StateKernelError,
	canonicalJson,
	parseStrictJsonBytes,
} from "./private-state-schema.mjs";

export const STAGE2_CONFIG_VERSION = 2;
export const TASK_MAX_BYTES = 262_144;
export const REPORT_MAX_BYTES = 1_048_576;
export const PUBLICATION_METADATA_MAX_BYTES = 16_384;
export const EXTERNAL_REVIEW_MAX_BYTES = 1_048_576;

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ROLE_NAME = /^[a-z][a-z0-9_-]{0,31}$/;
const GENERATION = /^[a-f0-9]{32}$/;
const SHA = /^[a-f0-9]{40}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const DECIMAL = /^(?:0|[1-9][0-9]{0,39})$/;
const FULL_REF = /^refs\/[\x21-\x7e]{1,507}$/;
const RFC3339_MILLIS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const PERCENT_DANGEROUS = /%(?:2e|2f|5c)/i;
const CONTRACT_ROLES = new Set([
	"builder",
	"test_author",
	"reviewer",
	"validator",
]);
const MODES = new Set(["write", "gated", "read-only"]);

function fail(code, message) {
	throw new StateKernelError(code, message);
}

function invalid(label) {
	fail("invalid_contract", `${label} is invalid`);
}

function plain(value, label) {
	if (value === null || typeof value !== "object" || Array.isArray(value))
		invalid(label);
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) invalid(label);
	return value;
}

function exact(value, keys, label) {
	plain(value, label);
	const actual = Object.keys(value).sort();
	const expected = [...keys].sort();
	if (
		actual.length !== expected.length ||
		actual.some((key, index) => key !== expected[index])
	)
		invalid(label);
	return value;
}

function matching(value, expression, label) {
	if (typeof value !== "string" || !expression.test(value)) invalid(label);
	return value;
}

function enumeration(value, allowed, label) {
	if (!allowed.has(value)) invalid(label);
	return value;
}

function integer(value, label, minimum = 0) {
	if (!Number.isSafeInteger(value) || value < minimum) invalid(label);
	return value;
}

function timestamp(value, label) {
	matching(value, RFC3339_MILLIS, label);
	if (new Date(value).toISOString() !== value) invalid(label);
	return value;
}

function text(value, label, { nonempty = false } = {}) {
	if (
		typeof value !== "string" ||
		value.includes("\0") ||
		Buffer.byteLength(value, "utf8") > 65_536 ||
		(nonempty && value.length === 0)
	)
		invalid(label);
	return value;
}

function canonicalPath(value, label) {
	if (
		typeof value !== "string" ||
		Buffer.byteLength(value, "utf8") > 4096 ||
		!isAbsolute(value) ||
		resolve(value) !== value ||
		/[\0-\x1f\x7f]/.test(value)
	)
		invalid(label);
	return value;
}

export function validateRelativePath(value, label = "relative path") {
	if (
		typeof value !== "string" ||
		Buffer.byteLength(value, "ascii") !== Buffer.byteLength(value, "utf8") ||
		value.length < 1 ||
		value.length > 512 ||
		value.includes("\\") ||
		value.startsWith("/") ||
		/^[A-Za-z]:/.test(value) ||
		value.startsWith("//") ||
		/[\0-\x20\x7f]/.test(value) ||
		PERCENT_DANGEROUS.test(value)
	)
		invalid(label);
	const segments = value.split("/");
	if (
		segments.some(
			(segment) =>
				segment.length < 1 ||
				segment.length > 128 ||
				segment === "." ||
				segment === ".." ||
				segment === ".git",
		)
	)
		invalid(label);
	return value;
}

function clone(value) {
	const result = structuredClone(value);
	(function freeze(node) {
		if (!node || typeof node !== "object" || Object.isFrozen(node)) return;
		Object.freeze(node);
		for (const child of Object.values(node)) freeze(child);
	})(result);
	return result;
}

function digest(domain, value) {
	return createHash("sha256")
		.update(domain)
		.update(canonicalJson(value), "utf8")
		.digest("hex");
}

function without(value, field) {
	const copy = structuredClone(value);
	delete copy[field];
	return copy;
}

function serializedBound(value, maxBytes, label) {
	if (Buffer.byteLength(canonicalJson(value), "utf8") > maxBytes)
		invalid(label);
}

function commonDirectory(value, label) {
	exact(value, ["path", "device", "inode"], label);
	canonicalPath(value.path, `${label}.path`);
	matching(value.device, DECIMAL, `${label}.device`);
	matching(value.inode, DECIMAL, `${label}.inode`);
}

function repositoryIdentity(value, label) {
	exact(value, ["key", "common_dir"], label);
	matching(value.key, DIGEST, `${label}.key`);
	commonDirectory(value.common_dir, `${label}.common_dir`);
}

function scope(value, label = "scope") {
	exact(
		value,
		[
			"repository",
			"repository_root",
			"workspace_id",
			"workspace_key",
			"run_id",
			"run_generation",
		],
		label,
	);
	repositoryIdentity(value.repository, `${label}.repository`);
	canonicalPath(value.repository_root, `${label}.repository_root`);
	matching(value.workspace_id, ID, `${label}.workspace_id`);
	matching(value.workspace_key, DIGEST, `${label}.workspace_key`);
	matching(value.run_id, ID, `${label}.run_id`);
	matching(value.run_generation, GENERATION, `${label}.run_generation`);
}

function role(value, label = "role") {
	exact(
		value,
		[
			"name",
			"contract_role",
			"agent_kind",
			"configured_mode",
			"source_generation",
			"pane_generation",
			"agent_generation",
			"pane_operation_id",
			"agent_operation_id",
			"agent_request_digest",
			"agent_name",
		],
		label,
	);
	matching(value.name, ROLE_NAME, `${label}.name`);
	enumeration(value.contract_role, CONTRACT_ROLES, `${label}.contract_role`);
	matching(value.agent_kind, ID, `${label}.agent_kind`);
	enumeration(value.configured_mode, MODES, `${label}.configured_mode`);
	for (const field of [
		"source_generation",
		"pane_generation",
		"agent_generation",
	])
		matching(value[field], GENERATION, `${label}.${field}`);
	if (
		new Set([
			value.source_generation,
			value.pane_generation,
			value.agent_generation,
		]).size !== 3
	)
		invalid(`${label} generations`);
	matching(value.pane_operation_id, ID, `${label}.pane_operation_id`);
	matching(value.agent_operation_id, ID, `${label}.agent_operation_id`);
	matching(value.agent_request_digest, DIGEST, `${label}.agent_request_digest`);
	matching(value.agent_name, ID, `${label}.agent_name`);
}

function gitSource(value, label = "source") {
	plain(value, label);
	if (value.kind === "role_worktree") {
		exact(
			value,
			[
				"kind",
				"root",
				"common_dir",
				"branch_ref",
				"fork_sha",
				"expected_sha",
				"tree_sha",
				"worktree_generation",
				"worktree_entry_digest",
				"registered",
			],
			label,
		);
		canonicalPath(value.root, `${label}.root`);
		commonDirectory(value.common_dir, `${label}.common_dir`);
		matching(value.branch_ref, FULL_REF, `${label}.branch_ref`);
		if (
			value.branch_ref.includes("\\") ||
			value.branch_ref
				.split("/")
				.some((part) => !part || part === "." || part === "..")
		)
			invalid(`${label}.branch_ref`);
		for (const field of ["fork_sha", "expected_sha", "tree_sha"])
			matching(value[field], SHA, `${label}.${field}`);
		matching(
			value.worktree_generation,
			GENERATION,
			`${label}.worktree_generation`,
		);
		matching(
			value.worktree_entry_digest,
			DIGEST,
			`${label}.worktree_entry_digest`,
		);
	} else if (value.kind === "integration_snapshot") {
		exact(
			value,
			[
				"kind",
				"root",
				"common_dir",
				"head_mode",
				"base_sha",
				"integration_sha",
				"tree_sha",
				"snapshot_generation",
				"snapshot_entry_digest",
				"integration_entry_digest",
				"registered",
			],
			label,
		);
		canonicalPath(value.root, `${label}.root`);
		commonDirectory(value.common_dir, `${label}.common_dir`);
		if (value.head_mode !== "detached") invalid(`${label}.head_mode`);
		for (const field of ["base_sha", "integration_sha", "tree_sha"])
			matching(value[field], SHA, `${label}.${field}`);
		matching(
			value.snapshot_generation,
			GENERATION,
			`${label}.snapshot_generation`,
		);
		matching(
			value.snapshot_entry_digest,
			DIGEST,
			`${label}.snapshot_entry_digest`,
		);
		matching(
			value.integration_entry_digest,
			DIGEST,
			`${label}.integration_entry_digest`,
		);
	} else invalid(`${label}.kind`);
	if (value.registered !== true) invalid(`${label}.registered`);
}

function legalRoleSource(roleValue, sourceValue, label) {
	const key = `${roleValue.contract_role}:${roleValue.configured_mode}:${sourceValue.kind}`;
	if (
		!new Set([
			"builder:write:role_worktree",
			"test_author:write:role_worktree",
			"test_author:gated:role_worktree",
			"reviewer:read-only:integration_snapshot",
			"validator:gated:integration_snapshot",
		]).has(key)
	)
		invalid(label);
	const generation =
		sourceValue.kind === "role_worktree"
			? sourceValue.worktree_generation
			: sourceValue.snapshot_generation;
	if (generation !== roleValue.source_generation)
		invalid(`${label} generation`);
}

function sortedUniqueStrings(values, validate, label, maximum) {
	if (!Array.isArray(values) || values.length > maximum) invalid(label);
	values.forEach((value, index) => validate(value, `${label}[${index}]`));
	if (new Set(values).size !== values.length) invalid(label);
	for (let index = 1; index < values.length; index++) {
		if (
			Buffer.compare(
				Buffer.from(values[index - 1]),
				Buffer.from(values[index]),
			) >= 0
		)
			invalid(label);
	}
}

function idsUnique(values, label, maximum) {
	if (!Array.isArray(values) || values.length > maximum) invalid(label);
	const ids = new Set();
	for (const [index, value] of values.entries()) {
		if (ids.has(value.id)) invalid(label);
		ids.add(value.id);
		matching(value.id, ID, `${label}[${index}].id`);
	}
}

function assignment(value, label = "assignment") {
	exact(
		value,
		[
			"title",
			"mission",
			"acceptance_criteria",
			"owned_paths",
			"forbidden_paths",
			"required_commands",
		],
		label,
	);
	text(value.title, `${label}.title`);
	text(value.mission, `${label}.mission`);
	idsUnique(value.acceptance_criteria, `${label}.acceptance_criteria`, 64);
	for (const [index, criterion] of value.acceptance_criteria.entries()) {
		exact(criterion, ["id", "text"], `${label}.acceptance_criteria[${index}]`);
		text(criterion.text, `${label}.acceptance_criteria[${index}].text`);
	}
	idsUnique(value.required_commands, `${label}.required_commands`, 64);
	for (const [index, command] of value.required_commands.entries()) {
		exact(command, ["id", "command"], `${label}.required_commands[${index}]`);
		text(command.command, `${label}.required_commands[${index}].command`);
	}
	sortedUniqueStrings(
		value.owned_paths,
		validateRelativePath,
		`${label}.owned_paths`,
		64,
	);
	sortedUniqueStrings(
		value.forbidden_paths,
		validateRelativePath,
		`${label}.forbidden_paths`,
		64,
	);
	const contains = (left, right) =>
		right === left || right.startsWith(`${left}/`);
	for (const list of [value.owned_paths, value.forbidden_paths]) {
		for (let left = 0; left < list.length; left++)
			for (let right = left + 1; right < list.length; right++)
				if (
					contains(list[left], list[right]) ||
					contains(list[right], list[left])
				)
					invalid(`${label} path prefixes`);
	}
	for (const owned of value.owned_paths)
		for (const forbidden of value.forbidden_paths)
			if (contains(owned, forbidden) || contains(forbidden, owned))
				invalid(`${label} path overlap`);
}

function stateRootSelector(value) {
	exact(
		value,
		value?.kind === "absolute" ? ["kind", "path"] : ["kind"],
		"configuration.state_root",
	);
	if (value.kind === "default") return;
	if (value.kind !== "absolute") invalid("configuration.state_root.kind");
	canonicalPath(value.path, "configuration.state_root.path");
}

function configRole(value, index) {
	const label = `configuration.roles[${index}]`;
	exact(
		value,
		[
			"name",
			"contract_role",
			"kind",
			"mode",
			"assignment",
			"validator_artifacts",
		],
		label,
	);
	matching(value.name, ROLE_NAME, `${label}.name`);
	enumeration(value.contract_role, CONTRACT_ROLES, `${label}.contract_role`);
	matching(value.kind, ID, `${label}.kind`);
	enumeration(value.mode, MODES, `${label}.mode`);
	assignment(value.assignment, `${label}.assignment`);
	if (
		!Array.isArray(value.validator_artifacts) ||
		value.validator_artifacts.length !== 0
	)
		invalid(`${label}.validator_artifacts`);
	const producer =
		value.contract_role === "builder" || value.contract_role === "test_author";
	const legal = producer
		? value.contract_role === "builder"
			? value.mode === "write"
			: value.mode === "write" || value.mode === "gated"
		: value.contract_role === "reviewer"
			? value.mode === "read-only"
			: value.mode === "gated";
	if (!legal) invalid(label);
}

export function parseStage2ConfigBytes(bytes) {
	let value;
	try {
		value = parseStrictJsonBytes(bytes, { maxBytes: TASK_MAX_BYTES });
	} catch (error) {
		if (
			error instanceof StateKernelError &&
			error.code === "duplicate_json_key"
		)
			throw error;
		throw error;
	}
	plain(value, "configuration");
	if (value.version !== STAGE2_CONFIG_VERSION)
		fail("wrong_version", "configuration version must be 2");
	exact(
		value,
		["version", "state_root", "worktree_root", "roles"],
		"configuration",
	);
	stateRootSelector(value.state_root);
	validateRelativePath(value.worktree_root, "configuration.worktree_root");
	if (!Array.isArray(value.roles) || value.roles.length > 64)
		invalid("configuration.roles");
	value.roles.forEach(configRole);
	if (new Set(value.roles.map(({ name }) => name)).size !== value.roles.length)
		invalid("configuration role names");
	if (
		value.roles.filter(
			({ contract_role }) =>
				contract_role === "builder" || contract_role === "test_author",
		).length > 64 ||
		value.roles.filter(
			({ contract_role }) =>
				contract_role === "reviewer" || contract_role === "validator",
		).length > 64
	)
		invalid("configuration role cardinality");
	return clone(value);
}

export function taskDigest(task) {
	return digest(
		"herdr-conductor-task-digest-v1\0",
		without(task, "task_digest"),
	);
}

function validateTaskCore(value) {
	exact(
		value,
		[
			"document_type",
			"schema_version",
			"task_id",
			"task_generation",
			"task_digest",
			"scope",
			"role",
			"source",
			"outbox",
			"assignment",
			"validator_artifacts",
			"created_at",
		],
		"task",
	);
	if (
		value.document_type !== "herdr-conductor-task" ||
		value.schema_version !== 1
	)
		invalid("task document");
	matching(value.task_id, ID, "task.task_id");
	matching(value.task_generation, GENERATION, "task.task_generation");
	matching(value.task_digest, DIGEST, "task.task_digest");
	scope(value.scope, "task.scope");
	role(value.role, "task.role");
	gitSource(value.source, "task.source");
	legalRoleSource(value.role, value.source, "task role/source");
	exact(
		value.outbox,
		[
			"outbox_id",
			"outbox_generation",
			"root",
			"slot_name",
			"payload_filename",
			"commit_filename",
		],
		"task.outbox",
	);
	matching(value.outbox.outbox_id, ID, "task.outbox.outbox_id");
	matching(
		value.outbox.outbox_generation,
		GENERATION,
		"task.outbox.outbox_generation",
	);
	canonicalPath(value.outbox.root, "task.outbox.root");
	if (
		value.outbox.slot_name !==
			`report-${value.task_id}-${value.task_generation}-${value.outbox.outbox_generation}` ||
		value.outbox.payload_filename !== "report.json" ||
		value.outbox.commit_filename !== "COMMITTED.json"
	)
		invalid("task.outbox");
	assignment(value.assignment, "task.assignment");
	if (
		!Array.isArray(value.validator_artifacts) ||
		value.validator_artifacts.length !== 0
	)
		invalid("task.validator_artifacts");
	timestamp(value.created_at, "task.created_at");
	serializedBound(value, TASK_MAX_BYTES, "task size");
}

export function validateTask(value) {
	validateTaskCore(value);
	if (value.task_digest !== taskDigest(value))
		fail("digest_mismatch", "task digest does not match canonical task");
	return clone(value);
}

function taskReference(value, label) {
	exact(value, ["id", "generation", "digest"], label);
	matching(value.id, ID, `${label}.id`);
	matching(value.generation, GENERATION, `${label}.generation`);
	matching(value.digest, DIGEST, `${label}.digest`);
}

function agentObservation(value, label) {
	exact(
		value,
		[
			"operation_id",
			"entry_digest",
			"agent_generation",
			"pane_generation",
			"agent_name",
		],
		label,
	);
	matching(value.operation_id, ID, `${label}.operation_id`);
	matching(value.entry_digest, DIGEST, `${label}.entry_digest`);
	matching(value.agent_generation, GENERATION, `${label}.agent_generation`);
	matching(value.pane_generation, GENERATION, `${label}.pane_generation`);
	matching(value.agent_name, ID, `${label}.agent_name`);
}

function finding(value, label, { workerInput = true } = {}) {
	exact(
		value,
		["id", "severity", "path", "line", "message", "evidence_kind"],
		label,
	);
	matching(value.id, ID, `${label}.id`);
	enumeration(
		value.severity,
		new Set(["blocker", "high", "medium", "low", "info"]),
		`${label}.severity`,
	);
	if (value.path !== null) validateRelativePath(value.path, `${label}.path`);
	if (value.line !== null) integer(value.line, `${label}.line`, 1);
	if (value.line !== null && value.path === null) invalid(label);
	text(value.message, `${label}.message`);
	enumeration(
		value.evidence_kind,
		new Set(
			workerInput
				? ["worker_assertion"]
				: ["worker_assertion", "conductor_observation"],
		),
		`${label}.evidence_kind`,
	);
}

function requirementResult(value, label) {
	exact(
		value,
		[
			"requirement_kind",
			"requirement_id",
			"assertion",
			"evidence_kind",
			"command",
			"exit_code",
			"output_sha256",
			"note",
		],
		label,
	);
	enumeration(
		value.requirement_kind,
		new Set(["command", "criterion"]),
		`${label}.requirement_kind`,
	);
	matching(value.requirement_id, ID, `${label}.requirement_id`);
	enumeration(
		value.assertion,
		new Set(["passed", "failed", "not_run", "not_applicable"]),
		`${label}.assertion`,
	);
	if (value.evidence_kind !== "worker_assertion")
		invalid(`${label}.evidence_kind`);
	if (value.command !== null) text(value.command, `${label}.command`);
	if (value.exit_code !== null && !Number.isSafeInteger(value.exit_code))
		invalid(`${label}.exit_code`);
	if (value.output_sha256 !== null)
		matching(value.output_sha256, DIGEST, `${label}.output_sha256`);
	text(value.note, `${label}.note`);
	if (
		value.assertion === "not_run" &&
		(value.exit_code !== null || value.output_sha256 !== null)
	)
		invalid(label);
	if (
		value.requirement_kind === "command" &&
		(value.command === null || value.assertion === "not_applicable")
	)
		invalid(label);
	if (
		value.requirement_kind === "criterion" &&
		(value.command !== null ||
			value.exit_code !== null ||
			value.output_sha256 !== null)
	)
		invalid(label);
}

function roleResult(value, contractRole, label) {
	if (value === null) invalid(label);
	exact(value, ["kind", "verdict"], label);
	const expectedKind =
		contractRole === "builder" || contractRole === "test_author"
			? "delivery"
			: contractRole === "reviewer"
				? "review"
				: "validation";
	if (value.kind !== expectedKind) invalid(label);
	const verdicts =
		expectedKind === "delivery"
			? ["delivered"]
			: expectedKind === "review"
				? ["approve", "request_changes"]
				: ["pass", "fail"];
	enumeration(value.verdict, new Set(verdicts), `${label}.verdict`);
}

function reportCore(value, { task, draft = false, workerInput = true } = {}) {
	const fields = [
		"document_type",
		"schema_version",
		"report_id",
		"report_generation",
		"task",
		"scope",
		"role",
		"agent_observation",
		"source",
		"status",
		"result",
		"summary",
		"findings",
		"requirement_results",
		"changed_paths",
		"artifacts",
		"completed_at",
	];
	if (!draft) fields.splice(4, 0, "report_digest");
	exact(value, fields, draft ? "report draft" : "report");
	if (
		value.document_type !== "herdr-conductor-report" ||
		value.schema_version !== 1
	)
		invalid("report document");
	matching(value.report_id, ID, "report.report_id");
	matching(value.report_generation, GENERATION, "report.report_generation");
	if (!draft) matching(value.report_digest, DIGEST, "report.report_digest");
	taskReference(value.task, "report.task");
	scope(value.scope, "report.scope");
	role(value.role, "report.role");
	agentObservation(value.agent_observation, "report.agent_observation");
	gitSource(value.source, "report.source");
	legalRoleSource(value.role, value.source, "report role/source");
	enumeration(
		value.status,
		new Set(["completed", "blocked", "failed"]),
		"report.status",
	);
	text(value.summary, "report.summary");
	if (!Array.isArray(value.findings) || value.findings.length > 256)
		invalid("report.findings");
	value.findings.forEach((entry, index) =>
		finding(entry, `report.findings[${index}]`, { workerInput }),
	);
	if (
		new Set(value.findings.map(({ id }) => id)).size !== value.findings.length
	)
		invalid("report.findings");
	if (
		!Array.isArray(value.requirement_results) ||
		value.requirement_results.length > 128
	)
		invalid("report.requirement_results");
	value.requirement_results.forEach((entry, index) =>
		requirementResult(entry, `report.requirement_results[${index}]`),
	);
	const requirementKeys = value.requirement_results.map(
		({ requirement_kind, requirement_id }) =>
			`${requirement_kind}:${requirement_id}`,
	);
	if (new Set(requirementKeys).size !== requirementKeys.length)
		invalid("report.requirement_results");
	sortedUniqueStrings(
		value.changed_paths,
		validateRelativePath,
		"report.changed_paths",
		256,
	);
	if (!Array.isArray(value.artifacts) || value.artifacts.length !== 0)
		invalid("report.artifacts");
	timestamp(value.completed_at, "report.completed_at");
	if (value.status === "completed")
		roleResult(value.result, value.role.contract_role, "report.result");
	else if (value.result !== null) invalid("report.result");
	if (
		value.status === "blocked" &&
		value.requirement_results.some(
			({ assertion }) =>
				assertion !== "not_run" && assertion !== "not_applicable",
		)
	)
		invalid("blocked report requirements");
	if (
		value.result?.kind === "review" &&
		value.result.verdict === "request_changes" &&
		!value.findings.some(({ severity }) => severity !== "info")
	)
		invalid("review result");
	if (value.result?.kind === "validation") {
		const applicablePass = value.requirement_results.every(
			({ assertion }) =>
				assertion === "passed" || assertion === "not_applicable",
		);
		if (value.result.verdict === "pass" && !applicablePass)
			invalid("validation pass");
		if (
			value.result.verdict === "fail" &&
			!value.requirement_results.some(
				({ assertion }) => assertion === "failed",
			) &&
			!value.findings.some(
				({ severity, message }) =>
					severity !== "info" && message.startsWith("Prohibited mutation:"),
			)
		)
			invalid("validation fail");
	}
	if (task !== undefined) validateReportTaskBinding(value, task);
	serializedBound(value, REPORT_MAX_BYTES, "report size");
}

function validateReportTaskBinding(value, task) {
	validateTask(task);
	if (
		value.task.id !== task.task_id ||
		value.task.generation !== task.task_generation ||
		value.task.digest !== task.task_digest
	)
		fail("foreign_role", "report does not identify the authoritative task");
	if (
		canonicalJson(value.scope) !== canonicalJson(task.scope) ||
		canonicalJson(value.role) !== canonicalJson(task.role)
	)
		fail("foreign_role", "report scope or role differs from task");
	if (
		value.agent_observation.operation_id !== task.role.agent_operation_id ||
		value.agent_observation.agent_generation !== task.role.agent_generation ||
		value.agent_observation.pane_generation !== task.role.pane_generation ||
		value.agent_observation.agent_name !== task.role.agent_name
	)
		fail("foreign_role", "report agent observation differs from task");
	if (task.source.kind !== value.source.kind)
		fail("stale_source", "report source kind differs from task");
	if (task.source.kind === "integration_snapshot") {
		if (
			canonicalJson(value.source) !== canonicalJson(task.source) ||
			value.changed_paths.length !== 0
		)
			fail("stale_source", "gate report source must equal task source");
	} else {
		const changing = new Set(["expected_sha", "tree_sha"]);
		for (const key of Object.keys(task.source))
			if (
				!changing.has(key) &&
				canonicalJson(value.source[key]) !== canonicalJson(task.source[key])
			)
				fail("stale_source", `producer report source ${key} differs from task`);
	}
	const expected = new Map();
	for (const entry of task.assignment.required_commands)
		expected.set(`command:${entry.id}`, entry);
	for (const entry of task.assignment.acceptance_criteria)
		expected.set(`criterion:${entry.id}`, entry);
	if (expected.size !== value.requirement_results.length)
		invalid("report requirement completeness");
	for (const result of value.requirement_results) {
		const requirement = expected.get(
			`${result.requirement_kind}:${result.requirement_id}`,
		);
		if (!requirement) invalid("report requirement identity");
		if (
			result.requirement_kind === "command" &&
			result.command !== requirement.command
		)
			invalid("report command text");
		if (
			result.requirement_kind === "criterion" &&
			result.assertion === "not_applicable" &&
			(!requirement.text.startsWith("Applicability: ") ||
				requirement.text.length === "Applicability: ".length ||
				result.note.length === 0)
		)
			invalid("criterion applicability");
	}
}

export function reportDigest(report) {
	return digest(
		"herdr-conductor-report-digest-v1\0",
		without(report, "report_digest"),
	);
}

export function validateReportDraft(value, options = {}) {
	reportCore(value, { ...options, draft: true });
	return clone(value);
}

export function validateReport(value, options = {}) {
	reportCore(value, { ...options, draft: false });
	if (value.report_digest !== reportDigest(value))
		fail("digest_mismatch", "report digest does not match canonical report");
	return clone(value);
}

export function publishingGuardDigest(value) {
	return digest(
		"herdr-conductor-publishing-guard-digest-v1\0",
		without(value, "guard_digest"),
	);
}

function publisherCommon(value, label, { marker = false } = {}) {
	scope(value.scope, `${label}.scope`);
	taskReference(value.task, `${label}.task`);
	exact(
		value.outbox,
		["id", "generation", "root", "slot_name"],
		`${label}.outbox`,
	);
	matching(value.outbox.id, ID, `${label}.outbox.id`);
	matching(value.outbox.generation, GENERATION, `${label}.outbox.generation`);
	canonicalPath(value.outbox.root, `${label}.outbox.root`);
	matching(value.outbox.slot_name, ID, `${label}.outbox.slot_name`);
	exact(
		value.filenames,
		marker ? ["payload", "commit"] : ["guard", "staging", "payload", "commit"],
		`${label}.filenames`,
	);
	if (
		value.filenames.payload !== "report.json" ||
		value.filenames.commit !== "COMMITTED.json"
	)
		invalid(`${label}.filenames`);
	if (
		!marker &&
		(value.filenames.guard !== ".publishing.json" ||
			value.filenames.staging !== `payload.part-${value.publisher_nonce}`)
	)
		invalid(`${label}.filenames`);
	matching(value.publisher_nonce, GENERATION, `${label}.publisher_nonce`);
	exact(value.report, ["id", "generation", "digest"], `${label}.report`);
	matching(value.report.id, ID, `${label}.report.id`);
	matching(value.report.generation, GENERATION, `${label}.report.generation`);
	matching(value.report.digest, DIGEST, `${label}.report.digest`);
	integer(value.payload_byte_length, `${label}.payload_byte_length`);
	matching(value.payload_sha256, DIGEST, `${label}.payload_sha256`);
}

export function validatePublishingGuard(value) {
	exact(
		value,
		[
			"document_type",
			"schema_version",
			"guard_digest",
			"scope",
			"task",
			"outbox",
			"filenames",
			"publisher_nonce",
			"report",
			"payload_byte_length",
			"payload_sha256",
		],
		"publishing guard",
	);
	if (
		value.document_type !== "herdr-conductor-report-publishing-guard" ||
		value.schema_version !== 1
	)
		invalid("publishing guard document");
	matching(value.guard_digest, DIGEST, "publishing guard.guard_digest");
	publisherCommon(value, "publishing guard");
	serializedBound(
		value,
		PUBLICATION_METADATA_MAX_BYTES,
		"publishing guard size",
	);
	if (value.guard_digest !== publishingGuardDigest(value))
		fail("digest_mismatch", "publishing guard digest mismatch");
	return clone(value);
}

export function commitMarkerDigest(value) {
	return digest(
		"herdr-conductor-commit-marker-digest-v1\0",
		without(value, "marker_digest"),
	);
}

export function validateCommitMarker(value) {
	exact(
		value,
		[
			"document_type",
			"schema_version",
			"marker_digest",
			"scope",
			"task",
			"outbox",
			"filenames",
			"publisher_nonce",
			"report",
			"payload_byte_length",
			"payload_sha256",
			"publishing_guard_digest",
		],
		"commit marker",
	);
	if (
		value.document_type !== "herdr-conductor-report-committed" ||
		value.schema_version !== 1
	)
		invalid("commit marker document");
	matching(value.marker_digest, DIGEST, "commit marker.marker_digest");
	publisherCommon(value, "commit marker", { marker: true });
	matching(
		value.publishing_guard_digest,
		DIGEST,
		"commit marker.publishing_guard_digest",
	);
	serializedBound(value, PUBLICATION_METADATA_MAX_BYTES, "commit marker size");
	if (value.marker_digest !== commitMarkerDigest(value))
		fail("digest_mismatch", "commit marker digest mismatch");
	return clone(value);
}

const REJECTION_FAILURE_CLASSES = new Set([
	"report_mismatch",
	"source_identity",
	"source_dirty",
	"path_policy",
	"task_stale",
	"requirement_contract",
]);

function sourceObservation(value, label) {
	exact(
		value,
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
		label,
	);
	canonicalPath(value.canonical_path, `${label}.canonical_path`);
	commonDirectory(value.common_directory, `${label}.common_directory`);
	matching(value.full_ref, FULL_REF, `${label}.full_ref`);
	matching(value.head_sha, SHA, `${label}.head_sha`);
	matching(value.head_tree_sha, SHA, `${label}.head_tree_sha`);
	if (value.index_tree_sha !== null)
		matching(value.index_tree_sha, SHA, `${label}.index_tree_sha`);
	for (const field of [
		"tracked_status_sha256",
		"untracked_inventory_sha256",
		"ignored_inventory_sha256",
		"computed_changed_paths_sha256",
	])
		matching(value[field], DIGEST, `${label}.${field}`);
	timestamp(value.observed_at, `${label}.observed_at`);
}

export function reportRejectionDigest(value) {
	return digest("herdr-conductor/report-rejection/v1\n", value);
}

export function validateReportRejection(value) {
	exact(
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
		"report rejection",
	);
	if (
		value.document_type !== "herdr-conductor-report-rejection" ||
		value.schema_version !== 1
	)
		invalid("report rejection document");
	matching(value.repository_key, DIGEST, "report rejection.repository_key");
	matching(value.workspace_id, ID, "report rejection.workspace_id");
	matching(value.run_id, ID, "report rejection.run_id");
	matching(value.run_generation, GENERATION, "report rejection.run_generation");
	matching(value.role_name, ROLE_NAME, "report rejection.role_name");
	matching(value.task_id, ID, "report rejection.task_id");
	matching(
		value.task_generation,
		GENERATION,
		"report rejection.task_generation",
	);
	matching(value.task_digest, DIGEST, "report rejection.task_digest");
	matching(
		value.report_generation,
		GENERATION,
		"report rejection.report_generation",
	);
	matching(
		value.raw_payload_sha256,
		DIGEST,
		"report rejection.raw_payload_sha256",
	);
	matching(
		value.committed_marker_digest,
		DIGEST,
		"report rejection.committed_marker_digest",
	);
	enumeration(
		value.failure_class,
		REJECTION_FAILURE_CLASSES,
		"report rejection.failure_class",
	);
	matching(
		value.validation_input_digest,
		DIGEST,
		"report rejection.validation_input_digest",
	);
	if (value.source_observation !== null)
		sourceObservation(
			value.source_observation,
			"report rejection.source_observation",
		);
	if (
		["source_identity", "source_dirty", "path_policy"].includes(
			value.failure_class,
		) &&
		value.source_observation === null
	)
		invalid("report rejection.source_observation");
	return clone(value);
}

export function parseTaskBytes(bytes) {
	return validateTask(
		parseStrictJsonBytes(bytes, { maxBytes: TASK_MAX_BYTES }),
	);
}

export function parseReportBytes(bytes, options = {}) {
	return validateReport(
		parseStrictJsonBytes(bytes, { maxBytes: REPORT_MAX_BYTES }),
		options,
	);
}

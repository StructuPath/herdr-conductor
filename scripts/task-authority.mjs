#!/usr/bin/env node
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import {
	canonicalJson,
	parseStrictJsonBytes,
	StateKernelError,
} from "./private-state-schema.mjs";
import { validateTask } from "./task-report-schema.mjs";
import {
	ensurePrivateSubdirectory,
	loadActiveRun,
	performJournaledOperation,
	publishExclusivePrivateBytes,
	readStablePrivateBytes,
} from "./state-kernel.mjs";

function hash(domain, value) {
	return createHash("sha256")
		.update(domain)
		.update(canonicalJson(value))
		.digest("hex");
}

export function taskPublicationRequest(task, taskPath, configurationDigest) {
	validateTask(task);
	return Object.freeze({
		document_type: "herdr-conductor-task-publication-request",
		schema_version: 1,
		task_path: taskPath,
		task_digest: task.task_digest,
		task_generation: task.task_generation,
		source_generation: task.role.source_generation,
		outbox_generation: task.outbox.outbox_generation,
		configuration_digest: configurationDigest,
		pane_operation_id: task.role.pane_operation_id,
		agent_operation_id: task.role.agent_operation_id,
		agent_request_digest: task.role.agent_request_digest,
	});
}

export function taskPublicationRequestDigest(
	task,
	taskPath,
	configurationDigest,
) {
	return hash(
		"herdr-conductor/task-publication-request/v1\n",
		taskPublicationRequest(task, taskPath, configurationDigest),
	);
}

export async function publishTaskAuthority(
	handle,
	{ workspaceId, runId, runGeneration, task, configurationDigest, fault } = {},
) {
	const checked = validateTask(task);
	const active = loadActiveRun(handle.store, {
		workspaceId,
		expectedRunId: runId,
		expectedGeneration: runGeneration,
	});
	const paths = active.paths;
	const stateRoot = handle.store.stateRoot;
	if (!paths?.tasksDir || !paths?.outboxesDir || !stateRoot)
		throw new StateKernelError(
			"state_unknown",
			"active Stage 2 run paths are unavailable",
		);
	const sourceOperation =
		checked.source.kind === "role_worktree"
			? "worktree.create"
			: "gate-source.create";
	const sourceEntries = active.journal.filter(
		(entry) =>
			entry.operation_type === sourceOperation &&
			entry.phase === "observed" &&
			entry.subject.id === checked.role.name &&
			entry.subject.generation === checked.role.source_generation &&
			entry.observed_identity !== null,
	);
	if (sourceEntries.length !== 1)
		throw new StateKernelError(
			"bookkeeping_unknown",
			"task source authority is missing or duplicated",
		);
	const sourceEntry = sourceEntries[0];
	const sourceEntryDigest =
		checked.source.kind === "role_worktree"
			? checked.source.worktree_entry_digest
			: checked.source.snapshot_entry_digest;
	if (sourceEntry.entry_digest !== sourceEntryDigest)
		throw new StateKernelError(
			"stale_source",
			"task source does not bind the observed source journal entry",
		);
	const observedSource = sourceEntry.observed_identity;
	const sourceMatches =
		checked.source.kind === "role_worktree"
			? checked.source.root === observedSource.path &&
				canonicalJson(checked.source.common_dir) ===
					canonicalJson(observedSource.common_dir) &&
				checked.source.branch_ref === observedSource.branch_ref &&
				checked.source.fork_sha === observedSource.fork_sha &&
				checked.source.expected_sha === observedSource.head_sha &&
				checked.source.registered === observedSource.registered
			: checked.source.root === observedSource.root &&
				canonicalJson(checked.source.common_dir) ===
					canonicalJson(observedSource.common_dir) &&
				checked.source.head_mode === observedSource.head_mode &&
				checked.source.base_sha === observedSource.base_sha &&
				checked.source.integration_sha === observedSource.integration_sha &&
				checked.source.tree_sha === observedSource.tree_sha &&
				checked.source.integration_entry_digest ===
					observedSource.integration_entry_digest &&
				checked.source.registered === observedSource.registered;
	if (!sourceMatches)
		throw new StateKernelError(
			"stale_source",
			"task source does not equal the observed source identity",
		);
	if (
		active.journal.some(
			(entry) =>
				["pane.create", "agent.start"].includes(entry.operation_type) &&
				entry.subject.id === checked.role.name,
		)
	)
		throw new StateKernelError(
			"bookkeeping_unknown",
			"task publication cannot follow pane or agent authority",
		);
	const roleTaskDirectory = ensurePrivateSubdirectory(
		join(paths.tasksDir, checked.role.name),
		{ root: stateRoot, fault },
	);
	const taskPath = join(roleTaskDirectory, `${checked.task_generation}.json`);
	const expectedTaskPath = resolve(taskPath);
	const roleOutbox = ensurePrivateSubdirectory(
		join(paths.outboxesDir, checked.role.name),
		{ root: stateRoot, fault },
	);
	const sourceOutbox = ensurePrivateSubdirectory(
		join(roleOutbox, checked.role.source_generation),
		{ root: stateRoot, fault },
	);
	const taskOutbox = ensurePrivateSubdirectory(
		join(sourceOutbox, checked.task_generation),
		{ root: stateRoot, fault },
	);
	const generationOutbox = ensurePrivateSubdirectory(
		join(taskOutbox, checked.outbox.outbox_generation),
		{ root: stateRoot, fault },
	);
	if (generationOutbox !== checked.outbox.root)
		throw new StateKernelError(
			"path_mismatch",
			"task outbox root does not equal the derived private path",
		);
	ensurePrivateSubdirectory(join(generationOutbox, checked.outbox.slot_name), {
		root: stateRoot,
		fault,
	});
	const requestDigest = taskPublicationRequestDigest(
		checked,
		expectedTaskPath,
		configurationDigest,
	);
	const result = await performJournaledOperation(handle, {
		workspaceId,
		runId,
		runGeneration,
		operationId: `task-publish-${checked.role.name}-${checked.task_generation}`,
		operationType: "task.publish",
		subject: {
			kind: "task",
			id: checked.role.name,
			generation: checked.task_generation,
		},
		requestDigest,
		fault,
		effect: async () => {
			const bytes = Buffer.from(canonicalJson(checked));
			publishExclusivePrivateBytes(taskPath, bytes, {
				root: stateRoot,
				maxBytes: 262_144,
				fault,
				scope: "task_publish",
			});
			return { resultDigest: checked.task_digest };
		},
	});
	return Object.freeze({
		taskPath,
		slotPath: join(checked.outbox.root, checked.outbox.slot_name),
		requestDigest,
		...result,
	});
}

export function loadAuthoritativeTaskByExactPath(
	taskPath,
	stateRoot,
	{ active, configurationDigest, requireAttachedAgent = true } = {},
) {
	if (!active?.paths?.tasksDir || !active?.journal)
		throw new StateKernelError(
			"state_unknown",
			"active Stage 2 authority is unavailable",
		);
	const bytes = readStablePrivateBytes(taskPath, {
		root: stateRoot,
		maxBytes: 262_144,
	});
	let task;
	try {
		task = validateTask(parseStrictJsonBytes(bytes, { maxBytes: 262_144 }));
	} catch (error) {
		if (error instanceof StateKernelError) throw error;
		throw new StateKernelError("invalid_json", "task bytes are malformed", {
			cause: error,
		});
	}
	const expected = join(
		active.paths.tasksDir,
		task.role.name,
		`${task.task_generation}.json`,
	);
	if (resolve(taskPath) !== expected || taskPath !== expected)
		throw new StateKernelError(
			"path_mismatch",
			"task was not loaded from its exact authoritative path",
		);
	if (
		task.scope.repository.key !== active.state.repository.key ||
		task.scope.workspace_id !== active.state.workspace_id ||
		task.scope.run_id !== active.state.run_id ||
		task.scope.run_generation !== active.state.generation
	)
		throw new StateKernelError(
			"foreign_run",
			"task scope does not equal the active run",
		);
	const requestDigest = taskPublicationRequestDigest(
		task,
		expected,
		configurationDigest,
	);
	const publications = active.journal.filter(
		(entry) =>
			entry.operation_type === "task.publish" &&
			entry.phase === "observed" &&
			entry.subject.id === task.role.name &&
			entry.subject.generation === task.task_generation &&
			entry.request_digest === requestDigest &&
			entry.result_digest === task.task_digest,
	);
	if (publications.length !== 1)
		throw new StateKernelError(
			"bookkeeping_unknown",
			"task publication authority is missing or duplicated",
		);
	if (requireAttachedAgent) {
		const agents = active.journal.filter(
			(entry) =>
				entry.operation_type === "agent.start" &&
				entry.phase === "observed" &&
				entry.subject.id === task.role.name &&
				entry.subject.generation === task.role.agent_generation,
		);
		if (agents.length !== 1)
			throw new StateKernelError(
				"foreign_role",
				"task does not have one attached observed agent",
			);
	}
	return Object.freeze({
		task,
		bytes,
		taskPath: expected,
		publication: publications[0],
	});
}

#!/usr/bin/env node
import {
	closeSync,
	constants,
	fstatSync,
	openSync,
	readFileSync,
	unlinkSync,
} from "node:fs";
import { join } from "node:path";
import {
	PRIVATE_STATE_VERSION,
	parseStrictJsonBytes,
	validateGeneration,
	validateId,
	validateJournalEntry,
	validateKey,
	validateRunState,
} from "./private-state-schema.mjs";
import { OPERATION_TYPES, operationPolicy } from "./operation-policy.mjs";

import {
	assertLock,
	checkpoint,
	compareRunIdentity,
	fsyncDirectory,
	inspectRepositoryLock,
	journalEntryDigest,
	kernelError,
	lstat,
	loadActiveRun,
	publishExclusiveJson,
	readPrivateJson,
	removePrivateGuard,
	sameRepository,
	scanActivePointers,
	scanExactDirectory,
	scanJournal,
	scanRunStates,
	workspacePaths,
	writeAtomicJson,
} from "./state-internal.mjs";
function journalPath(active, sequence, operationId) {
	return join(
		active.paths.operationsDir,
		`${String(sequence).padStart(10, "0")}-${operationId}.json`,
	);
}

function journalGuardPath(active, sequence, operationId) {
	return join(
		active.paths.operationGuardsDir,
		`${String(sequence).padStart(10, "0")}-${operationId}.json`,
	);
}

function readUncertainJournal(path) {
	let descriptor;
	try {
		descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
		const stats = fstatSync(descriptor);
		if (
			!stats.isFile() ||
			(stats.mode & 0o777) !== 0o600 ||
			stats.uid !== process.getuid() ||
			stats.nlink < 1 ||
			stats.nlink > 2
		)
			throw kernelError(
				"bookkeeping_unknown",
				"uncertain archive journal identity is invalid",
			);
		return validateJournalEntry(
			parseStrictJsonBytes(readFileSync(descriptor), { maxBytes: 1_048_576 }),
		);
	} finally {
		if (descriptor !== undefined) closeSync(descriptor);
	}
}

function validateOperationRequest(request) {
	validateId(request.operationId, "operation id");
	if (!OPERATION_TYPES.includes(request.operationType)) {
		throw kernelError("invalid_state", "operation type is invalid");
	}
	if (
		request.subject === null ||
		typeof request.subject !== "object" ||
		Array.isArray(request.subject)
	) {
		throw kernelError("invalid_state", "operation subject is invalid");
	}
	const keys = Object.keys(request.subject).sort();
	if (keys.join(",") !== "generation,id,kind")
		throw kernelError("invalid_state", "operation subject has unknown fields");
	validateId(request.subject.kind, "subject kind");
	validateId(request.subject.id, "subject id");
	validateGeneration(request.subject.generation, "subject generation");
	validateKey(request.requestDigest, "request digest");
	if (
		request.operationType === "report.reject" &&
		request.operationId !==
			`report-reject-${request.subject.id}-${request.subject.generation}`
	) {
		throw kernelError(
			"invalid_state",
			"report rejection operation id must bind the full report generation",
		);
	}
}

function validateOperationSubject(active, operationType, subject) {
	const policy = operationPolicy(operationType);
	if (subject.kind !== policy.subjectKind) {
		throw kernelError(
			"invalid_state",
			"operation subject kind is incompatible with its operation type",
		);
	}
	if (
		operationType === "run.archive" ||
		operationType === "run.stand-down.begin"
	) {
		if (
			subject.id !== active.state.run_id ||
			subject.generation !== active.state.generation
		) {
			throw kernelError(
				"stale_generation",
				"run operation subject is stale or foreign",
			);
		}
		return;
	}
	if (["git.merge", "pane.close"].includes(operationType)) {
		const matching = active.journal.filter(
			(entry) =>
				entry.operation_type === policy.prerequisite &&
				entry.phase === "observed" &&
				entry.subject.id === subject.id &&
				entry.subject.generation === subject.generation &&
				entry.observed_identity !== null,
		);
		if (matching.length !== 1)
			throw kernelError(
				"stale_generation",
				"canonical creation journal subject is missing, duplicate, or stale",
			);
	}
	if (operationType === "integration.harvest") {
		const reconciliations = active.journal.filter(
			(entry) =>
				entry.operation_type === "integration.reconcile" &&
				entry.phase === "observed" &&
				entry.subject.id === subject.id &&
				entry.subject.generation === subject.generation,
		);
		if (reconciliations.length !== 1)
			throw kernelError(
				"bookkeeping_unknown",
				"integration harvest requires one observed reconciliation",
			);
	}
	if (operationType === "gate-source.create") {
		const integrations = active.journal.filter(
			(entry) =>
				entry.operation_type === "integration.harvest" &&
				entry.phase === "observed",
		);
		if (integrations.length !== 1)
			throw kernelError(
				"bookkeeping_unknown",
				"gate source creation requires one observed integration harvest",
			);
	}
	if (["report.harvest", "report.reject"].includes(operationType)) {
		const opposite =
			operationType === "report.harvest" ? "report.reject" : "report.harvest";
		if (
			active.journal.some(
				(entry) =>
					entry.operation_type === opposite &&
					entry.subject.id === subject.id &&
					entry.subject.generation === subject.generation,
			)
		) {
			throw kernelError(
				"operation_conflict",
				"report acceptance and rejection are mutually exclusive",
			);
		}
	}
}

function createIntent(
	active,
	operationId,
	operationType,
	subject,
	requestDigest,
) {
	const sequence = active.state.journal_sequence + 1;
	const now = new Date().toISOString();
	const intent = {
		document_type: "herdr-conductor-operation",
		schema_version: PRIVATE_STATE_VERSION,
		repository_key: active.store.repository.key,
		workspace_id: active.state.workspace_id,
		workspace_key: active.state.workspace_key,
		run_id: active.state.run_id,
		run_generation: active.state.generation,
		sequence,
		operation_id: operationId,
		operation_type: operationType,
		subject,
		request_digest: requestDigest,
		previous_digest: active.state.journal_head,
		entry_digest: "0".repeat(64),
		phase: "intent",
		result_digest: null,
		observed_identity: null,
		error_code: null,
		created_at: now,
		updated_at: now,
	};
	intent.entry_digest = journalEntryDigest(intent);
	return validateJournalEntry(intent);
}

function publishIntent(active, intent, fault, intentScope, headScope) {
	const path = journalPath(active, intent.sequence, intent.operation_id);
	publishExclusiveJson(path, intent, validateJournalEntry, {
		root: active.store.stateRoot,
		fault,
		scope: intentScope,
	});
	const journaledState = {
		...active.state,
		revision: active.state.revision + 1,
		journal_sequence: intent.sequence,
		journal_head: intent.entry_digest,
		updated_at: new Date().toISOString(),
	};
	writeAtomicJson(active.paths.statePath, journaledState, validateRunState, {
		root: active.store.stateRoot,
		fault,
		scope: headScope,
	});
	active.state = validateRunState(journaledState);
	return path;
}

function publishGuard(active, intent, fault, scope) {
	const path = journalGuardPath(active, intent.sequence, intent.operation_id);
	publishExclusiveJson(path, intent, validateJournalEntry, {
		root: active.store.stateRoot,
		fault,
		scope,
	});
	return path;
}

function transitionJournalEntry(
	active,
	path,
	entry,
	{ phase, resultDigest, observedIdentity, errorCode, fault, scope },
) {
	const transitioned = {
		...entry,
		entry_digest: "0".repeat(64),
		phase,
		result_digest: resultDigest,
		observed_identity: observedIdentity,
		error_code: errorCode,
		updated_at: new Date().toISOString(),
	};
	transitioned.entry_digest = journalEntryDigest(transitioned);
	writeAtomicJson(path, transitioned, validateJournalEntry, {
		root: active.store.stateRoot,
		fault,
		scope,
	});
	const runState = {
		...active.state,
		revision: active.state.revision + 1,
		journal_head: transitioned.entry_digest,
		updated_at: new Date().toISOString(),
	};
	writeAtomicJson(active.paths.statePath, runState, validateRunState, {
		root: active.store.stateRoot,
		fault,
		scope: `${scope}_head`,
	});
	active.state = validateRunState(runState);
	return validateJournalEntry(transitioned);
}

function loadArchiveCandidate(
	store,
	{ workspaceId, runId, runGeneration, operationId },
) {
	const workspace = workspacePaths(store, workspaceId);
	const states = scanRunStates(store, workspace).filter(
		({ state }) => state.run_id === runId && state.generation === runGeneration,
	);
	if (states.length !== 1)
		throw kernelError(
			"recovery_required",
			"archive run identity is missing or ambiguous",
		);
	const pointers = scanActivePointers(store, workspace).filter(
		({ value }) => value.run_id === runId && value.generation === runGeneration,
	);
	if (pointers.length > 1)
		throw kernelError(
			"duplicate_active",
			"archive run has duplicate active pointers",
		);
	const selected = states[0];
	if (selected.activationGuard)
		throw kernelError(
			"recovery_required",
			"archive run has an activation guard",
		);
	if (!sameRepository(selected.state.repository, store.repository))
		throw kernelError(
			"foreign_repository",
			"archive run belongs to another repository",
		);
	if (
		selected.state.repository_root !== store.repositoryRoot ||
		selected.state.workspace_id !== workspaceId ||
		selected.state.workspace_key !== workspace.key
	)
		throw kernelError(
			"foreign_workspace",
			"archive run belongs to another scope",
		);
	if (pointers.length === 1)
		compareRunIdentity(store, workspace, pointers[0].value, selected.state);
	else if (selected.state.status !== "archived")
		throw kernelError(
			"bookkeeping_unknown",
			"active archive run lost its pointer",
		);
	const active = {
		store,
		workspace,
		pointer: pointers[0]?.value ?? null,
		pointerPath:
			pointers[0]?.path ??
			join(workspace.activeDir, `${runId}--${runGeneration}.json`),
		state: selected.state,
		paths: selected.paths,
		journal: [],
	};
	active.journal = scanJournal(store, active, {
		allowGuards: true,
		allowArchiveTransition: true,
	});
	const archiveEntries = active.journal.filter(
		(entry) =>
			entry.operation_id === operationId &&
			entry.operation_type === "run.archive",
	);
	if (archiveEntries.length > 1)
		throw kernelError(
			"bookkeeping_unknown",
			"archive journal authority is duplicated",
		);
	const guards = active.journal.guards;
	if (
		guards.length > 1 ||
		(guards.length === 1 && guards[0].operation_id !== operationId)
	)
		throw kernelError(
			"recovery_required",
			"archive has foreign uncertainty guards",
		);
	return {
		active,
		entry: archiveEntries[0] ?? null,
		guard: guards[0] ?? null,
	};
}

export function inspectArchiveUncertainty(store, { workspaceId } = {}) {
	const workspace = workspacePaths(store, workspaceId);
	const pointers = scanActivePointers(store, workspace);
	const lock = inspectRepositoryLock(store);
	const candidates = [];
	for (const selected of scanRunStates(store, workspace)) {
		if (
			selected.state.workspace_id !== workspaceId ||
			!sameRepository(selected.state.repository, store.repository)
		)
			continue;
		const pointer = pointers.find(
			({ value }) =>
				value.run_id === selected.state.run_id &&
				value.generation === selected.state.generation,
		);
		const active = {
			store,
			workspace,
			pointer: pointer?.value ?? null,
			pointerPath:
				pointer?.path ??
				join(
					workspace.activeDir,
					`${selected.state.run_id}--${selected.state.generation}.json`,
				),
			state: selected.state,
			paths: selected.paths,
			journal: [],
		};
		let journal;
		let guards;
		try {
			journal = scanJournal(store, active, {
				allowGuards: true,
				allowArchiveTransition: true,
			});
			guards = journal.guards;
		} catch {
			journal = scanExactDirectory(active.paths.operationsDir, {
				root: store.stateRoot,
			})
				.filter(
					(entry) =>
						entry.type === "file" && /^\d{10}-.+\.json$/.test(entry.name),
				)
				.map((entry) => {
					const path = join(active.paths.operationsDir, entry.name);
					try {
						return readPrivateJson(path, validateJournalEntry, {
							root: store.stateRoot,
							maxBytes: 1_048_576,
						});
					} catch {
						return readUncertainJournal(path);
					}
				});
			guards = scanExactDirectory(active.paths.operationGuardsDir, {
				root: store.stateRoot,
			})
				.filter(
					(entry) =>
						entry.type === "file" && /^\d{10}-.+\.json$/.test(entry.name),
				)
				.map((entry) => {
					const path = join(active.paths.operationGuardsDir, entry.name);
					try {
						return readPrivateJson(path, validateJournalEntry, {
							root: store.stateRoot,
							maxBytes: 1_048_576,
						});
					} catch {
						return readUncertainJournal(path);
					}
				});
		}
		for (const entry of journal.filter(
			(candidate) => candidate.operation_type === "run.archive",
		)) {
			const guard = guards.find(
				(candidate) => candidate.operation_id === entry.operation_id,
			);
			const completedArchive =
				entry.phase === "observed" &&
				selected.state.status === "archived" &&
				!pointer &&
				!guard;
			if (!completedArchive)
				candidates.push({
					run_id: selected.state.run_id,
					run_generation: selected.state.generation,
					operation_id: entry.operation_id,
					journal_phase: entry.phase,
					state_status: selected.state.status,
					pointer_present: Boolean(pointer),
					guard_present: Boolean(guard),
					lock_status: lock.status,
				});
		}
	}
	if (candidates.length > 1)
		throw kernelError(
			"recovery_required",
			"archive restart authority is ambiguous",
		);
	if (candidates.length === 0) return null;
	return Object.freeze({
		classification: "archive_uncertain",
		error_code: "recovery_required",
		...candidates[0],
	});
}

export function archiveActiveRun(
	handle,
	{
		workspaceId,
		runId,
		runGeneration,
		operationId,
		subject,
		requestDigest,
		fault,
	} = {},
) {
	assertLock(handle);
	validateOperationRequest({
		operationId,
		operationType: "run.archive",
		subject,
		requestDigest,
	});
	const loaded = loadArchiveCandidate(handle.store, {
		workspaceId,
		runId,
		runGeneration,
		operationId,
	});
	let { active, entry } = loaded;
	validateOperationSubject(active, "run.archive", subject);
	if (entry) {
		if (
			entry.request_digest !== requestDigest ||
			entry.subject.kind !== subject.kind ||
			entry.subject.id !== subject.id ||
			entry.subject.generation !== subject.generation
		)
			throw kernelError(
				"operation_conflict",
				"archive operation input changed",
			);
		throw kernelError(
			"recovery_required",
			"existing archive authority is uncertain and cannot be replayed",
		);
	}
	if (active.state.status !== "active" || active.pointer === null)
		throw kernelError(
			"recovery_required",
			"archive cannot begin from this state",
		);
	entry = createIntent(
		active,
		operationId,
		"run.archive",
		subject,
		requestDigest,
	);
	publishIntent(active, entry, fault, "archive_intent", "archive_intent_head");
	checkpoint(fault, "archive.after_intent_durable");
	publishGuard(active, entry, fault, "archive_guard_publish");
	checkpoint(fault, "archive.after_guard_durable");
	try {
		assertLock(handle);
		if (active.state.status === "active") {
			const archived = {
				...active.state,
				revision: active.state.revision + 1,
				status: "archived",
				updated_at: new Date().toISOString(),
			};
			writeAtomicJson(active.paths.statePath, archived, validateRunState, {
				root: handle.store.stateRoot,
				fault,
				scope: "archive_state",
			});
			active.state = validateRunState(archived);
		}
		checkpoint(fault, "archive.after_state_durable");
		assertLock(handle);
		if (lstat(active.pointerPath)) {
			checkpoint(fault, "archive.before_pointer_remove");
			unlinkSync(active.pointerPath);
			checkpoint(fault, "archive.after_pointer_remove");
		}
		checkpoint(fault, "archive.before_pointer_fsync");
		fsyncDirectory(active.workspace.activeDir);
		checkpoint(fault, "archive.after_pointer_fsync");
		checkpoint(fault, "archive.before_result");
		const observed = transitionJournalEntry(
			active,
			journalPath(active, entry.sequence, operationId),
			entry,
			{
				phase: "observed",
				resultDigest: requestDigest,
				observedIdentity: null,
				errorCode: null,
				fault,
				scope: "archive_result",
			},
		);
		removePrivateGuard(journalGuardPath(active, entry.sequence, operationId), {
			parent: active.paths.operationGuardsDir,
			fault,
			scope: "archive_guard_remove",
		});
		return {
			replayed: false,
			resultDigest: observed.result_digest,
			state: active.state,
		};
	} catch (error) {
		throw kernelError(
			"recovery_required",
			"archive transition is uncertain and cannot be replayed",
			error,
		);
	}
}

export async function performJournaledOperation(
	handle,
	{
		workspaceId,
		runId,
		runGeneration,
		operationId,
		operationType,
		subject,
		requestDigest,
		effect,
		validateBeforeResultPublication,
		fault,
	} = {},
) {
	assertLock(handle);
	if (typeof effect !== "function")
		throw kernelError("invalid_state", "journaled effect is required");
	if (
		validateBeforeResultPublication !== undefined &&
		typeof validateBeforeResultPublication !== "function"
	)
		throw kernelError(
			"invalid_state",
			"result publication validator must be a function",
		);
	validateOperationRequest({
		operationId,
		operationType,
		subject,
		requestDigest,
	});
	const active = loadActiveRun(handle.store, {
		workspaceId,
		expectedRunId: runId,
		expectedGeneration: runGeneration,
	});
	validateOperationSubject(active, operationType, subject);
	const existing = active.journal.find(
		(entry) => entry.operation_id === operationId,
	);
	if (existing) {
		const sameSubject =
			existing.subject.kind === subject.kind &&
			existing.subject.id === subject.id &&
			existing.subject.generation === subject.generation;
		if (
			existing.operation_type !== operationType ||
			existing.request_digest !== requestDigest ||
			!sameSubject
		) {
			throw kernelError(
				"operation_conflict",
				"operation id was reused with different input",
			);
		}
		if (existing.phase === "observed") {
			return {
				replayed: true,
				resultDigest: existing.result_digest,
				sequence: existing.sequence,
			};
		}
		throw kernelError(
			"recovery_required",
			"operation requires explicit recovery",
		);
	}
	const intent = createIntent(
		active,
		operationId,
		operationType,
		subject,
		requestDigest,
	);
	const sequence = intent.sequence;
	const guardPath = journalGuardPath(active, sequence, operationId);
	let path;
	let intentDurable = false;
	let guardDurable = false;
	let effectStarted = false;
	try {
		path = publishIntent(
			active,
			intent,
			fault,
			"journal_intent",
			"journal_head",
		);
		intentDurable = true;
		checkpoint(fault, "journal.after_intent_durable");
		publishGuard(active, intent, fault, "journal_guard_publish");
		guardDurable = true;
		checkpoint(fault, "journal.after_guard_durable");
		assertLock(handle);
		effectStarted = true;
		const observation = await effect();
		if (
			observation === null ||
			typeof observation !== "object" ||
			Array.isArray(observation)
		) {
			throw kernelError(
				"invalid_state",
				"journaled effect returned an invalid observation",
			);
		}
		const observationKeys = Object.keys(observation).sort().join(",");
		if (
			observationKeys !== "resultDigest" &&
			observationKeys !== "observedIdentity,resultDigest"
		) {
			throw kernelError(
				"invalid_state",
				"journaled effect returned an invalid observation",
			);
		}
		validateKey(observation.resultDigest, "result digest");
		checkpoint(fault, "journal.after_effect");
		assertLock(handle);
		if (validateBeforeResultPublication)
			await validateBeforeResultPublication(observation);
		assertLock(handle);
		const observed = transitionJournalEntry(active, path, intent, {
			phase: "observed",
			resultDigest: observation.resultDigest,
			observedIdentity: observation.observedIdentity ?? null,
			errorCode: null,
			fault,
			scope: "journal_result",
		});
		removePrivateGuard(guardPath, {
			parent: active.paths.operationGuardsDir,
			fault,
			scope: "journal_guard_remove",
		});
		return {
			replayed: false,
			resultDigest: observed.result_digest,
			sequence,
		};
	} catch (error) {
		if (intentDurable) {
			if (guardDurable && !error.finalStateDurable) {
				try {
					assertLock(handle);
					transitionJournalEntry(active, path, intent, {
						phase: "needs_attention",
						resultDigest: null,
						observedIdentity: null,
						errorCode: effectStarted
							? "external_effect_unknown"
							: "intent_unresolved",
						fault,
						scope: "journal_attention",
					});
					removePrivateGuard(guardPath, {
						parent: active.paths.operationGuardsDir,
						fault,
						scope: "journal_guard_remove",
					});
				} catch {
					// The durable guard keeps uncertain state from authorizing replay.
				}
			}
			throw kernelError(
				"recovery_required",
				"journaled operation requires explicit recovery",
				error,
			);
		}
		throw error;
	}
}

export function loadUncertainApplyRun(store, { workspaceId } = {}) {
	const workspace = workspacePaths(store, workspaceId);
	const pointers = scanActivePointers(store, workspace);
	if (pointers.length !== 1)
		throw kernelError(
			"bookkeeping_unknown",
			"apply resolution requires exactly one active pointer",
		);
	const runStates = scanRunStates(store, workspace);
	if (runStates.some(({ activationGuard }) => activationGuard !== null))
		throw kernelError(
			"recovery_required",
			"workspace has an unresolved activation guard",
		);
	const activeStates = runStates.filter(({ state }) => state.status === "active");
	const nonArchived = runStates.filter(({ state }) => state.status !== "archived");
	if (activeStates.length !== 1 || nonArchived.length !== 1)
		throw kernelError(
			"bookkeeping_unknown",
			"active pointer does not have one exclusive non-archived run state",
		);
	const pointer = pointers[0].value;
	const selected = activeStates[0];
	compareRunIdentity(store, workspace, pointer, selected.state);
	const active = {
		store,
		workspace,
		pointer,
		pointerPath: pointers[0].path,
		state: selected.state,
		paths: selected.paths,
		journal: [],
	};
	active.journal = scanJournal(store, active, { allowGuards: true });
	const unresolved = active.journal.filter((entry) => entry.phase !== "observed");
	if (unresolved.length !== 1 || active.journal.at(-1) !== unresolved[0])
		throw kernelError(
			"recovery_required",
			"apply resolution requires exactly one terminal unresolved operation",
		);
	const entry = unresolved[0];
	if (entry.operation_type !== "apply.publish")
		throw kernelError(
			"recovery_required",
			"the unresolved operation is not an apply publication",
		);
	const guards = active.journal.guards;
	if (
		guards.length > 1 ||
		(guards.length === 1 &&
			(guards[0].operation_id !== entry.operation_id ||
				guards[0].sequence !== entry.sequence ||
				guards[0].phase !== "intent"))
	)
		throw kernelError(
			"recovery_required",
			"apply resolution has foreign uncertainty guards",
		);
	if (active.state.journal_head !== entry.entry_digest)
		throw kernelError(
			"bookkeeping_unknown",
			"the uncertain apply publication is not the journal head",
		);
	active.uncertain = entry;
	active.uncertainGuard = guards[0] ?? null;
	return active;
}

export async function resolveUncertainApplyPublication(
	handle,
	{ workspaceId, operationId, resolve, fault } = {},
) {
	assertLock(handle);
	if (typeof resolve !== "function")
		throw kernelError("invalid_state", "apply resolution requires a resolver");
	const active = loadUncertainApplyRun(handle.store, { workspaceId });
	const entry = active.uncertain;
	if (operationId !== undefined && entry.operation_id !== operationId)
		throw kernelError(
			"operation_conflict",
			"apply resolution does not match the uncertain operation",
		);
	const observation = await resolve(entry, active);
	if (
		observation === null ||
		typeof observation !== "object" ||
		Array.isArray(observation) ||
		Object.keys(observation).sort().join(",") !== "observedIdentity,resultDigest"
	)
		throw kernelError(
			"invalid_state",
			"apply resolution returned an invalid observation",
		);
	validateKey(observation.resultDigest, "result digest");
	checkpoint(fault, "resolution.after_observation");
	assertLock(handle);
	const observed = transitionJournalEntry(
		active,
		journalPath(active, entry.sequence, entry.operation_id),
		entry,
		{
			phase: "observed",
			resultDigest: observation.resultDigest,
			observedIdentity: observation.observedIdentity,
			errorCode: null,
			fault,
			scope: "journal_resolution",
		},
	);
	if (active.uncertainGuard)
		removePrivateGuard(
			journalGuardPath(active, entry.sequence, entry.operation_id),
			{
				parent: active.paths.operationGuardsDir,
				fault,
				scope: "journal_resolution_guard_remove",
			},
		);
	return {
		resolved: true,
		resultDigest: observed.result_digest,
		sequence: entry.sequence,
	};
}

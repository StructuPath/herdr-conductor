#!/usr/bin/env node
import { readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import {
	PRIVATE_STATE_VERSION,
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
	journalEntryDigest,
	kernelError,
	lstat,
	loadActiveRun,
	publishExclusiveJson,
	removePrivateGuard,
	sameRepository,
	scanActivePointers,
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
}

function validateOperationSubject(active, operationType, subject) {
	const policy = operationPolicy(operationType);
	if (subject.kind !== policy.subjectKind) {
		throw kernelError(
			"invalid_state",
			"operation subject kind is incompatible with its operation type",
		);
	}
	if (operationType === "run.archive") {
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
	if (policy.prerequisite !== null) {
		const matching = active.journal.filter(
			(entry) =>
				entry.operation_type === policy.prerequisite &&
				entry.phase === "observed" &&
				entry.subject.id === subject.id &&
				entry.subject.generation === subject.generation &&
				entry.observed_identity !== null,
		);
		if (matching.length !== 1) {
			throw kernelError(
				"stale_generation",
				"canonical creation journal subject is missing, duplicate, or stale",
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

function cleanExactArchivePublishTemp(directory, operationId) {
	const escaped = operationId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const pattern = new RegExp(
		`^\\.tmp-(\\d{10}-${escaped}\\.json)-[0-9]+-[a-f0-9]{24}$`,
	);
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const match = pattern.exec(entry.name);
		if (!match) continue;
		if (!entry.isFile())
			throw kernelError("bookkeeping_unknown", "archive temp is not a file");
		const destination = join(directory, match[1]);
		const destinationStats = lstat(destination);
		const tempStats = lstat(join(directory, entry.name));
		if (
			!destinationStats ||
			!tempStats ||
			destinationStats.dev !== tempStats.dev ||
			destinationStats.ino !== tempStats.ino ||
			destinationStats.nlink !== 2n ||
			tempStats.nlink !== 2n
		)
			throw kernelError(
				"bookkeeping_unknown",
				"archive temp identity is ambiguous",
			);
		unlinkSync(join(directory, entry.name));
		fsyncDirectory(directory);
	}
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
	cleanExactArchivePublishTemp(selected.paths.operationsDir, operationId);
	cleanExactArchivePublishTemp(selected.paths.operationGuardsDir, operationId);
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

export function findRecoverableArchive(store, { workspaceId } = {}) {
	const workspace = workspacePaths(store, workspaceId);
	const candidates = [];
	for (const { state } of scanRunStates(store, workspace)) {
		const operationId = `archive-${state.generation.slice(0, 12)}`;
		const candidate = loadArchiveCandidate(store, {
			workspaceId,
			runId: state.run_id,
			runGeneration: state.generation,
			operationId,
		});
		if (
			candidate.entry &&
			(candidate.entry.phase === "intent" ||
				candidate.guard !== null ||
				lstat(candidate.active.pointerPath) !== null)
		)
			candidates.push(candidate);
	}
	if (candidates.length === 0) return null;
	if (candidates.length !== 1)
		throw kernelError(
			"bookkeeping_unknown",
			"archive recovery authority is ambiguous",
		);
	return candidates[0];
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
	let { active, entry, guard } = loaded;
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
		if (entry.phase === "needs_attention")
			throw kernelError(
				"recovery_required",
				"archive has an ambiguous journal result",
			);
		if (
			entry.phase === "intent" &&
			active.state.journal_sequence !== entry.sequence
		) {
			const recoveredIntentHead = {
				...active.state,
				revision: active.state.revision + 1,
				journal_sequence: entry.sequence,
				journal_head: entry.entry_digest,
				updated_at: new Date().toISOString(),
			};
			writeAtomicJson(
				active.paths.statePath,
				recoveredIntentHead,
				validateRunState,
				{
					root: handle.store.stateRoot,
					fault,
					scope: "archive_intent_head_recover",
				},
			);
			active.state = validateRunState(recoveredIntentHead);
		}
		if (entry.phase === "intent" && !guard) {
			publishGuard(active, entry, fault, "archive_guard");
			guard = entry;
			checkpoint(fault, "archive.after_guard_durable");
		}
		if (entry.phase === "observed") {
			if (active.state.status !== "archived" || lstat(active.pointerPath))
				throw kernelError(
					"recovery_required",
					"archive result precedes its state transition",
				);
			if (active.state.journal_head !== entry.entry_digest) {
				const recoveredHead = {
					...active.state,
					revision: active.state.revision + 1,
					journal_head: entry.entry_digest,
					updated_at: new Date().toISOString(),
				};
				writeAtomicJson(
					active.paths.statePath,
					recoveredHead,
					validateRunState,
					{
						root: handle.store.stateRoot,
						fault,
						scope: "archive_result_head_recover",
					},
				);
				active.state = validateRunState(recoveredHead);
			}
			if (guard)
				removePrivateGuard(
					journalGuardPath(active, entry.sequence, operationId),
					{
						parent: active.paths.operationGuardsDir,
						fault,
						scope: "archive_guard",
					},
				);
			return {
				replayed: true,
				resultDigest: entry.result_digest,
				state: active.state,
			};
		}
	} else {
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
		publishIntent(
			active,
			entry,
			fault,
			"archive_intent",
			"archive_intent_head",
		);
		checkpoint(fault, "archive.after_intent_durable");
		publishGuard(active, entry, fault, "archive_guard");
		guard = entry;
		checkpoint(fault, "archive.after_guard_durable");
	}
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
			scope: "archive_guard",
		});
		return {
			replayed: false,
			resultDigest: observed.result_digest,
			state: active.state,
		};
	} catch (error) {
		throw kernelError(
			"recovery_required",
			"archive transition can be retried exactly",
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
		publishGuard(active, intent, fault, "journal_guard");
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
			scope: "journal_guard",
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
						scope: "journal_guard",
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

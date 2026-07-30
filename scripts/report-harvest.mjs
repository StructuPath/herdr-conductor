#!/usr/bin/env node
import { createHash } from "node:crypto";
import { join } from "node:path";
import { canonicalJson, StateKernelError } from "./private-state-schema.mjs";
import {
	reportRejectionDigest,
	validateReport,
	validateReportRejection,
} from "./task-report-schema.mjs";
import { loadAuthoritativeTaskByExactPath } from "./task-authority.mjs";
import { scanRawReportSlot } from "./report-publisher.mjs";
import {
	inspectGateSource,
	inspectProducerSource,
	validateProducerPathPolicy,
} from "./source-policy.mjs";
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
		.update(
			typeof value === "string" || Buffer.isBuffer(value)
				? value
				: canonicalJson(value),
		)
		.digest("hex");
}

function error(code, message, cause) {
	return new StateKernelError(code, message, cause ? { cause } : undefined);
}

function rejectionClass(failure) {
	if (failure?.failureClass) return failure.failureClass;
	if (["foreign_role", "digest_mismatch"].includes(failure?.code))
		return "report_mismatch";
	if (failure?.code === "stale_generation") return "task_stale";
	if (failure?.code === "invalid_contract") return "requirement_contract";
	if (failure?.code === "source_policy_violation")
		return /path|owned|forbidden|changed/i.test(failure.message)
			? "path_policy"
			: "source_dirty";
	if (["stale_source", "foreign_repository"].includes(failure?.code))
		return "source_identity";
	return null;
}

function rejectionIdentity({
	active,
	task,
	raw,
	failureClass,
	validationInputDigest,
	sourceObservation,
}) {
	return validateReportRejection({
		document_type: "herdr-conductor-report-rejection",
		schema_version: 1,
		repository_key: active.state.repository.key,
		workspace_id: active.state.workspace_id,
		run_id: active.state.run_id,
		run_generation: active.state.generation,
		role_name: task.role.name,
		task_id: task.task_id,
		task_generation: task.task_generation,
		task_digest: task.task_digest,
		report_generation: raw.report.report_generation,
		raw_payload_sha256: hash("", raw.payload),
		committed_marker_digest: raw.marker.marker_digest,
		failure_class: failureClass,
		validation_input_digest: validationInputDigest,
		source_observation: sourceObservation ?? null,
	});
}

function observedRetry(active, roleName, reportGeneration = null) {
	const entries = active.journal.filter(
		(entry) =>
			entry.subject.id === roleName &&
			(reportGeneration === null ||
				entry.subject.generation === reportGeneration) &&
			["report.harvest", "report.reject"].includes(entry.operation_type),
	);
	if (entries.length > 1)
		throw error(
			"bookkeeping_unknown",
			"report terminal authority is duplicated",
		);
	if (entries[0]?.phase === "observed")
		return Object.freeze({
			replayed: true,
			disposition:
				entries[0].operation_type === "report.reject"
					? "rejected"
					: "harvested",
			resultDigest: entries[0].result_digest,
		});
	if (entries.length)
		throw error("recovery_required", "report terminal operation is uncertain");
	return null;
}

export async function harvestCommittedReport(
	handle,
	{
		workspaceId,
		runId,
		runGeneration,
		taskPath,
		configurationDigest,
		inspectSource,
		fault,
	} = {},
) {
	const active = loadActiveRun(handle.store, {
		workspaceId,
		expectedRunId: runId,
		expectedGeneration: runGeneration,
	});
	const taskAuthority = loadAuthoritativeTaskByExactPath(
		taskPath,
		handle.store.stateRoot,
		{ active, configurationDigest, requireAttachedAgent: true },
	);
	const task = taskAuthority.task;
	const priorTerminal = observedRetry(active, task.role.name);
	if (priorTerminal) return priorTerminal;
	const raw = scanRawReportSlot(join(task.outbox.root, task.outbox.slot_name), {
		stateRoot: handle.store.stateRoot,
		task,
	});
	if (raw.state !== "raw_committed") {
		if (raw.state === "raw_empty")
			throw error("state_unknown", "no committed report is available");
		throw error("recovery_required", "report publisher inventory is uncertain");
	}
	const retry = observedRetry(
		active,
		task.role.name,
		raw.report.report_generation,
	);
	if (retry) return retry;
	const validationMaterial = {
		task_digest: task.task_digest,
		raw_payload_sha256: hash("", raw.payload),
		committed_marker_digest: raw.marker.marker_digest,
		report_generation: raw.report.report_generation,
		configuration_digest: configurationDigest,
	};
	const validationInputDigest = hash(
		"herdr-conductor/report-validation-input/v1\n",
		validationMaterial,
	);
	let report;
	let sourceResult;
	let validationFailure = raw.taskMismatch
		? error("foreign_role", "committed report identifies another task")
		: null;
	if (!validationFailure) {
		try {
			report = validateReport(raw.report, { task });
			if (typeof inspectSource === "function")
				sourceResult = await inspectSource({ task, report });
			else if (task.source.kind === "role_worktree") {
				sourceResult = inspectProducerSource(
					task.source,
					report.source,
					task.assignment,
					{ reportedPaths: report.changed_paths },
				);
				validateProducerPathPolicy(
					sourceResult.changedPaths,
					report.changed_paths,
					task.assignment,
				);
			} else {
				sourceResult = inspectGateSource(task.source);
				if (report.changed_paths.length !== 0 || report.artifacts.length !== 0)
					throw error(
						"source_policy_violation",
						"gate reports cannot declare changed paths or artifacts",
					);
			}
		} catch (caught) {
			validationFailure = caught;
		}
	}
	if (validationFailure) {
		const failureClass = rejectionClass(validationFailure);
		if (!failureClass) throw validationFailure;
		const sourceObservation =
			validationFailure.sourceObservation ?? sourceResult?.observation ?? null;
		if (
			["source_identity", "source_dirty", "path_policy"].includes(
				failureClass,
			) &&
			sourceObservation === null
		) {
			throw error(
				validationFailure.code ?? "stale_source",
				"source validation did not complete; no rejection intent was published",
				validationFailure,
			);
		}
		const identity = rejectionIdentity({
			active,
			task,
			raw,
			failureClass,
			validationInputDigest,
			sourceObservation,
		});
		const identityDigest = reportRejectionDigest(identity);
		const result = await performJournaledOperation(handle, {
			workspaceId,
			runId,
			runGeneration,
			operationId: `report-reject-${task.role.name}-${raw.report.report_generation}`,
			operationType: "report.reject",
			subject: {
				kind: "report",
				id: task.role.name,
				generation: raw.report.report_generation,
			},
			requestDigest: hash("herdr-conductor/report-reject-request/v1\n", {
				...validationMaterial,
				validation_input_digest: validationInputDigest,
			}),
			fault,
			effect: async () => ({
				resultDigest: identityDigest,
				observedIdentity: identity,
			}),
		});
		return Object.freeze({
			disposition: "rejected",
			failureClass,
			rejectionDigest: identityDigest,
			...result,
		});
	}
	const requestDigest = hash("herdr-conductor/report-harvest-request/v1\n", {
		...validationMaterial,
		report_digest: report.report_digest,
	});
	let acceptedPath;
	const result = await performJournaledOperation(handle, {
		workspaceId,
		runId,
		runGeneration,
		operationId: `report-harvest-${task.role.name}-${report.report_generation}`,
		operationType: "report.harvest",
		subject: {
			kind: "report",
			id: task.role.name,
			generation: report.report_generation,
		},
		requestDigest,
		fault,
		effect: async () => {
			const roleDirectory = ensurePrivateSubdirectory(
				join(active.paths.reportsDir, task.role.name),
				{ root: handle.store.stateRoot, fault },
			);
			const taskDirectory = ensurePrivateSubdirectory(
				join(roleDirectory, task.task_generation),
				{ root: handle.store.stateRoot, fault },
			);
			acceptedPath = join(taskDirectory, `${report.report_generation}.json`);
			publishExclusivePrivateBytes(acceptedPath, raw.payload, {
				root: handle.store.stateRoot,
				maxBytes: 1_048_576,
				fault,
				scope: "report_accept",
			});
			return { resultDigest: report.report_digest };
		},
		validateBeforeResultPublication: async () => {
			const currentRaw = scanRawReportSlot(
				join(task.outbox.root, task.outbox.slot_name),
				{ stateRoot: handle.store.stateRoot, task },
			);
			if (
				currentRaw.state !== "raw_committed" ||
				!currentRaw.payload.equals(raw.payload) ||
				currentRaw.marker.marker_digest !== raw.marker.marker_digest
			)
				throw error(
					"recovery_required",
					"raw report changed before harvest observation",
				);
			if (typeof inspectSource === "function")
				await inspectSource({ task, report });
			else if (task.source.kind === "role_worktree")
				inspectProducerSource(task.source, report.source, task.assignment, {
					reportedPaths: report.changed_paths,
				});
			else inspectGateSource(task.source);
			const acceptedBytes = readStablePrivateBytes(acceptedPath, {
				root: handle.store.stateRoot,
				maxBytes: 1_048_576,
			});
			if (!acceptedBytes.equals(raw.payload))
				throw error(
					"digest_mismatch",
					"accepted report bytes changed before observation",
				);
		},
	});
	return Object.freeze({
		disposition: "harvested",
		reportDigest: report.report_digest,
		sourceResult,
		...result,
	});
}

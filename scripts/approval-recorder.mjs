#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stateRootForConfig } from "./state-root.mjs";
import {
	StateKernelError,
	canonicalJson,
	parseStrictJsonBytes,
	validateStage3ApprovalIdentity,
} from "./private-state-schema.mjs";
import { parseStage2ConfigBytes } from "./task-report-schema.mjs";
import {
	observeStage3ApplyTarget,
	stage3ApplyTargetRef,
} from "./stage3-apply.mjs";
import {
	acquireRepositoryLock,
	inspectRepositoryLock,
	loadActiveRun,
	openRepositoryStore,
	performJournaledOperation,
	releaseRepositoryLock,
} from "./state-kernel.mjs";
import { readBoundedReportInput } from "./report-publisher.mjs";

export const APPROVAL_MAX_BYTES = 16_384;

function fail(code, message, cause) {
	throw new StateKernelError(code, message, cause ? { cause } : undefined);
}

function sha256(value) {
	return createHash("sha256")
		.update(typeof value === "string" ? value : canonicalJson(value))
		.digest("hex");
}

function recorderConfiguration(configPath) {
	const canonicalPath = resolve(configPath);
	const config = parseStage2ConfigBytes(readFileSync(canonicalPath));
	const targetRef = stage3ApplyTargetRef(config);
	if (!targetRef)
		fail(
			"capability_unavailable",
			"configuration does not declare a Stage 3 apply target",
		);
	return Object.freeze({
		configPath: canonicalPath,
		config,
		targetRef,
		configurationDigest: sha256(config),
		stateRoot: stateRootForConfig(config),
		repositoryRoot: dirname(canonicalPath),
	});
}

function refuseDeadRepositoryLock(store) {
	const lock = inspectRepositoryLock(store);
	if (lock.status !== "locked") return;
	try {
		process.kill(lock.owner.pid, 0);
	} catch (error) {
		if (error?.code !== "ESRCH") throw error;
		fail(
			"recovery_required",
			"operation_uncertain: retained dead-process lock requires recovery",
		);
	}
}

function validateRunConfigurationBinding(active, configurationDigest) {
	const bindings = active.journal.filter(
		(entry) =>
			entry.operation_type === "integration.bind" &&
			entry.phase === "observed",
	);
	if (bindings.length !== 1)
		fail("bookkeeping_unknown", "run configuration binding is missing");
	const expected = sha256({
		configuration_digest: configurationDigest,
		integration_target: bindings[0].observed_identity,
	});
	if (bindings[0].request_digest !== expected)
		fail("stale_task", "active run configuration digest changed");
}

function stage3AttemptEntries(active) {
	const observed = (type) =>
		active.journal.filter(
			(entry) => entry.operation_type === type && entry.phase === "observed",
		);
	const previews = observed("apply.preview");
	if (previews.length === 0)
		fail("state_unknown", "run has no previewed apply attempt");
	const previewEntry = previews.at(-1);
	const generation = previewEntry.subject.generation;
	const matching = (type) =>
		observed(type).filter((entry) => entry.subject.generation === generation);
	return {
		generation,
		previewEntry,
		approvalEntries: matching("approval.record"),
		consumptionEntries: matching("approval.consume"),
		publicationEntries: matching("apply.publish"),
	};
}

function requireApprovableAttempt(active, receipt) {
	if (
		active.journal.some(
			(entry) =>
				entry.operation_type === "run.stand-down.begin" &&
				entry.phase === "observed",
		)
	)
		fail("operation_conflict", "run has begun stand-down");
	const attempt = stage3AttemptEntries(active);
	if (receipt.attempt_generation !== attempt.generation)
		fail(
			"stale_task",
			"approval receipt does not name the newest apply attempt",
		);
	if (receipt.preview_entry_digest !== attempt.previewEntry.entry_digest)
		fail(
			"digest_mismatch",
			"approval receipt does not bind the exact preview journal entry",
		);
	if (
		attempt.consumptionEntries.length > 0 ||
		attempt.publicationEntries.length > 0
	)
		fail("operation_conflict", "apply attempt is already consumed");
	if (attempt.approvalEntries.length > 0)
		fail(
			attempt.approvalEntries[0].request_digest === sha256(receipt)
				? "replay_refused"
				: "operation_conflict",
			"apply attempt already has a recorded receipt",
		);
	return attempt;
}

function validateReceiptScope(receipt, store, active) {
	if (
		receipt.repository_key !== store.repository.key ||
		receipt.workspace_id !== active.state.workspace_id ||
		receipt.run_id !== active.state.run_id ||
		receipt.run_generation !== active.state.generation
	)
		fail("foreign_or_stale", "approval receipt names a foreign scope");
}

function requireLivePreview(configuration, previewIdentity, exec) {
	const observed = observeStage3ApplyTarget({
		repository: configuration.repositoryRoot,
		targetRef: previewIdentity.apply.target_ref,
		integration: {
			target_ref: previewIdentity.integration.target_ref,
			starting_sha: previewIdentity.integration.starting_sha,
			final_sha: previewIdentity.integration.final_sha,
		},
		exec,
	});
	if (canonicalJson({ ...observed }) !== canonicalJson(previewIdentity.apply))
		fail(
			"stale_source",
			"previewed apply authority drifted and cannot be approved",
		);
}

function defaultExec(command, args, options = {}) {
	try {
		return execFileSync(command, args, {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
			timeout: 60_000,
			killSignal: "SIGKILL",
			...options,
		}).trim();
	} catch (error) {
		const stderr =
			typeof error?.stderr === "string" ? error.stderr.trim().slice(0, 4096) : "";
		fail(
			"external_operation_failed",
			`${command} ${args.join(" ")} failed${stderr ? `: ${stderr}` : ""}`,
			error,
		);
	}
}

export async function recordApprovalFromStdin({
	configPath,
	input = process.stdin,
	exec = defaultExec,
	fault,
} = {}) {
	const configuration = recorderConfiguration(configPath);
	const bytes = await readBoundedReportInput(input, {
		maxBytes: APPROVAL_MAX_BYTES,
	});
	let receipt;
	try {
		receipt = validateStage3ApprovalIdentity(
			parseStrictJsonBytes(bytes, { maxBytes: APPROVAL_MAX_BYTES }),
			"approval receipt",
		);
	} catch (error) {
		if (error instanceof StateKernelError) throw error;
		fail("invalid_json", "approval receipt is not strict JSON", error);
	}
	if (!bytes.equals(Buffer.from(canonicalJson(receipt))))
		fail("digest_mismatch", "approval receipt must equal its canonical bytes");
	const store = openRepositoryStore({
		stateRoot: configuration.stateRoot,
		repoPath: configuration.repositoryRoot,
	});
	if (join(store.repositoryRoot, ".herdr-conductor.json") !== configuration.configPath)
		fail("path_mismatch", "recorder config path is not the repository config");
	refuseDeadRepositoryLock(store);
	const lock = acquireRepositoryLock(store, {
		operationId: `apply-approve-${receipt.attempt_generation}`,
		fault,
	});
	try {
		const active = loadActiveRun(store, {
			workspaceId: receipt.workspace_id,
			expectedRunId: receipt.run_id,
			expectedGeneration: receipt.run_generation,
		});
		validateReceiptScope(receipt, store, active);
		validateRunConfigurationBinding(active, configuration.configurationDigest);
		const attempt = requireApprovableAttempt(active, receipt);
		const previewIdentity = attempt.previewEntry.observed_identity;
		if (receipt.decision === "approve")
			requireLivePreview(configuration, previewIdentity, exec);
		await performJournaledOperation(lock, {
			workspaceId: receipt.workspace_id,
			runId: active.state.run_id,
			runGeneration: active.state.generation,
			operationId: `apply-approve-${attempt.generation}`,
			operationType: "approval.record",
			subject: {
				kind: "approval",
				id: "apply",
				generation: attempt.generation,
			},
			requestDigest: sha256(receipt),
			fault,
			effect: async () => {
				if (receipt.decision === "approve")
					requireLivePreview(configuration, previewIdentity, exec);
				return { resultDigest: sha256(receipt), observedIdentity: receipt };
			},
		});
		return Object.freeze({
			decision: receipt.decision,
			attemptGeneration: attempt.generation,
			receiptDigest: sha256(receipt),
		});
	} finally {
		releaseRepositoryLock(lock);
	}
}

async function main() {
	const argv = process.argv.slice(2);
	const command = argv[0];
	if (
		command !== "record" ||
		argv[1] !== "--config" ||
		!argv[2] ||
		argv.length !== 3
	) {
		process.stderr.write(
			"usage: approval-recorder.mjs record --config <exact-config-path>\n",
		);
		process.exitCode = 64;
		return;
	}
	const result = await recordApprovalFromStdin({
		configPath: argv[2],
		input: process.stdin,
	});
	process.stdout.write(`${result.decision} ${result.receiptDigest}\n`);
}

if (
	process.argv[1] &&
	resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
	main().catch((error) => {
		process.stderr.write(
			`herdr-conductor: ${error.code ?? "internal_error"}: ${error.message}\n`,
		);
		process.exitCode = 1;
	});

#!/usr/bin/env node
import { createHash, randomBytes } from "node:crypto";
import {
	closeSync,
	constants,
	fsyncSync,
	openSync,
	readFileSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stateRootForConfig } from "./state-root.mjs";
import {
	canonicalJson,
	parseStrictJsonBytes,
	StateKernelError,
} from "./private-state-schema.mjs";
import {
	commitMarkerDigest,
	parseStage2ConfigBytes,
	publishingGuardDigest,
	reportDigest,
	REPORT_MAX_BYTES,
	validateCommitMarker,
	validatePublishingGuard,
	validateReport,
	validateReportDraft,
	validateTask,
} from "./task-report-schema.mjs";
import {
	loadAuthoritativeTaskByExactPath,
	taskPublicationRequestDigest,
} from "./task-authority.mjs";
import {
	acquireRepositoryLock,
	fsyncDirectory,
	inspectRepositoryLock,
	loadActiveRun,
	openRepositoryStore,
	publishExclusivePrivateBytes,
	readStablePrivateBytes,
	releaseRepositoryLock,
	scanExactDirectory,
} from "./state-kernel.mjs";

function fail(code, message, cause) {
	throw new StateKernelError(code, message, cause ? { cause } : undefined);
}

function sha256(bytes) {
	return createHash("sha256").update(bytes).digest("hex");
}

export async function readBoundedReportInput(
	input = process.stdin,
	{ maxBytes = REPORT_MAX_BYTES } = {},
) {
	const chunks = [];
	let length = 0;
	try {
		for await (const chunkValue of input) {
			const chunk = Buffer.isBuffer(chunkValue)
				? chunkValue
				: Buffer.from(chunkValue);
			if (length + chunk.length > maxBytes)
				fail("input_too_large", "report input exceeds 1048576 bytes");
			chunks.push(chunk);
			length += chunk.length;
		}
	} catch (error) {
		if (error instanceof StateKernelError) throw error;
		fail(
			"input_read_error",
			"report input ended with a descriptor or stream error",
			error,
		);
	}
	return Buffer.concat(chunks, length);
}

function authoritativeTask(options) {
	if (typeof options.authorizeTask === "function")
		return options.authorizeTask();
	return loadAuthoritativeTaskByExactPath(options.taskPath, options.stateRoot, {
		active: options.active,
		configurationDigest: options.configurationDigest,
		requireAttachedAgent: true,
	});
}

function parseCanonicalInput(bytes, { draft, task }) {
	let value;
	try {
		value = parseStrictJsonBytes(bytes, { maxBytes: REPORT_MAX_BYTES });
	} catch (error) {
		if (error instanceof StateKernelError) throw error;
		fail("invalid_json", "report input is not strict JSON", error);
	}
	const checked = draft
		? validateReportDraft(value, { task })
		: validateReport(value, { task });
	if (!bytes.equals(Buffer.from(canonicalJson(checked))))
		fail("digest_mismatch", "report input must equal its canonical bytes");
	return checked;
}

export async function digestReportDraftFromStdin(options = {}) {
	const bytes = await readBoundedReportInput(options.input, options);
	const authority = authoritativeTask(options);
	const draft = parseCanonicalInput(bytes, {
		draft: true,
		task: authority.task,
	});
	return `${reportDigest(draft)}\n`;
}

function guardFor(task, report, payloadBytes, publisherNonce) {
	const base = {
		document_type: "herdr-conductor-report-publishing-guard",
		schema_version: 1,
		scope: report.scope,
		task: report.task,
		outbox: {
			id: task.outbox.outbox_id,
			generation: task.outbox.outbox_generation,
			root: task.outbox.root,
			slot_name: task.outbox.slot_name,
		},
		filenames: {
			guard: ".publishing.json",
			staging: `payload.part-${publisherNonce}`,
			payload: "report.json",
			commit: "COMMITTED.json",
		},
		publisher_nonce: publisherNonce,
		report: {
			id: report.report_id,
			generation: report.report_generation,
			digest: report.report_digest,
		},
		payload_byte_length: payloadBytes.length,
		payload_sha256: sha256(payloadBytes),
	};
	return validatePublishingGuard({
		...base,
		guard_digest: publishingGuardDigest(base),
	});
}

function markerFor(guard) {
	const base = {
		document_type: "herdr-conductor-report-committed",
		schema_version: 1,
		scope: guard.scope,
		task: guard.task,
		outbox: guard.outbox,
		filenames: { payload: "report.json", commit: "COMMITTED.json" },
		publisher_nonce: guard.publisher_nonce,
		report: guard.report,
		payload_byte_length: guard.payload_byte_length,
		payload_sha256: guard.payload_sha256,
		publishing_guard_digest: guard.guard_digest,
	};
	return validateCommitMarker({
		...base,
		marker_digest: commitMarkerDigest(base),
	});
}

function publishStaging(path, bytes, stateRoot, fault) {
	let descriptor;
	try {
		fault?.("publisher.before_staging_open");
		descriptor = openSync(
			path,
			constants.O_WRONLY |
				constants.O_CREAT |
				constants.O_EXCL |
				constants.O_NOFOLLOW,
			0o600,
		);
		writeFileSync(descriptor, bytes);
		fault?.("publisher.after_staging_write");
		fsyncSync(descriptor);
		fault?.("publisher.after_staging_fsync");
		closeSync(descriptor);
		descriptor = undefined;
		const observed = readStablePrivateBytes(path, {
			root: stateRoot,
			maxBytes: REPORT_MAX_BYTES,
		});
		if (!observed.equals(bytes))
			fail("digest_mismatch", "publisher staging bytes changed");
	} catch (error) {
		if (descriptor !== undefined) closeSync(descriptor);
		if (error instanceof StateKernelError) throw error;
		fail(
			"durability_unknown",
			"publisher staging publication is uncertain",
			error,
		);
	}
}

export function scanRawReportSlot(
	slotPath,
	{ stateRoot, task, acceptedHistory = false } = {},
) {
	const entries = scanExactDirectory(slotPath, { root: stateRoot });
	const names = entries.map(({ name }) => name);
	if (
		names.some(
			(name) => name === ".publishing.json" || name.startsWith("payload.part-"),
		)
	)
		return Object.freeze({
			state: "publication_uncertain",
			errorCode: "recovery_required",
			entries,
		});
	if (entries.length === 0)
		return Object.freeze({ state: "raw_empty", entries });
	if (
		names.length !== 2 ||
		!names.includes("report.json") ||
		!names.includes("COMMITTED.json")
	)
		return Object.freeze({
			state: "publication_uncertain",
			errorCode: "recovery_required",
			entries,
		});
	try {
		const payloadPath = join(slotPath, "report.json");
		const markerPath = join(slotPath, "COMMITTED.json");
		const payload = readStablePrivateBytes(payloadPath, {
			root: stateRoot,
			maxBytes: REPORT_MAX_BYTES,
		});
		const marker = validateCommitMarker(
			parseStrictJsonBytes(
				readStablePrivateBytes(markerPath, {
					root: stateRoot,
					maxBytes: 16_384,
				}),
				{ maxBytes: 16_384 },
			),
		);
		const report = validateReport(
			parseStrictJsonBytes(payload, { maxBytes: REPORT_MAX_BYTES }),
		);
		if (
			marker.payload_byte_length !== payload.length ||
			marker.payload_sha256 !== sha256(payload) ||
			marker.report.id !== report.report_id ||
			marker.report.generation !== report.report_generation ||
			marker.report.digest !== report.report_digest
		)
			fail(
				"digest_mismatch",
				"committed report marker does not bind the payload",
			);
		const taskMismatch =
			marker.task.id !== task.task_id ||
			marker.task.generation !== task.task_generation ||
			marker.task.digest !== task.task_digest ||
			marker.outbox.id !== task.outbox.outbox_id ||
			marker.outbox.generation !== task.outbox.outbox_generation ||
			marker.outbox.root !== task.outbox.root ||
			marker.outbox.slot_name !== task.outbox.slot_name ||
			report.task.id !== task.task_id ||
			report.task.generation !== task.task_generation ||
			report.task.digest !== task.task_digest;
		return Object.freeze({
			state: acceptedHistory ? "accepted_history" : "raw_committed",
			payload,
			marker,
			report,
			taskMismatch,
			entries,
		});
	} catch (error) {
		return Object.freeze({
			state: "publication_uncertain",
			errorCode: "recovery_required",
			error,
			entries,
		});
	}
}

export async function publishReportFromStdin(options = {}) {
	const inputBytes = await readBoundedReportInput(options.input, options);
	const authority = authoritativeTask(options);
	const report = parseCanonicalInput(inputBytes, {
		draft: false,
		task: authority.task,
	});
	const payloadBytes = Buffer.from(canonicalJson(report));
	if (payloadBytes.length > REPORT_MAX_BYTES)
		fail("input_too_large", "canonical report exceeds its maximum size");
	const slotPath = join(
		authority.task.outbox.root,
		authority.task.outbox.slot_name,
	);
	if (resolve(slotPath) !== slotPath)
		fail("path_mismatch", "derived report slot is not canonical");
	const nonce = (options.random ?? randomBytes)(16).toString("hex");
	const guard = guardFor(authority.task, report, payloadBytes, nonce);
	const marker = markerFor(guard);
	const existing = scanRawReportSlot(slotPath, {
		stateRoot: options.stateRoot,
		task: authority.task,
	});
	if (existing.state === "raw_committed")
		fail("replay_refused", "report slot is already committed");
	if (existing.state !== "raw_empty")
		fail(
			"recovery_required",
			"report slot contains uncertain publication residue",
		);
	const guardPath = join(slotPath, ".publishing.json");
	const stagingPath = join(slotPath, guard.filenames.staging);
	const payloadPath = join(slotPath, "report.json");
	const markerPath = join(slotPath, "COMMITTED.json");
	publishExclusivePrivateBytes(guardPath, Buffer.from(canonicalJson(guard)), {
		root: options.stateRoot,
		maxBytes: 16_384,
		fault: options.fault,
		scope: "publisher_guard",
	});
	publishStaging(stagingPath, payloadBytes, options.stateRoot, options.fault);
	publishExclusivePrivateBytes(payloadPath, payloadBytes, {
		root: options.stateRoot,
		maxBytes: REPORT_MAX_BYTES,
		fault: options.fault,
		scope: "publisher_payload",
	});
	fsyncDirectory(slotPath);
	publishExclusivePrivateBytes(markerPath, Buffer.from(canonicalJson(marker)), {
		root: options.stateRoot,
		maxBytes: 16_384,
		fault: options.fault,
		scope: "publisher_marker",
	});
	fsyncDirectory(slotPath);
	unlinkSync(stagingPath);
	fsyncDirectory(slotPath);
	options.fault?.("publisher.after_staging_unlink");
	unlinkSync(guardPath);
	fsyncDirectory(slotPath);
	options.fault?.("publisher.after_guard_unlink");
	const committed = scanRawReportSlot(slotPath, {
		stateRoot: options.stateRoot,
		task: authority.task,
	});
	if (committed.state !== "raw_committed")
		fail("durability_unknown", "committed report could not be revalidated");
	return Object.freeze({
		reportDigest: report.report_digest,
		markerDigest: marker.marker_digest,
		slotPath,
	});
}

function cliConfiguration(configPath) {
	const canonicalPath = resolve(configPath);
	const config = parseStage2ConfigBytes(readFileSync(canonicalPath));
	return Object.freeze({
		configPath: canonicalPath,
		configurationDigest: sha256(Buffer.from(canonicalJson(config))),
		stateRoot: stateRootForConfig(config),
	});
}

function cliTaskStore(taskPath, configuration) {
	const bytes = readStablePrivateBytes(resolve(taskPath), {
		root: configuration.stateRoot,
		maxBytes: 262_144,
	});
	const task = validateTask(parseStrictJsonBytes(bytes, { maxBytes: 262_144 }));
	if (
		configuration.configPath !==
		join(task.scope.repository_root, ".herdr-conductor.json")
	)
		fail(
			"path_mismatch",
			"publisher config path is not task repository config",
		);
	const store = openRepositoryStore({
		stateRoot: configuration.stateRoot,
		repoPath: task.scope.repository_root,
	});
	return { store, task };
}

function cliAuthority(taskPath, configuration, expectedStore = null) {
	const { store, task } = cliTaskStore(taskPath, configuration);
	if (
		expectedStore &&
		(store.repository.key !== expectedStore.repository.key ||
			store.repositoryRoot !== expectedStore.repositoryRoot)
	)
		fail("foreign_repository", "task repository changed during publication");
	const active = loadActiveRun(store, {
		workspaceId: task.scope.workspace_id,
		expectedRunId: task.scope.run_id,
		expectedGeneration: task.scope.run_generation,
	});
	const requestDigest = taskPublicationRequestDigest(
		task,
		resolve(taskPath),
		configuration.configurationDigest,
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
		fail("bookkeeping_unknown", "task publication authority is missing");
	const agents = active.journal.filter(
		(entry) =>
			entry.operation_type === "agent.start" &&
			entry.phase === "observed" &&
			entry.subject.id === task.role.name &&
			entry.subject.generation === task.role.agent_generation,
	);
	if (agents.length !== 1)
		fail("foreign_role", "task does not have one attached observed agent");
	return Object.freeze({
		store,
		task,
		taskPath: resolve(taskPath),
		publication: publications[0],
	});
}

export async function publishReportFromCliStdin({
	taskPath,
	configPath,
	input = process.stdin,
	random,
	fault,
} = {}) {
	const configuration = cliConfiguration(configPath);
	const initial = cliAuthority(taskPath, configuration);
	const initialSlot = scanRawReportSlot(
		join(initial.task.outbox.root, initial.task.outbox.slot_name),
		{ stateRoot: configuration.stateRoot, task: initial.task },
	);
	const operationId = `report-publish-${initial.task.role.name}-${initial.task.task_generation}`;
	const existingLock = inspectRepositoryLock(initial.store);
	let stalePublisherLock = false;
	if (
		existingLock.status === "locked" &&
		existingLock.owner.operation_id === operationId
	) {
		try {
			process.kill(existingLock.owner.pid, 0);
		} catch (error) {
			if (error?.code === "ESRCH") stalePublisherLock = true;
			else throw error;
		}
	}
	if (initialSlot.state === "publication_uncertain" || stalePublisherLock)
		fail(
			"recovery_required",
			"publication_uncertain: retained publisher authority requires recovery",
		);
	const lock = acquireRepositoryLock(initial.store, {
		operationId,
		fault,
	});
	try {
		return await publishReportFromStdin({
			input,
			stateRoot: configuration.stateRoot,
			random,
			fault,
			authorizeTask: () => cliAuthority(taskPath, configuration, initial.store),
		});
	} finally {
		releaseRepositoryLock(lock);
	}
}

async function main() {
	const [command, configFlag, configPath, taskFlag, taskPath] =
		process.argv.slice(2);
	if (
		!["digest", "publish"].includes(command) ||
		configFlag !== "--config" ||
		!configPath ||
		taskFlag !== "--task" ||
		!taskPath ||
		process.argv.length !== 7
	) {
		process.stderr.write(
			"usage: report-publisher.mjs digest|publish --config <exact-config-path> --task <exact-task-path>\n",
		);
		process.exitCode = 64;
		return;
	}
	const configuration = cliConfiguration(configPath);
	const authorizeTask = () => cliAuthority(taskPath, configuration);
	if (command === "digest")
		process.stdout.write(
			await digestReportDraftFromStdin({
				input: process.stdin,
				stateRoot: configuration.stateRoot,
				authorizeTask,
			}),
		);
	else {
		const result = await publishReportFromCliStdin({
			taskPath,
			configPath,
			input: process.stdin,
		});
		process.stdout.write(`${result.reportDigest}\n`);
	}
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

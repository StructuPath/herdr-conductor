import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
	lstatSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { reconcile } from "../scripts/stage1-runtime.mjs";
import {
	canonicalJson,
	StateKernelError,
} from "../scripts/private-state-schema.mjs";
import { publishReportFromStdin } from "../scripts/report-publisher.mjs";
import { reportDigest } from "../scripts/task-report-schema.mjs";
import {
	assembledFixture,
	buildWorkerReport,
	context,
	deterministicRandom,
	git,
	privateDocuments,
	publishWorkerReport,
} from "./stage1-runtime-helpers.mjs";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function linkedWorktreeSnapshot(repository) {
	const worktreeList = git(repository, "worktree", "list", "--porcelain");
	const paths = worktreeList
		.split("\n")
		.filter((line) => line.startsWith("worktree "))
		.map((line) => line.slice("worktree ".length))
		.sort();
	return {
		worktreeList,
		worktrees: paths.map((worktree) => {
			const tracked = git(worktree, "ls-files").split("\n").filter(Boolean);
			const untracked = git(
				worktree,
				"ls-files",
				"--others",
				"--exclude-standard",
			)
				.split("\n")
				.filter(Boolean);
			const ignored = git(
				worktree,
				"ls-files",
				"--others",
				"--ignored",
				"--exclude-standard",
			)
				.split("\n")
				.filter(Boolean);
			const observe = (path) => {
				const absolute = join(worktree, path);
				const stats = lstatSync(absolute);
				return {
					path,
					kind: stats.isDirectory() ? "directory" : "file",
					mode: Number(stats.mode & 0o7777),
					content: stats.isDirectory() ? null : sha256(readFileSync(absolute)),
				};
			};
			return {
				path: worktree,
				head: git(worktree, "rev-parse", "HEAD"),
				ref: git(worktree, "rev-parse", "--abbrev-ref", "HEAD"),
				indexTree: git(worktree, "write-tree"),
				indexStages: git(worktree, "ls-files", "--stage"),
				trackedStatus: git(
					worktree,
					"status",
					"--porcelain=v1",
					"--untracked-files=no",
				),
				rootMode: Number(lstatSync(worktree).mode & 0o7777),
				adminMode: Number(lstatSync(join(worktree, ".git")).mode & 0o7777),
				tracked: tracked.map(observe),
				untracked: untracked.map(observe),
				ignored: ignored.map(observe),
			};
		}),
	};
}

function forbiddenEffectSnapshot(fixture) {
	const documents = privateDocuments(fixture.stateRoot);
	const log = fixture.fake.log;
	const gitState = linkedWorktreeSnapshot(fixture.repository);
	return {
		targetHead: git(fixture.repository, "rev-parse", "HEAD"),
		targetStatus: git(
			fixture.repository,
			"status",
			"--porcelain=v1",
			"--untracked-files=all",
		),
		linkedWorktreeSources: gitState,
		branches: git(
			fixture.repository,
			"for-each-ref",
			"--format=%(refname):%(objectname)",
			"refs/heads",
		),
		worktrees: gitState.worktreeList,
		stateAuthorityBytes: documents.map(({ path }) => [
			path,
			sha256(readFileSync(path)),
		]),
		taskBytes: documents
			.filter(({ path }) => path.includes("/contracts/tasks/"))
			.map(({ path }) => [path, sha256(readFileSync(path))]),
		rawOutboxBytes: documents
			.filter(
				({ path }) =>
					path.endsWith("/report.json") || path.endsWith("/COMMITTED.json"),
			)
			.map(({ path }) => [path, sha256(readFileSync(path))]),
		acceptedReports: documents.filter(({ path }) =>
			path.includes("/contracts/reports/"),
		).length,
		reportRejections: documents.filter(
			({ value }) => value.operation_type === "report.reject",
		).length,
		journalAuthority: documents.filter(
			({ value }) => value.document_type === "herdr-conductor-operation",
		).length,
		targetCas: log.filter(
			({ args }) => args[2] === "update-ref" || args[4] === "update-ref",
		).length,
		gateCreates: documents.filter(
			({ value }) => value.operation_type === "gate-source.create",
		).length,
		paneCreates: log.filter(
			({ args }) => args[0] === "pane" && args[1] === "split",
		).length,
		agentStarts: log.filter(
			({ args }) => args[0] === "agent" && args[1] === "start",
		).length,
		paneCloses: log.filter(
			({ args }) => args[0] === "pane" && args[1] === "close",
		).length,
		archives: documents.filter(
			({ value }) => value.operation_type === "run.archive",
		).length,
		targetSyncOrReset: log.filter(({ args }) =>
			args.some((value) =>
				["read-tree", "reset", "checkout", "restore"].includes(value),
			),
		).length,
		branchRemovals: log.filter(({ args }) =>
			args.some((value) => value === "-d" || value === "-D"),
		).length,
		worktreeRemovals: log.filter(
			({ args }) => args[2] === "worktree" && args[3] === "remove",
		).length,
		prunes: log.filter(({ args }) => args.includes("prune")).length,
		approvalConsume: documents.filter(({ value }) =>
			/approval.*consum/.test(value.operation_type ?? ""),
		).length,
		externalApply: documents.filter(({ value }) =>
			/apply/.test(value.operation_type ?? ""),
		).length,
		outOfRootDeletes: log.filter(
			({ command, args }) =>
				["rm", "unlink"].includes(command) || args.includes("rm"),
		).length,
	};
}

const roles = [
	{
		name: "builder",
		contract_role: "builder",
		kind: "codex",
		mode: "write",
	},
];

test("every normative error and action seam preserves its exact full forbidden-effect contract", async () => {
	const injectedCodes = [
		"state_unknown",
		"foreign_repository",
		"foreign_workspace",
		"foreign_run",
		"foreign_generation",
		"stale_source",
		"source_policy_violation",
		"path_mismatch",
		"lock_unknown",
		"durability_unknown",
		"capability_unavailable",
		"target_drift",
		"gate_timing",
	];
	const rows = [
		{
			name: "malformed JSON",
			code: "invalid_json",
			input: () => Readable.from([Buffer.from("{")]),
		},
		{
			name: "duplicate JSON key",
			code: "duplicate_json_key",
			input: ({ report }) =>
				Readable.from([
					Buffer.from(
						canonicalJson(report).replace(
							"{",
							'{"document_type":"herdr-conductor-report",',
						),
					),
				]),
		},
		{
			name: "input read error",
			code: "input_read_error",
			input: () =>
				new Readable({
					read() {
						this.destroy(new Error("bounded input failure"));
					},
				}),
		},
		{
			name: "wrong version",
			code: "wrong_version",
			input: ({ report }) =>
				Readable.from([
					Buffer.from(canonicalJson({ ...report, schema_version: 2 })),
				]),
		},
		{
			name: "invalid UTF-8",
			code: "invalid_json",
			input: () => Readable.from([Buffer.from([0xc3])]),
		},
		{
			name: "noncanonical framing",
			code: "digest_mismatch",
			input: ({ report }) =>
				Readable.from([Buffer.from(JSON.stringify(report))]),
		},
		{
			name: "wrong report digest",
			code: "digest_mismatch",
			input: ({ report }) =>
				Readable.from([
					Buffer.from(
						canonicalJson({ ...report, report_digest: "0".repeat(64) }),
					),
				]),
		},
		{
			name: "foreign task scope",
			code: "foreign_role",
			input: ({ report }) => {
				const changed = {
					...report,
					scope: { ...report.scope, workspace_id: "foreign-workspace" },
				};
				delete changed.report_digest;
				changed.report_digest = reportDigest(changed);
				return Readable.from([Buffer.from(canonicalJson(changed))]);
			},
		},
		{
			name: "stale task generation",
			code: "foreign_role",
			input: ({ report }) => {
				const changed = {
					...report,
					task: { ...report.task, generation: "f".repeat(32) },
				};
				delete changed.report_digest;
				changed.report_digest = reportDigest(changed);
				return Readable.from([Buffer.from(canonicalJson(changed))]);
			},
		},
		{
			name: "oversized framing",
			code: "input_too_large",
			input: () => Readable.from([Buffer.alloc(1_048_577, 0x61)]),
		},
		{
			name: "replayed report",
			code: "replay_refused",
			prepare: async ({ fixture, value }) =>
				publishReportFromStdin({
					input: Readable.from([Buffer.from(canonicalJson(value.report))]),
					stateRoot: fixture.stateRoot,
					authorizeTask: () => ({ task: value.task }),
				}),
			input: ({ report }) =>
				Readable.from([Buffer.from(canonicalJson(report))]),
		},
		{
			name: "equivocal report",
			code: "equivocal_report",
			prepare: async ({ fixture, value }) =>
				publishReportFromStdin({
					input: Readable.from([Buffer.from(canonicalJson(value.report))]),
					stateRoot: fixture.stateRoot,
					authorizeTask: () => ({ task: value.task }),
				}),
			input: ({ report }) => {
				const changed = { ...report, summary: "Equivocal replay" };
				delete changed.report_digest;
				changed.report_digest = reportDigest(changed);
				return Readable.from([Buffer.from(canonicalJson(changed))]);
			},
		},
		...injectedCodes.map((code) => ({
			name: code,
			code,
			input: ({ report }) =>
				Readable.from([Buffer.from(canonicalJson(report))]),
			inject: true,
		})),
	];
	for (const row of rows) {
		const fixture = await assembledFixture({ roles });
		const worker = fixture.result.workers[0];
		const value = await buildWorkerReport(fixture, worker);
		await row.prepare?.({ fixture, worker, value });
		const before = forbiddenEffectSnapshot(fixture);
		const outboxBefore = readdirSync(worker.outbox_slot).sort();
		await assert.rejects(
			publishReportFromStdin({
				input: row.input(value),
				stateRoot: fixture.stateRoot,
				authorizeTask: row.inject
					? () => {
							throw new StateKernelError(row.code, `${row.name} fixture`);
						}
					: () => ({ task: value.task }),
			}),
			(error) => error.code === row.code,
			row.name,
		);
		assert.deepEqual(forbiddenEffectSnapshot(fixture), before, row.name);
		assert.deepEqual(
			readdirSync(worker.outbox_slot).sort(),
			outboxBefore,
			row.name,
		);
	}

	for (const row of [
		{
			name: "producer HEAD/tree drift",
			code: "stale_source",
			rejectionClass: "source_identity",
			mutate(worker) {
				writeFileSync(
					join(worker.cwd, "src", "drift.mjs"),
					"export default 2;\n",
				);
				git(worker.cwd, "add", "src/drift.mjs");
				git(worker.cwd, "commit", "-qm", "late head and tree drift");
			},
		},
		{
			name: "producer ref drift",
			code: "stale_source",
			throws: true,
			mutate(worker) {
				git(worker.cwd, "branch", "-m", "late-ref-drift");
			},
		},
		{
			name: "producer index drift",
			code: "source_policy_violation",
			rejectionClass: "source_dirty",
			mutate(worker) {
				writeFileSync(
					join(worker.cwd, "src", "drift.mjs"),
					"export default 3;\n",
				);
				git(worker.cwd, "add", "src/drift.mjs");
			},
		},
		{
			name: "producer tracked-byte drift",
			code: "source_policy_violation",
			rejectionClass: "source_dirty",
			mutate(worker) {
				writeFileSync(
					join(worker.cwd, "src", "drift.mjs"),
					"export default 4;\n",
				);
			},
		},
		{
			name: "producer untracked drift",
			code: "source_policy_violation",
			rejectionClass: "source_dirty",
			mutate(worker) {
				writeFileSync(join(worker.cwd, "late-untracked.txt"), "late\n");
			},
		},
		{
			name: "producer ignored drift",
			code: "source_policy_violation",
			rejectionClass: "source_dirty",
			mutate(worker) {
				mkdirSync(join(worker.cwd, ".ignored"));
				writeFileSync(join(worker.cwd, ".ignored", "late.txt"), "late\n");
			},
		},
	]) {
		const fixture = await assembledFixture({ roles });
		const worker = fixture.result.workers[0];
		writeFileSync(join(worker.cwd, ".gitignore"), ".ignored/\n");
		mkdirSync(join(worker.cwd, "src"));
		writeFileSync(join(worker.cwd, "src", "drift.mjs"), "export default 1;\n");
		git(worker.cwd, "add", ".gitignore", "src/drift.mjs");
		git(worker.cwd, "commit", "-qm", "source drift fixture");
		await publishWorkerReport(fixture, worker);
		row.mutate(worker);
		const before = forbiddenEffectSnapshot(fixture);
		const reconcileOptions = {
			contextJson: context(fixture.repository, fixture.workspace),
			exec: fixture.fake.exec,
			herdrBin: "fake",
		};
		if (row.throws) {
			await assert.rejects(
				reconcile(reconcileOptions),
				(error) => error.code === row.code,
				row.name,
			);
			assert.deepEqual(forbiddenEffectSnapshot(fixture), before, row.name);
			continue;
		}
		const result = await reconcile(reconcileOptions);
		assert.equal(result.lifecycle, "delivery_report_rejected", row.name);
		const rejection = privateDocuments(fixture.stateRoot).find(
			({ value }) =>
				value.operation_type === "report.reject" && value.phase === "observed",
		);
		assert.equal(
			rejection.value.observed_identity.failure_class,
			row.rejectionClass,
			`${row.name}: exact ${row.code} rejection class`,
		);
		const after = forbiddenEffectSnapshot(fixture);
		assert.equal(after.reportRejections, before.reportRejections + 1, row.name);
		assert.equal(after.journalAuthority, before.journalAuthority + 1, row.name);
		const {
			stateAuthorityBytes: _beforeState,
			reportRejections: _beforeRejections,
			journalAuthority: _beforeJournal,
			...beforeEffects
		} = before;
		const {
			stateAuthorityBytes: _afterState,
			reportRejections: _afterRejections,
			journalAuthority: _afterJournal,
			...afterEffects
		} = after;
		assert.deepEqual(afterEffects, beforeEffects, row.name);
	}
});

test("raw payload, marker, and barrier replacement residue blocks every independent effect", async () => {
	for (const [name, mutate] of [
		[
			"raw replacement",
			(slot) => writeFileSync(join(slot, "report.json"), "{}\n"),
		],
		[
			"marker replacement",
			(slot) => writeFileSync(join(slot, "COMMITTED.json"), "{}\n"),
		],
		[
			"barrier collision",
			(slot) => writeFileSync(join(slot, ".publishing.json"), "{}\n"),
		],
	]) {
		const fixture = await assembledFixture({ roles });
		const worker = fixture.result.workers[0];
		mkdirSync(join(worker.cwd, "src"));
		writeFileSync(join(worker.cwd, "src", "raw.mjs"), "export default 1;\n");
		git(worker.cwd, "add", "src/raw.mjs");
		git(worker.cwd, "commit", "-qm", "raw replacement fixture");
		await publishWorkerReport(fixture, worker);
		mutate(worker.outbox_slot);
		const before = forbiddenEffectSnapshot(fixture);
		await assert.rejects(
			reconcile({
				contextJson: context(fixture.repository, fixture.workspace),
				exec: fixture.fake.exec,
				herdrBin: "fake",
			}),
			(error) => error.code === "recovery_required",
			name,
		);
		assert.deepEqual(forbiddenEffectSnapshot(fixture), before, name);
	}
});

test("deterministic path rejection creates no accepted report, target CAS, gate, or pane-close effect", async () => {
	const fixture = await assembledFixture({ roles });
	const worker = fixture.result.workers[0];
	mkdirSync(join(worker.cwd, "src"));
	writeFileSync(join(worker.cwd, "src", "owned.mjs"), "export default 1;\n");
	git(worker.cwd, "add", "src/owned.mjs");
	git(worker.cwd, "commit", "-qm", "owned change");
	await publishWorkerReport(fixture, worker, { changed_paths: [] });
	const target = git(fixture.repository, "rev-parse", "HEAD");
	const paneEffects = fixture.fake.effects;
	const forbiddenBefore = forbiddenEffectSnapshot(fixture);
	const result = await reconcile({
		contextJson: context(fixture.repository, fixture.workspace),
		stateRoot: fixture.stateRoot,
		exec: fixture.fake.exec,
		herdrBin: "fake",
		random: deterministicRandom(180),
	});
	assert.equal(result.lifecycle, "delivery_report_rejected");
	assert.equal(git(fixture.repository, "rev-parse", "HEAD"), target);
	assert.equal(fixture.fake.effects, paneEffects);
	const forbiddenAfter = forbiddenEffectSnapshot(fixture);
	assert.equal(
		forbiddenAfter.reportRejections,
		forbiddenBefore.reportRejections + 1,
	);
	assert.equal(
		forbiddenAfter.journalAuthority,
		forbiddenBefore.journalAuthority + 1,
	);
	const {
		stateAuthorityBytes: _beforeState,
		reportRejections: _beforeRejections,
		journalAuthority: _beforeJournal,
		...beforeEffects
	} = forbiddenBefore;
	const {
		stateAuthorityBytes: _afterState,
		reportRejections: _afterRejections,
		journalAuthority: _afterJournal,
		...afterEffects
	} = forbiddenAfter;
	assert.deepEqual(afterEffects, beforeEffects);
	assert.equal(
		privateDocuments(fixture.stateRoot).filter(({ path }) =>
			path.includes("/contracts/reports/"),
		).length,
		0,
	);
	assert.deepEqual(readdirSync(worker.outbox_slot).sort(), [
		"COMMITTED.json",
		"report.json",
	]);
	assert.ok(readFileSync(join(worker.outbox_slot, "report.json")).length > 0);
});

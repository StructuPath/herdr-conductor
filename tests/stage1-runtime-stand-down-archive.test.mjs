import { test } from "node:test";
import { createHash } from "node:crypto";
import { canonicalJson } from "../scripts/private-state-schema.mjs";
import {
	archivedStandDownReplay,
	deriveRetainedReportAuthority,
} from "../scripts/stage1-runtime.mjs";
import { loadArchivedRun } from "../scripts/state-kernel.mjs";
import { reportDigest, taskDigest } from "../scripts/task-report-schema.mjs";
import {
	assert,
	existsSync,
	mkdirSync,
	rmSync,
	writeFileSync,
	dirname,
	join,
	assemble,
	reconcile,
	readStatus,
	standDown,
	temp,
	repo,
	privateStateRoot,
	openRepositoryStore,
	context,
	config,
	deterministicRandom,
	FakeHerdr,
	readJournals,
	privateDocuments,
	snapshotTree,
	gitInventory,
	git,
	publishWorkerReport,
	assembledFixture,
} from "./stage1-runtime-helpers.mjs";

test("B3 pane tuple mismatches and duplicate live resources close zero panes", async () => {
	const cases = [
		[
			"pane workspace_id",
			(fake, worker) => {
				fake.panes.get(worker.pane_id).workspace_id = "wForeign";
			},
		],
		[
			"agent workspace_id",
			(fake, worker) => {
				fake.agents.get(worker.agent_name).workspace_id = "wForeign";
			},
		],
		[
			"pane pane_id",
			(fake, worker) => {
				fake.panes.get(worker.pane_id).pane_id = "wB2:foreign";
			},
		],
		[
			"agent pane_id",
			(fake, worker) => {
				fake.agents.get(worker.agent_name).pane_id = "wB2:foreign";
			},
		],
		[
			"terminal",
			(fake, worker) => {
				fake.panes.get(worker.pane_id).terminal_id = "foreign";
			},
		],
		[
			"agent kind",
			(fake, worker) => {
				fake.agents.get(worker.agent_name).agent_session.agent = "claude";
			},
		],
		[
			"session",
			(fake, worker) => {
				fake.agents.get(worker.agent_name).agent_session.value = "/foreign";
			},
		],
		[
			"name",
			(fake, worker) => {
				fake.agents.get(worker.agent_name).name = "foreign";
			},
		],
		[
			"cwd",
			(fake, worker) => {
				fake.agents.get(worker.agent_name).cwd = temp("foreign-cwd-");
			},
		],
		[
			"foreground cwd",
			(fake, worker) => {
				fake.panes.get(worker.pane_id).foreground_cwd = temp(
					"foreign-foreground-cwd-",
				);
			},
		],
		[
			"run",
			(fake, worker) => {
				fake.panes.get(worker.pane_id).tokens.conductor_run_id = "r-foreign";
			},
		],
		[
			"generation",
			(fake, worker) => {
				fake.agents.get(worker.agent_name).tokens.conductor_generation =
					"f".repeat(32);
			},
		],
		[
			"duplicate pane",
			(fake, worker) => {
				fake.panes.set("duplicate", { ...fake.panes.get(worker.pane_id) });
			},
		],
		[
			"duplicate agent",
			(fake, worker) => {
				fake.agents.set("duplicate", { ...fake.agents.get(worker.agent_name) });
			},
		],
	];
	for (const [name, mutate] of cases) {
		const fixture = await assembledFixture();
		const worker = fixture.result.workers[0];
		mutate(fixture.fake, worker);
		const closeBefore = fixture.fake.log.filter(
			({ args }) => args[0] === "pane" && args[1] === "close",
		).length;
		await assert.rejects(
			() =>
				standDown({
					contextJson: context(fixture.repository, fixture.workspace),
					stateRoot: fixture.stateRoot,
					herdrBin: "fake",
					exec: fixture.fake.exec,
				}),
			name,
		);
		assert.equal(
			fixture.fake.log.filter(
				({ args }) => args[0] === "pane" && args[1] === "close",
			).length,
			closeBefore,
			name,
		);
	}
});

test("stand-down closes a producer pane observed before agent intent", async () => {
	const repository = repo();
	const stateRoot = privateStateRoot();
	const fake = new FakeHerdr();
	await assert.rejects(() =>
		assemble({
			contextJson: context(repository),
			configPath: config(
				repository,
				[{ name: "builder", kind: "pi", mode: "write" }],
				{},
				stateRoot,
			),
			exec: fake.exec,
			herdrBin: "fake",
			random: deterministicRandom(),
			fault(name) {
				if (name === "producer.after_pane_observed")
					throw new Error("crash before agent intent");
			},
		}),
	);
	assert.equal(fake.panes.size, 1);
	assert.equal(fake.agents.size, 0);
	const result = await standDown({
		contextJson: context(repository),
		herdrBin: "fake",
		exec: fake.exec,
	});
	assert.equal(result.archived, true);
	assert.equal(result.closed.length, 1);
	assert.equal(fake.panes.size, 0);
});

test("successful stand-down exposes the verified archived terminal through status", async () => {
	const fixture = await assembledFixture();
	const archived = await standDown({
		contextJson: context(fixture.repository, fixture.workspace),
		herdrBin: "fake",
		exec: fixture.fake.exec,
	});
	assert.equal(archived.archived, true);
	const authorityBytes = canonicalJson(privateDocuments(fixture.stateRoot));
	const effects = fixture.fake.effects;
	const replay = await standDown({
		contextJson: context(fixture.repository, fixture.workspace),
		herdrBin: "fake",
		exec: fixture.fake.exec,
		reason: "operator_abandoned",
	});
	assert.deepEqual(replay.closed, archived.closed);
	assert.equal(replay.replayed, true);
	for (const conflictingReason of ["missing_report", "not_a_valid_reason"])
		await assert.rejects(
			() =>
				standDown({
					contextJson: context(fixture.repository, fixture.workspace),
					herdrBin: "fake",
					exec: fixture.fake.exec,
					reason: conflictingReason,
				}),
			(error) => error.code === "operation_conflict",
		);
	assert.equal(
		canonicalJson(privateDocuments(fixture.stateRoot)),
		authorityBytes,
	);
	assert.equal(fixture.fake.effects, effects);
	const status = readStatus({
		contextJson: context(fixture.repository, fixture.workspace),
		herdrBin: "fake",
		exec: fixture.fake.exec,
	});
	assert.equal(status.lifecycle, "archived");
	assert.equal(status.archived, true);
	assert.deepEqual(status.legal_next_operations, ["status"]);
	assert.deepEqual(status.workers, []);
});

test("status and stand-down require every published task before and after archive", async () => {
	for (const archived of [false, true]) {
		const fixture = await assembledFixture();
		if (archived)
			await standDown({
				contextJson: context(fixture.repository, fixture.workspace),
				herdrBin: "fake",
				exec: fixture.fake.exec,
				reason: "operator_abandoned",
			});
		rmSync(fixture.result.workers[0].task_path);
		const authorityBytes = canonicalJson(privateDocuments(fixture.stateRoot));
		const effects = fixture.fake.effects;
		assert.throws(
			() =>
				readStatus({
					contextJson: context(fixture.repository, fixture.workspace),
					herdrBin: "fake",
					exec: fixture.fake.exec,
				}),
			(error) => error.code === "bookkeeping_unknown",
		);
		await assert.rejects(
			() =>
				standDown({
					contextJson: context(fixture.repository, fixture.workspace),
					herdrBin: "fake",
					exec: fixture.fake.exec,
					reason: "operator_abandoned",
				}),
			(error) => error.code === "bookkeeping_unknown",
		);
		assert.equal(
			canonicalJson(privateDocuments(fixture.stateRoot)),
			authorityBytes,
		);
		assert.equal(fixture.fake.effects, effects);
	}
});

test("archived replay rejects every terminal authority mutation without effects", async () => {
	const fixture = await assembledFixture({
		roles: [
			{ name: "builder-a", kind: "codex", mode: "write" },
			{ name: "builder-b", kind: "codex", mode: "write" },
		],
	});
	await standDown({
		contextJson: context(fixture.repository, fixture.workspace),
		herdrBin: "fake",
		exec: fixture.fake.exec,
	});
	const archived = loadArchivedRun(
		openRepositoryStore({
			stateRoot: fixture.stateRoot,
			repoPath: fixture.repository,
		}),
		{ workspaceId: fixture.workspace },
	);
	const digest = (value) =>
		createHash("sha256").update(canonicalJson(value)).digest("hex");
	const standDownEntry = (value) =>
		value.journal.find(
			(entry) => entry.operation_type === "run.stand-down.begin",
		);
	const archiveEntry = (value) =>
		value.journal.find((entry) => entry.operation_type === "run.archive");
	const redigestIdentity = (value) => {
		const entry = standDownEntry(value);
		entry.request_digest = digest(entry.observed_identity);
		entry.result_digest = digest(entry.observed_identity);
	};
	const mutations = [
		[
			"archive operation id",
			(value) => {
				standDownEntry(value).observed_identity.archive_operation_id =
					"archive-foreign";
				redigestIdentity(value);
			},
		],
		[
			"source journal head",
			(value) => {
				standDownEntry(value).observed_identity.source_journal_head =
					"f".repeat(64);
				redigestIdentity(value);
			},
		],
		[
			"close operation id",
			(value) => {
				standDownEntry(
					value,
				).observed_identity.close_set[0].close_operation_id = "close-foreign";
				redigestIdentity(value);
			},
		],
		...[
			"role_name",
			"pane_generation",
			"pane_entry_digest",
			"pane_id",
			"terminal_id",
			"cwd",
		].map((field) => [
			`close set ${field}`,
			(value) => {
				standDownEntry(value).observed_identity.close_set[0][field] =
					field === "cwd" ? temp("foreign-close-cwd-") : "f".repeat(32);
				redigestIdentity(value);
			},
		]),
		[
			"close set order",
			(value) => {
				standDownEntry(value).observed_identity.close_set.reverse();
				redigestIdentity(value);
			},
		],
		[
			"duplicate close set",
			(value) => {
				const identity = standDownEntry(value).observed_identity;
				identity.close_set.push(structuredClone(identity.close_set[0]));
				redigestIdentity(value);
			},
		],
		[
			"stand-down request digest",
			(value) => {
				standDownEntry(value).request_digest = "f".repeat(64);
			},
		],
		[
			"stand-down result digest",
			(value) => {
				standDownEntry(value).result_digest = "f".repeat(64);
			},
		],
		[
			"archive operation identity",
			(value) => {
				archiveEntry(value).operation_id = "archive-foreign";
			},
		],
		[
			"archive request binding",
			(value) => {
				archiveEntry(value).request_digest = "f".repeat(64);
			},
		],
		[
			"archive result binding",
			(value) => {
				archiveEntry(value).result_digest = "f".repeat(64);
			},
		],
		[
			"archive previous binding",
			(value) => {
				archiveEntry(value).previous_digest = "f".repeat(64);
			},
		],
		[
			"archive journal head binding",
			(value) => {
				value.state.journal_head = "f".repeat(64);
			},
		],
		[
			"close request digest",
			(value) => {
				value.journal.find(
					(entry) => entry.operation_type === "pane.close",
				).request_digest = "f".repeat(64);
			},
		],
		[
			"close result digest",
			(value) => {
				value.journal.find(
					(entry) => entry.operation_type === "pane.close",
				).result_digest = "f".repeat(64);
			},
		],
		[
			"missing close result",
			(value) => {
				const index = value.journal.findIndex(
					(entry) => entry.operation_type === "pane.close",
				);
				value.journal.splice(index, 1);
			},
		],
		[
			"duplicate close result",
			(value) => {
				const close = value.journal.find(
					(entry) => entry.operation_type === "pane.close",
				);
				const archiveIndex = value.journal.findIndex(
					(entry) => entry.operation_type === "run.archive",
				);
				value.journal.splice(archiveIndex - 1, 0, structuredClone(close));
			},
		],
		[
			"extra close result",
			(value) => {
				const close = structuredClone(
					value.journal.find((entry) => entry.operation_type === "pane.close"),
				);
				close.operation_id = "close-extra";
				const archiveIndex = value.journal.findIndex(
					(entry) => entry.operation_type === "run.archive",
				);
				value.journal.splice(archiveIndex, 0, close);
			},
		],
		[
			"retained pane identity",
			(value) => {
				value.journal.find(
					(entry) => entry.operation_type === "pane.create",
				).observed_identity.pane_id = `${fixture.workspace}:foreign`;
			},
		],
	];
	const authority = snapshotTree(fixture.stateRoot);
	const gitBefore = gitInventory(fixture.repository);
	const effects = fixture.fake.effects;
	for (const [name, mutate] of mutations) {
		const changed = structuredClone(archived);
		mutate(changed);
		assert.throws(
			() => archivedStandDownReplay(changed, fixture.workspace),
			(error) => error.code === "bookkeeping_unknown",
			name,
		);
		assert.deepEqual(snapshotTree(fixture.stateRoot), authority, name);
		assert.deepEqual(gitInventory(fixture.repository), gitBefore, name);
		assert.equal(fixture.fake.effects, effects, name);
	}
	for (const reason of ["normal_completion", "not-a-reason"])
		assert.throws(
			() => archivedStandDownReplay(archived, fixture.workspace, reason),
			(error) => error.code === "operation_conflict",
			reason,
		);
});

test("archived status and stand-down replay require canonical retained task and report authority", async () => {
	for (const variant of [
		"missing task",
		"malformed task",
		"noncanonical task",
		"cross-role task",
		"missing report",
		"malformed report",
		"noncanonical report",
		"cross-role report",
	]) {
		const fixture = await assembledFixture();
		const worker = fixture.result.workers[0];
		mkdirSync(join(worker.cwd, "src"));
		writeFileSync(join(worker.cwd, "src", "archive-authority.txt"), "done\n");
		git(worker.cwd, "add", "src/archive-authority.txt");
		git(worker.cwd, "commit", "-qm", "complete archived authority fixture");
		await publishWorkerReport(fixture, worker);
		await reconcile({
			contextJson: context(fixture.repository, fixture.workspace),
			herdrBin: "fake",
			exec: fixture.fake.exec,
		});
		await standDown({
			contextJson: context(fixture.repository, fixture.workspace),
			herdrBin: "fake",
			exec: fixture.fake.exec,
			reason: "normal_completion",
		});
		const documents = privateDocuments(fixture.stateRoot);
		const target = documents.find(({ path }) =>
			variant.includes("task")
				? path.includes("/contracts/tasks/")
				: path.includes("/contracts/reports/"),
		);
		assert.ok(target, variant);
		if (variant.startsWith("missing")) rmSync(target.path);
		else if (variant.startsWith("malformed"))
			writeFileSync(target.path, '{"broken":');
		else if (variant.startsWith("noncanonical"))
			writeFileSync(target.path, JSON.stringify(target.value, null, 2));
		else {
			const changed = structuredClone(target.value);
			changed.role.name = "cross-role";
			if (variant.includes("task")) {
				delete changed.task_digest;
				changed.task_digest = taskDigest(changed);
			} else {
				delete changed.report_digest;
				changed.report_digest = reportDigest(changed);
			}
			writeFileSync(target.path, canonicalJson(changed));
		}
		const authority = snapshotTree(fixture.stateRoot);
		const gitBefore = gitInventory(fixture.repository);
		const effects = fixture.fake.effects;
		assert.throws(
			() =>
				readStatus({
					contextJson: context(fixture.repository, fixture.workspace),
					herdrBin: "fake",
					exec: fixture.fake.exec,
				}),
			(error) => error.code === "bookkeeping_unknown",
			variant,
		);
		await assert.rejects(
			() =>
				standDown({
					contextJson: context(fixture.repository, fixture.workspace),
					herdrBin: "fake",
					exec: fixture.fake.exec,
				}),
			(error) => error.code === "bookkeeping_unknown",
			variant,
		);
		assert.deepEqual(snapshotTree(fixture.stateRoot), authority, variant);
		assert.deepEqual(gitInventory(fixture.repository), gitBefore, variant);
		assert.equal(fixture.fake.effects, effects, variant);
	}
});

test("archived retained authority rejects duplicate task and report journal owners without effects", async () => {
	const fixture = await assembledFixture();
	const worker = fixture.result.workers[0];
	mkdirSync(join(worker.cwd, "src"));
	writeFileSync(join(worker.cwd, "src", "duplicate-authority.txt"), "done\n");
	git(worker.cwd, "add", "src/duplicate-authority.txt");
	git(worker.cwd, "commit", "-qm", "duplicate authority fixture");
	await publishWorkerReport(fixture, worker);
	await reconcile({
		contextJson: context(fixture.repository, fixture.workspace),
		herdrBin: "fake",
		exec: fixture.fake.exec,
	});
	await standDown({
		contextJson: context(fixture.repository, fixture.workspace),
		herdrBin: "fake",
		exec: fixture.fake.exec,
		reason: "normal_completion",
	});
	const archived = loadArchivedRun(
		openRepositoryStore({
			stateRoot: fixture.stateRoot,
			repoPath: fixture.repository,
		}),
		{ workspaceId: fixture.workspace },
	);
	const authority = snapshotTree(fixture.stateRoot);
	const gitBefore = gitInventory(fixture.repository);
	const effects = fixture.fake.effects;
	for (const operationType of ["task.publish", "report.harvest"]) {
		const changed = structuredClone(archived);
		const duplicate = structuredClone(
			changed.journal.find((entry) => entry.operation_type === operationType),
		);
		const index = changed.journal.findIndex(
			(entry) => entry.operation_type === operationType,
		);
		changed.journal.splice(index + 1, 0, duplicate);
		assert.throws(
			() => deriveRetainedReportAuthority(changed, fixture.stateRoot),
			(error) => error.code === "bookkeeping_unknown",
			operationType,
		);
		assert.deepEqual(snapshotTree(fixture.stateRoot), authority, operationType);
		assert.deepEqual(
			gitInventory(fixture.repository),
			gitBefore,
			operationType,
		);
		assert.equal(fixture.fake.effects, effects, operationType);
	}
});

test("pre-intent integration failure is retryable while failed pane close is never replayed", async () => {
	for (const operation of ["merge", "close"]) {
		const fixture = await assembledFixture();
		if (operation === "merge")
			await publishWorkerReport(fixture, fixture.result.workers[0]);
		let attempts = 0;
		const failingExec = (command, args, options) => {
			if (
				(operation === "merge" &&
					command === "git" &&
					args[4] === "merge-tree") ||
				(operation === "close" && args[0] === "pane" && args[1] === "close")
			) {
				attempts++;
				throw Object.assign(new Error(`${operation} failed`), {
					code: operation === "merge" ? "EIO" : "ETIMEDOUT",
				});
			}
			return fixture.fake.exec(command, args, options);
		};
		const invoke =
			operation === "merge"
				? () =>
						reconcile({
							contextJson: context(fixture.repository, fixture.workspace),
							stateRoot: fixture.stateRoot,
							exec: failingExec,
						})
				: () =>
						standDown({
							contextJson: context(fixture.repository, fixture.workspace),
							stateRoot: fixture.stateRoot,
							herdrBin: "fake",
							exec: failingExec,
						});
		await assert.rejects(invoke);
		assert.equal(attempts, 1);
		assert.equal(existsSync(fixture.result.workers[0].cwd), true);
		await assert.rejects(invoke);
		assert.equal(
			attempts,
			operation === "merge" ? 2 : 1,
			`${operation} restart disposition`,
		);
		assert.equal(
			readJournals(fixture.stateRoot).filter(
				(entry) => entry.phase === "needs_attention",
			).length,
			operation === "merge" ? 0 : 1,
		);
	}
});

test("stand-down resumes partial pre-close drift without touching an observed pane", async () => {
	const fixture = await assembledFixture({
		roles: [
			{ name: "reviewer-a", kind: "pi", mode: "read-only" },
			{ name: "reviewer-b", kind: "pi", mode: "read-only" },
		],
	});
	const [first, second] = fixture.result.workers;
	const secondAgent = fixture.fake.agents.get(second.agent_name);
	const originalWorkspace = secondAgent.workspace_id;
	fixture.fake.onEffect = ({ args }) => {
		if (args[0] === "pane" && args[1] === "close" && args[2] === first.pane_id)
			secondAgent.workspace_id = "wDrift";
	};
	await assert.rejects(() =>
		standDown({
			contextJson: context(fixture.repository, fixture.workspace),
			stateRoot: fixture.stateRoot,
			herdrBin: "fake",
			exec: fixture.fake.exec,
			reason: "missing_report",
		}),
	);
	assert.equal(fixture.fake.panes.has(first.pane_id), false);
	assert.equal(fixture.fake.panes.has(second.pane_id), true);
	secondAgent.workspace_id = originalWorkspace;
	fixture.fake.onEffect = null;
	const conflictingStart = fixture.fake.log.length;
	await assert.rejects(
		() =>
			standDown({
				contextJson: context(fixture.repository, fixture.workspace),
				stateRoot: fixture.stateRoot,
				herdrBin: "fake",
				exec: fixture.fake.exec,
				reason: "operator_abandoned",
			}),
		(error) => error.code === "operation_conflict",
	);
	assert.equal(
		fixture.fake.log
			.slice(conflictingStart)
			.some(({ args }) => args[0] === "pane" && args[1] === "close"),
		false,
	);
	const retryStart = fixture.fake.log.length;
	const retried = await standDown({
		contextJson: context(fixture.repository, fixture.workspace),
		stateRoot: fixture.stateRoot,
		herdrBin: "fake",
		exec: fixture.fake.exec,
	});
	assert.equal(retried.archived, true);
	assert.deepEqual(
		new Set(retried.closed),
		new Set([first.pane_id, second.pane_id]),
	);
	for (const { args } of fixture.fake.log.slice(retryStart))
		assert.equal(
			args.includes(first.pane_id),
			false,
			`retried prior pane: ${args.join(" ")}`,
		);
});

test("historical archives never mask newer malformed, duplicate, or needs-attention active runs", async () => {
	for (const variant of ["malformed", "duplicate", "needs_attention"]) {
		const historical = await assembledFixture({ seed: 1 });
		await standDown({
			contextJson: context(historical.repository, historical.workspace),
			stateRoot: historical.stateRoot,
			herdrBin: "fake",
			exec: historical.fake.exec,
		});
		const current = await assembledFixture({
			repository: historical.repository,
			workspace: historical.workspace,
			stateRoot: historical.stateRoot,
			seed: 40,
		});
		const paneId = current.result.workers[0].pane_id;
		if (variant === "malformed") {
			const run = privateDocuments(current.stateRoot).find(
				({ value }) =>
					value.document_type === "herdr-conductor-run" &&
					value.run_id === current.result.run_id,
			);
			writeFileSync(run.path, "{malformed");
		}
		if (variant === "duplicate") {
			const pointer = privateDocuments(current.stateRoot).find(
				({ path, value }) =>
					path.includes("/active/") && value.run_id === current.result.run_id,
			);
			const duplicate = {
				...pointer.value,
				run_id: `${pointer.value.run_id}-duplicate`,
			};
			writeFileSync(
				join(
					dirname(pointer.path),
					`${duplicate.run_id}--${duplicate.generation}.json`,
				),
				JSON.stringify(duplicate),
				{ mode: 0o600 },
			);
		}
		if (variant === "needs_attention") {
			await assert.rejects(() =>
				standDown({
					contextJson: context(current.repository, current.workspace),
					stateRoot: current.stateRoot,
					herdrBin: "fake",
					exec(command, args) {
						if (args[0] === "pane" && args[1] === "close")
							throw new Error("injected close ambiguity");
						return current.fake.exec(command, args);
					},
				}),
			);
		}
		const closesBefore = current.fake.log.filter(
			({ args }) => args[0] === "pane" && args[1] === "close",
		).length;
		await assert.rejects(() =>
			standDown({
				contextJson: context(current.repository, current.workspace),
				stateRoot: current.stateRoot,
				herdrBin: "fake",
				exec: current.fake.exec,
			}),
		);
		assert.equal(current.fake.panes.has(paneId), true, variant);
		assert.equal(
			current.fake.log.filter(
				({ args }) => args[0] === "pane" && args[1] === "close",
			).length,
			closesBefore,
			variant,
		);
	}
});

test("archive boundaries classify incomplete authority uncertain and post-guard authority archived", async () => {
	for (const boundary of [
		"archive_intent.after_publish",
		"archive_intent_head.after_publish",
		"archive.after_intent_durable",
		"archive_guard_publish.after_publish",
		"archive.after_guard_durable",
		"archive_state.after_publish",
		"archive.after_state_durable",
		"archive.before_pointer_remove",
		"archive.after_pointer_remove",
		"archive.before_pointer_fsync",
		"archive.after_pointer_fsync",
		"archive.before_result",
		"archive_result.after_publish",
		"archive_result_head.after_publish",
		"archive_guard_remove.before_remove",
		"archive_guard_remove.after_remove",
		"archive_guard_remove.after_directory_fsync",
	]) {
		const fixture = await assembledFixture();
		const paneId = fixture.result.workers[0].pane_id;
		let fired = false;
		await assert.rejects(() =>
			standDown({
				contextJson: context(fixture.repository, fixture.workspace),
				stateRoot: fixture.stateRoot,
				herdrBin: "fake",
				exec: fixture.fake.exec,
				fault(name) {
					if (name === `run.archive:${boundary}` && !fired) {
						fired = true;
						throw new Error(`fault ${boundary}`);
					}
				},
			}),
		);
		assert.equal(fired, true, boundary);
		const retryStart = fixture.fake.log.length;
		const terminal = boundary.startsWith("archive_guard_remove.after_");
		if (terminal) {
			const result = await standDown({
				contextJson: context(fixture.repository, fixture.workspace),
				herdrBin: "fake",
				exec: fixture.fake.exec,
			});
			assert.equal(result.archived, true, boundary);
			assert.equal(result.replayed, true, boundary);
		} else
			await assert.rejects(
				() =>
					standDown({
						contextJson: context(fixture.repository, fixture.workspace),
						herdrBin: "fake",
						exec: fixture.fake.exec,
					}),
				(error) =>
					error.code === "recovery_required" &&
					error.message.startsWith("archive_uncertain:"),
				boundary,
			);
		for (const { args } of fixture.fake.log.slice(retryStart))
			assert.equal(
				args.includes(paneId),
				false,
				`${boundary}: ${args.join(" ")}`,
			);
	}
});

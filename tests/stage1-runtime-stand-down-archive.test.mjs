import { test } from "node:test";
import { canonicalJson } from "../scripts/private-state-schema.mjs";
import {
	assert,
	existsSync,
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
	context,
	config,
	deterministicRandom,
	FakeHerdr,
	readJournals,
	privateDocuments,
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

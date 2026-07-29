import { test } from "node:test";
import {
	assert,
	existsSync,
	writeFileSync,
	dirname,
	join,
	reconcile,
	standDown,
	temp,
	git,
	context,
	readJournals,
	privateDocuments,
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

test("failed merge and close are ambiguous and never replayed", async () => {
	for (const operation of ["merge", "close"]) {
		const fixture = await assembledFixture({
			roles: [{ name: "builder", kind: "pi", mode: "write" }],
		});
		let attempts = 0;
		const failingExec = (command, args) => {
			if (
				(operation === "merge" &&
					command === "git" &&
					args[2] === "merge-tree") ||
				(operation === "close" && args[0] === "pane" && args[1] === "close")
			) {
				attempts++;
				const code = operation === "merge" ? "EIO" : "ETIMEDOUT";
				throw Object.assign(new Error(`${operation} ${code}`), { code });
			}
			return fixture.fake.exec(command, args);
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
		await assert.rejects(invoke, /explicit recovery/);
		assert.equal(attempts, 1);
		assert.equal(
			readJournals(fixture.stateRoot).filter(
				(entry) => entry.phase === "needs_attention",
			).length,
			1,
		);
		assert.equal(existsSync(fixture.result.workers[0].cwd), true);
		await assert.rejects(invoke);
		assert.equal(attempts, 1, `${operation} replayed after ambiguity`);
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
		}),
	);
	assert.equal(fixture.fake.panes.has(first.pane_id), false);
	assert.equal(fixture.fake.panes.has(second.pane_id), true);
	secondAgent.workspace_id = originalWorkspace;
	fixture.fake.onEffect = null;
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

test("archive private-write boundaries recover only the exact missing-active transition", async () => {
	const recoverable = new Set([
		"archive.after_pointer_remove",
		"archive.before_pointer_fsync",
		"archive.after_pointer_fsync",
		"archive.before_result",
		"archive_result.after_publish",
		"archive_result_head.after_publish",
		"archive_guard.before_remove",
	]);
	for (const boundary of [
		"archive_intent.after_publish",
		"archive_intent_head.after_publish",
		"archive.after_intent_durable",
		"archive_guard.after_publish",
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
		"archive_guard.before_remove",
		"archive_guard.after_remove",
		"archive_guard.after_directory_fsync",
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
		if (recoverable.has(boundary)) {
			const retried = await standDown({
				contextJson: context(fixture.repository, fixture.workspace),
				stateRoot: fixture.stateRoot,
				herdrBin: "fake",
				exec: fixture.fake.exec,
			});
			assert.equal(retried.archived, true, boundary);
		} else {
			await assert.rejects(() =>
				standDown({
					contextJson: context(fixture.repository, fixture.workspace),
					stateRoot: fixture.stateRoot,
					herdrBin: "fake",
					exec: fixture.fake.exec,
				}),
			);
		}
		for (const { args } of fixture.fake.log.slice(retryStart))
			assert.equal(
				args.includes(paneId),
				false,
				`${boundary}: ${args.join(" ")}`,
			);
	}
});

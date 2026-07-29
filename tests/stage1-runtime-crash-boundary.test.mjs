import { test } from "node:test";
import {
	assert,
	spawnSync,
	readFileSync,
	rmSync,
	writeFileSync,
	dirname,
	join,
	assemble,
	temp,
	git,
	repo,
	context,
	config,
	deterministicRandom,
	expectCodeAsync,
	FakeHerdr,
	readJournals,
	privateDocuments,
	inspectKilledOperation,
	assembledFixture,
} from "./stage1-runtime-helpers.mjs";

test("crashes at intent/effect boundaries leave non-replayed truthful state", async () => {
	for (const [boundary, expectedEffects] of [
		["journal.after_intent_durable", 0],
		["journal.after_effect", 1],
	]) {
		const repository = repo();
		const stateRoot = join(temp("conductor-b2-state-"), "state");
		const fake = new FakeHerdr();
		const cfg = config(repository, [
			{ name: "reviewer", kind: "codex", mode: "read-only" },
		]);
		await expectCodeAsync("recovery_required", () =>
			assemble({
				contextJson: context(repository),
				stateRoot,
				configPath: cfg,
				exec: fake.exec,
				herdrBin: "fake",
				random: deterministicRandom(),
				fault(name) {
					if (name === boundary) throw new Error(`abrupt ${boundary}`);
				},
			}),
		);
		assert.equal(fake.effects, expectedEffects, boundary);
		const before = fake.effects;
		await assert.rejects(() =>
			assemble({
				contextJson: context(repository),
				stateRoot,
				configPath: cfg,
				exec: fake.exec,
				herdrBin: "fake",
				random: deterministicRandom(50),
			}),
		);
		assert.equal(
			fake.effects,
			before,
			`${boundary} replayed an external effect`,
		);
		const journal = readJournals(stateRoot);
		assert.equal(
			journal.at(-1).phase,
			boundary === "journal.after_intent_durable"
				? "intent"
				: "needs_attention",
		);
	}
});

test("SIGKILL boundaries preserve truthful ambiguity and no available path replays effects", () => {
	const child = join(
		dirname(new URL(import.meta.url).pathname),
		"fixtures",
		"stage1-crash-child.mjs",
	);
	const cases = [];
	for (const operation of ["worktree.create", "pane.create", "agent.start"])
		for (const boundary of [
			"journal.after_intent_durable",
			"journal.after_effect",
		])
			cases.push([operation, boundary]);
	cases.push(["agent.start", "after_start_before_metadata"]);

	for (const [operation, boundary] of cases) {
		const repository = repo();
		const stateRoot = join(temp("conductor-b2-crash-state-"), "state");
		const logPath = join(temp("conductor-b2-crash-log-"), "effects.log");
		writeFileSync(logPath, "");
		const mode = operation === "worktree.create" ? "write" : "read-only";
		const cfg = config(repository, [{ name: "worker", kind: "pi", mode }]);
		const target = `${operation}:${boundary}`;
		const crashed = spawnSync(
			process.execPath,
			[child, repository, stateRoot, cfg, logPath, target],
			{ encoding: "utf8" },
		);
		assert.equal(crashed.signal, "SIGKILL", `${target}: ${crashed.stderr}`);
		const effectsAfterCrash = readFileSync(logPath, "utf8");
		const effects = effectsAfterCrash.trim()
			? effectsAfterCrash.trim().split("\n").map(JSON.parse)
			: [];
		const expectedEffects = {
			"worktree.create:journal.after_intent_durable": 0,
			"worktree.create:journal.after_effect": 1,
			"pane.create:journal.after_intent_durable": 0,
			"pane.create:journal.after_effect": 1,
			"agent.start:journal.after_intent_durable": 1,
			"agent.start:journal.after_effect": 3,
			"agent.start:after_start_before_metadata": 2,
		}[target];
		assert.equal(effects.length, expectedEffects, `${target} effect count`);
		for (const effect of effects) {
			assert.ok(Array.isArray(effect.args), `${target} dropped complete argv`);
			assert.ok(effect.args.length >= 2, `${target} recorded truncated argv`);
		}
		inspectKilledOperation({ repository, stateRoot, operation, boundary });

		const retried = spawnSync(
			process.execPath,
			[child, repository, stateRoot, cfg, logPath, "never", "50"],
			{ encoding: "utf8" },
		);
		assert.notEqual(
			retried.status,
			0,
			`${target} retry unexpectedly succeeded`,
		);
		assert.match(
			retried.stderr,
			/lock_busy|already held/,
			`${target} did not separately report stale lock refusal`,
		);
		assert.equal(
			readFileSync(logPath, "utf8"),
			effectsAfterCrash,
			`${target} retry replayed an external effect`,
		);
	}
});

test("B3 SIGKILL at intent, effect, and result boundaries never replays merge or close", async () => {
	const child = join(
		dirname(new URL(import.meta.url).pathname),
		"fixtures",
		"b3-crash-child.mjs",
	);
	for (const operation of ["merge", "close"])
		for (const boundary of [
			`${operation === "merge" ? "git.merge" : "pane.close"}:journal.after_intent_durable`,
			`${operation === "merge" ? "git.merge" : "pane.close"}:journal.after_effect`,
			`${operation === "merge" ? "git.merge" : "pane.close"}:journal_result.after_publish`,
		]) {
			const fixture = await assembledFixture({
				roles: [{ name: "builder", kind: "pi", mode: "write" }],
			});
			const livePath = join(temp("conductor-b3-live-"), "live.json");
			const effectsPath = join(temp("conductor-b3-effects-"), "effects.log");
			writeFileSync(
				livePath,
				JSON.stringify({
					panes: Object.fromEntries(fixture.fake.panes),
					agents: Object.fromEntries(fixture.fake.agents),
				}),
			);
			writeFileSync(effectsPath, "");
			const crashed = spawnSync(
				process.execPath,
				[
					child,
					operation,
					fixture.repository,
					fixture.stateRoot,
					fixture.workspace,
					livePath,
					effectsPath,
					boundary,
				],
				{ encoding: "utf8" },
			);
			assert.equal(
				crashed.signal,
				"SIGKILL",
				`${operation}:${boundary}: ${crashed.stderr}`,
			);
			const afterCrash = readFileSync(effectsPath, "utf8");
			const effectCount = afterCrash.trim()
				? afterCrash.trim().split("\n").length
				: 0;
			assert.equal(
				effectCount,
				boundary.endsWith("after_intent_durable") ? 0 : 1,
				`${operation}:${boundary}`,
			);
			const retry = spawnSync(
				process.execPath,
				[
					child,
					operation,
					fixture.repository,
					fixture.stateRoot,
					fixture.workspace,
					livePath,
					effectsPath,
					"never",
				],
				{ encoding: "utf8" },
			);
			assert.notEqual(
				retry.status,
				0,
				`${operation}:${boundary} retry succeeded`,
			);
			assert.equal(
				readFileSync(effectsPath, "utf8"),
				afterCrash,
				`${operation}:${boundary} replayed effect`,
			);
		}
});

test("true SIGKILL archive recovery is limited to exact missing-active evidence", async () => {
	const recoverable = new Set([
		"run.archive:archive.after_pointer_remove",
		"run.archive:archive_result.after_publish",
		"run.archive:archive_guard.before_remove",
	]);
	const child = join(
		dirname(new URL(import.meta.url).pathname),
		"fixtures",
		"b3-crash-child.mjs",
	);
	for (const boundary of [
		"run.archive:archive.after_intent_durable",
		"run.archive:archive_state.after_publish",
		"run.archive:archive.after_pointer_remove",
		"run.archive:archive_result.after_publish",
		"run.archive:archive_guard.before_remove",
		"run.archive:archive_guard.after_remove",
		"run.archive:archive_guard.after_directory_fsync",
	]) {
		const fixture = await assembledFixture();
		const livePath = join(temp("conductor-archive-live-"), "live.json");
		const effectsPath = join(temp("conductor-archive-effects-"), "effects.log");
		writeFileSync(
			livePath,
			JSON.stringify({
				panes: Object.fromEntries(fixture.fake.panes),
				agents: Object.fromEntries(fixture.fake.agents),
			}),
		);
		writeFileSync(effectsPath, "");
		const args = [
			child,
			"archive",
			fixture.repository,
			fixture.stateRoot,
			fixture.workspace,
			livePath,
			effectsPath,
			boundary,
		];
		const crashed = spawnSync(process.execPath, args, { encoding: "utf8" });
		assert.equal(crashed.signal, "SIGKILL", `${boundary}: ${crashed.stderr}`);
		const afterCrash = readFileSync(effectsPath, "utf8");
		const owner = privateDocuments(fixture.stateRoot).find(
			({ value }) => value.document_type === "herdr-conductor-repository-lock",
		);
		assert.ok(owner, boundary);
		rmSync(dirname(owner.path), { recursive: true, force: true });
		const retry = spawnSync(process.execPath, [...args.slice(0, -1), "never"], {
			encoding: "utf8",
		});
		assert.equal(
			retry.status === 0,
			recoverable.has(boundary),
			`${boundary}: ${retry.stderr}`,
		);
		assert.equal(readFileSync(effectsPath, "utf8"), afterCrash, boundary);
	}
});

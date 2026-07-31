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
	repo,
	privateStateRoot,
	context,
	config,
	deterministicRandom,
	expectCodeAsync,
	FakeHerdr,
	readJournals,
	privateDocuments,
	inspectKilledOperation,
	publishWorkerReport,
	assembledFixture,
} from "./stage1-runtime-helpers.mjs";
import {
	inspectArchiveUncertainty,
	loadArchivedRun,
	openRepositoryStore,
} from "../scripts/state-kernel.mjs";
import { STAGE2_CHECKPOINT_CATALOG } from "../scripts/stage2-checkpoint-catalog.mjs";

test("crashes at intent/effect boundaries leave non-replayed truthful state", async () => {
	for (const [boundary, expectedEffects] of [
		["journal.after_intent_durable", 0],
		["journal.after_effect", 1],
	]) {
		const repository = repo();
		const stateRoot = privateStateRoot();
		const fake = new FakeHerdr();
		const cfg = config(
			repository,
			[{ name: "reviewer", kind: "codex", mode: "read-only" }],
			{},
			stateRoot,
		);
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
		const stateRoot = privateStateRoot("conductor-b2-crash-state-");
		const logPath = join(temp("conductor-b2-crash-log-"), "effects.log");
		writeFileSync(logPath, "");
		const cfg = config(
			repository,
			[{ name: "worker", kind: "pi", mode: "write" }],
			{},
			stateRoot,
		);
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
			"pane.create:journal.after_intent_durable": 1,
			"pane.create:journal.after_effect": 2,
			"agent.start:journal.after_intent_durable": 2,
			"agent.start:journal.after_effect": 4,
			"agent.start:after_start_before_metadata": 3,
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
			`${operation === "merge" ? "integration.reconcile" : "pane.close"}:journal.after_intent_durable`,
			`${operation === "merge" ? "integration.reconcile" : "pane.close"}:journal.after_effect`,
			`${operation === "merge" ? "integration.reconcile" : "pane.close"}:journal_result.after_publish`,
		]) {
			const fixture = await assembledFixture({
				roles: [{ name: "builder", kind: "pi", mode: "write" }],
			});
			if (operation === "merge")
				await publishWorkerReport(fixture, fixture.result.workers[0]);
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

test("true SIGKILL archive boundaries classify from durable authority without replay", async () => {
	const child = join(
		dirname(new URL(import.meta.url).pathname),
		"fixtures",
		"b3-crash-child.mjs",
	);
	const checkpoints = STAGE2_CHECKPOINT_CATALOG.archive;
	const reaches = (checkpoint, threshold) =>
		checkpoints.indexOf(checkpoint) >= checkpoints.indexOf(threshold);
	for (const checkpoint of checkpoints) {
		const boundary = `run.archive:${checkpoint}`;
		const expected = {
			phase: reaches(checkpoint, "archive_result.after_publish")
				? "observed"
				: "intent",
			status: reaches(checkpoint, "archive_state.after_publish")
				? "archived"
				: "active",
			pointer: !reaches(checkpoint, "archive.after_pointer_remove"),
			guard:
				reaches(checkpoint, "archive_guard_publish.after_publish") &&
				!reaches(checkpoint, "archive_guard_remove.after_remove"),
			terminal: reaches(checkpoint, "archive_guard_remove.after_remove"),
		};
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
		const effects = afterCrash.trim().split("\n").filter(Boolean);
		assert.equal(effects.length, 1, `${boundary}: close effect inventory`);
		assert.deepEqual(JSON.parse(effects[0]).args.slice(0, 2), [
			"pane",
			"close",
		]);
		const documents = privateDocuments(fixture.stateRoot);
		const owner = documents.find(
			({ value }) => value.document_type === "herdr-conductor-repository-lock",
		);
		assert.ok(owner, boundary);
		const runState = documents.find(
			({ value }) => value.document_type === "herdr-conductor-run",
		)?.value;
		const pointers = documents.filter(
			({ value }) => value.document_type === "herdr-conductor-active-run",
		);
		const archiveEntries = documents.filter(
			({ value }) =>
				value.document_type === "herdr-conductor-operation" &&
				value.operation_type === "run.archive",
		);
		const archiveGuards = archiveEntries.filter(({ path }) =>
			path.includes("/operation-guards/"),
		);
		const archiveResults = archiveEntries.filter(({ path }) =>
			path.includes("/operations/"),
		);
		assert.equal(runState.status, expected.status, boundary);
		assert.equal(pointers.length > 0, expected.pointer, boundary);
		assert.equal(archiveGuards.length > 0, expected.guard, boundary);
		const expectedArchiveResults = reaches(
			checkpoint,
			"archive_intent.after_publish",
		)
			? 1
			: 0;
		assert.equal(archiveResults.length, expectedArchiveResults, boundary);
		if (expectedArchiveResults)
			assert.equal(archiveResults[0].value.phase, expected.phase, boundary);
		const store = openRepositoryStore({
			stateRoot: fixture.stateRoot,
			repoPath: fixture.repository,
		});
		const classification = inspectArchiveUncertainty(store, {
			workspaceId: fixture.workspace,
		});
		const retryablePreIntent = checkpoint === "archive_intent.before_temp_open";
		const bookkeepingResidue = [
			"archive_intent.after_temp_write",
			"archive_intent.after_file_fsync",
		].includes(checkpoint);
		if (expected.terminal || retryablePreIntent || bookkeepingResidue) {
			assert.equal(classification, null, boundary);
			if (expected.terminal)
				assert.equal(
					loadArchivedRun(store, { workspaceId: fixture.workspace }).state
						.status,
					"archived",
					boundary,
				);
		} else
			assert.deepEqual(
				{
					classification: classification.classification,
					errorCode: classification.error_code,
					phase: classification.journal_phase,
					status: classification.state_status,
					pointer: classification.pointer_present,
					guard: classification.guard_present,
				},
				{
					classification: "archive_uncertain",
					errorCode: "recovery_required",
					phase: expected.phase,
					status: expected.status,
					pointer: expected.pointer,
					guard: expected.guard,
				},
				boundary,
			);
		rmSync(store.lockDir, { recursive: true, force: true });
		const authorityBeforeRetry = privateDocuments(fixture.stateRoot);
		const retry = spawnSync(process.execPath, [...args.slice(0, -1), "never"], {
			encoding: "utf8",
		});
		assert.equal(
			retry.status,
			expected.terminal || retryablePreIntent ? 0 : 1,
			`${boundary}: restart exit: ${retry.stderr}`,
		);
		if (!expected.terminal && !retryablePreIntent)
			assert.equal(
				retry.stderr.split(":", 1)[0],
				bookkeepingResidue ? "bookkeeping_unknown" : "recovery_required",
				`${boundary}: restart classification`,
			);
		assert.equal(readFileSync(effectsPath, "utf8"), afterCrash, boundary);
		if (retryablePreIntent)
			assert.equal(
				loadArchivedRun(store, { workspaceId: fixture.workspace }).state.status,
				"archived",
				boundary,
			);
		else
			assert.deepEqual(
				privateDocuments(fixture.stateRoot),
				authorityBeforeRetry,
				boundary,
			);
	}
});

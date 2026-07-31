import { test } from "node:test";
import {
	assert,
	existsSync,
	mkdirSync,
	symlinkSync,
	join,
	assemble,
	parsePluginContext,
	readStatus,
	temp,
	git,
	repo,
	privateStateRoot,
	context,
	config,
	deterministicRandom,
	expectCode,
	expectCodeAsync,
	FakeHerdr,
	readJournals,
	snapshotTree,
	gitInventory,
	effectLog,
	assembledFixture,
} from "./stage1-runtime-helpers.mjs";

test("assemble records fixed fork, run-unique full refs/names, and exact observed identities", async () => {
	const repository = repo();
	const fork = git(repository, "rev-parse", "HEAD");
	const fixture = await assembledFixture({
		repository,
		roles: [{ name: "builder", kind: "pi", mode: "write" }],
	});
	assert.equal(fixture.result.fork_sha, fork);
	assert.match(fixture.result.run_id, /^r-[a-f0-9]{24}$/);
	assert.match(fixture.result.workers[0].agent_name, /^builder-[a-f0-9]{12}$/);
	const journal = readJournals(fixture.stateRoot);
	assert.deepEqual(
		journal.map((entry) => entry.operation_type),
		[
			"integration.bind",
			"worktree.create",
			"task.publish",
			"pane.create",
			"agent.start",
		],
	);
	const integration = journal[0].observed_identity;
	assert.equal(integration.path, repository);
	assert.equal(integration.head_sha, fork);
	assert.equal(integration.branch_ref, "refs/heads/main");
	const worktree = journal[1].observed_identity;
	assert.equal(
		worktree.branch_ref,
		`refs/heads/conductor/${fixture.result.run_id}/builder`,
	);
	assert.equal(worktree.fork_sha, fork);
	assert.equal(worktree.head_sha, fork);
	assert.equal(worktree.registered, true);
	const pane = journal[4].observed_identity;
	assert.equal(pane.workspace_id, fixture.workspace);
	assert.equal(pane.run_id, fixture.result.run_id);
	assert.equal(pane.agent_name, fixture.result.workers[0].agent_name);
	assert.equal(pane.generation, journal[3].subject.generation);
	assert.notEqual(journal[4].subject.generation, journal[3].subject.generation);
});

test("assemble retries only Herdr's explicit no-effect pane-busy response", async () => {
	const repository = repo();
	const fake = new FakeHerdr();
	fake.agentBusyRemaining = 1;
	const stateRoot = privateStateRoot();
	const result = await assemble({
		contextJson: context(repository),
		configPath: config(
			repository,
			[{ name: "builder", kind: "pi", mode: "write" }],
			{},
			stateRoot,
		),
		exec: fake.exec,
		herdrBin: "fake-herdr",
		random: deterministicRandom(),
	});
	assert.equal(result.workers.length, 1);
	assert.equal(
		fake.log.filter(({ args }) => args[0] === "agent" && args[1] === "start")
			.length,
		2,
	);
});

test("strict fake Git/Herdr calls see durable intent before every effect and preserve ordering", async () => {
	const repository = repo();
	const stateRoot = privateStateRoot();
	const fake = new FakeHerdr();
	fake.onEffect = () => {
		const journal = readJournals(stateRoot);
		assert.equal(
			journal.at(-1).phase,
			"intent",
			"external effect ran before durable intent",
		);
	};
	const result = await assemble({
		contextJson: context(repository),
		stateRoot,
		configPath: config(
			repository,
			[
				{
					name: "builder",
					kind: "pi",
					mode: "write",
				},
			],
			{},
			stateRoot,
		),
		exec: fake.exec,
		herdrBin: "fake-herdr",
		random: deterministicRandom(),
	});
	const worker = result.workers[0];
	const branch = `conductor/${result.run_id}/builder`;
	assert.deepEqual(fake.log, [
		{ command: "fake-herdr", args: ["--version"] },
		{ command: "fake-herdr", args: ["api", "schema", "--json"] },
		{ command: "fake-herdr", args: ["pane", "get", "wB2:p0"] },
		{
			command: "git",
			args: [
				"-C",
				repository,
				"worktree",
				"add",
				"-b",
				branch,
				worker.cwd,
				result.fork_sha,
			],
		},
		{ command: "fake-herdr", args: ["pane", "get", "wB2:p0"] },
		{
			command: "fake-herdr",
			args: [
				"pane",
				"split",
				"wB2:p0",
				"--direction",
				"right",
				"--cwd",
				worker.cwd,
				"--no-focus",
			],
		},
		{ command: "fake-herdr", args: ["pane", "get", worker.pane_id] },
		{
			command: "fake-herdr",
			args: [
				"agent",
				"start",
				worker.agent_name,
				"--kind",
				"pi",
				"--pane",
				worker.pane_id,
				"--timeout",
				"60000",
			],
		},
		{
			command: "fake-herdr",
			args: [
				"pane",
				"report-metadata",
				worker.pane_id,
				"--source",
				"structupath.conductor",
				"--token",
				`conductor_run_id=${result.run_id}`,
				"--token",
				`conductor_generation=${readJournals(stateRoot)[3].subject.generation}`,
			],
		},
		{ command: "fake-herdr", args: ["pane", "list"] },
		{ command: "fake-herdr", args: ["agent", "list"] },
		{ command: "fake-herdr", args: ["pane", "get", worker.pane_id] },
		{ command: "fake-herdr", args: ["agent", "get", worker.agent_name] },
	]);
});

test("strict fakes reject every wrong or unscripted complete command", () => {
	const repository = repo();
	const roles = [{ name: "reviewer", kind: "codex", mode: "read-only" }];
	config(repository, roles);
	const fake = new FakeHerdr(repository, "wB2", roles);
	assert.throws(() => fake.exec("other-herdr", ["pane", "list"]));
	assert.throws(() => fake.exec("fake", ["--version", "extra"]));
	assert.throws(() => fake.exec("fake", ["api", "schema", "--json", "extra"]));
	assert.throws(() => fake.exec("fake", ["pane", "list", "--all"]));
	assert.throws(() => fake.exec("fake", ["pane", "get", "wForeign:p0"]));
	assert.throws(() => fake.exec("git", ["rev-parse", "HEAD"]));
	assert.throws(() =>
		fake.exec("git", ["-C", repository, "status", "--short"]),
	);
	assert.throws(() =>
		fake.exec("git", [
			"-C",
			repository,
			"update-ref",
			"refs/heads/main",
			"a".repeat(40),
			"b".repeat(40),
			"extra",
		]),
	);
});

test("populated repository/workspace scopes select exactly one run without foreign mutation or probing", async () => {
	const stateRoot = privateStateRoot();
	const role = { name: "builder", kind: "pi", mode: "write" };
	const firstRepo = repo();
	const secondRepo = repo();
	const sharedRepo = repo();
	const fixtures = [];
	for (const [repository, workspace, seed] of [
		[firstRepo, "wOne", 1],
		[secondRepo, "wOne", 20],
		[sharedRepo, "wA", 40],
		[sharedRepo, "wB", 60],
	]) {
		const fake = new FakeHerdr(repository, workspace, [role]);
		const run = await assemble({
			contextJson: context(repository, workspace),
			stateRoot,
			configPath: config(repository, [role], {}, stateRoot),
			exec: fake.exec,
			herdrBin: "fake",
			random: deterministicRandom(seed),
		});
		fixtures.push({ repository, workspace, fake, run });
	}

	for (const selected of fixtures) {
		for (const action of ["board", "status"]) {
			const stateBefore = snapshotTree(stateRoot);
			const inventoriesBefore = [firstRepo, secondRepo, sharedRepo].map(
				gitInventory,
			);
			const effectsBefore = fixtures.map(({ fake }) =>
				structuredClone(effectLog(fake)),
			);
			const logsBefore = fixtures.map(({ fake }) => structuredClone(fake.log));
			const output = readStatus({
				contextJson: context(selected.repository, selected.workspace),
				stateRoot,
				exec: selected.fake.exec,
				herdrBin: "fake",
			});
			assert.equal(
				output.run,
				selected.run.run_id,
				`${action} selected wrong run`,
			);
			assert.equal(
				output.workspace_id,
				selected.workspace,
				`${action} selected wrong workspace`,
			);
			assert.match(output.repository_key, /^[a-f0-9]{64}$/);
			assert.deepEqual(
				snapshotTree(stateRoot),
				stateBefore,
				`${action} mutated private state`,
			);
			assert.deepEqual(
				[firstRepo, secondRepo, sharedRepo].map(gitInventory),
				inventoriesBefore,
				`${action} mutated Git inventory`,
			);
			assert.deepEqual(
				fixtures.map(({ fake }) => effectLog(fake)),
				effectsBefore,
				`${action} caused an effect`,
			);
			for (const [index, fixture] of fixtures.entries()) {
				if (fixture !== selected)
					assert.deepEqual(
						fixture.fake.log,
						logsBefore[index],
						`${action} probed a foreign scope`,
					);
			}
			const worker = selected.run.workers[0];
			for (const call of selected.fake.log.slice(
				logsBefore[fixtures.indexOf(selected)].length,
			)) {
				if (call.args[0] === "pane" && call.args[1] === "get")
					assert.deepEqual(call.args, ["pane", "get", worker.pane_id]);
				else if (call.args[0] === "agent" && call.args[1] === "get")
					assert.deepEqual(call.args, ["agent", "get", worker.agent_name]);
				else
					assert.ok(
						[
							"--version",
							"api schema --json",
							"pane list",
							"agent list",
						].includes(call.args.join(" ")),
						`${action} made foreign/unexpected probe ${call.args.join(" ")}`,
					);
			}
		}
	}
});

test("malformed, foreign, and stale inputs have zero Herdr effects", async () => {
	const repository = repo();
	const stateRoot = privateStateRoot();
	const fake = new FakeHerdr();
	await expectCodeAsync("invalid_context", () =>
		assemble({
			contextJson: '{"workspace_id":"w","workspace_id":"x"}',
			stateRoot,
			exec: fake.exec,
			herdrBin: "fake",
		}),
	);
	assert.equal(fake.effects, 0);
	const good = await assemble({
		contextJson: context(repository, "wGood"),
		stateRoot,
		configPath: config(
			repository,
			[{ name: "reviewer", kind: "codex", mode: "read-only" }],
			{},
			stateRoot,
		),
		exec: fake.exec,
		herdrBin: "fake",
		random: deterministicRandom(),
	});
	const before = fake.effects;
	expectCode("bookkeeping_unknown", () =>
		readStatus({
			contextJson: context(repository, "wForeign"),
			stateRoot,
			exec: fake.exec,
			herdrBin: "fake",
		}),
	);
	assert.equal(fake.effects, before);
	await expectCodeAsync("duplicate_active", () =>
		assemble({
			contextJson: context(repository, "wGood"),
			stateRoot,
			configPath: join(repository, ".herdr-conductor.json"),
			exec: fake.exec,
			herdrBin: "fake",
			random: deterministicRandom(90),
		}),
	);
	assert.equal(fake.effects, before);
	assert.ok(good.run_id);
});

test("live status is context-bound and marks changed identity foreign_or_stale", async () => {
	const fixture = await assembledFixture();
	const live = readStatus({
		contextJson: context(fixture.repository, fixture.workspace),
		stateRoot: fixture.stateRoot,
		exec: fixture.fake.exec,
		herdrBin: "fake",
	});
	assert.equal(live.workers[0].status, "idle");
	const agent = fixture.fake.agents.get(fixture.result.workers[0].agent_name);
	agent.workspace_id = "wForeign";
	const stale = readStatus({
		contextJson: context(fixture.repository, fixture.workspace),
		stateRoot: fixture.stateRoot,
		exec: fixture.fake.exec,
		herdrBin: "fake",
	});
	assert.equal(stale.workers[0].status, "foreign_or_stale");
});

test("every run-bound action fails closed after configuration digest change", async () => {
	const fixture = await assembledFixture();
	const before = fixture.fake.effects;
	config(
		fixture.repository,
		[
			{
				name: "builder",
				kind: "codex",
				mode: "write",
				assignment: {
					title: "Changed after assembly",
					mission: "Must fail closed",
					acceptance_criteria: [],
					owned_paths: ["src"],
					forbidden_paths: [],
					required_commands: [],
				},
			},
		],
		{},
		fixture.stateRoot,
	);
	expectCode("stale_task", () =>
		readStatus({
			contextJson: context(fixture.repository, fixture.workspace),
			exec: fixture.fake.exec,
			herdrBin: "fake",
		}),
	);
	assert.equal(fixture.fake.effects, before);
});

test("foreign anchor and cross-repository symlink roots have zero effects", async () => {
	const repository = repo();
	const fake = new FakeHerdr();
	fake.anchorOverride = { workspace_id: "foreign", pane_id: "wB2:p0" };
	const foreignState = join(temp("conductor-b2-state-"), "state");
	await expectCodeAsync("foreign_or_stale", () =>
		assemble({
			contextJson: context(repository),
			stateRoot: foreignState,
			configPath: config(repository, [
				{ name: "reviewer", kind: "codex", mode: "read-only" },
			]),
			exec: fake.exec,
			herdrBin: "fake",
			random: deterministicRandom(),
		}),
	);
	assert.equal(fake.effects, 0);
	assert.equal(existsSync(foreignState), false);

	const missingFake = new FakeHerdr();
	missingFake.anchorOverride = null;
	const missingState = join(temp("conductor-b2-state-"), "state");
	await assert.rejects(() =>
		assemble({
			contextJson: context(repository),
			stateRoot: missingState,
			configPath: join(repository, ".herdr-conductor.json"),
			exec: missingFake.exec,
			herdrBin: "fake",
		}),
	);
	assert.equal(missingFake.effects, 0);
	assert.equal(existsSync(missingState), false);

	const foreignRepository = repo();
	symlinkSync(foreignRepository, join(repository, "linked-worktrees"));
	const symlinkState = join(temp("conductor-b2-state-"), "state");
	const crossRepoFake = new FakeHerdr();
	await expectCodeAsync("invalid_config", () =>
		assemble({
			contextJson: context(repository),
			stateRoot: symlinkState,
			configPath: config(
				repository,
				[{ name: "builder", kind: "pi", mode: "write" }],
				{ worktree_root: "linked-worktrees" },
			),
			exec: crossRepoFake.exec,
			herdrBin: "fake",
			random: deterministicRandom(),
		}),
	);
	assert.equal(crossRepoFake.effects, 0);
	assert.deepEqual(crossRepoFake.log, []);
	assert.equal(existsSync(symlinkState), false);
	assert.equal(
		git(foreignRepository, "worktree", "list").split("\n").length,
		1,
	);

	const target = join(
		repository,
		".conductor-worktrees",
		"r-010101010101010101010101",
		"builder",
	);
	mkdirSync(target, { recursive: true });
	const preexistingState = join(temp("conductor-b2-state-"), "state");
	const preexistingFake = new FakeHerdr();
	await expectCodeAsync("invalid_config", () =>
		assemble({
			contextJson: context(repository),
			stateRoot: preexistingState,
			configPath: config(repository, [
				{ name: "builder", kind: "pi", mode: "write" },
			]),
			exec: preexistingFake.exec,
			herdrBin: "fake",
			random: deterministicRandom(),
		}),
	);
	assert.equal(preexistingFake.effects, 0);
	assert.equal(existsSync(preexistingState), false);
});

test("Stage 2 config rejects unused legacy fields and absolute worktree roots", async () => {
	for (const overrides of [
		{ team: "legacy" },
		{ base_branch: "main" },
		{ worktree_root: temp("external-worktree-root-") },
	]) {
		const repository = repo();
		const fake = new FakeHerdr();
		await expectCodeAsync("invalid_contract", () =>
			assemble({
				contextJson: context(repository),
				stateRoot: join(temp("conductor-b2-state-"), "state"),
				configPath: config(
					repository,
					[{ name: "builder", kind: "pi", mode: "write" }],
					overrides,
				),
				exec: fake.exec,
				herdrBin: "fake",
			}),
		);
		assert.equal(fake.effects, 0);
	}
});

test("pane and agent cwd plus foreground_cwd are independently required", async () => {
	for (const [kind, field] of [
		["pane", "cwd"],
		["pane", "foreground_cwd"],
		["agent", "cwd"],
		["agent", "foreground_cwd"],
	]) {
		const repository = repo();
		const stateRoot = privateStateRoot();
		const fake = new FakeHerdr();
		const original = fake.exec;
		fake.exec = (command, args) => {
			const output = original(command, args);
			if (
				command !== "git" &&
				args[0] === kind &&
				args[1] === "get" &&
				!(kind === "pane" && args[2].endsWith(":p0"))
			) {
				const parsed = JSON.parse(output);
				delete parsed.result[kind][field];
				return JSON.stringify(parsed);
			}
			return output;
		};
		await expectCodeAsync("recovery_required", () =>
			assemble({
				contextJson: context(repository),
				configPath: config(
					repository,
					[{ name: "reviewer", kind: "codex", mode: "read-only" }],
					{},
					stateRoot,
				),
				exec: fake.exec,
				herdrBin: "fake",
				random: deterministicRandom(),
			}),
		);
	}
});

test("exact Herdr 0.7.5 protocol gate rejects other and unparseable runtimes before effects", async () => {
	for (const variant of ["version", "protocol", "unparseable"]) {
		const repository = repo();
		const stateRoot = join(temp("conductor-version-gate-"), "state");
		const fake = new FakeHerdr();
		const gatedExec = (command, args) => {
			if (command === "fake" && args[0] === "--version")
				return variant === "version"
					? "herdr 0.7.6"
					: variant === "unparseable"
						? "unknown"
						: "herdr 0.7.5";
			if (command === "fake" && args[0] === "api")
				return JSON.stringify({
					protocol: variant === "protocol" ? 18 : 17,
					schema_version: 1,
				});
			return fake.exec(command, args);
		};
		await expectCodeAsync("unsupported_herdr", () =>
			assemble({
				contextJson: context(repository),
				stateRoot,
				configPath: config(repository, [
					{ name: "reviewer", kind: "pi", mode: "read-only" },
				]),
				herdrBin: "fake",
				exec: gatedExec,
			}),
		);
		assert.equal(fake.effects, 0, variant);
		assert.equal(existsSync(stateRoot), false, variant);
	}
});

test("plugin context has no CONDUCTOR_REPO or ambient-cwd fallback", () => {
	expectCode("context_unavailable", () => parsePluginContext(""));
	expectCode("invalid_context", () =>
		parsePluginContext(
			JSON.stringify({ workspace_id: "w", workspace_cwd: "." }),
		),
	);
});

import { test } from "node:test";
import {
	assert,
	execFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
	dirname,
	join,
	reconcile,
	standDown,
	loadActiveRun,
	openRepositoryStore,
	git,
	repo,
	context,
	expectCode,
	journalFiles,
	readJournals,
	publishWorkerReport,
	assembledFixture,
} from "./stage1-runtime-helpers.mjs";

const updateRefCount = (fixture) =>
	fixture.fake.log.filter(
		({ args }) => args[2] === "update-ref" || args[4] === "update-ref",
	).length;

async function completedProducer(fixture, filename = "src/implementation.txt") {
	const worker = fixture.result.workers[0];
	mkdirSync(dirname(join(worker.cwd, filename)), { recursive: true });
	writeFileSync(join(worker.cwd, filename), "implemented\n");
	git(worker.cwd, "add", filename);
	git(worker.cwd, "commit", "-qm", `implement ${filename}`);
	await publishWorkerReport(fixture, worker);
	return worker;
}

test("report-first reconcile and stand-down retain Git and product inventory", async () => {
	const fixture = await assembledFixture();
	const worker = await completedProducer(fixture);
	for (const relativePath of [
		"artifacts/result.txt",
		"reports/review.md",
		"logs/run.log",
		"recordings/demo.webm",
		".guard/events.jsonl",
	]) {
		const path = join(fixture.repository, relativePath);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, `${relativePath}\n`);
	}
	const beforeBranches = git(
		fixture.repository,
		"for-each-ref",
		"--format=%(refname)",
		"refs/heads",
	);
	const reconciled = await reconcile({
		contextJson: context(fixture.repository, fixture.workspace),
		stateRoot: fixture.stateRoot,
		exec: fixture.fake.exec,
	});
	assert.equal(reconciled.lifecycle, "integration_harvested_no_gates");
	assert.equal(reconciled.integration.selection.length, 1);
	assert.equal(
		readFileSync(join(fixture.repository, "src/implementation.txt"), "utf8"),
		"implemented\n",
	);
	assert.equal(updateRefCount(fixture), 1);
	const worktreesAfterReconcile = git(
		fixture.repository,
		"worktree",
		"list",
		"--porcelain",
	);
	const stoodDown = await standDown({
		contextJson: context(fixture.repository, fixture.workspace),
		stateRoot: fixture.stateRoot,
		herdrBin: "fake",
		exec: fixture.fake.exec,
		reason: "normal_completion",
	});
	assert.equal(stoodDown.archived, true);
	assert.deepEqual(stoodDown.closed, [worker.pane_id]);
	assert.equal(
		git(
			fixture.repository,
			"for-each-ref",
			"--format=%(refname)",
			"refs/heads",
		),
		beforeBranches,
	);
	assert.equal(
		git(fixture.repository, "worktree", "list", "--porcelain"),
		worktreesAfterReconcile,
	);
	assert.equal(existsSync(worker.cwd), true);
	for (const relativePath of [
		"artifacts/result.txt",
		"reports/review.md",
		"logs/run.log",
		"recordings/demo.webm",
		".guard/events.jsonl",
	])
		assert.equal(existsSync(join(fixture.repository, relativePath)), true);
	const store = openRepositoryStore({
		stateRoot: fixture.stateRoot,
		repoPath: fixture.repository,
	});
	expectCode("state_unknown", () =>
		loadActiveRun(store, { workspaceId: fixture.workspace }),
	);
});

test("source, target, journal, registration, and lock failures perform zero CAS", async () => {
	for (const variant of [
		"source-branch",
		"source-foreign-common-dir",
		"target-branch",
		"target-head",
		"unregistered",
		"journal",
		"lock",
	]) {
		const fixture = await assembledFixture();
		const worker = await completedProducer(fixture);
		let held;
		let reconcileExec = fixture.fake.exec;
		if (variant === "source-branch") git(worker.cwd, "branch", "-m", "foreign");
		if (variant === "source-foreign-common-dir") {
			const recorded = readJournals(fixture.stateRoot).find(
				(entry) => entry.operation_type === "worktree.create",
			).observed_identity;
			const original = `${worker.cwd}-original`;
			execFileSync("mv", [worker.cwd, original]);
			execFileSync("git", ["clone", "-q", fixture.repository, worker.cwd]);
			git(worker.cwd, "update-ref", recorded.branch_ref, recorded.head_sha);
			git(worker.cwd, "symbolic-ref", "HEAD", recorded.branch_ref);
			git(worker.cwd, "reset", "--hard", recorded.head_sha);
		}
		if (variant === "target-branch")
			git(fixture.repository, "branch", "-m", "foreign-target");
		if (variant === "target-head") {
			writeFileSync(join(fixture.repository, "target-drift.txt"), "drift\n");
			git(fixture.repository, "add", "target-drift.txt");
			git(fixture.repository, "commit", "-qm", "target drift");
		}
		if (variant === "unregistered") {
			reconcileExec = (command, args, options) => {
				const output = fixture.fake.exec(command, args, options);
				if (command !== "git" || args[2] !== "worktree") return output;
				return output
					.split(/\n\n+/)
					.filter((block) => !block.includes(`worktree ${worker.cwd}`))
					.join("\n\n");
			};
		}
		if (variant === "journal") {
			const path = journalFiles(fixture.stateRoot)[0];
			const value = JSON.parse(readFileSync(path, "utf8"));
			value.observed_identity.head_sha = "f".repeat(40);
			writeFileSync(path, JSON.stringify(value));
		}
		if (variant === "lock") {
			const kernel = await import("../scripts/state-kernel.mjs");
			held = kernel.acquireRepositoryLock(
				openRepositoryStore({
					stateRoot: fixture.stateRoot,
					repoPath: fixture.repository,
				}),
				{ operationId: "concurrent-test" },
			);
		}
		const before = updateRefCount(fixture);
		const invocation = () =>
			reconcile({
				contextJson: context(fixture.repository, fixture.workspace),
				stateRoot: fixture.stateRoot,
				exec: reconcileExec,
			});
		if (variant === "source-foreign-common-dir") {
			const rejected = await invocation();
			assert.equal(rejected.lifecycle, "delivery_report_rejected", variant);
		} else await assert.rejects(invocation, variant);
		assert.equal(updateRefCount(fixture), before, variant);
		if (held)
			(await import("../scripts/state-kernel.mjs")).releaseRepositoryLock(held);
	}
});

test("source and target races immediately before CAS perform zero CAS", async () => {
	for (const changed of ["source", "target"]) {
		const fixture = await assembledFixture();
		const worker = await completedProducer(fixture, "src/race.txt");
		const before = updateRefCount(fixture);
		let injected = false;
		await assert.rejects(() =>
			reconcile({
				contextJson: context(fixture.repository, fixture.workspace),
				stateRoot: fixture.stateRoot,
				exec: fixture.fake.exec,
				fault(name) {
					if (
						name !== "integration.reconcile:integration.before_cas" ||
						injected
					)
						return;
					injected = true;
					const path = changed === "source" ? worker.cwd : fixture.repository;
					writeFileSync(join(path, `${changed}-race.txt`), "drift\n");
					git(path, "add", `${changed}-race.txt`);
					git(path, "commit", "-qm", `${changed} race`);
				},
			}),
		);
		assert.equal(injected, true, changed);
		assert.equal(updateRefCount(fixture), before, changed);
	}
});

test("post-CAS ref, tracked-worktree, and staged-index drift never publish reconciliation", async () => {
	for (const race of ["ref", "tracked", "staged"]) {
		const fixture = await assembledFixture();
		const worker = await completedProducer(fixture, `src/${race}.txt`);
		let injected = false;
		await assert.rejects(
			() =>
				reconcile({
					contextJson: context(fixture.repository, fixture.workspace),
					stateRoot: fixture.stateRoot,
					exec: fixture.fake.exec,
					fault(name) {
						if (
							name !== "integration.reconcile:journal.after_effect" ||
							injected
						)
							return;
						injected = true;
						if (race === "ref") {
							const current = git(
								fixture.repository,
								"rev-parse",
								"refs/heads/main",
							);
							const actor = git(worker.cwd, "rev-parse", "HEAD");
							git(
								fixture.repository,
								"update-ref",
								"refs/heads/main",
								actor,
								current,
							);
						} else {
							writeFileSync(
								join(fixture.repository, "base.txt"),
								`${race} drift\n`,
							);
							if (race === "staged") git(fixture.repository, "add", "base.txt");
						}
					},
				}),
			(error) => error.code === "recovery_required",
		);
		assert.equal(injected, true, race);
		const entry = readJournals(fixture.stateRoot).find(
			(candidate) => candidate.operation_type === "integration.reconcile",
		);
		assert.equal(entry.phase, "needs_attention", race);
		assert.equal(entry.observed_identity, null, race);
		const attempts = updateRefCount(fixture);
		await assert.rejects(() =>
			reconcile({
				contextJson: context(fixture.repository, fixture.workspace),
				stateRoot: fixture.stateRoot,
				exec: fixture.fake.exec,
			}),
		);
		assert.equal(updateRefCount(fixture), attempts, `${race} replayed CAS`);
	}
});

test("post-CAS synchronization checkpoints preserve concurrent tracked edits and journal no success", async () => {
	for (const checkpoint of [
		"integration.after_cas",
		"integration.before_sync",
		"integration.during_sync",
		"integration.before_observed_publication",
	]) {
		const fixture = await assembledFixture();
		await completedProducer(fixture, `src/${checkpoint.split(".").at(-1)}.txt`);
		const concurrentBytes = `concurrent edit at ${checkpoint}\n`;
		let injected = false;
		await assert.rejects(
			() =>
				reconcile({
					contextJson: context(fixture.repository, fixture.workspace),
					exec: fixture.fake.exec,
					fault(name) {
						if (name !== `integration.reconcile:${checkpoint}` || injected)
							return;
						injected = true;
						writeFileSync(
							join(fixture.repository, "base.txt"),
							concurrentBytes,
						);
					},
				}),
			(error) => error.code === "recovery_required",
		);
		assert.equal(injected, true, checkpoint);
		assert.equal(
			readFileSync(join(fixture.repository, "base.txt"), "utf8"),
			concurrentBytes,
			checkpoint,
		);
		const entry = readJournals(fixture.stateRoot).find(
			(candidate) => candidate.operation_type === "integration.reconcile",
		);
		assert.notEqual(entry.phase, "observed", checkpoint);
		assert.equal(entry.observed_identity, null, checkpoint);
	}
});

test("CAS failure cannot synchronize the target worktree", async () => {
	const fixture = await assembledFixture();
	const worker = await completedProducer(fixture, "src/cas.txt");
	const oldTarget = git(fixture.repository, "rev-parse", "refs/heads/main");
	let externalHead;
	let casAttempts = 0;
	let resetCalls = 0;
	const racingExec = (command, args, options) => {
		if (command === "git" && args[4] === "update-ref") {
			casAttempts++;
			externalHead = git(worker.cwd, "rev-parse", "HEAD");
			git(
				fixture.repository,
				"update-ref",
				"refs/heads/main",
				externalHead,
				oldTarget,
			);
		}
		if (command === "git" && args[2] === "reset") resetCalls++;
		return fixture.fake.exec(command, args, options);
	};
	await assert.rejects(
		() =>
			reconcile({
				contextJson: context(fixture.repository, fixture.workspace),
				stateRoot: fixture.stateRoot,
				exec: racingExec,
			}),
		(error) => error.code === "recovery_required",
	);
	assert.equal(casAttempts, 1);
	assert.equal(resetCalls, 0);
	assert.equal(
		git(fixture.repository, "rev-parse", "refs/heads/main"),
		externalHead,
	);
	assert.equal(existsSync(join(fixture.repository, "src/cas.txt")), false);
});

test("cross-scope callers and conflicting complete producer sets perform zero CAS", async () => {
	const isolated = await assembledFixture();
	for (const [repository, workspace] of [
		[repo(), isolated.workspace],
		[isolated.repository, "wForeign"],
	]) {
		const before = updateRefCount(isolated);
		await assert.rejects(() =>
			reconcile({
				contextJson: context(repository, workspace),
				stateRoot: isolated.stateRoot,
				exec: isolated.fake.exec,
			}),
		);
		assert.equal(updateRefCount(isolated), before);
	}

	const fixture = await assembledFixture({
		roles: ["builder-a", "builder-b"].map((name) => ({
			name,
			kind: "pi",
			mode: "write",
			assignment: {
				title: `Task for ${name}`,
				mission: "Create a deliberate complete-set conflict",
				acceptance_criteria: [],
				owned_paths: ["base.txt"],
				forbidden_paths: [],
				required_commands: [],
			},
		})),
	});
	for (const [index, worker] of fixture.result.workers.entries()) {
		writeFileSync(join(worker.cwd, "base.txt"), `builder-${index}\n`);
		git(worker.cwd, "add", "base.txt");
		git(worker.cwd, "commit", "-qm", `conflict ${index}`);
		await publishWorkerReport(fixture, worker);
	}
	await assert.rejects(() =>
		reconcile({
			contextJson: context(fixture.repository, fixture.workspace),
			stateRoot: fixture.stateRoot,
			exec: fixture.fake.exec,
		}),
	);
	assert.equal(updateRefCount(fixture), 0);
	assert.equal(
		readJournals(fixture.stateRoot).filter(
			(entry) => entry.operation_type === "integration.reconcile",
		).length,
		0,
	);
	for (const worker of fixture.result.workers)
		assert.equal(existsSync(worker.cwd), true);
});

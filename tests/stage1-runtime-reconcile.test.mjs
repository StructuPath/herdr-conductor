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
	assembledFixture,
} from "./stage1-runtime-helpers.mjs";

test("B3 reconcile and stand-down preserve all Git and retained inventory", async () => {
	const fixture = await assembledFixture({
		roles: [{ name: "builder", kind: "pi", mode: "write" }],
	});
	const worker = fixture.result.workers[0];
	writeFileSync(join(worker.cwd, "implementation.txt"), "implemented\n");
	git(worker.cwd, "add", "implementation.txt");
	git(worker.cwd, "commit", "-qm", "implementation");
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
	assert.equal(reconciled.merges.length, 1);
	assert.equal(
		readFileSync(join(fixture.repository, "implementation.txt"), "utf8"),
		"implemented\n",
	);
	const worktreesAfterMerge = git(
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
		worktreesAfterMerge,
	);
	assert.equal(existsSync(worker.cwd), true);
	for (const relativePath of [
		"artifacts/result.txt",
		"reports/review.md",
		"logs/run.log",
		"recordings/demo.webm",
		".guard/events.jsonl",
	])
		assert.equal(
			existsSync(join(fixture.repository, relativePath)),
			true,
			relativePath,
		);
	const store = openRepositoryStore({
		stateRoot: fixture.stateRoot,
		repoPath: fixture.repository,
	});
	expectCode("state_unknown", () =>
		loadActiveRun(store, { workspaceId: fixture.workspace }),
	);
});

test("B3 source/target substitution, unregistered path, corrupt journal, and lock contention perform zero CAS", async () => {
	for (const variant of [
		"source-branch",
		"source-foreign-common-dir",
		"source-unrelated-history",
		"target-branch",
		"target-head",
		"unregistered",
		"journal",
		"lock",
	]) {
		const fixture = await assembledFixture({
			roles: [{ name: "builder", kind: "pi", mode: "write" }],
		});
		const worker = fixture.result.workers[0];
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
		if (variant === "source-unrelated-history") {
			const tree = git(worker.cwd, "write-tree");
			const unrelated = git(worker.cwd, "commit-tree", tree, "-m", "unrelated");
			git(worker.cwd, "reset", "--hard", unrelated);
		}
		if (variant === "target-branch")
			git(fixture.repository, "branch", "-m", "foreign-target");
		if (variant === "target-head") {
			writeFileSync(join(fixture.repository, "target-drift.txt"), "drift\n");
			git(fixture.repository, "add", "target-drift.txt");
			git(fixture.repository, "commit", "-qm", "target drift");
		}
		if (variant === "unregistered") {
			reconcileExec = (command, args) => {
				const output = fixture.fake.exec(command, args);
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
			const store = openRepositoryStore({
				stateRoot: fixture.stateRoot,
				repoPath: fixture.repository,
			});
			const kernel = await import("../scripts/state-kernel.mjs");
			held = kernel.acquireRepositoryLock(store, {
				operationId: "concurrent-test",
			});
		}
		const mergesBefore = fixture.fake.log.filter(
			({ args }) => args[2] === "update-ref",
		).length;
		await assert.rejects(
			() =>
				reconcile({
					contextJson: context(fixture.repository, fixture.workspace),
					stateRoot: fixture.stateRoot,
					exec: reconcileExec,
				}),
			variant,
		);
		assert.equal(
			fixture.fake.log.filter(({ args }) => args[2] === "update-ref").length,
			mergesBefore,
			variant,
		);
		if (held)
			(await import("../scripts/state-kernel.mjs")).releaseRepositoryLock(held);
	}
});

test("B3 injected source and target races at every final-read/CAS boundary perform zero CAS", async () => {
	for (const changed of ["source", "target"])
		for (const boundary of [
			"after_final_source_read",
			"after_final_target_read",
			"before_cas",
		]) {
			const fixture = await assembledFixture({
				roles: [{ name: "builder", kind: "pi", mode: "write" }],
			});
			const worker = fixture.result.workers[0];
			writeFileSync(join(worker.cwd, "initial.txt"), "initial\n");
			git(worker.cwd, "add", "initial.txt");
			git(worker.cwd, "commit", "-qm", "initial source");
			let injected = false;
			const casBefore = fixture.fake.log.filter(
				({ args }) => args[2] === "update-ref",
			).length;
			await assert.rejects(() =>
				reconcile({
					contextJson: context(fixture.repository, fixture.workspace),
					stateRoot: fixture.stateRoot,
					exec: fixture.fake.exec,
					fault(name) {
						if (name !== `git.merge:${boundary}` || injected) return;
						injected = true;
						const path = changed === "source" ? worker.cwd : fixture.repository;
						writeFileSync(join(path, `${changed}-${boundary}.txt`), "drift\n");
						git(path, "add", `${changed}-${boundary}.txt`);
						git(path, "commit", "-qm", `${changed} ${boundary}`);
					},
				}),
			);
			assert.equal(injected, true, `${changed}:${boundary}`);
			assert.equal(
				fixture.fake.log.filter(({ args }) => args[2] === "update-ref").length,
				casBefore,
				`${changed}:${boundary}`,
			);
		}
});

test("B3 post-CAS drift never publishes an observed merge result", async () => {
	for (const boundary of [
		"after_cas",
		"during_worktree_sync",
		"before_result_publication",
		"journal.after_effect",
	]) {
		const fixture = await assembledFixture({
			roles: [{ name: "builder", kind: "pi", mode: "write" }],
		});
		const worker = fixture.result.workers[0];
		writeFileSync(join(worker.cwd, "post-cas.txt"), `${boundary}\n`);
		git(worker.cwd, "add", "post-cas.txt");
		git(worker.cwd, "commit", "-qm", `source ${boundary}`);
		const actorHead = git(worker.cwd, "rev-parse", "HEAD");
		let injected = false;
		await assert.rejects(
			() =>
				reconcile({
					contextJson: context(fixture.repository, fixture.workspace),
					stateRoot: fixture.stateRoot,
					exec: fixture.fake.exec,
					fault(name) {
						if (name !== `git.merge:${boundary}` || injected) return;
						injected = true;
						const conductorHead = git(
							fixture.repository,
							"rev-parse",
							"refs/heads/main",
						);
						git(
							fixture.repository,
							"update-ref",
							"refs/heads/main",
							actorHead,
							conductorHead,
						);
					},
				}),
			(error) => {
				assert.equal(error.code, "recovery_required");
				assert.equal(error.actualIdentity.ref_sha, actorHead);
				assert.notEqual(error.expectedIdentity.ref_sha, actorHead);
				assert.match(error.cause.message, /expected .* actual/);
				return true;
			},
		);
		assert.equal(injected, true, boundary);
		assert.equal(
			git(fixture.repository, "rev-parse", "refs/heads/main"),
			actorHead,
			boundary,
		);
		const merges = readJournals(fixture.stateRoot).filter(
			(entry) => entry.operation_type === "git.merge",
		);
		assert.equal(merges.length, 1, boundary);
		assert.equal(merges[0].phase, "needs_attention", boundary);
		assert.equal(merges[0].observed_identity, null, boundary);
	}
});

test("B3 concurrent tracked edits after CAS, during sync, and before result are preserved and unobserved", async () => {
	for (const race of [
		"after_cas",
		"during_sync",
		"before_result_publication",
		"journal_after_effect",
	]) {
		const fixture = await assembledFixture({
			roles: [{ name: "builder", kind: "pi", mode: "write" }],
		});
		const worker = fixture.result.workers[0];
		writeFileSync(join(worker.cwd, "merged.txt"), `${race}\n`);
		git(worker.cwd, "add", "merged.txt");
		git(worker.cwd, "commit", "-qm", `source ${race}`);
		const concurrentContent = `concurrent ${race}\n`;
		let injected = false;
		const injectTrackedEdit = () => {
			if (injected) return;
			injected = true;
			writeFileSync(join(fixture.repository, "base.txt"), concurrentContent);
		};
		const racingExec = (command, args) => {
			if (
				race === "during_sync" &&
				command === "git" &&
				args[2] === "read-tree" &&
				args[3] !== "-n"
			)
				injectTrackedEdit();
			return fixture.fake.exec(command, args);
		};
		await assert.rejects(
			() =>
				reconcile({
					contextJson: context(fixture.repository, fixture.workspace),
					stateRoot: fixture.stateRoot,
					exec: racingExec,
					fault(name) {
						if (
							(race === "after_cas" && name === "git.merge:after_cas") ||
							(race === "before_result_publication" &&
								name === "git.merge:before_result_publication") ||
							(race === "journal_after_effect" &&
								name === "git.merge:journal.after_effect")
						)
							injectTrackedEdit();
					},
				}),
			(error) => error.code === "recovery_required",
		);
		assert.equal(injected, true, race);
		assert.equal(
			readFileSync(join(fixture.repository, "base.txt"), "utf8"),
			concurrentContent,
			race,
		);
		const merge = readJournals(fixture.stateRoot).find(
			(entry) => entry.operation_type === "git.merge",
		);
		assert.equal(merge.phase, "needs_attention", race);
		assert.equal(merge.observed_identity, null, race);
	}
});

test("B3 post-CAS staged index race reaches the publication guard without replay", async () => {
	const fixture = await assembledFixture({
		roles: [{ name: "builder", kind: "pi", mode: "write" }],
	});
	const worker = fixture.result.workers[0];
	writeFileSync(join(worker.cwd, "staged-race.txt"), "merged\n");
	git(worker.cwd, "add", "staged-race.txt");
	git(worker.cwd, "commit", "-qm", "staged race source");
	const stagedContent = "same-user staged edit\n";
	let injected = false;
	await assert.rejects(
		() =>
			reconcile({
				contextJson: context(fixture.repository, fixture.workspace),
				stateRoot: fixture.stateRoot,
				exec: fixture.fake.exec,
				fault(name) {
					if (name !== "git.merge:journal.after_effect" || injected) return;
					injected = true;
					writeFileSync(join(fixture.repository, "base.txt"), stagedContent);
					git(fixture.repository, "add", "base.txt");
				},
			}),
		(error) => {
			assert.equal(error.code, "recovery_required");
			assert.match(
				error.cause.message,
				/index changed before result publication/,
			);
			return true;
		},
	);
	assert.equal(injected, true);
	assert.equal(
		readFileSync(join(fixture.repository, "base.txt"), "utf8"),
		stagedContent,
	);
	assert.equal(
		git(fixture.repository, "show", ":base.txt"),
		stagedContent.trim(),
	);
	const merge = readJournals(fixture.stateRoot).find(
		(entry) => entry.operation_type === "git.merge",
	);
	assert.equal(merge.phase, "needs_attention");
	assert.equal(merge.observed_identity, null);
	assert.equal(
		readJournals(fixture.stateRoot).filter(
			(entry) =>
				entry.operation_type === "git.merge" && entry.phase === "observed",
		).length,
		0,
	);
	const synchronizationCalls = fixture.fake.log.filter(
		({ args }) => args[2] === "read-tree" && args[3] !== "-n",
	).length;
	await assert.rejects(
		() =>
			reconcile({
				contextJson: context(fixture.repository, fixture.workspace),
				stateRoot: fixture.stateRoot,
				exec: fixture.fake.exec,
			}),
		(error) => error.code === "recovery_required",
	);
	assert.equal(
		fixture.fake.log.filter(
			({ args }) => args[2] === "read-tree" && args[3] !== "-n",
		).length,
		synchronizationCalls,
	);
	assert.equal(
		git(fixture.repository, "show", ":base.txt"),
		stagedContent.trim(),
	);
});

test("B3 CAS failure cannot install the computed merge commit or update the worktree", async () => {
	const fixture = await assembledFixture({
		roles: [{ name: "builder", kind: "pi", mode: "write" }],
	});
	const worker = fixture.result.workers[0];
	writeFileSync(join(worker.cwd, "cas.txt"), "source\n");
	git(worker.cwd, "add", "cas.txt");
	git(worker.cwd, "commit", "-qm", "CAS source");
	const oldTarget = git(fixture.repository, "rev-parse", "refs/heads/main");
	let externalHead;
	let casAttempts = 0;
	let readTreeCalls = 0;
	const racingExec = (command, args) => {
		if (command === "git" && args[2] === "update-ref") {
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
		if (command === "git" && args[2] === "read-tree" && args[3] !== "-n")
			readTreeCalls++;
		return fixture.fake.exec(command, args);
	};
	await assert.rejects(
		() =>
			reconcile({
				contextJson: context(fixture.repository, fixture.workspace),
				stateRoot: fixture.stateRoot,
				exec: racingExec,
			}),
		/explicit recovery/,
	);
	assert.equal(casAttempts, 1);
	assert.equal(readTreeCalls, 0);
	assert.equal(
		git(fixture.repository, "rev-parse", "refs/heads/main"),
		externalHead,
	);
	assert.equal(existsSync(join(fixture.repository, "cas.txt")), false);
});

test("B3 a second repository/workspace cannot select or mutate the active run", async () => {
	const fixture = await assembledFixture({
		roles: [{ name: "builder", kind: "pi", mode: "write" }],
	});
	for (const [repository, workspace] of [
		[repo(), fixture.workspace],
		[fixture.repository, "wForeign"],
	]) {
		const before = fixture.fake.log.filter(
			({ args }) => args[2] === "update-ref",
		).length;
		await assert.rejects(() =>
			reconcile({
				contextJson: context(repository, workspace),
				stateRoot: fixture.stateRoot,
				exec: fixture.fake.exec,
			}),
		);
		assert.equal(
			fixture.fake.log.filter(({ args }) => args[2] === "update-ref").length,
			before,
		);
		const closesBefore = fixture.fake.log.filter(
			({ args }) => args[0] === "pane" && args[1] === "close",
		).length;
		await assert.rejects(() =>
			standDown({
				contextJson: context(repository, workspace),
				stateRoot: fixture.stateRoot,
				herdrBin: "fake",
				exec: fixture.fake.exec,
			}),
		);
		assert.equal(
			fixture.fake.log.filter(
				({ args }) => args[0] === "pane" && args[1] === "close",
			).length,
			closesBefore,
		);
	}
});

test("real plumbing conflict preserves state and both worktrees without replay", async () => {
	const fixture = await assembledFixture({
		roles: [
			{ name: "builder-a", kind: "pi", mode: "write" },
			{ name: "builder-b", kind: "pi", mode: "write" },
		],
	});
	for (const [index, worker] of fixture.result.workers.entries()) {
		writeFileSync(join(worker.cwd, "base.txt"), `builder-${index}\n`);
		git(worker.cwd, "add", "base.txt");
		git(worker.cwd, "commit", "-qm", `conflict ${index}`);
	}
	await assert.rejects(
		() =>
			reconcile({
				contextJson: context(fixture.repository, fixture.workspace),
				stateRoot: fixture.stateRoot,
				exec: fixture.fake.exec,
			}),
		/explicit recovery/,
	);
	const casCount = fixture.fake.log.filter(
		({ args }) => args[2] === "update-ref",
	).length;
	assert.equal(casCount, 1);
	assert.equal(existsSync(fixture.result.workers[0].cwd), true);
	assert.equal(existsSync(fixture.result.workers[1].cwd), true);
	assert.equal(
		readJournals(fixture.stateRoot).filter(
			(entry) =>
				entry.operation_type === "git.merge" &&
				entry.phase === "needs_attention",
		).length,
		1,
	);
	await assert.rejects(() =>
		reconcile({
			contextJson: context(fixture.repository, fixture.workspace),
			stateRoot: fixture.stateRoot,
			exec: fixture.fake.exec,
		}),
	);
	assert.equal(
		fixture.fake.log.filter(({ args }) => args[2] === "update-ref").length,
		casCount,
	);
});

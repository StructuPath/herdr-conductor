import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	linkSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	acquireRepositoryLock,
	createRun,
	inspectRepositoryLock,
	loadActiveRun,
	openRepositoryStore,
	performJournaledOperation,
	publishExclusiveJson,
	readPrivateJson,
	releaseRepositoryLock,
	resolveGitCommonDirectory,
	writeAtomicJson,
} from "../scripts/state-kernel.mjs";
import {
	StateKernelError,
	parseStrictJsonBytes,
	validateActiveRun,
	validateJournalEntry,
	validateRepositoryDocument,
} from "../scripts/private-state-schema.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const LOCK_CHILD = join(ROOT, "tests/fixtures/state-lock-child.mjs");
const GENERATION = "a".repeat(32);
const SUBJECT_GENERATION = "b".repeat(32);
const REQUEST_DIGEST = "c".repeat(64);
const RESULT_DIGEST = "d".repeat(64);
const trash = [];

function temp(prefix = "conductor-b1-") {
	const path = mkdtempSync(join(tmpdir(), prefix));
	trash.push(path);
	return path;
}

process.on("exit", () => {
	for (const path of trash) rmSync(path, { recursive: true, force: true });
});

function git(cwd, ...args) {
	const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
	assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
	return result.stdout.trim();
}

function gitRepo() {
	const path = temp("conductor-b1-repo-");
	spawnSync("git", ["init", "-q", "-b", "main", path]);
	git(path, "config", "user.name", "Conductor B1 Test");
	git(path, "config", "user.email", "conductor-b1@example.invalid");
	writeFileSync(join(path, "README.md"), "base\n");
	git(path, "add", "README.md");
	git(path, "commit", "-qm", "init");
	return path;
}

function setup() {
	const repo = gitRepo();
	const stateRoot = join(temp("conductor-b1-state-parent-"), "state");
	const store = openRepositoryStore({ stateRoot, repoPath: repo });
	return { repo, stateRoot, store, forkSha: git(repo, "rev-parse", "HEAD") };
}

function writeStateFixture(path, value) {
	writeFileSync(path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
	chmodSync(path, 0o600);
}

function expectCode(code, fn) {
	assert.throws(
		fn,
		(error) => error instanceof StateKernelError && error.code === code,
	);
}

async function expectCodeAsync(code, fn) {
	await assert.rejects(
		fn,
		(error) => error instanceof StateKernelError && error.code === code,
	);
}

function startRun(context, overrides = {}) {
	const lock = acquireRepositoryLock(context.store, {
		operationId: overrides.lockOperation ?? "create-run",
	});
	const run = createRun(lock, {
		workspaceId: overrides.workspaceId ?? "wB1",
		runId: overrides.runId ?? "run-b1",
		generation: overrides.generation ?? GENERATION,
		forkSha: context.forkSha,
		fault: overrides.fault,
	});
	return { lock, run };
}

function operation(overrides = {}) {
	return {
		workspaceId: "wB1",
		runId: "run-b1",
		runGeneration: GENERATION,
		operationId: "create-builder-pane",
		operationType: "pane.create",
		subject: { kind: "pane", id: "builder", generation: SUBJECT_GENERATION },
		requestDigest: REQUEST_DIGEST,
		...overrides,
	};
}

test("physical Git common-directory identity is shared by linked worktrees and differs by clone", () => {
	const repo = gitRepo();
	const worktree = temp("conductor-b1-worktree-");
	git(repo, "worktree", "add", "-q", "-b", "test-worktree", worktree);
	const mainIdentity = resolveGitCommonDirectory(repo);
	const worktreeIdentity = resolveGitCommonDirectory(worktree);
	assert.deepEqual(mainIdentity.repository, worktreeIdentity.repository);
	assert.notEqual(mainIdentity.repositoryRoot, worktreeIdentity.repositoryRoot);
	const clone = temp("conductor-b1-clone-");
	spawnSync("git", ["clone", "-q", repo, clone]);
	assert.notEqual(
		resolveGitCommonDirectory(clone).repository.key,
		mainIdentity.repository.key,
	);
});

test("store creates only private v1 state and ignores executable legacy inventory", () => {
	const repo = gitRepo();
	const parent = temp("conductor-b1-legacy-");
	const stateRoot = join(parent, "state");
	mkdirSync(stateRoot, { mode: 0o700 });
	const legacy = join(stateRoot, "run-legacy");
	mkdirSync(legacy, { mode: 0o700 });
	const marker = join(parent, "executed");
	writeFileSync(join(legacy, "worker.env"), `PANE=$(touch ${marker})\n`, {
		mode: 0o600,
	});
	const store = openRepositoryStore({ stateRoot, repoPath: repo });
	assert.equal(existsSync(marker), false);
	assert.ok(existsSync(join(store.repositoryDir, "identity.json")));
	assert.equal(
		readFileSync(join(legacy, "worker.env"), "utf8"),
		`PANE=$(touch ${marker})\n`,
	);
	assert.equal(lstatSync(stateRoot).mode & 0o777, 0o700);
	assert.equal(
		lstatSync(join(store.repositoryDir, "identity.json")).mode & 0o777,
		0o600,
	);
});

test("store rejects foreign repository identity and unknown pre-existing permissions", () => {
	const context = setup();
	const documentPath = join(context.store.repositoryDir, "identity.json");
	const document = readPrivateJson(documentPath, validateRepositoryDocument, {
		root: context.stateRoot,
	});
	const foreign = structuredClone(document);
	foreign.repository.common_dir.inode = String(
		BigInt(foreign.repository.common_dir.inode) + 1n,
	);
	writeAtomicJson(documentPath, foreign, validateRepositoryDocument, {
		root: context.stateRoot,
	});
	expectCode("foreign_repository", () =>
		openRepositoryStore({
			stateRoot: context.stateRoot,
			repoPath: context.repo,
		}),
	);

	const legacyRoot = join(temp("conductor-b1-legacy-parent-"), "state");
	mkdirSync(legacyRoot, { mode: 0o755 });
	const isolated = openRepositoryStore({
		stateRoot: legacyRoot,
		repoPath: context.repo,
	});
	assert.equal(isolated.stateRoot, join(legacyRoot, "v1"));
	assert.equal(lstatSync(legacyRoot).mode & 0o777, 0o755);
	assert.equal(lstatSync(isolated.stateRoot).mode & 0o777, 0o700);
});

test("no-follow reads reject symlinks, wrong modes, duplicate keys, and non-regular leaves", () => {
	const context = setup();
	const source = join(context.store.repositoryDir, "identity.json");
	const link = join(context.store.repositoryDir, "identity-link.json");
	symlinkSync(source, link);
	expectCode("state_symlink", () =>
		readPrivateJson(link, validateRepositoryDocument, {
			root: context.stateRoot,
		}),
	);

	chmodSync(source, 0o644);
	expectCode("state_permissions", () =>
		readPrivateJson(source, validateRepositoryDocument, {
			root: context.stateRoot,
		}),
	);
	chmodSync(source, 0o600);

	const hardlink = join(context.store.repositoryDir, "identity-hardlink.json");
	linkSync(source, hardlink);
	expectCode("bookkeeping_unknown", () =>
		readPrivateJson(source, validateRepositoryDocument, {
			root: context.stateRoot,
		}),
	);
	unlinkSync(hardlink);

	const duplicate = join(context.store.repositoryDir, "duplicate.json");
	writeFileSync(
		duplicate,
		'{"document_type":"herdr-conductor-repository","document_type":"herdr-conductor-repository","schema_version":1,"repository":{}}\n',
		{ mode: 0o600 },
	);
	expectCode("duplicate_json_key", () =>
		readPrivateJson(duplicate, validateRepositoryDocument, {
			root: context.stateRoot,
		}),
	);

	const directoryLeaf = join(context.store.repositoryDir, "directory.json");
	mkdirSync(directoryLeaf, { mode: 0o700 });
	expectCode("bookkeeping_unknown", () =>
		readPrivateJson(directoryLeaf, validateRepositoryDocument, {
			root: context.stateRoot,
		}),
	);
});

test("repository lock has one owner, refuses contention, and never adopts malformed state", () => {
	const context = setup();
	assert.equal(inspectRepositoryLock(context.store).status, "unlocked");
	const lock = acquireRepositoryLock(context.store, { operationId: "first" });
	assert.equal(
		inspectRepositoryLock(context.store).owner.lock_id,
		lock.owner.lock_id,
	);
	expectCode("lock_busy", () =>
		acquireRepositoryLock(context.store, { operationId: "second" }),
	);
	releaseRepositoryLock(lock);
	assert.equal(inspectRepositoryLock(context.store).status, "unlocked");

	mkdirSync(context.store.lockDir, { mode: 0o700 });
	expectCode("lock_unknown", () =>
		acquireRepositoryLock(context.store, { operationId: "third" }),
	);
});

test("repository lock race produces exactly one winner", async () => {
	const context = setup();
	const children = Array.from({ length: 5 }, (_, index) =>
		spawn(
			process.execPath,
			[LOCK_CHILD, context.stateRoot, context.repo, `race-${index}`],
			{
				stdio: ["ignore", "pipe", "pipe"],
			},
		),
	);
	const outputs = await Promise.all(
		children.map(
			(child) =>
				new Promise((resolve, reject) => {
					let stdout = "";
					let stderr = "";
					child.stdout.on("data", (chunk) => (stdout += chunk));
					child.stderr.on("data", (chunk) => (stderr += chunk));
					child.on("error", reject);
					child.on("close", (code) => {
						if (code === 0) resolve(stdout.trim());
						else reject(new Error(stderr || `child exited ${code}`));
					});
				}),
		),
	);
	assert.equal(
		outputs.filter((value) => value === "winner").length,
		1,
		outputs.join(", "),
	);
	assert.equal(
		outputs.filter((value) => value === "lock_busy" || value === "lock_unknown")
			.length,
		4,
	);
});

test("run creation and load bind repository, workspace, run, and generation", () => {
	const context = setup();
	const { lock } = startRun(context);
	const active = loadActiveRun(context.store, {
		workspaceId: "wB1",
		expectedRunId: "run-b1",
		expectedGeneration: GENERATION,
	});
	assert.equal(active.state.fork_sha, context.forkSha);
	expectCode("foreign_run", () =>
		loadActiveRun(context.store, {
			workspaceId: "wB1",
			expectedRunId: "foreign",
			expectedGeneration: GENERATION,
		}),
	);
	expectCode("stale_generation", () =>
		loadActiveRun(context.store, {
			workspaceId: "wB1",
			expectedRunId: "run-b1",
			expectedGeneration: "f".repeat(32),
		}),
	);
	expectCode("bookkeeping_unknown", () =>
		loadActiveRun(context.store, { workspaceId: "foreign" }),
	);
	releaseRepositoryLock(lock);
});

test("any additional non-archived run state blocks effects", async () => {
	for (const [status, generation] of [
		["initializing", "e".repeat(32)],
		["needs_attention", "f".repeat(32)],
	]) {
		const context = setup();
		const { lock, run } = startRun(context);
		const runId = `orphan-${status}`;
		const runDirectory = join(run.workspace.runsDir, runId);
		const generationDirectory = join(runDirectory, generation);
		mkdirSync(runDirectory, { mode: 0o700 });
		mkdirSync(generationDirectory, { mode: 0o700 });
		mkdirSync(join(generationDirectory, "operations"), { mode: 0o700 });
		mkdirSync(join(generationDirectory, "operation-guards"), { mode: 0o700 });
		writeStateFixture(join(generationDirectory, "run.json"), {
			...run.state,
			revision: 0,
			run_id: runId,
			generation,
			status,
			journal_sequence: 0,
			journal_head: null,
		});
		let effects = 0;
		await expectCodeAsync("bookkeeping_unknown", () =>
			performJournaledOperation(lock, {
				...operation(),
				effect: async () => {
					effects++;
					return { resultDigest: RESULT_DIGEST };
				},
			}),
		);
		assert.equal(effects, 0, status);
	}
});

test("renamed active pointers and run directories are not authoritative", () => {
	for (const target of ["pointer", "run-directory"]) {
		const context = setup();
		const { lock, run } = startRun(context);
		if (target === "pointer") {
			renameSync(
				run.pointerPath,
				join(run.workspace.activeDir, "renamed.json"),
			);
		} else {
			renameSync(
				join(run.workspace.runsDir, "run-b1"),
				join(run.workspace.runsDir, "renamed-run"),
			);
		}
		expectCode("bookkeeping_unknown", () =>
			loadActiveRun(context.store, { workspaceId: "wB1" }),
		);
		releaseRepositoryLock(lock);
	}
});

test("malformed, extra-key, wrong-version, and foreign active state never reach an effect", async () => {
	const fixtures = [
		["malformed", "invalid_json", () => "{\n"],
		[
			"extra",
			"invalid_state",
			(pointer) => ({ ...pointer, command: "touch /tmp/never" }),
		],
		[
			"version",
			"wrong_version",
			(pointer) => ({ ...pointer, schema_version: 2 }),
		],
		[
			"repository",
			"foreign_repository",
			(pointer) => ({ ...pointer, repository_key: "f".repeat(64) }),
		],
		[
			"workspace",
			"foreign_workspace",
			(pointer) => ({ ...pointer, workspace_id: "wForeign" }),
		],
	];
	for (const [name, code, mutate] of fixtures) {
		const context = setup();
		const { lock, run } = startRun(context);
		const pointer = readPrivateJson(run.pointerPath, validateActiveRun, {
			root: context.stateRoot,
		});
		const mutated = mutate(pointer);
		writeFileSync(
			run.pointerPath,
			typeof mutated === "string" ? mutated : `${JSON.stringify(mutated)}\n`,
			{ mode: 0o600 },
		);
		chmodSync(run.pointerPath, 0o600);
		let effects = 0;
		await expectCodeAsync(code, () =>
			performJournaledOperation(lock, {
				...operation(),
				effect: async () => {
					effects++;
					return { resultDigest: RESULT_DIGEST };
				},
			}),
		);
		assert.equal(effects, 0, name);
	}
});

test("duplicate active pointers and orphan active state fail closed", () => {
	const context = setup();
	const { lock, run } = startRun(context);
	const pointer = readPrivateJson(run.pointerPath, validateActiveRun, {
		root: context.stateRoot,
	});
	const duplicateGeneration = "e".repeat(32);
	writeStateFixture(
		join(run.workspace.activeDir, `run-other--${duplicateGeneration}.json`),
		{
			...pointer,
			run_id: "run-other",
			generation: duplicateGeneration,
		},
	);
	expectCode("duplicate_active", () =>
		loadActiveRun(context.store, { workspaceId: "wB1" }),
	);
	releaseRepositoryLock(lock);

	const orphanContext = setup();
	const orphanLock = acquireRepositoryLock(orphanContext.store, {
		operationId: "orphan",
	});
	expectCode("durability_unknown", () =>
		createRun(orphanLock, {
			workspaceId: "wB1",
			runId: "run-b1",
			generation: GENERATION,
			forkSha: orphanContext.forkSha,
			fault(name) {
				if (name === "run.after_state_durable") throw new Error("crash");
			},
		}),
	);
	expectCode("bookkeeping_unknown", () =>
		loadActiveRun(orphanContext.store, { workspaceId: "wB1" }),
	);
});

test("activation publication faults never silently adopt an intermediate run", () => {
	for (const [boundary, loadCode] of [
		["active_pointer.after_publish", "bookkeeping_unknown"],
		["active_pointer.after_directory_fsync", "recovery_required"],
		["run_activate.after_publish", "recovery_required"],
	]) {
		const context = setup();
		const lock = acquireRepositoryLock(context.store, {
			operationId: `activation-${boundary}`,
		});
		expectCode("durability_unknown", () =>
			createRun(lock, {
				workspaceId: "wB1",
				runId: "run-b1",
				generation: GENERATION,
				forkSha: context.forkSha,
				fault(name) {
					if (name === boundary) throw new Error(`fault at ${boundary}`);
				},
			}),
		);
		expectCode(loadCode, () =>
			loadActiveRun(context.store, { workspaceId: "wB1" }),
		);
	}
});

test("pre-intent durability failure performs zero external effects", async () => {
	const context = setup();
	const { lock } = startRun(context);
	let effects = 0;
	await expectCodeAsync("durability_unknown", () =>
		performJournaledOperation(lock, {
			...operation(),
			fault(name) {
				if (name === "journal_intent.after_temp_write")
					throw new Error("disk fault");
			},
			effect: async () => {
				effects++;
				return { resultDigest: RESULT_DIGEST };
			},
		}),
	);
	assert.equal(effects, 0);
	assert.equal(
		loadActiveRun(context.store, { workspaceId: "wB1" }).journal.length,
		0,
	);
	releaseRepositoryLock(lock);
});

test("every intent publication fault performs zero external effects and leaves fail-closed state", async () => {
	const cases = [
		["journal_intent.before_temp_open", null],
		["journal_intent.after_temp_write", null],
		["journal_intent.after_file_fsync", null],
		["journal_intent.after_publish", "bookkeeping_unknown"],
		["journal_intent.after_directory_fsync", "bookkeeping_unknown"],
		["journal_head.after_temp_write", "bookkeeping_unknown"],
		["journal_head.after_publish", "recovery_required"],
		["journal_head.after_directory_fsync", "recovery_required"],
		[
			"journal_guard_publish.after_publish",
			"bookkeeping_unknown",
			"recovery_required",
		],
		[
			"journal_guard_publish.after_directory_fsync",
			"recovery_required",
			"recovery_required",
		],
	];
	for (const [
		boundary,
		reopenCode,
		operationCode = "durability_unknown",
	] of cases) {
		const context = setup();
		const { lock } = startRun(context);
		let effects = 0;
		await expectCodeAsync(operationCode, () =>
			performJournaledOperation(lock, {
				...operation(),
				fault(name) {
					if (name === boundary) throw new Error(`fault at ${boundary}`);
				},
				effect: async () => {
					effects++;
					return { resultDigest: RESULT_DIGEST };
				},
			}),
		);
		assert.equal(effects, 0, boundary);
		if (reopenCode)
			expectCode(reopenCode, () =>
				loadActiveRun(context.store, { workspaceId: "wB1" }),
			);
		else
			assert.equal(
				loadActiveRun(context.store, { workspaceId: "wB1" }).journal.length,
				0,
			);
	}
});

test("a lock publication fault leaves unknown ownership and cannot be adopted", () => {
	const context = setup();
	expectCode("durability_unknown", () =>
		acquireRepositoryLock(context.store, {
			operationId: "faulted-lock",
			fault(name) {
				if (name === "lock_owner.after_temp_write")
					throw new Error("disk fault");
			},
		}),
	);
	expectCode("lock_unknown", () => inspectRepositoryLock(context.store));
	expectCode("lock_unknown", () =>
		acquireRepositoryLock(context.store, { operationId: "do-not-adopt" }),
	);
});

test("durable intent without an effect blocks replay and requires recovery", async () => {
	const context = setup();
	const { lock } = startRun(context);
	let effects = 0;
	await expectCodeAsync("recovery_required", () =>
		performJournaledOperation(lock, {
			...operation(),
			fault(name) {
				if (name === "journal.after_intent_durable") throw new Error("crash");
			},
			effect: async () => {
				effects++;
				return { resultDigest: RESULT_DIGEST };
			},
		}),
	);
	assert.equal(effects, 0);
	expectCode("recovery_required", () =>
		loadActiveRun(context.store, { workspaceId: "wB1" }),
	);
	await expectCodeAsync("recovery_required", () =>
		performJournaledOperation(lock, {
			...operation(),
			effect: async () => {
				effects++;
				return { resultDigest: RESULT_DIGEST };
			},
		}),
	);
	assert.equal(effects, 0);
});

test("effect failure or post-effect fault is journaled as needs_attention and never replayed", async () => {
	for (const failure of ["effect", "after_effect"]) {
		const context = setup();
		const { lock } = startRun(context);
		let effects = 0;
		await expectCodeAsync("recovery_required", () =>
			performJournaledOperation(lock, {
				...operation(),
				fault(name) {
					if (failure === "after_effect" && name === "journal.after_effect")
						throw new Error("crash");
				},
				effect: async () => {
					effects++;
					if (failure === "effect")
						throw new Error("command failed ambiguously");
					return { resultDigest: RESULT_DIGEST };
				},
			}),
		);
		assert.equal(effects, 1);
		expectCode("recovery_required", () =>
			loadActiveRun(context.store, { workspaceId: "wB1" }),
		);
	}
});

test("lost lock ownership after an effect prevents result publication and blocks replay", async () => {
	const context = setup();
	const { lock } = startRun(context);
	let effects = 0;
	await expectCodeAsync("recovery_required", () =>
		performJournaledOperation(lock, {
			...operation(),
			effect: async () => {
				effects++;
				releaseRepositoryLock(lock);
				return { resultDigest: RESULT_DIGEST };
			},
		}),
	);
	assert.equal(effects, 1);
	assert.equal(inspectRepositoryLock(context.store).status, "unlocked");
	expectCode("recovery_required", () =>
		loadActiveRun(context.store, { workspaceId: "wB1" }),
	);
});

test("operation type and recorded resource generation are checked before an effect", async () => {
	const context = setup();
	const { lock } = startRun(context);
	let effects = 0;
	for (const [code, overrides] of [
		[
			"invalid_state",
			{
				operationType: "git.merge",
				subject: { kind: "git", id: "builder", generation: SUBJECT_GENERATION },
			},
		],
		["stale_generation", { operationType: "pane.close" }],
		[
			"stale_generation",
			{
				operationType: "run.archive",
				subject: { kind: "run", id: "run-b1", generation: "f".repeat(32) },
			},
		],
	]) {
		await expectCodeAsync(code, () =>
			performJournaledOperation(lock, {
				...operation(overrides),
				effect: async () => {
					effects++;
					return { resultDigest: RESULT_DIGEST };
				},
			}),
		);
	}
	assert.equal(effects, 0);
	releaseRepositoryLock(lock);
});

test("durable observed result is returned on retry without a second effect", async () => {
	const context = setup();
	const { lock } = startRun(context);
	let effects = 0;
	const first = await performJournaledOperation(lock, {
		...operation(),
		effect: async () => {
			effects++;
			return { resultDigest: RESULT_DIGEST };
		},
	});
	assert.deepEqual(first, {
		replayed: false,
		resultDigest: RESULT_DIGEST,
		sequence: 1,
	});
	const retry = await performJournaledOperation(lock, {
		...operation(),
		effect: async () => {
			effects++;
			return { resultDigest: "e".repeat(64) };
		},
	});
	assert.deepEqual(retry, {
		replayed: true,
		resultDigest: RESULT_DIGEST,
		sequence: 1,
	});
	assert.equal(effects, 1);
	await expectCodeAsync("operation_conflict", () =>
		performJournaledOperation(lock, {
			...operation({ requestDigest: "f".repeat(64) }),
			effect: async () => ({ resultDigest: RESULT_DIGEST }),
		}),
	);
	releaseRepositoryLock(lock);
});

test("operation IDs ending in .guard do not collide with the guard namespace", async () => {
	const context = setup();
	const { lock } = startRun(context);
	let effects = 0;
	const guardedName = operation({ operationId: "valid.guard" });
	await performJournaledOperation(lock, {
		...guardedName,
		effect: async () => {
			effects++;
			return { resultDigest: RESULT_DIGEST };
		},
	});
	const active = loadActiveRun(context.store, { workspaceId: "wB1" });
	assert.equal(active.journal[0].operation_id, "valid.guard");
	const retry = await performJournaledOperation(lock, {
		...guardedName,
		effect: async () => {
			effects++;
			return { resultDigest: "e".repeat(64) };
		},
	});
	assert.equal(retry.replayed, true);
	assert.equal(effects, 1);
});

test("deleting a durable observed journal record is detected before replay", async () => {
	const context = setup();
	const { lock, run } = startRun(context);
	let effects = 0;
	await performJournaledOperation(lock, {
		...operation(),
		effect: async () => {
			effects++;
			return { resultDigest: RESULT_DIGEST };
		},
	});
	const [record] = readdirSync(run.paths.operationsDir);
	unlinkSync(join(run.paths.operationsDir, record));
	await expectCodeAsync("bookkeeping_unknown", () =>
		performJournaledOperation(lock, {
			...operation(),
			effect: async () => {
				effects++;
				return { resultDigest: RESULT_DIGEST };
			},
		}),
	);
	assert.equal(effects, 1);
});

test("journal uncertainty guard blocks replay even when needs-attention finalization also fails", async () => {
	const context = setup();
	const { lock } = startRun(context);
	let effects = 0;
	await expectCodeAsync("recovery_required", () =>
		performJournaledOperation(lock, {
			...operation(),
			fault(name) {
				if (
					name === "journal_result.after_publish" ||
					name === "journal_attention.before_temp_open"
				) {
					throw new Error(`fault at ${name}`);
				}
			},
			effect: async () => {
				effects++;
				return { resultDigest: RESULT_DIGEST };
			},
		}),
	);
	expectCode("recovery_required", () =>
		loadActiveRun(context.store, { workspaceId: "wB1" }),
	);
	await expectCodeAsync("recovery_required", () =>
		performJournaledOperation(lock, {
			...operation(),
			effect: async () => {
				effects++;
				return { resultDigest: RESULT_DIGEST };
			},
		}),
	);
	assert.equal(effects, 1);
});

test("an uncertain observed-result publication is downgraded and cannot replay", async () => {
	const context = setup();
	const { lock, run } = startRun(context);
	let effects = 0;
	await expectCodeAsync("recovery_required", () =>
		performJournaledOperation(lock, {
			...operation(),
			fault(name) {
				if (name === "journal_result.after_publish")
					throw new Error("directory fsync not reached");
			},
			effect: async () => {
				effects++;
				return { resultDigest: RESULT_DIGEST };
			},
		}),
	);
	expectCode("recovery_required", () =>
		loadActiveRun(context.store, { workspaceId: "wB1" }),
	);
	const [record] = readdirSync(run.paths.operationsDir);
	const journal = readPrivateJson(
		join(run.paths.operationsDir, record),
		validateJournalEntry,
		{
			root: context.stateRoot,
		},
	);
	assert.equal(journal.phase, "needs_attention");
	await expectCodeAsync("recovery_required", () =>
		performJournaledOperation(lock, {
			...operation(),
			effect: async () => {
				effects++;
				return { resultDigest: RESULT_DIGEST };
			},
		}),
	);
	assert.equal(effects, 1);
});

test("renamed journal records are not authoritative", async () => {
	const context = setup();
	const { lock, run } = startRun(context);
	let effects = 0;
	await performJournaledOperation(lock, {
		...operation(),
		effect: async () => {
			effects++;
			return { resultDigest: RESULT_DIGEST };
		},
	});
	const [record] = readdirSync(run.paths.operationsDir);
	renameSync(
		join(run.paths.operationsDir, record),
		join(run.paths.operationsDir, "0000000001-renamed.json"),
	);
	await expectCodeAsync("bookkeeping_unknown", () =>
		performJournaledOperation(lock, {
			...operation(),
			effect: async () => {
				effects++;
				return { resultDigest: RESULT_DIGEST };
			},
		}),
	);
	assert.equal(effects, 1);
});

test("journal terminal-field corruption breaks the hash chain before replay", async () => {
	const context = setup();
	const { lock, run } = startRun(context);
	let effects = 0;
	await performJournaledOperation(lock, {
		...operation(),
		effect: async () => {
			effects++;
			return { resultDigest: RESULT_DIGEST };
		},
	});
	const [record] = readdirSync(run.paths.operationsDir);
	const recordPath = join(run.paths.operationsDir, record);
	const corrupted = parseStrictJsonBytes(readFileSync(recordPath));
	corrupted.result_digest = "f".repeat(64);
	writeFileSync(recordPath, `${JSON.stringify(corrupted)}\n`, { mode: 0o600 });
	chmodSync(recordPath, 0o600);
	await expectCodeAsync("bookkeeping_unknown", () =>
		performJournaledOperation(lock, {
			...operation(),
			effect: async () => {
				effects++;
				return { resultDigest: RESULT_DIGEST };
			},
		}),
	);
	assert.equal(effects, 1);
});

test("a fault during observed-result finalization requires recovery and never repeats the effect", async () => {
	const context = setup();
	const { lock } = startRun(context);
	let effects = 0;
	await expectCodeAsync("recovery_required", () =>
		performJournaledOperation(lock, {
			...operation(),
			fault(name) {
				if (name === "journal_result.after_directory_fsync")
					throw new Error("caller crashed");
			},
			effect: async () => {
				effects++;
				return { resultDigest: RESULT_DIGEST };
			},
		}),
	);
	expectCode("recovery_required", () =>
		loadActiveRun(context.store, { workspaceId: "wB1" }),
	);
	await expectCodeAsync("recovery_required", () =>
		performJournaledOperation(lock, {
			...operation(),
			effect: async () => {
				effects++;
				return { resultDigest: "e".repeat(64) };
			},
		}),
	);
	assert.equal(effects, 1);
});

test("Stage 1 actions expose only the strict runtime authority", () => {
	assert.match(
		readFileSync(join(ROOT, "scripts/assemble.sh"), "utf8"),
		/stage1-runtime/,
	);
	assert.match(
		readFileSync(join(ROOT, "scripts/board.sh"), "utf8"),
		/stage1-runtime/,
	);
	assert.match(
		readFileSync(join(ROOT, "scripts/status.sh"), "utf8"),
		/stage1-runtime/,
	);
	for (const relative of ["scripts/harvest.sh", "scripts/stand-down.sh"])
		assert.match(readFileSync(join(ROOT, relative), "utf8"), /stage1-runtime/);
});

test("exclusive publication never overwrites an active pointer", () => {
	const context = setup();
	const { lock, run } = startRun(context);
	const pointer = readPrivateJson(run.pointerPath, validateActiveRun, {
		root: context.stateRoot,
	});
	expectCode("state_exists", () =>
		publishExclusiveJson(
			run.pointerPath,
			{ ...pointer, revision: 1 },
			validateActiveRun,
			{
				root: context.stateRoot,
			},
		),
	);
	assert.equal(
		readPrivateJson(run.pointerPath, validateActiveRun, {
			root: context.stateRoot,
		}).revision,
		0,
	);
	releaseRepositoryLock(lock);
});

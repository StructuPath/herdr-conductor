import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import {
	assemble,
	parsePluginContext,
	readStatus,
	reconcile,
	standDown,
} from "../scripts/stage1-runtime.mjs";
import {
	StateKernelError,
	parseStrictJsonBytes,
	validateActiveRun,
	validateJournalEntry,
	validateLockOwner,
	validateRunState,
} from "../scripts/private-state-schema.mjs";
import {
	inspectRepositoryLock,
	loadActiveRun,
	openRepositoryStore,
} from "../scripts/state-kernel.mjs";

const trash = [];
function temp(prefix) {
	const path = mkdtempSync(join(tmpdir(), prefix));
	trash.push(path);
	return path;
}
process.on("exit", () =>
	trash.forEach((path) => rmSync(path, { recursive: true, force: true })),
);

function git(cwd, ...args) {
	return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}
function repo() {
	const path = temp("conductor-b2-repo-");
	spawnSync("git", ["init", "-q", "-b", "main", path]);
	git(path, "config", "user.name", "Conductor B2 Test");
	git(path, "config", "user.email", "conductor-b2@example.invalid");
	writeFileSync(join(path, "base.txt"), "base\n");
	git(path, "add", "base.txt");
	git(path, "commit", "-qm", "base");
	return realpathSync(path);
}
function context(repository, workspace = "wB2") {
	return JSON.stringify({
		workspace_id: workspace,
		workspace_cwd: repository,
		focused_pane_id: `${workspace}:p0`,
	});
}
function config(repository, roles, overrides = {}) {
	const path = join(repository, ".herdr-conductor.json");
	writeFileSync(
		path,
		JSON.stringify({
			version: 1,
			worktree_root: ".conductor-worktrees",
			roles,
			...overrides,
		}),
	);
	return path;
}
function deterministicRandom(seed = 1) {
	let value = seed;
	return (bytes) => Buffer.alloc(bytes, value++);
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

class FakeHerdr {
	constructor(repository, workspace, roles) {
		this.repository = repository;
		this.workspace = workspace;
		this.roles = roles;
		this.log = [];
		this.effects = 0;
		this.panes = new Map();
		this.agents = new Map();
		this.worktrees = new Set();
		this.onEffect = null;
		this.anchorOverride = undefined;
		this.agentBusyRemaining = 0;
	}
	record(command, args, effect = false) {
		const call = { command, args: [...args] };
		this.log.push(call);
		if (effect) {
			this.effects++;
			this.onEffect?.(call);
		}
	}
	exec = (command, args) => {
		if (command === "git") {
			assert.equal(args[0], "-C", `Git call omitted -C: ${args.join(" ")}`);
			if (!this.repository) this.repository = args[1];
			if (!this.roles)
				this.roles = JSON.parse(
					readFileSync(join(this.repository, ".herdr-conductor.json"), "utf8"),
				).roles;
			const allowedCwd =
				args[1] === this.repository ||
				this.worktrees.has(args[1]) ||
				[...this.panes.values()].some((pane) => pane.cwd === args[1]);
			assert.equal(allowedCwd, true, `foreign Git cwd: ${args[1]}`);
			if (args[2] === "worktree" && args[3] === "add") {
				const branch = args[5];
				const target = args[6];
				const forkSha = git(this.repository, "rev-parse", "HEAD");
				assert.match(
					branch,
					/^conductor\/r-[a-f0-9]{24}\/[a-z][a-z0-9_-]{0,31}$/,
				);
				assert.deepEqual(args, [
					"-C",
					this.repository,
					"worktree",
					"add",
					"-b",
					branch,
					target,
					forkSha,
				]);
				assert.equal(
					target,
					join(
						this.repository,
						".conductor-worktrees",
						...branch.split("/").slice(1),
					),
				);
				this.worktrees.add(target);
				this.record(command, args, true);
			} else if (args[2] === "rev-parse") {
				assert.ok(
					[
						JSON.stringify(["-C", args[1], "rev-parse", "HEAD"]),
						JSON.stringify(["-C", args[1], "rev-parse", "--show-toplevel"]),
						JSON.stringify([
							"-C",
							args[1],
							"rev-parse",
							"--path-format=absolute",
							"--git-common-dir",
						]),
					].includes(JSON.stringify(args)) ||
						(args.length === 4 &&
							(/^refs\/heads\//.test(args[3]) ||
								/^[a-f0-9]{40}\^\{tree\}$/.test(args[3]))),
					`unexpected rev-parse: ${args.join(" ")}`,
				);
			} else if (args[2] === "merge-base") {
				assert.equal(args.length, 6);
				assert.deepEqual(args.slice(2, 4), ["merge-base", "--is-ancestor"]);
				assert.match(args[4], /^[a-f0-9]{40}$/);
				assert.match(args[5], /^[a-f0-9]{40}$/);
			} else if (args[2] === "merge-tree") {
				assert.equal(args.length, 6);
				assert.deepEqual(args.slice(2, 4), ["merge-tree", "--write-tree"]);
				assert.match(args[4], /^[a-f0-9]{40}$/);
				assert.match(args[5], /^[a-f0-9]{40}$/);
			} else if (args[2] === "commit-tree") {
				assert.equal(args.length, 10);
				assert.match(args[3], /^[a-f0-9]{40}$/);
				assert.deepEqual(args.slice(4, 9), [
					"-p",
					args[5],
					"-p",
					args[7],
					"-m",
				]);
				assert.match(args[5], /^[a-f0-9]{40}$/);
				assert.match(args[7], /^[a-f0-9]{40}$/);
				assert.equal(args[9], `Conductor merge ${args[7]}`);
			} else if (args[2] === "update-ref") {
				assert.equal(args.length, 6);
				assert.match(args[3], /^refs\/heads\//);
				assert.match(args[4], /^[a-f0-9]{40}$/);
				assert.match(args[5], /^[a-f0-9]{40}$/);
				this.record(command, args, true);
			} else if (args[2] === "read-tree") {
				if (args[3] === "-n") {
					assert.deepEqual(args.slice(2, 6), [
						"read-tree",
						"-n",
						"--reset",
						"-u",
					]);
					assert.equal(args.length, 7);
					assert.match(args[6], /^[a-f0-9]{40}$/);
				} else {
					assert.deepEqual(args.slice(2, 6), [
						"read-tree",
						"-u",
						"-m",
						args[5],
					]);
					assert.equal(args.length, 7);
					assert.match(args[5], /^[a-f0-9]{40}$/);
					assert.match(args[6], /^[a-f0-9]{40}$/);
				}
			} else if (args[2] === "write-tree") {
				assert.deepEqual(args, ["-C", args[1], "write-tree"]);
			} else if (args[2] === "diff-files") {
				assert.deepEqual(args, ["-C", args[1], "diff-files", "--quiet"]);
			} else if (args[2] === "status") {
				assert.deepEqual(args, [
					"-C",
					args[1],
					"status",
					"--porcelain=v1",
					"--untracked-files=no",
				]);
			} else if (args[2] === "symbolic-ref") {
				assert.deepEqual(args, ["-C", args[1], "symbolic-ref", "-q", "HEAD"]);
			} else if (args[2] === "worktree") {
				assert.deepEqual(args, [
					"-C",
					args[1],
					"worktree",
					"list",
					"--porcelain",
				]);
			} else {
				assert.fail(`unscripted fake Git call: ${args.join(" ")}`);
			}
			return execFileSync(command, args, { encoding: "utf8" }).trim();
		}
		assert.ok(
			new Set(["fake", "fake-herdr", "herdr"]).has(command),
			`unscripted fake binary: ${command}`,
		);
		const mutating =
			(args[0] === "pane" && ["split", "report-metadata"].includes(args[1])) ||
			(args[0] === "agent" && args[1] === "start");
		this.record(command, args, mutating);
		if (args.length === 1 && args[0] === "--version") return "herdr 0.7.5";
		if (args[0] === "api" && args[1] === "schema") {
			assert.deepEqual(args, ["api", "schema", "--json"]);
			return JSON.stringify({ protocol: 17, schema_version: 1 });
		}
		if (args[0] === "pane" && args[1] === "split") {
			const cwd = args[6];
			const role = this.roles[this.panes.size];
			assert.deepEqual(args, [
				"pane",
				"split",
				`${this.workspace}:p0`,
				"--direction",
				"right",
				"--cwd",
				cwd,
				"--no-focus",
			]);
			if (role.mode === "read-only") assert.equal(cwd, this.repository);
			else
				assert.equal(
					this.worktrees.has(cwd),
					true,
					`pane cwd is not the exact created worktree: ${cwd}`,
				);
			const paneId = `${this.workspace}:p${this.panes.size + 1}`;
			const pane = {
				workspace_id: this.workspace,
				pane_id: paneId,
				terminal_id: `term_${this.panes.size + 1}`,
				cwd,
				foreground_cwd: cwd,
				tokens: {},
			};
			this.panes.set(paneId, pane);
			return JSON.stringify({ result: { pane } });
		}
		if (args[0] === "pane" && args[1] === "get") {
			assert.deepEqual(args, ["pane", "get", args[2]]);
			const stored = this.panes.get(args[2]);
			if (!stored && !this.workspace) this.workspace = args[2].slice(0, -3);
			if (!stored) assert.equal(args[2], `${this.workspace}:p0`);
			const pane =
				stored ??
				(this.anchorOverride === undefined
					? { workspace_id: this.workspace, pane_id: args[2] }
					: this.anchorOverride);
			return JSON.stringify({ result: { pane } });
		}
		if (args[0] === "pane" && args[1] === "list") {
			assert.deepEqual(args, ["pane", "list"]);
			return JSON.stringify({ result: { panes: [...this.panes.values()] } });
		}
		if (args[0] === "agent" && args[1] === "start") {
			const name = args[2];
			const paneId = args[6];
			const pane = this.panes.get(paneId);
			const role = this.roles[Number(paneId.split(":p")[1]) - 1];
			assert.match(
				name,
				new RegExp(`^${role.name.slice(0, 14)}-[a-f0-9]{12}$`),
			);
			assert.deepEqual(args, [
				"agent",
				"start",
				name,
				"--kind",
				role.kind,
				"--pane",
				paneId,
				"--timeout",
				"60000",
				...(role.launch_args?.length ? ["--", ...role.launch_args] : []),
			]);
			if (this.agentBusyRemaining > 0) {
				this.agentBusyRemaining--;
				throw new Error(
					"agent_pane_busy: agent target pane is not an available shell",
				);
			}
			const agentSession = {
				agent: role.kind,
				kind: "path",
				source: `herdr:${role.kind}`,
				value: `/tmp/${name}.jsonl`,
			};
			pane.agent_session = agentSession;
			this.agents.set(name, {
				name,
				workspace_id: pane.workspace_id,
				pane_id: paneId,
				terminal_id: pane.terminal_id,
				cwd: pane.cwd,
				foreground_cwd: pane.cwd,
				agent_session: agentSession,
				tokens: {},
				agent_status: "idle",
			});
			return JSON.stringify({ result: { agent: this.agents.get(name) } });
		}
		if (args[0] === "pane" && args[1] === "report-metadata") {
			const pane = this.panes.get(args[2]);
			const runToken = args[6];
			const generationToken = args[8];
			assert.match(runToken, /^conductor_run_id=r-[a-f0-9]{24}$/);
			assert.match(generationToken, /^conductor_generation=[a-f0-9]{32}$/);
			assert.deepEqual(args, [
				"pane",
				"report-metadata",
				pane.pane_id,
				"--source",
				"structupath.conductor",
				"--token",
				runToken,
				"--token",
				generationToken,
			]);
			for (const token of [runToken, generationToken]) {
				const [key, value] = token.split("=", 2);
				pane.tokens[key] = value;
				for (const agent of this.agents.values())
					if (agent.pane_id === pane.pane_id) agent.tokens[key] = value;
			}
			return "";
		}
		if (args[0] === "agent" && args[1] === "get") {
			assert.deepEqual(args, ["agent", "get", args[2]]);
			assert.ok(this.agents.has(args[2]), `foreign agent probe: ${args[2]}`);
			return JSON.stringify({ result: { agent: this.agents.get(args[2]) } });
		}
		if (args[0] === "agent" && args[1] === "list") {
			assert.deepEqual(args, ["agent", "list"]);
			return JSON.stringify({ result: { agents: [...this.agents.values()] } });
		}
		if (args[0] === "pane" && args[1] === "close") {
			assert.deepEqual(args, ["pane", "close", args[2]]);
			assert.ok(this.panes.has(args[2]), `foreign pane close: ${args[2]}`);
			this.record(command, args, true);
			this.panes.delete(args[2]);
			for (const [name, agent] of this.agents)
				if (agent.pane_id === args[2]) this.agents.delete(name);
			return JSON.stringify({ result: { closed: true } });
		}
		throw new Error(`unexpected fake Herdr call: ${args.join(" ")}`);
	};
}

function journalFiles(root) {
	const files = [];
	function walk(path) {
		if (!existsSync(path)) return;
		for (const entry of readdirSync(path, { withFileTypes: true })) {
			const child = join(path, entry.name);
			if (entry.isDirectory()) walk(child);
			else if (path.endsWith("operations") && entry.name.endsWith(".json"))
				files.push(child);
		}
	}
	walk(root);
	return files.sort();
}
function readJournals(root) {
	return journalFiles(root).map((path) =>
		validateJournalEntry(parseStrictJsonBytes(readFileSync(path))),
	);
}

function snapshotTree(root) {
	const snapshot = [];
	function walk(path) {
		if (!existsSync(path)) return;
		for (const entry of readdirSync(path, { withFileTypes: true }).sort(
			(a, b) => a.name.localeCompare(b.name),
		)) {
			const child = join(path, entry.name);
			const name = relative(root, child);
			if (entry.isDirectory()) {
				snapshot.push([name, "directory"]);
				walk(child);
			} else {
				snapshot.push([name, readFileSync(child, "utf8")]);
			}
		}
	}
	walk(root);
	return snapshot;
}

function gitInventory(repository) {
	return {
		refs: execFileSync(
			"git",
			[
				"-C",
				repository,
				"for-each-ref",
				"--format=%(refname) %(objectname)",
				"refs/heads",
			],
			{ encoding: "utf8" },
		).trim(),
		worktrees: execFileSync(
			"git",
			["-C", repository, "worktree", "list", "--porcelain"],
			{ encoding: "utf8" },
		).trim(),
	};
}

function effectLog(fake) {
	return fake.log.filter(
		({ command, args }) =>
			command === "git" ||
			(args[0] === "pane" && ["split", "report-metadata"].includes(args[1])) ||
			(args[0] === "agent" && args[1] === "start"),
	);
}

function privateDocuments(root) {
	const documents = [];
	function walk(path) {
		if (!existsSync(path)) return;
		for (const entry of readdirSync(path, { withFileTypes: true })) {
			const child = join(path, entry.name);
			if (entry.isDirectory()) walk(child);
			else if (entry.name.endsWith(".json")) {
				documents.push({
					path: child,
					value: parseStrictJsonBytes(readFileSync(child)),
				});
			}
		}
	}
	walk(root);
	return documents;
}

function inspectKilledOperation({
	repository,
	stateRoot,
	operation,
	boundary,
}) {
	const documents = privateDocuments(stateRoot);
	const run = validateRunState(
		documents.find(({ value }) => value.document_type === "herdr-conductor-run")
			.value,
	);
	const operations = documents
		.filter(
			({ path, value }) =>
				value.document_type === "herdr-conductor-operation" &&
				path.includes("/operations/"),
		)
		.map(({ value }) => validateJournalEntry(value))
		.sort((left, right) => left.sequence - right.sequence);
	const guards = documents
		.filter(({ path }) => path.includes("/operation-guards/"))
		.map(({ value }) => validateJournalEntry(value));
	const expectedSequence = operation === "agent.start" ? 3 : 2;
	assert.equal(run.status, "active");
	assert.equal(
		run.journal_sequence,
		expectedSequence,
		`${operation}:${boundary} high-water`,
	);
	assert.equal(
		operations.length,
		expectedSequence,
		`${operation}:${boundary} journal inventory`,
	);
	assert.deepEqual(
		operations.map(({ operation_type }) => operation_type),
		operation === "agent.start"
			? ["integration.bind", "pane.create", "agent.start"]
			: ["integration.bind", operation],
	);
	const current = operations.at(-1);
	assert.equal(current.phase, "intent", `${operation}:${boundary} phase`);
	assert.equal(current.observed_identity, null);
	assert.equal(current.result_digest, null);
	assert.equal(
		run.journal_head,
		current.entry_digest,
		`${operation}:${boundary} journal head`,
	);
	assert.equal(
		guards.length,
		boundary === "journal.after_intent_durable" ? 0 : 1,
		`${operation}:${boundary} uncertainty guard inventory`,
	);
	if (guards.length === 1) assert.deepEqual(guards[0], current);
	const active = validateActiveRun(
		documents.find(
			({ value }) => value.document_type === "herdr-conductor-active-run",
		).value,
	);
	assert.equal(active.run_id, run.run_id);
	assert.equal(active.generation, run.generation);
	const lockOwner = validateLockOwner(
		documents.find(
			({ value }) => value.document_type === "herdr-conductor-repository-lock",
		).value,
	);
	assert.equal(lockOwner.operation_id, `assemble-${run.run_id}`);
	const store = openRepositoryStore({ stateRoot, repoPath: repository });
	assert.equal(inspectRepositoryLock(store).status, "locked");
	expectCode("recovery_required", () =>
		loadActiveRun(store, { workspaceId: "wCrash" }),
	);
	const runtimeProbes = [];
	expectCode("recovery_required", () =>
		readStatus({
			contextJson: context(repository, "wCrash"),
			stateRoot,
			herdrBin: "runtime-gate-only",
			exec(_command, args) {
				runtimeProbes.push(args);
				if (args[0] === "--version") return "herdr 0.7.5";
				if (args.join(" ") === "api schema --json")
					return JSON.stringify({ protocol: 17, schema_version: 1 });
				assert.fail("unresolved operation reached a live identity probe");
			},
		}),
	);
	assert.deepEqual(runtimeProbes, [["--version"], ["api", "schema", "--json"]]);
	return { run, current, guards, lockOwner };
}

async function assembledFixture({
	repository = repo(),
	workspace = "wB2",
	roles = [{ name: "reviewer", kind: "codex", mode: "read-only" }],
	seed = 1,
	stateRoot = join(temp("conductor-b2-state-"), "state"),
	fault,
} = {}) {
	const fake = new FakeHerdr();
	const result = await assemble({
		contextJson: context(repository, workspace),
		stateRoot,
		configPath: config(repository, roles),
		exec: fake.exec,
		herdrBin: "fake-herdr",
		random: deterministicRandom(seed),
		fault,
	});
	return { repository, workspace, stateRoot, fake, result };
}

export {
	assert,
	execFileSync,
	spawnSync,
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
	dirname,
	join,
	assemble,
	parsePluginContext,
	readStatus,
	reconcile,
	standDown,
	loadActiveRun,
	openRepositoryStore,
	temp,
	git,
	repo,
	context,
	config,
	deterministicRandom,
	expectCode,
	expectCodeAsync,
	FakeHerdr,
	journalFiles,
	readJournals,
	snapshotTree,
	gitInventory,
	effectLog,
	privateDocuments,
	inspectKilledOperation,
	assembledFixture,
};

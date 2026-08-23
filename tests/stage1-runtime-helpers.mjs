import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { Readable } from "node:stream";
import {
	chmodSync,
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
	canonicalJson,
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
import {
	parseTaskBytes,
	reportDigest,
} from "../scripts/task-report-schema.mjs";
import { publishReportFromStdin } from "../scripts/report-publisher.mjs";
import { computeChangedPaths } from "../scripts/source-policy.mjs";

const trash = [];
function temp(prefix) {
	const path = mkdtempSync(join(tmpdir(), prefix));
	trash.push(path);
	return path;
}
function makeTreeRemovable(path) {
	if (!existsSync(path)) return;
	chmodSync(path, 0o700);
	for (const entry of readdirSync(path, { withFileTypes: true })) {
		const child = join(path, entry.name);
		if (entry.isDirectory()) makeTreeRemovable(child);
		else if (!entry.isSymbolicLink()) chmodSync(child, 0o600);
	}
}
process.on("exit", () => {
	for (const path of trash) {
		makeTreeRemovable(path);
		rmSync(path, { recursive: true, force: true });
	}
});

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
function privateStateRoot(prefix = "conductor-b2-state-") {
	const path = join(temp(prefix), "state");
	mkdirSync(path, { mode: 0o700 });
	return realpathSync(path);
}

function context(repository, workspace = "wB2") {
	return JSON.stringify({
		workspace_id: workspace,
		workspace_cwd: repository,
		focused_pane_id: `${workspace}:p0`,
	});
}
function config(repository, roles, overrides = {}, stateRoot = null) {
	const path = join(repository, ".herdr-conductor.json");
	const stage2Roles = roles.map((role) => {
		if (role.contract_role === undefined) {
			role.contract_role = role.mode === "read-only" ? "builder" : "builder";
			role.mode = "write";
		}
		const configured = {
			name: role.name,
			contract_role: role.contract_role,
			kind: role.kind,
			mode: role.mode,
			assignment: role.assignment ?? {
				title: `Task for ${role.name}`,
				mission: `Complete the attended ${role.name} task`,
				acceptance_criteria: [],
				owned_paths: ["src"],
				forbidden_paths: [],
				required_commands: [],
			},
			validator_artifacts: role.validator_artifacts ?? [],
		};
		if (role.launch_args !== undefined)
			configured.launch_args = role.launch_args;
		return configured;
	});
	writeFileSync(
		path,
		JSON.stringify({
			version: 2,
			state_root: stateRoot
				? { kind: "absolute", path: stateRoot }
				: { kind: "default" },
			worktree_root: ".conductor-worktrees",
			roles: stage2Roles,
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
	exec = (command, args, options = {}) => {
		if (command === "git") {
			assert.equal(args[0], "-C", `Git call omitted -C: ${args.join(" ")}`);
			if (!this.repository) this.repository = args[1];
			if (args[2] === "-c") {
				assert.equal(args[3], "commit.gpgSign=false");
				assert.ok(
					new Set(["merge-tree", "commit-tree", "update-ref", "rev-parse"]).has(
						args[4],
					),
					`unscripted deterministic Git call: ${args.join(" ")}`,
				);
				if (args[4] === "update-ref") this.record(command, args, true);
				return execFileSync(command, args, {
					encoding: options.encoding ?? "utf8",
					input: options.input,
					env: options.env,
				}).trim();
			}
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
				let target;
				if (args[4] === "-b") {
					const branch = args[5];
					target = args[6];
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
				} else {
					assert.equal(args[4], "--detach");
					target = args[5];
					assert.match(args[6], /^[a-f0-9]{40}$/);
				}
				assert.equal(
					target.startsWith(join(this.repository, ".conductor-worktrees")),
					true,
				);
				this.worktrees.add(target);
				this.record(command, args, true);
			} else if (args[2] === "rev-parse") {
				assert.ok(
					[
						JSON.stringify(["-C", args[1], "rev-parse", "HEAD"]),
						JSON.stringify(["-C", args[1], "rev-parse", "HEAD^{tree}"]),
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
								/^[a-f0-9]{40}\^\{tree\}$/.test(args[3]))) ||
						JSON.stringify(args.slice(2)) ===
							JSON.stringify(["rev-parse", "--abbrev-ref", "HEAD"]),
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
			} else if (args[2] === "reset") {
				assert.deepEqual(args.slice(2, 4), ["reset", "--hard"]);
				assert.match(args[4], /^[a-f0-9]{40}$/);
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
				assert.ok(
					[
						JSON.stringify([
							"-C",
							args[1],
							"status",
							"--porcelain=v1",
							"--untracked-files=no",
						]),
						JSON.stringify([
							"-C",
							args[1],
							"status",
							"--porcelain=v1",
							"-z",
							"--untracked-files=no",
						]),
					].includes(JSON.stringify(args)),
					`unexpected status: ${args.join(" ")}`,
				);
			} else if (args[2] === "ls-files") {
				assert.ok(
					args.includes("-z"),
					`gate/source inventory omitted NUL framing: ${args.join(" ")}`,
				);
			} else if (args[2] === "-c" && args[3] === "diff.renames=false") {
				assert.equal(args[4], "diff");
			} else if (args[2] === "show-ref") {
				assert.deepEqual(args, [
					"-C",
					args[1],
					"show-ref",
					"--verify",
					"--hash",
					args[5],
				]);
				assert.match(args[5], /^refs\//);
			} else if (args[2] === "diff") {
				assert.deepEqual(args, [
					"-C",
					args[1],
					"diff",
					"--name-status",
					"--no-renames",
					"-z",
					args[6],
					args[7],
				]);
				assert.match(args[6], /^[a-f0-9]{40}$/);
				assert.match(args[7], /^[a-f0-9]{40}$/);
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
			const encoding = options.encoding === null ? null : "utf8";
			const output = execFileSync(command, args, { encoding });
			return Buffer.isBuffer(output) ? output : output.trim();
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
			const role = this.roles.find(
				(candidate) =>
					cwd.endsWith(`/${candidate.name}`) &&
					![...this.panes.values()].some(
						(pane) => pane.role_name === candidate.name,
					),
			);
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
			assert.ok(role, `pane cwd does not select one configured role: ${cwd}`);
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
				role_name: role.name,
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
			const role = this.roles.find(
				(candidate) => candidate.name === pane.role_name,
			);
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
	const expectedSequence =
		operation === "agent.start" ? 5 : operation === "pane.create" ? 4 : 2;
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
			? [
					"integration.bind",
					"worktree.create",
					"task.publish",
					"pane.create",
					"agent.start",
				]
			: operation === "pane.create"
				? ["integration.bind", "worktree.create", "task.publish", "pane.create"]
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

let reportCounter = 1;
async function buildWorkerReport(fixture, worker, overrides = {}) {
	const task = parseTaskBytes(readFileSync(worker.task_path));
	const active = loadActiveRun(
		openRepositoryStore({
			stateRoot: fixture.stateRoot,
			repoPath: fixture.repository,
		}),
		{ workspaceId: fixture.workspace },
	);
	const agentEntry = active.journal.find(
		(entry) =>
			entry.operation_type === "agent.start" &&
			entry.phase === "observed" &&
			entry.subject.id === task.role.name,
	);
	assert.ok(agentEntry, "worker report requires observed agent authority");
	const producer = task.source.kind === "role_worktree";
	const head = producer ? git(task.source.root, "rev-parse", "HEAD") : null;
	const tree = producer
		? git(task.source.root, "rev-parse", "HEAD^{tree}")
		: null;
	const source = producer
		? { ...task.source, expected_sha: head, tree_sha: tree }
		: task.source;
	const changedPaths = producer
		? computeChangedPaths(task.source.root, task.source.fork_sha, head)
		: [];
	const requirementResults = [
		...task.assignment.required_commands.map((requirement) => ({
			requirement_kind: "command",
			requirement_id: requirement.id,
			assertion: "passed",
			evidence_kind: "worker_assertion",
			command: requirement.command,
			exit_code: 0,
			output_sha256: "a".repeat(64),
			note: "test worker assertion",
		})),
		...task.assignment.acceptance_criteria.map((requirement) => ({
			requirement_kind: "criterion",
			requirement_id: requirement.id,
			assertion: "passed",
			evidence_kind: "worker_assertion",
			command: null,
			exit_code: null,
			output_sha256: null,
			note: "test worker assertion",
		})),
	];
	const result =
		task.role.contract_role === "reviewer"
			? { kind: "review", verdict: "approve" }
			: task.role.contract_role === "validator"
				? { kind: "validation", verdict: "pass" }
				: { kind: "delivery", verdict: "delivered" };
	const draft = {
		document_type: "herdr-conductor-report",
		schema_version: 1,
		report_id: `report-${task.role.name}`,
		report_generation: (reportCounter++).toString(16).padStart(32, "0"),
		task: {
			id: task.task_id,
			generation: task.task_generation,
			digest: task.task_digest,
		},
		scope: task.scope,
		role: task.role,
		source,
		agent_observation: {
			operation_id: task.role.agent_operation_id,
			entry_digest: agentEntry.entry_digest,
			agent_generation: task.role.agent_generation,
			pane_generation: task.role.pane_generation,
			agent_name: task.role.agent_name,
		},
		status: "completed",
		result,
		summary: "Test report",
		findings: [],
		requirement_results: requirementResults,
		changed_paths: changedPaths,
		artifacts: [],
		completed_at: "2026-07-28T00:00:00.000Z",
		...overrides,
	};
	const report = { ...draft, report_digest: reportDigest(draft) };
	return { task, report };
}

async function publishWorkerReport(fixture, worker, overrides = {}) {
	const { task, report } = await buildWorkerReport(fixture, worker, overrides);
	await publishReportFromStdin({
		input: Readable.from([Buffer.from(canonicalJson(report))]),
		stateRoot: fixture.stateRoot,
		authorizeTask: () => ({ task }),
	});
	return report;
}

async function assembledFixture({
	repository = repo(),
	workspace = "wB2",
	roles = [{ name: "builder", kind: "codex", mode: "write" }],
	seed = 1,
	random = deterministicRandom(seed),
	stateRoot = join(temp("conductor-b2-state-"), "state"),
	configOverrides = {},
	fault,
} = {}) {
	const fake = new FakeHerdr();
	mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
	stateRoot = realpathSync(stateRoot);
	const result = await assemble({
		contextJson: context(repository, workspace),
		configPath: config(repository, roles, configOverrides, stateRoot),
		exec: fake.exec,
		herdrBin: "fake-herdr",
		random,
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
	privateStateRoot,
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
	buildWorkerReport,
	publishWorkerReport,
	assembledFixture,
};

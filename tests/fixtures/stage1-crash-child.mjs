import assert from "node:assert/strict";
import { appendFileSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { assemble } from "../../scripts/stage1-runtime.mjs";

const [repository, stateRoot, configPath, logPath, target, seedArg = "1"] =
	process.argv.slice(2);
const workspace = "wCrash";
const config = JSON.parse(readFileSync(configPath, "utf8"));
const [role] = config.roles;
const startSeed = Number(seedArg);
const token = (offset, bytes) =>
	(startSeed + offset).toString(16).padStart(2, "0").repeat(bytes);
const runId = `r-${token(0, 12)}`;
const paneGeneration = token(role.mode === "write" ? 3 : 2, 16);
const agentSuffix = token(role.mode === "write" ? 4 : 3, 6);
const branch = `conductor/${runId}/${role.name}`;
const worktree = join(repository, ".conductor-worktrees", runId, role.name);
const forkSha = execFileSync("git", ["-C", repository, "rev-parse", "HEAD"], {
	encoding: "utf8",
}).trim();
const panes = new Map();
const agents = new Map();
const mutation = (command, args) =>
	appendFileSync(logPath, `${JSON.stringify({ command, args })}\n`);

function paneFor(id) {
	return (
		panes.get(id) ??
		(id === `${workspace}:p0`
			? { workspace_id: workspace, pane_id: id }
			: undefined)
	);
}

function fakeExec(command, args) {
	if (command === "git") {
		assert.equal(args[0], "-C", "Git fake requires -C");
		if (args[2] === "worktree" && args[3] === "add") {
			assert.deepEqual(args, [
				"-C",
				repository,
				"worktree",
				"add",
				"-b",
				branch,
				worktree,
				forkSha,
			]);
			mutation(command, args);
		} else if (args[2] === "rev-parse") {
			assert.ok([repository, worktree].includes(args[1]));
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
					(args.length === 4 && /^refs\/heads\//.test(args[3])),
			);
		} else if (args[2] === "symbolic-ref") {
			assert.deepEqual(args, ["-C", args[1], "symbolic-ref", "-q", "HEAD"]);
			assert.ok([repository, worktree].includes(args[1]));
		} else if (args[2] === "worktree") {
			assert.deepEqual(args, [
				"-C",
				args[1],
				"worktree",
				"list",
				"--porcelain",
			]);
			assert.ok([repository, worktree].includes(args[1]));
		} else if (args[2] === "status") {
			assert.deepEqual(args, [
				"-C",
				repository,
				"status",
				"--porcelain=v1",
				"--untracked-files=no",
			]);
		} else {
			assert.fail(`unscripted fake Git call: ${args.join(" ")}`);
		}
		return execFileSync(command, args, { encoding: "utf8" }).trim();
	}
	assert.equal(command, "strict-fake-herdr");
	if (args.length === 1 && args[0] === "--version") return "herdr 0.7.5";
	if (args[0] === "api" && args[1] === "schema") {
		assert.deepEqual(args, ["api", "schema", "--json"]);
		return JSON.stringify({ protocol: 17, schema_version: 1 });
	}
	if (args[0] === "pane" && args[1] === "get") {
		assert.deepEqual(args, ["pane", "get", args[2]]);
		assert.ok(args[2] === `${workspace}:p0` || panes.has(args[2]));
		return JSON.stringify({ result: { pane: paneFor(args[2]) } });
	}
	if (args[0] === "pane" && args[1] === "split") {
		const cwd = role.mode === "write" ? worktree : repository;
		assert.deepEqual(args, [
			"pane",
			"split",
			`${workspace}:p0`,
			"--direction",
			"right",
			"--cwd",
			cwd,
			"--no-focus",
		]);
		mutation(command, args);
		const pane = {
			workspace_id: workspace,
			pane_id: `${workspace}:p1`,
			terminal_id: "terminal-1",
			cwd,
			foreground_cwd: cwd,
			tokens: {},
		};
		panes.set(pane.pane_id, pane);
		return JSON.stringify({ result: { pane } });
	}
	if (args[0] === "agent" && args[1] === "start") {
		const name = `${role.name.slice(0, 14)}-${agentSuffix}`;
		assert.deepEqual(args, [
			"agent",
			"start",
			name,
			"--kind",
			role.kind,
			"--pane",
			`${workspace}:p1`,
			"--timeout",
			"60000",
			...(role.launch_args?.length ? ["--", ...role.launch_args] : []),
		]);
		mutation(command, args);
		const pane = panes.get(`${workspace}:p1`);
		const agentSession = {
			agent: role.kind,
			kind: "path",
			source: `herdr:${role.kind}`,
			value: `/tmp/${name}.jsonl`,
		};
		pane.agent_session = agentSession;
		agents.set(name, {
			name,
			workspace_id: workspace,
			pane_id: pane.pane_id,
			terminal_id: pane.terminal_id,
			cwd: pane.cwd,
			foreground_cwd: pane.cwd,
			agent_session: agentSession,
			tokens: {},
			agent_status: "idle",
		});
		if (target === "agent.start:after_start_before_metadata")
			process.kill(process.pid, "SIGKILL");
		return JSON.stringify({ result: { agent: agents.get(name) } });
	}
	if (args[0] === "pane" && args[1] === "report-metadata") {
		assert.deepEqual(args, [
			"pane",
			"report-metadata",
			`${workspace}:p1`,
			"--source",
			"structupath.conductor",
			"--token",
			`conductor_run_id=${runId}`,
			"--token",
			`conductor_generation=${paneGeneration}`,
		]);
		mutation(command, args);
		const pane = panes.get(`${workspace}:p1`);
		for (const token of [args[6], args[8]]) {
			const [key, value] = token.split("=", 2);
			pane.tokens[key] = value;
			for (const agent of agents.values()) agent.tokens[key] = value;
		}
		return JSON.stringify({ result: {} });
	}
	if (args[0] === "pane" && args[1] === "list") {
		assert.deepEqual(args, ["pane", "list"]);
		return JSON.stringify({ result: { panes: [...panes.values()] } });
	}
	if (args[0] === "agent" && args[1] === "list") {
		assert.deepEqual(args, ["agent", "list"]);
		return JSON.stringify({ result: { agents: [...agents.values()] } });
	}
	if (args[0] === "agent" && args[1] === "get") {
		assert.deepEqual(args, [
			"agent",
			"get",
			`${role.name.slice(0, 14)}-${agentSuffix}`,
		]);
		return JSON.stringify({ result: { agent: agents.get(args[2]) } });
	}
	assert.fail(`unscripted fake call: ${command} ${args.join(" ")}`);
}

let seed = startSeed;
await assemble({
	contextJson: JSON.stringify({
		workspace_id: workspace,
		workspace_cwd: repository,
		focused_pane_id: `${workspace}:p0`,
	}),
	stateRoot,
	configPath,
	herdrBin: "strict-fake-herdr",
	exec: fakeExec,
	random: (bytes) => Buffer.alloc(bytes, seed++),
	fault(name) {
		if (name === target) process.kill(process.pid, "SIGKILL");
	},
});

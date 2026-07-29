#!/usr/bin/env node
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const path = process.env.FAKE_HERDR_STATE;
const repository = process.env.FAKE_HERDR_REPOSITORY;
if (!path) throw new Error("FAKE_HERDR_STATE is required");
if (!repository) throw new Error("FAKE_HERDR_REPOSITORY is required");
const state = existsSync(path)
	? JSON.parse(readFileSync(path, "utf8"))
	: { panes: {}, agents: {} };
const config = JSON.parse(
	readFileSync(join(repository, ".herdr-conductor.json"), "utf8"),
);
const [role] = config.roles;
const args = process.argv.slice(2);
const save = () => writeFileSync(path, JSON.stringify(state));
const result = (value) =>
	process.stdout.write(JSON.stringify({ result: value }));
const workspace = process.env.FAKE_HERDR_WORKSPACE ?? "wEntry";
const anchor = `${workspace}:p0`;

if (args.length === 1 && args[0] === "--version") {
	process.stdout.write("herdr 0.7.5\n");
} else if (args[0] === "api" && args[1] === "schema") {
	assert.deepEqual(args, ["api", "schema", "--json"]);
	result({ protocol: 17, schema_version: 1 });
} else if (args[0] === "pane" && args[1] === "get") {
	assert.deepEqual(args, ["pane", "get", args[2]]);
	assert.ok(args[2] === anchor || Object.hasOwn(state.panes, args[2]));
	const pane =
		state.panes[args[2]] ??
		(args[2] === anchor
			? { workspace_id: workspace, pane_id: args[2] }
			: undefined);
	result({ pane });
} else if (args[0] === "pane" && args[1] === "split") {
	const cwd = args[6];
	assert.deepEqual(args, [
		"pane",
		"split",
		anchor,
		"--direction",
		"right",
		"--cwd",
		cwd,
		"--no-focus",
	]);
	if (role.mode === "read-only") assert.equal(cwd, repository);
	else assert.match(cwd, new RegExp(`^${repository}/\\.conductor-worktrees/`));
	const pane = {
		workspace_id: workspace,
		pane_id: `${workspace}:p1`,
		terminal_id: "terminal-entry",
		cwd,
		foreground_cwd: cwd,
		tokens: {},
	};
	state.panes[pane.pane_id] = pane;
	save();
	result({ pane });
} else if (args[0] === "agent" && args[1] === "start") {
	const name = args[2];
	assert.match(name, new RegExp(`^${role.name.slice(0, 14)}-[a-f0-9]{12}$`));
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
	const pane = state.panes[`${workspace}:p1`];
	const agentSession = {
		agent: role.kind,
		kind: "path",
		source: `herdr:${role.kind}`,
		value: `/tmp/${name}.jsonl`,
	};
	pane.agent_session = agentSession;
	const agent = {
		name,
		workspace_id: workspace,
		pane_id: pane.pane_id,
		terminal_id: pane.terminal_id,
		cwd: pane.cwd,
		foreground_cwd: pane.cwd,
		agent_session: agentSession,
		tokens: {},
		agent_status: "idle",
	};
	state.agents[name] = agent;
	save();
	result({ agent });
} else if (args[0] === "pane" && args[1] === "report-metadata") {
	const runToken = args[6];
	const generationToken = args[8];
	assert.match(runToken, /^conductor_run_id=r-[a-f0-9]{24}$/);
	assert.match(generationToken, /^conductor_generation=[a-f0-9]{32}$/);
	assert.deepEqual(args, [
		"pane",
		"report-metadata",
		`${workspace}:p1`,
		"--source",
		"structupath.conductor",
		"--token",
		runToken,
		"--token",
		generationToken,
	]);
	const pane = state.panes[`${workspace}:p1`];
	for (const token of [runToken, generationToken]) {
		const [key, value] = token.split("=", 2);
		pane.tokens[key] = value;
		for (const agent of Object.values(state.agents)) agent.tokens[key] = value;
	}
	save();
	result({});
} else if (args[0] === "pane" && args[1] === "list") {
	assert.deepEqual(args, ["pane", "list"]);
	result({ panes: Object.values(state.panes) });
} else if (args[0] === "agent" && args[1] === "list") {
	assert.deepEqual(args, ["agent", "list"]);
	result({ agents: Object.values(state.agents) });
} else if (args[0] === "agent" && args[1] === "get") {
	assert.deepEqual(args, ["agent", "get", args[2]]);
	assert.ok(Object.hasOwn(state.agents, args[2]));
	result({ agent: state.agents[args[2]] });
} else if (args[0] === "pane" && args[1] === "close") {
	assert.deepEqual(args, ["pane", "close", `${workspace}:p1`]);
	assert.ok(Object.hasOwn(state.panes, args[2]));
	delete state.panes[args[2]];
	for (const [name, agent] of Object.entries(state.agents))
		if (agent.pane_id === args[2]) delete state.agents[name];
	save();
	result({ closed: true });
} else {
	process.stderr.write(`unscripted fake Herdr call: ${args.join(" ")}\n`);
	process.exitCode = 2;
}

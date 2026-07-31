import { execFileSync } from "node:child_process";
import {
	appendFileSync,
	existsSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import {
	readStatus,
	reconcile,
	standDown,
} from "../../scripts/stage1-runtime.mjs";

const [
	operation,
	repository,
	stateRoot,
	workspace,
	livePath,
	effectsPath,
	boundary,
	barrierReadyPath,
	barrierReleasePath,
] = process.argv.slice(2);
const contextJson = JSON.stringify({
	workspace_id: workspace,
	workspace_cwd: repository,
	focused_pane_id: `${workspace}:p0`,
});
const exec = (command, args, options = {}) => {
	if (command === "git") {
		if (
			args[2] === "update-ref" ||
			args[4] === "update-ref" ||
			(args[2] === "worktree" && args[3] === "add")
		)
			appendFileSync(effectsPath, `${JSON.stringify({ command, args })}\n`);
		const output = execFileSync(command, args, {
			encoding: options.encoding === null ? null : (options.encoding ?? "utf8"),
			stdio:
				options.input === undefined
					? ["ignore", "pipe", "pipe"]
					: ["pipe", "pipe", "pipe"],
			input: options.input,
			env: options.env,
		});
		return Buffer.isBuffer(output) ? output : output.trim();
	}
	if (args.length === 1 && args[0] === "--version") return "herdr 0.7.5";
	if (args[0] === "api" && args[1] === "schema")
		return JSON.stringify({ protocol: 17, schema_version: 1 });
	const live = JSON.parse(readFileSync(livePath, "utf8"));
	let result;
	if (args[0] === "pane" && args[1] === "list")
		result = { panes: Object.values(live.panes) };
	else if (args[0] === "agent" && args[1] === "list")
		result = { agents: Object.values(live.agents) };
	else if (args[0] === "pane" && args[1] === "get")
		result = { pane: live.panes[args[2]] };
	else if (args[0] === "agent" && args[1] === "get")
		result = { agent: live.agents[args[2]] };
	else if (args[0] === "pane" && args[1] === "split") {
		appendFileSync(effectsPath, `${JSON.stringify({ command, args })}\n`);
		const paneId = `${workspace}:p${Object.keys(live.panes).length + 1}`;
		const cwd = args[6];
		live.panes[paneId] = {
			workspace_id: workspace,
			pane_id: paneId,
			terminal_id: `terminal-${paneId}`,
			cwd,
			foreground_cwd: cwd,
			tokens: {},
		};
		writeFileSync(livePath, JSON.stringify(live));
		result = { pane: live.panes[paneId] };
	} else if (args[0] === "agent" && args[1] === "start") {
		appendFileSync(effectsPath, `${JSON.stringify({ command, args })}\n`);
		const name = args[2];
		const kind = args[4];
		const paneId = args[6];
		const pane = live.panes[paneId];
		const agentSession = {
			agent: kind,
			kind: "path",
			source: `herdr:${kind}`,
			value: `/tmp/${name}.jsonl`,
		};
		pane.agent_session = agentSession;
		live.agents[name] = {
			name,
			workspace_id: workspace,
			pane_id: paneId,
			terminal_id: pane.terminal_id,
			cwd: pane.cwd,
			foreground_cwd: pane.cwd,
			agent_session: agentSession,
			tokens: {},
			agent_status: "idle",
		};
		writeFileSync(livePath, JSON.stringify(live));
		result = { agent: live.agents[name] };
	} else if (args[0] === "pane" && args[1] === "report-metadata") {
		appendFileSync(effectsPath, `${JSON.stringify({ command, args })}\n`);
		const pane = live.panes[args[2]];
		for (let index = 6; index < args.length; index += 2) {
			const [key, value] = args[index].split("=", 2);
			pane.tokens[key] = value;
			for (const agent of Object.values(live.agents))
				if (agent.pane_id === pane.pane_id) agent.tokens[key] = value;
		}
		writeFileSync(livePath, JSON.stringify(live));
		result = {};
	} else if (args[0] === "pane" && args[1] === "close") {
		appendFileSync(effectsPath, `${JSON.stringify({ command, args })}\n`);
		delete live.panes[args[2]];
		for (const [name, agent] of Object.entries(live.agents))
			if (agent.pane_id === args[2]) delete live.agents[name];
		writeFileSync(livePath, JSON.stringify(live));
		result = { closed: true };
	} else
		throw new Error(`unexpected fake command: ${command} ${args.join(" ")}`);
	return JSON.stringify({ result });
};
const fault = (name) => {
	if (name !== boundary) return;
	if (barrierReadyPath && barrierReleasePath) {
		writeFileSync(barrierReadyPath, "ready\n");
		while (!existsSync(barrierReleasePath))
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
		return;
	}
	process.kill(process.pid, "SIGKILL");
};
const options = { contextJson, stateRoot, exec, fault };
try {
	if (["merge", "reject", "lifecycle"].includes(operation))
		await reconcile(options);
	else if (operation === "status")
		process.stdout.write(
			JSON.stringify(readStatus({ ...options, herdrBin: "fake" })),
		);
	else await standDown({ ...options, herdrBin: "fake" });
} catch (error) {
	process.stderr.write(`${error.code ?? "internal_error"}:${error.message}\n`);
	process.exitCode = 1;
}

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { reconcile, standDown } from "../../scripts/stage1-runtime.mjs";

const [
	operation,
	repository,
	stateRoot,
	workspace,
	livePath,
	effectsPath,
	boundary,
] = process.argv.slice(2);
const contextJson = JSON.stringify({
	workspace_id: workspace,
	workspace_cwd: repository,
	focused_pane_id: `${workspace}:p0`,
});
const exec = (command, args) => {
	if (command === "git") {
		if (args[2] === "update-ref")
			appendFileSync(effectsPath, `${JSON.stringify({ command, args })}\n`);
		return execFileSync(command, args, {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		}).trim();
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
	else if (args[0] === "pane" && args[1] === "close") {
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
	if (name === boundary) process.kill(process.pid, "SIGKILL");
};
const options = { contextJson, stateRoot, exec, fault };
if (operation === "merge") await reconcile(options);
else await standDown({ ...options, herdrBin: "fake" });

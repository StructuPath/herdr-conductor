import { execFileSync } from "node:child_process";
import { applyStage3 } from "../../scripts/stage1-runtime.mjs";

const [repository, workspace, boundary] = process.argv.slice(2);

function exec(command, args, options = {}) {
	if (command !== "git") {
		if (args.length === 1 && args[0] === "--version") return "herdr 0.7.5";
		if (args.join(" ") === "api schema --json")
			return JSON.stringify({ protocol: 17, schema_version: 1 });
		throw new Error(`unexpected fake Herdr call: ${args.join(" ")}`);
	}
	return execFileSync(command, args, {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		...options,
	}).trim();
}

try {
	await applyStage3({
		contextJson: JSON.stringify({
			workspace_id: workspace,
			workspace_cwd: repository,
			focused_pane_id: `${workspace}:p0`,
		}),
		herdrBin: "fake",
		exec,
		fault(point) {
			if (point === boundary) process.kill(process.pid, "SIGKILL");
		},
	});
} catch (error) {
	process.stderr.write(`${error.code ?? "internal_error"}:${error.message}\n`);
	process.exitCode = 1;
}

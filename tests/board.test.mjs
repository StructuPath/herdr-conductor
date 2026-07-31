import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { publishWorkerReport } from "./stage1-runtime-helpers.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BASH = process.env.CONDUCTOR_TEST_BASH ?? "bash";

test("board and status reject absent plugin context instead of selecting global state", () => {
	for (const action of ["board", "status"]) {
		const result = spawnSync(BASH, [join(ROOT, "scripts", `${action}.sh`)], {
			encoding: "utf8",
			env: {
				...process.env,
				HERDR_PLUGIN_ROOT: ROOT,
				HERDR_PLUGIN_CONTEXT_JSON: "",
			},
		});
		assert.notEqual(result.status, 0, action);
		assert.match(result.stderr, /HERDR_PLUGIN_CONTEXT_JSON is required/);
	}
});

test("all five report-first shell entrypoints execute positively with strict complete-argv fakes", async () => {
	const base = mkdtempSync(join(tmpdir(), "conductor-b2-entrypoints-"));
	try {
		const repositoryPath = join(base, "repository");
		spawnSync("git", ["init", "-q", "-b", "main", repositoryPath]);
		const repository = realpathSync(repositoryPath);
		execFileSync("git", [
			"-C",
			repository,
			"config",
			"user.name",
			"Entry Test",
		]);
		execFileSync("git", [
			"-C",
			repository,
			"config",
			"user.email",
			"entry@example.invalid",
		]);
		writeFileSync(join(repository, "base.txt"), "base\n");
		execFileSync("git", ["-C", repository, "add", "base.txt"]);
		execFileSync("git", ["-C", repository, "commit", "-qm", "base"]);
		const stateRootPath = join(base, "state");
		mkdirSync(stateRootPath, { mode: 0o700 });
		const stateRoot = realpathSync(stateRootPath);
		writeFileSync(
			join(repository, ".herdr-conductor.json"),
			JSON.stringify({
				version: 2,
				state_root: { kind: "absolute", path: stateRoot },
				worktree_root: ".conductor-worktrees",
				roles: [
					{
						name: "builder",
						contract_role: "builder",
						kind: "pi",
						mode: "write",
						assignment: {
							title: "Shell lifecycle",
							mission: "Exercise the report-first shell actions",
							acceptance_criteria: [],
							owned_paths: ["shell-harvest.txt"],
							forbidden_paths: [],
							required_commands: [],
						},
						validator_artifacts: [],
					},
				],
			}),
		);
		const workspace = "wEntry";
		const env = {
			...process.env,
			HERDR_PLUGIN_ROOT: ROOT,
			HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({
				workspace_id: workspace,
				workspace_cwd: repository,
				focused_pane_id: `${workspace}:p0`,
			}),
			HERDR_BIN_PATH: join(ROOT, "tests", "fixtures", "fake-herdr.mjs"),
			FAKE_HERDR_STATE: join(base, "herdr.json"),
			FAKE_HERDR_REPOSITORY: repository,
			FAKE_HERDR_WORKSPACE: workspace,
			CONDUCTOR_STATE_DIR: stateRoot,
		};
		const assembled = spawnSync(BASH, [join(ROOT, "scripts", "assemble.sh")], {
			encoding: "utf8",
			env,
		});
		assert.equal(assembled.status, 0, assembled.stderr);
		const assembly = JSON.parse(assembled.stdout);
		const workerCwd = assembly.workers[0].cwd;
		writeFileSync(
			join(workerCwd, "shell-harvest.txt"),
			"merged by shell harvest\n",
		);
		execFileSync("git", ["-C", workerCwd, "add", "shell-harvest.txt"]);
		execFileSync("git", ["-C", workerCwd, "commit", "-qm", "shell fixture"]);
		await publishWorkerReport(
			{
				repository,
				workspace,
				stateRoot: env.CONDUCTOR_STATE_DIR,
			},
			assembly.workers[0],
		);
		const board = spawnSync(BASH, [join(ROOT, "scripts", "board.sh")], {
			encoding: "utf8",
			env,
		});
		assert.equal(board.status, 0, board.stderr);
		assert.equal(JSON.parse(board.stdout).workspace_id, workspace);
		const status = spawnSync(BASH, [join(ROOT, "scripts", "status.sh")], {
			encoding: "utf8",
			env,
		});
		assert.equal(status.status, 0, status.stderr);
		assert.match(status.stdout, /builder/);
		const harvest = spawnSync(BASH, [join(ROOT, "scripts", "harvest.sh")], {
			encoding: "utf8",
			env,
		});
		assert.equal(harvest.status, 0, harvest.stderr);
		assert.equal(
			JSON.parse(harvest.stdout).lifecycle,
			"integration_harvested_no_gates",
		);
		assert.equal(
			readFileSync(join(repository, "shell-harvest.txt"), "utf8"),
			"merged by shell harvest\n",
		);
		const standDown = spawnSync(
			BASH,
			[join(ROOT, "scripts", "stand-down.sh")],
			{
				encoding: "utf8",
				env,
			},
		);
		assert.equal(standDown.status, 0, standDown.stderr);
		assert.equal(JSON.parse(standDown.stdout).archived, true);
	} finally {
		rmSync(base, { recursive: true, force: true });
	}
});

test("harvest and stand-down reject absent plugin context", () => {
	for (const action of ["harvest", "stand-down"]) {
		const result = spawnSync(BASH, [join(ROOT, "scripts", `${action}.sh`)], {
			encoding: "utf8",
			env: {
				...process.env,
				HERDR_PLUGIN_ROOT: ROOT,
				HERDR_PLUGIN_CONTEXT_JSON: "",
			},
		});
		assert.notEqual(result.status, 0, action);
		assert.match(result.stderr, /HERDR_PLUGIN_CONTEXT_JSON is required/);
	}
});

test("board renderer reads only the strict Stage 1 runtime", () => {
	const source = readFileSync(join(ROOT, "bin", "renderer.mjs"), "utf8");
	assert.match(source, /stage1-runtime\.mjs/);
	assert.doesNotMatch(source, /scripts\/lib\.sh|conductor_board_json/);
});

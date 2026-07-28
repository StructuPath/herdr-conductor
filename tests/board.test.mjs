import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BASH = process.env.CONDUCTOR_TEST_BASH ?? "bash";

function runLib(fn, env = {}) {
	return spawnSync(BASH, ["-c", `. "${ROOT}/scripts/lib.sh" && ${fn}`], {
		encoding: "utf8",
		env: {
			...process.env,
			HERDR_PLUGIN_ROOT: ROOT,
			HERDR_BIN_PATH: "/bin/false",
			...env,
		},
	});
}

function fakeRun() {
	const state = mkdtempSync(join(tmpdir(), "cond-"));
	const run = join(state, "run-t");
	mkdirSync(run, { recursive: true });
	writeFileSync(
		join(run, "builder.env"),
		"ROLE=builder\nKIND=claude\nCWD=/tmp/e\nPANE=wZ:p4\nDISPATCH_TS=0\n",
	);
	writeFileSync(
		join(run, "reviewer.env"),
		"ROLE=reviewer\nKIND=codex\nCWD=/tmp/r\nPANE=wZ:p5\nDISPATCH_TS=0\n",
	);
	return state;
}

test("board JSON is empty when no run exists", () => {
	const state = mkdtempSync(join(tmpdir(), "cond-"));
	const r = runLib("conductor_board_json", { CONDUCTOR_STATE_DIR: state });
	assert.equal(r.status, 0, r.stderr);
	const b = JSON.parse(r.stdout.trim());
	assert.equal(b.run, null);
	assert.deepEqual(b.workers, []);
	rmSync(state, { recursive: true, force: true });
});

test("board JSON lists workers from the run registry with fallback status", () => {
	const state = fakeRun();
	const r = runLib("conductor_board_json", { CONDUCTOR_STATE_DIR: state });
	assert.equal(r.status, 0, r.stderr);
	const b = JSON.parse(r.stdout.trim());
	assert.equal(b.run, "run-t");
	assert.equal(b.workers.length, 2);
	const roles = b.workers.map((w) => w.role).sort();
	assert.deepEqual(roles, ["builder", "reviewer"]);
	const builder = b.workers.find((w) => w.role === "builder");
	assert.equal(builder.kind, "claude");
	assert.equal(builder.pane, "wZ:p4");
	// herdr agent list unavailable (/bin/false) -> status falls back to unknown, not a crash
	assert.equal(builder.status, "unknown");
	rmSync(state, { recursive: true, force: true });
});

test("stand-down reports cleanly when there is no active run", () => {
	const state = mkdtempSync(join(tmpdir(), "cond-"));
	const r = spawnSync(BASH, [join(ROOT, "scripts", "stand-down.sh")], {
		encoding: "utf8",
		env: {
			...process.env,
			HERDR_PLUGIN_ROOT: ROOT,
			HERDR_BIN_PATH: "/bin/false",
			CONDUCTOR_STATE_DIR: state,
		},
	});
	assert.equal(r.status, 0, r.stderr);
	assert.match(r.stdout, /no active conductor run/i);
	rmSync(state, { recursive: true, force: true });
});

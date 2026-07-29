#!/usr/bin/env node
// Zero-dependency live board for the invoking repository/workspace's strict B2
// state. Passive viewer: it never drives agents or writes state.
import { spawnSync } from "node:child_process";

const ROOT = process.env.CONDUCTOR_PLUGIN_ROOT || process.cwd();
const POLL_MS = 2000;

const C = {
	reset: "\x1b[0m",
	dim: "\x1b[2m",
	bold: "\x1b[1m",
	green: "\x1b[32m",
	yellow: "\x1b[33m",
	red: "\x1b[31m",
	cyan: "\x1b[36m",
	gray: "\x1b[90m",
};
const clear = () => process.stdout.write("\x1b[2J\x1b[H");
const hideCursor = () => process.stdout.write("\x1b[?25l");
const showCursor = () => process.stdout.write("\x1b[?25h");

const STATUS_COLOR = {
	working: C.yellow,
	idle: C.green,
	done: C.green,
	blocked: C.red,
	unknown: C.gray,
	dry: C.cyan,
};

function fetchBoard() {
	const r = spawnSync(
		process.execPath,
		[`${ROOT}/scripts/stage1-runtime.mjs`, "board"],
		{ encoding: "utf8", timeout: 8000 },
	);
	if (r.status !== 0 || !r.stdout)
		return { error: (r.stderr || "board read failed").trim() };
	try {
		return JSON.parse(r.stdout.trim().split("\n").pop());
	} catch (e) {
		return { error: "unparsable board: " + e.message };
	}
}

function pad(s, n) {
	s = String(s ?? "");
	return s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length);
}
function shortenCwd(p) {
	if (!p) return "";
	const home = process.env.HOME || "";
	if (home && p.startsWith(home)) p = "~" + p.slice(home.length);
	return p.length > 44 ? "…" + p.slice(-43) : p;
}

function render(board, tick) {
	clear();
	const spin = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"[tick % 10];
	process.stdout.write(
		`${C.bold}${C.cyan}  Conductor Board${C.reset}  ${C.dim}${spin} refreshing every ${POLL_MS / 1000}s · q to quit${C.reset}\n\n`,
	);
	if (board.error) {
		process.stdout.write(`  ${C.red}${board.error}${C.reset}\n`);
		return;
	}
	if (!board.run || !board.workers || board.workers.length === 0) {
		process.stdout.write(
			`  ${C.dim}No active conductor run. Invoke the Assemble action from this workspace.${C.reset}\n`,
		);
		return;
	}
	process.stdout.write(`  ${C.dim}run ${board.run}${C.reset}\n\n`);
	process.stdout.write(
		`  ${C.bold}${pad("ROLE", 16)}${pad("KIND", 8)}${pad("PANE", 8)}${pad("STATUS", 10)}CWD${C.reset}\n`,
	);
	for (const w of board.workers) {
		const col = STATUS_COLOR[w.status] || C.gray;
		process.stdout.write(
			`  ${pad(w.role, 16)}${C.dim}${pad(w.kind, 8)}${pad(w.pane, 8)}${C.reset}${col}${pad(w.status, 10)}${C.reset}${C.dim}${shortenCwd(w.cwd)}${C.reset}\n`,
		);
	}
	const working = board.workers.filter((w) => w.status === "working").length;
	process.stdout.write(
		`\n  ${C.dim}${board.workers.length} worker(s), ${working} working${C.reset}\n`,
	);
}

let tick = 0,
	timer = null;
function loop() {
	render(fetchBoard(), tick++);
	timer = setTimeout(loop, POLL_MS);
}
function quit() {
	if (timer) clearTimeout(timer);
	showCursor();
	clear();
	process.exit(0);
}

if (process.stdin.isTTY) {
	process.stdin.setRawMode(true);
	process.stdin.resume();
	process.stdin.on("data", (b) => {
		const k = b.toString();
		if (k === "q" || k === "\x03") quit();
	});
}
process.on("SIGINT", quit);
process.on("SIGTERM", quit);
hideCursor();
loop();

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	mkdtempSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const command = JSON.parse(
	readFileSync(new URL("../package.json", import.meta.url), "utf8"),
).scripts["check:shell"];

test("shell validation checks later scripts, handles spaces, and never executes them", () => {
	const root = mkdtempSync(join(tmpdir(), "conductor-shell-check-"));
	try {
		mkdirSync(join(root, "scripts"));
		writeFileSync(join(root, "scripts", "a.sh"), "exit 42\n");
		writeFileSync(join(root, "scripts", "z later.sh"), "if then\n");
		const invalid = spawnSync("/bin/sh", ["-c", command], {
			cwd: root,
			encoding: "utf8",
		});
		assert.notEqual(invalid.status, 0);
		assert.match(invalid.stderr, /z later\.sh/);
		writeFileSync(join(root, "scripts", "z later.sh"), "exit 43\n");
		const valid = spawnSync("/bin/sh", ["-c", command], {
			cwd: root,
			encoding: "utf8",
		});
		assert.equal(valid.status, 0, valid.stderr);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

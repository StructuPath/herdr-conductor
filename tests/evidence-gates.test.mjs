import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
	B0_EVIDENCE_PATHS,
	checkEvidenceInventory,
} from "../scripts/check-evidence-inventory.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function runNode(script) {
	return execFileSync(process.execPath, [path.join(root, script)], {
		cwd: root,
		encoding: "utf8",
	});
}

test("retained evidence gate runs both B0 and B4 checkers", () => {
	const command = JSON.parse(
		fs.readFileSync(path.join(root, "package.json"), "utf8"),
	).scripts["check:evidence"];
	assert.match(command, /check-evidence-inventory\.mjs/);
	assert.match(command, /check-b0-identity-evidence\.mjs/);
	assert.match(command, /check-stage1-live-smoke-evidence\.mjs/);
	assert.match(runNode("scripts/check-b0-identity-evidence.mjs"), /B0 identity evidence valid/);
	assert.match(
		runNode("scripts/check-stage1-live-smoke-evidence.mjs"),
		/Stage 1 (?:B4 live evidence|runtime source manifest) valid/,
	);
});

test("every retained B0 artifact is required by the evidence inventory", () => {
	const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "conductor-b0-inventory-"));
	try {
		for (const relative of B0_EVIDENCE_PATHS) {
			const target = path.join(fixture, relative);
			fs.mkdirSync(path.dirname(target), { recursive: true });
			fs.writeFileSync(target, relative);
		}
		assert.match(checkEvidenceInventory(fixture), /5 foundational files/);
		for (const relative of B0_EVIDENCE_PATHS) {
			const target = path.join(fixture, relative);
			fs.rmSync(target);
			assert.throws(
				() => checkEvidenceInventory(fixture),
				new RegExp(`retained B0 evidence is missing: ${relative.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
			);
			fs.mkdirSync(path.dirname(target), { recursive: true });
			fs.writeFileSync(target, relative);
		}
	} finally {
		fs.rmSync(fixture, { recursive: true, force: true });
	}
});

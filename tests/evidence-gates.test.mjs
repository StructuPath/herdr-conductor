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
import { STAGE2_EVIDENCE_PATHS } from "../scripts/stage2-evidence-contract.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function runNode(script) {
	return execFileSync(process.execPath, [path.join(root, script)], {
		cwd: root,
		encoding: "utf8",
	});
}

test("retained evidence gate runs B0/B4 compatibility and predeclares the Stage 2 release checker", () => {
	const command = JSON.parse(
		fs.readFileSync(path.join(root, "package.json"), "utf8"),
	).scripts["check:evidence"];
	assert.match(command, /check-evidence-inventory\.mjs/);
	assert.match(command, /check-b0-identity-evidence\.mjs/);
	assert.match(command, /check-stage1-live-smoke-evidence\.mjs/);
	const release = JSON.parse(
		fs.readFileSync(path.join(root, "package.json"), "utf8"),
	).scripts["check:release"];
	assert.match(release, /check-stage2-live-evidence\.mjs/);
	assert.match(
		runNode("scripts/check-b0-identity-evidence.mjs"),
		/B0 identity evidence valid/,
	);
	assert.match(
		runNode("scripts/check-stage1-live-smoke-evidence.mjs"),
		/Stage 1 (?:B4 live evidence|runtime source manifest) valid/,
	);
});

test("every retained B0 artifact is required by the evidence inventory", () => {
	const fixture = fs.mkdtempSync(
		path.join(os.tmpdir(), "conductor-b0-inventory-"),
	);
	try {
		for (const relative of B0_EVIDENCE_PATHS) {
			const target = path.join(fixture, relative);
			fs.mkdirSync(path.dirname(target), { recursive: true });
			fs.writeFileSync(target, relative);
		}
		assert.match(checkEvidenceInventory(fixture), /5 foundational files/);
		const partial = path.join(fixture, STAGE2_EVIDENCE_PATHS[0]);
		fs.mkdirSync(path.dirname(partial), { recursive: true });
		fs.writeFileSync(partial, "partial");
		assert.throws(
			() => checkEvidenceInventory(fixture),
			/absent at Commit A or present as the exact complete trio/,
		);
		fs.rmSync(partial);
		for (const relative of B0_EVIDENCE_PATHS) {
			const target = path.join(fixture, relative);
			fs.rmSync(target);
			assert.throws(
				() => checkEvidenceInventory(fixture),
				new RegExp(
					`retained B0 evidence is missing: ${relative.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
				),
			);
			fs.mkdirSync(path.dirname(target), { recursive: true });
			fs.writeFileSync(target, relative);
		}
	} finally {
		fs.rmSync(fixture, { recursive: true, force: true });
	}
});

#!/usr/bin/env node
import assert from "node:assert/strict";
import { statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const B0_EVIDENCE_PATHS = [
	"docs/evidence/2026-07-28-herdr-0.7.5-identity-capability.json",
	"docs/evidence/2026-07-28-herdr-0.7.5-identity-capability.md",
	"docs/evidence/2026-07-28-herdr-0.7.5-negative-fixture-results.json",
	"docs/evidence/fixtures/2026-07-28-herdr-0.7.5-identity-fixtures.json",
	"scripts/check-b0-identity-evidence.mjs",
];

export function checkEvidenceInventory(root) {
	for (const path of B0_EVIDENCE_PATHS) {
		assert.equal(
			statSync(join(root, path), { throwIfNoEntry: false })?.isFile(),
			true,
			`retained B0 evidence is missing: ${path}`,
		);
	}
	return `Retained B0 evidence inventory valid: ${B0_EVIDENCE_PATHS.length} foundational files.\n`;
}

const sourcePath = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === sourcePath) {
	try {
		process.stdout.write(checkEvidenceInventory(join(dirname(sourcePath), "..")));
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}

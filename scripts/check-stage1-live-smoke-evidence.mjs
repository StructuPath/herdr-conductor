#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	canonicalJson,
	parseStrictJsonBytes,
} from "./private-state-schema.mjs";
import {
	buildCandidateRuntimeSourceManifest,
	resolveCandidateCommit,
	validateEvidence,
	validateRuntimeSourceManifest,
} from "./stage1-evidence-contract.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = join(
	root,
	"docs/evidence/stage1-runtime-source-manifest.json",
);
const jsonPath = join(
	root,
	"docs/evidence/2026-07-28-stage1-b4-live-smoke.json",
);
const reportPath = join(
	root,
	"docs/evidence/2026-07-28-stage1-b4-live-smoke.md",
);

export function checkCandidateProvenance(
	rootPath,
	candidate,
	retainedManifest,
	currentManifest,
) {
	const candidateManifest = buildCandidateRuntimeSourceManifest(
		rootPath,
		candidate,
	);
	assert.equal(
		canonicalJson(candidateManifest),
		canonicalJson(retainedManifest),
		"candidate Git tree differs from retained runtime source manifest",
	);
	if (currentManifest !== undefined)
		assert.equal(
			canonicalJson(candidateManifest),
			canonicalJson(currentManifest),
			"candidate Git tree differs from supplied runtime source",
		);
	return candidateManifest;
}

export function checkEvidence() {
	const sourceManifest = parseStrictJsonBytes(readFileSync(manifestPath));
	const hasJson = existsSync(jsonPath);
	const hasReport = existsSync(reportPath);
	assert.equal(
		hasJson,
		hasReport,
		"machine and human live evidence must be retained together",
	);
	if (!hasJson) {
		return `Stage 1 runtime source manifest valid: ${sourceManifest.files.length} exact files; no live run is claimed in this candidate commit.\n`;
	}
	const evidenceBytes = readFileSync(jsonPath);
	const reportBytes = readFileSync(reportPath);
	const evidence = parseStrictJsonBytes(evidenceBytes);
	const candidate = resolveCandidateCommit(root, evidence.candidate.commit);
	const sourceManifestDigest = validateRuntimeSourceManifest(
		sourceManifest,
		root,
		(path) => execFileSync("git", ["-C", root, "show", `${candidate}:${path}`]),
	);
	checkCandidateProvenance(root, candidate, sourceManifest);
	validateEvidence(evidence, { sourceManifestDigest, reportBytes });
	const serialized = `${evidenceBytes.toString("utf8")}\n${reportBytes.toString("utf8")}`;
	assert.doesNotMatch(
		serialized,
		/(?:\/Users\/|\/tmp\/|herdr\.sock|\.jsonl|api[_-]?key|token["']?\s*:)/i,
		"evidence contains a forbidden raw value",
	);
	return `Stage 1 B4 live evidence valid: ${evidence.invocations.length} strict invocations, ${evidence.isolation.probes.length} isolation refusals, zero cleanup residue.\n`;
}

const sourcePath = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === sourcePath) {
	try {
		process.stdout.write(checkEvidence());
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}

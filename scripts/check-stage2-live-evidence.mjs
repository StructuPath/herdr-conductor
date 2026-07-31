#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJson, StateKernelError } from "./private-state-schema.mjs";
import {
	buildStage2SourceManifest,
	STAGE2_EVIDENCE_PATHS,
	validateEvidenceBytes,
} from "./stage2-evidence-contract.mjs";

function fail(code, message, cause) {
	throw new StateKernelError(code, message, cause ? { cause } : undefined);
}
function git(repository, args, encoding = "utf8") {
	try {
		return execFileSync("git", ["-C", repository, ...args], {
			encoding,
			stdio: ["ignore", "pipe", "pipe"],
		});
	} catch (error) {
		fail("candidate_mismatch", `git ${args[0]} failed`, error);
	}
}
function commit(repository, revision, label) {
	const value = git(repository, [
		"rev-parse",
		"--verify",
		`${revision}^{commit}`,
	]).trim();
	if (!/^[a-f0-9]{40}$/.test(value))
		fail("candidate_mismatch", `${label} is not a SHA-1 commit`);
	return value;
}
function blob(repository, revision, path) {
	const type = git(repository, [
		"cat-file",
		"-t",
		`${revision}:${path}`,
	]).trim();
	if (type !== "blob")
		fail("candidate_mismatch", `${path} is not a regular Git blob`);
	return git(repository, ["show", `${revision}:${path}`], null);
}

export function checkCommittedEvidence(repository, commitA, commitB) {
	const a = commit(repository, commitA, "Commit A");
	const b = commit(repository, commitB, "Commit B");
	try {
		execFileSync(
			"git",
			["-C", repository, "merge-base", "--is-ancestor", a, b],
			{ stdio: "ignore" },
		);
	} catch (error) {
		fail(
			"candidate_mismatch",
			"Commit A is not an ancestor of Commit B",
			error,
		);
	}
	const changed = git(repository, [
		"diff",
		"--name-only",
		"--diff-filter=ACDMRTUXB",
		`${a}..${b}`,
		"--",
	])
		.trim()
		.split("\n")
		.filter(Boolean)
		.sort();
	if (changed.join("\0") !== [...STAGE2_EVIDENCE_PATHS].sort().join("\0"))
		fail(
			"candidate_mismatch",
			"Commit A..B is not the exact three evidence paths",
		);
	const source = blob(repository, b, STAGE2_EVIDENCE_PATHS[0]);
	const expectedSource = Buffer.from(
		canonicalJson(buildStage2SourceManifest(repository, a)),
	);
	if (!source.equals(expectedSource))
		fail(
			"candidate_mismatch",
			"source manifest does not reproduce immutable Commit A bytes",
		);
	const machine = blob(repository, b, STAGE2_EVIDENCE_PATHS[1]);
	const human = blob(repository, b, STAGE2_EVIDENCE_PATHS[2]);
	const result = validateEvidenceBytes(source, human, machine, a);
	return Object.freeze({
		commitA: a,
		commitB: b,
		changedPaths: Object.freeze(changed),
		completionDigest: result.completionDigest,
	});
}

async function main() {
	const repository = resolve(process.argv[2] ?? ".");
	const commitB = process.argv[3] ?? "HEAD";
	const parents = git(repository, ["rev-list", "--parents", "-n", "1", commitB])
		.trim()
		.split(/\s+/);
	if (parents.length !== 2)
		fail(
			"candidate_mismatch",
			"Commit B must have exactly one parent Commit A",
		);
	const result = checkCommittedEvidence(repository, parents[1], parents[0]);
	process.stdout.write(
		`Stage 2 committed evidence valid: ${result.completionDigest}\n`,
	);
}
if (
	process.argv[1] &&
	resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
	main().catch((error) => {
		process.stderr.write(
			`herdr-conductor: ${error.code ?? "internal_error"}: ${error.message}\n`,
		);
		process.exitCode = 1;
	});

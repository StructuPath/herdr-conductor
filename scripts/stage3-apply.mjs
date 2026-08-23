#!/usr/bin/env node
import { createHash } from "node:crypto";
import {
	StateKernelError,
	canonicalJson,
	validateFullRef,
	validateGitObjectId,
} from "./private-state-schema.mjs";
import { STAGE3_CONFIG_VERSION } from "./task-report-schema.mjs";

function fail(code, message, cause) {
	throw new StateKernelError(code, message, cause ? { cause } : undefined);
}

function gitLine(exec, repo, args) {
	const output = exec("git", ["-C", repo, ...args]);
	if (typeof output !== "string" || !output || output.includes("\n"))
		fail(
			"invalid_repository",
			`git ${args.join(" ")} returned ambiguous output`,
		);
	return output;
}

export function stage3ApplyTargetRef(config) {
	if (!config || config.version !== STAGE3_CONFIG_VERSION) return null;
	if (config.apply === null) return null;
	return validateFullRef(config.apply.target_ref, "configured apply target");
}

export function observeStage3ApplyTarget({
	repository,
	targetRef,
	integration,
	exec,
} = {}) {
	validateFullRef(targetRef, "apply target ref");
	validateFullRef(integration?.target_ref, "integration target ref");
	validateGitObjectId(integration.starting_sha, "integration starting SHA");
	validateGitObjectId(integration.final_sha, "integration final SHA");
	if (targetRef === integration.target_ref)
		fail(
			"invalid_config",
			"apply target must differ from the integration target",
		);
	if (integration.starting_sha === integration.final_sha)
		fail("stale_source", "integration produced nothing to apply");
	const integrationSha = gitLine(exec, repository, [
		"rev-parse",
		integration.target_ref,
	]);
	if (integrationSha !== integration.final_sha)
		fail(
			"stale_source",
			"integration target ref no longer holds the integrated SHA",
		);
	let observedSha;
	try {
		observedSha = gitLine(exec, repository, [
			"show-ref",
			"--verify",
			"--hash",
			targetRef,
		]);
	} catch (error) {
		if (error instanceof StateKernelError && error.code === "invalid_repository")
			throw error;
		fail("stale_source", "apply target ref does not exist", error);
	}
	validateGitObjectId(observedSha, "apply target SHA");
	if (observedSha !== integration.starting_sha)
		fail(
			"stale_source",
			"apply target ref is not at the run's integration base",
		);
	const worktrees = exec("git", [
		"-C",
		repository,
		"worktree",
		"list",
		"--porcelain",
	]);
	if (typeof worktrees !== "string")
		fail("invalid_repository", "git worktree inventory is ambiguous");
	if (
		worktrees
			.split("\n")
			.some((line) => line === `branch ${targetRef}`)
	)
		fail(
			"stale_source",
			"apply target ref is checked out in a repository worktree",
		);
	try {
		exec("git", [
			"-C",
			repository,
			"merge-base",
			"--is-ancestor",
			observedSha,
			integration.final_sha,
		]);
	} catch (error) {
		fail(
			"stale_source",
			"proposed apply is not a fast-forward of the target",
			error,
		);
	}
	const diff = exec(
		"git",
		[
			"-C",
			repository,
			"diff",
			"--name-status",
			"--no-renames",
			"-z",
			observedSha,
			integration.final_sha,
		],
		{ maxBuffer: 16 * 1024 * 1024 },
	);
	if (typeof diff !== "string")
		fail("invalid_repository", "apply change summary is ambiguous");
	const changedPathCount = diff
		.split("\0")
		.filter((field, index) => field !== "" && index % 2 === 0).length;
	if (changedPathCount < 1)
		fail("stale_source", "apply change summary is empty");
	return Object.freeze({
		target_ref: targetRef,
		observed_sha: observedSha,
		final_sha: integration.final_sha,
		diff_name_status_sha256: createHash("sha256").update(diff).digest("hex"),
		changed_path_count: changedPathCount,
	});
}

export function publishStage3ApplyCas({
	repository,
	targetRef,
	expectedSha,
	finalSha,
	preflight,
	exec,
	fault,
} = {}) {
	validateFullRef(targetRef, "apply target ref");
	validateGitObjectId(expectedSha, "apply expected SHA");
	validateGitObjectId(finalSha, "apply final SHA");
	if (expectedSha === finalSha)
		fail("stale_source", "apply has nothing to publish");
	if (typeof preflight !== "function")
		fail("bookkeeping_unknown", "apply publication preflight is required");
	const before = preflight();
	if (canonicalJson(before) !== canonicalJson(preflight()))
		fail("stale_source", "apply authority changed between preflights");
	fault?.("apply.before_cas");
	if (canonicalJson(before) !== canonicalJson(preflight()))
		fail(
			"stale_source",
			"apply authority changed immediately before compare-and-swap",
		);
	exec("git", ["-C", repository, "update-ref", targetRef, finalSha, expectedSha]);
	fault?.("apply.after_cas");
	const published = gitLine(exec, repository, ["rev-parse", targetRef]);
	if (published !== finalSha)
		fail(
			"durability_unknown",
			"published apply ref does not equal the approved final SHA",
		);
	return Object.freeze({ casCount: 1, finalSha });
}

export function resolveStage3ApplyOutcome({
	repository,
	targetRef,
	expectedSha,
	finalSha,
	exec,
} = {}) {
	validateFullRef(targetRef, "apply target ref");
	validateGitObjectId(expectedSha, "apply expected SHA");
	validateGitObjectId(finalSha, "apply final SHA");
	let observed;
	try {
		observed = gitLine(exec, repository, [
			"show-ref",
			"--verify",
			"--hash",
			targetRef,
		]);
	} catch (error) {
		fail(
			"foreign_or_stale",
			"uncertain apply target cannot be observed",
			error,
		);
	}
	if (observed === finalSha)
		return Object.freeze({ outcome: "applied", cas_count: 1 });
	if (observed === expectedSha)
		return Object.freeze({ outcome: "unapplied", cas_count: 0 });
	fail(
		"foreign_or_stale",
		"uncertain apply target holds a foreign SHA and cannot be resolved",
	);
}

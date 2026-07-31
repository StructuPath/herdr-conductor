#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import {
	StateKernelError,
	canonicalJson,
	validateGitObjectId,
} from "./private-state-schema.mjs";
import { resolveGitCommonDirectory } from "./state-kernel.mjs";

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

function sameCommonDirectory(left, right) {
	return (
		left.path === right.path &&
		left.device === right.device &&
		left.inode === right.inode
	);
}

function liveRepositoryIdentity(path, exec) {
	const repositoryRoot = realpathSync(
		gitLine(exec, path, ["rev-parse", "--show-toplevel"]),
	);
	const commonPath = realpathSync(
		gitLine(exec, path, [
			"rev-parse",
			"--path-format=absolute",
			"--git-common-dir",
		]),
	);
	const stats = statSync(commonPath, { bigint: true });
	if (!stats.isDirectory())
		fail("invalid_repository", "live Git common directory is not a directory");
	return {
		repositoryRoot,
		commonDirectory: {
			path: commonPath,
			device: stats.dev.toString(10),
			inode: stats.ino.toString(10),
		},
	};
}

function worktreeMembership(exec, repositoryRoot, expectedPath, expectedRef) {
	const output = exec("git", [
		"-C",
		repositoryRoot,
		"worktree",
		"list",
		"--porcelain",
	]);
	if (typeof output !== "string")
		fail("invalid_repository", "git worktree inventory is ambiguous");
	const matches = output.split(/\n\n+/).filter((block) => {
		const lines = block.split("\n");
		return (
			lines.filter((line) => line === `worktree ${expectedPath}`).length ===
				1 &&
			lines.filter((line) => line === `branch ${expectedRef}`).length === 1
		);
	});
	if (matches.length !== 1)
		fail(
			"foreign_or_stale",
			"worktree is missing, duplicated, or unregistered",
		);
}

function canonicalExisting(path, label) {
	let canonical;
	try {
		canonical = realpathSync(path);
	} catch (error) {
		fail("foreign_or_stale", `${label} cannot be canonicalized`, error);
	}
	if (canonical !== path)
		fail("foreign_or_stale", `${label} canonical path changed`);
	return canonical;
}

export function observeCreatedWorktree(
	path,
	branchRef,
	forkSha,
	repository,
	exec,
) {
	const canonicalPath = canonicalExisting(path, "worktree path");
	const resolved = resolveGitCommonDirectory(canonicalPath);
	const headSha = gitLine(exec, canonicalPath, ["rev-parse", "HEAD"]);
	const observedRef = gitLine(exec, canonicalPath, [
		"symbolic-ref",
		"-q",
		"HEAD",
	]);
	validateGitObjectId(headSha, "worktree head");
	worktreeMembership(exec, canonicalPath, canonicalPath, branchRef);
	if (
		resolved.repository.key !== repository.key ||
		observedRef !== branchRef ||
		headSha !== forkSha
	)
		fail(
			"foreign_or_stale",
			"created worktree identity does not match its intent",
		);
	return {
		path: canonicalPath,
		common_dir: resolved.repository.common_dir,
		branch_ref: branchRef,
		fork_sha: forkSha,
		head_sha: headSha,
		registered: true,
	};
}

export function bindIntegrationTarget(active, exec) {
	const path = canonicalExisting(
		active.store.repositoryRoot,
		"integration target path",
	);
	if (path !== active.state.repository_root)
		fail("foreign_or_stale", "integration target canonical path changed");
	const resolved = liveRepositoryIdentity(path, exec);
	const branchRef = gitLine(exec, path, ["symbolic-ref", "-q", "HEAD"]);
	const headSha = gitLine(exec, path, ["rev-parse", "HEAD"]);
	const refSha = gitLine(exec, path, ["rev-parse", branchRef]);
	validateGitObjectId(headSha, "integration target head");
	worktreeMembership(exec, path, path, branchRef);
	if (
		resolved.repositoryRoot !== path ||
		!sameCommonDirectory(
			resolved.commonDirectory,
			active.state.repository.common_dir,
		) ||
		headSha !== refSha ||
		headSha !== active.state.fork_sha
	)
		fail(
			"foreign_or_stale",
			"integration target identity changed before binding",
		);
	if (
		exec("git", [
			"-C",
			path,
			"status",
			"--porcelain=v1",
			"--untracked-files=no",
		]) !== ""
	)
		fail("foreign_or_stale", "integration target worktree is not clean");
	return {
		path,
		common_dir: resolved.commonDirectory,
		branch_ref: branchRef,
		fork_sha: active.state.fork_sha,
		head_sha: headSha,
		registered: true,
	};
}

export function liveSourceIdentity(recorded, active, exec) {
	const path = canonicalExisting(recorded.path, "source worktree path");
	const resolved = liveRepositoryIdentity(path, exec);
	const branchRef = gitLine(exec, path, ["symbolic-ref", "-q", "HEAD"]);
	const headSha = gitLine(exec, path, ["rev-parse", "HEAD"]);
	const refSha = gitLine(exec, path, ["rev-parse", recorded.branch_ref]);
	validateGitObjectId(headSha, "source worktree head");
	worktreeMembership(
		exec,
		active.store.repositoryRoot,
		path,
		recorded.branch_ref,
	);
	if (
		resolved.repositoryRoot !== path ||
		!sameCommonDirectory(resolved.commonDirectory, recorded.common_dir) ||
		!sameCommonDirectory(
			resolved.commonDirectory,
			active.store.repository.common_dir,
		) ||
		branchRef !== recorded.branch_ref ||
		recorded.fork_sha !== active.state.fork_sha ||
		headSha !== refSha
	)
		fail("foreign_or_stale", "live source worktree identity changed");
	try {
		exec("git", [
			"-C",
			path,
			"merge-base",
			"--is-ancestor",
			recorded.fork_sha,
			headSha,
		]);
	} catch (error) {
		fail(
			"foreign_or_stale",
			"source head is not descended from the fixed fork",
			error,
		);
	}
	return { ...recorded, head_sha: headSha, registered: true };
}

function readIntegrationTargetIdentity(expected, active, exec) {
	const path = canonicalExisting(expected.path, "integration target path");
	const resolved = liveRepositoryIdentity(path, exec);
	const branchRef = gitLine(exec, path, ["symbolic-ref", "-q", "HEAD"]);
	const headSha = gitLine(exec, path, ["rev-parse", "HEAD"]);
	const refSha = gitLine(exec, path, ["rev-parse", expected.branch_ref]);
	validateGitObjectId(headSha, "integration target head");
	validateGitObjectId(refSha, "integration target ref");
	worktreeMembership(
		exec,
		active.store.repositoryRoot,
		path,
		expected.branch_ref,
	);
	return {
		path,
		common_dir: resolved.commonDirectory,
		branch_ref: branchRef,
		fork_sha: expected.fork_sha,
		head_sha: headSha,
		ref_sha: refSha,
		repository_root: resolved.repositoryRoot,
		registered: true,
	};
}

function expectedLiveTarget(expected) {
	return {
		...expected,
		ref_sha: expected.head_sha,
		repository_root: expected.path,
		registered: true,
	};
}

function targetDrift(expected, actual, message) {
	const error = new StateKernelError(
		"foreign_or_stale",
		`${message}: expected ${expected.branch_ref}@${expected.ref_sha}; actual ${actual.branch_ref}@${actual.ref_sha} (HEAD ${actual.head_sha})`,
	);
	error.expectedIdentity = expected;
	error.actualIdentity = actual;
	throw error;
}

function requireIntegrationTargetIdentity(expected, active, exec) {
	const actual = readIntegrationTargetIdentity(expected, active, exec);
	const wanted = expectedLiveTarget(expected);
	if (
		canonicalJson(actual) !== canonicalJson(wanted) ||
		!sameCommonDirectory(
			actual.common_dir,
			active.store.repository.common_dir,
		) ||
		expected.fork_sha !== active.state.fork_sha
	)
		targetDrift(
			wanted,
			actual,
			"integration target no longer matches run authority",
		);
	return actual;
}

export function liveIntegrationTarget(expected, active, exec) {
	const actual = requireIntegrationTargetIdentity(expected, active, exec);
	if (
		exec("git", [
			"-C",
			actual.path,
			"status",
			"--porcelain=v1",
			"--untracked-files=no",
		]) !== ""
	)
		fail("foreign_or_stale", "integration target worktree is not clean");
	return { ...expected, registered: true };
}

function checkpoint(fault, name) {
	if (typeof fault === "function") fault(name);
}

function verifySynchronizationBase(expected, mergedHead, active, exec) {
	const actual = readIntegrationTargetIdentity(expected, active, exec);
	const wanted = {
		...expectedLiveTarget(expected),
		head_sha: mergedHead,
		ref_sha: mergedHead,
	};
	if (
		canonicalJson(actual) !== canonicalJson(wanted) ||
		!sameCommonDirectory(actual.common_dir, active.store.repository.common_dir)
	)
		targetDrift(
			wanted,
			actual,
			"integration target changed after compare-and-swap",
		);
	const indexTree = gitLine(exec, actual.path, ["write-tree"]);
	const oldTree = gitLine(exec, actual.path, [
		"rev-parse",
		`${expected.head_sha}^{tree}`,
	]);
	if (indexTree !== oldTree)
		fail(
			"foreign_or_stale",
			"integration target index changed before synchronization",
		);
	try {
		exec("git", ["-C", actual.path, "diff-files", "--quiet"]);
	} catch (error) {
		fail(
			"foreign_or_stale",
			"integration target worktree changed before synchronization",
			error,
		);
	}
}

export function validateMergeResultPublication({ active, result, exec }) {
	const target = requireIntegrationTargetIdentity(result.target, active, exec);
	const indexTree = gitLine(exec, target.path, ["write-tree"]);
	const mergedTree = gitLine(exec, target.path, [
		"rev-parse",
		`${target.head_sha}^{tree}`,
	]);
	if (indexTree !== mergedTree)
		fail(
			"foreign_or_stale",
			"integration target index changed before result publication",
		);
	try {
		exec("git", ["-C", target.path, "diff-files", "--quiet"]);
	} catch (error) {
		fail(
			"foreign_or_stale",
			"integration target worktree changed before result publication",
			error,
		);
	}
	if (
		exec("git", [
			"-C",
			target.path,
			"status",
			"--porcelain=v1",
			"--untracked-files=no",
		]) !== ""
	)
		fail(
			"foreign_or_stale",
			"integration target worktree is not clean before result publication",
		);
}

export function buildOrderedProducerSelection(producers) {
	if (!Array.isArray(producers))
		fail("bookkeeping_unknown", "producer selection must be an array");
	const selection = producers.map((producer) => {
		const value = {
			role_name: producer.role_name,
			task_digest: producer.task_digest,
			report_digest: producer.report_digest,
			source_sha: producer.source_sha,
			tree_sha: producer.tree_sha,
			source_generation: producer.source_generation,
		};
		if (
			typeof value.role_name !== "string" ||
			![value.task_digest, value.report_digest].every((entry) =>
				/^[a-f0-9]{64}$/.test(entry),
			) ||
			![value.source_sha, value.tree_sha].every((entry) =>
				/^[a-f0-9]{40}$/.test(entry),
			) ||
			!/^[a-f0-9]{32}$/.test(value.source_generation)
		)
			fail("bookkeeping_unknown", "producer selection entry is invalid");
		return Object.freeze(value);
	});
	selection.sort((left, right) =>
		Buffer.compare(Buffer.from(left.role_name), Buffer.from(right.role_name)),
	);
	if (
		new Set(selection.map(({ role_name }) => role_name)).size !==
		selection.length
	)
		fail("bookkeeping_unknown", "producer selection contains duplicate roles");
	return Object.freeze(selection);
}

function deterministicGit(repository, args, options = {}) {
	try {
		return (options.execFile ?? execFileSync)(
			"git",
			["-C", repository, "-c", "commit.gpgSign=false", ...args],
			{
				encoding: "utf8",
				stdio:
					options.input === undefined
						? ["ignore", "pipe", "pipe"]
						: ["pipe", "pipe", "pipe"],
				input: options.input,
				env: {
					...process.env,
					LC_ALL: "C",
					LANG: "C",
					TZ: "UTC",
					GIT_AUTHOR_NAME: "Herdr Conductor",
					GIT_AUTHOR_EMAIL: "conductor@local.invalid",
					GIT_AUTHOR_DATE: "2000-01-01T00:00:00+00:00",
					GIT_COMMITTER_NAME: "Herdr Conductor",
					GIT_COMMITTER_EMAIL: "conductor@local.invalid",
					GIT_COMMITTER_DATE: "2000-01-01T00:00:00+00:00",
				},
			},
		).trim();
	} catch (error) {
		fail(
			"source_policy_violation",
			`deterministic Git ${args[0]} failed`,
			error,
		);
	}
}

export function planCompleteIntegration({
	repository,
	targetSha,
	producers,
	execFile,
} = {}) {
	validateGitObjectId(targetSha, "integration target SHA");
	const selection = buildOrderedProducerSelection(producers ?? []);
	let virtualTarget = targetSha;
	const commits = [];
	for (const producer of selection) {
		const tree = deterministicGit(
			repository,
			["merge-tree", "--write-tree", virtualTarget, producer.source_sha],
			{ execFile },
		);
		validateGitObjectId(tree, "integration tree");
		const message = `Conductor Stage 2 integrate ${producer.role_name} ${producer.source_sha}\n`;
		const commit = deterministicGit(
			repository,
			[
				"commit-tree",
				tree,
				"-p",
				virtualTarget,
				"-p",
				producer.source_sha,
				"-F",
				"-",
			],
			{ execFile, input: message },
		);
		validateGitObjectId(commit, "integration commit");
		commits.push(
			Object.freeze({
				role_name: producer.role_name,
				tree_sha: tree,
				commit_sha: commit,
				parents: Object.freeze([virtualTarget, producer.source_sha]),
				message,
			}),
		);
		virtualTarget = commit;
	}
	return Object.freeze({
		selection,
		startingTargetSha: targetSha,
		finalSha: virtualTarget,
		commits: Object.freeze(commits),
		casRequired: selection.length > 0,
	});
}

export function publishIntegrationCas({
	repository,
	targetRef,
	expectedTargetSha,
	plan,
	preflight,
	execFile,
	fault,
} = {}) {
	if (!plan || plan.startingTargetSha !== expectedTargetSha)
		fail("stale_source", "integration plan does not bind the expected target");
	if (typeof preflight !== "function")
		fail("bookkeeping_unknown", "complete integration preflight is required");
	const before = preflight();
	if (canonicalJson(before) !== canonicalJson(preflight()))
		fail(
			"stale_source",
			"integration authority changed between collective preflights",
		);
	if (!plan.casRequired)
		return Object.freeze({ casCount: 0, finalSha: expectedTargetSha });
	fault?.("integration.before_cas");
	if (canonicalJson(before) !== canonicalJson(preflight()))
		fail(
			"stale_source",
			"integration authority changed immediately before compare-and-swap",
		);
	deterministicGit(
		repository,
		["update-ref", targetRef, plan.finalSha, expectedTargetSha],
		{ execFile },
	);
	fault?.("integration.after_cas");
	return Object.freeze({ casCount: 1, finalSha: plan.finalSha });
}

export function synchronizeIntegrationTarget({
	expectedTarget,
	finalSha,
	active,
	exec,
	fault,
} = {}) {
	validateGitObjectId(finalSha, "integration final SHA");
	verifySynchronizationBase(expectedTarget, finalSha, active, exec);
	checkpoint(fault, "integration.before_sync");
	exec("git", [
		"-C",
		expectedTarget.path,
		"read-tree",
		"-u",
		"-m",
		expectedTarget.head_sha,
		finalSha,
	]);
	checkpoint(fault, "integration.during_sync");
	const observed = liveIntegrationTarget(
		{ ...expectedTarget, head_sha: finalSha },
		active,
		exec,
	);
	checkpoint(fault, "integration.before_observed_publication");
	return observed;
}

export function validateIntegrationPublication({
	repository,
	targetRef,
	expectedSha,
	execFile,
} = {}) {
	const actual = deterministicGit(repository, ["rev-parse", targetRef], {
		execFile,
	});
	if (actual !== expectedSha)
		fail(
			"stale_source",
			"published integration ref does not equal the planned final SHA",
		);
	return actual;
}

export function mergeImmutableSource({
	active,
	recordedSource,
	expectedTarget,
	exec,
	fault,
}) {
	const source = liveSourceIdentity(recordedSource, active, exec);
	checkpoint(fault, "after_final_source_read");
	const target = liveIntegrationTarget(expectedTarget, active, exec);
	checkpoint(fault, "after_final_target_read");
	if (source.path === target.path || source.branch_ref === target.branch_ref)
		fail(
			"foreign_or_stale",
			"source and integration target identities overlap",
		);
	const tree = gitLine(exec, target.path, [
		"merge-tree",
		"--write-tree",
		target.head_sha,
		source.head_sha,
	]);
	validateGitObjectId(tree, "merged tree");
	const mergedHead = gitLine(exec, target.path, [
		"commit-tree",
		tree,
		"-p",
		target.head_sha,
		"-p",
		source.head_sha,
		"-m",
		`Conductor merge ${source.head_sha}`,
	]);
	validateGitObjectId(mergedHead, "merged commit");
	checkpoint(fault, "before_cas");
	const sourceNow = liveSourceIdentity(recordedSource, active, exec);
	const targetNow = liveIntegrationTarget(expectedTarget, active, exec);
	if (
		canonicalJson(sourceNow) !== canonicalJson(source) ||
		canonicalJson(targetNow) !== canonicalJson(target)
	)
		fail(
			"foreign_or_stale",
			"merge identities changed before compare-and-swap",
		);
	exec("git", [
		"-C",
		target.path,
		"read-tree",
		"-n",
		"--reset",
		"-u",
		mergedHead,
	]);
	exec("git", [
		"-C",
		target.path,
		"update-ref",
		target.branch_ref,
		mergedHead,
		target.head_sha,
	]);
	checkpoint(fault, "after_cas");
	const observedTarget = { ...target, head_sha: mergedHead };
	verifySynchronizationBase(target, mergedHead, active, exec);
	checkpoint(fault, "before_worktree_sync");
	exec("git", [
		"-C",
		target.path,
		"read-tree",
		"-u",
		"-m",
		target.head_sha,
		mergedHead,
	]);
	checkpoint(fault, "during_worktree_sync");
	const finalTarget = liveIntegrationTarget(observedTarget, active, exec);
	checkpoint(fault, "before_result_publication");
	const publishedTarget = liveIntegrationTarget(finalTarget, active, exec);
	return {
		result: { source_head_sha: source.head_sha, target: publishedTarget },
		source,
		target,
	};
}

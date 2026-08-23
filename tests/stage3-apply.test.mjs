import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	observeStage3ApplyTarget,
	publishStage3ApplyCas,
	resolveStage3ApplyOutcome,
	stage3ApplyTargetRef,
} from "../scripts/stage3-apply.mjs";
import { StateKernelError } from "../scripts/private-state-schema.mjs";

const roots = [];
process.on("exit", () =>
	roots.forEach((path) => rmSync(path, { recursive: true, force: true })),
);
const exec = (command, args, options = {}) =>
	execFileSync(command, args, {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		...options,
	}).trim();
const git = (repo, ...args) => exec("git", ["-C", repo, ...args]);

function fixture() {
	const repo = mkdtempSync(join(tmpdir(), "conductor-stage3-apply-"));
	roots.push(repo);
	execFileSync("git", ["init", "-q", "-b", "main", repo]);
	git(repo, "config", "user.name", "Stage3 Test");
	git(repo, "config", "user.email", "stage3@example.invalid");
	writeFileSync(join(repo, "base"), "base\n");
	git(repo, "add", ".");
	git(repo, "commit", "-qm", "base");
	const starting = git(repo, "rev-parse", "HEAD");
	git(repo, "update-ref", "refs/heads/release", starting);
	writeFileSync(join(repo, "feature"), "feature\n");
	git(repo, "add", ".");
	git(repo, "commit", "-qm", "integrated");
	const final = git(repo, "rev-parse", "HEAD");
	return {
		repo,
		integration: {
			target_ref: "refs/heads/main",
			starting_sha: starting,
			final_sha: final,
		},
	};
}

function code(expected, fn) {
	assert.throws(
		fn,
		(error) => error instanceof StateKernelError && error.code === expected,
	);
}

test("configured apply targets exist only for explicit version 3 configuration", () => {
	assert.equal(stage3ApplyTargetRef({ version: 2 }), null);
	assert.equal(stage3ApplyTargetRef({ version: 3, apply: null }), null);
	assert.equal(
		stage3ApplyTargetRef({
			version: 3,
			apply: { target_ref: "refs/heads/release" },
		}),
		"refs/heads/release",
	);
	code("invalid_state", () =>
		stage3ApplyTargetRef({ version: 3, apply: { target_ref: "main" } }),
	);
});

test("apply target observation binds the exact fast-forward proposal", () => {
	const { repo, integration } = fixture();
	const observed = observeStage3ApplyTarget({
		repository: repo,
		targetRef: "refs/heads/release",
		integration,
		exec,
	});
	assert.equal(observed.observed_sha, integration.starting_sha);
	assert.equal(observed.final_sha, integration.final_sha);
	assert.equal(observed.changed_path_count, 1);
	assert.match(observed.diff_name_status_sha256, /^[a-f0-9]{64}$/);
	assert.deepEqual(
		observeStage3ApplyTarget({
			repository: repo,
			targetRef: "refs/heads/release",
			integration,
			exec,
		}),
		observed,
	);
});

test("apply target observation fails closed on every drift", () => {
	const { repo, integration } = fixture();
	code("invalid_config", () =>
		observeStage3ApplyTarget({
			repository: repo,
			targetRef: integration.target_ref,
			integration,
			exec,
		}),
	);
	code("stale_source", () =>
		observeStage3ApplyTarget({
			repository: repo,
			targetRef: "refs/heads/missing",
			integration,
			exec,
		}),
	);
	code("stale_source", () =>
		observeStage3ApplyTarget({
			repository: repo,
			targetRef: "refs/heads/release",
			integration: { ...integration, final_sha: integration.starting_sha },
			exec,
		}),
	);
	git(repo, "update-ref", "refs/heads/release", integration.final_sha);
	code("stale_source", () =>
		observeStage3ApplyTarget({
			repository: repo,
			targetRef: "refs/heads/release",
			integration,
			exec,
		}),
	);
	git(repo, "update-ref", "refs/heads/release", integration.starting_sha);
	const checkout = mkdtempSync(join(tmpdir(), "conductor-stage3-checkout-"));
	roots.push(checkout);
	git(repo, "worktree", "add", "-q", checkout, "release");
	code("stale_source", () =>
		observeStage3ApplyTarget({
			repository: repo,
			targetRef: "refs/heads/release",
			integration,
			exec,
		}),
	);
	git(repo, "worktree", "remove", "--force", checkout);
	const emptyTree = git(repo, "hash-object", "-t", "tree", "/dev/null");
	const foreignRoot = git(repo, "commit-tree", emptyTree, "-m", "foreign");
	git(repo, "update-ref", integration.target_ref, foreignRoot);
	code("stale_source", () =>
		observeStage3ApplyTarget({
			repository: repo,
			targetRef: "refs/heads/release",
			integration: { ...integration, final_sha: foreignRoot },
			exec,
		}),
	);
	git(repo, "update-ref", integration.target_ref, integration.final_sha);
	const startingTree = git(repo, "rev-parse", `${integration.starting_sha}^{tree}`);
	const sameTree = git(
		repo,
		"commit-tree",
		startingTree,
		"-p",
		integration.starting_sha,
		"-m",
		"no-op",
	);
	git(repo, "update-ref", integration.target_ref, sameTree);
	code("stale_source", () =>
		observeStage3ApplyTarget({
			repository: repo,
			targetRef: "refs/heads/release",
			integration: { ...integration, final_sha: sameTree },
			exec,
		}),
	);
});

test("apply publication performs exactly one compare-and-swap", () => {
	const { repo, integration } = fixture();
	let preflights = 0;
	const published = publishStage3ApplyCas({
		repository: repo,
		targetRef: "refs/heads/release",
		expectedSha: integration.starting_sha,
		finalSha: integration.final_sha,
		preflight: () => {
			preflights += 1;
			return { stable: true };
		},
		exec,
	});
	assert.deepEqual(published, {
		casCount: 1,
		finalSha: integration.final_sha,
	});
	assert.ok(preflights >= 2);
	assert.equal(
		git(repo, "rev-parse", "refs/heads/release"),
		integration.final_sha,
	);
});

test("apply publication refuses drifting preflights with zero CAS", () => {
	const { repo, integration } = fixture();
	let calls = 0;
	code("stale_source", () =>
		publishStage3ApplyCas({
			repository: repo,
			targetRef: "refs/heads/release",
			expectedSha: integration.starting_sha,
			finalSha: integration.final_sha,
			preflight: () => ({ call: ++calls }),
			exec,
		}),
	);
	assert.equal(
		git(repo, "rev-parse", "refs/heads/release"),
		integration.starting_sha,
	);
	code("stale_source", () =>
		publishStage3ApplyCas({
			repository: repo,
			targetRef: "refs/heads/release",
			expectedSha: integration.starting_sha,
			finalSha: integration.starting_sha,
			preflight: () => ({ stable: true }),
			exec,
		}),
	);
});

test("uncertain apply outcomes resolve only to exact observations", () => {
	const { repo, integration } = fixture();
	const request = {
		repository: repo,
		targetRef: "refs/heads/release",
		expectedSha: integration.starting_sha,
		finalSha: integration.final_sha,
		exec,
	};
	assert.deepEqual(resolveStage3ApplyOutcome(request), {
		outcome: "unapplied",
		cas_count: 0,
	});
	git(repo, "update-ref", "refs/heads/release", integration.final_sha);
	assert.deepEqual(resolveStage3ApplyOutcome(request), {
		outcome: "applied",
		cas_count: 1,
	});
	const foreign = git(
		repo,
		"commit-tree",
		git(repo, "rev-parse", `${integration.starting_sha}^{tree}`),
		"-p",
		integration.starting_sha,
		"-m",
		"foreign",
	);
	git(repo, "update-ref", "refs/heads/release", foreign);
	code("foreign_or_stale", () => resolveStage3ApplyOutcome(request));
	git(repo, "update-ref", "-d", "refs/heads/release");
	code("foreign_or_stale", () => resolveStage3ApplyOutcome(request));
});

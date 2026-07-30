import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	computeChangedPaths,
	inspectGateSource,
	inspectProducerSource,
	validateProducerPathPolicy,
} from "../scripts/source-policy.mjs";
import { establishGateModes } from "../scripts/gate-source.mjs";
import { StateKernelError } from "../scripts/private-state-schema.mjs";
import { resolveGitCommonDirectory } from "../scripts/state-kernel.mjs";

const roots = [];
const git = (repo, ...args) =>
	execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
function repository() {
	const path = mkdtempSync(join(tmpdir(), "conductor-stage2-paths-"));
	roots.push(path);
	spawnSync("git", ["init", "-q", "-b", "main", path]);
	git(path, "config", "user.name", "Test");
	git(path, "config", "user.email", "test@example.invalid");
	writeFileSync(join(path, "base.txt"), "base\n");
	git(path, "add", ".");
	git(path, "commit", "-qm", "base");
	return path;
}
process.on("exit", () =>
	roots.forEach((path) => rmSync(path, { recursive: true, force: true })),
);

test("collector computes exact sorted Git paths with renames disabled", () => {
	const repo = repository();
	const base = git(repo, "rev-parse", "HEAD");
	git(repo, "mv", "base.txt", "renamed.txt");
	git(repo, "commit", "-qm", "rename");
	const output = git(repo, "rev-parse", "HEAD");
	assert.deepEqual(computeChangedPaths(repo, base, output), [
		"base.txt",
		"renamed.txt",
	]);
});

test("producer collection rejects ignored files and directories after modes are restored", () => {
	const repo = realpathSync(repository());
	writeFileSync(join(repo, ".gitignore"), ".ignored/\n*.ignored\n");
	git(repo, "add", ".gitignore");
	git(repo, "commit", "-qm", "add ignore policy");
	const head = git(repo, "rev-parse", "HEAD");
	const tree = git(repo, "rev-parse", "HEAD^{tree}");
	const common = resolveGitCommonDirectory(repo).repository.common_dir;
	mkdirSync(join(repo, ".ignored"));
	writeFileSync(join(repo, ".ignored", "nested.ignored"), "forbidden\n");
	const authorityBefore = [
		git(repo, "rev-parse", "HEAD"),
		git(repo, "write-tree"),
		git(repo, "for-each-ref", "--format=%(refname):%(objectname)"),
	];
	assert.throws(
		() =>
			inspectProducerSource(
				{
					root: repo,
					common_dir: common,
					branch_ref: "refs/heads/main",
					fork_sha: head,
				},
				{
					root: repo,
					expected_sha: head,
					tree_sha: tree,
					changed_paths: [],
				},
				{ owned_paths: ["src"], forbidden_paths: [] },
			),
		(error) => {
			assert.equal(error.code, "source_policy_violation");
			assert.notEqual(
				error.sourceObservation.ignored_inventory_sha256,
				createHash("sha256").update(Buffer.alloc(0)).digest("hex"),
			);
			return true;
		},
	);
	assert.deepEqual(
		[
			git(repo, "rev-parse", "HEAD"),
			git(repo, "write-tree"),
			git(repo, "for-each-ref", "--format=%(refname):%(objectname)"),
		],
		authorityBefore,
	);
});

test("gate collection rejects ignored inventory after read-only modes are restored", () => {
	const repo = realpathSync(repository());
	writeFileSync(join(repo, ".gitignore"), ".ignored/\n");
	git(repo, "add", ".gitignore");
	git(repo, "commit", "-qm", "add gate ignore policy");
	const gate = mkdtempSync(join(tmpdir(), "conductor-stage2-gate-"));
	roots.push(gate);
	git(repo, "worktree", "add", "-q", "--detach", gate, "HEAD");
	mkdirSync(join(gate, ".ignored"));
	writeFileSync(join(gate, ".ignored", "nested.log"), "forbidden\n");
	const source = {
		root: realpathSync(gate),
		common_dir: resolveGitCommonDirectory(gate).repository.common_dir,
		integration_sha: git(gate, "rev-parse", "HEAD"),
		tree_sha: git(gate, "rev-parse", "HEAD^{tree}"),
	};
	establishGateModes(gate);
	const authorityBefore = [
		git(gate, "rev-parse", "HEAD"),
		git(gate, "write-tree"),
		git(repo, "for-each-ref", "--format=%(refname):%(objectname)"),
	];
	try {
		assert.throws(
			() => inspectGateSource(source),
			(error) => {
				assert.equal(error.code, "source_policy_violation");
				assert.notEqual(
					error.gateSourceObservation.ignored_inventory_sha256,
					createHash("sha256").update(Buffer.alloc(0)).digest("hex"),
				);
				return true;
			},
		);
		assert.deepEqual(
			[
				git(gate, "rev-parse", "HEAD"),
				git(gate, "write-tree"),
				git(repo, "for-each-ref", "--format=%(refname):%(objectname)"),
			],
			authorityBefore,
		);
	} finally {
		chmodSync(gate, 0o755);
		chmodSync(join(gate, ".git"), 0o644);
		chmodSync(join(gate, ".ignored"), 0o755);
	}
});

test("owned/forbidden prefixes are component-aware and exact", () => {
	const assignment = { owned_paths: ["src"], forbidden_paths: ["src-secret"] };
	assert.deepEqual(
		validateProducerPathPolicy(["src/a.mjs"], ["src/a.mjs"], assignment),
		["src/a.mjs"],
	);
	assert.throws(
		() =>
			validateProducerPathPolicy(
				["src-secret/a"],
				["src-secret/a"],
				assignment,
			),
		(error) =>
			error instanceof StateKernelError &&
			error.code === "source_policy_violation",
	);
	assert.throws(
		() => validateProducerPathPolicy(["src/a"], [], assignment),
		(error) =>
			error instanceof StateKernelError &&
			error.code === "source_policy_violation",
	);
});

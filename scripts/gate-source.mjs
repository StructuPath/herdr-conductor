#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { chmodSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { StateKernelError } from "./private-state-schema.mjs";
import { resolveGitCommonDirectory } from "./state-kernel.mjs";
import { inspectGateSource } from "./source-policy.mjs";

function fail(code, message, cause) {
	throw new StateKernelError(code, message, cause ? { cause } : undefined);
}

function git(repository, args, options = {}) {
	try {
		return (options.execFile ?? execFileSync)(
			"git",
			["-C", repository, ...args],
			{
				encoding: Object.hasOwn(options, "encoding")
					? options.encoding
					: "utf8",
				stdio: ["ignore", "pipe", "pipe"],
				env: { ...process.env, LC_ALL: "C", LANG: "C" },
			},
		);
	} catch (error) {
		fail(
			"capability_unavailable",
			`git ${args[0]} failed for gate source`,
			error,
		);
	}
}

function trackedPaths(root, options) {
	const bytes = git(root, ["ls-files", "-z"], { ...options, encoding: null });
	if (bytes.length === 0) return [];
	if (bytes.at(-1) !== 0)
		fail(
			"capability_unavailable",
			"tracked gate inventory is not NUL terminated",
		);
	return bytes.subarray(0, -1).toString("utf8").split("\0");
}

export function establishGateModes(root, options = {}) {
	const paths = trackedPaths(root, options);
	const directories = new Set([root]);
	for (const relative of paths) {
		const path = join(root, relative);
		for (
			let parent = dirname(path);
			parent.startsWith(root) && parent !== root;
			parent = dirname(parent)
		)
			directories.add(parent);
		const stats = lstatSync(path);
		if (stats.isSymbolicLink()) continue;
		if (!stats.isFile())
			fail(
				"capability_unavailable",
				"tracked gate entry is not a regular file or symlink",
			);
		chmodSync(path, Number(stats.mode & 0o111) !== 0 ? 0o555 : 0o444);
	}
	for (const directory of [...directories].sort(
		(left, right) => right.length - left.length,
	))
		chmodSync(directory, 0o555);
	const admin = join(root, ".git");
	const adminStats = lstatSync(admin);
	if (
		!adminStats.isFile() ||
		adminStats.isSymbolicLink() ||
		adminStats.nlink !== 1
	)
		fail(
			"capability_unavailable",
			"linked-worktree .git entry is not an exact regular file",
		);
	chmodSync(admin, 0o444);
	return Object.freeze({ trackedPaths: Object.freeze(paths) });
}

export function createGateSource({
	repository,
	destination,
	integrationSha,
	baseSha,
	generation,
	integrationEntryDigest,
	execFile,
} = {}) {
	if (lstatSync(destination, { throwIfNoEntry: false }))
		fail("path_mismatch", "gate source destination already exists");
	mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
	git(
		repository,
		["worktree", "add", "--detach", destination, integrationSha],
		{ execFile },
	);
	const root = realpathSync(destination);
	if (root !== destination)
		fail("path_mismatch", "gate source path is not canonical");
	const identity = resolveGitCommonDirectory(root);
	const treeSha = git(root, ["rev-parse", "HEAD^{tree}"], { execFile }).trim();
	const observedIdentity = {
		document_type: "herdr-conductor-gate-source",
		schema_version: 1,
		root,
		common_dir: identity.repository.common_dir,
		head_mode: "detached",
		base_sha: baseSha,
		integration_sha: integrationSha,
		tree_sha: treeSha,
		snapshot_generation: generation,
		integration_entry_digest: integrationEntryDigest,
		registered: true,
	};
	establishGateModes(root, { execFile });
	inspectGateSource(observedIdentity, { exec: execFile });
	return Object.freeze(observedIdentity);
}

export function validateGateSource(source, options = {}) {
	return inspectGateSource(source, options);
}

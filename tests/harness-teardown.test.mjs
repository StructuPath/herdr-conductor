import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	writeFileSync,
	readFileSync,
	readdirSync,
	existsSync,
	chmodSync,
	realpathSync,
	statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
	createHarnessControlPlane,
	validatePrivateOutputParent,
} from "../scripts/harness-teardown.mjs";

test("descriptor-held harness tears down only a sealed exact manifest", async () => {
	const parent = mkdtempSync(join(tmpdir(), "conductor-harness-parent-"));
	chmodSync(parent, 0o700);
	const plane = await createHarnessControlPlane({ parent });
	const nested = join(plane.rootPath, "repositories", "repo");
	mkdirSync(nested);
	await plane.appendManifestRecord(relative(plane.rootPath, nested));
	const file = join(nested, "tracked");
	writeFileSync(file, "x", { mode: 0o600 });
	await plane.appendManifestRecord(relative(plane.rootPath, file));
	await plane.appendWorkspaceIdentity("workspace-disposable");
	await plane.sealHarnessManifest();
	const result = await plane.teardownHarness();
	assert.deepEqual(result, {
		status: "passed",
		root_absent: true,
		state_absent: true,
		out_of_root_deletion_count: 0,
		unlisted_residue_count: 0,
	});
	assert.equal(existsSync(plane.rootPath), false);
});
test("unlisted entries fail closed and remain inside the disposable root", async () => {
	const parent = mkdtempSync(join(tmpdir(), "conductor-harness-race-"));
	chmodSync(parent, 0o700);
	const plane = await createHarnessControlPlane({ parent });
	writeFileSync(join(plane.rootPath, "unexpected"), "retain");
	await plane.sealHarnessManifest();
	await assert.rejects(() => plane.teardownHarness(), /unlisted or missing/);
	assert.equal(existsSync(join(plane.rootPath, "unexpected")), true);
	plane.stop();
});
test("pre-teardown failure exits bounded, stops its helper, and retains residue", () => {
	const parent = mkdtempSync(join(tmpdir(), "conductor-harness-failure-"));
	chmodSync(parent, 0o700);
	const resultPath = join(parent, "result.json");
	const fixture = fileURLToPath(
		new URL(
			"./fixtures/harness-preteardown-failure-child.mjs",
			import.meta.url,
		),
	);
	const child = spawnSync(process.execPath, [fixture, parent, resultPath], {
		encoding: "utf8",
		timeout: 5_000,
	});
	assert.equal(child.status, 1, child.stderr);
	assert.equal(child.signal, null);
	const { root, helperPid } = JSON.parse(readFileSync(resultPath, "utf8"));
	assert.equal(
		readFileSync(join(root, "retained-residue"), "utf8"),
		"retain\n",
	);
	assert.throws(
		() => process.kill(helperPid, 0),
		(error) => error.code === "ESRCH",
	);
});

test("harness has no out-of-root state deletion capability", async () => {
	const parent = mkdtempSync(join(tmpdir(), "conductor-harness-contained-"));
	chmodSync(parent, 0o700);
	const sentinel = join(parent, "outside-sentinel");
	writeFileSync(sentinel, "retain", { mode: 0o600 });
	const plane = await createHarnessControlPlane({ parent });
	assert.equal("bindExternalState" in plane, false);
	assert.equal("recordExternalState" in plane, false);
	await plane.sealHarnessManifest();
	const result = await plane.teardownHarness();
	assert.equal(result.out_of_root_deletion_count, 0);
	assert.equal(readFileSync(sentinel, "utf8"), "retain");
});

test("mode-hardened nested disposable trees are identity-restored and removed", async () => {
	const parent = mkdtempSync(join(tmpdir(), "conductor-harness-mode-"));
	chmodSync(parent, 0o700);
	const plane = await createHarnessControlPlane({ parent });
	const gate = join(plane.rootPath, "repositories", "gate", "nested");
	mkdirSync(gate, { recursive: true, mode: 0o700 });
	writeFileSync(join(gate, "tracked"), "x", { mode: 0o444 });
	chmodSync(gate, 0o555);
	chmodSync(join(gate, ".."), 0o555);
	await plane.recordDisposableTree();
	await plane.sealHarnessManifest();
	const result = await plane.teardownHarness();
	assert.equal(result.status, "passed");
	assert.equal(result.out_of_root_deletion_count, 0);
	assert.equal(existsSync(plane.rootPath), false);
});

test("true SIGKILL terminal boundaries retain exact residue or prove root absence without out-of-root deletion", () => {
	const fixture = fileURLToPath(
		new URL("./fixtures/harness-teardown-child.mjs", import.meta.url),
	);
	const ordinary = ["repositories/repo", "repositories", "workspaces", "state"];
	const boundaries = [
		"before_permission_restore:repositories/repo",
		"after_permission_restore:repositories/repo",
		...ordinary.flatMap((path) => [
			`before_remove:${path}`,
			`after_remove:${path}`,
		]),
		"before_marker_unlink",
		"after_marker_unlink",
		"before_manifest_unlink",
		"after_manifest_unlink",
		"before_control_remove",
		"after_control_remove",
		"before_root_remove",
		"after_root_remove",
	];
	for (const boundary of boundaries) {
		const parent = mkdtempSync(
			join(
				tmpdir(),
				`conductor-harness-kill-${boundary.replaceAll(/[/:]/g, "-")}-`,
			),
		);
		chmodSync(parent, 0o700);
		const resultPath = join(parent, "root.json");
		const sentinel = join(parent, "outside-sentinel");
		writeFileSync(sentinel, "retain");
		const child = spawnSync(
			process.execPath,
			[fixture, parent, resultPath, boundary],
			{ encoding: "utf8", timeout: 10_000 },
		);
		assert.notEqual(child.status, 0, boundary);
		const { root, identities } = JSON.parse(readFileSync(resultPath, "utf8"));
		assert.equal(readFileSync(sentinel, "utf8"), "retain", boundary);
		assert.equal(existsSync(root), boundary !== "after_root_remove", boundary);
		if (!existsSync(root)) continue;
		const removed = new Set();
		if (
			boundary.startsWith("before_remove:") ||
			boundary.startsWith("after_remove:")
		)
			for (const path of ordinary) {
				if (boundary === `before_remove:${path}`) break;
				removed.add(path);
				if (boundary === `after_remove:${path}`) break;
			}
		if (
			!boundary.startsWith("before_remove:") &&
			!boundary.startsWith("after_remove:") &&
			!boundary.includes("permission_restore:")
		)
			ordinary.forEach((path) => removed.add(path));
		if (
			[
				"after_marker_unlink",
				"before_manifest_unlink",
				"after_manifest_unlink",
				"before_control_remove",
				"after_control_remove",
				"before_root_remove",
			].includes(boundary)
		)
			removed.add("control/marker.json");
		if (
			[
				"after_manifest_unlink",
				"before_control_remove",
				"after_control_remove",
				"before_root_remove",
			].includes(boundary)
		)
			removed.add("control/manifest.log");
		if (["after_control_remove", "before_root_remove"].includes(boundary))
			removed.add("control");
		const expected = Object.keys(identities)
			.filter((path) => !removed.has(path))
			.sort();
		const actual = [];
		function visit(path, relativePath = ".") {
			actual.push(relativePath);
			const stats = statSync(path);
			assert.equal(
				String(stats.dev),
				identities[relativePath].device,
				boundary,
			);
			assert.equal(String(stats.ino), identities[relativePath].inode, boundary);
			if (stats.isDirectory())
				for (const name of readdirSync(path))
					visit(
						join(path, name),
						relativePath === "." ? name : `${relativePath}/${name}`,
					);
		}
		visit(root);
		assert.deepEqual(actual.sort(), expected, boundary);
	}
});

test("private evidence output parent must be empty, 0700, and outside candidate/disposable roots", () => {
	const parent = mkdtempSync(join(tmpdir(), "conductor-output-"));
	chmodSync(parent, 0o700);
	const value = validatePrivateOutputParent(realpathSync(parent));
	assert.equal(value.mode, "0700");
});

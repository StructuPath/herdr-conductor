#!/usr/bin/env node
import { spawn } from "node:child_process";
import {
	constants,
	openSync,
	closeSync,
	fstatSync,
	readdirSync,
	realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { relative, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { StateKernelError } from "./private-state-schema.mjs";

function fail(code, message, cause) {
	throw new StateKernelError(code, message, cause ? { cause } : undefined);
}
function contained(parent, child) {
	const rel = relative(parent, child);
	return (
		rel !== "" &&
		rel !== ".." &&
		!rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)
	);
}

export class HarnessControlPlane {
	#child;
	#pending = [];
	#stderr = "";
	constructor(child, lines, initial) {
		this.#child = child;
		Object.assign(this, initial);
		lines.on("line", (line) => {
			const pending = this.#pending.shift();
			if (!pending) return;
			try {
				const result = JSON.parse(line);
				result.ok
					? pending.resolve(result.result)
					: pending.reject(new Error(result.error));
			} catch (error) {
				pending.reject(error);
			}
		});
		child.stderr.on("data", (chunk) => {
			this.#stderr += chunk.toString().slice(0, 4096);
		});
		child.on("exit", (code, signal) => {
			while (this.#pending.length)
				this.#pending
					.shift()
					.reject(
						new Error(
							`filesystem helper exited ${signal ?? code}: ${this.#stderr}`,
						),
					);
		});
	}
	command(command) {
		return new Promise((resolvePromise, reject) => {
			this.#pending.push({ resolve: resolvePromise, reject });
			this.#child.stdin.write(`${JSON.stringify(command)}\n`, (error) => {
				if (error) reject(error);
			});
		});
	}
	appendManifestRecord(path, workspace = null) {
		return this.command({ command: "append", path, workspace });
	}
	appendWorkspaceIdentity(workspaceId) {
		return this.command({
			command: "append_workspace",
			workspace_id: workspaceId,
		});
	}
	recordDisposableTree() {
		return this.command({ command: "record_tree" });
	}
	appendOutputIntent(value) {
		return this.command({ command: "output_intent", ...value });
	}
	sealHarnessManifest() {
		return this.command({ command: "seal" });
	}
	async teardownHarness({ killAt } = {}) {
		const result = await this.command({
			command: "teardown",
			...(killAt ? { kill_at: killAt } : {}),
		});
		await this.command({ command: "stop" });
		return result;
	}
	stop() {
		if (!this.#child.killed) this.#child.kill("SIGTERM");
	}
}

export async function createHarnessControlPlane({
	parent = tmpdir(),
	candidateCheckout,
	stateRoots = [],
} = {}) {
	const canonicalParent = realpathSync(parent);
	const deny = [
		"/",
		realpathSync(tmpdir()),
		process.env.HOME && realpathSync(process.env.HOME),
		candidateCheckout && realpathSync(candidateCheckout),
		...stateRoots.map((path) => realpathSync(path)),
	].filter(Boolean);
	if (
		deny.includes(canonicalParent) &&
		canonicalParent !== realpathSync(tmpdir())
	)
		fail("path_mismatch", "harness parent is deny-listed");
	const helper = fileURLToPath(
		new URL("./harness-fs-helper.py", import.meta.url),
	);
	const child = spawn("python3", [helper, "serve", canonicalParent], {
		stdio: ["pipe", "pipe", "pipe"],
	});
	const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
	const initial = await new Promise((resolvePromise, reject) => {
		const onLine = (line) => {
			lines.off("line", onLine);
			try {
				const value = JSON.parse(line);
				value.ok ? resolvePromise(value) : reject(new Error(value.error));
			} catch (error) {
				reject(error);
			}
		};
		lines.on("line", onLine);
		child.once("error", reject);
		child.once("exit", (code) =>
			reject(new Error(`filesystem helper exited ${code}`)),
		);
	});
	const root = realpathSync(initial.root_path);
	if (
		!contained(canonicalParent, root) ||
		root === canonicalParent ||
		deny.some((path) => path === root || contained(root, path))
	) {
		child.kill("SIGTERM");
		fail("path_mismatch", "harness root intersects a deny-listed path");
	}
	return new HarnessControlPlane(child, lines, {
		rootPath: root,
		nonce: initial.nonce,
		helperPid: initial.helper_pid,
	});
}

export function validatePrivateOutputParent(
	path,
	{ candidateCheckout, disposableRoot } = {},
) {
	const canonical = realpathSync(path);
	if (canonical !== resolve(path))
		fail("path_mismatch", "output parent must be canonical");
	if (
		(candidateCheckout &&
			(canonical === realpathSync(candidateCheckout) ||
				contained(realpathSync(candidateCheckout), canonical))) ||
		(disposableRoot &&
			(canonical === disposableRoot || contained(disposableRoot, canonical)))
	)
		fail(
			"path_mismatch",
			"output parent overlaps candidate or disposable root",
		);
	const descriptor = openSync(
		canonical,
		constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
	);
	const stats = fstatSync(descriptor, { bigint: true });
	if (
		!stats.isDirectory() ||
		Number(stats.mode & 0o777n) !== 0o700 ||
		Number(stats.uid) !== process.getuid() ||
		readdirSync(canonical).length !== 0
	) {
		closeSync(descriptor);
		fail(
			"path_mismatch",
			"output parent must be empty, private, and effective-user-owned",
		);
	}
	return Object.freeze({
		descriptor,
		canonicalPath: canonical,
		device: String(stats.dev),
		inode: String(stats.ino),
		owner: String(stats.uid),
		mode: "0700",
	});
}

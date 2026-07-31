#!/usr/bin/env node
import { lstatSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { StateKernelError } from "./private-state-schema.mjs";

export const DEFAULT_STATE_ROOT = join(
	homedir(),
	".local",
	"state",
	"herdr-conductor",
);

function fail(message, cause) {
	throw new StateKernelError(
		"invalid_config",
		message,
		cause ? { cause } : undefined,
	);
}

export function stateRootForConfig(config) {
	const selector = config?.state_root;
	if (selector?.kind === "default") return DEFAULT_STATE_ROOT;
	if (selector?.kind !== "absolute" || typeof selector.path !== "string")
		fail("configuration state_root selector is invalid");
	if (resolve(selector.path) !== selector.path)
		fail("configuration absolute state_root must be normalized");
	let canonical;
	let stats;
	try {
		canonical = realpathSync(selector.path);
		stats = lstatSync(selector.path);
	} catch (error) {
		fail("configuration absolute state_root must already exist", error);
	}
	if (
		canonical !== selector.path ||
		stats.isSymbolicLink() ||
		!stats.isDirectory()
	)
		fail("configuration absolute state_root must be a canonical directory");
	return canonical;
}

// Retained only for the historical Stage 1 live-smoke contract.
export function runtimeStateRoot(env = process.env) {
	return env.CONDUCTOR_STATE_DIR ?? DEFAULT_STATE_ROOT;
}

export function requireLiveHarnessStateRoot(env = process.env) {
	if (Object.hasOwn(env, "CONDUCTOR_STATE_DIR"))
		throw new Error(
			"refusing live smoke: CONDUCTOR_STATE_DIR is not forwarded to plugin actions; unset it so harness and plugin use the shared default",
		);
	return DEFAULT_STATE_ROOT;
}

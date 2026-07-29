#!/usr/bin/env node
import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_STATE_ROOT = join(
	homedir(),
	".local",
	"state",
	"herdr-conductor",
);

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

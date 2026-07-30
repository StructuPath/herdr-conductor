#!/usr/bin/env node
import { requireLiveHarnessStateRoot } from "./state-root.mjs";

const OPT_IN = "I_UNDERSTAND_THIS_USES_LOCAL_HERDR";

if (process.env.CONDUCTOR_STAGE1_LIVE_SMOKE !== OPT_IN) {
	process.stderr.write(
		`refusing live smoke: set CONDUCTOR_STAGE1_LIVE_SMOKE=${OPT_IN}\n`,
	);
	process.exit(64);
}
try {
	requireLiveHarnessStateRoot();
} catch (error) {
	process.stderr.write(`${error.message}\n`);
	process.exit(64);
}

process.stderr.write(
	"refusing live smoke: the Stage 1 path is retained only for historical evidence compatibility; use the reviewed Stage 2 descriptor-held harness\n",
);
process.exit(64);

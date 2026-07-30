#!/usr/bin/env node
import { resolve } from "node:path";
import { finalizePrivateEvidenceTrio } from "./stage2-evidence-contract.mjs";

const [flag, outputParent, candidateFlag, candidate] = process.argv.slice(2);
if (
	flag !== "--output-parent" ||
	!outputParent ||
	candidateFlag !== "--candidate" ||
	!/^[a-f0-9]{40}$/.test(candidate ?? "") ||
	process.argv.length !== 6
) {
	process.stderr.write(
		"usage: finalize-stage2-live-evidence --output-parent <exact-private-directory> --candidate <commit-a>\n",
	);
	process.exit(64);
}
try {
	const result = finalizePrivateEvidenceTrio(resolve(outputParent), candidate);
	process.stdout.write(
		`Stage 2 private evidence valid: ${result.completionDigest}\n`,
	);
} catch (error) {
	process.stderr.write(
		`herdr-conductor: ${error.code ?? "evidence_invalid"}: ${error.message}\n`,
	);
	process.exitCode = 1;
}

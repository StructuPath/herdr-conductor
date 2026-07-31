import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHarnessControlPlane } from "../../scripts/harness-teardown.mjs";

const [parent, resultPath] = process.argv.slice(2);
const plane = await createHarnessControlPlane({ parent });
writeFileSync(join(plane.rootPath, "retained-residue"), "retain\n");
writeFileSync(
	resultPath,
	JSON.stringify({ root: plane.rootPath, helperPid: plane.helperPid }),
);
try {
	await plane.sealHarnessManifest();
	await plane.teardownHarness();
	process.exitCode = 2;
} catch {
	process.exitCode = 1;
} finally {
	plane.stop();
}

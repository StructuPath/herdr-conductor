import { readFileSync } from "node:fs";
import { closeSync } from "node:fs";
import { publishPrivateEvidenceTrio } from "../../scripts/stage2-evidence-contract.mjs";
import { validatePrivateOutputParent } from "../../scripts/harness-teardown.mjs";

const [outputPath, sourcePath, humanPath, machinePath, boundary] =
	process.argv.slice(2);
const output = validatePrivateOutputParent(outputPath);
try {
	publishPrivateEvidenceTrio(
		output,
		{
			sourceBytes: readFileSync(sourcePath),
			humanBytes: readFileSync(humanPath),
			machineBytes: readFileSync(machinePath),
		},
		{
			checkpoint(point) {
				if (point === boundary) process.kill(process.pid, "SIGKILL");
			},
		},
	);
} finally {
	closeSync(output.descriptor);
}

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { Readable } from "node:stream";
import { publishReportFromCliStdin } from "../../scripts/report-publisher.mjs";

const [
	taskPath,
	configPath,
	reportPath,
	boundary,
	barrierReadyPath,
	barrierReleasePath,
] = process.argv.slice(2);
try {
	await publishReportFromCliStdin({
		taskPath,
		configPath,
		input: Readable.from([readFileSync(reportPath)]),
		fault(point) {
			if (point !== boundary) return;
			if (barrierReadyPath && barrierReleasePath) {
				writeFileSync(barrierReadyPath, "ready\n");
				while (!existsSync(barrierReleasePath))
					Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
				return;
			}
			process.kill(process.pid, "SIGKILL");
		},
	});
} catch (error) {
	process.stderr.write(`${error.code ?? "internal_error"}:${error.message}\n`);
	process.exitCode = 1;
}

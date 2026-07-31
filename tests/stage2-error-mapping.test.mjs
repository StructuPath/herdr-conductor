import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { publishReportFromStdin } from "../scripts/report-publisher.mjs";
import { StateKernelError } from "../scripts/private-state-schema.mjs";
import { validateProducerPathPolicy } from "../scripts/source-policy.mjs";
import {
	validateReport,
	validateTask,
} from "../scripts/task-report-schema.mjs";
import { stage2ContractFixture } from "./stage2-runtime-helpers.mjs";

function code(expected, fn) {
	assert.throws(
		fn,
		(error) => error instanceof StateKernelError && error.code === expected,
	);
}
async function codeAsync(expected, fn) {
	await assert.rejects(
		fn,
		(error) => error instanceof StateKernelError && error.code === expected,
	);
}

test("public Stage 2 seams retain normative malformed, stale, path, and framing error codes", async () => {
	const { task, report } = stage2ContractFixture();
	code("invalid_contract", () => validateTask({ ...task, unknown: true }));
	code("digest_mismatch", () =>
		validateReport({ ...report, report_digest: "0".repeat(64) }, { task }),
	);
	code("source_policy_violation", () =>
		validateProducerPathPolicy(
			["secrets/token"],
			["secrets/token"],
			task.assignment,
		),
	);
	await codeAsync("invalid_json", () =>
		publishReportFromStdin({
			input: Readable.from([Buffer.from("{")]),
			stateRoot: "/unused",
			authorizeTask: () => ({ task }),
		}),
	);
	await codeAsync("input_too_large", () =>
		publishReportFromStdin({
			input: Readable.from([Buffer.alloc(1_048_577, 0x61)]),
			stateRoot: "/unused",
			authorizeTask: () => assert.fail("oversize framing reached authority"),
		}),
	);
});

import test from "node:test";
import assert from "node:assert/strict";
import {
	mkdtempSync,
	mkdirSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	copyExclusivePrivateBytes,
	publishExclusivePrivateBytes,
	readStablePrivateBytes,
	scanExactDirectory,
} from "../scripts/state-kernel.mjs";
import { StateKernelError } from "../scripts/private-state-schema.mjs";

const roots = [];
function root() {
	const value = mkdtempSync(join(tmpdir(), "conductor-stage2-fs-"));
	roots.push(value);
	return value;
}
process.on("exit", () =>
	roots.forEach((path) => rmSync(path, { recursive: true, force: true })),
);
function code(expected, fn) {
	assert.throws(
		fn,
		(error) => error instanceof StateKernelError && error.code === expected,
	);
}

test("stable private byte publication is exclusive, private, and copy-safe", () => {
	const directory = root();
	const source = join(directory, "source");
	const destination = join(directory, "destination");
	publishExclusivePrivateBytes(source, Buffer.from("source\n"), {
		root: directory,
	});
	assert.equal(
		readStablePrivateBytes(source, { root: directory }).toString(),
		"source\n",
	);
	copyExclusivePrivateBytes(source, destination, {
		sourceRoot: directory,
		destinationRoot: directory,
	});
	assert.equal(
		readStablePrivateBytes(destination, { root: directory }).toString(),
		"source\n",
	);
	code("state_exists", () =>
		publishExclusivePrivateBytes(source, Buffer.from("replacement"), {
			root: directory,
		}),
	);
	assert.deepEqual(
		scanExactDirectory(directory, { root: directory }).map(
			({ name, mode, linkCount }) => ({ name, mode, linkCount }),
		),
		[
			{ name: "destination", mode: 0o600, linkCount: "1" },
			{ name: "source", mode: 0o600, linkCount: "1" },
		],
	);
});

test("stable reads reject symlink leaves and unexpected inventory stays visible", () => {
	const directory = root();
	const outside = join(root(), "outside");
	writeFileSync(outside, "outside");
	symlinkSync(outside, join(directory, "linked"));
	code("state_symlink", () =>
		readStablePrivateBytes(join(directory, "linked"), { root: directory }),
	);
	assert.equal(
		scanExactDirectory(directory, { root: directory })[0].type,
		"symlink",
	);
});

test("directory chains must remain private", () => {
	const directory = root();
	const nested = join(directory, "nested");
	mkdirSync(nested, { mode: 0o755 });
	code("state_permissions", () =>
		scanExactDirectory(nested, { root: directory }),
	);
});

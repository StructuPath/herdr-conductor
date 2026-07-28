import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { validateRepository } from "../scripts/check-manifest.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtures = [];

after(() => {
	for (const fixture of fixtures)
		fs.rmSync(fixture, { recursive: true, force: true });
});

function fixture() {
	const base = fs.mkdtempSync(
		path.join(os.tmpdir(), "herdr-conductor-manifest-"),
	);
	const repository = path.join(base, "repository");
	fixtures.push(base);
	fs.mkdirSync(path.join(repository, "scripts"), { recursive: true });
	fs.writeFileSync(
		path.join(repository, "package.json"),
		JSON.stringify({ version: "1.2.3" }),
	);
	fs.writeFileSync(
		path.join(repository, "herdr-plugin.toml"),
		'version = "1.2.3"\n[[actions]]\nid = "open"\ncommand = ["bash", "scripts/open.sh"]\n',
	);
	fs.writeFileSync(path.join(repository, "scripts", "open.sh"), "#!/bin/sh\n");
	fs.chmodSync(path.join(repository, "scripts", "open.sh"), 0o755);
	return { base, repository };
}

test("repository manifest passes CI validation", () => {
	assert.deepEqual(validateRepository(root).errors, []);
});

test("manifest validation rejects malformed TOML", () => {
	const { repository } = fixture();
	fs.writeFileSync(
		path.join(repository, "herdr-plugin.toml"),
		'version = "1.2.3"\n[[actions]\n',
	);

	const { errors } = validateRepository(repository);
	assert.ok(
		errors.some((error) => error.startsWith("manifest is not valid TOML:")),
		errors.join("\n"),
	);
});

test("manifest validation enforces package version parity", () => {
	const { repository } = fixture();
	fs.writeFileSync(
		path.join(repository, "package.json"),
		JSON.stringify({ version: "9.9.9" }),
	);

	const { errors } = validateRepository(repository);
	assert.ok(
		errors.some((error) => error.startsWith("version mismatch:")),
		errors.join("\n"),
	);
});

test("manifest validation requires action entrypoints to exist", () => {
	const { repository } = fixture();
	fs.rmSync(path.join(repository, "scripts", "open.sh"));

	const { errors } = validateRepository(repository);
	assert.ok(
		errors.some((error) => error.includes("entrypoint does not exist")),
		errors.join("\n"),
	);
});

test("manifest validation keeps action entrypoints inside the repository", () => {
	const { base, repository } = fixture();
	const outside = path.join(base, "outside.sh");
	fs.writeFileSync(outside, "#!/bin/sh\n");
	fs.chmodSync(outside, 0o755);
	fs.writeFileSync(
		path.join(repository, "herdr-plugin.toml"),
		'version = "1.2.3"\n[[actions]]\nid = "open"\ncommand = ["bash", "../outside.sh"]\n',
	);

	const { errors } = validateRepository(repository);
	assert.ok(
		errors.some((error) => error.includes("entrypoint escapes the repository")),
		errors.join("\n"),
	);
});

test("manifest validation requires executable scripts", () => {
	const { repository } = fixture();
	fs.chmodSync(path.join(repository, "scripts", "open.sh"), 0o644);

	const { errors } = validateRepository(repository);
	assert.ok(
		errors.some((error) => error.includes("script is not executable")),
		errors.join("\n"),
	);
});

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { validateDocs } from "../scripts/check-docs.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtures = [];
const requiredFiles = [
	"package.json",
	"herdr-plugin.toml",
	"README.md",
	"docs/herdr-plugins-cheatsheet.md",
	"docs/history/README.md",
	"docs/history/2026-07-23-herdr-conductor-origin-spec.md",
	"docs/history/2026-07-23-feature-delivery-adapter-plan.md",
	"roles/reviewer.md",
	"roles/validator.md",
];

after(() => {
	for (const fixture of fixtures)
		fs.rmSync(fixture, { recursive: true, force: true });
});

function fixture() {
	const base = fs.mkdtempSync(path.join(os.tmpdir(), "herdr-conductor-docs-"));
	fixtures.push(base);
	for (const relative of requiredFiles) {
		const target = path.join(base, relative);
		fs.mkdirSync(path.dirname(target), { recursive: true });
		fs.copyFileSync(path.join(root, relative), target);
	}
	return base;
}

test("repository documentation passes the Stage 0 claim contract", () => {
	assert.deepEqual(validateDocs(root).errors, []);
});

test("documentation validation requires README and manifest actions to agree", () => {
	const repository = fixture();
	const readmePath = path.join(repository, "README.md");
	const readme = fs
		.readFileSync(readmePath, "utf8")
		.replace(/^herdr plugin action invoke board .*\n/m, "");
	fs.writeFileSync(readmePath, readme);

	const { errors } = validateDocs(repository);
	assert.ok(
		errors.some((error) =>
			error.startsWith("README action commands must be exactly"),
		),
		errors.join("\n"),
	);
});

test("documentation validation rejects retired behavior claims in current docs", () => {
	const repository = fixture();
	fs.appendFileSync(
		path.join(repository, "roles/reviewer.md"),
		"\nNote: you are launched fully read-only.\n",
	);

	const { errors } = validateDocs(repository);
	assert.ok(
		errors.some((error) => error.includes("retired current-behavior claim")),
		errors.join("\n"),
	);
});

test("documentation validation rejects restored Flotion product scaffolding", () => {
	const repository = fixture();
	fs.mkdirSync(path.join(repository, ".claude"));

	const { errors } = validateDocs(repository);
	assert.ok(
		errors.some((error) =>
			error.includes("legacy/non-product path must not exist: .claude"),
		),
		errors.join("\n"),
	);
});

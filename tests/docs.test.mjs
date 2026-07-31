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
	"SECURITY.md",
	"docs/private-state-v1.md",
	"docs/herdr-plugins-cheatsheet.md",
	"docs/history/README.md",
	"docs/history/2026-07-23-herdr-conductor-origin-spec.md",
	"docs/history/2026-07-23-feature-delivery-adapter-plan.md",
	"roles/reviewer.md",
	"roles/validator.md",
	...fs
		.readdirSync(path.join(root, "tests"))
		.filter((name) => /^(?:stage1-runtime-.*|stage2-.*)\.test\.mjs$/.test(name))
		.map((name) => `tests/${name}`),
	"tests/private-state-schema.test.mjs",
	"tests/state-kernel.test.mjs",
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

test("repository documentation passes the Stage 2 claim contract", () => {
	assert.deepEqual(validateDocs(root).errors, []);
});

test("documentation validation rejects broad or newer Herdr support claims", () => {
	for (const claim of ["Herdr `>=0.7.5`", "Herdr 0.7.6 or newer"]) {
		const repository = fixture();
		const readmePath = path.join(repository, "README.md");
		const readme = fs
			.readFileSync(readmePath, "utf8")
			.replace("Herdr exactly `0.7.5`", claim);
		fs.writeFileSync(readmePath, readme);
		const { errors } = validateDocs(repository);
		assert.ok(
			errors.some((error) => error.includes("exactly Herdr 0.7.5")),
			errors.join("\n"),
		);
	}
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

test("documentation validation rejects nonexistent canonical test paths", () => {
	for (const relative of ["README.md", "docs/private-state-v1.md"]) {
		const repository = fixture();
		const documentPath = path.join(repository, relative);
		const content = fs
			.readFileSync(documentPath, "utf8")
			.replace(
				"tests/stage1-runtime-*.test.mjs",
				"tests/stage1-runtime-missing.test.mjs",
			);
		fs.writeFileSync(documentPath, content);

		const { errors } = validateDocs(repository);
		assert.ok(
			errors.some((error) =>
				error.includes(
					`${relative} canonical test command references nonexistent path: tests/stage1-runtime-missing.test.mjs`,
				),
			),
			errors.join("\n"),
		);
	}
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

test("documentation validation requires both roles to fail closed on integration SHA mismatch", () => {
	for (const relative of ["roles/reviewer.md", "roles/validator.md"]) {
		const repository = fixture();
		const rolePath = path.join(repository, relative);
		const content = fs
			.readFileSync(rolePath, "utf8")
			.replace("git rev-parse HEAD", "inspect the current checkout");
		fs.writeFileSync(rolePath, content);

		const { errors } = validateDocs(repository);
		assert.ok(
			errors.some((error) =>
				error.includes(
					`${relative} must retain safety boundary text: git rev-parse HEAD`,
				),
			),
			errors.join("\n"),
		);
	}
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

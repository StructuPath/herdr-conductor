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
	"scripts/conductor-lib.sh",
	"tests/conductor-lib.test.mjs",
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

test("documentation validation scans source and test comments for retired claims", () => {
	const regressions = [
		[
			"scripts/conductor-lib.sh",
			"\n# Retry re-uses workers rather than orphaning panes.\n",
			"cross-process worker recovery",
		],
		[
			"scripts/conductor-lib.sh",
			"\n# Close only panes Conductor started.\n",
			"unverified recorded pane ownership",
		],
		[
			"scripts/conductor-lib.sh",
			"\n# pi-library vendors a byte-identical duplicate.\n",
			"byte-identical vendoring",
		],
		[
			"tests/conductor-lib.test.mjs",
			"\n// Mode controls isolation and enforcement.\n",
			"mode-enforced isolation",
		],
	];

	for (const [relative, claim, label] of regressions) {
		const repository = fixture();
		fs.appendFileSync(path.join(repository, relative), claim);
		const { errors } = validateDocs(repository);
		assert.ok(
			errors.some((error) => error.includes(label)),
			`${relative}: ${errors.join("\n")}`,
		);
	}
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
				error.includes(`${relative} must retain safety boundary text: git rev-parse HEAD`),
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

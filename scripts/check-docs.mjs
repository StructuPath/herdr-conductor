#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseManifest } from "./check-manifest.mjs";

const EXPECTED_ACTIONS = [
	"assemble",
	"board",
	"status",
	"harvest",
	"stand-down",
];
const EXPECTED_PANES = ["board-pane"];
const LEGACY_PRODUCT_PATHS = [
	".claude",
	".team",
	"herdr/fs-team.layout.json",
	"scripts/herdr_spawn_fast.py",
	"herdr-conductor-spec.md",
	"docs/plans/2026-07-23-001-feat-herdr-conductor-adapter-plan.md",
];
const HISTORY_PATHS = [
	"docs/history/README.md",
	"docs/history/2026-07-23-herdr-conductor-origin-spec.md",
	"docs/history/2026-07-23-feature-delivery-adapter-plan.md",
];
const CURRENT_DOCS = [
	"README.md",
	"docs/herdr-plugins-cheatsheet.md",
	"roles/reviewer.md",
	"roles/validator.md",
	"herdr-plugin.toml",
];
const RETIRED_CLAIMS = [
	"survives the orchestrator",
	"mode is the one knob that drives isolation and enforcement",
	"crash mid-assemble is recoverable",
	"ownership verified",
	"GUARD enforces",
	"SWARM isolates",
	"you are launched fully read-only",
	"stand down cleanly",
];

function read(root, relative, errors) {
	try {
		return fs.readFileSync(path.join(root, relative), "utf8");
	} catch (error) {
		errors.push(`${relative} could not be read: ${error.message}`);
		return "";
	}
}

function normalized(content) {
	return content.replace(/\s+/g, " ").trim();
}

function ids(entries) {
	if (!Array.isArray(entries)) return [];
	return entries
		.map((entry) => entry?.id)
		.filter((id) => typeof id === "string");
}

function sameMembers(actual, expected) {
	return (
		actual.length === expected.length &&
		[...actual]
			.sort()
			.every((value, index) => value === [...expected].sort()[index])
	);
}

export function validateDocs(root) {
	const resolvedRoot = path.resolve(root);
	const errors = [];
	let manifest;
	let packageJson;

	try {
		manifest = parseManifest(path.join(resolvedRoot, "herdr-plugin.toml"));
	} catch (error) {
		errors.push(error.message);
	}
	try {
		packageJson = JSON.parse(read(resolvedRoot, "package.json", errors));
	} catch (error) {
		errors.push(`package.json is invalid JSON: ${error.message}`);
	}

	const manifestActions = ids(manifest?.actions);
	if (!sameMembers(manifestActions, EXPECTED_ACTIONS)) {
		errors.push(
			`manifest actions must be exactly ${EXPECTED_ACTIONS.join(", ")}; found ${manifestActions.join(", ") || "none"}`,
		);
	}
	const manifestPanes = ids(manifest?.panes);
	if (!sameMembers(manifestPanes, EXPECTED_PANES)) {
		errors.push(
			`manifest panes must be exactly ${EXPECTED_PANES.join(", ")}; found ${manifestPanes.join(", ") || "none"}`,
		);
	}

	const readme = read(resolvedRoot, "README.md", errors);
	const documentedActions = [
		...readme.matchAll(/action invoke ([a-z][a-z0-9-]*)/g),
	].map((match) => match[1]);
	if (!sameMembers(documentedActions, EXPECTED_ACTIONS)) {
		errors.push(
			`README action commands must be exactly ${EXPECTED_ACTIONS.join(", ")}; found ${documentedActions.join(", ") || "none"}`,
		);
	}

	const requiredScripts = [
		"test",
		"check",
		"check:shell",
		"check:manifest",
		"check:docs",
	];
	for (const script of requiredScripts) {
		if (typeof packageJson?.scripts?.[script] !== "string") {
			errors.push(`package.json must define scripts.${script}`);
		}
	}

	for (const relative of LEGACY_PRODUCT_PATHS) {
		if (fs.existsSync(path.join(resolvedRoot, relative))) {
			errors.push(`legacy/non-product path must not exist: ${relative}`);
		}
	}
	for (const relative of HISTORY_PATHS) {
		if (
			!fs
				.statSync(path.join(resolvedRoot, relative), { throwIfNoEntry: false })
				?.isFile()
		) {
			errors.push(`historical record is missing: ${relative}`);
		}
	}

	for (const relative of CURRENT_DOCS) {
		const content = read(resolvedRoot, relative, errors);
		for (const claim of RETIRED_CLAIMS) {
			if (content.includes(claim)) {
				errors.push(
					`${relative} contains retired current-behavior claim: ${claim}`,
				);
			}
		}
	}

	const requiredBoundaries = [
		["README.md", "newest global"],
		["README.md", "Do not invoke `stand-down`"],
		["README.md", "It is advisory"],
		["README.md", "not filesystem immutable"],
		["README.md", "does not invoke Swarm"],
		["roles/reviewer.md", "not enforcement"],
		["roles/validator.md", "does not verify source immutability"],
		["herdr-plugin.toml", "Legacy unsafe teardown"],
		["docs/history/README.md", "not current runtime"],
	];
	for (const [relative, boundary] of requiredBoundaries) {
		const content = read(resolvedRoot, relative, errors);
		if (!normalized(content).includes(normalized(boundary))) {
			errors.push(`${relative} must retain safety boundary text: ${boundary}`);
		}
	}

	return {
		errors,
		actionCount: manifestActions.length,
		currentDocumentCount: CURRENT_DOCS.length,
	};
}

const sourcePath = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === sourcePath) {
	const root = path.resolve(path.dirname(sourcePath), "..");
	const result = validateDocs(root);
	if (result.errors.length > 0) {
		for (const error of result.errors)
			process.stderr.write(`error: ${error}\n`);
		process.exitCode = 1;
	} else {
		process.stdout.write(
			`Docs valid: ${result.actionCount} actions agree and ${result.currentDocumentCount} current documents retain Stage 0 boundaries.\n`,
		);
	}
}

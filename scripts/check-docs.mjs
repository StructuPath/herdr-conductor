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
	"preview",
	"apply",
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
const CANONICAL_VERIFICATION_FILES = [
	"README.md",
	"SECURITY.md",
	"docs/private-state-v1.md",
];
const STAGE_RUNTIME_TEST = /^(?:stage1-runtime-.*|stage2-.*|stage3-.*)\.test\.mjs$/;
const CURRENT_CLAIM_FILES = [
	"README.md",
	"SECURITY.md",
	"docs/herdr-plugins-cheatsheet.md",
	"roles/reviewer.md",
	"roles/validator.md",
	"herdr-plugin.toml",
];
const RETIRED_CLAIMS = [
	["orchestrator survival", /survives? the orchestrator/i],
	[
		"mode-enforced isolation",
		/mode.{0,60}(?:drives?|controls?|enforces?).{0,30}(?:isolation|enforcement)/i,
	],
	[
		"crash recovery",
		/(?:crash(?: mid-assemble)? (?:is |be )?recoverable|recover\w*.{0,40}(?:from|after) (?:a )?crash)/i,
	],
	["verified ownership", /(?:ownership verified|verified ownership)/i],
	["Guard enforcement", /guard (?:directly )?enforces?/i],
	["Swarm isolation", /swarm.{0,30}isolates?/i],
	["enforced read-only launch", /launched fully read-only/i],
	["clean stand-down", /stand down cleanly/i],
	[
		"unverified recorded pane ownership",
		/only panes?.{0,30}(?:we|conductor).{0,20}(?:started|created|owns?)/i,
	],
	[
		"unverified recorded Guard-file ownership",
		/only guard files?.{0,30}(?:we|conductor).{0,20}(?:wrote|created|owns?)/i,
	],
	["byte-identical vendoring", /byte-identical (?:copy|duplicate)/i],
	[
		"cross-process worker recovery",
		/(?:retry.{0,80}re-uses? (?:them|workers)|re-assembl\w*.{0,100}after a crash)/i,
	],
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

function matchesGlob(value, pattern) {
	let valueIndex = 0;
	let patternIndex = 0;
	let starIndex = -1;
	let starValueIndex = 0;
	while (valueIndex < value.length) {
		if (
			patternIndex < pattern.length &&
			(pattern[patternIndex] === "?" ||
				pattern[patternIndex] === value[valueIndex])
		) {
			valueIndex++;
			patternIndex++;
		} else if (pattern[patternIndex] === "*") {
			starIndex = patternIndex++;
			starValueIndex = valueIndex;
		} else if (starIndex !== -1) {
			patternIndex = starIndex + 1;
			valueIndex = ++starValueIndex;
		} else return false;
	}
	while (pattern[patternIndex] === "*") patternIndex++;
	return patternIndex === pattern.length;
}

function validateCanonicalTestCommands(root, relative, content, errors) {
	const commands = [
		...content.replace(/\\\n\s*/g, " ").matchAll(/node --test\s+([^\n]+)/g),
	];
	if (commands.length === 0) {
		errors.push(`${relative} must contain a canonical node --test command`);
		return;
	}
	const referenced = new Set();
	for (const command of commands) {
		for (const token of command[1].trim().split(/\s+/)) {
			if (!token.startsWith("tests/")) continue;
			if (/[*?]/.test(token)) {
				const directory = path.dirname(token);
				const pattern = path.basename(token);
				const directoryPath = path.join(root, directory);
				const matches = fs.existsSync(directoryPath)
					? fs
							.readdirSync(directoryPath)
							.filter((name) => matchesGlob(name, pattern))
					: [];
				if (matches.length === 0)
					errors.push(
						`${relative} canonical test command references nonexistent path: ${token}`,
					);
				for (const match of matches)
					referenced.add(path.join(directory, match));
			} else if (
				!fs
					.statSync(path.join(root, token), { throwIfNoEntry: false })
					?.isFile()
			) {
				errors.push(
					`${relative} canonical test command references nonexistent path: ${token}`,
				);
			} else referenced.add(token);
		}
	}
	const splitTests = fs
		.readdirSync(path.join(root, "tests"))
		.filter((name) => STAGE_RUNTIME_TEST.test(name))
		.map((name) => `tests/${name}`);
	for (const testPath of splitTests)
		if (!referenced.has(testPath))
			errors.push(
				`${relative} canonical test command omits split runtime test: ${testPath}`,
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
	const security = read(resolvedRoot, "SECURITY.md", errors);
	const releaseVersion = packageJson?.version;
	if (
		typeof releaseVersion !== "string" ||
		manifest?.version !== releaseVersion
	)
		errors.push(
			"documentation version authority requires matching package and manifest versions",
		);
	else {
		for (const [relative, content] of [
			["README.md", readme],
			["SECURITY.md", security],
		])
			if (!content.includes(`\`${releaseVersion}\``))
				errors.push(
					`${relative} must document release version ${releaseVersion}`,
				);
	}
	if (!/Requirements:\s+Herdr exactly `0\.7\.5`/.test(readme))
		errors.push("README requirements must support exactly Herdr 0.7.5");
	if (
		/Herdr\s+`?>=\s*0\.7\.5`?/i.test(readme) ||
		/Herdr.{0,24}(?:0\.7\.6|newer|later)/i.test(readme)
	)
		errors.push("README must not claim Herdr >=0.7.5 or newer support");
	const documentedActions = [
		...readme.matchAll(/action invoke ([a-z][a-z0-9-]*)/g),
	].map((match) => match[1]);
	if (!sameMembers(documentedActions, EXPECTED_ACTIONS)) {
		errors.push(
			`README action commands must be exactly ${EXPECTED_ACTIONS.join(", ")}; found ${documentedActions.join(", ") || "none"}`,
		);
	}

	for (const relative of CANONICAL_VERIFICATION_FILES) {
		const content = read(resolvedRoot, relative, errors);
		validateCanonicalTestCommands(resolvedRoot, relative, content, errors);
	}

	const requiredScripts = [
		"test",
		"test:stage2",
		"check",
		"check:shell",
		"check:shellcheck",
		"check:python",
		"check:workflow",
		"check:manifest",
		"check:docs",
		"check:evidence",
		"check:release",
		"report:publish",
		"evidence:stage2:live",
		"evidence:stage2:finalize",
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

	for (const relative of CURRENT_CLAIM_FILES) {
		const content = normalized(read(resolvedRoot, relative, errors));
		for (const [claim, pattern] of RETIRED_CLAIMS) {
			if (pattern.test(content)) {
				errors.push(
					`${relative} contains retired current-behavior claim: ${claim}`,
				);
			}
		}
	}

	const requiredBoundaries = [
		[
			"README.md",
			"there is no `CONDUCTOR_REPO`, ambient-cwd, process-ID, or newest-global fallback",
		],
		[
			"README.md",
			"Approval receipts remain unauthenticated same-UID operator records",
		],
		["README.md", "A spent receipt never authorizes a second compare-and-swap"],
		["README.md", "Resolution exists only for the apply publication"],
		[
			"SECURITY.md",
			"an approve receipt is durably consumed before any apply effect",
		],
		[
			"SECURITY.md",
			"Ambiguous-operation resolution exists only for the Stage 3 apply publication",
		],
		["README.md", "`harvest` is explicitly invoked and attended"],
		["README.md", "`stand-down` closes only panes"],
		["README.md", "B4 live smoke report"],
		["README.md", "Guard is observational"],
		["README.md", "does not invoke Swarm"],
		["README.md", "does not contain or claim results"],
		["README.md", "exactly Herdr `0.7.5`"],
		["SECURITY.md", "attended-operational"],
		["SECURITY.md", "not authentication"],
		["SECURITY.md", "harness-only exception"],
		["roles/reviewer.md", "not enforcement"],
		["roles/reviewer.md", "Expected integration SHA: <full 40-hex SHA>"],
		["roles/reviewer.md", "git rev-parse HEAD"],
		["roles/reviewer.md", "Output `BLOCKED`"],
		["roles/reviewer.md", "does not advance this cwd"],
		["roles/reviewer.md", "unauthenticated worker assertions"],
		["roles/validator.md", "does not verify source immutability"],
		["roles/validator.md", "Expected integration SHA: <full 40-hex SHA>"],
		["roles/validator.md", "git rev-parse HEAD"],
		["roles/validator.md", "Output `BLOCKED`"],
		["roles/validator.md", "does not advance this cwd"],
		["roles/validator.md", "`changed_paths` and `artifacts` are exactly `[]`"],
		["herdr-plugin.toml", "Snapshot Conductor status"],
		[
			"herdr-plugin.toml",
			"Archive strict state and close only panes matching the deterministic full live recorded identity tuple",
		],
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
		currentDocumentCount: CURRENT_CLAIM_FILES.length,
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
			`Docs valid: ${result.actionCount} actions agree and ${result.currentDocumentCount} current documents retain release boundaries.\n`,
		);
	}
}

#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const fixturePath = join(
	root,
	"docs/evidence/fixtures/2026-07-28-herdr-0.7.5-identity-fixtures.json",
);
const resultPath = join(
	root,
	"docs/evidence/2026-07-28-herdr-0.7.5-negative-fixture-results.json",
);

function nonEmptyString(value) {
	return typeof value === "string" && value.length > 0;
}

function hasSession(value) {
	return (
		value !== null &&
		typeof value === "object" &&
		nonEmptyString(value.agent) &&
		nonEmptyString(value.kind) &&
		nonEmptyString(value.source) &&
		nonEmptyString(value.value)
	);
}

function hasTokens(value) {
	return (
		value !== null &&
		typeof value === "object" &&
		nonEmptyString(value.conductor_run_id) &&
		nonEmptyString(value.conductor_generation)
	);
}

function hasPaneIdentity(pane) {
	return (
		pane !== null &&
		typeof pane === "object" &&
		nonEmptyString(pane.workspace_id) &&
		nonEmptyString(pane.pane_id) &&
		nonEmptyString(pane.terminal_id) &&
		nonEmptyString(pane.cwd) &&
		nonEmptyString(pane.foreground_cwd) &&
		hasSession(pane.agent_session) &&
		hasTokens(pane.tokens)
	);
}

function hasAgentIdentity(agent) {
	return (
		agent !== null &&
		typeof agent === "object" &&
		nonEmptyString(agent.name) &&
		nonEmptyString(agent.workspace_id) &&
		nonEmptyString(agent.pane_id) &&
		nonEmptyString(agent.terminal_id) &&
		nonEmptyString(agent.cwd) &&
		nonEmptyString(agent.foreground_cwd) &&
		hasSession(agent.agent_session) &&
		hasTokens(agent.tokens)
	);
}

function classifyIdentity(expected, panes, agents) {
	if (!Array.isArray(panes) || !Array.isArray(agents)) {
		return "capability_unavailable";
	}
	if (panes.length !== 1 || agents.length !== 1) return "ambiguous";

	const pane = panes[0];
	const agent = agents[0];
	if (!hasPaneIdentity(pane) || !hasAgentIdentity(agent)) {
		return "capability_unavailable";
	}

	const matches =
		pane.workspace_id === expected.workspace_id &&
		agent.workspace_id === expected.workspace_id &&
		pane.pane_id === expected.pane_id &&
		agent.pane_id === expected.pane_id &&
		pane.terminal_id === expected.terminal_id &&
		agent.terminal_id === expected.terminal_id &&
		agent.name === expected.agent_name &&
		JSON.stringify(pane.agent_session) === JSON.stringify(expected.agent_session) &&
		JSON.stringify(agent.agent_session) === JSON.stringify(expected.agent_session) &&
		pane.cwd === expected.canonical_cwd &&
		pane.foreground_cwd === expected.canonical_cwd &&
		agent.cwd === expected.canonical_cwd &&
		agent.foreground_cwd === expected.canonical_cwd &&
		pane.tokens.conductor_run_id === expected.run_id &&
		agent.tokens.conductor_run_id === expected.run_id &&
		pane.tokens.conductor_generation === expected.generation &&
		agent.tokens.conductor_generation === expected.generation;

	return matches ? "eligible" : "foreign_or_stale";
}

function applyFixtureMutations(fixtures, fixture) {
	const pane = structuredClone(fixtures.baseline.pane);
	const agent = structuredClone(fixtures.baseline.agent);
	const targets = { pane, agent };
	for (const path of fixture.mutations?.delete ?? []) {
		const [target, ...keys] = path.split(".");
		let value = targets[target];
		for (const key of keys.slice(0, -1)) value = value[key];
		delete value[keys.at(-1)];
	}
	for (const [path, replacement] of Object.entries(fixture.mutations?.set ?? {})) {
		const [target, ...keys] = path.split(".");
		let value = targets[target];
		for (const key of keys.slice(0, -1)) value = value[key];
		value[keys.at(-1)] = replacement;
	}
	return {
		expectedIdentity: fixtures.baseline.expected_identity,
		panes: Array.from({ length: fixture.mutations?.pane_count ?? 1 }, () => structuredClone(pane)),
		agents: Array.from({ length: fixture.mutations?.agent_count ?? 1 }, () => structuredClone(agent)),
	};
}

function runFixture(fixtures, fixture) {
	const attempts = { pane_close: 0, worktree_remove: 0, branch_merge: 0 };
	const spies = {
		paneClose: () => attempts.pane_close++,
		worktreeRemove: () => attempts.worktree_remove++,
		branchMerge: () => attempts.branch_merge++,
	};
	const input = applyFixtureMutations(fixtures, fixture);
	const actual = classifyIdentity(input.expectedIdentity, input.panes, input.agents);
	if (actual === "eligible") {
		spies.paneClose();
		spies.worktreeRemove();
		spies.branchMerge();
	}
	return {
		name: fixture.name,
		expected: fixture.expected_result,
		actual,
		mutation_attempts: attempts,
	};
}

function parseFixtures(bytes) {
	try {
		return JSON.parse(bytes);
	} catch (error) {
		throw new Error("B0 identity fixture is not valid JSON", { cause: error });
	}
}

function main() {
	const fixtureBytes = readFileSync(fixturePath);
	const fixtures = parseFixtures(fixtureBytes);
	assert.equal(fixtures.probe_kind, "conductor-b0-negative-identity-fixtures");
	assert.equal(fixtures.cases.length, 32);

	const cases = fixtures.cases.map((fixture) => runFixture(fixtures, fixture));
	for (const result of cases) {
		assert.equal(result.actual, result.expected, `${result.name}: classification drift`);
		const attempts = Object.values(result.mutation_attempts);
		if (result.actual === "eligible") {
			assert.deepEqual(attempts, [1, 1, 1], `${result.name}: positive spy control failed`);
		} else {
			assert.deepEqual(attempts, [0, 0, 0], `${result.name}: negative fixture reached mutation`);
		}
	}

	const result = {
		probe_kind: fixtures.probe_kind,
		fixture_sha256: createHash("sha256").update(fixtureBytes).digest("hex"),
		cases,
		summary: {
			total: cases.length,
			eligible: cases.filter((item) => item.actual === "eligible").length,
			refused: cases.filter((item) => item.actual !== "eligible").length,
			negative_mutation_attempts: cases
				.filter((item) => item.actual !== "eligible")
				.reduce(
					(total, item) =>
						total + Object.values(item.mutation_attempts).reduce((sum, value) => sum + value, 0),
					0,
				),
			positive_control_mutation_attempts: cases
				.filter((item) => item.actual === "eligible")
				.reduce(
					(total, item) =>
						total + Object.values(item.mutation_attempts).reduce((sum, value) => sum + value, 0),
					0,
				),
		},
	};
	const rendered = `${JSON.stringify(result, null, 2)}\n`;

	if (process.argv.includes("--write")) {
		writeFileSync(resultPath, rendered);
		process.stdout.write(`Wrote ${resultPath}\n`);
	} else {
		assert.equal(readFileSync(resultPath, "utf8"), rendered, "B0 evidence result is stale; run with --write");
		process.stdout.write(
			`B0 identity evidence valid: ${result.summary.refused} negative fixtures reached ${result.summary.negative_mutation_attempts} mock mutations; positive control reached ${result.summary.positive_control_mutation_attempts}.\n`,
		);
	}
}

try {
	main();
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
}

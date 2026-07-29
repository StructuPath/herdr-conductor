#!/usr/bin/env node
import { realpathSync } from "node:fs";
import {
	StateKernelError,
	canonicalJson,
	parseStrictJsonBytes,
} from "./private-state-schema.mjs";

const KIND = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function fail(code, message, cause) {
	throw new StateKernelError(code, message, cause ? { cause } : undefined);
}

function plain(value, label) {
	if (value === null || typeof value !== "object" || Array.isArray(value))
		fail("capability_unavailable", `${label} must be an object`);
	return value;
}

function string(value, label, pattern = null) {
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		value.length > 4096 ||
		/[\0\r\n]/.test(value) ||
		(pattern && !pattern.test(value))
	)
		fail("capability_unavailable", `${label} is invalid`);
	return value;
}

export function herdrJson(exec, herdrBin, args) {
	const output = exec(herdrBin, args);
	let value;
	try {
		value = parseStrictJsonBytes(Buffer.from(output), {
			maxBytes: 1024 * 1024,
		});
	} catch (error) {
		fail(
			"capability_unavailable",
			`Herdr ${args.slice(0, 2).join(" ")} did not return JSON`,
			error,
		);
	}
	if (value?.error)
		fail(
			"capability_unavailable",
			`Herdr ${args.slice(0, 2).join(" ")} returned an error`,
		);
	return value?.result ?? value;
}

export function requireHerdrRuntime(exec, herdrBin) {
	const version = exec(herdrBin, ["--version"]);
	if (version !== "herdr 0.7.5")
		fail("unsupported_herdr", "Herdr runtime must be exactly 0.7.5");
	const schema = herdrJson(exec, herdrBin, ["api", "schema", "--json"]);
	if (schema.protocol !== 17 || schema.schema_version !== 1)
		fail("unsupported_herdr", "Herdr protocol must be exactly 17/schema 1");
	return Object.freeze({ version: "0.7.5", protocol: 17, schemaVersion: 1 });
}

export function paneFrom(result) {
	return plain(result?.pane ?? result, "Herdr pane");
}

export function agentFrom(result) {
	return plain(result?.agent ?? result, "Herdr agent");
}

function canonicalLiveCwd(value, label) {
	string(value, label);
	try {
		return realpathSync(value);
	} catch (error) {
		fail("capability_unavailable", `${label} cannot be canonicalized`, error);
	}
}

function exactLiveCwds(value, label, expected) {
	const cwd = canonicalLiveCwd(value.cwd, `${label}.cwd`);
	const foregroundCwd = canonicalLiveCwd(
		value.foreground_cwd,
		`${label}.foreground_cwd`,
	);
	if (cwd !== expected || foregroundCwd !== expected)
		fail(
			"foreign_or_stale",
			`${label} cwd fields do not match the expected cwd`,
		);
	return expected;
}

export function paneCreationIdentity(pane, run, generation, expectedCwd) {
	return {
		workspace_id: string(pane.workspace_id, "pane workspace_id", KIND),
		pane_id: string(pane.pane_id, "pane pane_id", KIND),
		terminal_id: string(pane.terminal_id, "pane terminal_id", KIND),
		cwd: exactLiveCwds(pane, "pane", expectedCwd),
		run_id: run.state.run_id,
		generation,
	};
}

function session(value) {
	plain(value, "agent_session");
	return {
		agent: string(value.agent, "agent_session.agent", KIND),
		kind: string(value.kind, "agent_session.kind", KIND),
		source: string(value.source, "agent_session.source", KIND),
		value: string(value.value, "agent_session.value"),
	};
}

export function fullPaneIdentity(pane, agent, expected) {
	const paneTokens = plain(pane.tokens, "pane tokens");
	const agentTokens = plain(agent.tokens, "agent tokens");
	const agentSession = session(agent.agent_session);
	const identity = {
		workspace_id: string(pane.workspace_id, "pane workspace_id", KIND),
		pane_id: string(pane.pane_id, "pane pane_id", KIND),
		terminal_id: string(pane.terminal_id, "pane terminal_id", KIND),
		agent_name: string(agent.name, "agent name", KIND),
		agent_kind: agentSession.agent,
		agent_session: agentSession,
		cwd: exactLiveCwds(pane, "pane", expected.cwd),
		run_id: string(paneTokens.conductor_run_id, "pane run token", KIND),
		generation: string(
			paneTokens.conductor_generation,
			"pane generation token",
			/^[a-f0-9]{32}$/,
		),
	};
	const comparisons = [
		[agent.workspace_id, identity.workspace_id],
		[agent.pane_id, identity.pane_id],
		[agent.terminal_id, identity.terminal_id],
		[exactLiveCwds(agent, "agent", expected.cwd), identity.cwd],
		[agentTokens.conductor_run_id, identity.run_id],
		[agentTokens.conductor_generation, identity.generation],
		[identity.workspace_id, expected.workspaceId],
		[identity.pane_id, expected.paneId],
		[identity.agent_name, expected.agentName],
		[identity.agent_kind, expected.agentKind],
		[identity.run_id, expected.runId],
		[identity.generation, expected.generation],
	];
	if (comparisons.some(([actual, wanted]) => actual !== wanted))
		fail(
			"foreign_or_stale",
			"live pane and agent identity do not match the operation",
		);
	if (
		canonicalJson(session(pane.agent_session)) !==
		canonicalJson(identity.agent_session)
	)
		fail("foreign_or_stale", "pane and agent sessions disagree");
	return identity;
}

export function requireAnchor(exec, herdrBin, context) {
	const anchor = paneFrom(
		herdrJson(exec, herdrBin, ["pane", "get", context.focusedPaneId]),
	);
	if (
		string(anchor.workspace_id, "anchor workspace_id", KIND) !==
			context.workspaceId ||
		string(anchor.pane_id, "anchor pane_id", KIND) !== context.focusedPaneId
	)
		fail(
			"foreign_or_stale",
			"focused pane is missing or belongs to another workspace",
		);
}

export function startAgentWhenReady(
	exec,
	herdrBin,
	args,
	{ timeoutMs = 10_000, pollMs = 100 } = {},
) {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		try {
			return herdrJson(exec, herdrBin, args);
		} catch (error) {
			let message = "";
			for (let current = error; current; current = current.cause)
				message += `\n${current.message ?? ""}`;
			if (!/agent_pane_busy|is not an available shell/.test(message))
				throw error;
			if (Date.now() >= deadline)
				fail(
					"capability_unavailable",
					"new pane did not reach an available shell before agent start",
				);
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, pollMs);
		}
	}
}

export function requireUniqueLiveIdentity(exec, herdrBin, paneId, agentName) {
	const panesResult = herdrJson(exec, herdrBin, ["pane", "list"]);
	const agentsResult = herdrJson(exec, herdrBin, ["agent", "list"]);
	const panes = Array.isArray(panesResult?.panes) ? panesResult.panes : [];
	const agents = Array.isArray(agentsResult?.agents) ? agentsResult.agents : [];
	if (
		panes.filter((pane) => pane?.pane_id === paneId).length !== 1 ||
		agents.filter((agent) => agent?.name === agentName).length !== 1
	)
		fail(
			"ambiguous",
			"live pane or named-agent identity is missing or duplicated",
		);
}

export function observeStartedAgent(
	exec,
	herdrBin,
	expected,
	{ timeoutMs = 5_000, pollMs = 100 } = {},
) {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		let retryCause;
		try {
			const panesResult = herdrJson(exec, herdrBin, ["pane", "list"]);
			const agentsResult = herdrJson(exec, herdrBin, ["agent", "list"]);
			const panes = Array.isArray(panesResult?.panes) ? panesResult.panes : [];
			const agents = Array.isArray(agentsResult?.agents)
				? agentsResult.agents
				: [];
			const paneMatches = panes.filter(
				(pane) => pane?.pane_id === expected.paneId,
			);
			const agentMatches = agents.filter(
				(agent) => agent?.name === expected.agentName,
			);
			if (paneMatches.length > 1 || agentMatches.length > 1)
				fail("ambiguous", "new pane or named agent is duplicated");
			if (paneMatches.length === 0 || agentMatches.length === 0)
				fail("capability_unavailable", "new pane or named agent is not listed");
			const pane = paneFrom(
				herdrJson(exec, herdrBin, ["pane", "get", expected.paneId]),
			);
			const agent = agentFrom(
				herdrJson(exec, herdrBin, ["agent", "get", expected.agentName]),
			);
			return fullPaneIdentity(pane, agent, expected);
		} catch (error) {
			if (
				!(error instanceof StateKernelError) ||
				!["foreign_or_stale", "capability_unavailable"].includes(error.code)
			)
				throw error;
			retryCause = error;
		}
		if (Date.now() >= deadline)
			fail(
				"capability_unavailable",
				"new agent identity did not converge after metadata publication",
				retryCause,
			);
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, pollMs);
	}
}

export function readHerdrIdentity(active, recorded, exec, herdrBin) {
	requireUniqueLiveIdentity(
		exec,
		herdrBin,
		recorded.pane_id,
		recorded.agent_name,
	);
	const pane = paneFrom(
		herdrJson(exec, herdrBin, ["pane", "get", recorded.pane_id]),
	);
	const agent = agentFrom(
		herdrJson(exec, herdrBin, ["agent", "get", recorded.agent_name]),
	);
	const identity = fullPaneIdentity(pane, agent, {
		workspaceId: active.state.workspace_id,
		paneId: recorded.pane_id,
		agentName: recorded.agent_name,
		agentKind: recorded.agent_kind,
		runId: active.state.run_id,
		generation: recorded.generation,
		cwd: recorded.cwd,
	});
	if (canonicalJson(identity) !== canonicalJson(recorded))
		fail(
			"foreign_or_stale",
			"live pane tuple does not match canonical journal identity",
		);
	return {
		identity,
		agentStatus: string(agent.agent_status ?? "unknown", "agent status", KIND),
	};
}

export function liveCloseIdentity(active, recorded, exec, herdrBin) {
	return readHerdrIdentity(active, recorded, exec, herdrBin).identity;
}

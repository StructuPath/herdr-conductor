import assert from "node:assert/strict";
import { test } from "node:test";
import { requireHerdrRuntime } from "../scripts/herdr-identity.mjs";

const methodParams = {
	"agent.list": "EmptyParams",
	"agent.get": "AgentTarget",
	"agent.start": "AgentStartParams",
	"pane.split": "PaneSplitParams",
	"pane.list": "PaneListParams",
	"pane.get": "PaneTarget",
	"pane.report_metadata": "PaneReportMetadataParams",
	"pane.close": "PaneTarget",
};

function schema093() {
	const nullableString = { type: ["string", "null"] };
	const identity = {
		workspace_id: { type: "string" },
		pane_id: { type: "string" },
		terminal_id: { type: "string" },
		cwd: nullableString,
		foreground_cwd: nullableString,
		tokens: { type: "object", additionalProperties: { type: "string" } },
		agent_session: {
			anyOf: [
				{ $ref: "#/schemas/success_response/$defs/AgentSessionInfo" },
				{ type: "null" },
			],
		},
	};
	const paneRef = "#/schemas/success_response/$defs/PaneInfo";
	const agentRef = "#/schemas/success_response/$defs/AgentInfo";
	return {
		protocol: 22,
		schema_version: 1,
		schemas: {
			request: {
				oneOf: Object.entries(methodParams).map(([method, params]) => ({
					type: "object",
					required: ["method", "params"],
					properties: {
						method: { type: "string", const: method },
						params: { $ref: `#/schemas/request/$defs/${params}` },
					},
				})),
				$defs: {
					EmptyParams: { type: "object" },
					PaneTarget: {
						type: "object",
						required: ["pane_id"],
						properties: { pane_id: { type: "string" } },
					},
					PaneListParams: { type: "object" },
					SplitDirection: { type: "string", enum: ["right", "down"] },
					PaneSplitParams: {
						type: "object",
						required: ["direction"],
						properties: {
							direction: {
								$ref: "#/schemas/request/$defs/SplitDirection",
							},
							target_pane_id: nullableString,
							cwd: nullableString,
							focus: { type: "boolean" },
						},
					},
					PaneReportMetadataParams: {
						type: "object",
						required: ["pane_id", "source"],
						properties: {
							pane_id: { type: "string" },
							source: { type: "string" },
							tokens: { type: "object" },
						},
					},
					AgentTarget: {
						type: "object",
						required: ["target"],
						properties: { target: { type: "string" } },
					},
					AgentStartParams: {
						type: "object",
						required: ["name", "kind", "pane_id"],
						properties: {
							name: { type: "string" },
							kind: { type: "string" },
							pane_id: { type: "string" },
							timeout_ms: { type: ["integer", "null"] },
						},
					},
					PluginInvocationContext: {
						type: "object",
						properties: {
							workspace_id: nullableString,
							workspace_cwd: nullableString,
							focused_pane_id: nullableString,
						},
					},
				},
			},
			success_response: {
				$defs: {
					AgentSessionInfo: {
						type: "object",
						required: ["source", "agent", "kind", "value"],
						properties: {
							source: { type: "string" },
							agent: { type: "string" },
							kind: { type: "string" },
							value: { type: "string" },
						},
					},
					PaneInfo: {
						type: "object",
						required: ["workspace_id", "pane_id", "terminal_id"],
						properties: identity,
					},
					AgentInfo: {
						type: "object",
						required: ["workspace_id", "pane_id", "terminal_id"],
						properties: {
							...identity,
							name: nullableString,
							agent_status: { type: "string" },
						},
					},
					ResponseResult: {
						oneOf: [
							{
								required: ["type", "pane"],
								properties: {
									type: { const: "pane_info" },
									pane: { $ref: paneRef },
								},
							},
							{
								required: ["type", "panes"],
								properties: {
									type: { const: "pane_list" },
									panes: { type: "array", items: { $ref: paneRef } },
								},
							},
							{
								required: ["type", "agent"],
								properties: {
									type: { const: "agent_info" },
									agent: { $ref: agentRef },
								},
							},
							{
								required: ["type", "agents"],
								properties: {
									type: { const: "agent_list" },
									agents: { type: "array", items: { $ref: agentRef } },
								},
							},
							{
								required: ["type", "agent", "argv"],
								properties: {
									type: { const: "agent_started" },
									agent: { $ref: agentRef },
									argv: { type: "array", items: { type: "string" } },
								},
							},
							{
								required: ["type"],
								properties: { type: { const: "ok" } },
							},
						],
					},
				},
			},
		},
	};
}

function server093() {
	return {
		status: "running",
		running: true,
		version: "0.9.3",
		protocol: 22,
		compatible: true,
		endpoint_compatible: true,
		restart_needed: false,
		server_binary_stale: false,
	};
}

function candidateExec(schema = schema093(), server = server093()) {
	const calls = [];
	return {
		calls,
		exec(command, args) {
			assert.equal(command, "candidate-herdr");
			calls.push(args);
			if (args.join(" ") === "--version") return "herdr 0.9.3";
			if (args.join(" ") === "api schema --json") return JSON.stringify(schema);
			if (args.join(" ") === "status server --json")
				return JSON.stringify(server);
			assert.fail(`unexpected command: ${args.join(" ")}`);
		},
	};
}

test("legacy 0.7.5 keeps its exact protocol and accepts the legacy status shape", () => {
	const calls = [];
	const profile = requireHerdrRuntime((_command, args) => {
		calls.push(args);
		if (args.join(" ") === "--version") return "herdr 0.7.5";
		if (args.join(" ") === "api schema --json")
			return JSON.stringify({ protocol: 17, schema_version: 1 });
		if (args.join(" ") === "status server --json")
			return JSON.stringify({
				status: "running",
				running: true,
				version: "0.7.5",
				protocol: 17,
				compatible: true,
				restart_needed: false,
			});
		assert.fail(`unexpected command: ${args.join(" ")}`);
	}, "legacy-herdr");
	assert.deepEqual(profile, { version: "0.7.5", protocol: 17, schemaVersion: 1 });
	assert.deepEqual(calls, [
		["--version"],
		["api", "schema", "--json"],
		["status", "server", "--json"],
	]);
});

test("0.9.3 requires the proven API capabilities and exact live server identity", () => {
	const fake = candidateExec();
	assert.deepEqual(requireHerdrRuntime(fake.exec, "candidate-herdr"), {
		version: "0.9.3",
		protocol: 22,
		schemaVersion: 1,
	});
	assert.deepEqual(fake.calls, [
		["--version"],
		["api", "schema", "--json"],
		["status", "server", "--json"],
	]);
});

test("0.9.3 refuses missing API capabilities and stale or incompatible servers", () => {
	const cases = [
		{
			name: "wrong protocol",
			change(schema) {
				schema.protocol = 21;
			},
		},
		{
			name: "missing close method",
			change(schema) {
				schema.schemas.request.oneOf = schema.schemas.request.oneOf.filter(
					(candidate) => candidate.properties.method.const !== "pane.close",
				);
			},
		},
		{
			name: "missing identity tokens",
			change(schema) {
				delete schema.schemas.success_response.$defs.PaneInfo.properties.tokens;
			},
		},
		{
			name: "server version mismatch",
			change(_schema, server) {
				server.version = "0.9.2";
			},
		},
		{
			name: "endpoint incompatible",
			change(_schema, server) {
				server.endpoint_compatible = false;
			},
		},
		{
			name: "stale server binary",
			change(_schema, server) {
				server.server_binary_stale = true;
			},
		},
	];
	for (const fixture of cases) {
		const schema = schema093();
		const server = server093();
		fixture.change(schema, server);
		const fake = candidateExec(schema, server);
		assert.throws(
			() => requireHerdrRuntime(fake.exec, "candidate-herdr"),
			(error) => error?.code === "unsupported_herdr",
			fixture.name,
		);
	}
});

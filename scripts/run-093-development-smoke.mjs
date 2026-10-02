#!/usr/bin/env node
// Development-only installed-action compatibility smoke. It never starts,
// stops, restarts, or upgrades a Herdr server and refuses default-session paths.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import {
	chmodSync,
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
	STAGE3_APPROVAL_STATEMENTS,
	canonicalJson,
	parseStrictJsonBytes,
} from "./private-state-schema.mjs";
import { computeChangedPaths } from "./source-policy.mjs";
import {
	parseTaskBytes,
	reportDigest,
} from "./task-report-schema.mjs";

const OPT_IN = "I_UNDERSTAND_THIS_MUTATES_ONLY_THE_ISOLATED_093_SESSION";
const PLUGIN_ID = "structupath.conductor";
const root = realpathSync(join(dirname(fileURLToPath(import.meta.url)), ".."));
const configPathFor = (repository) => join(repository, ".herdr-conductor.json");
let retainedFailure = null;

function fail(message) {
	throw new Error(message);
}

function sha256(value) {
	return createHash("sha256").update(value).digest("hex");
}

function contained(parent, child) {
	const path = relative(parent, child);
	return path !== "" && path !== ".." && !path.startsWith(`..${sep}`);
}

function shellQuote(value) {
	return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

function command(binary, args, options = {}) {
	return execFileSync(binary, args, {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		timeout: 180_000,
		killSignal: "SIGKILL",
		...options,
	}).trim();
}

function git(repository, ...args) {
	return command("git", ["-C", repository, ...args]);
}

function findObject(value, predicate, seen = new Set()) {
	if (value === null || typeof value !== "object" || seen.has(value)) return null;
	seen.add(value);
	if (predicate(value)) return value;
	for (const child of Array.isArray(value) ? value : Object.values(value)) {
		const found = findObject(child, predicate, seen);
		if (found) return found;
	}
	return null;
}

function parseJson(output, label) {
	try {
		return JSON.parse(output);
	} catch (error) {
		throw new Error(`${label} did not return JSON`, { cause: error });
	}
}

function embeddedJson(result, predicate) {
	const direct = findObject(result.payload, predicate);
	if (direct) return direct;
	for (const text of [result.output, result.payload?.stdout, result.payload?.stderr]) {
		if (typeof text !== "string") continue;
		for (const candidate of [text.trim(), ...text.split("\n")]) {
			if (!candidate.startsWith("{")) continue;
			try {
				const found = findObject(JSON.parse(candidate), predicate);
				if (found) return found;
			} catch {
				// Not a standalone JSON value.
			}
		}
	}
	fail("installed action omitted its structured result");
}

function repositoryKey(repository) {
	const commonPath = realpathSync(
		git(repository, "rev-parse", "--path-format=absolute", "--git-common-dir"),
	);
	const stats = statSync(commonPath, { bigint: true });
	return sha256(
		`herdr-conductor-repository-v1\0${commonPath}\0${stats.dev}\0${stats.ino}`,
	);
}

function workspaceKey(workspaceId) {
	return sha256(`herdr-conductor-workspace-v1\0${workspaceId}`);
}

function journalEntries(stateRepositoryPath, workspaceId, assembled) {
	const directory = join(
		stateRepositoryPath,
		"workspaces",
		workspaceKey(workspaceId),
		"runs",
		assembled.run_id,
		assembled.generation,
		"operations",
	);
	return readdirSync(directory)
		.filter((name) => name.endsWith(".json"))
		.sort()
		.map((name) => parseStrictJsonBytes(readFileSync(join(directory, name))));
}

function retainedOperations(stateRoot) {
	const operations = [];
	function visit(directory) {
		if (!existsSync(directory)) return;
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			const path = join(directory, entry.name);
			if (entry.isDirectory()) {
				visit(path);
				continue;
			}
			if (!path.includes(`${sep}operations${sep}`) || !entry.name.endsWith(".json"))
				continue;
			try {
				const value = parseStrictJsonBytes(readFileSync(path));
				operations.push({
					path: relative(stateRoot, path),
					operation_id: value.operation_id,
					operation_type: value.operation_type,
					phase: value.phase,
					subject: value.subject,
				});
			} catch {
				operations.push({
					path: relative(stateRoot, path),
					parse_error: true,
				});
			}
		}
	}
	visit(stateRoot);
	return operations.sort((left, right) =>
		Buffer.from(left.path).compare(Buffer.from(right.path)),
	);
}

function buildReport(worker, stateRepositoryPath, workspaceId, assembled) {
	const task = parseTaskBytes(readFileSync(worker.task_path));
	const agent = journalEntries(
		stateRepositoryPath,
		workspaceId,
		assembled,
	).find(
		(entry) =>
			entry.operation_type === "agent.start" &&
			entry.phase === "observed" &&
			entry.subject.id === task.role.name,
	);
	assert.ok(agent, "report requires observed task-bound agent authority");
	const producer = task.source.kind === "role_worktree";
	const output = producer ? git(task.source.root, "rev-parse", "HEAD") : null;
	const source = producer
		? {
				...task.source,
				expected_sha: output,
				tree_sha: git(task.source.root, "rev-parse", "HEAD^{tree}"),
			}
		: task.source;
	const changedPaths = producer
		? computeChangedPaths(task.source.root, task.source.fork_sha, output)
		: [];
	const requirementResults = [
		...task.assignment.required_commands.map((requirement) => ({
			requirement_kind: "command",
			requirement_id: requirement.id,
			assertion: "passed",
			evidence_kind: "worker_assertion",
			command: requirement.command,
			exit_code: 0,
			output_sha256: sha256("development smoke command assertion"),
			note: "Unauthenticated deterministic development-smoke assertion.",
		})),
		...task.assignment.acceptance_criteria.map((requirement) => ({
			requirement_kind: "criterion",
			requirement_id: requirement.id,
			assertion: "passed",
			evidence_kind: "worker_assertion",
			command: null,
			exit_code: null,
			output_sha256: null,
			note: "Unauthenticated deterministic development-smoke assertion.",
		})),
	];
	const draft = {
		document_type: "herdr-conductor-report",
		schema_version: 1,
		report_id: `development-smoke-${task.role.name}`,
		report_generation: sha256(`development-smoke\0${task.task_digest}`).slice(
			0,
			32,
		),
		task: {
			id: task.task_id,
			generation: task.task_generation,
			digest: task.task_digest,
		},
		scope: task.scope,
		role: task.role,
		source,
		agent_observation: {
			operation_id: task.role.agent_operation_id,
			entry_digest: agent.entry_digest,
			agent_generation: task.role.agent_generation,
			pane_generation: task.role.pane_generation,
			agent_name: task.role.agent_name,
		},
		status: "completed",
		result:
			task.role.contract_role === "validator"
				? { kind: "validation", verdict: "pass" }
				: { kind: "delivery", verdict: "delivered" },
		summary: "Deterministic local development smoke result.",
		findings: [],
		requirement_results: requirementResults,
		changed_paths: changedPaths,
		artifacts: [],
		completed_at: "2000-01-01T00:00:00.000Z",
	};
	return { task, report: { ...draft, report_digest: reportDigest(draft) } };
}

function publishReport(pluginRoot, worker, report) {
	const result = spawnSync(
		process.execPath,
		[
			join(pluginRoot, "scripts/report-publisher.mjs"),
			"publish",
			"--config",
			configPathFor(report.scope.repository_root),
			"--task",
			worker.task_path,
		],
		{
			cwd: worker.cwd,
			input: canonicalJson(report),
			encoding: "utf8",
			timeout: 120_000,
		},
	);
	if (result.status !== 0)
		fail(`report publication failed: ${(result.stderr ?? "").trim()}`);
}

function approvalReceipt(previewed) {
	const identity = previewed.preview;
	return {
		document_type: "herdr-conductor-stage3-approval",
		schema_version: 1,
		repository_key: identity.repository_key,
		workspace_id: identity.workspace_id,
		run_id: identity.run_id,
		run_generation: identity.run_generation,
		attempt_generation: identity.attempt_generation,
		preview_entry_digest: previewed.preview_entry_digest,
		decision: "approve",
		statement: STAGE3_APPROVAL_STATEMENTS.approve,
	};
}

function recordApproval(pluginRoot, repository, receipt) {
	const result = spawnSync(
		process.execPath,
		[
			join(pluginRoot, "scripts/approval-recorder.mjs"),
			"record",
			"--config",
			configPathFor(repository),
		],
		{
			cwd: repository,
			input: canonicalJson(receipt),
			encoding: "utf8",
			timeout: 120_000,
		},
	);
	if (result.status !== 0)
		fail(`approval recording failed: ${(result.stderr ?? "").trim()}`);
}

function createDevelopmentPlugin(temporaryRoot, herdrBin, socket) {
	const pluginRoot = join(temporaryRoot, "plugin");
	cpSync(root, pluginRoot, {
		recursive: true,
		filter(source) {
			const relativePath = relative(root, source);
			return (
				relativePath !== ".git" &&
				!relativePath.startsWith(`.git${sep}`) &&
				relativePath !== "node_modules" &&
				!relativePath.startsWith(`node_modules${sep}`)
			);
		},
	});
	const wrapperPath = join(pluginRoot, "scripts/development-093-action.sh");
	writeFileSync(
		wrapperPath,
		`#!/usr/bin/env bash\nset -euo pipefail\ncd "\${HERDR_PLUGIN_ROOT:?}"\nexport HERDR_BIN_PATH=${shellQuote(herdrBin)}\nexport HERDR_SOCKET_PATH=${shellQuote(socket)}\nexec node scripts/stage1-runtime.mjs "$1"\n`,
		{ mode: 0o700 },
	);
	chmodSync(wrapperPath, 0o700);
	const manifestPath = join(pluginRoot, "herdr-plugin.toml");
	const manifest = readFileSync(manifestPath, "utf8").replace(
		/command = \["bash", "scripts\/(assemble|board|status|harvest|preview|apply|stand-down)\.sh"\]/g,
		(_match, action) =>
			`command = ["bash", "scripts/development-093-action.sh", "${action}"]`,
	);
	for (const action of [
		"assemble",
		"board",
		"status",
		"harvest",
		"preview",
		"apply",
		"stand-down",
	])
		if (
			!manifest.includes(
				`command = ["bash", "scripts/development-093-action.sh", "${action}"]`,
			)
		)
			fail(`development plugin manifest did not rewrite ${action}`);
	writeFileSync(manifestPath, manifest);
	return realpathSync(pluginRoot);
}

function createRepository(repository, stateRoot) {
	mkdirSync(repository, { recursive: true });
	command("git", ["init", "-q", "-b", "main", repository]);
	git(repository, "config", "user.name", "Conductor Development Smoke");
	git(
		repository,
		"config",
		"user.email",
		"conductor-development-smoke@local.invalid",
	);
	writeFileSync(join(repository, "base.txt"), "Herdr 0.9.3 development smoke\n");
	writeFileSync(
		configPathFor(repository),
		canonicalJson({
			version: 3,
			apply: { target_ref: "refs/heads/development-smoke-target" },
			state_root: { kind: "absolute", path: stateRoot },
			worktree_root: ".conductor-worktrees",
			roles: [
				{
					name: "builder",
					contract_role: "builder",
					kind: "pi",
					mode: "write",
					assignment: {
						title: "Create the deterministic development-smoke file",
						mission: "Exercise installed Conductor actions without a model.",
						acceptance_criteria: [
							{
								id: "smoke-file",
								text: "The deterministic smoke file is committed.",
							},
						],
						owned_paths: ["src"],
						forbidden_paths: [],
						required_commands: [],
					},
					validator_artifacts: [],
				},
				{
					name: "validator",
					contract_role: "validator",
					kind: "pi",
					mode: "gated",
					assignment: {
						title: "Validate the deterministic integration snapshot",
						mission: "Exercise the exact-SHA gate without a model.",
						acceptance_criteria: [
							{
								id: "exact-sha",
								text: "The gate source is the integration SHA.",
							},
						],
						owned_paths: [],
						forbidden_paths: [],
						required_commands: [],
					},
					validator_artifacts: [],
				},
			],
		}),
	);
	git(repository, "add", "base.txt", ".herdr-conductor.json");
	command("git", ["-C", repository, "commit", "-qm", "development smoke base"], {
		env: {
			...process.env,
			GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
			GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
		},
	});
	const fork = git(repository, "rev-parse", "HEAD");
	git(
		repository,
		"update-ref",
		"refs/heads/development-smoke-target",
		fork,
	);
	return fork;
}

function installSyntheticPi(home, temporaryRoot, herdrBin, session, socket) {
	const binDirectory = join(temporaryRoot, "synthetic-bin");
	mkdirSync(binDirectory, { mode: 0o700 });
	const piPath = join(binDirectory, "pi");
	writeFileSync(
		piPath,
		`#!/usr/bin/env bash\nset -euo pipefail\nPANE="\${HERDR_PANE_ID:?}"\nSESSION_ID="development-smoke-\${PANE//:/-}"\n# Agent detection runs on a periodic process scan. Reporting before the fake\n# foreground pi process is detected is discarded when detection publishes Pi.\nsleep 1\n${shellQuote(herdrBin)} --session ${shellQuote(session)} pane report-agent-session "$PANE" --source herdr:pi --agent pi --seq 1 --session-start-source startup --agent-session-id "$SESSION_ID" >/dev/null\n${shellQuote(herdrBin)} --session ${shellQuote(session)} pane report-agent "$PANE" --source herdr:pi --agent pi --state idle --seq 2 --agent-session-id "$SESSION_ID" >/dev/null\nprintf 'synthetic pi fixture ready\\n'\nwhile IFS= read -r _line; do :; done\n`,
		{ mode: 0o700 },
	);
	chmodSync(piPath, 0o700);
	const profileContent = `export PATH=${shellQuote(binDirectory)}:"$PATH"\nexport HERDR_BIN_PATH=${shellQuote(herdrBin)}\nexport HERDR_SOCKET_PATH=${shellQuote(socket)}\n`;
	const profiles = [".zshenv", ".zshrc", ".bash_profile", ".bashrc", ".profile"].map(
		(name) => join(home, name),
	);
	for (const profile of profiles)
		if (existsSync(profile))
			fail(`isolated HOME profile already exists and will not be overwritten: ${profile}`);
	for (const profile of profiles)
		writeFileSync(profile, profileContent, { mode: 0o600 });
	return () => {
		for (const profile of profiles) rmSync(profile, { force: true });
	};
}

async function main() {
	if (process.env.CONDUCTOR_093_DEVELOPMENT_SMOKE !== OPT_IN)
		fail(
			`refusing development smoke: set CONDUCTOR_093_DEVELOPMENT_SMOKE=${OPT_IN}`,
		);
	const herdrBin = realpathSync(
		process.env.CONDUCTOR_093_HERDR_BIN ??
			fail("CONDUCTOR_093_HERDR_BIN is required"),
	);
	const session = process.env.CONDUCTOR_093_SESSION;
	if (!session || session === "default")
		fail("CONDUCTOR_093_SESSION must name a non-default isolated session");
	const socket = realpathSync(
		process.env.HERDR_SOCKET_PATH ?? fail("HERDR_SOCKET_PATH is required"),
	);
	const home = realpathSync(process.env.HOME ?? fail("isolated HOME is required"));
	const temporaryParent = realpathSync(tmpdir());
	const allowedHomeParents = [
		temporaryParent,
		...(existsSync("/tmp") ? [realpathSync("/tmp")] : []),
	];
	if (!allowedHomeParents.some((parent) => contained(parent, home)))
		fail("HOME must be a child of a recognized temporary directory");
	const expectedSocketSuffix = join("sessions", session, "herdr.sock");
	if (!socket.endsWith(expectedSocketSuffix) || !contained(home, socket))
		fail("HERDR_SOCKET_PATH is not the named isolated session socket under HOME");
	if (command(herdrBin, ["--version"]) !== "herdr 0.9.3")
		fail("development smoke requires the exact Herdr 0.9.3 client");
	const herdrEnv = {
		...process.env,
		HERDR_BIN_PATH: herdrBin,
		HERDR_SOCKET_PATH: socket,
	};
	const runHerdr = (args) =>
		parseJson(
			command(herdrBin, ["--session", session, ...args], { env: herdrEnv }),
			`herdr ${args.join(" ")}`,
		);
	const runHerdrCommand = (args) =>
		command(herdrBin, ["--session", session, ...args], { env: herdrEnv });
	const status = runHerdr(["status", "server", "--json"]);
	if (
		status.status !== "running" ||
		status.running !== true ||
		status.version !== "0.9.3" ||
		status.protocol !== 22 ||
		status.compatible !== true ||
		status.endpoint_compatible !== true ||
		status.restart_needed !== false ||
		status.server_binary_stale !== false ||
		status.session !== session ||
		realpathSync(status.socket) !== socket
	)
		fail("named server is not the exact healthy isolated 0.9.3/protocol 22 server");
	const api = runHerdr(["api", "schema", "--json"]);
	if (api.protocol !== 22 || api.schema_version !== 1)
		fail("named client does not expose protocol 22/schema 1");
	const priorPluginRecord = findObject(
		runHerdr(["plugin", "list", "--json"]),
		(value) => value?.plugin_id === PLUGIN_ID,
	);
	let priorPlugin = null;
	if (priorPluginRecord) {
		if (
			priorPluginRecord.source?.kind !== "local" ||
			typeof priorPluginRecord.plugin_root !== "string" ||
			typeof priorPluginRecord.enabled !== "boolean"
		)
			fail("existing isolated Conductor plugin cannot be restored exactly");
		priorPlugin = {
			root: realpathSync(priorPluginRecord.plugin_root),
			enabled: priorPluginRecord.enabled,
		};
	}

	const temporaryRoot = realpathSync(
		mkdtempSync(join(temporaryParent, "herdr-conductor-093-development-")),
	);
	chmodSync(temporaryRoot, 0o700);
	const stateRoot = join(temporaryRoot, "state");
	const repository = join(temporaryRoot, "repository");
	mkdirSync(stateRoot, { mode: 0o700 });
	let removeProfiles = () => {};
	let profilesRemoved = false;
	let pluginLinked = false;
	let priorPluginRemoved = false;
	let workspaceId = null;
	let workspaceClosed = false;
	let completed = false;
	let summary;
	const cleanupErrors = [];
	try {
		const pluginRoot = createDevelopmentPlugin(temporaryRoot, herdrBin, socket);
		removeProfiles = installSyntheticPi(
			home,
			temporaryRoot,
			herdrBin,
			session,
			socket,
		);
		const fork = createRepository(repository, stateRoot);
		if (priorPlugin) {
			runHerdr(["plugin", "unlink", PLUGIN_ID]);
			priorPluginRemoved = true;
		}
		runHerdr(["plugin", "link", pluginRoot, "--enabled"]);
		pluginLinked = true;
		const workspaceCreated = runHerdr([
			"workspace",
			"create",
			"--cwd",
			repository,
			"--label",
			"Conductor 0.9.3 development smoke",
			"--focus",
		]);
		const workspace = findObject(
			workspaceCreated,
			(value) => typeof value?.workspace_id === "string",
		);
		const rootPane = findObject(
			workspaceCreated,
			(value) =>
				typeof value?.pane_id === "string" &&
				value?.workspace_id === workspace?.workspace_id,
		);
		if (!workspace || !rootPane) fail("workspace creation omitted identities");
		workspaceId = workspace.workspace_id;
		runHerdrCommand([
			"pane",
			"run",
			rootPane.pane_id,
			"command -v pi >/dev/null && printf 'synthetic-pi-ready\\n'",
		]);
		runHerdrCommand([
			"pane",
			"wait-output",
			rootPane.pane_id,
			"--match",
			"synthetic-pi-ready",
			"--timeout",
			"30000",
		]);

		const invokeLog = (actionId) => {
			runHerdr(["workspace", "focus", workspaceId]);
			const invoked = runHerdr([
				"plugin",
				"action",
				"invoke",
				actionId,
				"--plugin",
				PLUGIN_ID,
			]);
			const invocation = findObject(
				invoked,
				(value) =>
					typeof value?.log?.log_id === "string" &&
					value?.action?.action_id === actionId,
			);
			if (!invocation) fail(`Herdr omitted ${actionId} action log identity`);
			const deadline = Date.now() + 180_000;
			let log;
			while (Date.now() < deadline) {
				const listed = runHerdr([
					"plugin",
					"log",
					"list",
					"--plugin",
					PLUGIN_ID,
					"--limit",
					"100",
				]);
				log = findObject(
					listed,
					(value) => value?.log_id === invocation.log.log_id,
				);
				if (log && log.status !== "running") break;
				Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
			}
			if (!log || log.status === "running")
				fail(`Herdr ${actionId} action did not reach a terminal state`);
			return {
				payload: log,
				output: `${log.stdout ?? ""}\n${log.stderr ?? ""}`.trim(),
			};
		};
		const invoke = (actionId) => {
			const result = invokeLog(actionId);
			if (result.payload.status !== "succeeded" || result.payload.exit_code !== 0)
				fail(`Herdr ${actionId} action failed: ${result.output}`);
			return result;
		};
		const invokeRefusal = (actionId) => {
			const result = invokeLog(actionId);
			if (result.payload.status === "succeeded" || result.payload.exit_code === 0)
				fail(`Herdr ${actionId} action unexpectedly succeeded`);
			return result;
		};

		const assembled = embeddedJson(
			invoke("assemble"),
			(value) =>
				typeof value?.run_id === "string" && Array.isArray(value?.workers),
		);
		assert.equal(assembled.workers.length, 1);
		invoke("status");
		embeddedJson(
			invoke("board"),
			(value) =>
				value?.run === assembled.run_id && value?.workspace_id === workspaceId,
		);
		const builder = assembled.workers[0];
		mkdirSync(join(builder.cwd, "src"));
		writeFileSync(join(builder.cwd, "src", "smoke.txt"), "verified local fixture\n");
		git(builder.cwd, "add", "src/smoke.txt");
		command("git", ["-C", builder.cwd, "commit", "-qm", "development smoke change"], {
			env: {
				...process.env,
				GIT_AUTHOR_DATE: "2000-01-01T00:01:00Z",
				GIT_COMMITTER_DATE: "2000-01-01T00:01:00Z",
			},
		});
		const stateRepositoryPath = join(
			stateRoot,
			"v1",
			"repositories",
			repositoryKey(repository),
		);
		publishReport(
			pluginRoot,
			builder,
			buildReport(builder, stateRepositoryPath, workspaceId, assembled).report,
		);
		const firstHarvest = embeddedJson(
			invoke("harvest"),
			(value) =>
				value?.lifecycle === "gate_waiting_reports" &&
				Array.isArray(value?.gate_workers),
		);
		assert.equal(firstHarvest.gate_workers.length, 1);
		const validator = firstHarvest.gate_workers[0];
		assert.equal(
			git(validator.cwd, "rev-parse", "HEAD"),
			firstHarvest.integration.final_sha,
		);
		publishReport(
			pluginRoot,
			validator,
			buildReport(validator, stateRepositoryPath, workspaceId, assembled).report,
		);
		const secondHarvest = embeddedJson(
			invoke("harvest"),
			(value) => value?.lifecycle === "gate_reports_collected",
		);
		const targetBefore = git(
			repository,
			"rev-parse",
			"refs/heads/development-smoke-target",
		);
		assert.equal(targetBefore, fork);
		const previewed = embeddedJson(
			invoke("preview"),
			(value) =>
				value?.lifecycle === "apply_previewed" &&
				typeof value?.preview_entry_digest === "string",
		);
		invokeRefusal("apply");
		assert.equal(
			git(repository, "rev-parse", "refs/heads/development-smoke-target"),
			targetBefore,
		);
		recordApproval(pluginRoot, repository, approvalReceipt(previewed));
		const applied = embeddedJson(
			invoke("apply"),
			(value) => value?.lifecycle === "applied" && value?.apply?.cas_count === 1,
		);
		assert.equal(
			git(repository, "rev-parse", "refs/heads/development-smoke-target"),
			secondHarvest.integration.final_sha,
		);
		const replayedApply = embeddedJson(
			invoke("apply"),
			(value) => value?.lifecycle === "applied" && value?.replayed === true,
		);
		const stoodDown = embeddedJson(
			invoke("stand-down"),
			(value) => value?.archived === true && Array.isArray(value?.closed),
		);
		const replayedStandDown = embeddedJson(
			invoke("stand-down"),
			(value) => value?.archived === true && value?.replayed === true,
		);
		assert.equal(stoodDown.closed.length, 2);
		summary = {
			document_type: "herdr-conductor-0.9.3-development-smoke",
			schema_version: 1,
			certification: false,
			result: "passed",
			runtime: { version: "0.9.3", protocol: 22, api_schema: 1 },
			actions: [
				"assemble",
				"status",
				"board",
				"harvest-producer",
				"harvest-validator",
				"preview",
				"apply-refusal-before-receipt",
				"apply",
				"apply-replay",
				"stand-down",
				"stand-down-replay",
			],
			integration_final_sha: secondHarvest.integration.final_sha,
			apply_target_before: targetBefore,
			apply_target_after: applied.apply.final_sha,
			apply_replayed: replayedApply.replayed,
			closed_worker_count: stoodDown.closed.length,
			stand_down_replayed: replayedStandDown.replayed,
			limitations: [
				"development-only",
				"synthetic local shell workers",
				"unauthenticated worker assertions",
				"no model or network integration",
				"not formal evidence or production approval",
			],
		};
		completed = true;
	} finally {
		if (completed && workspaceId && !workspaceClosed) {
			try {
				runHerdr(["workspace", "close", workspaceId]);
				workspaceClosed = true;
			} catch (error) {
				cleanupErrors.push(`workspace close: ${error.message}`);
			}
		}
		if (pluginLinked) {
			try {
				runHerdr(["plugin", "unlink", PLUGIN_ID]);
				pluginLinked = false;
			} catch (error) {
				cleanupErrors.push(`plugin unlink: ${error.message}`);
			}
		}
		if (priorPluginRemoved) {
			try {
				runHerdr([
					"plugin",
					"link",
					priorPlugin.root,
					priorPlugin.enabled ? "--enabled" : "--disabled",
				]);
				priorPluginRemoved = false;
			} catch (error) {
				cleanupErrors.push(`prior plugin restoration: ${error.message}`);
			}
		}
		try {
			removeProfiles();
			profilesRemoved = true;
		} catch (error) {
			cleanupErrors.push(`profile removal: ${error.message}`);
		}
		if (completed) {
			summary.artifacts = {
				temporary_root: temporaryRoot,
				repository,
				state_root: stateRoot,
				retention: "private development evidence; manual disposal required",
			};
			summary.cleanup = {
				workspace: workspaceClosed ? "closed" : "failed",
				development_plugin: pluginLinked ? "failed" : "unlinked",
				temporary_profiles: profilesRemoved ? "removed" : "failed",
				prior_plugin: priorPlugin
					? priorPluginRemoved
						? "failed"
						: "restored"
					: "not_present",
			};
			if (cleanupErrors.length > 0)
				retainedFailure = {
					temporary_root: temporaryRoot,
					state_root: stateRoot,
					repository,
					workspace_id: workspaceId,
					operations: retainedOperations(stateRoot),
					cleanup_errors: cleanupErrors,
				};
		} else {
			retainedFailure = {
				temporary_root: temporaryRoot,
				state_root: stateRoot,
				repository,
				workspace_id: workspaceId,
				operations: retainedOperations(stateRoot),
				cleanup_errors: cleanupErrors,
			};
		}
	}
	if (cleanupErrors.length > 0)
		fail(`development smoke cleanup failed: ${cleanupErrors.join("; ")}`);
	if (!completed) fail("development smoke did not complete");
	process.stdout.write(`${canonicalJson(summary)}\n`);
}

main().catch((error) => {
	process.stderr.write(`herdr-conductor development smoke: ${error.message}\n`);
	if (retainedFailure)
		process.stderr.write(
			`retained failed development smoke:\n${JSON.stringify(retainedFailure, null, 2)}\n`,
		);
	process.exitCode = 1;
});

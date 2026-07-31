#!/usr/bin/env node
import { StateKernelError } from "./private-state-schema.mjs";

const CLEAN_STATES = new Set([
	"delivery_provisioning",
	"delivery_waiting_reports",
	"delivery_ready_reconcile",
	"delivery_nonprogressable",
	"delivery_report_rejected",
	"integration_pending_harvest",
	"integration_harvested_no_gates",
	"gate_source_task_provisioning",
	"gate_agent_provisioning",
	"gate_waiting_reports",
	"gate_reports_collected",
	"gate_source_refused",
]);

function fail(message) {
	throw new StateKernelError("bookkeeping_unknown", message);
}

function bool(value, label) {
	if (typeof value !== "boolean") fail(`${label} is not boolean`);
}

function normalizedRole(entry, kind) {
	if (!entry || typeof entry !== "object" || Array.isArray(entry))
		fail(`${kind} role facts are invalid`);
	if (typeof entry.name !== "string" || !entry.name)
		fail(`${kind} role name is invalid`);
	for (const field of ["source", "task", "pane", "agent"])
		bool(entry[field], `${kind}.${entry.name}.${field}`);
	if (entry.task && !entry.source) fail(`${kind} task skips source`);
	if (entry.pane && !entry.task) fail(`${kind} pane skips task`);
	if (entry.agent && !entry.pane) fail(`${kind} agent skips pane`);
	if (entry.report !== null && entry.report !== undefined && !entry.agent)
		fail(`${kind} report skips agent`);
	return {
		...entry,
		report: entry.report ?? null,
		reportRejected: entry.reportRejected ?? false,
		sourceRefused: entry.sourceRefused ?? false,
	};
}

function roles(entries, kind) {
	if (!Array.isArray(entries) || entries.length > 64)
		fail(`${kind} role cardinality is invalid`);
	const result = entries.map((entry) => normalizedRole(entry, kind));
	if (new Set(result.map(({ name }) => name)).size !== result.length)
		fail(`${kind} role names are duplicated`);
	return result;
}

function acceptedDelivery(report) {
	return (
		report?.status === "completed" &&
		report?.result?.kind === "delivery" &&
		report?.result?.verdict === "delivered"
	);
}

export function classifyCleanDelivery(producerFacts) {
	const producers = roles(producerFacts, "producer");
	if (producers.length === 0) return "delivery_ready_reconcile";
	if (producers.some(({ reportRejected }) => reportRejected)) {
		if (
			producers.some(
				({ report, reportRejected }) =>
					report !== null ||
					(reportRejected !== true && reportRejected !== false),
			)
		)
			fail("rejected delivery facts conflict with report authority");
		return "delivery_report_rejected";
	}
	if (producers.some(({ sourceRefused }) => sourceRefused))
		fail("producer source refusal is not a Stage 2 lifecycle state");
	const reportCount = producers.filter(({ report }) => report !== null).length;
	if (reportCount > 0 && producers.some(({ agent }) => !agent))
		fail("producer report precedes the all-agent barrier");
	if (reportCount === 0 && producers.some(({ agent }) => !agent))
		return "delivery_provisioning";
	if (reportCount < producers.length) return "delivery_waiting_reports";
	if (producers.every(({ report }) => acceptedDelivery(report)))
		return "delivery_ready_reconcile";
	return "delivery_nonprogressable";
}

export function classifyCleanGates(gateFacts) {
	const gates = roles(gateFacts, "gate");
	if (gates.length === 0) return "integration_harvested_no_gates";
	if (gates.some(({ sourceRefused }) => sourceRefused))
		return "gate_source_refused";
	const reportCount = gates.filter(({ report }) => report !== null).length;
	if (reportCount > 0 && gates.some(({ agent }) => !agent))
		fail("gate report precedes the all-agent barrier");
	if (gates.some(({ task }) => !task)) {
		if (
			gates.some(({ pane, agent, report }) => pane || agent || report !== null)
		)
			fail("gate pane/report precedes the all-task barrier");
		return "gate_source_task_provisioning";
	}
	if (gates.some(({ agent }) => !agent)) {
		if (reportCount > 0) fail("gate report precedes the all-agent barrier");
		return "gate_agent_provisioning";
	}
	if (reportCount < gates.length) return "gate_waiting_reports";
	return "gate_reports_collected";
}

export function classifyStandDownPrefix(standDown) {
	if (!standDown || typeof standDown !== "object" || Array.isArray(standDown))
		fail("stand-down facts are invalid");
	if (!new Set(["abandoned", "completed"]).has(standDown.outcome))
		fail("stand-down outcome is invalid");
	if (!Array.isArray(standDown.closeSet) || !Array.isArray(standDown.closes))
		fail("stand-down close facts are invalid");
	const ids = standDown.closeSet.map((entry) => entry?.id);
	if (
		ids.some((id) => typeof id !== "string") ||
		new Set(ids).size !== ids.length
	)
		fail("stand-down close set is invalid");
	if (
		standDown.closes.length > ids.length ||
		standDown.closes.some((id, index) => id !== ids[index])
	)
		fail("stand-down closes are not an exact ordered prefix");
	if (standDown.uncertain)
		return Object.freeze({
			state: "stand_down_uncertain",
			closed: standDown.closes.length,
			total: ids.length,
		});
	if (standDown.closes.length === ids.length)
		return Object.freeze({
			state: "stand_down_ready_archive",
			closed: ids.length,
			total: ids.length,
		});
	return Object.freeze({
		state:
			standDown.outcome === "completed"
				? "completed_closing"
				: "abandoned_closing",
		closed: standDown.closes.length,
		total: ids.length,
	});
}

function nextOperations(state) {
	if (state === "archived") return ["status"];
	if (state === "delivery_ready_reconcile")
		return ["integration.reconcile", "run.stand-down.begin"];
	if (state === "integration_pending_harvest")
		return ["integration.harvest", "run.stand-down.begin"];
	if (state === "stand_down_ready_archive") return ["run.archive"];
	if (state === "abandoned_closing" || state === "completed_closing")
		return ["pane.close"];
	if (
		state.endsWith("uncertain") ||
		state === "operation_uncertain" ||
		state === "recovery_required"
	)
		return [];
	if (CLEAN_STATES.has(state)) return ["run.stand-down.begin"];
	return [];
}

function reportsFromRetainedInventory(inventory, configuredRoles) {
	if (!Array.isArray(inventory) || inventory.length > 64)
		fail("retained report inventory is invalid");
	const configured = new Set(configuredRoles.map(({ name }) => name));
	const reports = Object.create(null);
	for (const entry of inventory) {
		if (
			!entry ||
			typeof entry !== "object" ||
			Array.isArray(entry) ||
			!entry.task ||
			!entry.report
		)
			fail("retained task/report entry is invalid");
		const taskRole = entry.task.role?.name;
		const reportRole = entry.report.role?.name;
		if (
			typeof taskRole !== "string" ||
			taskRole !== reportRole ||
			!configured.has(taskRole) ||
			entry.task.task_generation !== entry.report.task_generation ||
			entry.task.task_digest !== entry.report.task_digest
		)
			fail("retained task/report authority is foreign or mismatched");
		if (Object.hasOwn(reports, taskRole))
			fail("retained report authority is duplicated");
		reports[taskRole] = entry.report;
	}
	return reports;
}

function deriveFacts(active, config, options) {
	if (options.facts) return options.facts;
	if (!active?.journal || !config?.roles)
		fail("complete lifecycle facts are required");
	if (options.acceptedReports && options.reportInventory)
		fail("report authority has multiple representations");
	const acceptedReports = options.reportInventory
		? reportsFromRetainedInventory(options.reportInventory, config.roles)
		: (options.acceptedReports ?? {});
	const rejected = new Set(
		active.journal
			.filter(
				(entry) =>
					entry.operation_type === "report.reject" &&
					entry.phase === "observed",
			)
			.map((entry) => entry.subject.id),
	);
	const operation = (type, roleName) =>
		active.journal.some(
			(entry) =>
				entry.operation_type === type &&
				entry.subject.id === roleName &&
				entry.phase === "observed",
		);
	const roleFacts = (entry) => {
		const gate =
			entry.contract_role === "reviewer" || entry.contract_role === "validator";
		return {
			name: entry.name,
			source: operation(
				gate ? "gate-source.create" : "worktree.create",
				entry.name,
			),
			task: operation("task.publish", entry.name),
			pane: operation("pane.create", entry.name),
			agent: operation("agent.start", entry.name),
			report: acceptedReports[entry.name] ?? null,
			reportRejected: !gate && rejected.has(entry.name),
			sourceRefused:
				(gate && rejected.has(entry.name)) ||
				(options.sourceRefused?.includes(entry.name) ?? false),
		};
	};
	const producers = config.roles
		.filter(
			({ contract_role }) =>
				contract_role === "builder" || contract_role === "test_author",
		)
		.map(roleFacts);
	const gates = config.roles
		.filter(
			({ contract_role }) =>
				contract_role === "reviewer" || contract_role === "validator",
		)
		.map(roleFacts);
	const standDownEntry = active.journal.find(
		(entry) =>
			entry.operation_type === "run.stand-down.begin" &&
			entry.phase === "observed",
	);
	let standDown = options.standDown ?? null;
	if (standDownEntry && !standDown) {
		const identity = standDownEntry.observed_identity;
		const closeEntries = active.journal.filter(
			(entry) =>
				entry.operation_type === "pane.close" && entry.phase === "observed",
		);
		const closes = [];
		for (const expected of identity.close_set) {
			const matching = closeEntries.filter(
				(entry) =>
					entry.operation_id === expected.close_operation_id &&
					entry.subject.id === expected.role_name &&
					entry.subject.generation === expected.pane_generation,
			);
			if (matching.length > 1) fail("stand-down close authority is duplicated");
			if (matching.length === 0) break;
			closes.push(expected.close_operation_id);
		}
		if (closes.length !== closeEntries.length)
			fail("stand-down closes are not an exact ordered prefix");
		standDown = {
			outcome: identity.outcome,
			closeSet: identity.close_set.map((entry) => ({
				id: entry.close_operation_id,
			})),
			closes,
			uncertain: false,
		};
	}
	return {
		producers,
		gates,
		reconciliation:
			active.journal.find(
				(entry) =>
					entry.operation_type === "integration.reconcile" &&
					entry.phase === "observed",
			) ?? null,
		integrationHarvest:
			active.journal.find(
				(entry) =>
					entry.operation_type === "integration.harvest" &&
					entry.phase === "observed",
			) ?? null,
		standDown,
		archived: active.state?.status === "archived",
		archiveUncertain: options.archiveUncertain ?? false,
		uncertainty: options.uncertainty ?? null,
	};
}

export function scanStage2Authority(active, config, options = {}) {
	const facts = deriveFacts(active, config, options);
	let state;
	let detail = null;
	if (facts.archived) state = "archived";
	else if (facts.archiveUncertain) state = "archive_uncertain";
	else if (facts.uncertainty) state = facts.uncertainty;
	else if (facts.standDown) {
		detail = classifyStandDownPrefix(facts.standDown);
		state = detail.state;
	} else if (facts.reconciliation) {
		if (
			!facts.reconciliation.observed &&
			facts.reconciliation.phase !== "observed"
		)
			fail("reconciliation is not observed");
		if (!facts.integrationHarvest) state = "integration_pending_harvest";
		else {
			if (
				!facts.integrationHarvest.observed &&
				facts.integrationHarvest.phase !== "observed"
			)
				fail("integration harvest is not observed");
			state = classifyCleanGates(facts.gates ?? []);
		}
	} else {
		if (facts.integrationHarvest)
			fail("integration harvest skips reconciliation");
		if (
			(facts.gates ?? []).some(
				({ source, task, pane, agent, report }) =>
					source || task || pane || agent || report,
			)
		)
			fail("gate authority precedes integration harvest");
		state = classifyCleanDelivery(facts.producers ?? []);
	}
	return Object.freeze({
		state,
		detail,
		legalNextOperations: Object.freeze(nextOperations(state)),
	});
}

export function standDownReasonForState(state, requestedReason) {
	const allowed = {
		report_rejected: new Set(["delivery_report_rejected"]),
		normal_completion: new Set([
			"integration_harvested_no_gates",
			"gate_reports_collected",
		]),
		nonprogressable_delivery: new Set(["delivery_nonprogressable"]),
		source_policy_refusal: new Set(["gate_source_refused"]),
		clean_provisioning_failure: new Set([
			"delivery_provisioning",
			"gate_source_task_provisioning",
			"gate_agent_provisioning",
		]),
		missing_report: new Set([
			"delivery_waiting_reports",
			"gate_waiting_reports",
		]),
		operator_abandoned: CLEAN_STATES,
	};
	if (!allowed[requestedReason]?.has(state))
		fail("stand-down reason does not match lifecycle state");
	return requestedReason;
}

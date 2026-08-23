#!/usr/bin/env node
export const OPERATION_POLICIES = Object.freeze({
	"integration.bind": Object.freeze({
		subjectKind: "git",
		prerequisite: null,
		observedIdentity: "worktree",
	}),
	"worktree.create": Object.freeze({
		subjectKind: "worktree",
		prerequisite: null,
		observedIdentity: "worktree",
	}),
	"task.publish": Object.freeze({
		subjectKind: "task",
		prerequisite: "worktree.create",
		observedIdentity: null,
	}),
	"pane.create": Object.freeze({
		subjectKind: "pane",
		prerequisite: null,
		observedIdentity: "pane-creation",
	}),
	"agent.start": Object.freeze({
		subjectKind: "agent",
		prerequisite: null,
		observedIdentity: "pane",
	}),
	"report.harvest": Object.freeze({
		subjectKind: "report",
		prerequisite: "task.publish",
		observedIdentity: null,
	}),
	"report.reject": Object.freeze({
		subjectKind: "report",
		prerequisite: "task.publish",
		observedIdentity: "report-rejection",
	}),
	"integration.reconcile": Object.freeze({
		subjectKind: "git",
		prerequisite: null,
		observedIdentity: "stage2-integration",
	}),
	"integration.harvest": Object.freeze({
		subjectKind: "git",
		prerequisite: "integration.reconcile",
		observedIdentity: "stage2-integration",
	}),
	"gate-source.create": Object.freeze({
		subjectKind: "snapshot",
		prerequisite: "integration.harvest",
		observedIdentity: "gate-source",
	}),
	"run.stand-down.begin": Object.freeze({
		subjectKind: "run",
		prerequisite: null,
		observedIdentity: "stand-down",
	}),
	"git.merge": Object.freeze({
		subjectKind: "worktree",
		prerequisite: "worktree.create",
		observedIdentity: "merge",
	}),
	"pane.close": Object.freeze({
		subjectKind: "pane",
		prerequisite: "pane.create",
		observedIdentity: null,
	}),
	"run.archive": Object.freeze({
		subjectKind: "run",
		prerequisite: null,
		observedIdentity: null,
	}),
	"apply.preview": Object.freeze({
		subjectKind: "apply",
		prerequisite: "integration.harvest",
		observedIdentity: "stage3-preview",
	}),
	"approval.record": Object.freeze({
		subjectKind: "approval",
		prerequisite: "apply.preview",
		observedIdentity: "stage3-approval",
	}),
	"approval.consume": Object.freeze({
		subjectKind: "approval",
		prerequisite: "approval.record",
		observedIdentity: "stage3-consumption",
	}),
	"apply.publish": Object.freeze({
		subjectKind: "apply",
		prerequisite: "approval.consume",
		observedIdentity: "stage3-apply",
	}),
});

export const OPERATION_TYPES = Object.freeze(Object.keys(OPERATION_POLICIES));
export const RESOURCE_KINDS = Object.freeze([
	...new Set(
		OPERATION_TYPES.map((type) => OPERATION_POLICIES[type].subjectKind),
	),
]);

export function operationPolicy(type) {
	return OPERATION_POLICIES[type] ?? null;
}

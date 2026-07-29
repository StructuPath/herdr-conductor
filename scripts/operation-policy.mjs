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
	"git.merge": Object.freeze({
		subjectKind: "worktree",
		prerequisite: "worktree.create",
		observedIdentity: "merge",
	}),
	"pane.close": Object.freeze({
		subjectKind: "pane",
		prerequisite: "agent.start",
		observedIdentity: null,
	}),
	"run.archive": Object.freeze({
		subjectKind: "run",
		prerequisite: null,
		observedIdentity: null,
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

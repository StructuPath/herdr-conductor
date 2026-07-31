#!/usr/bin/env node

const jsonWrite = (scope) =>
	Object.freeze(
		[
			"before_temp_open",
			"after_temp_write",
			"after_file_fsync",
			"after_publish",
			"after_directory_fsync",
		].map((suffix) => `${scope}.${suffix}`),
	);
const bytePublish = (scope) =>
	Object.freeze(
		[
			"before_open",
			"after_write",
			"after_file_fsync",
			"after_directory_fsync",
		].map((suffix) => `${scope}.${suffix}`),
	);
const guardRemoval = (scope) =>
	Object.freeze(
		["before_remove", "after_remove", "after_directory_fsync"].map(
			(suffix) => `${scope}.${suffix}`,
		),
	);
const unique = (...groups) => Object.freeze([...new Set(groups.flat())]);

export const JOURNALED_OPERATION_CHECKPOINTS = unique(
	jsonWrite("journal_intent"),
	jsonWrite("journal_head"),
	["journal.after_intent_durable"],
	jsonWrite("journal_guard_publish"),
	["journal.after_guard_durable", "journal.after_effect"],
	jsonWrite("journal_result"),
	jsonWrite("journal_result_head"),
	guardRemoval("journal_guard_remove"),
);

export const ARCHIVE_CHECKPOINTS = unique(
	jsonWrite("archive_intent"),
	jsonWrite("archive_intent_head"),
	["archive.after_intent_durable"],
	jsonWrite("archive_guard_publish"),
	["archive.after_guard_durable"],
	jsonWrite("archive_state"),
	[
		"archive.after_state_durable",
		"archive.before_pointer_remove",
		"archive.after_pointer_remove",
		"archive.before_pointer_fsync",
		"archive.after_pointer_fsync",
		"archive.before_result",
	],
	jsonWrite("archive_result"),
	jsonWrite("archive_result_head"),
	guardRemoval("archive_guard_remove"),
);

export const PUBLISHER_CHECKPOINTS = unique(
	bytePublish("publisher_guard"),
	[
		"publisher.before_staging_open",
		"publisher.after_staging_write",
		"publisher.after_staging_fsync",
	],
	bytePublish("publisher_payload"),
	bytePublish("publisher_marker"),
	["publisher.after_staging_unlink", "publisher.after_guard_unlink"],
);

const directoryPublication = Object.freeze([
	"after_directory_create",
	"after_directory_create_fsync",
]);
export const TASK_PUBLICATION_CHECKPOINTS = unique(
	directoryPublication,
	JOURNALED_OPERATION_CHECKPOINTS,
	bytePublish("task_publish"),
);
export const REPORT_HARVEST_CHECKPOINTS = unique(
	directoryPublication,
	JOURNALED_OPERATION_CHECKPOINTS,
	bytePublish("report_accept"),
);
export const REPORT_REJECTION_CHECKPOINTS = JOURNALED_OPERATION_CHECKPOINTS;
export const INTEGRATION_RECONCILE_CHECKPOINTS = unique(
	JOURNALED_OPERATION_CHECKPOINTS,
	[
		"integration.before_cas",
		"integration.after_cas",
		"integration.before_sync",
		"integration.during_sync",
		"integration.before_observed_publication",
	],
);
const INTEGRATION_HARVEST_CHECKPOINTS = JOURNALED_OPERATION_CHECKPOINTS;
const GATE_SOURCE_CHECKPOINTS = JOURNALED_OPERATION_CHECKPOINTS;
export const GATE_TASK_CHECKPOINTS = TASK_PUBLICATION_CHECKPOINTS;
export const PRODUCER_PANE_BARRIER_CHECKPOINTS = Object.freeze([
	"producer.after_pane_observed",
]);
const GATE_PANE_CHECKPOINTS = unique(JOURNALED_OPERATION_CHECKPOINTS, [
	"gate.after_panes_observed",
]);
const GATE_AGENT_CHECKPOINTS = JOURNALED_OPERATION_CHECKPOINTS;
const PANE_CLOSE_CHECKPOINTS = JOURNALED_OPERATION_CHECKPOINTS;
const STAND_DOWN_BEGIN_CHECKPOINTS = JOURNALED_OPERATION_CHECKPOINTS;
const LOCK_ACQUISITION_CHECKPOINTS = Object.freeze([
	"lock.after_mkdir",
	"lock.after_owner_publish",
]);
const RUN_ACTIVATION_CHECKPOINTS = Object.freeze(["run.after_state_durable"]);

export const STAGE2_CHECKPOINT_CATALOG = Object.freeze({
	task_publication: TASK_PUBLICATION_CHECKPOINTS,
	publisher: PUBLISHER_CHECKPOINTS,
	report_harvest: REPORT_HARVEST_CHECKPOINTS,
	report_rejection: REPORT_REJECTION_CHECKPOINTS,
	integration_reconcile: INTEGRATION_RECONCILE_CHECKPOINTS,
	integration_harvest: INTEGRATION_HARVEST_CHECKPOINTS,
	gate_source: GATE_SOURCE_CHECKPOINTS,
	gate_task: GATE_TASK_CHECKPOINTS,
	producer_pane_barrier: PRODUCER_PANE_BARRIER_CHECKPOINTS,
	gate_pane: GATE_PANE_CHECKPOINTS,
	gate_agent: GATE_AGENT_CHECKPOINTS,
	pane_close: PANE_CLOSE_CHECKPOINTS,
	stand_down_begin: STAND_DOWN_BEGIN_CHECKPOINTS,
	archive: ARCHIVE_CHECKPOINTS,
	lock_acquisition: LOCK_ACQUISITION_CHECKPOINTS,
	run_activation: RUN_ACTIVATION_CHECKPOINTS,
});

export const PRODUCTION_LITERAL_CHECKPOINTS = unique(
	...Object.values(STAGE2_CHECKPOINT_CATALOG),
	[
		"after_final_source_read",
		"after_final_target_read",
		"before_cas",
		"after_cas",
		"before_worktree_sync",
		"during_worktree_sync",
		"before_result_publication",
	],
);

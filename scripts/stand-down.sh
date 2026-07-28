#!/usr/bin/env bash
# Legacy action: select the newest global run and close pane IDs recorded in its
# sourced state. No live workspace/session/agent/cwd ownership comparison occurs.
# Do not use this action on persisted or ambiguous state. Branches/worktrees remain.
set -uo pipefail
cd "${HERDR_PLUGIN_ROOT:-$(dirname "$0")/..}" || {
	echo "herdr-conductor: cannot resolve plugin root"
	exit 1
}
. scripts/lib.sh

# conductor_teardown keys off CONDUCTOR_RUN_ID; pin it to the resolved active run.
if ! rd="$(conductor_pin_active_run)"; then
	echo "herdr-conductor: no active conductor run to stand down."
	exit 0
fi
n="$(find "$rd" -name '*.env' 2>/dev/null | wc -l | tr -d ' ')"
conductor_teardown
echo "herdr-conductor: legacy teardown attempted for run ${CONDUCTOR_RUN_ID} (${n} recorded pane(s); branches kept)."

#!/usr/bin/env bash
# Action: stand down the team — close every conductor-owned worker pane for the
# active run (via the transport's own teardown, which closes only panes it
# started and verifies ownership). Git branches and worktrees are kept.
set -uo pipefail
cd "${HERDR_PLUGIN_ROOT:-$(dirname "$0")/..}" || { echo "herdr-conductor: cannot resolve plugin root"; exit 1; }
. scripts/lib.sh

# conductor_teardown keys off CONDUCTOR_RUN_ID; pin it to the resolved active run.
if ! rd="$(conductor_pin_active_run)"; then
  echo "herdr-conductor: no active conductor run to stand down."
  exit 0
fi
n="$(find "$rd" -name '*.env' 2>/dev/null | wc -l | tr -d ' ')"
conductor_teardown
echo "herdr-conductor: stood down run ${CONDUCTOR_RUN_ID} (${n} worker pane(s) closed; branches kept)."

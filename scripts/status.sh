#!/usr/bin/env bash
# Action: one-shot status table for the active run — the board's answer without a
# pane, for when you want the state in a log or over a plain shell.
set -uo pipefail
cd "${HERDR_PLUGIN_ROOT:-$(dirname "$0")/..}" || { echo "herdr-conductor: cannot resolve plugin root"; exit 1; }
. scripts/lib.sh

if ! conductor_pin_active_run >/dev/null; then
  echo "no active conductor workers"
  exit 0
fi
conductor_status

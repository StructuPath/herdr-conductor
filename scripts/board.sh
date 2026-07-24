#!/usr/bin/env bash
# Action: open the Conductor board pane (singleton — `plugin pane open` is not
# idempotent on herdr 0.7.x, so a racing/repeat invoke would stack panes).
set -uo pipefail
cd "${HERDR_PLUGIN_ROOT:-$(dirname "$0")/..}" || { echo "herdr-conductor: cannot resolve plugin root"; exit 1; }
. scripts/lib.sh

# already open? the pane carries the manifest title as its `label` in pane list.
existing="$("$HERDR_BIN_PATH" pane list 2>/dev/null | python3 -c '
import json,sys
try:
    d=json.load(sys.stdin)
    for p in d["result"]["panes"]:
        if p.get("label")=="Conductor Board": print(p["pane_id"]); break
except Exception: pass
' 2>/dev/null)"
if [ -n "$existing" ]; then
  "$HERDR_BIN_PATH" pane focus "$existing" >/dev/null 2>&1 || true
  echo "herdr-conductor: board already open ($existing)"
  exit 0
fi

if ! "$HERDR_BIN_PATH" plugin pane open --plugin structupath.conductor --entrypoint board-pane --placement split >/dev/null 2>&1; then
  echo "herdr-conductor: failed to open the board pane"
  exit 1
fi
echo "herdr-conductor: Conductor board opened."

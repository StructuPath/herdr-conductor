#!/usr/bin/env bash
# lib.sh — herdr-conductor plugin glue over the proven Tier-1 transport.
#
# Sources conductor-lib.sh (the agent-driven transport: start/dispatch/await/
# collect/teardown, proven live on herdr 0.7.5) and adds the plugin-side helpers
# the action + pane scripts need: plugin-root resolution, board-state reads over
# the run registry, and a pane_fatal that keeps a failed pane on screen.
#
# The run registry is conductor-lib's own: $CONDUCTOR_STATE_DIR/run-<id>/<role>.env
# (default CONDUCTOR_STATE_DIR=~/.local/state/herdr-conductor). The board reads it;
# it never writes worker state — the orchestrating agent owns that via the transport.
set -uo pipefail

CONDUCTOR_PLUGIN_ROOT="${HERDR_PLUGIN_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
# shellcheck source=scripts/conductor-lib.sh
. "$CONDUCTOR_PLUGIN_ROOT/scripts/conductor-lib.sh"

# A pane whose process exits immediately closes before the user can read the
# error — that reads as a crash. Hold the message on screen instead.
pane_fatal(){ printf '\n  %s\n\n' "$1" >&2; sleep 600; exit 1; }

pane_require_node(){
  command -v node >/dev/null 2>&1 || pane_fatal "conductor $1: node (>=20) not found on PATH"
}

# Resolve the run id the same way conductor-lib does. Callers may pin
# CONDUCTOR_RUN_ID; otherwise the newest run-* dir is the active run.
conductor_active_run_dir(){
  if [ -n "${CONDUCTOR_RUN_ID:-}" ]; then printf '%s/run-%s' "$CONDUCTOR_STATE_DIR" "$CONDUCTOR_RUN_ID"; return 0; fi
  local newest="" d
  for d in "$CONDUCTOR_STATE_DIR"/run-*; do
    [ -d "$d" ] || continue
    if [ -z "$newest" ] || [ "$d" -nt "$newest" ]; then newest="$d"; fi
  done
  printf '%s' "$newest"
}

# Emit the board as JSON (array of {role,kind,pane,cwd,status}) for the renderer.
# Live status comes from `herdr agent list` (machine-readable) keyed by agent name
# == role — NOT `agent read --source detection`, which returns terminal text.
conductor_board_json(){
  local rd; rd="$(conductor_active_run_dir)"
  if [ -z "$rd" ] || [ ! -d "$rd" ]; then printf '{"run":null,"workers":[]}\n'; return 0; fi
  local agents_json; agents_json="$("$HERDR_BIN_PATH" agent list 2>/dev/null || printf '')"
  ROLE_STATE_DIR="$rd" HERDR_AGENTS="$agents_json" python3 - <<'PY'
import json, os, glob, re
rd = os.environ["ROLE_STATE_DIR"]
# map agent name -> status from `herdr agent list`
status = {}
raw = os.environ.get("HERDR_AGENTS", "")
try:
    d = json.loads(raw)
    for a in d.get("result", {}).get("agents", d.get("agents", [])) or []:
        n = a.get("name") or a.get("agent")
        if n: status[n] = a.get("agent_status", "unknown")
except Exception:
    pass
def envval(text, key):
    m = re.search(r'(?m)^%s=(.*)$' % re.escape(key), text)
    return m.group(1) if m else ""
workers = []
for sf in sorted(glob.glob(os.path.join(rd, "*.env"))):
    t = open(sf).read()
    role = envval(t, "ROLE") or os.path.basename(sf)[:-4]
    workers.append({
        "role": role,
        "kind": envval(t, "KIND"),
        "pane": envval(t, "PANE"),
        "cwd": envval(t, "CWD"),
        "status": status.get(role, "unknown"),
    })
print(json.dumps({"run": os.path.basename(rd), "workers": workers}))
PY
}

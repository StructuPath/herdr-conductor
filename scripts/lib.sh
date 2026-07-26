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

# The target repo is resolved by the transport's conductor_repo_root (which reads
# HERDR_PLUGIN_CONTEXT_JSON.workspace_cwd and never trusts ambient cwd) — actions
# below call it directly rather than keeping a second copy here.

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

# Pin CONDUCTOR_RUN_ID to the active run, so the transport's run-scoped helpers
# (teardown, reconcile, status) act on it rather than on this process's own $$.
# Prints the run dir; returns 1 when there is no active run.
conductor_pin_active_run(){
  local rd; rd="$(conductor_active_run_dir)"
  [ -n "$rd" ] && [ -d "$rd" ] || return 1
  CONDUCTOR_RUN_ID="${CONDUCTOR_RUN_ID:-${rd##*/run-}}"
  export CONDUCTOR_RUN_ID
  printf '%s\n' "$rd"
}

# Emit the board as JSON (array of {role,kind,pane,cwd,status}) for the renderer.
# Live status comes from the transport's _c_agent_status_map (`herdr agent list`) —
# one parser, shared with conductor_status, so the two can't drift.
conductor_board_json(){
  local rd; rd="$(conductor_active_run_dir)"
  if [ -z "$rd" ] || [ ! -d "$rd" ]; then printf '{"run":null,"workers":[]}\n'; return 0; fi
  ROLE_STATE_DIR="$rd" CONDUCTOR_STATUS_MAP="$(_c_agent_status_map)" python3 - <<'PY'
import json, os, glob, re
rd = os.environ["ROLE_STATE_DIR"]
# agent name -> status, as "<name>\t<status>" lines from _c_agent_status_map
status = {}
for line in os.environ.get("CONDUCTOR_STATUS_MAP", "").splitlines():
    if "\t" in line:
        n, s = line.split("\t", 1)
        status[n] = s
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

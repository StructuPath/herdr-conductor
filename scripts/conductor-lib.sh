#!/usr/bin/env bash
# conductor-lib.sh — Herdr transport for feature-delivery-team.
#
# An orchestrating agent sources this and drives worker agents as visible Herdr
# panes: split -> agent start (readiness-polled) -> pointer-prompt -> settle via
# the report sentinel (NOT agent state) -> teardown. Every design choice here was
# proven live on herdr 0.7.5; see docs/spikes/2026-07-23-herdr-conductor/RESULTS.md.
#
# Contract (bash 3.2 compatible — no associative arrays; state lives in files):
#   conductor_start_worker <role> <kind> <cwd> [--warm] [-- <agent argv...>]
#   conductor_dispatch      <role> <task-file>
#   conductor_await         <role> [first_turn_ms]
#   conductor_collect       <role>          # prints report on success; hard-fails otherwise
#   conductor_teardown                      # closes conductor-owned panes only
#
# Env:
#   HERDR_BIN_PATH        herdr binary (default: herdr on PATH)
#   CONDUCTOR_STATE_DIR   run registry (default: ~/.local/state/herdr-conductor)
#   CONDUCTOR_ANCHOR_PANE pane to split from (default: focused pane)
#   CONDUCTOR_DRY_RUN=1   print the herdr commands instead of running them
set -uo pipefail

CONDUCTOR_MIN_HERDR="0.7.5"
CONDUCTOR_SENTINEL="<!-- REPORT-COMPLETE -->"
: "${HERDR_BIN_PATH:=herdr}"
: "${CONDUCTOR_STATE_DIR:=${HOME}/.local/state/herdr-conductor}"
: "${CONDUCTOR_DRY_RUN:=0}"

_c_die(){ printf 'conductor: %s\n' "$1" >&2; return 1; }
_c_slug_ok(){ printf '%s' "$1" | grep -Eq '^[a-z][a-z0-9_-]{0,31}$'; }
# portable mtime (epoch secs). BSD `stat -f %m` and GNU `stat -c %Y` differ, and
# GNU's `-f` means --file-system (emits garbage, not an error) — so shell fall-through
# is unsafe. python3 is already a hard dependency here; use it.
_c_mtime(){ python3 -c 'import os,sys;print(int(os.path.getmtime(sys.argv[1])))' "$1" 2>/dev/null || echo 0; }

# herdr invocation seam — every call goes through here (dry-run + single choke point).
# Dry-run logs to stderr so the audit is visible even when a caller captures stdout
# via command substitution (e.g. parsing the pane id out of `pane split`).
_c_herdr(){
  if [ "$CONDUCTOR_DRY_RUN" = 1 ]; then { printf 'DRYRUN: %s' "$HERDR_BIN_PATH"; printf ' %q' "$@"; printf '\n'; } >&2; return 0; fi
  "$HERDR_BIN_PATH" "$@"
}

_c_version_gate(){
  [ "$CONDUCTOR_DRY_RUN" = 1 ] && return 0
  command -v "$HERDR_BIN_PATH" >/dev/null 2>&1 || { _c_die "herdr not found (set HERDR_BIN_PATH)"; return 1; }
  local v; v="$("$HERDR_BIN_PATH" --version 2>/dev/null | grep -Eo '[0-9]+\.[0-9]+\.[0-9]+' | head -1)"
  [ -n "$v" ] || { _c_die "cannot read herdr version"; return 1; }
  # numeric compare vs min (0.7.5): fail if lower
  local IFS=.; set -- $v; local a=$1 b=$2 c=$3; set -- $CONDUCTOR_MIN_HERDR; local x=$1 y=$2 z=$3
  if [ "$a" -lt "$x" ] || { [ "$a" -eq "$x" ] && [ "$b" -lt "$y" ]; } || { [ "$a" -eq "$x" ] && [ "$b" -eq "$y" ] && [ "$c" -lt "$z" ]; }; then
    _c_die "herdr $v < required $CONDUCTOR_MIN_HERDR"; return 1
  fi
  return 0
}

_c_run_dir(){ printf '%s/run-%s' "$CONDUCTOR_STATE_DIR" "${CONDUCTOR_RUN_ID:=$$}"; }
_c_role_state(){ printf '%s/%s.env' "$(_c_run_dir)" "$1"; }

# --- lifecycle ---------------------------------------------------------------

conductor_start_worker(){
  _c_version_gate || return 1
  local role="$1" kind="$2" cwd="$3"; shift 3
  # warm by default: a cold interactive agent (fresh claude/codex in a new dir) shows a
  # welcome/trust screen and drops the first prompt into the void (dogfood finding). A
  # throwaway warm-up prompt clears it. Use --no-warm only when you own a >=180s first turn.
  local warm=1 argv=""
  while [ $# -gt 0 ]; do case "$1" in
    --warm) warm=1; shift;;
    --no-warm) warm=0; shift;;
    --) shift; argv="$*"; break;;
    *) _c_die "unknown flag: $1"; return 1;;
  esac; done
  _c_slug_ok "$role" || { _c_die "role '$role' is not a valid agent name ([a-z][a-z0-9_-]{0,31})"; return 1; }
  [ -d "$cwd" ] || { _c_die "cwd does not exist: $cwd"; return 1; }
  mkdir -p "$(_c_run_dir)" "$cwd/.conductor"
  # never let a worker commit ephemeral transport state (dogfood finding: a builder
  # committed .conductor/task.md). Self-contained ignore, independent of the repo's rules.
  [ -f "$cwd/.conductor/.gitignore" ] || printf '*\n' > "$cwd/.conductor/.gitignore"

  local anchor="${CONDUCTOR_ANCHOR_PANE:-}"
  if [ -z "$anchor" ] && [ "$CONDUCTOR_DRY_RUN" != 1 ]; then
    anchor="$("$HERDR_BIN_PATH" pane list 2>/dev/null | python3 -c 'import json,sys;
d=json.load(sys.stdin);p=[x for x in d["result"]["panes"] if x.get("focused")];print(p[0]["pane_id"] if p else "")' 2>/dev/null)"
    [ -n "$anchor" ] || { _c_die "no anchor pane (set CONDUCTOR_ANCHOR_PANE)"; return 1; }
  fi
  : "${anchor:=DRYPANE}"

  local split pane out t=0
  if [ "$CONDUCTOR_DRY_RUN" = 1 ]; then
    # audit both calls (to stderr, via _c_herdr) without capturing them
    _c_herdr pane split "$anchor" --direction right --cwd "$cwd" --no-focus
    pane="DRYPANE"
    _c_herdr agent start "$role" --kind "$kind" --pane "$pane" --timeout 60000 ${argv:+-- $argv}
  else
    split="$(_c_herdr pane split "$anchor" --direction right --cwd "$cwd" --no-focus 2>&1)"
    pane="$(printf '%s' "$split" | python3 -c 'import json,sys;
try: print(json.load(sys.stdin)["result"]["pane"]["pane_id"])
except Exception: print("")' 2>/dev/null)"
    [ -n "$pane" ] || { _c_die "pane split failed: $split"; return 1; }
    # readiness poll: a fresh split is not a startable shell for ~1-2s (agent_pane_busy)
    for t in $(seq 1 25); do
      out="$(_c_herdr agent start "$role" --kind "$kind" --pane "$pane" --timeout 60000 ${argv:+-- $argv} 2>&1)"
      printf '%s' "$out" | grep -q 'agent_pane_busy' && { sleep 1; continue; }
      break
    done
    if printf '%s' "$out" | grep -q '"error"'; then
      _c_herdr pane close "$pane" >/dev/null 2>&1
      _c_die "agent start failed for '$role' after $t tries: $out"; return 1
    fi
  fi

  { echo "ROLE=$role"; echo "KIND=$kind"; echo "CWD=$cwd"; echo "PANE=$pane"; echo "DISPATCH_TS=0"; } > "$(_c_role_state "$role")"

  # cold first turn is slow/flaky (codex/pi): warm with a throwaway prompt so the
  # real dispatch runs warm. Optional — callers with a >=180s first-turn window can skip.
  if [ "$warm" = 1 ] && [ "$CONDUCTOR_DRY_RUN" != 1 ]; then
    _c_herdr agent prompt "$role" "Reply 'ready' and wait for your task." >/dev/null 2>&1
    _c_herdr agent wait "$role" --until idle --until done --timeout 60000 >/dev/null 2>&1
  fi
  printf '%s\n' "$pane"
}

conductor_dispatch(){
  local role="$1" taskfile="$2"
  local sf; sf="$(_c_role_state "$role")"
  [ -f "$sf" ] || { _c_die "no such worker: $role"; return 1; }
  [ -f "$taskfile" ] || { _c_die "task file not found: $taskfile"; return 1; }
  # shellcheck disable=SC1090
  . "$sf"
  cp "$taskfile" "$CWD/.conductor/task.md"
  # archive any prior report so a stale one can never read as fresh (KTD-2)
  [ -f "$CWD/.conductor/report.md" ] && mv "$CWD/.conductor/report.md" "$CWD/.conductor/report.prev.md"
  local ts; ts="$(date +%s)"
  sed "s/^DISPATCH_TS=.*/DISPATCH_TS=$ts/" "$sf" > "$sf.tmp" && mv "$sf.tmp" "$sf"
  _c_herdr agent prompt "$role" "Re-read .conductor/task.md in your cwd and execute it exactly. End your report with the line: $CONDUCTOR_SENTINEL" >/dev/null
}

# completion is the report sentinel, NOT agent state. working-gate is advisory.
conductor_await(){
  local role="$1" first_ms="${2:-180000}"
  local sf; sf="$(_c_role_state "$role")"; [ -f "$sf" ] || { _c_die "no such worker: $role"; return 1; }
  # shellcheck disable=SC1090
  . "$sf"
  [ "$CONDUCTOR_DRY_RUN" = 1 ] && { echo "DRYRUN: await $role"; return 0; }
  local report="$CWD/.conductor/report.md"

  _c_settle(){ # $1=timeout_ms -> 0 if fresh complete report appears
    _c_herdr agent wait "$role" --until working --timeout 20000 >/dev/null 2>&1  # advisory: ignore miss
    local budget=$(( ${1} / 3000 )); [ "$budget" -lt 1 ] && budget=1
    local i
    for i in $(seq 1 "$budget"); do
      if [ -f "$report" ] && grep -q "$CONDUCTOR_SENTINEL" "$report"; then
        local m; m="$(_c_mtime "$report")"
        [ "$m" -ge "$DISPATCH_TS" ] && return 0
      fi
      sleep 3
    done
    return 1
  }

  if _c_settle "$first_ms"; then return 0; fi
  # settle-without-report: one re-prompt, then escalate (KTD-4)
  _c_herdr agent prompt "$role" "Finish the task in .conductor/task.md and write .conductor/report.md ending with $CONDUCTOR_SENTINEL" >/dev/null 2>&1
  if _c_settle 120000; then return 0; fi
  _c_die "worker '$role' settled without a complete report after re-prompt — escalate to human"; return 2
}

conductor_collect(){
  local role="$1"
  local sf; sf="$(_c_role_state "$role")"; [ -f "$sf" ] || { _c_die "no such worker: $role"; return 1; }
  # shellcheck disable=SC1090
  . "$sf"
  [ "$CONDUCTOR_DRY_RUN" = 1 ] && { echo "DRYRUN: collect $role"; return 0; }
  local report="$CWD/.conductor/report.md"
  [ -f "$report" ] || { _c_die "collect('$role'): report.md absent"; return 1; }
  [ -s "$report" ] || { _c_die "collect('$role'): report.md empty"; return 1; }
  grep -q "$CONDUCTOR_SENTINEL" "$report" || { _c_die "collect('$role'): report.md missing sentinel"; return 1; }
  local m; m="$(_c_mtime "$report")"
  [ "$m" -ge "$DISPATCH_TS" ] || { _c_die "collect('$role'): report.md is stale (mtime<dispatch) — refusing stale result"; return 1; }
  cat "$report"
}

# --- status ------------------------------------------------------------------

# conductor_status: report the active conductor workers for the current run.
# No args. Reads each <role>.env in the run dir and pairs it with the worker's
# live agent_status (herdr agent read, via the _c_herdr seam so dry-run honored).
conductor_status(){
  local rd; rd="$(_c_run_dir)"
  local sf found=0
  # bash 3.2 has no nullglob: an empty run dir yields the literal glob, so probe.
  for sf in "$rd"/*.env; do [ -f "$sf" ] && { found=1; break; }; done
  if [ ! -d "$rd" ] || [ "$found" = 0 ]; then
    echo "no active conductor workers"; return 0
  fi
  printf '%-16s  %-8s  %-14s  %-10s  %s\n' ROLE KIND PANE STATUS CWD
  local status
  for sf in "$rd"/*.env; do
    [ -f "$sf" ] || continue
    ROLE=""; KIND=""; PANE=""; CWD=""
    # shellcheck disable=SC1090
    . "$sf"
    if [ "$CONDUCTOR_DRY_RUN" = 1 ]; then
      _c_herdr agent read "$ROLE" --source detection   # audit to stderr only
      status="dry"
    else
      status="$(_c_herdr agent read "$ROLE" --source detection 2>/dev/null | python3 -c 'import json,sys;
try: print(json.load(sys.stdin)["result"]["agent_status"] or "unknown")
except Exception: print("unknown")' 2>/dev/null)"
      [ -n "$status" ] || status="unknown"
    fi
    printf '%-16s  %-8s  %-14s  %-10s  %s\n' "$ROLE" "$KIND" "$PANE" "$status" "$CWD"
  done
}

conductor_teardown(){
  local rd; rd="$(_c_run_dir)"; [ -d "$rd" ] || return 0
  local sf role pane
  for sf in "$rd"/*.env; do
    [ -f "$sf" ] || continue
    role=""; pane=""; . "$sf"
    [ -n "${PANE:-}" ] && _c_herdr pane close "$PANE" >/dev/null 2>&1  # only panes we started
    rm -f "$sf"
  done
  rmdir "$rd" 2>/dev/null || true
}

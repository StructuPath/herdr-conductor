#!/usr/bin/env bash
# conductor-lib.sh — Herdr transport for feature-delivery-team.
#
# An orchestrating agent sources this and drives worker agents as visible Herdr
# panes: split -> agent start (readiness-polled) -> pointer-prompt -> settle via
# the report sentinel (NOT agent state) -> teardown. Unit and dry-run tests cover
# the current transport, but the complete Tier-2 lifecycle has no retained live
# certification artifact. See README.md before using lifecycle mutators.
#
# Canonical copy lives in StructuPath/herdr-conductor; pi-library's
# feature-delivery-team skill vendors a byte-identical duplicate. Edit here, then
# re-vendor — never the other way around.
#
# Contract (bash 3.2 compatible — no associative arrays; state lives in files):
#
#   Tier 1 — the loop (one worker at a time, caller owns the choreography):
#     conductor_start_worker <role> <kind> <cwd> [--warm] [-- <agent argv...>]
#     conductor_dispatch      <role> <task-file>
#     conductor_await         <role> [first_turn_ms]
#     conductor_collect       <role>        # prints report on success; hard-fails otherwise
#     conductor_status                      # one row per worker + live state
#     conductor_teardown                    # legacy: closes recorded pane IDs without live identity checks
#
#   Tier 2 — the team (declare it once in .herdr-conductor.json):
#     conductor_config_load  [config-file]  # validate + normalize; prints JSON
#     conductor_assemble     [config-file]  # worktrees + guard drops + every worker
#     conductor_render_role  <role> [contract-file]   # role template -> task file
#     conductor_reconcile    [--into <dir>] # merge writer branches (KTD-7)
#     conductor_repo_root                   # the workspace's repo, never ambient cwd
#     conductor_worktree     <role> <base-branch> <worktree-root> [branch]
#     conductor_guard_drop   <cwd>          # herdr-guard audit override
#
# Env:
#   HERDR_BIN_PATH        herdr binary (default: herdr on PATH)
#   CONDUCTOR_STATE_DIR   run registry (default: ~/.local/state/herdr-conductor)
#   CONDUCTOR_ANCHOR_PANE pane to split from (default: focused pane)
#   CONDUCTOR_DRY_RUN=1   skip Herdr/Git mutations; still writes run/.conductor state
#   CONDUCTOR_REPO        pin the target repo (default: workspace cwd, then $PWD)
#   CONDUCTOR_ROLES_DIR   role templates (default: <lib>/../roles)
#   CONDUCTOR_MISSION     text substituted into {{MISSION}} when rendering a role
set -uo pipefail

CONDUCTOR_MIN_HERDR="0.7.5"
CONDUCTOR_SENTINEL="<!-- REPORT-COMPLETE -->"
CONDUCTOR_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
: "${HERDR_BIN_PATH:=herdr}"
: "${CONDUCTOR_STATE_DIR:=${HOME}/.local/state/herdr-conductor}"
: "${CONDUCTOR_DRY_RUN:=0}"
: "${CONDUCTOR_CONFIG_NAME:=.herdr-conductor.json}"
: "${CONDUCTOR_ROLES_DIR:=${CONDUCTOR_LIB_DIR}/../roles}"

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
  local IFS=. a b c x y z
  read -r a b c <<< "$v"
  read -r x y z <<< "$CONDUCTOR_MIN_HERDR"
  if [ "$a" -lt "$x" ] || { [ "$a" -eq "$x" ] && [ "$b" -lt "$y" ]; } || { [ "$a" -eq "$x" ] && [ "$b" -eq "$y" ] && [ "$c" -lt "$z" ]; }; then
    _c_die "herdr $v < required $CONDUCTOR_MIN_HERDR"; return 1
  fi
  return 0
}

_c_run_dir(){ printf '%s/run-%s' "$CONDUCTOR_STATE_DIR" "${CONDUCTOR_RUN_ID:=$$}"; }
_c_role_state(){ printf '%s/%s.env' "$(_c_run_dir)" "$1"; }
_c_team_json(){ printf '%s/team.json' "$(_c_run_dir)"; }
_c_tab(){ printf '\t'; }

# name -> agent_status, from `herdr agent list`.
# NOT `agent read --source detection`: that returns the pane's rendered TEXT, so on
# a cold pane it hands back welcome-screen art and every status parses as unknown
# (2026-07-23 dogfood, finding 4). `agent list` is the machine-readable surface.
_c_agent_status_map(){
  _c_herdr agent list 2>/dev/null | python3 -c 'import json,sys
try: d = json.load(sys.stdin)
except Exception: sys.exit(0)
res = d.get("result", d) if isinstance(d, dict) else {}
for a in (res.get("agents") or []):
    n = a.get("name") or a.get("agent")
    if n: print("%s\t%s" % (n, a.get("agent_status") or "unknown"))' 2>/dev/null
}

_c_status_of(){ # $1=role, $2=map text
  printf '%s\n' "$2" | awk -F'\t' -v r="$1" '$1==r{print $2; found=1} END{if(!found) print "unknown"}'
}

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
    _c_herdr agent wait "$role" --until idle --until "done" --timeout 60000 >/dev/null 2>&1
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
    local _
    for _ in $(seq 1 "$budget"); do
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
# live agent_status from `herdr agent list` (see _c_agent_status_map).
conductor_status(){
  local rd; rd="$(_c_run_dir)"
  local sf found=0
  # bash 3.2 has no nullglob: an empty run dir yields the literal glob, so probe.
  for sf in "$rd"/*.env; do [ -f "$sf" ] && { found=1; break; }; done
  if [ ! -d "$rd" ] || [ "$found" = 0 ]; then
    echo "no active conductor workers"; return 0
  fi
  local map; map="$(_c_agent_status_map)"
  printf '%-16s  %-8s  %-14s  %-10s  %s\n' ROLE KIND PANE STATUS CWD
  for sf in "$rd"/*.env; do
    [ -f "$sf" ] || continue
    ROLE=""; KIND=""; PANE=""; CWD=""
    # shellcheck disable=SC1090
    . "$sf"
    printf '%-16s  %-8s  %-14s  %-10s  %s\n' "$ROLE" "$KIND" "$PANE" "$(_c_status_of "$ROLE" "$map")" "$CWD"
  done
}

# --- the team (Tier 2) ---------------------------------------------------------

# conductor_repo_root: the workspace's repo, resolved WITHOUT trusting cwd.
# A pane or plugin action inherits whatever cwd the herdr server happened to have,
# so a bare `git` here silently targets some other repository — herdr-swarm shipped
# that exact bug once. herdr hands each invocation its workspace in
# HERDR_PLUGIN_CONTEXT_JSON (workspace_cwd); $PWD stands in only as a last resort.
# Fails loudly rather than degrading to "whatever repo is nearby".
conductor_repo_root(){
  local dir="${CONDUCTOR_REPO:-}" top
  if [ -z "$dir" ] && [ -n "${HERDR_PLUGIN_CONTEXT_JSON:-}" ]; then
    dir="$(printf '%s' "$HERDR_PLUGIN_CONTEXT_JSON" | python3 -c 'import json,sys
try: v = json.load(sys.stdin).get("workspace_cwd")
except Exception: v = None
print(v if isinstance(v, str) else "")' 2>/dev/null)"
  fi
  [ -n "$dir" ] || dir="$PWD"
  top="$(git -C "$dir" rev-parse --show-toplevel 2>/dev/null)" || {
    _c_die "$dir is not a git repository — run the conductor from a repo workspace"; return 1; }
  printf '%s\n' "$top"
}

# dry runs are audited off a real repo when there is one, $PWD when there is not.
_c_repo_or_pwd(){
  local r
  if r="$(conductor_repo_root 2>/dev/null)"; then printf '%s\n' "$r"; return 0; fi
  if [ "$CONDUCTOR_DRY_RUN" = 1 ]; then printf '%s\n' "${CONDUCTOR_REPO:-$PWD}"; return 0; fi
  conductor_repo_root   # re-run for its error message
}

_c_cfg_get(){ printf '%s' "$1" | python3 -c 'import json,sys;print(json.load(sys.stdin)[sys.argv[1]])' "$2" 2>/dev/null; }

# keep conductor artifacts out of `git status` without touching the repo's .gitignore
_c_git_exclude(){
  local repo="$1" pattern="$2" p
  p="$(git -C "$repo" rev-parse --git-path info/exclude 2>/dev/null)" || return 0
  case "$p" in /*) ;; *) p="$repo/$p";; esac
  mkdir -p "$(dirname "$p")" 2>/dev/null
  grep -qxF "$pattern" "$p" 2>/dev/null || printf '%s\n' "$pattern" >> "$p"
}

# conductor_config_load [path] — validate and normalize .herdr-conductor.json.
# Prints normalized JSON on stdout; every defect is a hard error with the offending
# role named, because a half-valid team assembles half a team and that is worse.
conductor_config_load(){
  local path="${1:-}"
  if [ -z "$path" ]; then
    local repo; repo="$(conductor_repo_root)" || return 1
    path="$repo/$CONDUCTOR_CONFIG_NAME"
  fi
  [ -f "$path" ] || { _c_die "team config not found: $path"; return 1; }
  CONDUCTOR_CONFIG_PATH="$path" python3 - <<'PY'
import json, os, re, sys
path = os.environ["CONDUCTOR_CONFIG_PATH"]
def die(m):
    sys.stderr.write("conductor: %s\n" % m); sys.exit(1)
try:
    cfg = json.load(open(path))
except Exception as e:
    die("team config is not valid JSON (%s): %s" % (path, e))
if not isinstance(cfg, dict):
    die("team config must be a JSON object: %s" % path)
if cfg.get("version") != 1:
    die("team config 'version' must be 1 (got %r)" % (cfg.get("version"),))
roles = cfg.get("roles")
if not isinstance(roles, list) or not roles:
    die("team config needs a non-empty 'roles' array")
MODES = ("write", "gated", "read-only")
SLUG = re.compile(r"^[a-z][a-z0-9_-]{0,31}$")   # mirrors _c_slug_ok — agent names
out = {
    "team": cfg.get("team") or "feature-delivery",
    "base_branch": cfg.get("base_branch") or "main",
    "worktree_root": cfg.get("worktree_root") or ".conductor-worktrees",
    "roles": [],
}
seen = set()
for i, r in enumerate(roles):
    if not isinstance(r, dict):
        die("roles[%d] must be an object" % i)
    name = r.get("name") or ""
    if not SLUG.match(name):
        die("roles[%d]: name %r is not a valid agent name ([a-z][a-z0-9_-]{0,31})" % (i, name))
    if name in seen:
        die("duplicate role name: %s" % name)
    seen.add(name)
    if not r.get("kind"):
        die("role '%s': 'kind' is required (claude|codex|pi|gemini|cursor)" % name)
    mode = r.get("mode") or "write"
    if mode not in MODES:
        die("role '%s': mode %r must be one of %s" % (name, mode, "|".join(MODES)))
    args = r.get("launch_args", [])
    if not isinstance(args, list) or any(not isinstance(a, str) for a in args):
        die("role '%s': 'launch_args' must be an array of strings" % name)
    out["roles"].append({
        "name": name,
        "kind": r["kind"],
        "mode": mode,
        "template": r.get("template") or name,
        "owns": r.get("owns") or "",
        "must_not_own": r.get("must_not_own") or "",
        "branch": r.get("branch") or ("conductor/" + name),
        "launch_args": args,
        # `write` and `gated` roles get an isolated worktree; `gated` and
        # `read-only` roles get the guard audit drop. See the mode table in README.
        "worktree": mode in ("write", "gated"),
        "guard": mode in ("gated", "read-only"),
    })
print(json.dumps(out))
PY
}

# conductor_worktree <role> <base-branch> <worktree-root> [branch]
# Creates (or reuses) the role's git worktree and prints its path. Reuse is
# deliberate: re-assembling a team after a crash must land the worker back in the
# tree its half-finished work is in, not a fresh one.
conductor_worktree(){
  local role="${1:-}" base="${2:-}" wtroot="${3:-}" branch="${4:-conductor/${1:-}}"
  _c_slug_ok "$role" || { _c_die "role '$role' is not a valid agent name"; return 1; }
  [ -n "$base" ] && [ -n "$wtroot" ] || { _c_die "conductor_worktree needs <role> <base-branch> <worktree-root>"; return 1; }
  local repo; repo="$(_c_repo_or_pwd)" || return 1
  local rel=""
  case "$wtroot" in /*) ;; *) rel="${wtroot%/}/"; wtroot="$repo/$wtroot";; esac
  local wt="$wtroot/$role"
  if [ "$CONDUCTOR_DRY_RUN" = 1 ]; then
    # A dry run must not touch the filesystem, so the worktree is audited but not
    # created — and an uncreated path would trip start_worker's cwd check. Report
    # the intended target, hand back the repo root as the stand-in cwd.
    printf 'DRYRUN: git -C %q worktree add -b %q %q %q\n' "$repo" "$branch" "$wt" "$base" >&2
    printf 'DRYRUN: (not created; worker cwd falls back to %q)\n' "$repo" >&2
    printf '%s\n' "$repo"; return 0
  fi
  # Excluding here, not in the caller: whatever creates the artifact owns keeping it
  # out of `git status`. An in-repo worktree root would otherwise show up untracked.
  [ -n "$rel" ] && _c_git_exclude "$repo" "$rel"
  [ -d "$wt" ] && { printf '%s\n' "$wt"; return 0; }
  mkdir -p "$wtroot" || { _c_die "cannot create the worktree root: $wtroot"; return 1; }
  local out
  if git -C "$repo" show-ref --verify --quiet "refs/heads/$branch"; then
    out="$(git -C "$repo" worktree add "$wt" "$branch" 2>&1)"
  else
    out="$(git -C "$repo" worktree add -b "$branch" "$wt" "$base" 2>&1)"
  fi
  [ -d "$wt" ] || { _c_die "worktree add failed for '$role': $out"; return 1; }
  printf '%s\n' "$wt"
}

# conductor_guard_drop <cwd> — herdr-guard project override for a review role.
# Prints the path it wrote, nothing if a policy was already there.
#
# Guard's project-override contract (herdr-guard docs/SPEC.md): the file lives at
# <workspace cwd>/.herdr-guard.json, may add SUBSTRING rules only, and may raise
# severity to `alert` at most. So this is an AUDIT layer, not a sandbox — guard
# sees rendered pane text and cannot stop a write. The launch flags on the worker
# (`--sandbox read-only` and friends) are the actual enforcement; this is the trail.
conductor_guard_drop(){
  local cwd="${1:-}"
  [ -d "$cwd" ] || { _c_die "guard drop: cwd does not exist: $cwd"; return 1; }
  local f="$cwd/.herdr-guard.json"
  if [ "$CONDUCTOR_DRY_RUN" = 1 ]; then printf 'DRYRUN: write %q\n' "$f" >&2; return 0; fi
  [ -f "$f" ] && return 0    # never clobber a repo's own guard policy
  # a read-only role's cwd is the repo itself, so keep our drop out of git status
  git -C "$cwd" rev-parse --show-toplevel >/dev/null 2>&1 && _c_git_exclude "$cwd" ".herdr-guard.json"
  cat > "$f" <<'JSON'
{
  "version": 1,
  "rules": [
    { "id": "conductor-review-commit", "severity": "alert", "match": "substring",
      "pattern": "git commit", "reason": "review role attempted a commit" },
    { "id": "conductor-review-push", "severity": "alert", "match": "substring",
      "pattern": "git push", "reason": "review role attempted a push" },
    { "id": "conductor-review-merge", "severity": "alert", "match": "substring",
      "pattern": "git merge", "reason": "review role attempted a merge" },
    { "id": "conductor-review-rebase", "severity": "alert", "match": "substring",
      "pattern": "git rebase", "reason": "review role attempted a rebase" },
    { "id": "conductor-review-reset", "severity": "alert", "match": "substring",
      "pattern": "git reset", "reason": "review role attempted a reset" },
    { "id": "conductor-review-checkout", "severity": "alert", "match": "substring",
      "pattern": "git checkout -", "reason": "review role attempted a branch switch" }
  ]
}
JSON
  printf '%s\n' "$f"
}

# conductor_assemble [config] — the whole team from one declaration.
# Per role: worktree (write/gated) -> guard drop (gated/read-only) -> start_worker
# with the role's kind and launch flags. Partial failure is reported per role and
# returns non-zero; the workers that did come up are left running and registered,
# so a retry re-uses them rather than orphaning panes.
conductor_assemble(){
  _c_version_gate || return 1
  local norm; norm="$(conductor_config_load "${1:-}")" || return 1
  mkdir -p "$(_c_run_dir)"
  printf '%s\n' "$norm" > "$(_c_team_json)"

  local repo; repo="$(_c_repo_or_pwd)" || return 1
  local base wtroot
  base="$(_c_cfg_get "$norm" base_branch)"
  wtroot="$(_c_cfg_get "$norm" worktree_root)"
  # conductor_worktree / conductor_guard_drop each exclude what they create.

  local roster; roster="$(_c_run_dir)/roster.tsv"
  printf '%s' "$norm" | python3 -c 'import json,sys
for r in json.load(sys.stdin)["roles"]:
    print("\t".join([r["name"], r["kind"], r["mode"], r["branch"],
                     "1" if r["worktree"] else "0", "1" if r["guard"] else "0",
                     " ".join(r["launch_args"])]))' > "$roster" || {
    _c_die "cannot expand the team roles"; return 1; }

  printf '%-16s  %-8s  %-10s  %s\n' ROLE KIND MODE CWD
  local name kind mode branch wants_wt wants_guard args cwd gf rc=0
  while IFS="$(_c_tab)" read -r name kind mode branch wants_wt wants_guard args; do
    [ -n "$name" ] || continue
    if [ "$wants_wt" = 1 ]; then
      cwd="$(conductor_worktree "$name" "$base" "$wtroot" "$branch")" || { rc=1; continue; }
    else
      cwd="$repo"
    fi
    gf=""
    [ "$wants_guard" = 1 ] && gf="$(conductor_guard_drop "$cwd")"
    # launch_args are flags (`--sandbox read-only`); word splitting is the point.
    # shellcheck disable=SC2086
    if conductor_start_worker "$name" "$kind" "$cwd" ${args:+-- $args} >/dev/null; then
      [ -n "$gf" ] && echo "GUARD_FILE=$gf" >> "$(_c_role_state "$name")"
      printf '%-16s  %-8s  %-10s  %s\n' "$name" "$kind" "$mode" "$cwd"
    else
      _c_die "assemble: worker '$name' failed to start"
      rc=1
    fi
  done < "$roster"
  return $rc
}

# conductor_render_role <role> [contract-file] — role template -> dispatchable task
# file. Prints the path; feed it straight to conductor_dispatch. The report contract
# is appended here so no role template can forget it (completion gates on it).
conductor_render_role(){
  local role="${1:-}" contract="${2:-}"
  local tj; tj="$(_c_team_json)"
  [ -f "$tj" ] || { _c_die "no assembled team — run conductor_assemble first"; return 1; }
  local out; out="$(_c_run_dir)/$role.task.md"
  CONDUCTOR_ROLE="$role" \
  CONDUCTOR_CONTRACT="$contract" \
  CONDUCTOR_TEAM_JSON="$tj" \
  CONDUCTOR_ROLES_DIR="$CONDUCTOR_ROLES_DIR" \
  CONDUCTOR_SENTINEL="$CONDUCTOR_SENTINEL" \
  CONDUCTOR_MISSION="${CONDUCTOR_MISSION:-}" \
  CONDUCTOR_OUT="$out" python3 - <<'PY' || return 1
import json, os, sys
def die(m):
    sys.stderr.write("conductor: %s\n" % m); sys.exit(1)
role = os.environ["CONDUCTOR_ROLE"]
cfg = json.load(open(os.environ["CONDUCTOR_TEAM_JSON"]))
r = next((x for x in cfg["roles"] if x["name"] == role), None)
if r is None:
    die("render_role: '%s' is not a role in this team" % role)
tpl = os.path.join(os.environ["CONDUCTOR_ROLES_DIR"], r["template"] + ".md")
if not os.path.isfile(tpl):
    die("render_role: template not found for role '%s': %s" % (role, tpl))
contract = os.environ.get("CONDUCTOR_CONTRACT") or ""
if contract and not os.path.isfile(contract):
    die("render_role: contract file not found: %s" % contract)
text = open(tpl).read()
subs = {
    "{{MISSION}}": os.environ.get("CONDUCTOR_MISSION", ""),
    "{{CONTEXT}}": open(contract).read() if contract else "(no contract supplied)",
    "{{OWNS}}": r["owns"] or "(see the context above)",
    "{{MUST_NOT_OWN}}": r["must_not_own"] or "(anything outside your slice)",
    "{{BASE_BRANCH}}": cfg["base_branch"],
}
for k, v in subs.items():
    text = text.replace(k, v)
text += ("\n---\n\nWrite your final report to `.conductor/report.md` in your cwd. "
         "End it with a literal line:\n\n%s\n" % os.environ["CONDUCTOR_SENTINEL"])
open(os.environ["CONDUCTOR_OUT"], "w").write(text)
PY
  printf '%s\n' "$out"
}

# conductor_reconcile [--into <dir>] [--branch <name>] — KTD-7 reconcile: merge
# every writer role's branch into one integration worktree. Plain git on purpose,
# not `herdr-swarm harvest`: conductor worktrees are not swarm slots, so swarm's
# harvest reads its own registry and would find nothing here.
# Never force, never deletes a branch. Returns non-zero if any branch conflicted or
# was missing, so a caller can gate on it.
conductor_reconcile(){
  local into="" ibranch=""
  while [ $# -gt 0 ]; do case "$1" in
    --into)   into="${2:-}"; shift 2;;
    --branch) ibranch="${2:-}"; shift 2;;
    *) _c_die "conductor_reconcile: unknown flag: $1"; return 1;;
  esac; done
  local tj; tj="$(_c_team_json)"
  [ -f "$tj" ] || { _c_die "no assembled team — run conductor_assemble first"; return 1; }
  local norm; norm="$(cat "$tj")"
  local repo; repo="$(conductor_repo_root)" || return 1
  local base wtroot
  base="$(_c_cfg_get "$norm" base_branch)"
  wtroot="$(_c_cfg_get "$norm" worktree_root)"
  case "$wtroot" in /*) ;; *) wtroot="$repo/$wtroot";; esac
  [ -n "$into" ] || into="$wtroot/_integration"
  # a relative --into must land in the repo, not wherever this process happens to
  # be standing — same reason repo_git exists in the sibling plugins.
  case "$into" in /*) ;; *) into="$wtroot/$into";; esac
  # git refuses to check the same branch out in two worktrees, so the branch has to
  # track the target directory — otherwise a second --into fails with a git error
  # that reads like "cannot create the worktree" and hides the real cause.
  [ -n "$ibranch" ] || ibranch="conductor/$(basename "$into" | sed 's/^_//')"

  # writer roles only: `gated` and `read-only` roles have no branch of their own.
  local branches; branches="$(printf '%s' "$norm" | python3 -c 'import json,sys
for r in json.load(sys.stdin)["roles"]:
    if r["mode"] == "write": print("%s\t%s" % (r["name"], r["branch"]))')"
  [ -n "$branches" ] || { echo "reconcile: no writer roles to merge"; return 0; }

  if [ ! -d "$into" ]; then
    mkdir -p "$(dirname "$into")"
    local wout
    if git -C "$repo" show-ref --verify --quiet "refs/heads/$ibranch"; then
      wout="$(git -C "$repo" worktree add "$into" "$ibranch" 2>&1)"
    else
      wout="$(git -C "$repo" worktree add -b "$ibranch" "$into" "$base" 2>&1)"
    fi
    # surface git's own reason — "already checked out" and "invalid reference" are
    # very different problems and a bare "cannot create" hides which one you have.
    [ -d "$into" ] || { _c_die "cannot create the integration worktree $into: $wout"; return 1; }
  fi

  printf '%-16s  %-32s  %s\n' ROLE BRANCH RESULT
  local role branch out rc=0
  while IFS="$(_c_tab)" read -r role branch; do
    [ -n "$role" ] || continue
    if ! git -C "$repo" show-ref --verify --quiet "refs/heads/$branch"; then
      printf '%-16s  %-32s  %s\n' "$role" "$branch" "missing"; rc=1; continue
    fi
    if out="$(git -C "$into" merge --no-ff --no-edit "$branch" 2>&1)"; then
      case "$out" in
        *"Already up to date"*) printf '%-16s  %-32s  %s\n' "$role" "$branch" "no-op";;
        *)                      printf '%-16s  %-32s  %s\n' "$role" "$branch" "merged";;
      esac
    else
      git -C "$into" merge --abort >/dev/null 2>&1
      printf '%-16s  %-32s  %s\n' "$role" "$branch" "CONFLICT"; rc=1
    fi
  done <<EOF
$branches
EOF
  printf '\nintegration worktree: %s (branch %s)\n' "$into" "$ibranch"
  return $rc
}

conductor_teardown(){
  local rd; rd="$(_c_run_dir)"; [ -d "$rd" ] || return 0
  local sf
  for sf in "$rd"/*.env; do
    [ -f "$sf" ] || continue
    # reset every field: a .env missing one would otherwise inherit the previous
    # worker's value and we would close a pane we do not own.
    PANE=""; GUARD_FILE=""
    # shellcheck disable=SC1090
    . "$sf"
    [ -n "$PANE" ] && _c_herdr pane close "$PANE" >/dev/null 2>&1   # only panes we started
    [ -n "$GUARD_FILE" ] && rm -f "$GUARD_FILE"                     # only guard files we wrote
    rm -f "$sf"
  done
  # worktrees and branches survive teardown on purpose — `stand-down` keeps work.
  # Only the run's own transport scratch goes.
  rm -f "$(_c_team_json)" "$rd/roster.tsv" "$rd"/*.task.md
  rmdir "$rd" 2>/dev/null || true
}

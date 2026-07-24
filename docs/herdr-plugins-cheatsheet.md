# Herdr Plugins Cheat-Sheet

Four StructuPath plugins, all installed + verified working on **herdr 0.7.5**.
Linked to local dev copies under `~/dev/structupath/`, so disk edits are live.
All four are registered in `~/.config/herdr/plugins.json` (the herdr package registry).

| Plugin | ID | Repo | Purpose |
|---|---|---|---|
| Browser   | `structupath.browser`   | `herdr-browser`   | A web browser inside a herdr pane |
| Guard     | `structupath.guard`     | `herdr-guard`     | Cross-agent command policy enforcement |
| Swarm     | `structupath.swarm`     | `herdr-swarm`     | Run N *identical* agents in parallel, safely |
| Conductor | `structupath.conductor` | `herdr-conductor` | Orchestrate a *role-differentiated* feature team as visible agent panes |

**Swarm vs Conductor:** Swarm fans out N interchangeable agents into worktrees and
you keep the best. Conductor runs a *team of different roles* (builder, validator,
reviewer…), each a real attachable pane, driven by an orchestrating agent. The
composition: **Conductor decides → Swarm isolates → Guard enforces.**

---

## Health checks (all four)

```bash
herdr plugin list          # installed + enabled? shows source path
herdr plugin action list   # proves the action scripts actually registered
herdr plugin log list       # per-command logs: exit codes / stderr from failed actions
herdr status server         # is the herdr server up
```

`enabled` in `plugin list` = manifest parsed. `action list` = scripts wired in.
Both green = healthy. A plugin pane shows a **label** in `herdr pane list`
(plain terminals show none) — that's the tell it's plugin-owned and rendering.

Invoke any action manually:

```bash
herdr plugin action invoke <action_id> --plugin <plugin_id>
```

> Exception: `swarm fanout` can NOT be action-invoked (panes don't inherit env).
> Use the TUI menu, or run `fanout-pane.sh` directly. Browser + Guard invoke fine.

---

## 🌐 Browser

One browser session per workspace. Two ways in:

| Action | What |
|---|---|
| `browse` | Personal interactive browser (own Chromium). **Type the URL in its address bar.** |
| `open`   | Viewer onto the shared *agent* browser session (with no URL = view-only attach) |
| `record-start` / `record-stop` | Record the session to WebM |
| `close`  | Close pane + release the session |

**Everyday:** menu → **Browse** → type URL → navigate (keyboard-driven).
Close with the `close` action or `q` in the pane.

**Quirk:** action-invoke can't pass a URL (herdr 0.7.x). So `open` with no URL
attaches view-only; the URL is set either by an agent or by:

```bash
agent-browser --session herdr-ws-<workspaceId> open https://example.com
```

---

## 🛡️ Guard

Runs in the background — subscribes to pane events and enforces a command policy
so a runaway agent can't do something dangerous. Mostly hands-off.

| Action | What |
|---|---|
| `test`  | Dry-run a command against the live policy (allow/deny, no execution) |
| `open`  | Open the guard pane (view policy / activity) |
| `pause` / `resume` | Temporarily stop / restart enforcement |
| `reset-rules` | Back up + reseed the default ruleset |

**Everyday:** leave it running. Use `test` when unsure if a command is blocked,
`pause`/`resume` to override temporarily.

---

## 🐝 Swarm  ← the one you missed

**Mental model:** "Try this task N different ways in parallel, then keep the best."
Each agent works in its **own git worktree + branch** off a recorded base SHA,
so they never collide. `main` stays clean until *you* merge.

### The 5 actions, in order

| # | Action | You do | It does |
|---|---|---|---|
| 1 | **Fan out** | how many agents (N), preset per slot, the task | N worktrees + `swarm/<run>/<slot>` branches, task → `.swarm-task.md`, launches agents, opens Status |
| 2 | **Status** | watch; `1`–`9` jump into a slot, `q` quit | per-slot state + **committed/uncommitted counts** vs the fork point |
| 3 | **Harvest** | review + merge, one slot at a time | merges good slots back `--no-ff`; removes worktree after (branch kept) |
| 4 | **Prune** | confirm via env flags | deletes fully-merged `swarm/*` branches (dry-run lists first) |
| — | **Abort** | bail anytime | stops agents, removes clean worktrees, **keeps branches** |

### Harvest keys (per slot)

- `1`–`9` select slot · `r` re-preview · `q` quit
- Clean slot → merged automatically (base drift-checked before every merge)
- Dirty slot → `w` commit WIP · `s` skip · `d` discard (typed confirm, snapshot saved first)
- Conflict → `s` shell into merge tree · `a` abort merge · `b` back out

### Prune is gated on purpose (destructive)

```bash
HERDR_SWARM_PRUNE_CONFIRM=yes         # delete listed merged swarm/* branches
HERDR_SWARM_PRUNE_ACK_REVERTED=yes    # also needed for merged-then-reverted
HERDR_SWARM_PRUNE_BACKUPS=yes         # delete discard-snapshot backup refs
```

Prune uses safe `git branch -d` (never `-D`) and refuses branches still
checked out in a worktree.

### 0.7.5 quirk

A slot that finishes still shows `working` in Status until you open Harvest.
Cosmetic — the committed work is harvestable regardless.

### Three things to remember

1. **Isolation is the point** — own worktree + branch each; `main` untouched until harvest.
2. **You are the merge gate** — agents commit locally, never push; you decide what lands.
3. **Cleanup is layered + safe** — abort keeps branches, prune won't force-delete, discards snapshot first.

### Everyday flow

TUI menu → **Fan out** (answer prompts) → **Status** (watch) → **Harvest** (keep winners) → **Prune** (tidy).

### Scripted / headless fan-out (CI or agent-driven)

`fanout` can't be action-invoked; call the pane script directly with env overrides:

```bash
HERDR_SWARM_SLOTS=3 \
HERDR_SWARM_PRESETS=claude,claude,codex \   # one name = applies to all slots
HERDR_SWARM_TASK_FILE=/path/brief.md \
HERDR_SWARM_DETRITUS=rename \               # delete | rename | abort (leftover branches)
HERDR_WORKSPACE_ID=<repo workspace id> \
  bash ~/dev/structupath/herdr-swarm/scripts/fanout-pane.sh
```

Presets live in `presets.conf` (`name|kind|args`); defaults are `claude` and `codex`.

---

## What the demo you missed actually did

2 slots, a dummy zero-cost preset (wrote a file + committed instead of launching a real agent):

```
# Fan out
slot 1 running — swarm/<run>/s1-demo -> ~/.herdr/worktrees/.../s1-demo
slot 2 running — swarm/<run>/s2-demo -> ~/.herdr/worktrees/.../s2-demo
fan-out complete — created 2, started 2, failed 0.

# Each slot: 1 commit on its own branch, main untouched
s1-demo:  demo(...): add result file   -> result-...-s1-demo.txt
s2-demo:  demo(...): add result file   -> result-...-s2-demo.txt
main:     init: notes                  (only notes.txt — clean)

# Harvest -> both merged --no-ff into main
*   merge s2-demo
|\
* | merge s1-demo
|\ \
| * add result file (s1)
| * add result file (s2)
* init: notes
# main now has BOTH result files, base preserved

# Prune (dry-run) listed both merged branches; real prune safely refused
# to -D branches still checked out in worktrees.
```

Everything was on a throwaway repo in the scratchpad and fully torn down after.

---

## 🎩 Conductor  ← the new one

**Mental model:** "Run a *team* — a builder, a validator, a reviewer — each as a
real, visible, attachable agent pane, and one orchestrator drives them." Unlike
Swarm's N-identical fan-out, Conductor's workers are **role-differentiated** and
**mixed-vendor** (claude/codex/pi side by side), and they **survive the
orchestrator** — a crashed driver doesn't kill the team.

### The split that makes it work

| Half | Where | Who drives it |
|---|---|---|
| **Transport** (the loop) | `scripts/conductor-lib.sh` | An orchestrating **agent** sources it and runs the loop |
| **Operational surface** | the `board` + `stand-down` actions | You / the TUI menu |

Dispatch is **agent-driven, not an action** — herdr plugin actions get no argv/TTY,
so the intelligence that decomposes a feature and assigns roles is the agent's job,
not a shell script's.

### The 2 actions

| Action | What |
|---|---|
| `board` | Live pane: one row per worker — role, kind, pane, **status (from `agent list`, not screen-scraping)**, cwd. Refreshes 2s; `q` quits. |
| `stand-down` | Closes only conductor-owned worker panes for the active run (ownership-verified); git branches + worktrees kept. |

```bash
herdr plugin action invoke board      --plugin structupath.conductor
herdr plugin action invoke stand-down --plugin structupath.conductor
```

### The agent-driven loop (what the orchestrator does)

```bash
. scripts/conductor-lib.sh
conductor_start_worker builder  claude "$engine_wt"          # warms by default
conductor_start_worker reviewer codex  "$repo" -- --sandbox read-only
conductor_dispatch builder "$builder_prompt"
conductor_await    builder && conductor_collect builder      # settles on the report SENTINEL
conductor_teardown
```

### Three things to remember

1. **Settle ≠ success** — a worker hits `idle` after *any* turn (even a question).
   Completion is a `<!-- REPORT-COMPLETE -->` sentinel in `.conductor/report.md`,
   never agent state. The lib enforces this (freshness-checked).
2. **Warm by default** — a cold interactive agent opens on a welcome screen and
   drops its first prompt; `conductor_start_worker` warms it. `--no-warm` to skip.
3. **Files both directions** — mission via `.conductor/task.md`, result via
   `.conductor/report.md` (auto-gitignored). Panes are for humans to watch/attach.

### Also shipped as the pi-library skill

The transport is also the **Herdr adapter** in `feature-delivery-team`
(pi-library) — same loop, driven inline by whatever agent you're in.

---

## Reference

- Plugin repos: `~/dev/structupath/herdr-{browser,conductor,guard,swarm}`
- Config: `~/.config/herdr/` (`config.toml`, `plugins.json` = the package registry)
- Swarm worktrees live under: `~/.herdr/worktrees/<repo>/`
- Swarm state/manifests: `~/.local/state/herdr-swarm/run-<workspaceId>.json`
- Conductor run registry: `~/.local/state/herdr-conductor/run-<id>/<role>.env`
- Docs: each repo's `README.md`; plans in `herdr-{swarm,conductor}/docs/plans/`
- Conductor is public (`StructuPath/herdr-conductor`, topic `herdr-plugin`); the
  others: browser + guard public, swarm not yet marketplace-listed.

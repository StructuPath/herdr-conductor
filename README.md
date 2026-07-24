# herdr-conductor

> Orchestrate a feature-delivery team as **visible Herdr agent panes**. An
> orchestrating agent dispatches worker agents (builder, validator, reviewer…),
> watches them on a live board, and stands the team down cleanly.

The fourth StructuPath Herdr plugin, and the operational surface for the
**Conductor** pattern. Where [herdr-swarm](https://github.com/StructuPath/herdr-swarm)
fans out N *identical* agents into worktrees, Conductor runs a *role-differentiated
team* — each worker is a real, attachable Herdr pane, mixed-vendor
(claude/codex/pi), and **survives the orchestrator** (a crashed driver doesn't kill
the team).

Verified on **herdr 0.7.5**.

**Docs:** the [StructuPath Herdr Plugins wiki](https://github.com/StructuPath/herdr-browser/wiki)
is the practical guide to this plugin and its three siblings (Browser, Guard,
Swarm).

## The two halves

| | Where it lives | What it does |
|---|---|---|
| **Transport** (the loop) | `scripts/conductor-lib.sh` | Sourced by an orchestrating agent to drive workers: `conductor_start_worker` → `conductor_dispatch` → `conductor_await` → `conductor_collect` → `conductor_teardown`. |
| **Operational surface** (this plugin) | `board` / `stand-down` actions + the board pane | Make a run visible and manageable as a first-class Herdr citizen. |

Dispatch is agent-driven, not an action, because Herdr plugin actions get no argv
and no TTY — the intelligence that decomposes a feature and assigns roles is the
orchestrating agent's, not a shell script's.

## Why an agent, not an action

The orchestrating agent (any coding agent in a Herdr pane) sources the transport
and runs the loop. Completion is gated on a **report sentinel written to a file**,
never on agent state — a worker reaches `idle` after *any* turn, including a
clarifying question, so "settled" is not "done". Workers exchange work through
`.conductor/task.md` (in) and `.conductor/report.md` (out); panes are for humans to
watch and attach to.

```bash
# inside the orchestrating agent's pane
. scripts/conductor-lib.sh
conductor_start_worker builder claude "$engine_wt"   -- --permission-mode default
conductor_start_worker reviewer codex "$repo"        -- --sandbox read-only
conductor_dispatch builder "$builder_prompt"
conductor_await    builder && conductor_collect builder   # settles on the report sentinel
```

Workers warm on start by default (a cold interactive agent opens on a welcome
screen and drops its first prompt); pass `--no-warm` if you own a ≥180s first turn.
Every worker cwd gets a `.conductor/.gitignore` so transport state is never
committed.

## Actions

```bash
herdr plugin action invoke board      --plugin structupath.conductor   # open the live board
herdr plugin action invoke stand-down --plugin structupath.conductor   # close worker panes (branches kept)
```

- **Board** — one row per worker: role, kind, pane, live status (from
  `herdr agent list`, not terminal scraping), and cwd. Refreshes every 2s; `q` quits.
- **Stand down** — closes only conductor-owned panes for the active run (ownership
  verified); git branches and worktrees are left intact.

## Install

```bash
herdr plugin install StructuPath/herdr-conductor    # from the marketplace
# or, for local dev:
herdr plugin link /path/to/herdr-conductor
```

Health check:

```bash
herdr plugin list           # enabled?
herdr plugin action list    # actions registered?
```

## The composition

Conductor is one of three plugins that compose into a full orchestration substrate,
each doing the one job it does well:

```
CONDUCTOR decides   →   SWARM isolates        →   GUARD enforces
(this plugin)           (worktree per writer)     (read-only audit for review roles)
```

## Requirements

- herdr ≥ 0.7.5, Node ≥ 20, Python 3, Bash (3.2+).
- macOS / Linux. (Herdr has documented Windows plugin defects; not supported.)

## Layout

```
herdr-plugin.toml         manifest (board + stand-down actions, board pane)
scripts/conductor-lib.sh  the transport (agent sources this) — proven on 0.7.5
scripts/lib.sh            plugin glue: root resolution, board JSON over the run registry
scripts/board.sh          action: open the board pane (singleton)
scripts/board-pane.sh     pane entrypoint → exec bin/renderer.mjs
scripts/stand-down.sh     action: teardown via the transport
bin/renderer.mjs          zero-dep live board renderer
tests/                    node --test
docs/plans/               the Conductor plan (Tier 1 + Tier 2 lineage)
```

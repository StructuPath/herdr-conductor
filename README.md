# herdr-conductor

> [!WARNING]
> Conductor `0.1.0` is an **advanced, attended assembly prototype**, not a durable
> delivery workflow. Its current run selection and teardown state are not safely
> scoped to a repository or Herdr workspace. **Do not invoke `stand-down` for an
> existing or ambiguous run.** Inspect panes and state manually until the planned
> identity/state rewrite is implemented and live-certified.

Conductor coordinates a role-differentiated team—builders, validators, and
reviewers—as visible Herdr agent panes. A human or trusted orchestrating agent
sources `scripts/conductor-lib.sh`, dispatches work, checks report files, and
chooses whether to reconcile writer branches. Herdr plugin actions expose the
same prototype run through a board and one-shot lifecycle commands.

The package requires Herdr `>=0.7.5`. Unit tests and dry-run transport tests cover
the current shell code, but the complete Tier-2 sequence has not been certified
in a live Herdr session. A worker process may remain alive after its driver exits;
Conductor does not durably rediscover or adopt that worker after a crash.

![herdr-conductor demo: a real two-role team on the live board](assets/herdr-conductor-demo.gif)

**Canonical suite guide:** [Deliver with Conductor](https://github.com/StructuPath/herdr-suite-site/blob/main/docs-src/Conductor.md).
The guide and this repository describe a supervised pattern, not an automatic
approval pipeline.

## Current trust and safety boundaries

The current runtime has important limitations:

- `board`, `status`, `harvest`, and `stand-down` select the newest global
  `run-*` directory. They do not bind the run to the invoking repository or Herdr
  workspace.
- Role state is stored as shell assignments and sourced. It is not a strict,
  non-executable state format.
- Teardown trusts recorded pane IDs; it does not compare live workspace,
  terminal, session, agent, cwd, and run identity before closing a pane.
- `read-only` and `gated` are configuration labels that choose worktrees and
  Guard drops. They do not select protected launch flags. Repository-provided
  `launch_args` are passed through as supplied, and no post-run source
  immutability check is performed.
- Guard observes rendered pane text and writes audit events. It is advisory and
  cannot enforce filesystem isolation or prove that a command was prevented.
- Reconcile merges writer branches without requiring validated role reports,
  validator/reviewer verdicts, or an approval record. The current validator and
  reviewer trees are not advanced to the reconciled integration commit.
- A dry run avoids Herdr and Git worktree/branch mutations, but still creates
  local run state and `.conductor/` transport files. It is not filesystem
  immutable.
- Worktrees and same-user agent processes are coordination tools, not security
  boundaries. Same-user processes can access or tamper with local state.

Use a disposable repository and direct human supervision. Do not run Swarm and
Conductor concurrently against the same Git common directory.

## Transport and team declaration

| Part | Location | Current responsibility |
| --- | --- | --- |
| Transport | `scripts/conductor-lib.sh` | Starts workers, dispatches task-file pointers, waits, collects sentinel-terminated reports, and performs legacy reconcile/teardown. |
| Team | `.herdr-conductor.json` + `roles/` | Declares role names, kinds, modes, ownership prompts, and optional launch arguments. |
| Plugin surface | `assemble`, `board`, `status`, `harvest`, `stand-down` | Exposes the prototype run through Herdr actions. |

Dispatch remains agent-driven because Herdr plugin actions receive neither argv
nor a TTY. Completion is a report-file convention, not an agent-state verdict:
workers read `.conductor/task.md`, write `.conductor/report.md`, and end the
report with `<!-- REPORT-COMPLETE -->`. The marker rejects absent, stale, and
obviously incomplete reports, but it is not bound to a run, role, task digest, or
commit and must not be treated as approval evidence.

Example attended loop:

```bash
. scripts/conductor-lib.sh
conductor_assemble
conductor_dispatch builder-engine "$(CONDUCTOR_MISSION='Add the widget engine.' \
  conductor_render_role builder-engine contract.md)"
conductor_await builder-engine && conductor_collect builder-engine
# Inspect branches and reports before deciding whether to reconcile.
conductor_reconcile
```

Example team declaration:

```json
{
  "version": 1,
  "base_branch": "main",
  "roles": [
    {
      "name": "builder-engine",
      "kind": "claude",
      "mode": "write",
      "owns": "engine, catalog, domain logic",
      "must_not_own": "UI layout, routes"
    },
    {
      "name": "validator",
      "kind": "codex",
      "mode": "gated",
      "launch_args": ["--sandbox", "workspace-write"]
    },
    {
      "name": "reviewer",
      "kind": "codex",
      "mode": "read-only",
      "launch_args": ["--sandbox", "read-only"]
    }
  ]
}
```

Current mode mapping:

| Mode | Worktree + branch | Guard audit drop | Current meaning |
| --- | --- | --- | --- |
| `write` | yes | no | Writer role on a role branch. |
| `gated` | yes | yes | Gate role in a disposable worktree; source immutability is requested, not verified. |
| `read-only` | no; uses the base tree | yes | Review role; isolation depends on caller-supplied launch flags and is not enforced by the mode. |

A truly read-only reviewer also cannot write the current in-tree report path.
Until a separate writable report outbox exists, treat the reviewer prompt and
report convention as cooperative instructions rather than a verified read-only
control.

## Actions

The manifest exposes exactly five actions:

```bash
herdr plugin action invoke assemble   --plugin structupath.conductor
herdr plugin action invoke board      --plugin structupath.conductor
herdr plugin action invoke status     --plugin structupath.conductor
herdr plugin action invoke harvest    --plugin structupath.conductor
herdr plugin action invoke stand-down --plugin structupath.conductor
```

- **Assemble** reads `.herdr-conductor.json`, prepares role resources, starts one
  pane per role, and opens the board. Re-running may reuse a directory or branch,
  but does not prove its repository, branch, fork commit, or ownership and is not
  crash recovery.
- **Board** displays the globally selected run and refreshes agent state every two
  seconds. It is observational; confirm the displayed cwd manually.
- **Status** prints the same globally selected run once.
- **Harvest** runs plain-Git reconcile into an integration worktree. It never
  force-merges or deletes branches, but it has no report/verdict/approval
  precondition. Inspect exact branches and commits first.
- **Stand down** is the legacy teardown path. It sources recorded state and closes
  recorded pane IDs without live identity verification. Do not use it on current
  persisted state or as a cleanup mechanism.

Herdr action processes resolve the target repository from
`HERDR_PLUGIN_CONTEXT_JSON.workspace_cwd`; this avoids ambient server cwd for the
initial repository lookup, but it does not fix global active-run selection.

## Relationship to Swarm and Guard

Swarm and Conductor are separate sibling workflows with different semantics:

```text
SWARM explores interchangeable candidates
    -- explicit human-selected commit -->
CONDUCTOR coordinates differentiated delivery roles

GUARD may observe either workflow; native harness/OS controls enforce.
```

Conductor creates and reconciles its own Git worktrees. It does not invoke Swarm,
read Swarm state, or use Swarm as a hidden lifecycle backend. The supported
composition is sequential: a human selects an exact Swarm commit, then starts a
separate Conductor run from an explicitly reviewed base. Concurrent mutation of
one repository is unsupported.

## Install and requirements

```bash
herdr plugin install StructuPath/herdr-conductor
# local development
herdr plugin link /path/to/herdr-conductor
```

Requirements: Herdr `>=0.7.5`, Node.js `>=20`, Python 3 with `tomllib`, and Bash
3.2 or newer on macOS or Linux. Windows is not supported.

Health check:

```bash
herdr plugin list
herdr plugin action list
```

## Development

```bash
npm test
npm run check
shellcheck --shell=bash scripts/*.sh
go run github.com/rhysd/actionlint/cmd/actionlint@v1.7.7
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for review gates and
[SECURITY.md](SECURITY.md) for private reporting and current safe-use guidance.

## Layout

```text
herdr-plugin.toml          manifest: five actions and one board pane
scripts/conductor-lib.sh   current Bash transport and lifecycle implementation
scripts/lib.sh             plugin glue and global run resolution
scripts/{assemble,board,status,harvest,stand-down}.sh
bin/renderer.mjs           zero-dependency live board renderer
roles/                     feature-delivery role prompt templates
tests/                     Node built-in test suite
docs/history/              historical origin/implementation records, not contracts
```

The unrelated Flotion prototype scaffolding restored by commit `7067a06` was
removed from the product tree in Stage 0. Git history preserves its exact files;
[`docs/history/README.md`](docs/history/README.md) records the provenance.

`scripts/conductor-lib.sh` is canonical in this repository. The pi-library
`feature-delivery-team` skill currently vendors a copy, so any future runtime
change requires an explicit cross-repository synchronization and evidence review.

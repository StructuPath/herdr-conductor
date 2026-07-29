# herdr-conductor

> [!IMPORTANT]
> Conductor `0.2.0` is **Stage 1 attended-operational** on exactly Herdr `0.7.5`.
> Its strict five-action lifecycle is supported only while an operator explicitly
> drives it. This status does not claim Stage 2 approval/report contracts, a suite
> adapter, unattended automation, or recovery tooling. Cooperative same-user
> TOCTOU limits remain explicit below.

Conductor coordinates role-differentiated builders, validators, and reviewers as
visible Herdr agent panes. Stage 1 B4 live evidence exercises the complete B3
lifecycle through the installed action entrypoints. Stage 1 B3 connects attended
harvest and stand-down
to the same strict private-state runtime as assemble, board, and status. Every
action resolves the invoking physical Git repository and exact Herdr workspace
from `HERDR_PLUGIN_CONTEXT_JSON`; there
is no `CONDUCTOR_REPO`, ambient-cwd, process-ID, or newest-global fallback.

All five actions are gated to exactly Herdr `0.7.5` (protocol `17`, schema `1`)
before lifecycle state is read or mutated, and require Node.js `>=20`. The B1
[private state contract](docs/private-state-v1.md) documents strict JSON,
physical repository identity, private persistence, locks, and journal crash
boundaries.

![herdr-conductor demo](assets/herdr-conductor-demo.gif)

**Canonical suite guide:** [Deliver with Conductor](https://github.com/StructuPath/herdr-suite-site/blob/main/docs-src/Conductor.md).
Conductor remains separate from Swarm and does not provide an automatic pipeline.

## Stage 1 B3 guarantees

For all five actions:

- `HERDR_PLUGIN_CONTEXT_JSON.workspace_cwd` must be the canonical Git repository
  root and `workspace_id` must be a bounded exact identifier. Assemble also
  requires `focused_pane_id`, live-fetches it before state creation and again
  immediately before every split, and requires its workspace to match exactly.
  Missing, malformed, duplicate-key, foreign, or stale context fails closed.
- Active state is keyed by physical Git common-directory identity and workspace.
  Repositories sharing one state root and workspaces sharing one repository do
  not select one another's runs.
- Assemble resolves and records one fixed fork SHA and the exact canonical
  integration target path, physical common directory, full ref, head/fork, and
  registered membership before lifecycle effects. Run IDs and run generations
  are unpredictable. Every writing role gets
  a run-unique full ref under `refs/heads/conductor/<run-id>/<role>` and every
  role gets a run-unique bounded agent name.
- Worktree creation, pane creation, and agent start each publish a durable intent
  before the external command. The terminal journal record contains the exact
  observed worktree, pane, or pane-plus-agent identity and a digest.
- Pane metadata carries the run and resource generation. Assemble reads both
  tokens back from pane and named-agent views and requires exact workspace, pane,
  terminal, session, name, run, and generation agreement. Both `cwd` and
  `foreground_cwd` are independently required, physically canonicalized, and
  required to equal the intended cwd in both views.
- A crash after durable intent or an uncertain external effect leaves the run in
  explicit recovery-required state. The runtime never adopts a same-named ref,
  worktree, pane, or agent and never silently replays an uncertain operation.
- Board and status load only the invoking context's strict active run. Live status
  re-reads both the pane and named agent; changed identity is reported as
  `foreign_or_stale`, and unavailable identity is reported as `unavailable`.

Private state remains cooperative same-user coordination, not authentication.
The repository lock cannot prevent another same-user process from mutating Git
immediately after harvest's final validation, and Herdr 0.7.5 has no conditional
pane-close API. Stand-down re-reads the full tuple immediately before
`pane.close`, but these documented same-user TOCTOU limitations remain.

## B4 live smoke and later-stage holds

The retained [B0 identity capability evidence](docs/evidence/2026-07-28-herdr-0.7.5-identity-capability.md),
fixtures, negative results, and deterministic checker remain foundational evidence
for the full live identity tuple; B4 complements rather than supersedes them.
The retained [B4 live smoke report](docs/evidence/2026-07-28-stage1-b4-live-smoke.md)
and machine evidence record one successful, explicitly opted-in disposable run
through all five installed actions. The smoke used a real supported agent,
verified cross-workspace/repository isolation, harvested an observed writer
commit, archived the run, closed the exact pane, and confirmed retained
worktree/branch/artifacts. Release `0.2.0` records that bounded Stage 1
attended-operational status; it does not expand the held Stage 2 surface. The
deterministic evidence checker resolves the candidate with argument-safe Git,
requires it to be an ancestor of the evidence head, and validates every retained
runtime-source digest against both that candidate tree and the current checkout
without rerunning Herdr. The report is sanitized operator-observed local evidence,
not cryptographic remote attestation or authentication against same-UID fabrication.

- `harvest` is explicitly invoked and attended. One repository mutation lock spans
  canonical journal loading and every source/target preflight. It computes a merge
  tree and commit from immutable source/target SHAs, then compare-and-swaps the
  assemble-bound target ref with `git update-ref <ref> <new> <old>`. The verified
  integration index/worktree is refreshed without moving the ref again. After the
  journal's post-effect checkpoint and while still holding the repository lock,
  harvest re-reads the exact target path/common directory/ref/head/membership,
  expected merged SHA, index tree, and tracked worktree cleanliness immediately
  before publishing an observed result.
- `stand-down` closes only panes whose live pane and named-agent views exactly match
  the canonical journal tuple immediately before close, then archives strict state.
- Stand-down never removes worktrees or branches and never deletes artifacts,
  reports, recordings, logs, Guard files, or legacy inventory.
- Failed or timed-out merge/close is ambiguous, journaled `needs_attention`, and
  cannot replay. Archive is a separate recoverable private-state transition: its
  journal is observed only after archived state and active-pointer removal. B3
  adds no suite receipt, adapter, approval, automation, worktree deletion/prune,
  or Browser evidence change.
- Role modes and launch arguments remain cooperative configuration. Guard is
  observational and cannot prove prevention. Stage 2 owns strict task/report
  schemas, writable report outboxes, and exact integration-SHA validation.

Strict v1 state lives only below the private `v1/` child of the configured state
parent. A pre-existing permissive legacy parent is not authority and is never
parsed, sourced, migrated, adopted, modified, or dual-written. The shipped
operational surface contains no second sourceable lifecycle; the journal is the
one canonical observed-resource authority for B3.

## Team declaration

Create `.herdr-conductor.json` at the repository root:

```json
{
  "version": 1,
  "roles": [
    {
      "name": "builder-engine",
      "kind": "claude",
      "mode": "write"
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

The config is strict JSON: duplicate keys, unknown or unused legacy fields,
malformed roles, absolute/external roots, symlinked path components, and
pre-existing targets are rejected before state or external effects. Worktree
paths are physically revalidated immediately before `git worktree add`. `write`
and `gated` roles receive worktrees;
`read-only` roles use the repository root. These labels do not themselves enforce
filesystem isolation. B3 does not write task or report files; that work remains
held for Stage 2.

## Actions

The manifest exposes exactly five actions:

```bash
herdr plugin action invoke assemble   --plugin structupath.conductor
herdr plugin action invoke board      --plugin structupath.conductor
herdr plugin action invoke status     --plugin structupath.conductor
herdr plugin action invoke harvest    --plugin structupath.conductor
herdr plugin action invoke stand-down --plugin structupath.conductor
```

- **Assemble** creates a new strict run, run-unique worktrees/refs, and one
  identity-observed named agent pane per role. It does not adopt or resume an
  existing active run.
- **Snapshot Conductor status** (`board`) prints one JSON snapshot for the
  invoking repository/workspace. It opens or focuses no pane.
- **Status** prints the same context-bound state as a table with live identity
  classification.
- **Harvest** performs attended, journal-authoritative, identity-checked plain-Git
  reconciliation into the invoking repository's exact current branch.
- **Stand down** identity-checks and closes eligible panes, archives strict state,
  and retains every worktree, branch, artifact, report, recording, log, and Guard
  file.

The manifest retains a passive `board-pane` entrypoint for an already
operator-opened plugin pane. It polls the same strict context-bound runtime and
never drives an agent or writes state.

## Relationship to Swarm and Guard

```text
SWARM explores interchangeable candidates
    -- explicit human-selected commit -->
CONDUCTOR coordinates differentiated delivery roles

GUARD may observe either workflow; native harness/OS controls enforce.
```

Conductor does not invoke Swarm, read Swarm state, or share private lifecycle
state. Concurrent Swarm and Conductor mutation of one Git common directory is
unsupported.

## Install and requirements

```bash
herdr plugin install StructuPath/herdr-conductor
# local development
herdr plugin link /path/to/herdr-conductor
```

Requirements: Herdr exactly `0.7.5`, Node.js `>=20`, Python 3 with `tomllib`,
and Bash 3.2 or newer on macOS or Linux. Windows is not supported.

## Development

```bash
npm test
npm run check
node --test tests/stage1-runtime-*.test.mjs tests/state-kernel.test.mjs
# destructive/live and refused unless this exact opt-in is present:
CONDUCTOR_STAGE1_LIVE_SMOKE=I_UNDERSTAND_THIS_USES_LOCAL_HERDR npm run smoke:stage1:live
shellcheck --shell=bash scripts/*.sh
go run github.com/rhysd/actionlint/cmd/actionlint@v1.7.7
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for review gates and
[SECURITY.md](SECURITY.md) for private reporting and safe-use boundaries.

## Layout

```text
herdr-plugin.toml                  five actions and passive board pane
scripts/stage1-runtime.mjs         sole CLI/lifecycle authority for all five actions
scripts/git-reconcile.mjs          Git identity, immutable merge, and ref CAS policy
scripts/herdr-identity.mjs         Herdr version, pane identity, and close policy
scripts/operation-policy.mjs       shared operation subject/prerequisite metadata
scripts/private-state-schema.mjs   strict private JSON schemas
scripts/state-kernel.mjs           persistence, locks, and active state
scripts/operation-journal.mjs       operation journals and archive recovery
scripts/*.sh                       thin strict Node action entrypoints
scripts/run-stage1-live-smoke.mjs  explicit opt-in disposable live harness
scripts/check-evidence-inventory.mjs  foundational-evidence inventory gate
scripts/check-b0-identity-evidence.mjs B0 identity-fixture gate
scripts/check-stage1-live-smoke-evidence.mjs B4 live-evidence gate
bin/renderer.mjs                   passive strict-state board renderer
roles/                             future Stage 2 role prompt inputs
tests/                             deterministic Node and shell regression suite
docs/private-state-v1.md           private state and crash contract
docs/evidence/                     candidate-anchored B4 live evidence and source manifest
```

Historical design records remain under `docs/history/` as inert documentation;
they are not entrypoints, current guidance, or runtime authority.

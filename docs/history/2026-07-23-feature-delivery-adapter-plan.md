# Historical Herdr Runtime Adapter Plan (Conductor Tier 1)

**Record date:** 2026-07-23

**Origin:** [Herdr Conductor adapter spec](2026-07-23-herdr-conductor-origin-spec.md)

> [!CAUTION]
> **Historical implementation plan, not a current runtime contract.** It records
> the 2026-07-23 Tier-1/Tier-2 path and intentionally retains superseded design
> language. Current Conductor does not provide durable recovery, verified pane
> ownership, Guard enforcement, mode-driven read-only enforcement, or Swarm-backed
> lifecycle. See the repository [README](../../README.md) for supported claims.

**Original target repo:** pi-library. The spike touched no other repo's code and
read `herdr-swarm` for patterns only.

## Summary

Add **Herdr** as a fourth runtime adapter to the `feature-delivery-team` skill, so an orchestrating agent can run the five-role team as real, visible, attachable Herdr panes — mixed-vendor (claude/codex/pi), OS-process-survivable, harness-enforced read-only for the read-only roles. A scripted spike gates the work: herdr's `agent prompt/wait/read` verbs have **zero prior live evidence** in any StructuPath repo.

**Positioning (carried from verdict):** this is the *attended, long-running, mixed-vendor* orchestration tier. It does not replace in-process subagents (which win on latency, token cost, and structured returns) and the skill text must say so.

---

## Problem Frame

All existing orchestration assets (`feature-delivery-team`, lead-agents, Pi subagents) dispatch through in-process transports. Herdr 0.7.5 natively supports agent-orchestrates-agents (`agent start/prompt/wait/read`), which adds visibility, mid-flight `agent attach` intervention, mixed-vendor teams, and worker survivability — but nothing in the ecosystem uses it, and three of its core verbs are unexercised. Tier 2 (a `herdr-conductor` plugin) is explicitly deferred until Tier 1 is dogfooded.

---

## Key Technical Decisions

1. **Native start path, not swarm's helper.** Workers launch via `herdr pane split --cwd <dir>` (topology) + `herdr agent start <name> --kind <kind> --pane <id>` (registration). Rationale: swarm's `herdr_agent_start()` deliberately uses `pane run` + `report-agent` for arbitrary argv, which yields **no native state detection and no working `agent wait`** — the primitives the conductor's control flow gates on. All five role runtimes (claude, codex, pi) are on the 0.7.5 `--kind` whitelist. Borrow swarm's *patterns* (version gate, `with_timeout`, singleton locks, ownership verification before removal); never source `herdr-swarm/scripts/lib.sh` verbatim — it pins reported-agent identity to `structupath.swarm` and shares swarm's lock namespace.
   > **Divergence from origin spec (recorded).** The spec recommended reusing `herdr_agent_start()` directly. That recommendation predates the 2026-07-23 learnings sweep, which established the helper never takes the `--kind` path and so produces workers herdr can't natively detect or `agent wait` on. The conductor needs those primitives, so this plan reuses swarm's *patterns* but not its bootstrap function. The spec is superseded on this point.
2. **Files both directions; panes are for humans.** Mission in: write the full role prompt to `<worker-cwd>/.conductor/task.md`, then deliver a one-line pointer via `agent prompt` ("Read .conductor/task.md and execute it"). Result out: every role prompt ends with "write your final report to `.conductor/report.md`, ending it with a literal `<!-- REPORT-COMPLETE -->` sentinel line"; the conductor reads files, never scrapes panes for verdicts. A report lacking the sentinel is treated as absent — this closes the settle-races-a-partial-write gap, since detection can fire between a worker's multiple write calls. Rationale: the task-file channel is the only proven long-prompt path (swarm's `.swarm-task.md`); `agent read` returns a lossy terminal snapshot unsuited to result parsing; `agent prompt` size limits are uncaptured.
3. **Read-only enforcement is harness-level, and asymmetric by role.** The **reviewer** (pure diff review) launches fully locked: `claude --permission-mode` / `--disallowedTools` or `codex --sandbox read-only`. The **validator** runs gates (tests, lint, build) that *require* writes (`.pytest_cache`, `node_modules`, coverage, build artifacts), so full read-only would break its job; it launches write-capable-but-scoped — `codex --sandbox workspace-write` (or claude equivalent) confined to a disposable worktree, with Guard as the audit layer. Flags pass through `agent start … -- <args>`. Guard is **audit only** for TUI panes — its own capability table says panes expose only rendered text and interrupt is "incidental only." Optional hardening: drop a substring-alert `.herdr-guard.json` into read-only workers' cwds (guard's per-cwd project override is the closest scoping primitive; no per-pane rules exist in v1).
4. **State gating: explicit `agent wait --until`, always with `--timeout`; settle is not success.** `prompt --wait` stalls from non-working states (5s change window) and doesn't track turns, so gate with explicit `agent wait --until idle --until done --until blocked --timeout <ms>`. **A settled state means the turn ended, not that work completed** — TUI kinds settle "idle" after a clarifying question, refusal, or bare acknowledgement. On settle-without-a-complete-report (sentinel absent), issue exactly one re-prompt ("finish the task in .conductor/task.md and write .conductor/report.md"), wait once more, and on a second no-report settle escalate to human — same terminal route as a timeout. Never a silent retry loop.
5. **Teardown discipline.** There is no `agent stop`: `pane close <id>` is the stop mechanism. Never `worktree remove` with a live agent (it kills agent + workspace + worktree in one shot). Any worktree removal routes through swarm-style ownership verification. Detect dirty-tree refusals by error code (`dirty_worktree_requires_force`), never by message text.
6. **Version pin and re-verification.** All facts verified on herdr 0.7.5. Herdr broke four CLI surfaces in one release week; the adapter carries a version gate and the skill text states its verified-on version.
7. **Tier-1 reconcile is plain git, not swarm harvest.** Builder cwds are git worktrees of the target repo; builder role prompts end by committing to a per-role branch; before dispatching the validator, the conductor `git merge`s the builder branch(es) into the validation worktree the validator reads. No swarm fanout/harvest integration (that's Tier 2) — just worktrees + `git merge`, so the dogfood's builder→validator handoff has a defined path instead of an ad-hoc hand-merge that would contaminate the Tier-2 evidence.

---

## Scope Boundaries

**In scope:** the spike; the Herdr adapter section of the `feature-delivery-team` skill; a small helper script in the skill dir; one dogfood run; catalog metadata refresh.

### Deferred to Follow-Up Work

- **Tier 2 `herdr-conductor` plugin** (assemble/dispatch/status/harvest actions, lead-agents-style team config) — gated on Tier-1 dogfood verdict.
- Event-driven control loop via `herdr api events.subscribe` (polling `agent wait` is sufficient for Tier 1).
- Worktree-per-builder integration with swarm's fanout (Tier 1 uses plain git worktrees + `git merge` per KTD-7; full swarm harvest integration is Tier 2).
- Guard v2 harness-reporter hooks.

### Outside this work's identity

- Replacing Pi subagents / Claude Code Agent tool for quick, unattended feature teams.
- Windows support (both sibling plugins are macos/linux; herdr has documented Windows plugin defects).

---

## High-Level Technical Design

```mermaid
sequenceDiagram
    participant C as Conductor (any coding agent)
    participant H as herdr CLI
    participant W as Worker pane (kind-tracked)
    participant FS as worker cwd/.conductor/

    C->>FS: write task.md (full role prompt)
    C->>H: pane split --cwd <dir>
    C->>H: agent start <role> --kind <kind> --pane <id> -- <read-only flags if applicable>
    Note over H,W: start blocks until agent input-ready (30s default)
    C->>H: agent prompt <role> "Read .conductor/task.md and execute"
    C->>H: agent wait <role> --until idle --until done --until blocked --timeout <ms>
    H-->>C: settled state (turn ended — NOT proof of completion)
    C->>FS: read report.md; require <!-- REPORT-COMPLETE --> sentinel
    alt sentinel present
        Note over C,FS: authoritative result
    else absent (chatty settle / partial write)
        C->>H: one re-prompt ("finish task.md, write report.md"), wait once more
        Note over C,W: second no-report settle → escalate to human (as timeout)
    end
    Note over C,W: pane stays open for human attach/inspection
    C->>H: pane close <id> (teardown; never worktree remove with live agent)
```

State-detection reliability of the `wait` edge is the load-bearing unknown — U1 measures it before anything ships. Settle ≠ success: the report sentinel, not the settled state, is the completion signal.

---

## Implementation Units

### U1. Go/no-go spike: exercise the unexercised verbs

**Goal:** produce captured evidence that the native-path loop works reliably enough to build on — or a documented no-go.
**Requirements:** de-risks KTD-1/2/3/4 before any skill text ships.
**Dependencies:** none.
**Files:** `docs/spikes/2026-07-23-herdr-conductor/` (evidence captures, one file per lettered scenario, swarm `spike-out/` convention); `docs/spikes/2026-07-23-herdr-conductor/RESULTS.md` (verdict table).
**Approach:** throwaway git repo in scratch space; drive everything from a script inside a live herdr session (the script splits an existing pane — it is not headless), capture raw CLI output. Scenarios, run per kind across **claude, codex, and pi** (all three advertised runtimes): (a) `pane split --cwd` + `agent start --kind <kind>` — readiness gate behavior, failure mode on busy pane; (b) pointer-prompt + task-file delivery — verify the worker actually reads the file; (c) **reliability loop, split by regime** — (c1) 15× short prompt→`agent wait --until idle --until done --until blocked` cycles per kind (`--until` is repeat-to-add on 0.7.5; the comma form exits 2), and (c2) 5× long-running tasks per kind (multi-minute, ≥1 tool call each, e.g. "run the test suite then summarize"), recording misdetections, early-settles, stalls, and wall-time; (d) report round-trip — worker writes `.conductor/report.md` with the `<!-- REPORT-COMPLETE -->` sentinel, conductor reads it; (d2) settle-without-report — pointer-prompt an *ambiguous* task, confirm the no-report settle is observable and distinguishable from completion; (e) role launch flags honored **and role job still runs** — reviewer under full read-only refuses a write; validator under scoped `workspace-write` completes an actual `pytest`/`pnpm test` run in its worktree; (f) teardown — `pane close` stops the agent, no orphan daemons.
**Test scenarios:**

- Happy path: (c1) ≥ 14/15 clean settle detections per kind; (c2) **zero early-settles** per kind (idle must not fire mid-turn); (d) report present with sentinel after settle.
- Edge: `agent start` into a pane running a foreground command → expect refusal, capture error shape (machine-detectable code, not message text).
- Error: `agent wait` with 5s timeout on a busy worker → confirm timeout error code, no zombie state.
- Edge: prompt containing shell metacharacters delivered via pointer (metacharacter-laden content lives in the task file, pointer stays inert).
**Verification:** RESULTS.md states GO or NO-GO per scenario per kind with evidence file references. **NO-GO on (c1) below 14/15 OR any early-settle in (c2) halts U2–U4** and routes back to design (event-subscription fallback or Tier-1 abandonment). A **pi-only** NO-GO downgrades the adapter's supported kinds to claude/codex rather than halting; a validator that cannot complete its suite under scoped flags (e) sends KTD-3 back to design, not the whole plan.

### U2. Conductor helper script

**Goal:** one shared helper owning the herdr choreography so the skill text stays declarative and invariants live in code, not prose (cross-script invariant-drift learning).
**Requirements:** KTD-1/2/3/4/5/6.
**Dependencies:** U1 (GO).
**Files:** `skills/feature-delivery-team/scripts/conductor-lib.sh`; `tests/test_conductor_lib.py` (subprocess smoke tests of arg validation and dry-run output, following existing `tests/` conventions).
**Approach:** functions: `conductor_start_worker <role> <kind> <cwd> [-- extra argv]` (split + start + readiness handling), `conductor_dispatch <role> <task-file>` (**archive any existing `.conductor/report.md` to `report.prev.md` before** writing the pointer prompt, and stamp a dispatch timestamp), `conductor_await <role> <timeout-ms>`, `conductor_collect <role>` (read report file; **hard-fail when report.md is absent, empty, lacks the `<!-- REPORT-COMPLETE -->` sentinel, or has an mtime predating the dispatch stamp** — a stale prior-run report must never read as a fresh result; on hard-fail, run the one-reprompt-then-escalate path from KTD-4), `conductor_teardown` (pane-close sweep by conductor-owned label, ownership-verified). Version gate ≥ 0.7.5; own state under `~/.local/state/herdr-conductor/` (never swarm's namespace); slug-safe role names enforced at entry. macOS bash 3.2 compatible, matching sibling repos.
**Test scenarios:**

- Happy path: dry-run mode emits the exact herdr command sequence for a two-worker dispatch.
- Edge: role name with illegal chars → hard error before any herdr call.
- Edge: missing `--cwd` dir → hard error (mirrors swarm's contract).
- Error: herdr binary absent → clear failure message naming `HERDR_BIN_PATH`.
- Error: `conductor_collect` on absent, empty, or sentinel-less report.md → hard error routing to escalation (not empty-success).
- Error: `conductor_collect` reading a report.md whose mtime predates the dispatch stamp → rejected as stale, not returned.
**Verification:** tests pass in pi-library's suite; a manual two-worker dry run against the spike repo reproduces U1 scenario (a)–(d) through the helper.

### U3. Herdr adapter section in the skill

**Goal:** `feature-delivery-team` gains Herdr as a fourth dispatch runtime with the when-to-use framing from the verdict.
**Requirements:** the user-visible deliverable; KTD-2/3/4 surfaced as instructions.
**Dependencies:** U2.
**Files:** `skills/feature-delivery-team/SKILL.md`.
**Approach:** add a Herdr row to the Step-2 adapter table ("attended, long-running, or mixed-vendor work; workers survive the orchestrator; humans can attach mid-flight — otherwise prefer native subagents"); add a dispatch subsection: task-file + pointer-prompt contract, report-file contract appended to every role prompt, read-only launch flags for validator/reviewer per kind, explicit-wait-with-timeout rule, teardown rule, verified-on version note. Keep the five role prompts untouched — the adapter changes transport only.
**Test scenarios:** `Test expectation: none — instruction document; behavior is proven by U1 evidence and U4 dogfood.`
**Verification:** a fresh agent given only SKILL.md + the helper can dispatch a two-role team without consulting the spike docs.

### U4. Dogfood run and catalog refresh

**Goal:** one real task through the Herdr adapter; capture what breaks; refresh catalog metadata.
**Requirements:** exit gate for Tier 1; feeds the Tier-2 go/no-go.
**Dependencies:** U3.
**Files:** `library.yaml` (feature-delivery-team `description` + `last_reviewed`); `docs/solutions/` entry if a non-obvious gotcha surfaces (create dir if needed, following herdr-swarm's frontmatter convention).
**Approach:** run a small real feature (StructuPath repo, not FSW production) with builder + validator as Herdr workers, mixed kinds, reconciled per KTD-7 (builder commits to a branch; conductor `git merge`s before the validator runs). **Establish the baseline first:** run the same feature once through the existing in-process adapter (Pi subagents or Claude Code Agent tool), recording token cost and wall time, then run the Herdr adapter and compare. Record: state-detection misses, prompt-delivery friction, report-file compliance, token cost and wall time vs. that baseline.
**Test scenarios:** `Test expectation: none — validation exercise; its output is the evidence.`
**Verification:** dogfood notes written; `just validate` green after `library.yaml` edit; explicit ship/hold recommendation for Tier 2, **stated as directional** (2 of 5 roles exercised, single run) — not conclusive.

---

## Risks & Dependencies

| Risk | Treatment |
| --- | --- |
| State detection unreliable for some kind (zero prior evidence) | U1 measures it per kind, split by regime; hard gate (≥14/15 short + zero early-settle on long tasks); NO-GO halts downstream (pi-only NO-GO downgrades kinds) |
| Worker settles "idle" without completing work (chatty clarification, refusal) | Report sentinel is the completion signal, not settle state; one re-prompt then escalate (KTD-4); spike (d2) confirms the no-report settle is observable |
| Stale prior-run report harvested as fresh success | `conductor_dispatch` archives old report + stamps time; `conductor_collect` rejects sentinel-less or pre-dispatch-mtime reports (KTD-2, U2) |
| Validator's gates need writes but launch flags are read-only | Asymmetric enforcement (KTD-3): reviewer fully locked, validator scoped `workspace-write` in a worktree; spike (e) proves the suite runs |
| Herdr CLI churn (4 surfaces broke in one release week) | Version gate in helper; verified-on note in skill; re-run spike on upgrade |
| `agent prompt` size/quoting limits unknown | Pointer-prompt design makes limits irrelevant; spike (b) confirms |
| Conductor sharing a repo with a live swarm run (swarm's lock is keyed by workspace, not repo) | Documented in skill text: don't run conductor and swarm fanout on the same repo concurrently |
| Token cost of 5 full agents vs. subagents | U4 measures against a baseline run first; verdict stated as directional |

## Deferred to Implementation

- **`blocked` settle handling.** `blocked` is in every `--until` set, but the conductor's route on a blocked settle (re-prompt / attach-and-escalate / teardown) is resolved in U3 skill text, not here — it depends on what `blocked` looks like per kind, observed in the spike.
- **Conductor-crash recovery.** Whether U2's helper grows a startup sweep that adopts a prior run's labeled panes, or recovery is "human attaches to surviving panes" by design, is decided after the spike shows how cleanly labels survive.
- **Session restart mid-task.** Whether a worker kind that auto-compacts/restarts on context overflow keeps its agent name for subsequent `wait`/`collect` — observe in U1 (c2) long tasks.

## Sources & Research

- `herdr agent {start,prompt,wait,read} --help`, herdr 0.7.5, this machine (verbs + whitelist + wait semantics)
- <https://herdr.dev/docs/agent-automation/> (pattern blessed upstream)
- herdr-swarm `docs/solutions/` + `spike-out/` (lifecycle gotchas, prompt-channel precedent, invariant-drift learning) — learnings sweep 2026-07-23
- herdr-guard `docs/SPEC.md` (honest capability model; two-level rule scoping)
- Origin spec + Fable verdict: `~/dev/structupath/herdr-conductor-spec.md`

---

## Tier-2 addendum (2026-07-25) — the `herdr-conductor` plugin

Tier 1 shipped and the U4 dogfood returned **"Tier-2 plugin: GO"**. Tier 2 was then
built out in the `herdr-conductor` repo against spec §4. Two decisions diverge from
the origin spec and are recorded here in the KTD-1 style.

### KTD-8. `harvest` is plain-git reconcile, not `herdr-swarm harvest`

> **Divergence from origin spec (recorded).** Spec §4 says the `harvest` action
> should "hand to `herdr-swarm harvest` (don't duplicate merge logic)". It cannot:
> conductor worktrees are role-differentiated plain git worktrees, not swarm slots,
> so swarm's harvest reads its own run registry and finds nothing. Registering
> conductor worktrees as swarm slots would also deepen the workspace-keyed lock
> collision already listed in Risks. `conductor_reconcile` therefore implements the
> KTD-7 path this plan already specified — merge each writer branch into one
> integration worktree, report per-branch results, never force, never delete a
> branch — and the `harvest` action is a thin wrapper over it. Non-zero exit on any
> conflict or missing branch, so a caller can gate on it.

### KTD-9. The team config is JSON, not YAML

> **Divergence from origin spec (recorded).** Spec D5 says to port
> `multi-team-config.yaml`'s shape; it does not constrain serialization.
> `.herdr-conductor.json` is parsed with python3's stdlib, which the transport
> already depends on. YAML would add a pyyaml dependency that cannot be assumed on
> a plugin user's machine, and JSON matches the sibling plugin's own project
> override, `.herdr-guard.json`. The *shape* is ported: depth-1 per D1
> (orchestrator → workers, no leads), one entry per role, per-role runtime `kind`
> per D3.

### What Tier 2 shipped

| Spec §4 action | Status |
| --- | --- |
| `assemble` | Built — config → worktrees → guard drops → one agent pane per role → board |
| `dispatch` | Deliberately **not** an action (actions get no argv/TTY). Declarative instead: `conductor_render_role` renders a role template into a dispatchable task file |
| `status` | Built — live board pane, plus a one-shot `status` action |
| `harvest` | Built per KTD-8 |
| `stand-down` | Already shipped |

Also closed: dogfood **finding 4** — `conductor_status` still read
`agent read --source detection`, which returns rendered pane text, so every worker
reported `unknown`. Both it and the board now share one `agent list` parser
(`_c_agent_status_map`), with a regression test.

Mode semantics (spec D2/D3, KTD-3) are expressed as one `mode` field per role:
`write` (worktree + branch), `gated` (worktree, writes allowed for gate artifacts,
guard audit drop), `read-only` (base tree, launch-flag locked, guard audit drop).

### Still open

- Live end-to-end smoke of `assemble` → dispatch → `harvest` → `stand-down` inside
  a real herdr session. The transport verbs are dogfood-proven; the Tier-2
  choreography over them is covered by tests and dry runs, not yet by a live run.
- The spike items RESULTS.md left outstanding (codex/pi `(a)+(c)` coverage, `(c1)`
  15× per kind, `(c2)` long-task early-settle, `(d2)`, `(e)`) remain outstanding.

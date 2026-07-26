# Herdr Conductor — Adapter Spec

**Goal:** an *orchestrating agent* that drives other agents as visible Herdr panes —
by porting the proven `feature-delivery-team` role model (pi-library) and the
`lead-agents` Orchestrator→Lead→Worker hierarchy onto Herdr's native agent CLI.

**Status:** design spec, 2026-07-23. Verified against installed **herdr 0.7.5**.
Sits beside `herdr-plugins-cheatsheet.md`.

> **Built.** Tier 1 shipped (pi-library `feature-delivery-team`, dogfooded
> 2026-07-23); Tier 2 shipped as this plugin (2026-07-25). Two decisions diverge
> from what's written below — `harvest` is plain-git reconcile rather than a hand-off
> to `herdr-swarm harvest` (§4), and the team config is JSON rather than YAML (§7 D5).
> Both are recorded as KTD-8/KTD-9 in
> `docs/plans/2026-07-23-001-feat-herdr-conductor-adapter-plan.md`, which supersedes
> this spec wherever they disagree. This document is kept as the origin record.

---

## 1. The one-sentence idea

Today your orchestration prior art (`feature-delivery-team`, `lead-agents`,
`multi-agent-orchestration`, the verifier system) dispatches through **Pi
in-process subagents, tmux, or a web backend**. None of it uses Herdr. The
Conductor swaps the *transport*: same roles, same ownership discipline, but each
worker is a real Herdr agent in its own pane, driven by `herdr agent
start/prompt/wait/read`. **The orchestrator is just a coding agent that knows
these five verbs.**

## 2. What already exists (reuse, don't reinvent)

| Asset | Location | What we take |
|---|---|---|
| **Role model** | pi-library `feature-delivery-team/SKILL.md` | 5 roles (builder-engine, builder-ui, test-author, validator, reviewer), ownership table, dispatch prompts, iterate-findings routing, final report shape — verbatim |
| **Hierarchy + delegation UX** | `lead-agents/.pi/multi-team/multi-team-config.yaml` + `agents/orchestrator.md` | Orchestrator→Lead→Member structure, `delegate(team, question)` semantics, append-only conversation-log JSONL, per-agent color, mental-model expertise files |
| **Pane+agent bootstrap** | `herdr-swarm/scripts/lib.sh` → `herdr_agent_start()` | The 0.7.4-vs-0.7.5 abstraction: on 0.7.5 it's `pane split` + `pane run` + `report-agent`. **Reuse this helper directly** — it's live-verified. |
| **Worktree isolation** | `herdr-swarm` fanout/harvest/prune | Worker-per-worktree so parallel builders never collide |
| **Read-only enforcement** | `herdr-guard` | Cross-agent command policy — gate validator/reviewer to read-only |

## 3. The transport swap (the whole spec in one table)

| Concept | `lead-agents` (Pi) | **Herdr Conductor** (verified 0.7.5 verbs) |
|---|---|---|
| Orchestrator | Pi session w/ `delegate` tool | Any coding agent (claude/codex/pi) in a Herdr pane, armed with these verbs |
| Spawn a worker | `delegate(team, q)` → in-proc sub-session | `pane split` → `herdr agent start <name> --kind <kind> --pane <id>` (via swarm's `herdr_agent_start`) |
| Assign work + block | sub-session returns synchronously | `herdr agent prompt <name> "<mission>" --wait --until idle,done,blocked --timeout <ms>` |
| Gate on state | implicit (call returns) | `herdr agent wait <name> --until blocked --timeout <ms>` |
| Collect result | tool return value | `herdr agent read <name> --source recent-unwrapped --lines <n>` |
| Enumerate team | config file | `herdr agent list` |
| Event-driven loop | n/a | `herdr api` → `events.subscribe`: `pane.agent_status_changed`, `pane.output_matched`, `pane.agent_detected` |
| Conversation log | `{{CONVERSATION_LOG}}` JSONL | same — append-only JSONL in plugin state dir |

`<TARGET>` for every verb = the agent's unique live name **or** the pane id hosting it.

### Verified verb signatures (herdr 0.7.5)

```
herdr agent start <NAME> --kind <pi|claude|codex|gemini|cursor|…> --pane <ID> [--timeout MS] [-- <AGENT_ARG>…]
herdr agent prompt <TARGET> <TEXT> [--wait] [--until idle|working|blocked|done|unknown]… [--timeout MS]
herdr agent wait   <TARGET> [--until <STATUS>]… [--timeout MS]     # default matches idle,done,blocked
herdr agent read   <TARGET> [--source visible|recent|recent-unwrapped|detection] [--lines N] [--format text|ansi]
herdr agent list
herdr pane split <PANE_ID> ; herdr pane read ; herdr pane list ; herdr pane close
```

> **`prompt --wait` gotcha (from `--help`):** from a non-working state, `--wait`
> first requires an observed state change within 5000ms or it returns
> `agent_prompt_stalled`. It does **not** track turns — if the agent is already
> working, the *current* turn's completion may match. For deterministic gating,
> prefer explicit `agent wait --until` after `prompt` rather than trusting
> `--wait` alone on a busy worker.

## 4. Architecture — two tiers, ship Tier 1 first

### Tier 1 — Conductor **skill** (hours, no new repo)

Add **Herdr** as a 4th runtime adapter to `feature-delivery-team`. Everything in
that skill stays; only Step 2's adapter table gains a row and Steps 4–6 gain a
Herdr dispatch block.

```
| Herdr | pane split → agent start --kind; agent prompt --wait; agent read | Each role is a
|       | visible pane. Builders get worktrees (swarm helper). Validator/reviewer read-only via herdr-guard. |
```

This alone delivers "an orchestrating agent that drives my agents," today,
reusing 100% of the role prompts.

### Tier 2 — `herdr-conductor` **plugin** (days, only if Tier 1 earns it)

A 4th StructuPath plugin. Actions:

| Action | Does |
|---|---|
| `assemble` | Read a team config (port of `multi-team-config.yaml`), open the Conductor pane |
| `dispatch` | Decompose task → per-role `pane split` + `agent start` + `agent prompt` |
| `status` | Live board: one row per worker (name, state, pane, worktree, changed-files) — driven by `events.subscribe` |
| `harvest` | Hand to `herdr-swarm harvest` (don't duplicate merge logic) |
| `stand-down` | Stop workers, close panes, keep branches |

Conductor pane = the orchestrator agent's home; worker panes = the team.

## 5. Core loop (Tier 1 pseudocode, real verbs)

```bash
# 0. contract (from feature-delivery-team Step 1): goal, base branch, gates, ownership
# 1. per writing-role: isolate + spawn
for role in builder-engine builder-ui; do
  wt=$(swarm_worktree_for "$role")                       # reuse herdr-swarm
  pane=$(herdr pane split "$root_pane")
  herdr agent start "$role" --kind claude --pane "$pane" --timeout 60000 -- --cwd "$wt"
  herdr agent prompt "$role" "$(render_role_prompt "$role")" --wait --until idle,done,blocked --timeout 600000
done
# 2. reconcile builders, smoke gate, then test-author (fresh context) — same pattern
# 3. read-only roles IN PARALLEL, guard-enforced
for role in validator reviewer; do
  pane=$(herdr pane split "$root_pane")
  herdr agent start "$role" --kind codex --pane "$pane" -- --cwd "$base"   # base tree, no worktree
  herdr agent prompt "$role" "$(render_role_prompt "$role")"               # fire; gate below
done
herdr agent wait validator --until idle,done,blocked --timeout 300000
herdr agent wait reviewer  --until idle,done,blocked --timeout 300000
verdict=$(herdr agent read validator --source recent-unwrapped --lines 200)
# 4. iterate: route findings to narrowest owner (feature-delivery-team Step 7), re-run downstream only
# 5. final report table (feature-delivery-team Final Report)
```

## 6. The composition win (why Herdr, not Pi, for this)

Your three existing plugins compose into a full orchestration substrate — **each
does one job it already does well:**

```
CONDUCTOR decides   →  SWARM isolates      →  GUARD enforces
(orchestrator agent)   (worktree per writer)   (validator/reviewer read-only,
                                                 no worker touches forbidden paths)
```

Plus the thing Pi subagents can't give: **every worker is a real, visible,
attachable pane.** You watch the team work, `herdr agent attach` into any worker
to intervene, and the orchestrator reads the same panes you do. Observability is
free instead of a web backend (`12 multi-agent-orchestration`) or a tmux+socket
rig (`the-verifier-agent-system`).

## 7. Decisions to make before building

| # | Question | Default recommendation |
|---|---|---|
| D1 | **Depth-1 or depth-2?** lead-agents is Orchestrator→Lead→Member. In Herdr each agent is a full pane/process, so depth-2 = panes spawning panes. | **Depth-1 first** (Orchestrator→Workers = the 5 roles). Add Leads only if a single orchestrator context can't hold coordination. |
| D2 | **Read-only enforcement.** Herdr can't sandbox FS writes per-agent. | Use **herdr-guard** rules to deny write/commit verbs for validator/reviewer panes. Confirms the 3-plugin composition is load-bearing, not decorative. |
| D3 | **Worker `--kind`.** Mixed models per role? | builders=claude, validator/reviewer=codex (independent 2nd engine), test-author=claude. Matches your model-routing rules. |
| D4 | **Gating: `prompt --wait` vs explicit `wait`.** | Prefer `prompt` then `agent wait --until` for busy workers (see §3 gotcha). Reserve `--wait` for cold-start single-shot. |
| D5 | **Where does the team config live?** | Port `multi-team-config.yaml` shape into the plugin (Tier 2) or a `.herdr-conductor.yaml` the skill reads (Tier 1). |
| D6 | **Orchestrator kind.** Is the conductor itself claude, codex, or pi? | Whatever the user is driving from; the skill is runtime-agnostic — it only shells out to `herdr`. |

## 8. Phased plan

1. **Spike (½ day):** throwaway repo, 2 workers. Prove `pane split → agent start
   → prompt → wait → read` behaves under a real 2-worker loop on 0.7.5, and that
   swarm's `herdr_agent_start` helper is callable standalone. Capture any
   `agent_prompt_stalled` / timing surprises. **Gate: go/no-go on Tier 1.**
2. **Tier 1 skill (1 day):** add the Herdr adapter to `feature-delivery-team`,
   ship via pi-library. Dogfood on a real FSW/StructuPath feature.
3. **Evaluate:** does visible-pane orchestration beat Pi subagents in practice?
4. **Tier 2 plugin (2–3 days):** only if #3 says yes. `herdr-conductor`, modeled
   on lead-agents, standing on swarm + guard.

---

### Appendix — evidence trail

- Roles/prompts: `~/dev/reference/pi-library/skills/feature-delivery-team/SKILL.md`
- Hierarchy/delegation: `~/dev/structupath/Agentic Engineer/lead-agents/.pi/multi-team/{multi-team-config.yaml,agents/orchestrator.md}`
- Pane+agent bootstrap: `~/dev/structupath/herdr-swarm/scripts/lib.sh` (`herdr_agent_start`)
- Verbs: `herdr agent {start,prompt,wait,read,list} --help` on 0.7.5 (this machine)
- Docs: https://herdr.dev/docs/agent-automation/ ("one agent can create work for other agents, inspect their state, and collect their results")
- Confirmed: zero herdr references anywhere in `~/dev/structupath/Agentic Engineer/`

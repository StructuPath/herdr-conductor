---
model: opus
description: Orient yourself as orchestrator over a full-stack team that was just scripted into a herdr workspace. Reads the spawn file, confirms every agent is alive by its stable name, and gets ready to drive the lead.
argument-hint: <spawn-file path>
---

# herdr Did Spawn

## Purpose

A full-stack Flotion team was **already booted** into a herdr workspace by the
`fastherdr-cc` / `fastherdr-pi` recipe (one `layout.apply` call laid out all five
panes, then `agent start` launched a pi role agent in each). That herdr session is
shared with everything else the user is running — other teams and ordinary
terminals are sibling workspaces. Your job is to take command of *this* team:
read the spawn file, confirm the agents are up, and stand ready to drive the
**lead**. You are the orchestrator and you run in a terminal.

## Variables

SPAWN_FILE: $1   # path to the .team/<feature>.herdr-spawn.json written at spawn time

## Instructions

- **Agent names are the handles, and they are stable.** Unlike cmux's positional
  surface refs, a herdr agent name (`lead-<feature>`, `plan-<feature>`, …) does not
  renumber when panes come and go. Read them once from the spawn file and use them
  for the whole run — there is nothing to rediscover.
- **Talk to the LEAD only.** The lead dispatches its own workers (plan, build-be,
  build-fe, test). You hand the lead a feature; it does the rest.
- The team is already booted — don't re-spawn anything. If one agent failed to
  start, report that one; don't rebuild the team.
- **Never close a workspace you did not spawn.** Other workspaces in this herdr
  session belong to the user.

## Workflow

1. Read `SPAWN_FILE`:
   ```bash
   F=$(jq -r .feature "$SPAWN_FILE")
   WS=$(jq -r .workspace "$SPAWN_FILE")
   LEAD=$(jq -r .agents.lead.name "$SPAWN_FILE")
   jq -r '.agents | to_entries[] | "\(.key)\t\(.value.name)\t\(.value.pane)"' "$SPAWN_FILE"
   ```
2. Confirm herdr is reachable — if not, tell the user to start it and stop:
   ```bash
   herdr status server     # expect: status: running, compatible: yes
   ```
3. Confirm the team is alive. `agent list` reports each agent's **live** status
   (`idle` / `working` / `blocked` / `done`) from the pi integration — this is
   reported state, not a screen scrape, so trust it for liveness:
   ```bash
   herdr agent list | jq -r --arg f "$F" \
     '.result.agents[] | select(.name | endswith("-"+$f)) | "\(.name)\t\(.agent_status)\t\(.pane_id)"'
   ```
   Every one of the five should be listed. A missing name means that pi never
   started — read its pane (`herdr pane read <pane_id> --source recent --lines 40`)
   and report which role is down.
4. Spot-check that the workers acknowledged their warm-up:
   ```bash
   for R in plan build-be build-fe test; do
     printf '%s: ' "$R"; herdr agent read "$R-$F" --source recent --lines 20 | grep -m1 "ready: $R" || echo "(no ack)"
   done
   ```
5. You are now oriented. Wait for the user to give you a feature request, then hand
   it to the lead and watch it coordinate:
   ```bash
   herdr agent prompt "$LEAD" "<feature>" --wait --until idle --until done --timeout 900000
   herdr agent read "$LEAD" --source recent --lines 60
   ```
   **The prompt text is the second positional** — it must come immediately after
   the target, before any flags, or the CLI rejects it as `unknown option`.
   **`--wait` returning is not proof of success** — a worker or the lead reaches
   `idle` after any turn, including one where it stopped to ask you something.
   Always read the pane and confirm the agreed `FLOTION-DONE:` sentinel before
   calling anything finished. When you grep for it, remember the pane **echoes
   your own prompt**, so the first match is the task you just sent — the reply is
   always the *last* match:
   `herdr agent read "$LEAD" --source recent --lines 80 | grep 'FLOTION-DONE:' | tail -1`
   Don't anchor on the `⏺` reply marker: in a narrow pane the text wraps to the
   next line and the match is lost even though the agent answered.
6. Now follow the `Report` section.

## Report

```
## Orchestrating team "[feature]"  (herdr workspace [WS])

| Role | Agent name | Pane | Model | Status |
|------|-----------|------|-------|--------|
| 👑 lead | lead-[feature] | [pane] | [model] | [status] |
| 📐 plan | plan-[feature] | [pane] | [model] | [status] |
| ⚙️ build-be | build-be-[feature] | [pane] | [model] | [status] |
| 🎨 build-fe | build-fe-[feature] | [pane] | [model] | [status] |
| ✅ test | test-[feature] | [pane] | [model] | [status] |

Team is up and the workers acknowledged. Give me a feature and I'll hand it to
the lead — or say "status" and I'll read the lead back.

Teardown when done: `herdr workspace close [WS]`
```

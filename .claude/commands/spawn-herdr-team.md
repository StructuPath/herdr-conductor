---
model: opus
description: Boot a 5-agent full-stack Flotion team as a new herdr workspace — lead on the left half, plan/build-be/build-fe/test in a 2×2 on the right, each a pi agent loaded with its role. You drive herdr yourself in natural language; no scripts.
argument-hint: [team-name] [feature description...]
---

# Spawn Full-Stack Team (herdr)

## Purpose

You are an orchestrator running in a terminal. Boot a fresh 5-agent team for
Flotion as **a new herdr workspace** and, if given a feature, hand it to the
team's lead. **One team = one workspace = one feature**, and teams coexist as
sibling workspaces in the same herdr session. You do this by driving the `herdr`
CLI yourself — there is no script; this command *is* the recipe.

This is the herdr port of `/spawn-fs-team`. The shape is identical; the transport
is stronger — herdr starts agents natively (`agent start`) instead of typing a
launch line into a shell, and addresses them by **stable name** instead of
positional refs.

## Variables

TEAM: $1                 # short slug for the team; default "fs-team" if omitted
FEATURE: $2              # everything after the slug — optional feature to ship now

# Model blend (reasoning roles on GLM-5.2, build/verify on Minimax-M3)
LEAD_MODEL:  openrouter/z-ai/glm-5.2
PLAN_MODEL:  openrouter/z-ai/glm-5.2
BE_MODEL:    openrouter/minimax/minimax-m3
FE_MODEL:    openrouter/minimax/minimax-m3
TEST_MODEL:  openrouter/minimax/minimax-m3

ROLES_DIR: .claude/agents          # lead-herdr.md, plan.md, build-be.md, build-fe.md, test.md
ROSTER:    .team/<TEAM>.roster.json

## Codebase Structure

```
.claude/agents/lead-herdr.md   the lead's system prompt (herdr transport)
.claude/agents/{plan,build-be,build-fe,test}.md   the 4 workers (transport-agnostic — shared with the cmux team)
.team/                         shared memory: <team>.roster.json, backlog.md, <role>.md notes
apps/flotion/                  the app the team builds (Vue 3 + TS / FastAPI + SQLite)
```

## Instructions

- **The four verbs are `pane send-text` / `pane send-keys` / `pane read` /
  `pane close`** — but you rarely need them here. herdr gives you the agent layer
  directly: `agent start`, `agent prompt`, `agent wait`, `agent read`. Use those.
- **Agent names are the handles, and they are stable.** Namespace every name with
  the team slug (`lead-<TEAM>`, `plan-<TEAM>`, …) so sibling teams never collide.
  Names must match `^[a-z][a-z0-9_-]{0,31}$`.
- **Pane ids are `<workspace>:p<N>`** — workspace-scoped, captured at creation.
  Thread them through; never guess.
- **`agent prompt` submits.** There is no separate enter step and no per-newline
  hazard — unlike cmux's `send`, a multi-line prompt is still one prompt.
- **Argument order matters.** The prompt text is the *second positional* and must
  come immediately after the target, **before** any flags:
  `herdr agent prompt <name> "<text>" --wait --until idle --timeout N`. Put the
  text last and the CLI rejects it with `unknown option: <your text>` — and the
  agent is never prompted at all.
- **`agent_prompt_stalled` means the agent never started a turn** within ~5s of
  submission. That is almost always missing credentials, not a slow model. Check
  that the workspace actually got the API keys (step 2) before blaming anything else.
- **Settle is not success.** A worker reaches `idle` after *any* turn, including
  one where it stopped to ask a question. Always confirm the agreed sentinel in
  the pane before treating a task as done.
- The **lead** drives the workers; you drive only the lead.

## Workflow

1. **Preflight.** Set `TEAM` (default `fs-team`) and `FEATURE` from the arguments.
   Confirm the herdr server is up — if it isn't, tell the user to run `herdr` and
   stop (herdr's server is owned by the app, not something you should force-start):
   ```bash
   herdr status server        # expect: status: running, compatible: yes
   herdr --version            # this recipe requires >= 0.7.5
   ```
   Verify the pi integration is wired so agent status is real and not screen-scraped:
   ```bash
   herdr integration status | grep '^pi:'    # expect "current"; if "not installed", run: herdr integration install pi
   ```

2. **Create the team workspace.** One workspace per team, cwd at the repo root.
   Capture the workspace id and the root pane — that root pane becomes the lead.
   ```bash
   WS_JSON=$(herdr workspace create --label "$TEAM" --cwd "$PWD" --no-focus)
   WS=$(printf '%s' "$WS_JSON"   | jq -r .result.workspace.workspace_id)
   LEAD_PANE=$(printf '%s' "$WS_JSON" | jq -r .result.root_pane.pane_id)
   ```
   **If the team needs API keys** (the pi models here run through OpenRouter), pass
   them at creation — herdr has no `--env-file`, so expand a dotenv into repeated
   `--env` flags:
   ```bash
   ENVARGS=()
   [ -f .env ] && while IFS= read -r line; do
     case "$line" in ''|\#*) continue;; esac
     ENVARGS+=(--env "$line")
   done < .env
   # then: herdr workspace create --label "$TEAM" --cwd "$PWD" --no-focus "${ENVARGS[@]}"
   ```
   > Tradeoff, stated plainly: `--env` puts values in this process's argv, which is
   > readable by `ps` on this machine for the life of the call. cmux's `--env-file`
   > avoids that; herdr 0.7.5 has no equivalent. If that matters for a given key,
   > don't inject it — start the agent in a pane whose shell sources the secret itself.
   > Never echo the values back to the user.

3. **Workers in a 2×2 on the right.** Split from the lead pane, capturing each new
   pane id. This yields: lead = left half, plan = top-left of the right half,
   build-be = top-right, build-fe = bottom-left, test = bottom-right.
   ```bash
   sp(){ herdr pane split "$1" --direction "$2" --cwd "$PWD" --no-focus | jq -r .result.pane.pane_id; }
   PLAN_PANE=$(sp "$LEAD_PANE" right)   # lead now = left half
   FE_PANE=$(sp   "$PLAN_PANE" down)
   BE_PANE=$(sp   "$PLAN_PANE" right)
   TEST_PANE=$(sp "$FE_PANE"   right)
   ```

4. **Identity (tell lead from workers at a glance).**
   ```bash
   herdr pane rename "$LEAD_PANE" "👑 lead"
   herdr pane rename "$PLAN_PANE" "📐 plan"
   herdr pane rename "$BE_PANE"   "⚙️ build-be"
   herdr pane rename "$FE_PANE"   "🎨 build-fe"
   herdr pane rename "$TEST_PANE" "✅ test"
   herdr workspace report-metadata "$WS" --source spawn-herdr-team --token team="$TEAM" --token roles=5
   herdr pane report-metadata "$LEAD_PANE" --source spawn-herdr-team --state-label "working=dispatching"
   ```

5. **Start a pi agent in each pane.** herdr launches the process itself — you do
   not type a command line into a shell. Each agent loads its role file as the
   system prompt and gets a team-namespaced name. Start the **four workers first**,
   then the lead.
   ```bash
   start(){ # start <name> <pane> <role-file> <model>
     herdr agent start "$1" --kind pi --pane "$2" --timeout 60000 \
       -- --append-system-prompt "$3" --model "$4"
   }
   start "plan-$TEAM"     "$PLAN_PANE" "$ROLES_DIR/plan.md"       "$PLAN_MODEL"
   start "build-be-$TEAM" "$BE_PANE"   "$ROLES_DIR/build-be.md"   "$BE_MODEL"
   start "build-fe-$TEAM" "$FE_PANE"   "$ROLES_DIR/build-fe.md"   "$FE_MODEL"
   start "test-$TEAM"     "$TEST_PANE" "$ROLES_DIR/test.md"       "$TEST_MODEL"
   start "lead-$TEAM"     "$LEAD_PANE" "$ROLES_DIR/lead-herdr.md" "$LEAD_MODEL"
   ```
   **If a start returns `agent_pane_busy`, retry it.** A freshly split pane is not
   a startable shell for ~1–2s. Poll up to ~25 times, one second apart, before
   giving up on that one role — and report the single failure rather than
   rebuilding the whole team.

6. **Warm each worker.** A cold interactive agent opens on a welcome screen and can
   swallow its first real prompt. Spend one throwaway turn to clear it:
   ```bash
   for R in plan build-be build-fe test; do
     herdr agent prompt "$R-$TEAM" "Reply 'ready: $R' and wait for the lead." \
       --wait --until idle --until done --timeout 60000
   done
   ```

7. **Write the roster** so the lead (and you) can recover every handle:
   ```bash
   jq -n --arg t "$TEAM" --arg w "$WS" --arg f "$FEATURE" \
     --arg lp "$LEAD_PANE" --arg pp "$PLAN_PANE" --arg bp "$BE_PANE" --arg fp "$FE_PANE" --arg tp "$TEST_PANE" \
     '{team:$t, transport:"herdr", workspace:$w, feature:($f|select(.!="")),
       agents:{
         lead:      {name:("lead-"+$t),      pane:$lp},
         plan:      {name:("plan-"+$t),      pane:$pp},
         "build-be":{name:("build-be-"+$t),  pane:$bp},
         "build-fe":{name:("build-fe-"+$t),  pane:$fp},
         test:      {name:("test-"+$t),      pane:$tp}}}' \
     > ".team/$TEAM.roster.json"
   ```

8. **Brief the lead** and, if a feature was given, hand it over:
   ```bash
   herdr agent prompt "lead-$TEAM" \
     "You are the LEAD of team $TEAM. Address your workers by herdr agent name: plan-$TEAM, build-be-$TEAM, build-fe-$TEAM, test-$TEAM. Roster: .team/$TEAM.roster.json. Drive them with 'herdr agent prompt <name>' and read them back with 'herdr agent read <name> --source recent'. Completion is the FLOTION-DONE sentinel, never agent state. ${FEATURE:+Feature to ship: $FEATURE. Begin: dispatch it to plan-$TEAM, then coordinate build and test.}${FEATURE:-No feature yet — confirm your roster and wait.}" \
     --wait --until idle --until done --timeout 300000
   ```

9. **Confirm and report.** `herdr agent list` should show all five agents. Focus the
   workspace so the user sees it (`herdr workspace focus "$WS"`), then follow the
   `Report` section.

## Report

```
## Team "[TEAM]" — booted as herdr workspace [WS]

**Workspace**: [WS]   ·   **Layout**: lead (left half) + 2×2 workers (right)

| Role | Agent name | Pane | Model | Status |
|------|-----------|------|-------|--------|
| 👑 lead | lead-[TEAM] | [pane] | [model] | [status] |
| 📐 plan | plan-[TEAM] | [pane] | [model] | [status] |
| ⚙️ build-be | build-be-[TEAM] | [pane] | [model] | [status] |
| 🎨 build-fe | build-fe-[TEAM] | [pane] | [model] | [status] |
| ✅ test | test-[TEAM] | [pane] | [model] | [status] |

**Roster**: .team/[TEAM].roster.json

Teardown when done: `herdr workspace close [WS]`
```

# Contributing

Conductor is currently an attended prototype. Keep changes small, fail closed on
ambiguous state, and do not turn documentation or tests into claims that exceed
observed behavior.

## Development requirements

- Node.js 20 or the current LTS release
- Python 3.11 or newer for `tomllib` manifest checks
- Bash 3.2 compatibility on macOS
- ShellCheck
- Go only when running the pinned Actionlint command locally

Run before requesting review:

```bash
npm run check
shellcheck --shell=bash scripts/*.sh
go run github.com/rhysd/actionlint/cmd/actionlint@v1.7.7
```

`npm run check:evidence` validates retained B0 and B4 evidence without touching
Herdr. The live B4 harness is not a routine test: it creates real disposable
workspaces, repositories, a worktree, and a supported agent pane, and refuses
unless invoked with the exact explicit opt-in:

```bash
CONDUCTOR_STAGE1_LIVE_SMOKE=I_UNDERSTAND_THIS_USES_LOCAL_HERDR npm run smoke:stage1:live
```

Run it only against the exact supported local Herdr runtime. Commit sanitized
evidence and capture retention facts before deleting its temporary repositories.
Never substitute direct module imports, fake entrypoints, or an existing user
workspace for the live gate.

CI repeats tests on Node 20 and current LTS, exercises the suite on macOS with the
system `/bin/bash`, and runs manifest, documentation, shell, and workflow checks.

## Change boundaries

- Do not source new state formats as shell. New state must be parsed as strict,
  non-executable data and reject corrupt, symlinked, duplicate, or mismatched
  identity before mutation.
- Changes to run selection, pane close, worktree lifecycle, branch merge, or
  cleanup require negative tests proving zero mutation for foreign or ambiguous
  resources.
- Guard and prompts are advisory. Describe filesystem or process enforcement only
  when a native harness/OS control and post-condition test prove it.
- Do not claim durable recovery, verified ownership, read-only enforcement, or
  live compatibility without retained evidence for the exact runtime and
  Conductor base. B4 evidence does not by itself authorize a release.
- Keep Swarm and Conductor separate. Supported composition is a sequential,
  human-selected commit handoff, not shared private state or lifecycle.
- Stand-down may archive strict state and close only a full live tuple match. It
  must never remove worktrees, branches, artifacts, reports, recordings, logs,
  Guard files, or legacy inventory.

Runtime contract changes must update the manifest, README, role guidance, tests,
and canonical suite documentation together. The strict runtime and its journal
are the sole current lifecycle and observed-resource authority.

## Review checklist

A pull request should state:

1. whether runtime behavior or only documentation/quality gates changed;
2. the failure boundary and any destructive surfaces touched;
3. exact tests/static checks run and their output;
4. current limitations and residual risks;
5. whether manifest, package, README, suite docs, and vendored transport remain
   in agreement.

Never include credentials, full agent transcripts, recordings, or unsanitized
state files in an issue, pull request, or test fixture.

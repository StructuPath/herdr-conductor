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
  live compatibility without retained evidence for the exact release.
- Keep Swarm and Conductor separate. Supported composition is a sequential,
  human-selected commit handoff, not shared private state or lifecycle.
- Do not use the current `stand-down` action to test cleanup. It trusts executable
  global state and recorded pane IDs.

Runtime contract changes must update the manifest, README, role guidance, tests,
and canonical suite documentation together. Changes to
`scripts/conductor-lib.sh` also require an explicit pi-library vendoring check;
do not assume the copies synchronize automatically.

## Review checklist

A pull request should state:

1. whether runtime behavior or only documentation/quality gates changed;
2. the failure boundary and any destructive surfaces touched;
3. exact tests/static checks run and their output;
4. current limitations and residual risks;
5. whether manifest, package, README, suite docs, and vendored transport remain in
   agreement.

Never include credentials, full agent transcripts, recordings, or unsanitized
state files in an issue, pull request, or test fixture.

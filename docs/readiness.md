# Conductor operational readiness

Conductor 0.4.0 supports attended task/report coordination and single-ref local
apply on exactly Herdr 0.7.5 (protocol 17, API schema 1). The manifest minimum
does not imply compatibility with newer Herdr releases. Seven installed actions
share one runtime; there is no compiled bundle or dependency installation step.

## Prepare a first run

1. Check `node --version`, `python3 --version`, `git --version`, and
   `herdr --version` against the [README requirements](../README.md#supported-contract).
2. Run `npm run check` in this checkout. It validates scripts, the manifest,
   documentation, historical evidence, and automated behavior. Shell validation
   checks each entrypoint individually without executing it.
3. Follow the [configuration contract](../README.md#configuration) in the
   intended invoking repository. Commit the configuration before assembly.
   Start with configuration v2 or v3 with `"apply": null` when local apply is
   not required. Choose explicit producer ownership and required commands.
4. Invoke the installed actions from the intended Herdr workspace. Inspect the
   returned task/source/outbox paths and give workers their exact task-bound
   publisher command. Every transition is attended.
5. Collect reports with harvest and inspect the exact integrated result. If
   applying, use preview's exact approval command and receipt contract before
   invoking apply. The target must be an existing local branch at the integration
   base and not checked out in any worktree.
6. Stand down after inspection. Archive retains all product resources; plan
   capacity for worktrees, branches, reports, and logs.

## Validation and remaining work

`npm run check` is the routine build/validation equivalent for this script-based
plugin. Before review also run `npm run test:stage2` (includes Stage 3),
`npm run check:shellcheck`, and `npm run check:workflow`. The latter validates
workflow syntax; it does not change CI configuration.

Automated tests use isolated Git repositories and a fake Herdr executable,
including real subprocess crashes, lock contention, rejected reports, gate
snapshots, and apply consumption/re-observation. Passing them is not a new live
installation or release attestation. Retained Stage 1/2 evidence remains bound
to its historical source commits. The opt-in live evidence workflow requires
the independent exact-source review described in [CONTRIBUTING](../CONTRIBUTING.md).

Priorities for subsequent work:

- The [installed-action developer smoke](evidence/2026-09-14-developer-installed-action-smoke.md)
  covers Stage 3 preview, attended apply, replay, and completed stand-down on
  exact Herdr 0.7.5 with deterministic local workers. Validate real agent
  integrations before broader deployment claims; preserve the separate formal
  evidence and independent review requirements.
- Test additional Herdr versions explicitly before widening the exact runtime
  contract or the website's compatibility claims.
- Improve operator guidance for retained resources and uncertain pane/agent
  operations without introducing automatic deletion or inferred recovery.
- Evaluate suite adapters as a separate design. Conductor currently does not
  invoke Swarm, and Guard observations do not grant apply approval.

The [security boundaries](../SECURITY.md) continue to apply: coordination and
receipts are cooperative same-UID records, worker reports are assertions, and
only the Stage 3 apply publication has bounded uncertainty resolution.

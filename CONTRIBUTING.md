# Contributing

Conductor `0.4.0` is attended Stage 2 and Stage 3 software for exactly Herdr
`0.7.5`. Changes must stay fail-closed, preserve one runtime authority, and
avoid claims beyond implemented and independently checked behavior.

## Development requirements

- Node.js 20 and the current LTS release
- Python 3.11 or newer
- Git with SHA-1-width object IDs
- macOS system Bash 3.2 compatibility and Linux Bash
- ShellCheck
- Go for the pinned Actionlint command

Run before requesting review:

```bash
npm run check
npm run test:stage2
shellcheck --shell=bash scripts/*.sh
go run github.com/rhysd/actionlint/cmd/actionlint@v1.7.7
```

CI checks full Git history on Node 20/current LTS Linux and Node 20 macOS,
including real worktrees, concurrency, true `SIGKILL`, descriptor-held teardown,
Python compilation, Bash 3.2 syntax/execution, ShellCheck, documentation,
manifest, historical evidence, and pinned Actionlint.

## Change boundaries

- `scripts/stage1-runtime.mjs` remains the one implementation behind assemble,
  board, status, harvest, preview, apply, and stand-down. Do not add a
  competing runtime.
- Task/outbox authority must be durable before pane/agent creation. Reports use
  only bounded stdin and one exact task-bound destination.
- Preserve complete producer selection, collector-computed paths, deterministic
  integration, zero-or-one target CAS, exact-SHA detached gate sources, and
  deterministic stand-down close prefixes.
- Keep validator source outputs and all report artifacts empty in schema v1.
- Treat worker and reviewer fields as unauthenticated assertions, never proof,
  approval, authorization, signature, or attestation.
- Missing, malformed, foreign, stale, duplicate, replayed, raced, or ambiguous
  authority must have negative tests proving zero forbidden effects.
- Product runtime never removes worktrees, branches, tasks, outboxes, reports,
  gate sources, artifacts, recordings, logs, or state. Only the explicit live
  harness may delete its exact identity-bound disposable inventory.
- Stage 3 stays the documented attended single-ref apply: journal-only
  fixed-statement approval receipts, durable consumption before any effect,
  exactly zero or one fast-forward apply CAS per attempt, and uncertainty
  resolution only for the apply publication by exact re-observation. Do not add
  approval delegation, multi-ref or non-fast-forward apply, or resolution for
  any other operation.
- Do not add suite adapters, unattended
  launch, Browser/Guard/Swarm promotion, site changes, push/release automation,
  cleanup/prune/migration/expiry, or newer-Herdr claims.

## Candidate and evidence sequence

Commit A contains implementation, tests, docs, roles, package/manifest, CI,
fixed source definition, harness, trio contract, and checker—but none of the
three Stage 2 live result files or a live-success claim.

1. Run every candidate/static/platform check available locally.
2. Commit and re-run checks at an immutable clean Commit A.
3. Generate the exact source manifest externally and obtain an independent
   canonical review over every listed path. The retained review uses only the
   fixed independent-human, independence, and GO tokens and requires an empty
   findings list; those assertions remain unauthenticated. Any finding or source
   change invalidates A.
4. Only then, with explicit opt-in, run the installed-plugin harness against
   exact A and an empty external `0700` output parent.
5. Validate the complete post-teardown trio, remove external staging inputs, and
   create Commit B by adding exactly:
   - `docs/evidence/stage2-runtime-source-manifest.json`
   - `docs/evidence/2026-07-28-stage2-live-contracts.json`
   - `docs/evidence/2026-07-28-stage2-live-contracts.md`
6. Run `npm run check`, `npm run check:release`, full CI, and independent final
   provenance review. Maintainers alone decide whether to tag/release.

The live run is not a routine development command and must not be run for Commit
A preparation. Never fabricate, hand-edit, reinterpret, or partially commit a
result trio. A complete trio after a post-proof crash may only be revalidated and
fsynced by the attended finalizer; it is never rewritten or automatically
completed.

Historical Stage 1 B0/B4 artifacts remain byte-for-byte retained and are checked
against their recorded candidate trees. Do not regenerate them for Stage 2.

## Review checklist

A pull request must state:

1. exact base/head and whether runtime authority changed;
2. touched effect/crash boundaries and zero-effect negatives;
3. exact tests/static/platform checks and output counts;
4. current same-UID, TOCTOU, assertion-only, retention, SHA-width, and
   no-recovery limitations;
5. whether package, manifest, README, SECURITY, private-state docs, roles,
   source definition, evidence inventory, and CI agree; and
6. explicit confirmation that no adapter, unattended, product cleanup,
   Browser, site, push, tag, or release change entered scope, and that Stage 3
   changes stay inside the single-ref attended apply boundary.

Never include credentials, tokens, private paths/state, raw action output,
prompts, transcripts, recordings, customer data, or unsanitized evidence.

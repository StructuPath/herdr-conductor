# Security policy

## Supported scope

Conductor `0.4.0` provides Stage 2 **attended-operational** strict task/report
contracts and the Stage 3 attended single-ref apply on exactly Herdr `0.7.5`,
protocol `17`, API schema `1`, under one cooperative OS user. The seven actions
preserve physical repository/workspace/run identity, strict private state, one
repository mutation lock, journaled crash truth, deterministic zero-or-one
target compare-and-swap for integration and for apply, exact-SHA gate sources,
and exact-identity stand-down/archive.

These controls prevent accidental authority confusion; they are not
authentication, sandboxing, signatures, or remote attestation. Worker-reported
`delivered`, `approve`, `pass`, command/criterion results, identity, evidence, and
external reviewer identity/independence/findings are unauthenticated assertions.
They do not by themselves authorize apply, release, or any other effect. Stage 3
approval receipts are unauthenticated same-UID operator records: fixed-statement
journal entries, not signatures, credentials, or delegated authority.

## Preserved boundaries

- Every source-capable pane/agent starts only after its immutable task and empty
  private outbox are durable and journal-observed.
- The bounded-stdin publisher accepts one task-bound canonical report and never
  accepts a destination or payload path. Partial/duplicate/changed publication
  inventory fails closed.
- Collector-computed Git changes must exactly equal declared changed paths, fall
  under exactly one owned prefix, and avoid forbidden prefixes.
- All producers must have accepted completed/delivered reports before one
  deterministic integration plan can perform one target CAS. Missing, failed,
  rejected, conflicted, drifted, or raced input performs zero CAS.
- Reviewer/validator sources are distinct detached worktrees at the exact
  integration SHA. Report outboxes are outside source; schema-v1 gate changed
  paths, source outputs, and artifacts are empty.
- Stand-down binds one deterministic close set and closes only an exact live
  pane/agent/cwd tuple. It retains every product worktree, branch, task, outbox,
  report, gate source, artifact, recording, log, and operation record.
- Stage 3 preview performs zero Git mutation; an approve receipt is durably
  consumed before any apply effect and never authorizes a second
  compare-and-swap; the apply moves exactly one configured local ref by
  fast-forward from its previewed SHA. An uncertain apply publication is
  resolved only by attended exact re-observation of that ref, and any foreign
  observation fails closed permanently.
- No product cleanup, prune, migration, expiry, adoption, suite adapter,
  unattended launch, Browser promotion, site repin, push, remote publication,
  or deployment is implemented. Ambiguous-operation resolution exists only for
  the Stage 3 apply publication.

## Residual risks

- A malicious or racing same-UID process can read, chmod, replace, or fabricate
  local state/evidence and mutate Git common state. Modes and digests do not
  authenticate it.
- Final filesystem/Git checks and Herdr pane-ID close retain same-user TOCTOU
  windows. Herdr `0.7.5` offers no conditional close tuple.
- A crash after possible pane close, archive publication, or evidence unlink
  remains uncertain; Stage 2 does not infer success or replay it. A crash
  around the Stage 3 apply CAS is resolved only by attended exact
  re-observation, never inferred or replayed.
- Retained product state consumes cumulative disk; no product expiry or cleanup
  API exists.
- Only 40-hex SHA-1-width Git repositories are supported.
- Guard is observational and cannot prove prevention. Role modes and read-only
  file modes are cooperative boundaries, not a malicious-process sandbox.

## Installed evidence harness

The live harness is a separate explicit destructive test boundary, never a
product action. It requires immutable clean Commit A, a complete exact-source
external review with no blocker/high/medium finding, exact Herdr versions, a
private empty output parent, and the opt-in phrase. It creates no result files
before positive teardown proof.

Disposable resources are controlled by a nonce-bound, sealed, descriptor-held
manifest and deleted only by exact recorded identity. Unsupported primitives,
substitution, unexpected inventory, or uncertainty retain residue. Because
Herdr `0.7.5` does not forward action environment variables, the harness also
binds the exact previously absent repository-keyed child beneath normal private
state, captures its retained inventory, removes only that child through a held
private parent descriptor, fsyncs the parent, proves it absent, and proves
neighboring state identity/bytes unchanged. This narrow harness-only exception
is not product cleanup authority and does not weaken the runtime state contract.

The post-proof trio retains only a domain-separated output-parent binding digest,
not local path/device/inode/UID metadata. It excludes prompts, transcripts, raw
command output, sockets, secrets/tokens, environment, private paths, and artifact
contents. Same-UID fabrication remains outside the guarantee.

## Reporting a vulnerability

Report command injection, cross-repository/workspace mutation, report authority
confusion, path-policy bypass, wrong-tree validation, unsafe pane close, or broad
harness deletion privately through
[GitHub Security Advisories](https://github.com/StructuPath/herdr-conductor/security/advisories/new).
Include Conductor/Herdr versions, OS, exact action or function, sanitized steps,
expected refusal, observed effect, and whether a crash boundary was involved.
Do not attach credentials, tokens, raw private state, full paths, prompts,
transcripts, recordings, customer data, or unsanitized action output.

A maintainer should reproduce in an isolated repository and avoid destructive
cleanup until exact identity is proven. Coordinate disclosure and release only
after a bounded fix, negative regression evidence, exact candidate review, and
all applicable release gates.

## Verification

```bash
npm run check
npm run test:stage2
shellcheck --shell=bash scripts/*.sh
python3 -m py_compile scripts/harness-fs-helper.py
go run github.com/rhysd/actionlint/cmd/actionlint@v1.7.7
node --test tests/stage1-runtime-*.test.mjs tests/stage2-*.test.mjs \
  tests/stage3-*.test.mjs
```

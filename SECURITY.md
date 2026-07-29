# Security Policy

## Supported scope

Conductor `0.2.0` is Stage 1 **attended-operational** software for cooperative
processes under one OS user, supported only on exactly Herdr `0.7.5`. Worktrees,
Guard observations, hashes, file modes, prompts, private state, and retained live
evidence are coordination and review aids, not authentication, authorization, or
isolation boundaries against a malicious same-user process.

The complete lifecycle is not approved for unattended or destructive use. All
five actions enforce the exact supported Herdr runtime before reading or mutating
lifecycle state. Stage 1 B3
binds all five actions to strict repository/workspace JSON state. Attended
harvest binds its target at assemble time, merges immutable SHAs with plumbing,
and compare-and-swaps the exact validated target ref. Stand-down rechecks the
full live pane/agent tuple immediately before close, archives strict state, and
deletes no retained resources. Important holds remain:

- Herdr pane close accepts only `pane_id`, so a same-user TOCTOU remains after the
  final identity read;
- failed/timed-out merge or close is ambiguous and requires manual recovery;
- private archive state/pointer transitions are exactly retryable, but no
  ambiguous external merge or close is automatically recovered;
- role modes do not enforce read-only behavior;
- Guard observes rendered text but cannot prove prevention;
- strict task/report, verdict, and approval contracts are not implemented.

The retained B4 report is sanitized operator-observed local evidence anchored to
a candidate Git tree, source manifest, and deterministic checker. It is not a
cryptographic remote attestation and cannot authenticate against evidence
fabricated by another process running as the same OS user.

Legacy shell state is never B3 authority and is not sourced, migrated, adopted,
or dual-written by plugin actions. Do not run Swarm and Conductor concurrently
against one Git common directory. Preserve recovery-required state and panes for
manual inspection rather than guessing ownership.

## Reporting a vulnerability

Report command injection, wrong-repository mutation, foreign pane/worktree
cleanup, state confusion, or sandbox-claim defects privately through
[GitHub Security Advisories](https://github.com/StructuPath/herdr-conductor/security/advisories/new).
Include the plugin/Herdr versions, OS, action or function, sanitized reproduction
steps, and whether any pane, worktree, ref, or file changed.

Do not attach credentials, recordings, full terminal transcripts, absolute home
paths, or raw state that may contain secrets. Replace sensitive values while
preserving the field shape needed to reproduce the issue.

A maintainer should acknowledge a report, reproduce it in an isolated repository,
and avoid destructive cleanup until identity is proven. Public disclosure and
release timing are coordinated after a fix and negative regression evidence are
available.

## Verification

Run the complete release gate and the canonical split runtime suite before
accepting security-sensitive lifecycle changes:

```bash
npm run check
node --test tests/stage1-runtime-*.test.mjs tests/state-kernel.test.mjs
```

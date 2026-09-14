# Installed-action developer smoke — 2026-09-14 UTC

The installed Conductor lifecycle passed on an isolated, running Herdr 0.7.5
server after fixing argument-free stand-down following Stage 3 apply.

This is bounded developer smoke evidence, not the formal Stage 2 result trio,
an independent-human source review, release attestation, or production approval.
Historical evidence and its review requirements remain unchanged.

## Tested source and environment

| Field | Observed value |
| --- | --- |
| Corrected candidate | `0f0e907742292b733d3bb8cf569096fbe265beba` |
| Plugin version | `0.4.0` (unreleased fix; no version bump) |
| Herdr client and server | `0.7.5` |
| Server protocol / API schema | `17` / `1` |
| Platform | macOS, Apple Silicon |
| Installed-action and report-publisher Node | `24.18.0` |
| Attended approval-recorder Node | `26.4.0` |
| Official runtime asset | [herdr-macos-aarch64, v0.7.5](https://github.com/herdrdev/herdr/releases/tag/v0.7.5) |
| Runtime asset SHA-256 | `37350546b0012555943b92eaf962665de4e264395baeb44227b8015e8ff5b0d6` |

The candidate was cloned at the exact commit and remained clean. A private
temporary root contained a dedicated API socket, XDG config/state directories,
plugin registry, synthetic Git repositories, and explicit absolute Conductor
state. No default session or production repository was used. The synthetic
repositories had no remotes.

A local shell fixture occupied the Pi worker slots and reported synthetic
session identities using Herdr's `herdr:pi` integration protocol. It invoked no
model and read no agent credentials. The operator made the deterministic change
and inspected the validator snapshot, then published reports through the actual
candidate report publisher. This tests installed plugin actions and real Herdr
transport; it does not validate a real Pi/model integration or autonomous work.

## Failure found and correction

Candidate `bf67d318067c60318dcd7089897f513bfefe3af7` successfully previewed,
approved, applied, and replayed the fixture result, but its installed stand-down
action failed with `bookkeeping_unknown: stand-down reason does not match
lifecycle state`. No worker panes were closed by that failed action.

The action supplies no reason. The runtime defaulted to `operator_abandoned`,
while an applied run correctly permits `normal_completion` only. The corrected
candidate selects `normal_completion` for an applied run when the reason is
omitted. Explicit invalid reasons, other lifecycle defaults, recorded restart
authority, and archive replay retain their existing checks. A regression failed
before this change and passed afterward.

Initial fixture setup also exposed the expected refusal when no recognized
worker session identity was present. Those failed runs were retained; a fresh
repository/run was used after correcting the fixture's session reporting. No
journal or run authority was rewritten to advance a failed run.

## Observed corrected workflow

1. Linked the exact candidate in the isolated registry and confirmed all seven
   installed actions. Committed configuration v3 with one builder, one validator,
   and an existing unchecked-out `refs/heads/live-apply-target` at the fork SHA.
2. Invoked installed assemble, board, and status. The builder's real worktree,
   pane, task, outbox, and session identity were observed.
3. Committed `src/smoke.txt` containing `verified local fixture` plus a newline,
   published the builder report, and invoked harvest. Integration performed one
   ref compare-and-swap and dispatched the validator at the exact final SHA.
4. Checked the validator's file content and detached HEAD against its task's
   integration SHA, published its report, and harvested it successfully.
5. Invoked preview and inspected the exact target, one-file diff, and accepted
   validator assertion. The target remained at its original SHA. Apply without
   a receipt and a malformed receipt were refused.
6. The attending operator recorded a canonical approval for that exact preview,
   then invoked installed apply. One approval consumption preceded one apply
   publication in the durable journal; the target moved once to the final SHA.
7. Repeated apply. It returned the recorded outcome with `replayed: true`.
   There remained one consumption and one publication, and the target reflog
   contained only its branch-creation entry and the single apply update.
8. Invoked installed stand-down with no reason. It archived the run and closed
   exactly the builder and validator panes, leaving the invoking root pane.
   Repeated stand-down returned the archived result with `replayed: true`.

| Final observation | Value |
| --- | --- |
| Apply target before | `6e67b667f187651a21826fdf5e255128dc9f4e70` |
| Apply target after | `30e7ac2ebda9fcdc34883aeaa704c05a916a315e` |
| Fixture file SHA-256 | `77a2cdc00810ab5cbd0be50c7895f7af8bfd7b77a2d6d24a3450e87883311685` |
| Approval consumption / publication sequence | `16` / `17` |
| Apply CAS count | `1` |
| Retained Git worktrees after stand-down | `3` |
| Worker panes closed by stand-down | `2` |

Tasks, reports, journals, branches, and worktrees remained retained. The isolated
plugin was unlinked and its dedicated server stopped; process exit and socket
removal were checked. Temporary fixture resources were retained privately for
inspection. Raw paths, session identifiers, pane output, and private state are
not included in this public record.

## Coverage limits

No newer-Herdr compatibility, real model-agent integration, broad production
readiness, target-drift/rejection matrix, or live crash-recovery claim follows
from this smoke. Crash boundaries and the broader refusal matrix remain covered
by automated tests. These observations and synthetic worker reports are not
authenticated. The formal evidence runner and finalizer were not invoked, and
no independent-human GO record or historical result trio was fabricated or
replaced.

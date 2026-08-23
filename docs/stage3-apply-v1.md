# Stage 3 Apply v1 — preview, approval, consumption, apply, recovery

Stage 3 v1 adds one attended, strict, fail-closed path from a finished Stage 2
run to one explicit Git ref move. It is cooperative same-UID coordination on
exactly Herdr `0.7.5`, not authentication, sandboxing, remote publication, or
unattended orchestration. Every Stage 3 transition is explicitly invoked by an
attended operator.

## What Stage 3 v1 is

After Stage 2 collects every configured gate report, the operator may:

1. **preview** — derive and durably journal one zero-effect preview document
   binding the exact run, integration, gate-report, and apply-target state;
2. **approve** — record one attended approval receipt bound to the exact
   preview journal entry through bounded stdin;
3. **consume** — durably spend that receipt for exactly one apply attempt
   before any Git effect;
4. **apply** — move the configured apply ref with exactly zero or one
   compare-and-swap from its precommitted SHA to the integrated final SHA; and
5. **recover** — resolve a crash between consumption and observation by exact
   Git re-observation, because the apply effect is a single atomic ref update
   whose outcome is exactly observable.

Approval receipts, like every other worker or operator field, are
unauthenticated same-UID records — not signatures, authorization proof, or
remote attestation. Recovery exists for the apply publication only; Stage 2
pane/agent/external effects retain their existing no-recovery boundary.

## Configuration v3

Stage 3 requires configuration `version: 3`, which is exactly configuration v2
plus one required top-level `apply` member:

```json
{
  "version": 3,
  "state_root": { "kind": "default" },
  "worktree_root": ".conductor-worktrees",
  "apply": { "target_ref": "refs/heads/release" },
  "roles": [ ... ]
}
```

- `"apply": null` declares Stage 3 disabled; the run behaves exactly as
  configuration v2.
- `apply.target_ref` is a full `refs/` ref name. It must differ from the
  integration target branch ref observed at `integration.bind`; preview fails
  closed otherwise.
- Configuration v2 remains accepted and byte-for-byte unchanged in meaning;
  v2 runs have no Stage 3 operations.

The configuration digest binding is unchanged: every action rereads the
configuration and refuses a changed run-bound digest.

## Attempt model

Stage 3 operations are grouped into **apply attempts**. An attempt is minted at
preview with one fresh attempt generation `g` and owns exactly four operation
ids:

| Operation id | Operation type | Subject kind | Effect |
| --- | --- | --- | --- |
| `apply-preview-<g>` | `apply.preview` | `apply` | none |
| `apply-approve-<g>` | `approval.record` | `approval` | none |
| `apply-consume-<g>` | `approval.consume` | `approval` | none |
| `apply-publish-<g>` | `apply.publish` | `apply` | zero or one ref CAS |

A new attempt is legal only when configuration v3 declares an apply target,
the lifecycle is `gate_reports_collected` or `integration_harvested_no_gates`,
and either no attempt exists or every prior attempt is closed. An attempt is
closed when its `apply.publish` is observed with outcome `unapplied`, or its
`approval.record` is observed with decision `reject`. An attempt whose
`apply.publish` is observed with outcome `applied` terminates Stage 3 for the
run: no further attempt is ever legal. At most 8 attempts may exist. Any
non-observed Stage 3 journal entry must be resolved before any new Stage 3
operation.

## Preview contract

`preview` is an attended action. It requires complete strict Stage 2
authority: one active version-2 run, validated run configuration binding, one
observed `integration.reconcile` and `integration.harvest`, and one accepted
completed report from every configured gate role (or a gateless
`integration_harvested_no_gates` run). It then observes, all under the
repository mutation lock:

- the live integration target: its ref must still resolve to the integrated
  `final_sha` with clean tracked state;
- the configured apply ref: it must exist, must not be the integration branch
  ref, must not be checked out in any worktree of the repository, and must
  resolve to exactly the integration `starting_sha` (the run's fork SHA), so
  the proposed move is a pure fast-forward that cannot discard commits;
- the deterministic change summary between `starting_sha` and `final_sha`
  (`git diff --name-status` byte digest and path count).

The preview document is the operation's observed identity:

- `document_type: "herdr-conductor-stage3-preview"`, `schema_version: 1`
- run scope (repository key, workspace, run id, run generation)
- integration binding (target ref, starting SHA, final SHA, integration
  entry digest)
- gate binding: for every configured gate role in byte order, its task digest,
  report digest, and asserted verdict fields — recorded as unauthenticated
  worker assertions
- apply binding: target ref, observed SHA (= starting SHA), proposed final
  SHA, `diff_name_status_sha256`, `changed_path_count`
- `attempt_generation`

Preview performs zero Git mutations. A preview whose observation does not
match a re-observation inside the journaled effect fails closed. Any drift of
the apply ref or integration ref fails closed with zero recorded authority.
Gate reports asserting non-positive verdicts do not block preview; the
verdicts are recorded in the document and the decision remains the attended
operator's. The action prints the preview document, its journal entry digest,
and the exact approval command.

## Approval receipt contract

Approval is recorded by the attended CLI (`npm run apply:approve`), not by a
Herdr action, because it requires bounded stdin. The recorder accepts at most
16384 bytes, reads only stdin through actual EOF, and requires canonical
bytes. The receipt is:

- `document_type: "herdr-conductor-stage3-approval"`, `schema_version: 1`
- run scope
- `preview`: the attempt generation and the exact observed preview journal
  entry digest
- `decision`: `"approve"` or `"reject"`
- `statement`: exactly
  `I_ATTENDED_THIS_EXACT_PREVIEW_AND_APPROVE` for approve or
  `I_ATTENDED_THIS_EXACT_PREVIEW_AND_REJECT` for reject

The recorder validates the receipt against the live journal under the
repository lock and requires the referenced preview to be the newest, still
open attempt. An `approve` receipt additionally requires the preview to still
be live (integration and apply refs unchanged); a `reject` receipt records on
a drifted target too, so an attempt can always close. The recorder journals
`approval.record` with the receipt as observed identity and the receipt digest
as request digest. The journal is the only durable approval store; there is no
approval file slot, payload path, destination, alternate FD, environment
payload, or replacement receipt. A second receipt for the same attempt is
refused (`replay_refused` when byte-identical, `operation_conflict`
otherwise). A `reject` receipt closes the attempt durably.

The receipt remains an unauthenticated operator record. Fixed statement
tokens exist so no free-text claim can masquerade as broader authority.

## Consumption and apply contract

`apply` is an attended action. With an approve receipt observed for the
newest attempt and no uncertain Stage 3 entries, it:

1. revalidates complete strict journal, configuration, and receipt-binding
   authority;
2. journals `approval.consume`, whose observed identity binds the approval
   journal entry digest and the attempt generation — the receipt is spent
   before any Git effect and is never reusable, whatever follows;
3. journals `apply.publish`, whose effect decides the attempt's single
   durable outcome: a live target (integration ref still `final_sha`, apply
   ref still `starting_sha`, not checked out anywhere) moves through the
   single compare-and-swap
   `git update-ref <target_ref> <final_sha> <starting_sha>` after one final
   in-effect preflight and is revalidated at exactly `final_sha`; a drifted
   target records outcome `unapplied` with zero CAS, closing the attempt so
   the run always progresses.

The apply outcome document is the observed identity:

- `document_type: "herdr-conductor-stage3-apply"`, `schema_version: 1`
- run scope, attempt generation, consumed approval entry digest
- `target_ref`, `expected_sha` (= starting SHA), `final_sha`
- `cas_count`: `1` for `applied`, `0` for `unapplied`
- `outcome`: `"applied"` or `"unapplied"`

A drift observed before the CAS performs zero target CAS and durably closes
the attempt; its receipt is already consumed and a fresh attempt (new
preview, new receipt) is required. The action never retries the CAS, never
force-updates, never touches any other ref, never pushes, and never deletes
or rewrites anything.

## Recovery contract

A crash after `approval.consume` is observed but while `apply-publish-<g>` is
non-observed (phase `intent` or `needs_attention`) leaves the run
`apply_uncertain`. Every other Conductor surface keeps refusing with
`recovery_required`. The attended `apply` action alone may resolve it: it
first reclaims the repository mutation lock when — and only when — the
retained owner process is dead and held exactly the apply action's own
operation id (any other retained lock keeps refusing), then resolves under
the lock by exact re-observation of the target ref:

- ref resolves to exactly `final_sha` → the effect completed; the entry is
  transitioned to `observed` with outcome `applied`, `cas_count: 1`;
- ref resolves to exactly `starting_sha` → the effect did not complete; the
  entry is transitioned to `observed` with outcome `unapplied`,
  `cas_count: 0`, closing the attempt;
- any other SHA, a missing ref, or an unreadable repository → resolution is
  refused (`foreign_or_stale`); the run stays `apply_uncertain` and no Stage 3
  operation is ever again legal for the run.

Resolution transitions the exact retained journal entry through the same
durable rewrite used by intent→observed, preserving the hash chain, and
removes the operation guard. Recovery never mutates Git, never replays the
CAS, and exists only for `apply.publish` — no other Conductor operation gains
recovery in Stage 3 v1.

## Lifecycle states

Stage 3 adds these disjoint stable states after `gate_reports_collected` /
`integration_harvested_no_gates` for configuration v3 runs with a non-null
apply target:

| State | Meaning | Legal next operations |
| --- | --- | --- |
| `apply_previewed` | newest attempt has an observed preview, no receipt | approval record, stand-down |
| `apply_approved` | approve receipt observed, not consumed | apply, stand-down |
| `apply_rejected` | newest attempt closed by reject receipt | new preview, stand-down |
| `apply_consumed` | receipt consumed, publish not yet journaled | apply, stand-down refused |
| `applied` | publish observed with outcome applied | stand-down |
| `apply_voided` | newest attempt publish observed unapplied | new preview, stand-down |
| `apply_uncertain` | publish non-observed | attended apply resolution only |

Stand-down from `applied`, `apply_rejected`, and `apply_voided` uses
`normal_completion`, `operator_abandoned`, or the states' existing reasons;
stand-down is refused in `apply_consumed` and `apply_uncertain` until the
publish is journaled or resolved. Configuration v2 runs and v3 runs with
`"apply": null` never enter these states.

## Operation policy additions

| Operation type | Subject kind | Prerequisite | Observed identity |
| --- | --- | --- | --- |
| `apply.preview` | `apply` | `integration.harvest` | `stage3-preview` |
| `approval.record` | `approval` | `apply.preview` | `stage3-approval` |
| `approval.consume` | `approval` | `approval.record` | `stage3-consumption` |
| `apply.publish` | `apply` | `approval.consume` | `stage3-apply` |

All four are journaled with the existing intent/observed/needs_attention
machinery, hash chain, request digests, and durable guards.

## Verification obligations

Every Stage 3 change lands with negative tests proving zero forbidden
effects, in the existing suites' style:

- preview drift (apply ref moved, integration ref moved, checked-out apply
  ref, apply ref equal to integration ref, missing ref, non-fast-forward)
  refuses with zero journal authority and zero Git mutation;
- foreign, stale, duplicate, replayed, malformed, oversized, and
  non-canonical receipts are refused with exact codes;
- consumption is durable before the CAS under fault injection at every
  checkpoint;
- crash inside the publish effect yields `apply_uncertain`; resolution
  recovers `applied` and `unapplied` exactly and refuses any third
  observation;
- a consumed receipt can never authorize a second CAS;
- the CAS count across any run history is exactly zero or one per attempt and
  at most one `applied` attempt per run;
- configuration v2 byte-compatibility: the full existing Stage 2 suite passes
  unchanged.

## Non-goals

Stage 3 v1 does not add: push, remote publication, deployment, release/tag
automation, suite adapters, unattended launch or triggers, Browser/Guard/
Swarm promotion, product cleanup/prune/migration/expiry, recovery for any
operation other than `apply.publish`, approval delegation, or multi-ref
apply. Worker and operator fields remain unauthenticated same-UID
assertions; Git final checks retain the documented same-user TOCTOU windows.

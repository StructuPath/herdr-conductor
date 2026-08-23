# Herdr Plugins Guide

The canonical cross-plugin guide lives in the
[`herdr-suite-site` documentation](https://github.com/StructuPath/herdr-suite-site/tree/main/docs-src).
That separate site is not changed or promoted by Conductor Stage 2.

For Conductor `0.4.0`, use this repository's [README](../README.md) as the
operational authority. Its bounded support is exactly Herdr `0.7.5`, protocol
`17`, API schema `1`, five attended actions, and one passive board pane.

Key boundaries:

- configuration v2 has no launch arguments;
- immutable task and empty private outbox authority precede pane/agent creation;
- reports use only the exact task-bound bounded-stdin publisher;
- every worker/reviewer result is an unauthenticated assertion;
- complete producer reports permit deterministic zero-or-one-CAS integration;
- reviewer/validator sources are distinct exact-integration-SHA snapshots with
  separate writable outboxes and empty artifacts/source outputs;
- stand-down closes an exact deterministic pane prefix and retains all product
  resources; and
- same-UID races, final-check/pane-close TOCTOU, cumulative retention, SHA-1-width
  support, and no ambiguous recovery remain explicit.

Historical designs under [`docs/history/`](history/) and retained Stage 1 evidence
are lineage records, not current operational guidance. Stage 2 does not add
preview, approval/apply, adapters, unattended launch, product cleanup, Browser or
site promotion, push, tag, or release automation.

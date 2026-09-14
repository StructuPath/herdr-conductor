# Herdr Plugins Guide

The canonical cross-plugin guide lives in the
[`herdr-suite-site` documentation](https://github.com/StructuPath/herdr-suite-site/tree/main/docs-src).
The suite guide summarizes the plugins; this repository defines Conductor's
runtime contract.

For Conductor `0.4.0`, use this repository's [README](../README.md) as the
operational authority. Its bounded support is exactly Herdr `0.7.5`, protocol
`17`, API schema `1`, seven attended actions including `preview` and `apply`,
and one passive board pane.

Key boundaries:

- configuration v2 and v3 have no launch arguments;
- immutable task and empty private outbox authority precede pane/agent creation;
- reports use only the exact task-bound bounded-stdin publisher;
- every worker/reviewer result is an unauthenticated assertion;
- complete producer reports permit deterministic zero-or-one-CAS integration;
- reviewer/validator sources are distinct exact-integration-SHA snapshots with
  separate writable outboxes and empty artifacts/source outputs;
- stand-down closes an exact deterministic pane prefix and retains all product
  resources;
- same-UID races, final-check/pane-close TOCTOU, cumulative retention, and
  SHA-1-width support remain explicit;
- configuration v3 optionally names one existing local apply target ref;
- preview binds the exact integration and gates, an operator records the
  approval receipt, and apply consumes it before any single-ref fast-forward;
- only an uncertain Stage 3 apply publication can be resolved by exact target
  re-observation; ambiguous pane/agent operations still refuse recovery.

Historical designs under [`docs/history/`](history/) and retained Stage 1 evidence
are lineage records, not current operational guidance. Conductor does not add
suite adapters, unattended launch, product cleanup, Browser promotion, push,
tag, or release automation. See [operational readiness](readiness.md) for setup,
validation, and the remaining evidence gaps.

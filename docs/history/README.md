# Historical records

Files in this directory preserve design lineage. They are **not current runtime
contracts, supported-operation guides, or evidence of present behavior**. Use the
repository [README](../../README.md), manifest, tests, and current suite guide for
current claims.

## Conductor origin and adapter plan

- [`2026-07-23-herdr-conductor-origin-spec.md`](2026-07-23-herdr-conductor-origin-spec.md)
  is the original design proposal.
- [`2026-07-23-feature-delivery-adapter-plan.md`](2026-07-23-feature-delivery-adapter-plan.md)
  records the Tier-1/Tier-2 implementation plan and addendum.

Both documents contain proposals later disproved by audit, including Swarm-backed
worktree lifecycle, Guard enforcement, verified teardown ownership, durable
recovery, and mode-driven read-only enforcement. They remain intact as decision
history rather than being rewritten to look current.

## Removed Flotion reference scaffolding

Commit [`7067a06`](https://github.com/StructuPath/herdr-conductor/commit/7067a0686ddf517f3adc5853d4edde26cf932c61)
restored a Flotion-specific five-agent prototype from backups. The restoring
commit explicitly recorded that the prototype was not runnable in this
repository and depended on application paths and credentials that were not
present.

Stage 0 removes those files from the product tree. Their byte-exact contents,
recovery notes, and original paths remain available from Git history:

```bash
git show --stat 7067a06
git show 7067a06:<path-recorded-by-that-commit>
```

This history reference is intentional; the Flotion prompts, layout, spawn script,
and placeholder team directory are not Conductor templates or supported tools.

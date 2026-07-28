# Pull request review

## Scope

- Change type: <!-- docs/quality, runtime, safety fix -->
- Runtime behavior changed: <!-- yes/no; describe exact boundary -->
- Destructive surfaces touched: <!-- run selection, panes, worktrees, refs, files, none -->

## Evidence

- [ ] `npm run check`
- [ ] `shellcheck --shell=bash scripts/*.sh`
- [ ] `go run github.com/rhysd/actionlint/cmd/actionlint@v1.7.7`
- [ ] Negative zero-mutation tests cover every changed fail-closed boundary, or not applicable
- [ ] Exact commands and results are included below

## Contract and claim review

- [ ] Manifest, package, README, role guidance, and tests agree
- [ ] Canonical suite docs/evidence were updated, or the change does not affect them
- [ ] No claim of Guard enforcement, secure same-user isolation, verified ownership,
      durable recovery, read-only enforcement, or live compatibility exceeds evidence
- [ ] `scripts/conductor-lib.sh` vendoring impact was checked, or not applicable

## Residual risks

<!-- Include ambiguity, unsupported concurrency, destructive-operation, and live-certification risks. -->

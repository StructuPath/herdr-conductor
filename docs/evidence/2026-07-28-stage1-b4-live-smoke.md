# Conductor 0.2.0 Stage 1 B4 — opt-in live smoke evidence

- **Started:** 2026-07-29T07:24:59.051Z
- **Completed:** 2026-07-29T07:25:07.563Z
- **Clean candidate commit:** `274f809192fd2bfa82b3fc5922cc6710c058ef0f`
- **Runtime source manifest:** `6041f6303e8b511f9d9bf40a65eb8279030aa2149feb92429a4e0d8adfe23499`
- **Herdr client/server:** `0.7.5` / `0.7.5`, protocol `17`, schema `1`
- **Result:** PASS

## Scope, provenance, and privacy

This is sanitized, operator-observed local evidence anchored to the named candidate
commit, its Git tree, the retained source manifest, and this checker. It is not a
cryptographic remote attestation and does not authenticate against fabrication by
a process running as the same OS user.

The explicitly opted-in harness invoked all five installed `structupath.conductor`
actions through Herdr 0.7.5. Every retained invocation record contains only the
action, bounded context, terminal status, exit code, and SHA-256 digests of its
log identifier and output/result. No raw log identifier or terminal output is retained.

## Verified lifecycle and isolation

- Assemble, board, status, harvest, and stand-down succeeded in the primary disposable workspace.
- Board, status, harvest, and stand-down each refused both a foreign workspace in the same repository and a workspace in a second repository.
- Fresh before/after reads of global disposable workspace/pane/agent inventories, both repositories' refs/worktrees/status/heads, both exact repository-state records, primary workspace state, active pointer, full live pane/agent tuple, pane-close count, and Git compare-and-swap count matched after every refusal.
- Harvest's result digest equals the observed `git.merge` journal result digest.
- Stand-down archived the run and closed exactly the observed writer pane.
- The original workspace inventory and focus were restored.

## Retention inventory captured before cleanup

| Retained path (inside the disposable writer worktree) | SHA-256 |
|---|---|
| `retained/marker.txt` | `fffd8313f6020e1ab9c9bd44361194e719655131c2293b3b3799d497b6a38216` |
| `retained/report.json` | `a4087f003cda1c018ba09e083741c3a0395f7563dee2e16551513f12409cf6ff` |
| `retained/live-smoke.log` | `2cae21b3c5e7a77394e4ba1522a8f6cee72588b2d015a9c82b60e2fb96631f62` |
| `retained/Guard-observation.txt` | `b0a0587c53ea86e0045154e81dea6f4f0e1a7b750cf92e8d63df55fd88601f09` |

Before this candidate was committed, the operator removed 2 strictly validated
identity-only records left by prior disposable B4 runs; no private paths are retained.
After retention facts were captured, this harness closed only its exact disposable
workspaces and removed only its two temporary repositories and exact repository-keyed
private-state records. The cleanup receipt reports zero residue.

This report is generated deterministically from the machine evidence. Commit B may
retain this evidence, but the attested runtime source manifest is the exact manifest
from candidate Commit A; the checker requires the current checkout to reproduce it.

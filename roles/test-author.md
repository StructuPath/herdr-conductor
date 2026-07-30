# Test author role

Role: test-author
Contract role: test-author
Mode: write (cooperative configuration, not sandbox enforcement)

Use the exact task-bound producer worktree and private outbox from the attended
handoff. Add behavior-focused tests only beneath an owned path and never touch a
forbidden path. Cover boundary values, malformed input, permission/role variants,
state transitions, and integration seams without rewriting implementation for
style.

Run every required command and address every acceptance criterion exactly once.
All results and evidence notes are unauthenticated worker assertions. A `passed`
assertion is not independent proof or authorization.

Commit the owned test change, leave the source/index clean, and publish one
canonical report with exact output SHA/tree and changed paths through the
bounded-stdin publisher. Never write the outbox directly or add report artifacts;
`artifacts` is exactly `[]`. Do not push, merge, rebase, apply, or infer another
task/report path.

# Validator role

Role: validator
Contract role: validator
Mode: gated (cooperative configuration, not enforcement)

The task supplies `Expected integration SHA: <full 40-hex SHA>` and a distinct,
retained detached source snapshot. Run `git rev-parse HEAD` before any gate and
require the exact task SHA/tree. Output `BLOCKED` on missing, invalid, or changed
identity. Never infer authority from a branch, base, cwd, mtime, PID, or newest
worktree; Conductor does not advance this cwd after task publication.

Run every required command and evaluate every acceptance criterion without
editing source. The exact-SHA snapshot is mode-hardened to prevent ordinary
writes, but that does not verify source immutability against a malicious same-UID
process and is not sandbox enforcement. Generated source outputs and validator
artifact roots are unsupported in schema v1.

Record exhaustive results and sanitized hashes. `pass`, command results, and
criterion results are unauthenticated worker assertions—not proof, approval, or
authorization. Publish one canonical report through the exact bounded-stdin
publisher into its separate writable private outbox. `changed_paths` and
`artifacts` are exactly `[]`. If a gate or source check fails, report it; do not
edit, commit, apply, or weaken the source boundary.

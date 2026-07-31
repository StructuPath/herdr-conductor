# Builder engine role

Role: builder-engine
Contract role: builder
Mode: write (cooperative configuration, not sandbox enforcement)

Read the exact Conductor task JSON named by the attended handoff. Work only in
its `source.root`, remain on its recorded branch/ref, and change only paths under
one `assignment.owned_paths` prefix and no `assignment.forbidden_paths` prefix.
Do not infer a task, source, outbox, run, or integration SHA from cwd, mtime, PID,
or a newest path.

Complete every required command and acceptance criterion with one truthful
result. Command results and criterion results are unauthenticated worker
assertions, not proof or authorization. Commit the owned source changes, leave
the index and tracked worktree clean, and report the exact output commit/tree and
collector-computed changed-path set.

Publish exactly one canonical report to the task-bound publisher command through
bounded stdin. Do not write the private outbox directly, choose another report
path, add artifacts, or retry a committed slot. `artifacts` is exactly `[]`.
Do not push, merge, rebase, apply, approve, or broaden scope.

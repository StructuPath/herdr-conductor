# Security Policy

## Supported scope

Conductor `0.1.0` is an attended local prototype for cooperative processes under
one OS user. Worktrees, Guard observations, hashes, file modes, prompts, and
report sentinels are not authorization or isolation boundaries against a
malicious same-user process.

The complete lifecycle is not currently safe for unattended or destructive use:

- active-run selection is global and not repository/workspace-bound;
- legacy state is sourced as shell;
- pane teardown does not compare live ownership identity;
- role modes do not enforce read-only behavior;
- Guard observes rendered text but cannot prove prevention;
- reconcile has no validated-verdict or approval precondition.

Do not invoke `stand-down` on persisted or ambiguous state. Do not run Swarm and
Conductor concurrently against one Git common directory. Preserve questionable
state and panes for manual inspection rather than guessing ownership.

## Reporting a vulnerability

Report command injection, wrong-repository mutation, foreign pane/worktree
cleanup, state confusion, or sandbox-claim defects privately through
[GitHub Security Advisories](https://github.com/StructuPath/herdr-conductor/security/advisories/new).
Include the plugin/Herdr versions, OS, action or function, sanitized reproduction
steps, and whether any pane, worktree, ref, or file changed.

Do not attach credentials, recordings, full terminal transcripts, absolute home
paths, or raw state that may contain secrets. Replace sensitive values while
preserving the field shape needed to reproduce the issue.

A maintainer should acknowledge a report, reproduce it in an isolated repository,
and avoid destructive cleanup until identity is proven. Public disclosure and
release timing are coordinated after a fix and negative regression evidence are
available.

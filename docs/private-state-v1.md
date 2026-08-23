# Conductor private state v1

**Status:** Stage 2 and Stage 3 in Conductor `0.4.0`. All seven actions use this state
exclusively through `scripts/stage1-runtime.mjs`. Tasks/outboxes precede agents;
report collection, deterministic integration, exact-SHA gates, stand-down close
prefixes, and archive share the same journal authority.

This document describes Conductor's private, non-executable state and crash
boundaries implemented by `scripts/private-state-schema.mjs` and
`scripts/state-kernel.mjs`. It is not a public suite contract, authentication,
or freedom from the documented same-user TOCTOU limits.

## Identity and layout

The kernel accepts an explicit repository path and state root. It never resolves
a repository from `CONDUCTOR_REPO`, ambient `$PWD`, a process ID, or the newest
recorded run.

Git identity is the canonical result of:

```text
git -C <explicit-repository> rev-parse --path-format=absolute --git-common-dir
```

The recorded physical identity contains the common-directory realpath plus its
filesystem device and inode as decimal strings. `repo-key` is a SHA-256 over all
three values. Linked worktrees share a repository key; separate clones do not.
Every run also records its exact canonical repository worktree root.

```text
<configured-state-parent>/
  v1/                                    private 0700 authority root
    repositories/<repo-key>/
    identity.json
    mutation.lock/
      owner.json
    workspaces/<workspace-key>/
      active/<run-id>--<generation>.json
      runs/<run-id>/<generation>/
        run.json
        activation.guard.json              present only during activation
        operations/<sequence>-<operation-id>.json
        operation-guards/<sequence>-<operation-id>.json
        contracts/
          tasks/<role>/<task-generation>.json
          reports/<role>/<task-generation>/<report-generation>.json
        outboxes/<role>/<outbox-generation>/
          report-<task-generation>-<outbox-generation>/
            .publishing.json                publication uncertainty only
            .staging-<nonce>                publication uncertainty only
            report.json                     immutable raw payload
            COMMITTED.json                  immutable commit marker
        gate-sources/<role>/<source-generation>/
```

`workspace-key` is a SHA-256 over the exact bounded Herdr workspace ID. Every
active pointer, run document, lock owner, resource identity, and journal entry
uses closed objects with exact keys and version `1`. Run and resource generations
are independent 128-bit random hexadecimal values; PID and timestamps are never
identity.

Run state has no persisted resource projection. The hash-chained operation
journal is the sole resource authority. `worktree.create`
records canonical path, physical common directory, full ref, fixed fork/head,
and registered membership. `pane.create` records workspace, pane, terminal, cwd,
run, and generation. `agent.start` records the complete pane-plus-agent tuple.
`integration.bind` records the assemble-time canonical target path, physical
common directory, full ref, fork/head, and registered membership. Harvest and
stand-down live-revalidate journal authority before every merge or close.

## Strict JSON

Private JSON is parsed by a bounded zero-dependency recursive parser before the
document validator runs. It rejects malformed/truncated input, duplicate object
keys at any depth, BOMs, invalid UTF-8, lone Unicode surrogates, excessive
nesting, oversized arrays/files, missing keys, extra keys, wrong versions, unsafe
numbers,
and malformed identifiers.

Owned output is deterministic sorted JSON with one trailing newline. Canonical
serialization does not make a corrupt input authoritative; every read repeats
strict parsing and exact validation.

The configured parent may predate v1 and may be mode `0755`; it is never an
authority root. The kernel creates or verifies only its dedicated `v1` child as
mode `0700` and does not parse, source, execute, modify, migrate, adopt, or return
other parent content. There is no legacy importer.

## Private filesystem rules

The dedicated `v1` authority root and every owned directory below it must be
owned by the effective user and have mode `0700`. Every authoritative document
must be a single-link regular file owned by the effective user with mode `0600`.

Reads validate the private ancestor chain, open the leaf with
`O_RDONLY | O_NOFOLLOW`, and then use `fstat` to verify type, owner, mode, link
count, size, device, and inode while reading through the descriptor. Symlinks,
non-regular leaves, wrong modes/owners, and changed files fail closed.

Writes use a random same-directory temporary file opened with
`O_CREAT | O_EXCL | O_NOFOLLOW` and mode `0600`. The kernel writes and fsyncs the
file before publication. Replacement uses atomic rename; exclusive publication
uses a hard link and refuses an existing destination. Publication finishes only
after the containing directory is fsynced.

A failure after rename/link but before confirmed directory fsync is
`durability_unknown`. The published file or temporary hard link is recovery
inventory; it is never silently substituted, removed, or adopted as a fallback.
Node's portable APIs cannot eliminate hostile same-UID swaps of intermediate path
components, so these controls remain cooperative same-user coordination rather
than authentication.

## Repository mutation lock

One `mutation.lock` directory serializes all workspaces sharing a physical Git
common directory. Acquisition uses atomic directory creation followed by a
strict, durably published `owner.json` containing a random lock nonce. PID is
diagnostic only.

Every mutating kernel API re-reads the owner and compares the nonce plus the lock
directory device/inode. Release removes a lock only after those values match the
held handle. A valid existing owner is `lock_busy`; missing, malformed, symlinked,
replaced, or mismatched lock state is `lock_unknown`.

B1 never steals or adopts a lock based on PID liveness, age, hostname, mtime, or
process name. A crash may intentionally leave an unknown lock that requires a
future explicitly reviewed recovery procedure.

## Active-run consistency

Run activation publishes an `initializing` `run.json`, then a durable activation
guard, one exclusive active pointer, and only then atomically marks the run
`active`, all while holding the repository lock. The guard is removed and its
directory fsynced only after the pointer and active state are confirmed durable.
Those files cannot be committed atomically. Every load scans the
workspace inventory and requires exactly one active pointer and exactly one
matching `active` run state with the same physical repository, repository root,
workspace, run ID, and generation, and no surviving activation guard.

Multiple pointers, more than one non-archived state, any unpointed non-archived
state, a pointer without one active state, unexpected inventory, copied foreign
state, or any identity mismatch is `duplicate_active`, `bookkeeping_unknown`, or
a narrower foreign/stale error. Run/generation directory names, active-pointer
filenames, and journal sequence/operation filenames must exactly match their
validated document identities; renamed or misplaced records are not authority. A
surviving activation guard requires explicit recovery. The kernel does not repair
or adopt an intermediate activation state.

## Write-ahead journal boundary

`performJournaledOperation` is the B1 seam used by the B2 assemble action for
worktree, pane, and agent creation. Under the repository lock it:

1. validates the exact active run and all existing operation records;
2. exclusively publishes and directory-fsyncs an immutable `intent`;
3. advances the run's durable journal sequence and hash-chain head;
4. publishes a durable per-operation uncertainty guard;
5. revalidates lock ownership and invokes the supplied effect at most once;
6. after the post-effect checkpoint, revalidates lock ownership and invokes any
   operation-specific immediately-before-publication validator;
7. validates the observation, publishes the terminal entry, and advances the
   run's head to the terminal-entry digest;
8. removes and directory-fsyncs the uncertainty guard only after both terminal
   documents are confirmed durable.

The run high-water mark, contiguous sequence, previous-entry digest, full entry
digest (including terminal phase/result), and current head digest are checked
together. Deleting, inserting, reordering, or replacing a journal record or its
terminal fields therefore makes bookkeeping unknown before any effect can run.
A surviving uncertainty guard always requires explicit recovery, even if a
schema-valid `observed` record is also visible.

The crash boundaries are intentionally conservative:

- Before durable intent completes, the effect is not invoked.
- After durable intent and before durable observed result, `intent` or
  `needs_attention` blocks the run and prohibits replay.
- A failed command is not proof that no side effect occurred.
- An observed result whose publication or terminal-head update is uncertain
  remains covered by the durable guard; a best-effort `needs_attention`
  transition cannot weaken that guard if the transition also fails.
- After a confirmed durable observed result, retry returns the recorded digest
  without invoking the effect again.
- Conflicting reuse of an operation ID is refused.

If result publication is uncertain after an external effect, the surviving
intent remains ambiguous unless an exact observed result can later be read. B1
provides diagnosis and refusal, not automatic rollback, retry, or recovery.

## Stage 2 runtime binding

All five actions enter `scripts/stage1-runtime.mjs`, the sole lifecycle
authority. The runtime accepts only strict `HERDR_PLUGIN_CONTEXT_JSON`, resolves
one fixed fork and target before effects, generates independent run/source/task/
outbox/pane/agent/report/snapshot generations, uses run-unique refs/names, and
never adopts same-named resources.

Configuration version 2 is closed to `version`, required tagged `state_root`,
`worktree_root`, and `roles`. `state_root` is exactly `{ "kind": "default" }`
for normal operation or `{ "kind": "absolute", "path": <canonical absolute> }`
for a sealed disposable harness. Every action reads configuration first, derives
the same root, and validates the run-bound configuration digest; there is no
environment or compatibility fallback. Every role binds a closed assignment and
empty `validator_artifacts`; launch
arguments do not exist. For each producer the runtime creates/observes source,
creates the exact empty outbox slot, exclusively publishes the immutable task,
and journals `task.publish` before `pane.create` or `agent.start`. A task without
one attached observed agent is inert.

The publisher reads descriptor 0 through actual EOF with a 1,048,576-byte bound.
It validates canonical report bytes, digest, exact task path/scope/configuration,
observed agent, source identity, and empty slot before creating a guard. Its exact
sequence is guard, staging payload, immutable raw payload, immutable commit
marker, directory fsyncs, staging unlink, then guard unlink. Any guard/staging,
malformed/extra inventory, changed payload/marker, or durability uncertainty is
`recovery_required`; replacement/adoption is forbidden.

`report.harvest` and `report.reject` are mutually exclusive terminal operations
for one report generation. Complete deterministic task/source/path/requirement
failure executes rejection with no accepted copy or external effect. Incomplete
transport/command/descriptor observation creates no rejection intent. Successful
harvest retains the raw pair and publishes one immutable accepted copy. Exact
observed retry returns recorded authority without reopening input.

Integration requires accepted completed/delivered reports for every producer.
The collector computes exact fixed-fork changes with rename/copy detection
disabled, enforces declared-path equality and component-aware owned/forbidden
policy, then collectively validates every task/agent/source/path/configuration/
target twice. Synthetic commits use fixed identity/time/message and configured
role order. A complete chain moves the target through one `update-ref` CAS; every
missing, failed, rejected, conflicted, drifted, raced, or incomplete case performs
zero CAS. `P=[]` records unchanged integration with zero CAS.

After observed integration harvest, every reviewer/validator receives a distinct
registered detached worktree at the exact integration SHA/tree. Source modes are
`0555` directories, retained executable tracked modes, `0444` other tracked files
and linked-worktree `.git`; no symlink is followed. All gate sources and tasks are
observed before any gate pane, and all gate panes before agents. Gate reports have
empty changed paths/artifacts. Source mutation creates stable refusal but does
not weaken later exact pane-close identity.

The lifecycle scanner validates complete journal/inventory/configuration before
deriving exactly one clean/stable/stand-down/archive state. Uncertainty outranks
stable progress. `run.stand-down.begin` binds source state, reason/outcome, exact
sorted close set, and archive operation. Each retry may close only entry `k+1`
after full journal plus live pane/agent/cwd revalidation. A possible close effect
is uncertain and never replayed. Archive begins only after all closes, including
`N=0`; all product resources remain retained.

Board/status select only the invoking physical repository/workspace and render
scanner-derived authority. Two repositories and two same-repository workspaces
with colliding logical IDs remain isolated by tests. Every effect gates exact
Herdr `0.7.5`, protocol `17`, schema `1`.

Private state remains cooperative same-user coordination. The repository lock
does not stop unrelated Git or same-UID mutation after final checks, and Herdr's
pane close accepts only pane ID, leaving documented TOCTOU. Stage 3 preview,
approval, consumption, and apply authority live only in the hash-chained
journal; the sole ambiguous-operation resolution is the attended apply
publication, resolved by exact target-ref re-observation. There is no product
cleanup/prune/migration/expiry, suite adapter, unattended trigger, Browser
promotion, push, or deployment.

## Verification

```bash
node --test tests/private-state-schema.test.mjs tests/state-kernel.test.mjs \
  tests/stage1-runtime-*.test.mjs tests/stage2-*.test.mjs tests/stage3-*.test.mjs
npm run check
```

The suite covers malformed/duplicate contracts, symlink/mode/type failures,
physical identity, repository/workspace isolation, lock/concurrency races,
task-before-agent barriers, bounded publication, rejection/harvest mutual
exclusion, lifecycle partitions, zero/one CAS, exact-SHA gates, every stand-down
prefix, and deterministic plus true-`SIGKILL` crash boundaries proving uncertain
operations are not replayed.

# Conductor private state v1

**Status:** Stage 1 B3. All five actions use this state exclusively through
`scripts/stage1-runtime.mjs`. Harvest is attended identity-checked reconcile;
stand-down is identity-checked pane close followed by strict-state archive.

This document describes Conductor's private, non-executable state format and the
failure boundaries implemented by `scripts/private-state-schema.mjs` and
`scripts/state-kernel.mjs`. It is not a public suite contract and does not make
the current `0.2.0` lifecycle authenticated or free of the documented same-user TOCTOU limits.

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

## B3 runtime binding and current holds

All five actions enter `scripts/stage1-runtime.mjs`, the sole shipped lifecycle
authority. The runtime requires strict
`HERDR_PLUGIN_CONTEXT_JSON` repository/workspace identity, resolves one fixed
fork SHA before effects, generates unpredictable run/resource identities, uses
run-unique full refs and agent names, and journals intent plus exact observation
around each Git/Herdr operation. It never adopts a same-named resource.

Board and status load only the active run for the invoking physical repository
and workspace. Live status compares both pane and named-agent views against the
recorded full tuple; it reports unavailable or foreign/stale identity rather
than selecting another run. Two repositories under one state root and two
workspaces under one repository remain isolated by tests.

No sourceable legacy lifecycle is shipped. The hash-chained journal is the one
canonical observed-resource authority; B3 creates no second unsynchronized
projection and performs no legacy write or dual-write.

Harvest holds the repository mutation lock continuously across canonical journal
load and source/target preflight. It validates the assemble-bound target and each
immutable source SHA, computes the merged tree/commit without moving a ref, then
uses compare-and-swap `git update-ref` against the validated old target SHA.
Source and target identity are re-read after injectable race boundaries and
immediately before CAS. The verified target index/worktree is refreshed with
`read-tree` without moving the ref again. After the journal's post-effect
checkpoint and while the repository lock remains held, the merge publication
validator re-reads the exact target path/common directory/ref/head/membership,
expected merged SHA, index tree, and tracked worktree cleanliness before any
observed result write. Drift is retained as `needs_attention` and prohibits
replay. The lock is cooperative same-user coordination, so another same-user
process can still mutate Git immediately after this final validation; it is not
authentication or an elimination of that residual TOCTOU race. Conflict and
command diagnostics are retained; failed commands are ambiguous and prohibit
replay.

Stand-down re-reads one exact pane+agent tuple immediately before each close and
requires workspace, pane, terminal, named agent/session, both canonical cwd
fields, run, and generation to match. Missing, malformed, duplicate, foreign,
stale, or transport-error data closes nothing for that pane. Herdr `0.7.5` has no
conditional close parameter beyond pane ID, so the same-user TOCTOU remains.
After successful closes, a recoverable private archive state machine durably
records intent, marks the run archived, removes and fsyncs its active pointer,
and only then records the archive result. Exact retry skips observed closes and
completes private archive boundaries idempotently. Worktrees, branches,
artifacts, reports, recordings, logs, Guard files, and legacy inventory remain.

Every effecting action first gates the runtime to exact Herdr 0.7.5, protocol 17,
and schema 1. Stage 1 enables no worktree/branch deletion, prune, suite adapter,
approval contract, unattended trigger, Browser promotion, or recovery tooling.
Version 0.2.0 records attended-operational Stage 1 and does not widen those
Stage 2 and later holds.

## Verification

```bash
node --test tests/private-state-schema.test.mjs tests/state-kernel.test.mjs \
  tests/stage1-runtime-*.test.mjs
npm run check
```

The B1-B3 suite includes malformed and duplicate JSON, symlink/mode/type
failures, physical repository identity, v1-root isolation, repository/workspace
cross-isolation, lock contention/races, duplicate-active/orphan state, stale
identities, strict fake Git/Herdr ordering, exact observed identities, and fault
injection proving uncertain operations are not replayed.

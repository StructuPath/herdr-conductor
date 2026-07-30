# Herdr Conductor

> [!IMPORTANT]
> Conductor `0.3.0` implements **Stage 2 attended strict task/report contracts**
> on exactly Herdr `0.7.5`, protocol `17`, API schema `1`. An operator explicitly
> invokes every transition. This is cooperative same-UID coordination, not
> authentication, sandboxing, unattended orchestration, or Stage 3
> approval/apply.

Conductor coordinates task-bound producer and gate roles through five installed
Herdr actions and one passive board pane. One runtime authority in
`scripts/stage1-runtime.mjs` owns the complete lifecycle. It preserves the
Stage 1 physical repository/workspace/run identity, hash-chained journal,
repository
mutation lock, Git compare-and-swap, exact pane identity, conservative crash
truth, archive transition, and retained resources.

## Supported contract

Requirements: Herdr exactly `0.7.5`, Node.js 20 or current LTS, Git with 40-hex
SHA-1 object IDs, Python 3.11+, and macOS or Linux.

For every effecting action, Conductor:

- accepts only `HERDR_PLUGIN_CONTEXT_JSON`; there is no `CONDUCTOR_REPO`,
  ambient-cwd, process-ID, or newest-global fallback;
- binds one physical Git common-directory identity and one Herdr workspace;
- requires exactly one active version-2 run/generation and complete strict
  journal/inventory authority;
- holds one cooperative repository mutation lock while changing Git, task,
  report, pane, agent, lifecycle, or active authority; and
- fails closed on malformed, foreign, stale, duplicate, replayed, ambiguous, or
  durability-uncertain state.

Configuration v2 publishes every producer source, immutable task, and empty
private report outbox before creating its pane or agent. A task precommits the
source/task/outbox/pane/agent generations and request digests. Herdr action and
agent argument arrays stay empty; Conductor does not launch an autonomous
mission.

Reports are closed canonical JSON. The task-bound publisher reads only bounded
stdin through actual EOF, accepts at most 1,048,576 bytes, validates canonical
bytes/digest/task/agent/source authority before publication, and commits one
immutable payload/marker slot. It does not accept a payload path, destination,
alternate FD, environment payload, or replacement report. Report command and
criterion results, `delivered`, `approve`, and `pass` remain unauthenticated
worker assertions—not proof, approval receipts, or authorization. Schema v1
requires empty validator source outputs and `artifacts: []`.

Attended `harvest` collects terminal reports in configured role order. A complete
invalid committed report is durably rejected; incomplete observation remains
retryable or uncertain according to the exact failure boundary. Integration
requires one accepted completed/delivered report from every producer, performs
two collective source/path/target preflights, builds deterministic synthetic
commits, and moves the target with exactly zero or one compare-and-swap. Missing,
blocked, failed, rejected, incomplete, conflicting, drifted, or raced selection
performs zero target CAS.

Reviewer and validator tasks use distinct retained detached worktrees at the exact
observed integration SHA/tree. Their sources are mode-hardened (`0555`
directories, `0444` non-executable files, retained executable bits) and their
writable report outboxes remain outside source. This is an ordinary-write and
review boundary, not malicious same-UID enforcement. Gate reports require empty
changed paths and artifacts and exhaustive worker-asserted requirement results.

Lifecycle scanning derives one disjoint state or fails with
`bookkeeping_unknown`/`recovery_required`. Stable states cover provisioning,
waiting reports, terminal rejection, nonprogressable delivery, ready/integrated
results, gate provisioning/waiting/refusal/collection, every stand-down close
prefix, and archive. Attended stand-down is available from every stable state,
binds a deterministic exact pane close set, closes only the next full live tuple,
and archives only after every close is observed. It never removes product
worktrees, branches, tasks, outboxes, reports, gate sources, logs, recordings, or
artifacts.

## Configuration

Commit `.herdr-conductor.json` in the invoking repository:

```json
{
  "version": 2,
  "state_root": { "kind": "default" },
  "worktree_root": ".conductor-worktrees",
  "roles": [
    {
      "name": "builder",
      "contract_role": "builder",
      "kind": "pi",
      "mode": "write",
      "assignment": {
        "title": "Implement the owned change",
        "mission": "Complete only the attended task.",
        "acceptance_criteria": [
          { "id": "behavior", "text": "The requested behavior is verified." }
        ],
        "owned_paths": ["src"],
        "forbidden_paths": ["secrets"],
        "required_commands": [
          { "id": "test", "command": "npm test" }
        ]
      },
      "validator_artifacts": []
    },
    {
      "name": "validator",
      "contract_role": "validator",
      "kind": "pi",
      "mode": "gated",
      "assignment": {
        "title": "Validate the exact integration",
        "mission": "Run the attended exact-SHA gate.",
        "acceptance_criteria": [],
        "owned_paths": [],
        "forbidden_paths": [],
        "required_commands": []
      },
      "validator_artifacts": []
    }
  ]
}
```

`state_root` is required. Use `{ "kind": "default" }` for normal operation.
The `{ "kind": "absolute", "path": "/canonical/disposable/root" }` variant is
reserved for a pre-existing canonical directory owned by an isolated harness;
there is no environment-variable or legacy fallback. Every action rereads this
configuration and refuses a changed run-bound digest.

Role names are unique and byte-sorted by the runtime where ordering matters.
Producer modes are `write`; reviewer/validator roles use exact-SHA gate sources.
Mode labels and file modes are cooperative controls, not authentication.

## Installed actions

Focus the intended Herdr workspace, then invoke each transition explicitly:

```bash
herdr plugin action invoke assemble --plugin structupath.conductor
herdr plugin action invoke board --plugin structupath.conductor
herdr plugin action invoke status --plugin structupath.conductor
herdr plugin action invoke harvest --plugin structupath.conductor
herdr plugin action invoke stand-down --plugin structupath.conductor
```

`assemble` returns exact task paths, source roots, outbox slots, and publisher
commands. A worker sends canonical report bytes to that publisher through stdin.
`harvest` is explicitly invoked and attended; producer report collection and
gate report collection may require separate invocations. Board/status are passive
and infer no missing input. `stand-down` closes only panes that were observed;
each exact workspace/pane/cwd/generation identity must still match, and the full
attached-agent tuple is also required when an agent was observed.

## Evidence and release boundary

Retained Stage 1 B0/B4 artifacts remain historical compatibility evidence. The
[B4 live smoke report](docs/evidence/2026-07-28-stage1-b4-live-smoke.md) is
validated against its recorded candidate Git tree, not current Stage 2 bytes.
It remains sanitized operator-observed local evidence, not remote attestation.

Commit A predeclares, but does not contain or claim results for, exactly these
Commit B paths:

- `docs/evidence/stage2-runtime-source-manifest.json`
- `docs/evidence/2026-07-28-stage2-live-contracts.json`
- `docs/evidence/2026-07-28-stage2-live-contracts.md`

After immutable Commit A and a complete external exact-source review with no
blocker/high/medium finding, the opt-in installed-plugin harness may run. It
writes the exact private trio only after descriptor-held disposable teardown and
positive absence proof. Its configuration selects an absolute private-state root
inside the sealed disposable root. Teardown has no out-of-root deletion API and
never removes configured shared/default state or product resources. The live run
is intentionally not part of Commit A or routine checks.

The argument-free release checker reads only immutable Commit B Git-tree blobs,
reproduces exact Commit A source bytes, requires the exact three-path A..B diff,
rerenders the human report, validates the embedded external review and sanitized
output-parent binding, and returns one out-of-band completion digest.

## Verification

```bash
npm run check
npm run test:stage2
bash -n scripts/*.sh
shellcheck --shell=bash scripts/*.sh
python3 -m py_compile scripts/harness-fs-helper.py
go run github.com/rhysd/actionlint/cmd/actionlint@v1.7.7
node --test tests/stage1-runtime-*.test.mjs tests/stage2-*.test.mjs
```

The live harness requires an explicit candidate, review record, empty canonical
`0700` output parent, and exact opt-in. Do not run it as a routine test:

```bash
CONDUCTOR_STAGE2_LIVE_EVIDENCE=I_UNDERSTAND_THIS_USES_LOCAL_HERDR \
  npm run evidence:stage2:live -- \
  --candidate <commit-a> \
  --review-record <external-review.json> \
  --output-parent <empty-private-directory>
```

A retained complete trio after a post-proof crash can be revalidated/fsynced
without rewriting bytes:

```bash
npm run evidence:stage2:finalize -- \
  --output-parent <exact-private-directory> \
  --candidate <commit-a>
```

## Security and limitations

- Private state, hashes, modes, journals, and local evidence are cooperative
  same-UID coordination and not authentication. Same-UID processes can race or
  fabricate them.
- Git/filesystem final checks and Herdr 0.7.5 pane-ID close retain same-user
  TOCTOU windows.
- Worker results are unauthenticated assertions. The retained external-review
  record uses only fixed independent-human/independence/GO tokens and requires
  zero findings; those closed assertions remain unauthenticated.
- Product resources are retained indefinitely and consume cumulative disk.
- A crash after a possible external effect remains uncertain; Stage 2 has no
  ambiguous-operation recovery or replay.
- Guard is observational and cannot prove prevention. Conductor does not invoke
  Swarm and makes no Browser, suite-adapter, site, sandbox, promotion, or
  unattended-readiness claim.
- Stage 3 preview, approval, approval consumption, apply, and recovery are not
  implemented.

See [SECURITY.md](SECURITY.md), [CONTRIBUTING.md](CONTRIBUTING.md), and
[docs/private-state-v1.md](docs/private-state-v1.md) for the authoritative
cooperative threat, candidate/evidence, and private-state boundaries.

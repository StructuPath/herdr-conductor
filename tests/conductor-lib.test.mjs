// Transport tests for scripts/conductor-lib.sh — the canonical copy of the loop
// that pi-library's feature-delivery-team skill vendors.
//
// Everything runs against a throwaway CONDUCTOR_STATE_DIR and, where a repo is
// needed, a throwaway git repo. No test touches a real herdr: dry-run mode audits
// the command sequence, and the few tests that need herdr output use a fake binary.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const LIB = join(ROOT, "scripts", "conductor-lib.sh");
const SENTINEL = "<!-- REPORT-COMPLETE -->";
const BASH = process.env.CONDUCTOR_TEST_BASH ?? "bash";

const trash = [];
function tmp(prefix = "cond-") {
  const d = mkdtempSync(join(tmpdir(), prefix));
  trash.push(d);
  return d;
}
process.on("exit", () => {
  for (const d of trash) rmSync(d, { recursive: true, force: true });
});

// Source the lib and run a snippet. Dry-run by default; pass CONDUCTOR_DRY_RUN:"0"
// for the tests that exercise real filesystem/git work.
function runLib(snippet, env = {}) {
  return spawnSync(BASH, ["-c", `. "${LIB}"\n${snippet}`], {
    encoding: "utf8",
    env: {
      ...process.env,
      CONDUCTOR_DRY_RUN: "1",
      CONDUCTOR_STATE_DIR: env.CONDUCTOR_STATE_DIR ?? tmp("cond-state-"),
      CONDUCTOR_RUN_ID: "t",
      HERDR_BIN_PATH: "/bin/false",
      ...env,
    },
  });
}

function git(cwd, ...args) {
  const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

// A git repo with one commit on `main`.
function gitRepo() {
  const d = tmp("cond-repo-");
  spawnSync("git", ["init", "-q", "-b", "main", d]);
  git(d, "config", "user.email", "t@example.com");
  git(d, "config", "user.name", "Conductor Test");
  writeFileSync(join(d, "a.txt"), "base\n");
  git(d, "add", "a.txt");
  git(d, "commit", "-qm", "init");
  return d;
}

// Minimal fake herdr: reports 0.7.5 and replays a canned `agent list` payload.
function fakeHerdr(agentListJson) {
  const bin = join(tmp("cond-bin-"), "herdr");
  writeFileSync(
    bin,
    `#!/bin/bash\n` +
      `if [ "$1" = "--version" ]; then echo "herdr 0.7.5"; exit 0; fi\n` +
      `if [ "$1" = "agent" ] && [ "$2" = "list" ]; then cat <<'JSON'\n${agentListJson}\nJSON\n exit 0; fi\n` +
      `exit 0\n`,
  );
  chmodSync(bin, 0o755);
  return bin;
}

function teamConfig(repo, cfg) {
  const p = join(repo, ".herdr-conductor.json");
  writeFileSync(p, JSON.stringify(cfg));
  return p;
}

const THREE_ROLES = {
  version: 1,
  base_branch: "main",
  roles: [
    { name: "builder-engine", kind: "claude", mode: "write", owns: "the engine", must_not_own: "the UI" },
    { name: "validator", kind: "codex", mode: "gated", launch_args: ["--sandbox", "workspace-write"] },
    { name: "reviewer", kind: "codex", mode: "read-only", launch_args: ["--sandbox", "read-only"] },
  ],
};

// --- the loop (dry run) ------------------------------------------------------

test("lib sources cleanly", () => {
  const r = runLib("echo sourced-ok");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /sourced-ok/);
});

test("start_worker emits pane split then agent start", () => {
  const cwd = tmp();
  const r = runLib(`conductor_start_worker reviewer codex "${cwd}"`);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /pane split/);
  assert.match(r.stderr, /--direction right/);
  assert.match(r.stderr, /agent start reviewer --kind codex/);
  assert.ok(r.stderr.indexOf("pane split") < r.stderr.indexOf("agent start"), "split must precede start");
});

test("start_worker passes agent argv through", () => {
  const cwd = tmp();
  const r = runLib(`conductor_start_worker reviewer codex "${cwd}" -- --sandbox read-only`);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /--sandbox read-only/);
});

test("illegal role name hard errors before any herdr call", () => {
  const cwd = tmp();
  const r = runLib(`conductor_start_worker BadRole codex "${cwd}"`);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /valid agent name/);
  assert.doesNotMatch(r.stderr, /pane split/);
});

test("missing cwd hard errors", () => {
  const r = runLib("conductor_start_worker reviewer codex /no/such/dir/xyz");
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /cwd does not exist/);
});

test("start_worker auto-ignores the .conductor transport dir", () => {
  // dogfood finding 3: a builder committed .conductor/task.md
  const cwd = tmp();
  const r = runLib(`conductor_start_worker reviewer codex "${cwd}"`);
  assert.equal(r.status, 0, r.stderr);
  const gi = join(cwd, ".conductor", ".gitignore");
  assert.ok(existsSync(gi), ".conductor/.gitignore was not created");
  assert.equal(readFileSync(gi, "utf8").trim(), "*");
});

test("dispatch to an unknown worker errors", () => {
  const f = join(tmp(), "task.md");
  writeFileSync(f, "do a thing");
  const r = runLib(`conductor_dispatch ghost "${f}"`);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /no such worker/);
});

// --- collect fails closed ----------------------------------------------------

function roleState({ dispatchTs = 0 } = {}) {
  const state = tmp("cond-state-");
  const cwd = tmp("cond-cwd-");
  mkdirSync(join(state, "run-t"), { recursive: true });
  mkdirSync(join(cwd, ".conductor"), { recursive: true });
  writeFileSync(
    join(state, "run-t", "builder.env"),
    `ROLE=builder\nKIND=claude\nCWD=${cwd}\nPANE=wZ:p1\nDISPATCH_TS=${dispatchTs}\n`,
  );
  return { state, cwd, report: join(cwd, ".conductor", "report.md") };
}

test("collect fails when the report is absent", () => {
  const { state } = roleState();
  const r = runLib("conductor_collect builder", { CONDUCTOR_STATE_DIR: state, CONDUCTOR_DRY_RUN: "0" });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /report\.md absent/);
});

test("collect fails when the report is empty", () => {
  const { state, report } = roleState();
  writeFileSync(report, "");
  const r = runLib("conductor_collect builder", { CONDUCTOR_STATE_DIR: state, CONDUCTOR_DRY_RUN: "0" });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /report\.md empty/);
});

test("collect fails when the sentinel is missing", () => {
  // a settle mid-write must not read as a result
  const { state, report } = roleState();
  writeFileSync(report, "PASS, everything is fine\n");
  const r = runLib("conductor_collect builder", { CONDUCTOR_STATE_DIR: state, CONDUCTOR_DRY_RUN: "0" });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /missing sentinel/);
});

test("collect rejects a report older than the dispatch", () => {
  // KTD-2: a stale prior-run report must never read as a fresh success
  const future = Math.floor(Date.now() / 1000) + 600;
  const { state, report } = roleState({ dispatchTs: future });
  writeFileSync(report, `stale verdict\n${SENTINEL}\n`);
  const r = runLib("conductor_collect builder", { CONDUCTOR_STATE_DIR: state, CONDUCTOR_DRY_RUN: "0" });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /stale/);
});

test("collect prints a fresh, complete report", () => {
  const { state, report } = roleState();
  writeFileSync(report, `PASS: 12/12 gates green\n${SENTINEL}\n`);
  const r = runLib("conductor_collect builder", { CONDUCTOR_STATE_DIR: state, CONDUCTOR_DRY_RUN: "0" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /12\/12 gates green/);
});

// --- team config -------------------------------------------------------------

function loadConfig(cfg, repo = tmp()) {
  const p = typeof cfg === "string" ? cfg : teamConfig(repo, cfg);
  return runLib(`conductor_config_load "${p}"`);
}

test("config normalizes and fills defaults", () => {
  const r = loadConfig(THREE_ROLES);
  assert.equal(r.status, 0, r.stderr);
  const c = JSON.parse(r.stdout);
  assert.equal(c.base_branch, "main");
  assert.equal(c.worktree_root, ".conductor-worktrees");
  const [engine, validator, reviewer] = c.roles;
  // template defaults to the role name; branch defaults to conductor/<role>
  assert.equal(engine.template, "builder-engine");
  assert.equal(engine.branch, "conductor/builder-engine");
  // mode drives isolation and enforcement
  assert.deepEqual([engine.worktree, engine.guard], [true, false]);
  assert.deepEqual([validator.worktree, validator.guard], [true, true]);
  assert.deepEqual([reviewer.worktree, reviewer.guard], [false, true]);
});

test("config rejects an unknown mode", () => {
  const r = loadConfig({ version: 1, roles: [{ name: "x", kind: "claude", mode: "sudo" }] });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /mode 'sudo' must be one of/);
});

test("config rejects a duplicate role name", () => {
  const r = loadConfig({
    version: 1,
    roles: [{ name: "dup", kind: "claude" }, { name: "dup", kind: "codex" }],
  });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /duplicate role name: dup/);
});

test("config rejects a role name herdr could not use as an agent name", () => {
  const r = loadConfig({ version: 1, roles: [{ name: "Builder Engine", kind: "claude" }] });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /is not a valid agent name/);
});

test("config rejects a role with no kind", () => {
  const r = loadConfig({ version: 1, roles: [{ name: "builder" }] });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /'kind' is required/);
});

test("config rejects launch_args that are not strings", () => {
  const r = loadConfig({ version: 1, roles: [{ name: "b", kind: "claude", launch_args: [1, 2] }] });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /must be an array of strings/);
});

test("config rejects the wrong version and malformed JSON", () => {
  const bad = loadConfig({ version: 2, roles: [{ name: "b", kind: "claude" }] });
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /'version' must be 1/);

  const d = tmp();
  const p = join(d, "broken.json");
  writeFileSync(p, "{not json");
  const broken = loadConfig(p);
  assert.notEqual(broken.status, 0);
  assert.match(broken.stderr, /not valid JSON/);
});

test("config load reports a missing file by path", () => {
  const r = runLib("conductor_config_load /no/such/team.json");
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /team config not found/);
});

// --- assemble (dry run) ------------------------------------------------------

test("assemble emits the full herdr sequence for every role", () => {
  const repo = gitRepo();
  const cfg = teamConfig(repo, THREE_ROLES);
  const state = tmp("cond-state-");
  const r = runLib(`conductor_assemble "${cfg}"`, { CONDUCTOR_REPO: repo, CONDUCTOR_STATE_DIR: state });
  assert.equal(r.status, 0, r.stderr);

  // one start per role, each with its own kind and launch flags
  assert.match(r.stderr, /agent start builder-engine --kind claude/);
  assert.match(r.stderr, /agent start validator --kind codex .*-- --sandbox workspace-write/);
  assert.match(r.stderr, /agent start reviewer --kind codex .*-- --sandbox read-only/);
  // writing + gated roles get a worktree; the read-only role does not
  assert.match(r.stderr, /worktree add -b conductor\/builder-engine/);
  assert.match(r.stderr, /worktree add -b conductor\/validator/);
  assert.doesNotMatch(r.stderr, /worktree add -b conductor\/reviewer/);
  // the summary table names all three
  for (const role of ["builder-engine", "validator", "reviewer"]) assert.match(r.stdout, new RegExp(role));

  // the normalized team is recorded for render_role / reconcile to read back
  const team = JSON.parse(readFileSync(join(state, "run-t", "team.json"), "utf8"));
  assert.equal(team.roles.length, 3);
});

test("a dry-run assemble avoids Herdr and Git mutations but creates transport files", () => {
  const repo = gitRepo();
  const cfg = teamConfig(repo, THREE_ROLES);
  runLib(`conductor_assemble "${cfg}"`, { CONDUCTOR_REPO: repo });
  assert.equal(git(repo, "worktree", "list").split("\n").length, 1, "dry run created a worktree");
  assert.ok(!existsSync(join(repo, ".herdr-guard.json")), "dry run wrote a guard policy");
  assert.equal(git(repo, "branch", "--list", "conductor/*"), "", "dry run created a branch");
  assert.ok(
    existsSync(join(repo, ".conductor", ".gitignore")),
    "dry run unexpectedly stopped creating its documented local transport file",
  );
});

// --- render_role -------------------------------------------------------------

// A run whose team.json is on disk — what render_role and reconcile read back.
// Cheaper than a full assemble, which would need a live herdr.
function recordedTeam(cfg = THREE_ROLES) {
  const repo = gitRepo();
  const state = tmp("cond-state-");
  mkdirSync(join(state, "run-t"), { recursive: true });
  const p = teamConfig(repo, cfg);
  const r = runLib(`conductor_config_load "${p}" > "${join(state, "run-t", "team.json")}"`, {
    CONDUCTOR_REPO: repo,
    CONDUCTOR_STATE_DIR: state,
  });
  assert.equal(r.status, 0, r.stderr);
  return { repo, state };
}

test("render_role fills every slot and appends the report contract", () => {
  const { repo, state } = recordedTeam();
  const contract = join(tmp(), "contract.md");
  writeFileSync(contract, "Acceptance: the widget widgets.");
  const r = runLib(`conductor_render_role builder-engine "${contract}"`, {
    CONDUCTOR_REPO: repo,
    CONDUCTOR_STATE_DIR: state,
    CONDUCTOR_MISSION: "Add the widget engine.",
  });
  assert.equal(r.status, 0, r.stderr);
  const task = readFileSync(r.stdout.trim(), "utf8");

  assert.match(task, /Add the widget engine\./);
  assert.match(task, /Acceptance: the widget widgets\./);
  assert.match(task, /Ownership: the engine/);
  assert.match(task, /Do not touch: the UI/);
  assert.match(task, /branched from `main`/);
  assert.doesNotMatch(task, /\{\{/, "an unsubstituted placeholder survived");
  // completion gates on this line, so no template may omit it
  assert.ok(task.trimEnd().endsWith(SENTINEL), "the report sentinel contract was not appended");
});

test("render_role errors on an unknown role and a missing contract", () => {
  const { repo, state } = recordedTeam();
  const env = { CONDUCTOR_REPO: repo, CONDUCTOR_STATE_DIR: state };

  const ghost = runLib("conductor_render_role ghost", env);
  assert.notEqual(ghost.status, 0);
  assert.match(ghost.stderr, /not a role in this team/);

  const missing = runLib("conductor_render_role builder-engine /no/such/contract.md", env);
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /contract file not found/);
});

test("render_role refuses to run before the team is assembled", () => {
  const r = runLib("conductor_render_role builder-engine");
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /run conductor_assemble first/);
});

// --- worktrees and the guard drop --------------------------------------------

test("worktree creates a role branch, and reuses it on a second call", () => {
  const repo = gitRepo();
  const env = { CONDUCTOR_REPO: repo, CONDUCTOR_DRY_RUN: "0" };
  const first = runLib("conductor_worktree builder-engine main .conductor-worktrees", env);
  assert.equal(first.status, 0, first.stderr);
  const wt = first.stdout.trim();
  assert.ok(existsSync(wt));
  // `branch --list` prefixes "+ " for a branch checked out in another worktree
  assert.equal(
    git(repo, "branch", "--list", "conductor/builder-engine").replace(/^[+*]\s*/, "").trim(),
    "conductor/builder-engine",
  );

  // reuse matters after a crash: the worker must land back in its half-done tree
  writeFileSync(join(wt, "wip.txt"), "half-finished\n");
  const second = runLib("conductor_worktree builder-engine main .conductor-worktrees", env);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(second.stdout.trim(), wt);
  assert.ok(existsSync(join(wt, "wip.txt")), "reuse clobbered in-progress work");
});

test("conductor artifacts never show up in the user's git status", () => {
  // in-repo worktrees and the guard drop are excluded by whatever creates them,
  // via .git/info/exclude — never by editing the repo's own .gitignore
  const repo = gitRepo();
  const env = { CONDUCTOR_REPO: repo, CONDUCTOR_DRY_RUN: "0" };
  assert.equal(runLib("conductor_worktree builder-engine main .conductor-worktrees", env).status, 0);
  assert.equal(runLib(`conductor_guard_drop "${repo}"`, env).status, 0);
  assert.equal(git(repo, "status", "--porcelain=v1"), "", "conductor artifacts leaked into git status");
  assert.ok(!existsSync(join(repo, ".gitignore")), "the repo's own .gitignore was edited");
});

test("worktree rejects a role name herdr could not use", () => {
  const repo = gitRepo();
  const r = runLib("conductor_worktree Bad_Role main .conductor-worktrees", {
    CONDUCTOR_REPO: repo,
    CONDUCTOR_DRY_RUN: "0",
  });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /valid agent name/);
});

test("guard drop writes an alert-only substring policy and never clobbers", () => {
  const cwd = tmp();
  const env = { CONDUCTOR_DRY_RUN: "0" };
  const r = runLib(`conductor_guard_drop "${cwd}"`, env);
  assert.equal(r.status, 0, r.stderr);
  const policy = JSON.parse(readFileSync(r.stdout.trim(), "utf8"));
  assert.equal(policy.version, 1);
  assert.ok(policy.rules.length > 0);
  // guard's project-override contract: substring only, severity capped at alert
  for (const rule of policy.rules) {
    assert.equal(rule.match, "substring", `rule ${rule.id} uses a non-substring match`);
    assert.equal(rule.severity, "alert", `rule ${rule.id} exceeds the alert cap`);
  }
  assert.ok(policy.rules.some((x) => x.pattern === "git commit"));

  // a repo's own policy wins
  writeFileSync(join(cwd, ".herdr-guard.json"), '{"version":1,"rules":[]}');
  const again = runLib(`conductor_guard_drop "${cwd}"`, env);
  assert.equal(again.status, 0, again.stderr);
  assert.equal(again.stdout.trim(), "", "guard drop reported writing over an existing policy");
  assert.deepEqual(JSON.parse(readFileSync(join(cwd, ".herdr-guard.json"), "utf8")).rules, []);
});

// --- reconcile (KTD-7) -------------------------------------------------------

// Build a repo whose writer branches either merge cleanly or collide.
function reconcileFixture({ collide }) {
  const repo = gitRepo();
  const state = tmp("cond-state-");
  mkdirSync(join(state, "run-t"), { recursive: true });
  const cfg = {
    version: 1,
    base_branch: "main",
    roles: [
      { name: "builder-engine", kind: "claude", mode: "write" },
      { name: "builder-ui", kind: "claude", mode: "write" },
      { name: "reviewer", kind: "codex", mode: "read-only" },
    ],
  };
  const p = teamConfig(repo, cfg);
  const load = runLib(`conductor_config_load "${p}" > "${join(state, "run-t", "team.json")}"`, {
    CONDUCTOR_REPO: repo,
    CONDUCTOR_STATE_DIR: state,
  });
  assert.equal(load.status, 0, load.stderr);

  const env = { CONDUCTOR_REPO: repo, CONDUCTOR_STATE_DIR: state, CONDUCTOR_DRY_RUN: "0" };
  for (const [role, file, body] of [
    ["builder-engine", "a.txt", "engine line\n"],
    ["builder-ui", collide ? "a.txt" : "b.txt", "ui line\n"],
  ]) {
    const wt = runLib(`conductor_worktree ${role} main .conductor-worktrees`, env).stdout.trim();
    writeFileSync(join(wt, file), body, { flag: "a" });
    git(wt, "add", "-A");
    git(wt, "commit", "-qm", `${role} work`);
  }
  return { repo, state, env };
}

test("reconcile merges writer branches into one integration worktree", () => {
  const { env } = reconcileFixture({ collide: false });
  const r = runLib("conductor_reconcile", env);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /builder-engine\s+conductor\/builder-engine\s+merged/);
  assert.match(r.stdout, /builder-ui\s+conductor\/builder-ui\s+merged/);
  // read-only roles have no branch of their own and must not appear
  assert.doesNotMatch(r.stdout, /reviewer/);
});

test("reconcile reports a conflict, returns non-zero, and leaves no half-merge", () => {
  const { env } = reconcileFixture({ collide: true });
  const r = runLib("conductor_reconcile", env);
  assert.notEqual(r.status, 0, "a conflicting harvest must not report success");
  assert.match(r.stdout, /CONFLICT/);
  const into = /integration worktree: (\S+)/.exec(r.stdout)[1];
  assert.equal(git(into, "status", "--porcelain=v1"), "", "merge --abort left the tree dirty");
});

test("reconcile flags a writer branch that was never created", () => {
  const { repo, env } = reconcileFixture({ collide: false });
  // a branch checked out in a worktree can't be deleted; drop the worktree first
  git(repo, "worktree", "remove", "--force", join(repo, ".conductor-worktrees", "builder-ui"));
  git(repo, "branch", "-D", "conductor/builder-ui");
  const r = runLib("conductor_reconcile --into missing-branch-run", env);
  assert.notEqual(r.status, 0);
  assert.match(r.stdout, /builder-ui\s+conductor\/builder-ui\s+missing/);
});

test("reconcile refuses to run before the team is assembled", () => {
  const r = runLib("conductor_reconcile", { CONDUCTOR_DRY_RUN: "0" });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /run conductor_assemble first/);
});

// --- live status -------------------------------------------------------------

test("status reads live state from `agent list`, not from pane text", () => {
  // Regression for dogfood finding 4: `agent read --source detection` returns the
  // pane's rendered text, so on a cold pane every status parsed as unknown.
  const state = tmp("cond-state-");
  mkdirSync(join(state, "run-t"), { recursive: true });
  writeFileSync(join(state, "run-t", "builder.env"), "ROLE=builder\nKIND=claude\nCWD=/tmp/e\nPANE=wZ:p4\nDISPATCH_TS=0\n");
  writeFileSync(join(state, "run-t", "reviewer.env"), "ROLE=reviewer\nKIND=codex\nCWD=/tmp/r\nPANE=wZ:p5\nDISPATCH_TS=0\n");
  const bin = fakeHerdr(
    JSON.stringify({
      result: { agents: [{ name: "builder", agent_status: "working" }, { name: "reviewer", agent_status: "idle" }] },
    }),
  );
  const r = runLib("conductor_status", { CONDUCTOR_STATE_DIR: state, CONDUCTOR_DRY_RUN: "0", HERDR_BIN_PATH: bin });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /builder\s+claude\s+wZ:p4\s+working/);
  assert.match(r.stdout, /reviewer\s+codex\s+wZ:p5\s+idle/);
});

test("status falls back to unknown when herdr is unreachable, and never crashes", () => {
  const state = tmp("cond-state-");
  mkdirSync(join(state, "run-t"), { recursive: true });
  writeFileSync(join(state, "run-t", "builder.env"), "ROLE=builder\nKIND=claude\nCWD=/tmp/e\nPANE=wZ:p4\nDISPATCH_TS=0\n");
  const r = runLib("conductor_status", { CONDUCTOR_STATE_DIR: state, CONDUCTOR_DRY_RUN: "0" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /builder\s+claude\s+wZ:p4\s+unknown/);
});

test("status reports an empty run without inventing workers", () => {
  const r = runLib("conductor_status", { CONDUCTOR_DRY_RUN: "0" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /no active conductor workers/);
});

// --- repo resolution ---------------------------------------------------------

test("repo_root prefers the workspace herdr handed us over ambient cwd", () => {
  // an action inherits the herdr server's cwd; trusting it targets the wrong repo
  const workspace = gitRepo();
  const elsewhere = gitRepo();
  const r = spawnSync(BASH, ["-c", `. "${LIB}"\nconductor_repo_root`], {
    encoding: "utf8",
    cwd: elsewhere,
    env: {
      ...process.env,
      CONDUCTOR_REPO: "",
      HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({ workspace_cwd: workspace }),
    },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), git(workspace, "rev-parse", "--show-toplevel"));
});

test("repo_root fails loudly outside a repo instead of picking a nearby one", () => {
  const notARepo = tmp();
  const r = runLib("conductor_repo_root", { CONDUCTOR_REPO: notARepo, CONDUCTOR_DRY_RUN: "0" });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /is not a git repository/);
});

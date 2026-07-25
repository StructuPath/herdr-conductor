#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Scripted fast-path spawn of a 5-agent Flotion team in herdr.

The herdr port of scripts/spawn_fast.py. Boots all five panes in ONE call from
herdr/fs-team.layout.json (lead on the left half, plan/build-be/build-fe/test in
a 2x2 on the right), starts a pi role agent in each pane, warms the workers,
writes a .team/<feature>.spawn.json the orchestrator can attach to, then execs
the chosen orchestrator (Claude Code or pi) in THIS terminal so it takes command
already oriented via /herdr-did-spawn.

Two transports, on purpose:
  * layout.apply and workspace.create go over the herdr socket -- `layout.apply`
    has no CLI surface in 0.7.5, and the socket takes env as a JSON map, so API
    keys never appear in any process's argv (the CLI's repeated `--env KEY=VALUE`
    would put them in `ps`).
  * agent start / prompt / rename go through the `herdr` CLI, which is the
    proven, documented path for those.

Usage:
    uv run scripts/herdr_spawn_fast.py <cc|pi> <feature-slug> [--orch-pi-model MODEL]

Invoked by the `just fastherdr-cc` / `just fastherdr-pi` recipes.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import socket
import subprocess
import sys
import time
from pathlib import Path

# scripts/ lives at the repo root; the repo is its parent.
REPO = Path(__file__).resolve().parent.parent
LAYOUT_FILE = REPO / "herdr" / "fs-team.layout.json"
ENV_FILE = REPO / ".env"
SOCKET_PATH = Path.home() / ".config" / "herdr" / "herdr.sock"

MIN_HERDR = (0, 7, 5)
DEFAULT_ORCH_PI_MODEL = "openrouter/z-ai/glm-5.2"

# Depth-first (first, then second) order of the panes in fs-team.layout.json.
ROLES = ["lead", "plan", "build-be", "build-fe", "test"]
MODELS = {
    "lead": "openrouter/z-ai/glm-5.2",
    "plan": "openrouter/z-ai/glm-5.2",
    "build-be": "openrouter/minimax/minimax-m3",
    "build-fe": "openrouter/minimax/minimax-m3",
    "test": "openrouter/minimax/minimax-m3",
}
# lead gets the herdr-transport variant; the four workers are transport-agnostic
# and are shared verbatim with the cmux team.
ROLE_FILES = {
    "lead": ".claude/agents/lead-herdr.md",
    "plan": ".claude/agents/plan.md",
    "build-be": ".claude/agents/build-be.md",
    "build-fe": ".claude/agents/build-fe.md",
    "test": ".claude/agents/test.md",
}
PANE_LABELS = {
    "lead": "👑 lead",
    "plan": "📐 plan",
    "build-be": "⚙️ build-be",
    "build-fe": "🎨 build-fe",
    "test": "✅ test",
}


def die(msg: str) -> None:
    print(f"herdr-spawn: {msg}", file=sys.stderr)
    sys.exit(1)


# --- herdr socket -------------------------------------------------------------

def call(method: str, params: dict) -> dict:
    """One request per connection: the server closes on some error paths, and a
    reused connection then fails as a BrokenPipe that hides the real error."""
    try:
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        sock.connect(str(SOCKET_PATH))
    except OSError as exc:
        die(f"cannot reach the herdr socket at {SOCKET_PATH} ({exc}). Is herdr running?")
    try:
        sock.sendall((json.dumps({"id": f"spawn:{method}", "method": method, "params": params}) + "\n").encode())
        line = sock.makefile("r").readline()
    finally:
        sock.close()
    if not line:
        die(f"{method}: herdr closed the connection without replying (malformed params?)")
    reply = json.loads(line)
    if "error" in reply:
        die(f"{method}: {reply['error'].get('code')} — {reply['error'].get('message')}")
    return reply["result"]


# --- herdr CLI ----------------------------------------------------------------

def herdr(*args: str) -> subprocess.CompletedProcess:
    return subprocess.run(["herdr", *args], capture_output=True, text=True)


def preflight() -> None:
    ver = herdr("--version")
    if ver.returncode != 0:
        die("the `herdr` CLI is not on PATH")
    found = re.search(r"(\d+)\.(\d+)\.(\d+)", ver.stdout or "")
    if not found:
        die("cannot read the herdr version")
    if tuple(int(g) for g in found.groups()) < MIN_HERDR:
        die(f"herdr {found.group(0)} < required {'.'.join(map(str, MIN_HERDR))}")
    call("ping", {})  # proves the server is up and the protocol matches
def check_integration(kind: str) -> None:
    status = herdr("integration", "status")
    for line in (status.stdout or "").splitlines():
        if line.startswith(f"{kind}:") and "not installed" in line:
            die(f"the {kind} integration is not installed — run: herdr integration install {kind}\n"
                "(without it, agent status is guesswork instead of reported state)")


def slugify(feature: str) -> str:
    """lowercase, spaces -> dashes, keep only [a-z0-9-]."""
    return re.sub(r"[^a-z0-9-]", "", feature.lower().replace(" ", "-"))


# Values in .env.example that mean "not filled in yet". Injecting these is worse
# than injecting nothing: a placeholder ANTHROPIC_API_KEY overrides Claude Code's
# own OAuth and breaks every claude-kind agent in the team with a bogus-credential
# error that looks nothing like the real cause.
PLACEHOLDER = re.compile(r"your[\w-]*here$|^changeme$|^\.\.\.$|^<.*>$", re.I)


def read_dotenv() -> dict[str, str]:
    """Parse .env into a map. Values go over the socket, never through argv."""
    env: dict[str, str] = {}
    if not ENV_FILE.exists():
        return env
    skipped = []
    for raw in ENV_FILE.read_text().splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key, value = key.strip(), value.strip().strip('"').strip("'")
        if not value or PLACEHOLDER.search(value):
            skipped.append(key)
            continue
        env[key] = value
    if skipped:
        print(f"herdr-spawn: skipping unfilled .env entries: {', '.join(skipped)}",
              file=sys.stderr)
    return env


def build_layout() -> dict:
    """Interpolate __REPO__ and return just the `root` node."""
    obj = json.loads(LAYOUT_FILE.read_text().replace("__REPO__", str(REPO)))
    return obj["root"]


def inject_env(node: dict, env: dict[str, str]) -> dict:
    """Set env on every pane node in the tree.

    Verified on herdr 0.7.5: `env` passed to workspace.create does NOT reach panes
    that a later layout.apply creates — those panes come up with an empty value and
    the agents fail with agent_prompt_stalled. Per-pane env in the LayoutNode is the
    only path that actually carries. Do not "simplify" this back to workspace.create.
    """
    if not env:
        return node
    if node.get("type") == "pane":
        node["env"] = {**env, **node.get("env", {})}
    else:
        inject_env(node["first"], env)
        inject_env(node["second"], env)
    return node


def panes_in_order(node: dict, out: list[str] | None = None) -> list[str]:
    """Depth-first (first, then second) — the order ROLES is written in."""
    out = [] if out is None else out
    if node.get("type") == "pane":
        out.append(node["pane_id"])
    else:
        panes_in_order(node["first"], out)
        panes_in_order(node["second"], out)
    return out


def start_agent(name: str, pane: str, role_file: str, model: str, kind: str) -> None:
    """A freshly laid-out pane is not a startable shell for ~1-2s; poll through
    agent_pane_busy rather than failing the whole team on a race."""
    # pi takes the role file as a path and the model as a flag. Other kinds are
    # started bare and read their role in as their first prompt (see role_prompt):
    # herdr refuses argv it cannot shell-encode, and a markdown role file inlined
    # as a flag value trips that with invalid_agent_argument.
    argv = ["--append-system-prompt", role_file, "--model", model] if kind == "pi" else []
    last = ""
    for _ in range(25):
        proc = herdr("agent", "start", name, "--kind", kind, "--pane", pane,
                     "--timeout", "60000", "--", *argv)
        last = (proc.stdout or "") + (proc.stderr or "")
        if "agent_pane_busy" in last:
            time.sleep(1)
            continue
        if '"error"' in last:
            die(f"agent start failed for {name}: {last[:300]}")
        return
    die(f"agent start for {name} never got a free pane: {last[:300]}")


def write_spawn_file(feature: str, workspace: str, tab: str, panes: dict[str, str],
                     agent: str, kind: str) -> Path:
    spawn = REPO / ".team" / f"{feature}.herdr-spawn.json"
    spawn.parent.mkdir(parents=True, exist_ok=True)
    spawn.write_text(json.dumps({
        "feature": feature,
        "transport": "herdr",
        "workspace": workspace,
        "workspace_name": feature,
        "tab": tab,
        "orchestrator": agent,
        "kind": kind,
        "layout": "herdr/fs-team.layout.json",
        "agents": {
            # MODELS only applies to pi, which takes --model; other kinds use
            # whatever they are configured with, so don't claim a model we didn't set.
            role: {"name": f"{role}-{feature}", "pane": panes[role],
                   **({"model": MODELS[role]} if kind == "pi" else {})}
            for role in ROLES
        },
    }, indent=2) + "\n")
    return spawn


def exec_orchestrator(agent: str, feature: str, orch_pi_model: str) -> None:
    """Replace this process with the orchestrator, oriented to the spawned team."""
    os.chdir(REPO)  # so the relative spawn-file arg resolves for /herdr-did-spawn
    sys.stdout.flush()
    attach = f"/herdr-did-spawn .team/{feature}.herdr-spawn.json"
    if agent == "cc":
        os.execvp("claude", ["claude", "--dangerously-skip-permissions",
                             "--model", "opus[1m]", attach])
    else:
        os.execvp("pi", ["pi", "--name", f"orchestrator-{feature}",
                         "--model", orch_pi_model, attach])


def main() -> None:
    parser = argparse.ArgumentParser(description="Fast-path spawn of a 5-agent Flotion team in herdr.")
    parser.add_argument("agent", choices=["cc", "pi"], help="orchestrator: cc (Claude Code) or pi")
    parser.add_argument("feature", help="feature slug (dash-case); names the team's workspace")
    parser.add_argument("--orch-pi-model", default=DEFAULT_ORCH_PI_MODEL,
                        help=f"model for the pi orchestrator (default: {DEFAULT_ORCH_PI_MODEL})")
    parser.add_argument("--dry-run", action="store_true",
                        help="print the layout that would be applied and exit")
    parser.add_argument("--no-attach", action="store_true",
                        help="spawn the team and print the roster, but don't exec the orchestrator")
    parser.add_argument("--kind", default="pi",
                        help="herdr agent kind for the five workers (default: pi). "
                             "Use `claude` if pi has no provider configured — the role files "
                             "are prompts, not pi-specific, so they load either way. "
                             "`herdr integration status` shows which kinds are wired up.")
    args = parser.parse_args()

    feature = slugify(args.feature)
    if not feature:
        die("feature slug is empty after slugification")

    root = build_layout()
    if args.dry_run:
        print(json.dumps({"workspace_label": feature, "root": root,
                          "roles": ROLES, "models": MODELS}, indent=2, ensure_ascii=False))
        return

    preflight()
    check_integration(args.kind)

    dotenv = read_dotenv()
    if not dotenv:
        print("herdr-spawn: warning — no .env found; the panes will inherit the herdr "
              "server's environment, which usually lacks OPENROUTER_API_KEY.\n"
              "             If the agents stall on their first turn, run: cp .env.example .env",
              file=sys.stderr)
    inject_env(root, dotenv)

    created = call("workspace.create", {"label": feature, "cwd": str(REPO), "focus": False})
    workspace = created["workspace"]["workspace_id"]

    # layout.apply REPLACES the tab and hands back a new tab_id — capture it.
    applied = call("layout.apply", {"tab_id": created["tab"]["tab_id"], "root": root, "focus": False})
    tab = applied["layout"]["tab_id"]
    pane_ids = panes_in_order(applied["layout"]["root"])
    if len(pane_ids) != len(ROLES):
        die(f"layout produced {len(pane_ids)} panes, expected {len(ROLES)}")
    panes = dict(zip(ROLES, pane_ids))

    for role, pane in panes.items():
        herdr("pane", "rename", pane, PANE_LABELS[role])
    herdr("workspace", "report-metadata", workspace, "--source", "herdr-spawn-fast",
          "--token", f"team={feature}", "--token", "roles=5")

    # workers first, then the lead — so the lead comes up to a team that exists
    for role in ["plan", "build-be", "build-fe", "test", "lead"]:
        print(f"  starting {role}-{feature} ({args.kind}) in {panes[role]} ...", flush=True)
        start_agent(f"{role}-{feature}", panes[role], ROLE_FILES[role], MODELS[role], args.kind)

    # Warm each worker: a cold interactive agent can swallow its first real prompt.
    # For non-pi kinds this same turn is also where the role gets loaded.
    # NOTE: `agent prompt` takes its text as the SECOND POSITIONAL — it must come
    # immediately after the target, before any flags, or the CLI rejects the text
    # as "unknown option" and the agent is never prompted at all.
    def role_prompt(role: str) -> str:
        if args.kind == "pi":
            return f"Reply 'ready: {role}' and wait for the lead."
        return (f"Read {ROLE_FILES[role]} and adopt it as your operating instructions "
                f"for this whole session. Then reply 'ready: {role}' and wait for the lead.")

    warm_roles = ["plan", "build-be", "build-fe", "test"]
    if args.kind != "pi":
        warm_roles.append("lead")  # pi got its role via --append-system-prompt; others didn't
    for role in warm_roles:
        warm = herdr("agent", "prompt", f"{role}-{feature}", role_prompt(role),
                     "--wait", "--until", "idle", "--until", "done", "--timeout", "180000")
        blob = (warm.stdout or "") + (warm.stderr or "")
        if "agent_prompt_stalled" in blob:
            die(f"{role}-{feature} accepted a prompt but never started a turn.\n"
                f"Almost always missing credentials: this repo has no .env, so the panes "
                f"inherit the herdr server's environment.\n"
                f"Fix: cp .env.example .env, fill in OPENROUTER_API_KEY, then re-run "
                f"(after `herdr workspace close {workspace}`).")
        if '"error"' in blob:
            die(f"warm-up failed for {role}-{feature}: {blob[:300]}")

    spawn = write_spawn_file(feature, workspace, tab, panes, args.agent, args.kind)
    herdr("workspace", "focus", workspace)

    print(f"team workspace={workspace} tab={tab} lead={panes['lead']}  spawn={spawn}", flush=True)
    if args.no_attach:
        for role in ROLES:
            detail = MODELS[role] if args.kind == "pi" else args.kind
            print(f"  {role:<9s} {role + '-' + feature:<26s} {panes[role]:<8s} {detail}")
        print(f"\nattach with:  claude '/herdr-did-spawn {spawn.relative_to(REPO)}'"
              f"\nteardown:     herdr workspace close {workspace}")
        return
    print(f"launching {args.agent} orchestrator, already aware via /herdr-did-spawn ...", flush=True)

    exec_orchestrator(args.agent, feature, args.orch_pi_model)


if __name__ == "__main__":
    main()

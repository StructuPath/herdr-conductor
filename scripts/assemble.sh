#!/usr/bin/env bash
# Action: assemble the team declared in the workspace's .herdr-conductor.json —
# a worktree per writing role, a guard audit drop per review role, one live agent
# pane per role — then open the board over it.
#
# The config comes from the WORKSPACE repo, not this plugin's cwd: an action
# inherits whatever cwd the herdr server had, so conductor_repo_root resolves the
# repo from HERDR_PLUGIN_CONTEXT_JSON instead.
set -uo pipefail
cd "${HERDR_PLUGIN_ROOT:-$(dirname "$0")/..}" || { echo "herdr-conductor: cannot resolve plugin root"; exit 1; }
. scripts/lib.sh

repo="$(conductor_repo_root)" || exit 1
cfg="$repo/$CONDUCTOR_CONFIG_NAME"
if [ ! -f "$cfg" ]; then
  echo "herdr-conductor: no team config at $cfg"
  echo "  Declare the team first — see 'Declaring a team' in the plugin README."
  exit 1
fi

if ! conductor_assemble "$cfg"; then
  echo
  echo "herdr-conductor: assemble finished with errors (above)."
  echo "  Some resources may remain. Inspect them manually; re-running is not recovery."
  exit 1
fi

echo
# A dry run avoids the live Herdr session and Git mutations, but the transport
# still writes run records and .conductor files; see README.md.
if [ "${CONDUCTOR_DRY_RUN:-0}" = 1 ]; then
  echo "herdr-conductor: dry run — board not opened."
  exit 0
fi
bash scripts/board.sh

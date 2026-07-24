#!/usr/bin/env bash
# Board pane entrypoint: resolve context in bash, exec the zero-dep Node renderer.
# Early failures route through pane_fatal so the pane stays readable.
set -uo pipefail
cd "${HERDR_PLUGIN_ROOT:-$(dirname "$0")/..}" || { echo "herdr-conductor: cannot resolve plugin root"; sleep 600; exit 1; }
. scripts/lib.sh
pane_require_node "board pane"
export HERDR_BIN_PATH CONDUCTOR_STATE_DIR
export CONDUCTOR_PLUGIN_ROOT
exec node bin/renderer.mjs

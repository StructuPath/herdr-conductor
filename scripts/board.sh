#!/usr/bin/env bash
# Stage 1 B2 context-bound board snapshot. It opens or focuses no unproven pane.
set -uo pipefail
cd "${HERDR_PLUGIN_ROOT:-$(dirname "$0")/..}" || {
	echo "herdr-conductor: cannot resolve plugin root"
	exit 1
}
exec node scripts/stage1-runtime.mjs board

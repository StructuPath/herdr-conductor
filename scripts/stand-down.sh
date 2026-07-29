#!/usr/bin/env bash
# Stage 1 B3 identity-checked pane close and strict-state archive only.
set -uo pipefail
cd "${HERDR_PLUGIN_ROOT:-$(dirname "$0")/..}" || {
	echo "herdr-conductor: cannot resolve plugin root"
	exit 1
}
exec node scripts/stage1-runtime.mjs stand-down

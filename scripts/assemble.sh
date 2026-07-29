#!/usr/bin/env bash
# Stage 1 B2 action: assemble only from strict context-bound JSON state.
set -uo pipefail
cd "${HERDR_PLUGIN_ROOT:-$(dirname "$0")/..}" || {
	echo "herdr-conductor: cannot resolve plugin root"
	exit 1
}
exec node scripts/stage1-runtime.mjs assemble

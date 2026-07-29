#!/usr/bin/env bash
# Stage 1 B2 one-shot status over the invoking repository/workspace only.
set -uo pipefail
cd "${HERDR_PLUGIN_ROOT:-$(dirname "$0")/..}" || {
	echo "herdr-conductor: cannot resolve plugin root"
	exit 1
}
exec node scripts/stage1-runtime.mjs status

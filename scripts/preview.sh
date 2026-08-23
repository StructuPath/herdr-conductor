#!/usr/bin/env bash
# Stage 3: journal one zero-effect apply preview for the configured target ref.
set -uo pipefail
cd "${HERDR_PLUGIN_ROOT:-$(dirname "$0")/..}" || {
	echo "herdr-conductor: cannot resolve plugin root"
	exit 1
}
exec node scripts/stage1-runtime.mjs preview

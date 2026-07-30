#!/usr/bin/env bash
# Stage 2 attended report collection, one-CAS integration, and gate progression.
set -uo pipefail
cd "${HERDR_PLUGIN_ROOT:-$(dirname "$0")/..}" || {
	echo "herdr-conductor: cannot resolve plugin root"
	exit 1
}
exec node scripts/stage1-runtime.mjs harvest

#!/usr/bin/env bash
# Stage 3: consume the approve receipt and move the apply ref with one CAS.
set -uo pipefail
cd "${HERDR_PLUGIN_ROOT:-$(dirname "$0")/..}" || {
	echo "herdr-conductor: cannot resolve plugin root"
	exit 1
}
exec node scripts/stage1-runtime.mjs apply

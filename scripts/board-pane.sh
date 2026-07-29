#!/usr/bin/env bash
# Stage 1 B2 pane entrypoint: context-bound renderer over strict JSON state.
set -uo pipefail
cd "${HERDR_PLUGIN_ROOT:-$(dirname "$0")/..}" || {
	echo "herdr-conductor: cannot resolve plugin root"
	sleep 600
	exit 1
}
export CONDUCTOR_PLUGIN_ROOT="${HERDR_PLUGIN_ROOT:-$PWD}"
exec node bin/renderer.mjs

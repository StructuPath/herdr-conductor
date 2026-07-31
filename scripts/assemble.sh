#!/usr/bin/env bash
# Stage 2: publish task/outbox authority before task-bound pane and agent effects.
set -uo pipefail
cd "${HERDR_PLUGIN_ROOT:-$(dirname "$0")/..}" || {
	echo "herdr-conductor: cannot resolve plugin root"
	exit 1
}
exec node scripts/stage1-runtime.mjs assemble

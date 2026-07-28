#!/usr/bin/env bash
# Action: harvest the run — merge every writing role's branch into one integration
# worktree and print the per-branch result (KTD-7).
#
# Plain git, not `herdr-swarm harvest`: conductor worktrees are role-differentiated
# git worktrees, not swarm slots, so swarm's harvest reads its own run registry and
# would find nothing here. Nothing is forced and no branch is deleted — a CONFLICT
# row means that branch was left untouched for a human to merge.
set -uo pipefail
cd "${HERDR_PLUGIN_ROOT:-$(dirname "$0")/..}" || {
	echo "herdr-conductor: cannot resolve plugin root"
	exit 1
}
. scripts/lib.sh

if ! conductor_pin_active_run >/dev/null; then
	echo "herdr-conductor: no active conductor run to harvest."
	exit 0
fi

# shellcheck disable=SC2119 # action intentionally accepts no positional arguments
if conductor_reconcile; then
	echo "herdr-conductor: harvest clean — every writer branch merged."
	exit 0
fi
echo "herdr-conductor: harvest incomplete — see the CONFLICT/missing rows above. Branches are untouched."
exit 1

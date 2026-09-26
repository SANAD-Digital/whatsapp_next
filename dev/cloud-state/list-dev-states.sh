#!/usr/bin/env bash
# list-dev-states.sh - list snapshots in the configured backend (local or r2).
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec env PYTHONPATH="$HERE/lib" PYTHONDONTWRITEBYTECODE=1 python3 -m devstate.cli list "$@"

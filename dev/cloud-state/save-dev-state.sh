#!/usr/bin/env bash
# save-dev-state.sh - see README.md. Thin wrapper: the logic lives in lib/devstate/ (Python, stdlib only).
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec env PYTHONPATH="$HERE/lib" PYTHONDONTWRITEBYTECODE=1 python3 -m devstate.cli save "$@"

#!/usr/bin/env bash
# session-start-hook.sh - PROPOSED Claude Code SessionStart hook (not installed automatically).
#
# Safe by design: starts services and reports state. It NEVER restores or overwrites a database,
# never runs bench init/build, never fails the session start (always exits 0). Restoring data stays
# an explicit command:  sudo dev/cloud-state/bootstrap-cloud.sh --restore-latest -- --dry-run
#
# To enable it, add to .claude/settings.json (see README.md, "SessionStart hook"):
#   {"hooks": {"SessionStart": [{"hooks": [{"type": "command",
#     "command": "\"$CLAUDE_PROJECT_DIR\"/dev/cloud-state/session-start-hook.sh", "timeout": 300}]}]}}
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG=/tmp/dev-state-session-start.log

# Only in a remote Claude Cloud session running as root; do nothing on a developer's laptop.
if [[ "${CLAUDE_CODE_REMOTE:-}" != "true" || $EUID -ne 0 ]]; then
	exit 0
fi

if "$HERE/bootstrap-cloud.sh" --session-start >"$LOG" 2>&1; then
	status="ready"
else
	status="NOT ready"
fi
fails=$(grep -c '^\s*\[FAIL\]' "$LOG" || true)
latest=$(grep -m1 '^\*' "$LOG" | awk '{print $2}')
echo "Frappe dev environment: $status (verify: ${fails:-0} FAIL). Full log: $LOG"
[[ -n "$latest" ]] && echo "Latest dev-state snapshot: $latest (not restored; restore explicitly if wanted)."
grep -E '^(ERROR|WARN) ' "$LOG" | head -5
exit 0

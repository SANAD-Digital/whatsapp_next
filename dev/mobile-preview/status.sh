#!/usr/bin/env bash
# status.sh - show the state of the mobile preview: processes, login, tunnel, URLs. Read-only.
#
#   ./dev/mobile-preview/status.sh
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

line() { printf '  %-34s %s\n' "$1" "$2"; }
state() { if mp_alive "$1" "$2"; then echo "running (pid $(cat "$(mp_pid "$1")"))"; else echo "stopped"; fi; }

echo "MOBILE PREVIEW ($MP_NAME)   runtime: $MP_RUNTIME_DIR"
show_site() {
	line "$2 web 127.0.0.1:$3" "$(state "$1-web" "$(mp_web_token "$3")")"
	line "$2 proxy 127.0.0.1:$4" "$(state "$1-proxy" "$(mp_proxy_token "$4")")"
}
mp_each_site show_site

if ! command -v devtunnel >/dev/null 2>&1; then
	line "devtunnel CLI" "not installed (sudo dev/cloud-state/cloud-environment-setup.sh)"
	exit 0
fi
if mp_logged_in; then line "Microsoft login" "logged in"
elif mp_alive login "devtunnel user login"; then
	line "Microsoft login" "WAITING for device login: $(grep -m1 -i 'enter the code' "$(mp_log login)" || true)"
else line "Microsoft login" "not logged in (start.sh prints a device code)"; fi

TID=$(cat "$MP_TUNNEL_ID_FILE" 2>/dev/null || true)
line "tunnel" "${TID:-not selected yet (label $MP_LABEL)}"
[[ -n "$TID" ]] && line "tunnel host" "$(state tunnel "$(mp_tunnel_token "$TID")")"
if [[ -n "$TID" ]] && mp_alive tunnel "$(mp_tunnel_token "$TID")" && [[ -s "$MP_URLS_FILE" ]]; then
	echo
	while read -r key u; do printf '%s MOBILE URL: %s\n' "${key^^}" "$u"; done < "$MP_URLS_FILE"
fi

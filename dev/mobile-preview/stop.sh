#!/usr/bin/env bash
# stop.sh - stop the mobile preview processes started by start.sh (only those: PID + command line).
#
#   ./dev/mobile-preview/stop.sh                   stop tunnel host, proxies and web servers
#   ./dev/mobile-preview/stop.sh --tunnel-only     stop only the tunnel host (URLs go offline,
#                                                  the local sites keep running)
#   ./dev/mobile-preview/stop.sh --delete-tunnel   also delete the tunnel at Microsoft: the next
#                                                  start.sh creates a new one with NEW URLs
#
# By default the tunnel itself (and so its URLs) is kept at Microsoft and reused by start.sh.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

TUNNEL_ONLY=0 DELETE=0
while [[ $# -gt 0 ]]; do
	case "$1" in
		--tunnel-only) TUNNEL_ONLY=1 ;;
		--delete-tunnel) DELETE=1 ;;
		-h|--help) sed -n '2,11p' "$0"; exit 0 ;;
		*) die "unknown option: $1" ;;
	esac
	shift
done

TID=$(cat "$MP_TUNNEL_ID_FILE" 2>/dev/null || true)
say "stopping mobile preview ($MP_NAME)"
mp_stop tunnel "$(mp_tunnel_token "${TID:-.}")"
mp_stop login "devtunnel user login"
rm -f "$MP_URLS_FILE"
if [[ $TUNNEL_ONLY -eq 0 ]]; then
	stop_site() {
		mp_stop "$1-proxy" "$(mp_proxy_token "$4")"
		mp_stop "$1-web" "$(mp_web_token "$3")"
	}
	mp_each_site stop_site
fi
if [[ $DELETE -eq 1 && -n "$TID" ]]; then
	dt delete "$TID" -f >/dev/null && ok "tunnel deleted at Microsoft" || warn "could not delete tunnel $TID"
	rm -f "$MP_TUNNEL_ID_FILE"
fi
ok "done"

#!/usr/bin/env bash
# start.sh - public HTTPS mobile preview of the local Frappe sites through a Microsoft Dev Tunnel.
#
# Development only. Run after `sudo dev/cloud-state/bootstrap-cloud.sh --session-start` (databases
# and Redis up). Idempotent: components that already run are left alone.
#
#   sudo ./dev/mobile-preview/start.sh                 start everything, verify, print the URLs
#   sudo ./dev/mobile-preview/start.sh --wait-login    if a device login is needed, wait for it
#   sudo ./dev/mobile-preview/start.sh --local-only    web + proxies only, no tunnel
#   options: --no-verify
#
# For each site (common.sh MP_SITES): gunicorn on 127.0.0.1:<web_port>, site_proxy.py on
# 127.0.0.1:<proxy_port>. Then one tunnel with the proxy ports as HTTP ports, anonymous connect.
# The tunnel is reused across sessions (found by label), so its URLs stay the same.
#
# Exit codes: 0 ok; 1 error or verification FAIL; 3 Microsoft device login needed (URL + code printed).
set -euo pipefail
umask 077
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

WAIT_LOGIN=0 LOCAL_ONLY=0 VERIFY=1
while [[ $# -gt 0 ]]; do
	case "$1" in
		--wait-login) WAIT_LOGIN=1 ;;
		--local-only) LOCAL_ONLY=1 ;;
		--no-verify) VERIFY=0 ;;
		-h|--help) sed -n '2,19p' "$0"; exit 0 ;;
		*) die "unknown option: $1" ;;
	esac
	shift
done

# ---- preflight ----------------------------------------------------------------------------------
[[ -x "$BENCH_DIR/env/bin/gunicorn" ]] || die "no bench at $BENCH_DIR: run sudo dev/cloud-state/bootstrap-cloud.sh"
check_site() {
	[[ -f "$BENCH_DIR/sites/$2/site_config.json" ]] \
		|| die "site $2 not found: restore it first (sudo dev/cloud-state/restore-dev-state.sh latest --dry-run)"
}
mp_each_site check_site
if [[ $LOCAL_ONLY -eq 0 ]]; then
	command -v devtunnel >/dev/null 2>&1 \
		|| die "devtunnel CLI not installed: run sudo dev/cloud-state/cloud-environment-setup.sh"
fi
mp_init_runtime
# A private copy of the proxy owned by frappe: the checkout may not be readable by that user.
PROXY_PY="$MP_RUNTIME_DIR/$MP_NAME-site_proxy.py"
as_frappe bash -c 'umask 077; cat > "$1"' _ "$PROXY_PY" < "$MP_DIR/site_proxy.py"

# ---- 1. web servers + proxies (loopback) --------------------------------------------------------
say "local web servers and site proxies (127.0.0.1 only)"
start_site() {
	local key=$1 site=$2 web=$3 proxy=$4
	if mp_alive "$key-web" "$(mp_web_token "$web")"; then ok "$site web already on 127.0.0.1:$web"
	elif mp_port_open "$web"; then die "127.0.0.1:$web is used by another process (not started by this tool)"
	else
		mp_spawn "$key-web" "$BENCH_DIR/sites" "$BENCH_DIR/env/bin/gunicorn" -b "127.0.0.1:$web" \
			-w "$MP_WEB_WORKERS" -t 120 "frappe.app:application_with_statics()"
		ok "$site web started on 127.0.0.1:$web"
	fi
	if mp_alive "$key-proxy" "$(mp_proxy_token "$proxy")"; then ok "$site proxy already on 127.0.0.1:$proxy"
	elif mp_port_open "$proxy"; then die "127.0.0.1:$proxy is used by another process (not started by this tool)"
	else
		mp_spawn "$key-proxy" "$MP_RUNTIME_DIR" "$BENCH_DIR/env/bin/python" "$PROXY_PY" "$proxy" "$web" "$site"
		ok "$site proxy started on 127.0.0.1:$proxy -> :$web"
	fi
}
mp_each_site start_site

wait_site() {
	local key=$1 site=$2 web=$3 proxy=$4
	for _ in $(seq 1 60); do
		# An arbitrary Host proves the site comes from the proxy, not from the hostname.
		if curl -s -m 5 -H "Host: mobile-preview.invalid" "http://127.0.0.1:$proxy/api/method/ping" | grep -q pong; then
			ok "$site answers through 127.0.0.1:$proxy"; return 0
		fi
		sleep 1
	done
	tail -5 "$(mp_log "$key-web")" >&2 || true
	die "$site does not answer on 127.0.0.1:$proxy (databases/Redis up? run sudo dev/cloud-state/bootstrap-cloud.sh --session-start; log: $(mp_log "$key-web"))"
}
mp_each_site wait_site

if [[ $LOCAL_ONLY -eq 1 ]]; then
	if [[ $VERIFY -eq 1 ]]; then exec "$MP_DIR/verify.sh" --local-only; fi
	exit 0
fi

# ---- 2. safety gate: nothing but the proxies may be exposed -------------------------------------
say "safety check before exposing anything"
"$MP_DIR/verify.sh" --safety-only || die "safety check failed: not starting the tunnel"

# ---- 3. Microsoft Dev Tunnels login -------------------------------------------------------------
say "Microsoft Dev Tunnels login"
if mp_logged_in; then
	ok "logged in"
else
	if ! mp_alive login "devtunnel user login"; then
		mp_spawn login "$FRAPPE_HOME" devtunnel user login -d
	fi
	url="" code=""
	for _ in $(seq 1 30); do
		line=$(grep -m1 -i "enter the code" "$(mp_log login)" 2>/dev/null || true)
		if [[ -n "$line" ]]; then
			url=$(grep -oE 'https://[^ ]+' <<<"$line" | head -1)
			code=$(grep -oE 'code [A-Z0-9]+' <<<"$line" | awk '{print $2}')
			break
		fi
		mp_alive login "devtunnel user login" || break
		sleep 1
	done
	if [[ -z "$code" ]]; then
		mp_logged_in && ok "logged in" || { tail -5 "$(mp_log login)" >&2 || true; die "device login did not start (log: $(mp_log login))"; }
	else
		echo
		echo "MICROSOFT DEVICE LOGIN REQUIRED"
		echo "  1. Open:  ${url:-https://login.microsoft.com/device}"
		echo "  2. Enter: $code"
		echo "  3. Sign in with the Microsoft account that owns the tunnel (the code expires after ~15 minutes)."
		echo
		if [[ $WAIT_LOGIN -eq 0 ]]; then
			echo "Then run this command again: $0"
			exit 3
		fi
		echo "Waiting for the sign-in to complete..."
		while mp_alive login "devtunnel user login"; do sleep 5; done
		mp_logged_in || die "login did not complete (code expired?). Run $0 again for a new code."
		ok "logged in"
	fi
fi

# ---- 4. the tunnel: reuse (id file, then label), else create -----------------------------------
say "tunnel"
tunnel_json() { dt show "$1" --json 2>/dev/null; }
TID="${MOBILE_PREVIEW_TUNNEL_ID:-}"
[[ -z "$TID" && -s "$MP_TUNNEL_ID_FILE" ]] && TID=$(cat "$MP_TUNNEL_ID_FILE")
if [[ -n "$TID" ]] && ! tunnel_json "$TID" >/dev/null; then warn "tunnel $TID no longer exists"; TID=""; fi
if [[ -z "$TID" ]]; then
	TID=$(dt list --labels "$MP_LABEL" --json 2>/dev/null \
		| python3 -c "import json,sys;t=json.load(sys.stdin).get('tunnels') or [];print(t[0]['tunnelId'] if t else '')" || true)
	[[ -n "$TID" ]] && ok "reusing tunnel labelled $MP_LABEL"
fi
if [[ -z "$TID" ]]; then
	TID=$(dt create --labels "$MP_LABEL" --allow-anonymous --expiration "$MP_TUNNEL_EXPIRATION" \
		--description "whatsapp_next mobile preview (development)" --json \
		| python3 -c "import json,sys;d=json.load(sys.stdin);print((d.get('tunnel') or d)['tunnelId'])") \
		|| die "could not create a tunnel"
	ok "created tunnel (label $MP_LABEL, expires after $MP_TUNNEL_EXPIRATION unused)"
fi
as_frappe bash -c 'umask 077; printf "%s\n" "$1" > "$2"' _ "$TID" "$MP_TUNNEL_ID_FILE"

# Converge the tunnel's configuration: label, one HTTP port per proxy port, anonymous connect.
info=$(tunnel_json "$TID") || die "cannot read tunnel $TID"
jq_py() { python3 -c "import json,sys;t=json.load(sys.stdin)['tunnel'];$1" <<<"$info"; }
if ! jq_py "sys.exit('$MP_LABEL' not in t.get('labels',[]))"; then
	dt update "$TID" --add-labels "$MP_LABEL" >/dev/null && ok "label $MP_LABEL added"
fi
ensure_port() {
	local proxy=$4
	if jq_py "sys.exit($proxy not in [p['portNumber'] for p in t.get('ports',[])])"; then ok "port $proxy present"
	else dt port create "$TID" -p "$proxy" --protocol http >/dev/null && ok "port $proxy added (http)"; fi
}
mp_each_site ensure_port
if jq_py "sys.exit(not any(a.get('type')=='Anonymous' and 'connect' in a.get('scopes',[]) and not a.get('isDeny') for a in t.get('accessControl',[])))"; then
	ok "anonymous connect allowed"
else
	dt access create "$TID" --anonymous >/dev/null && ok "anonymous connect added"
fi

# ---- 5. host the tunnel -------------------------------------------------------------------------
say "tunnel host"
if mp_alive tunnel "$(mp_tunnel_token "$TID")"; then ok "already hosting"
else
	mp_spawn tunnel "$FRAPPE_HOME" devtunnel host "$TID"
	for _ in $(seq 1 60); do
		grep -q "Ready to accept connections" "$(mp_log tunnel)" 2>/dev/null && break
		mp_alive tunnel "$(mp_tunnel_token "$TID")" || { tail -5 "$(mp_log tunnel)" >&2; die "devtunnel host exited (log: $(mp_log tunnel))"; }
		sleep 1
	done
	grep -q "Ready to accept connections" "$(mp_log tunnel)" || die "tunnel not ready after 60 s (log: $(mp_log tunnel))"
	ok "hosting"
fi

# Public URL per site, from the tunnel's port URIs (runtime only, never committed).
info=$(tunnel_json "$TID") || die "cannot read tunnel $TID"
: > "$MP_URLS_FILE.tmp"
write_url() {
	local key=$1 proxy=$4 u
	u=$(jq_py "print(next((p.get('portUri','') for p in t.get('ports',[]) if p['portNumber']==$proxy),'').rstrip('/'))")
	[[ -n "$u" ]] || die "no public URL for port $proxy"
	printf '%s %s\n' "$key" "$u" >> "$MP_URLS_FILE.tmp"
}
mp_each_site write_url
as_frappe bash -c 'umask 077; cat > "$1"' _ "$MP_URLS_FILE" < "$MP_URLS_FILE.tmp"; rm -f "$MP_URLS_FILE.tmp"

# ---- 6. verify through the public URLs ----------------------------------------------------------
rc=0
if [[ $VERIFY -eq 1 ]]; then
	say "verify"
	"$MP_DIR/verify.sh" || rc=1
fi
echo
while read -r key u; do
	printf '%s MOBILE URL: %s\n' "${key^^}" "$u"
done < "$MP_URLS_FILE"
[[ $rc -eq 0 ]] || echo "VERIFY: FAIL (see above)"
exit $rc

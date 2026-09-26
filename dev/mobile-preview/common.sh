# common.sh - shared settings and helpers for the mobile preview scripts (sourced, not executed).
#
# Development only. Every local process binds 127.0.0.1; only the Microsoft Dev Tunnel host
# makes the two proxy ports reachable from outside. Nothing here holds or writes a credential:
# the devtunnel CLI keeps its own login under ~frappe, and runtime files (PIDs, logs, the tunnel
# id and URLs) live in $MP_RUNTIME_DIR, outside every Git repository.
#
# Every setting can be overridden from the environment. A second, independent instance (e.g. for
# testing) only needs a different MOBILE_PREVIEW_NAME, MOBILE_PREVIEW_SITES and MOBILE_PREVIEW_LABEL.

MP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BENCH_DIR="${BENCH_DIR:-/home/frappe/frappe-bench}"
FRAPPE_USER="${FRAPPE_USER:-frappe}"
FRAPPE_HOME="${FRAPPE_HOME:-$(getent passwd "$FRAPPE_USER" | cut -d: -f6)}"
FRAPPE_HOME="${FRAPPE_HOME:-/home/$FRAPPE_USER}"  # holds the devtunnel login (~/.local/share/DevTunnels)
MP_RUNTIME_DIR="${MOBILE_PREVIEW_RUNTIME_DIR:-$FRAPPE_HOME/.dev-state/runtime}"
MP_NAME="${MOBILE_PREVIEW_NAME:-mobile-preview}"
# key:site:web_port:proxy_port  (web = gunicorn, proxy = site_proxy.py; the tunnel exposes proxy ports)
MP_SITES="${MOBILE_PREVIEW_SITES:-platform:platform.localhost:8001:8101 whatsapp:whatsapp.localhost:8002:8102}"
# The tunnel is found again in a later session by this label (the tunnel itself lives at Microsoft).
MP_LABEL="${MOBILE_PREVIEW_LABEL:-whatsapp-next-mobile-preview}"
MP_TUNNEL_EXPIRATION="${MOBILE_PREVIEW_TUNNEL_EXPIRATION:-30d}"
MP_WEB_WORKERS="${MOBILE_PREVIEW_WEB_WORKERS:-2}"

MP_TUNNEL_ID_FILE="$MP_RUNTIME_DIR/$MP_NAME.tunnel-id"
MP_URLS_FILE="$MP_RUNTIME_DIR/$MP_NAME.urls"

say()  { echo "==> $*"; }
ok()   { echo "OK    $*"; }
warn() { echo "WARN  $*"; }
die()  { echo "ERROR $*" >&2; exit 1; }

# Run a command as the frappe user with the session's egress proxy (the devtunnel CLI needs it;
# local traffic never goes through it). Works when called as root or as the frappe user.
as_frappe() {
	local proxy="${HTTPS_PROXY:-${https_proxy:-}}"
	local envs=(HOME="$FRAPPE_HOME" NO_PROXY="127.0.0.1,localhost" no_proxy="127.0.0.1,localhost")
	[[ -n "$proxy" ]] && envs+=(HTTPS_PROXY="$proxy" https_proxy="$proxy")
	if [[ $EUID -eq 0 ]]; then
		runuser -u "$FRAPPE_USER" -- env "${envs[@]}" "$@"
	elif [[ "$(id -un)" == "$FRAPPE_USER" ]]; then
		env "${envs[@]}" "$@"
	else
		die "run as root or as $FRAPPE_USER"
	fi
}
# From ~frappe: with no usable data directory the CLI writes ./DevTunnels/ into the current directory.
dt() { (cd "$FRAPPE_HOME" && as_frappe devtunnel "$@"); }

mp_init_runtime() {
	if [[ $EUID -eq 0 ]]; then
		install -d -m 700 -o "$FRAPPE_USER" -g "$FRAPPE_USER" "$FRAPPE_HOME/.dev-state" "$MP_RUNTIME_DIR"
	else
		(umask 077; mkdir -p "$MP_RUNTIME_DIR")
	fi
}

# Runtime file paths for one component, e.g. mp_pid platform-web
mp_pid() { echo "$MP_RUNTIME_DIR/$MP_NAME-$1.pid"; }
mp_log() { echo "$MP_RUNTIME_DIR/$MP_NAME-$1.log"; }

# A PID file is only trusted when that process still runs AND its command line contains $2:
# after a VM restart old PIDs are stale and may belong to unrelated processes.
mp_alive() {
	local pid
	pid=$(cat "$(mp_pid "$1")" 2>/dev/null) || return 1
	[[ "$pid" =~ ^[0-9]+$ && -r /proc/$pid/cmdline ]] || return 1
	tr '\0' ' ' < "/proc/$pid/cmdline" | grep -qF -- "$2"
}

# Start a detached process as frappe: own session, no inherited stdio, PID and log in runtime/.
# mp_spawn <component> <workdir> <command...>
mp_spawn() {
	local comp=$1 dir=$2; shift 2
	as_frappe bash -c 'umask 077; cd "$1" || exit 1; pidf=$2; log=$3; shift 3
		setsid nohup "$@" </dev/null >"$log" 2>&1 &
		echo $! >"$pidf"' _ "$dir" "$(mp_pid "$comp")" "$(mp_log "$comp")" "$@"
}

# mp_stop <component> <cmdline-token>
mp_stop() {
	local pidf; pidf=$(mp_pid "$1")
	if mp_alive "$1" "$2"; then
		local pid; pid=$(cat "$pidf")
		kill "$pid" 2>/dev/null || true
		for _ in $(seq 1 20); do kill -0 "$pid" 2>/dev/null || break; sleep 0.5; done
		kill -0 "$pid" 2>/dev/null && kill -9 "$pid" 2>/dev/null
		ok "stopped $1 (pid $pid)"
	fi
	rm -f "$pidf"
}

# Iterate sites: mp_each_site <function>; the function gets key site web_port proxy_port
mp_each_site() {
	local entry key site web proxy
	for entry in $MP_SITES; do
		IFS=: read -r key site web proxy <<<"$entry"
		"$1" "$key" "$site" "$web" "$proxy"
	done
}

mp_port_open() { python3 -c "import socket,sys;s=socket.socket();s.settimeout(1);sys.exit(s.connect_ex(('127.0.0.1',int(sys.argv[1]))))" "$1"; }

# Retried: one failed call through the egress proxy must not trigger a needless device login.
mp_logged_in() {
	local _
	for _ in 1 2 3; do
		dt user show --json 2>/dev/null \
			| python3 -c "import json,sys;sys.exit(json.load(sys.stdin).get('status')!='Logged in')" 2>/dev/null && return 0
		sleep 2
	done
	return 1
}

# Tokens that identify our processes in /proc/<pid>/cmdline
mp_web_token()    { echo "127.0.0.1:$1"; }
mp_proxy_token()  { echo "site_proxy.py $1 "; }
mp_tunnel_token() { echo "devtunnel host $1"; }

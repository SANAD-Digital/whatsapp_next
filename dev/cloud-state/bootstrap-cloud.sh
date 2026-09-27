#!/usr/bin/env bash
# bootstrap-cloud.sh - LAYER 2: per-session preparation of a Claude Cloud session. Idempotent.
#
# Layer 1 (cloud-environment-setup.sh, cached by Claude Cloud) provides packages and runtimes.
# This script does what must happen in EVERY session, because no process survives between
# sessions: start services, make sure the bench, repositories and app links exist, optionally
# restore a snapshot, verify.
#
#   sudo ./bootstrap-cloud.sh                        services + bench + repos + verify
#   sudo ./bootstrap-cloud.sh --restore-latest [-- --force --yes]
#   sudo ./bootstrap-cloud.sh --restore <id>   [-- --force --yes]
#   sudo ./bootstrap-cloud.sh --session-start        fast, never restores, never builds (for hooks)
#   options: --start-mock --start-web --with-r2
#            --mobile-preview   also run dev/mobile-preview/start.sh (public HTTPS URLs via a
#                               Microsoft Dev Tunnel). Never implied: without it nothing is exposed.
#
# It never: re-runs bench init on an existing bench, recreates an existing MariaDB volume,
# overwrites an existing site, switches a repository's branch, or restores data unless asked.
set -euo pipefail
umask 077  # state, secrets and logs this script writes are private

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
while IFS='=' read -r key value; do
	[[ -z "$key" || "$key" == \#* ]] && continue
	[[ -z "${!key+x}" ]] && export "$key=$value"
done < "$HERE/config/defaults.env"

RESTORE="" WITH_R2=0 START_MOCK=0 START_WEB=0 SESSION_START=0 MOBILE_PREVIEW=0
RESTORE_ARGS=()
while [[ $# -gt 0 ]]; do
	case "$1" in
		--restore-latest) RESTORE=latest ;;
		--restore) RESTORE="${2:?--restore needs a snapshot id}"; shift ;;
		--with-r2) WITH_R2=1 ;;
		--start-mock) START_MOCK=1 ;;
		--start-web) START_WEB=1 ;;
		--session-start) SESSION_START=1 ;;
		--mobile-preview) MOBILE_PREVIEW=1 ;;
		--) shift; RESTORE_ARGS=("$@"); break ;;
		-h|--help) sed -n '2,18p' "$0"; exit 0 ;;
		*) echo "unknown option: $1" >&2; exit 2 ;;
	esac
	shift
done
[[ $SESSION_START -eq 1 && -n "$RESTORE" ]] && { echo "--session-start never restores" >&2; exit 2; }

step() { echo "==> $*"; }
ok()   { echo "OK    $*"; }
skip() { echo "SKIP  $* (already present)"; }
warn() { echo "WARN  $*"; }
die()  { echo "ERROR $*" >&2; exit 1; }
[[ $EUID -eq 0 ]] || die "run as root"
as_frappe() { runuser -l "$FRAPPE_USER" -c "$*" </dev/null; }
# Long-running services are fully detached: own session, no inherited stdin/stdout/stderr.
spawn_frappe() { runuser -l "$FRAPPE_USER" -c "cd '$1' && setsid nohup $2 </dev/null >'$3' 2>&1 &" </dev/null >/dev/null 2>&1; }
new_secret() { python3 -c "import secrets;print('$1-'+secrets.token_urlsafe(18))"; }

# ---- 0. layer 1 present? ------------------------------------------------------------------------
step "base environment (layer 1)"
if bash "$HERE/cloud-environment-setup.sh" --check >/tmp/dev-state-base-check.log 2>&1; then ok "complete"
elif [[ $SESSION_START -eq 1 ]]; then
	grep MISS /tmp/dev-state-base-check.log || true
	die "base environment incomplete; run: sudo $HERE/cloud-environment-setup.sh (or fix the Cloud environment setup script)"
else
	grep MISS /tmp/dev-state-base-check.log || true
	warn "base environment incomplete in this image; running cloud-environment-setup.sh now (fallback)"
	bash "$HERE/cloud-environment-setup.sh"
fi
install -d -m 700 -o "$FRAPPE_USER" -g "$FRAPPE_USER" "$DEV_SECRETS_DIR" "$DEV_STATE_DIR"

# ---- 1. PostgreSQL ------------------------------------------------------------------------------
step "PostgreSQL $PG_CLUSTER_VERSION/$PG_CLUSTER_NAME"
if ! pg_lsclusters -h 2>/dev/null | awk -v v="$PG_CLUSTER_VERSION" -v n="$PG_CLUSTER_NAME" '$1==v && $2==n {f=1} END{exit !f}'; then
	pg_createcluster "$PG_CLUSTER_VERSION" "$PG_CLUSTER_NAME" >/dev/null; ok "cluster created"
fi
if pg_isready -q -h "$PG_HOST" -p "$PG_PORT"; then skip "postgres running"
else pg_ctlcluster "$PG_CLUSTER_VERSION" "$PG_CLUSTER_NAME" start </dev/null >/dev/null 2>&1; sleep 2
	pg_isready -q -h "$PG_HOST" -p "$PG_PORT" || die "postgres did not start"; ok "postgres started (pg_ctlcluster; no systemd)"; fi
PG_PW_FILE="$DEV_SECRETS_DIR/postgres-root.pw"
[[ -s "$PG_PW_FILE" ]] || { (umask 077; new_secret dev-pg > "$PG_PW_FILE"); chown "$FRAPPE_USER:" "$PG_PW_FILE"; }
pg_auth_ok() { runuser -u "$FRAPPE_USER" -- env PGPASSWORD="$(cat "$PG_PW_FILE")" psql -X -h "$PG_HOST" -p "$PG_PORT" -U "$PG_ROOT_USER" -d "$PG_ROOT_USER" -Atc 'select 1' >/dev/null 2>&1; }
if pg_auth_ok; then skip "dev root role $PG_ROOT_USER"
else
	printf '%s\n' "\\set pw '$(cat "$PG_PW_FILE")'" \
		"DO \$\$BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='$PG_ROOT_USER') THEN CREATE ROLE $PG_ROOT_USER LOGIN SUPERUSER; END IF; END\$\$;" \
		"ALTER ROLE $PG_ROOT_USER WITH LOGIN SUPERUSER PASSWORD :'pw';" | runuser -u postgres -- psql -q -v ON_ERROR_STOP=1 >/dev/null
	runuser -u postgres -- psql -Atc "SELECT 1 FROM pg_database WHERE datname='$PG_ROOT_USER'" | grep -q 1 \
		|| runuser -u postgres -- createdb -O "$PG_ROOT_USER" "$PG_ROOT_USER"
	pg_auth_ok || die "postgres dev root authentication failing"; ok "dev root role $PG_ROOT_USER ready"
fi

# ---- 2. Docker + MariaDB ------------------------------------------------------------------------
step "Docker + MariaDB ($MARIADB_IMAGE)"
if docker info >/dev/null 2>&1; then skip "dockerd"
else setsid nohup dockerd </dev/null >"$DEV_STATE_DIR/dockerd.log" 2>&1 &
	for _ in $(seq 1 30); do docker info >/dev/null 2>&1 && break; sleep 1; done
	docker info >/dev/null 2>&1 || die "dockerd did not start (see $DEV_STATE_DIR/dockerd.log)"; ok "dockerd started (no systemd)"; fi
MY_PW_FILE="$DEV_SECRETS_DIR/mariadb-root.pw"
if docker container inspect "$MARIADB_CONTAINER" >/dev/null 2>&1; then
	if [[ "$(docker inspect -f '{{.State.Running}}' "$MARIADB_CONTAINER")" == true ]]; then skip "container $MARIADB_CONTAINER"
	else docker start "$MARIADB_CONTAINER" >/dev/null; ok "container $MARIADB_CONTAINER started"; fi
else
	if docker volume inspect "$MARIADB_VOLUME" >/dev/null 2>&1; then
		[[ -s "$MY_PW_FILE" ]] || die "volume $MARIADB_VOLUME exists but $MY_PW_FILE is missing: its root password cannot be recovered"
		ok "reusing existing volume $MARIADB_VOLUME"
	else
		[[ -s "$MY_PW_FILE" ]] || { (umask 077; new_secret dev-mariadb > "$MY_PW_FILE"); chown "$FRAPPE_USER:" "$MY_PW_FILE"; }
		docker volume create "$MARIADB_VOLUME" >/dev/null
	fi
	docker run -d --name "$MARIADB_CONTAINER" -p "$MARIADB_HOST:$MARIADB_PORT:3306" -v "$MARIADB_VOLUME:/var/lib/mysql" \
		-e MARIADB_ROOT_PASSWORD="$(cat "$MY_PW_FILE")" \
		--health-cmd "healthcheck.sh --connect --innodb_initialized" --health-interval 5s --health-timeout 5s --health-retries 20 \
		"$MARIADB_IMAGE" --character-set-server=utf8mb4 --collation-server=utf8mb4_unicode_ci >/dev/null
	ok "container $MARIADB_CONTAINER created"
fi
for _ in $(seq 1 60); do [[ "$(docker inspect -f '{{.State.Health.Status}}' "$MARIADB_CONTAINER")" == healthy ]] && break; sleep 2; done
cnf=$(mktemp); chmod 600 "$cnf"
printf '[client]\nuser=%s\npassword=%s\nhost=%s\nport=%s\nprotocol=TCP\n' "$MARIADB_ROOT_USER" "$(cat "$MY_PW_FILE")" "$MARIADB_HOST" "$MARIADB_PORT" > "$cnf"
if v=$(mariadb --defaults-extra-file="$cnf" -Nse "select version()" 2>/dev/null); then ok "mariadb $v"; else rm -f "$cnf"; die "mariadb root authentication failed"; fi
rm -f "$cnf"

# ---- 3. repositories (full mode only) -----------------------------------------------------------
python3 - "$HERE/config/repos.json" > "$DEV_STATE_DIR/.repos.tsv" <<'PY'
import json, sys
for r in json.load(open(sys.argv[1]))["repositories"]:
    print("\t".join([r["app"], r["url"], r["branch"], r.get("remote", "origin"), r.get("path", ""), r["install"]]))
PY
if [[ $SESSION_START -eq 0 ]]; then
	step "application repositories"
	while IFS=$'\t' read -r app url branch remote path install; do
		[[ "$install" == soft-link ]] || continue
		if [[ -d "$path/.git" ]]; then skip "$app at $path ($(git -C "$path" branch --show-current))"
		else
			git clone --branch "$branch" --origin "$remote" "$url" "$path" </dev/null \
				|| die "cannot clone $app ($url, branch $branch): attach the repository to this Claude session, then re-run"
			ok "cloned $app ($branch)"
		fi
		setfacl -R -m "u:$FRAPPE_USER:rwX" -m "d:u:$FRAPPE_USER:rwX" "$path"
		as_frappe "git config --global --get-all safe.directory | grep -qx '$path' || git config --global --add safe.directory '$path'"
	done < "$DEV_STATE_DIR/.repos.tsv"
fi

# ---- 4. bench + app links -----------------------------------------------------------------------
step "bench at $BENCH_DIR"
if [[ -d "$BENCH_DIR/apps/frappe" ]]; then skip "bench (not re-initialised)"
elif [[ $SESSION_START -eq 1 ]]; then warn "no bench yet: run sudo $HERE/bootstrap-cloud.sh"
else
	as_frappe "cd ~ && bench init '$BENCH_DIR' --frappe-branch '$FRAPPE_BRANCH' --python \"\$(uv python find $PYTHON_VERSION)\" --no-backups" \
		|| die "bench init failed"
	ok "bench initialised"
fi
if [[ -d "$BENCH_DIR/apps/frappe" ]]; then
	while IFS=$'\t' read -r app url branch remote path install; do
		[[ "$app" == frappe ]] && continue
		if [[ -e "$BENCH_DIR/apps/$app" ]]; then skip "app $app"; continue; fi
		if [[ $SESSION_START -eq 1 ]]; then warn "app $app missing from the bench (run the full bootstrap)"; continue; fi
		if [[ "$install" == soft-link ]]; then
			as_frappe "cd '$BENCH_DIR' && bench get-app --soft-link --skip-assets '$path' && bench build --app '$app'" || die "linking $app failed"
		else
			as_frappe "cd '$BENCH_DIR' && bench get-app '$app' '$url' --branch '$branch'" || die "get-app $app failed"
		fi
		ok "app $app added"
	done < "$DEV_STATE_DIR/.repos.tsv"
fi

# ---- 5. Redis -----------------------------------------------------------------------------------
if [[ -d "$BENCH_DIR/config" ]]; then
	step "Redis (bench configs)"
	for conf in redis_cache redis_queue; do
		port=$(awk '$1=="port"{print $2}' "$BENCH_DIR/config/$conf.conf")
		if redis-cli -p "$port" ping 2>/dev/null | grep -q PONG; then skip "$conf :$port"
		else as_frappe "cd '$BENCH_DIR' && redis-server config/$conf.conf --daemonize yes" >/dev/null; sleep 1
			redis-cli -p "$port" ping | grep -q PONG || die "$conf did not start"; ok "$conf :$port started"; fi
	done
fi

# ---- 6. optional: R2 helper venv ----------------------------------------------------------------
if [[ $WITH_R2 -eq 1 ]]; then
	step "R2 helper venv"
	if "$DEV_STATE_R2_VENV/bin/python" -c "import boto3" 2>/dev/null; then skip "boto3 venv"
	else python3 -m venv "$DEV_STATE_R2_VENV" && "$DEV_STATE_R2_VENV/bin/pip" install -q boto3; ok "boto3 venv at $DEV_STATE_R2_VENV"; fi
fi

# ---- 7. optional: restore (explicit only) -------------------------------------------------------
if [[ -n "$RESTORE" ]]; then
	step "restore dev-state '$RESTORE'"
	# restore-dev-state reconciles db host/port with this session and migrates only when app commits differ.
	"$HERE/restore-dev-state.sh" "$RESTORE" "${RESTORE_ARGS[@]}"
fi

# ---- 8. /etc/hosts for every site ---------------------------------------------------------------
for d in "$BENCH_DIR"/sites/*/; do
	[[ -f "$d/site_config.json" ]] || continue
	site=$(basename "$d")
	grep -qE "^[0-9.]+\s+(.*\s)?$site(\s|$)" /etc/hosts || printf '127.0.0.1\t%s\t# frappe dev site (dev-state)\n' "$site" >> /etc/hosts
done

# ---- 9. optional: loopback-only dev services ----------------------------------------------------
if [[ $START_MOCK -eq 1 ]]; then
	step "wa-admin mock"
	# Discovery: WA_ADMIN_MOCK_DIR (config/defaults.env), else dev/wa_admin_mock next to this script,
	# so any clone location works.
	[[ -f "$WA_ADMIN_MOCK_DIR/wa_admin_mock.py" ]] || WA_ADMIN_MOCK_DIR="$(cd "$HERE/.." && pwd)/wa_admin_mock"
	if python3 -c "import socket,sys;s=socket.socket();s.settimeout(1);sys.exit(s.connect_ex(('127.0.0.1',$WA_ADMIN_MOCK_PORT)))"; then skip "mock running (127.0.0.1:$WA_ADMIN_MOCK_PORT answers)"
	elif [[ ! -f "$WA_ADMIN_MOCK_DIR/wa_admin_mock.py" ]]; then warn "mock not found at $WA_ADMIN_MOCK_DIR"
	else
		# The mock must accept the secret the (possibly restored) platform site sends.
		secret=$(python3 - "$BENCH_DIR/sites" "$WA_ADMIN_MOCK_PORT" <<'PY'
import json, pathlib, sys
for p in sorted(pathlib.Path(sys.argv[1]).glob("*/site_config.json")):
    c = json.loads(p.read_text())
    if f":{sys.argv[2]}" in str(c.get("wa_admin_api_url", "")) and c.get("wa_admin_secret"):
        print(c["wa_admin_secret"]); break
PY
)
		f="$DEV_SECRETS_DIR/wa-admin-mock.secret"
		if [[ -n "$secret" ]]; then (umask 077; printf '%s\n' "$secret" > "$f"); elif [[ ! -s "$f" ]]; then (umask 077; new_secret dev-wa-admin-mock > "$f"); fi
		chown "$FRAPPE_USER:" "$f"
		install -d -m 700 -o "$FRAPPE_USER" -g "$FRAPPE_USER" "$DEV_STATE_DIR/runtime"
		spawn_frappe "$WA_ADMIN_MOCK_DIR" "env WA_MOCK_ADMIN_SECRET=\"\$(cat '$f')\" '$BENCH_DIR/env/bin/python' wa_admin_mock.py --host 127.0.0.1 --port $WA_ADMIN_MOCK_PORT --state-file '$DEV_STATE_DIR/runtime/wa-admin-mock.state.json'" "/home/$FRAPPE_USER/wa-admin-mock.log"
		sleep 1
		python3 -c "import socket,sys;s=socket.socket();s.settimeout(1);sys.exit(s.connect_ex(('127.0.0.1',$WA_ADMIN_MOCK_PORT)))" \
			&& ok "mock on 127.0.0.1:$WA_ADMIN_MOCK_PORT" || warn "mock did not start (see ~$FRAPPE_USER/wa-admin-mock.log)"
	fi
fi
if [[ $START_WEB -eq 1 ]]; then
	step "web (gunicorn, loopback)"
	# The port, not `pgrep -f`: a pattern match also hits any shell whose command line mentions the address.
	if python3 -c "import socket,sys;s=socket.socket();s.settimeout(1);sys.exit(s.connect_ex(('127.0.0.1',$DEV_WEB_PORT)))"; then skip "gunicorn (127.0.0.1:$DEV_WEB_PORT answers)"
	else spawn_frappe "$BENCH_DIR/sites" "../env/bin/gunicorn -b 127.0.0.1:$DEV_WEB_PORT -w 2 -t 120 --preload frappe.app:application" "/home/$FRAPPE_USER/gunicorn-dev.log"
		sleep 3; ok "gunicorn on 127.0.0.1:$DEV_WEB_PORT"; fi
fi

# ---- 10. verify + snapshot availability ---------------------------------------------------------
step "verify"
if [[ -d "$BENCH_DIR/apps/frappe" ]]; then
	"$HERE/verify-dev-state.sh" || warn "verify reported FAIL lines (see above)"
fi
if [[ $SESSION_START -eq 1 ]]; then
	echo
	"$HERE/list-dev-states.sh" 2>/dev/null | head -5 || true
	echo "No data was restored. To restore explicitly: sudo $HERE/bootstrap-cloud.sh --restore-latest -- --dry-run"
fi

# ---- 11. optional: mobile preview (explicit only) -----------------------------------------------
if [[ $MOBILE_PREVIEW -eq 1 ]]; then
	step "mobile preview (Microsoft Dev Tunnel)"
	# Exit 3 = device login needed: start.sh has printed the URL and code; not a bootstrap failure.
	rc=0; "$(cd "$HERE/.." && pwd)/mobile-preview/start.sh" || rc=$?
	[[ $rc -eq 0 || $rc -eq 3 ]] || warn "mobile preview failed (exit $rc); see the output above"
fi

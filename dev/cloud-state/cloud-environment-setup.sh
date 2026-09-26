#!/usr/bin/env bash
# cloud-environment-setup.sh - LAYER 1: the static, cacheable base of a Claude Cloud environment.
#
# Paste this file into the Claude Cloud environment settings -> Setup script. Claude Cloud caches
# the resulting image, so this may NOT run again for every session. It therefore only installs
# things that are identical for every session and never depends on a process staying alive:
#
#   Ubuntu packages (build deps, MariaDB client + dev libs, PostgreSQL 16, Redis, age, ACL, Docker CLI)
#   CA/TLS trust for the frappe user's toolchain, uv, Python 3.14, Node 24, Yarn 1.x,
#   the frappe user, the Bench CLI, and (optionally) a pre-pulled mariadb:11.8 image.
#
# It never: creates or restores databases or sites, starts services as its final state,
# clones private repositories, or contains any secret. Idempotent: safe to run any number of times.
#
#   bash cloud-environment-setup.sh            install/verify everything
#   bash cloud-environment-setup.sh --check    report only; exit 1 if anything is missing
set -euo pipefail

# Self-contained on purpose: the environment settings hold only this file, not the repository.
FRAPPE_USER="${FRAPPE_USER:-frappe}"
PYTHON_VERSION="${PYTHON_VERSION:-3.14}"
NODE_MAJOR="${NODE_MAJOR:-24}"
NODE_DIR="${NODE_DIR:-/opt/node24}"
PG_VERSION="${PG_CLUSTER_VERSION:-16}"
MARIADB_IMAGE="${MARIADB_IMAGE:-mariadb:11.8}"
PREPULL_MARIADB="${PREPULL_MARIADB:-1}"

CHECK=0
[[ "${1:-}" == "--check" ]] && CHECK=1
[[ $EUID -eq 0 ]] || { echo "run as root" >&2; exit 1; }

missing_count=0
step() { echo "==> $*"; }
ok()   { echo "OK    $*"; }
have() { echo "SKIP  $* (present)"; }
need() { echo "MISS  $*"; missing_count=$((missing_count + 1)); }
as_frappe() { runuser -l "$FRAPPE_USER" -c "$*" </dev/null; }

# ---- packages -----------------------------------------------------------------------------------
step "Ubuntu packages"
PKGS=(ca-certificates curl git xz-utils acl age build-essential pkg-config
	libmariadb-dev libmariadb-dev-compat mariadb-client
	"postgresql-$PG_VERSION" "postgresql-client-$PG_VERSION" redis-server)
missing=()
for p in "${PKGS[@]}"; do dpkg -s "$p" >/dev/null 2>&1 || missing+=("$p"); done
command -v docker >/dev/null 2>&1 || missing+=(docker.io)
if [[ ${#missing[@]} -eq 0 ]]; then have "all packages"
elif [[ $CHECK -eq 1 ]]; then need "packages: ${missing[*]}"
else
	export DEBIAN_FRONTEND=noninteractive
	apt-get update -qq || echo "WARN  apt-get update reported errors (some third-party mirrors may be blocked)"
	apt-get install -y -q --no-install-recommends "${missing[@]}" >/dev/null
	ok "installed: ${missing[*]}"
fi
# A freshly installed server package must not leave a cluster running in the cached image.
# Only a cluster started by THIS run's install is stopped; a running session's cluster is left alone.
if [[ $CHECK -eq 0 && " ${missing[*]:-} " == *" postgresql-$PG_VERSION "* ]]; then
	pg_ctlcluster "$PG_VERSION" main stop 2>/dev/null || true
fi

# ---- uv -----------------------------------------------------------------------------------------
step "uv (>= 0.9, from PyPI)"
uv_ok() { [[ -x /usr/local/bin/uv ]] && /usr/local/bin/uv --version | awk '{split($2,v,"."); exit !(v[1]>0 || v[2]>=9)}'; }
if uv_ok; then have "uv $(/usr/local/bin/uv --version | awk '{print $2}')"
elif [[ $CHECK -eq 1 ]]; then need "uv"
else
	python3 -m venv /opt/uv-bootstrap && /opt/uv-bootstrap/bin/pip install -q -U uv
	install -m 0755 /opt/uv-bootstrap/bin/uv /usr/local/bin/uv
	ok "uv $(/usr/local/bin/uv --version | awk '{print $2}')"
fi

# ---- frappe user + TLS trust --------------------------------------------------------------------
step "user $FRAPPE_USER and toolchain profile"
if id "$FRAPPE_USER" >/dev/null 2>&1; then have "user $FRAPPE_USER"
elif [[ $CHECK -eq 1 ]]; then need "user $FRAPPE_USER"
else useradd -m -s /bin/bash "$FRAPPE_USER"; ok "created $FRAPPE_USER"; fi
PROFILE="/home/$FRAPPE_USER/.profile"
if grep -q "dev-state toolchain" "$PROFILE" 2>/dev/null; then have "profile"
elif [[ $CHECK -eq 1 ]]; then need "profile block in $PROFILE"
else
	# The session's TLS-inspecting proxy CA is in the system store; uv, Node and requests ship their
	# own CA bundles unless told otherwise, and fail with UnknownIssuer / SELF_SIGNED_CERT_IN_CHAIN.
	cat >> "$PROFILE" <<EOF

# dev-state toolchain (cloud-environment-setup.sh): Node $NODE_MAJOR and user tools first; trust the system CA store.
export PATH="$NODE_DIR/bin:\$HOME/.local/bin:\$PATH"
export UV_SYSTEM_CERTS=true
export NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt
export REQUESTS_CA_BUNDLE=/etc/ssl/certs/ca-certificates.crt
EOF
	chown "$FRAPPE_USER:" "$PROFILE"; ok "profile configured"
fi

# ---- Node + Yarn --------------------------------------------------------------------------------
step "Node $NODE_MAJOR + Yarn 1.x"
if [[ -x "$NODE_DIR/bin/node" && "$("$NODE_DIR/bin/node" --version)" == v$NODE_MAJOR.* ]]; then have "node $("$NODE_DIR/bin/node" --version)"
elif [[ $CHECK -eq 1 ]]; then need "node $NODE_MAJOR at $NODE_DIR"
else
	ver=$(curl -fsS https://nodejs.org/dist/index.json | python3 -c "import json,sys;print(next(r['version'] for r in json.load(sys.stdin) if r['version'].startswith('v$NODE_MAJOR.')))")
	tmp=$(mktemp -d); f="node-$ver-linux-x64.tar.xz"
	curl -fsS -o "$tmp/$f" "https://nodejs.org/dist/$ver/$f"
	curl -fsS -o "$tmp/SHASUMS256.txt" "https://nodejs.org/dist/$ver/SHASUMS256.txt"
	(cd "$tmp" && grep " $f\$" SHASUMS256.txt | sha256sum -c - >/dev/null) || { echo "node checksum mismatch" >&2; exit 1; }
	mkdir -p "$NODE_DIR" && tar -xJf "$tmp/$f" -C "$NODE_DIR" --strip-components=1 && rm -rf "$tmp"
	chmod -R a+rX "$NODE_DIR"; ok "node $ver (sha256 verified)"
fi
if [[ -x "$NODE_DIR/bin/yarn" ]]; then have "yarn $("$NODE_DIR/bin/yarn" --version)"
elif [[ $CHECK -eq 1 ]]; then need "yarn"
else PATH="$NODE_DIR/bin:$PATH" "$NODE_DIR/bin/npm" install -g -s yarn@1; ok "yarn $("$NODE_DIR/bin/yarn" --version)"; fi

# ---- Python + Bench (frappe user) ---------------------------------------------------------------
step "Python $PYTHON_VERSION + Bench CLI"
if as_frappe "uv python find $PYTHON_VERSION" >/dev/null 2>&1; then have "python $(as_frappe "\$(uv python find $PYTHON_VERSION) --version")"
elif [[ $CHECK -eq 1 ]]; then need "python $PYTHON_VERSION for $FRAPPE_USER"
else as_frappe "uv python install $PYTHON_VERSION" >/dev/null; ok "python $PYTHON_VERSION"; fi
if as_frappe "command -v bench" >/dev/null 2>&1; then have "bench $(as_frappe 'bench --version')"
elif [[ $CHECK -eq 1 ]]; then need "bench CLI"
else as_frappe "uv tool install frappe-bench" >/dev/null; ok "bench $(as_frappe 'bench --version')"; fi

# ---- optional: pre-pull the MariaDB image (dockerd is stopped again afterwards) ----------------
if [[ "$PREPULL_MARIADB" == 1 ]]; then
	step "pre-pull $MARIADB_IMAGE"
	started=0
	if ! docker info >/dev/null 2>&1 && [[ $CHECK -eq 0 ]]; then
		setsid nohup dockerd </dev/null >/tmp/dockerd-setup.log 2>&1 & started=1
		for _ in $(seq 1 30); do docker info >/dev/null 2>&1 && break; sleep 1; done
	fi
	if docker image inspect "$MARIADB_IMAGE" >/dev/null 2>&1; then have "image $MARIADB_IMAGE"
	elif [[ $CHECK -eq 1 ]]; then echo "INFO  image $MARIADB_IMAGE not pre-pulled (bootstrap pulls it on demand)"
	elif docker info >/dev/null 2>&1; then docker pull -q "$MARIADB_IMAGE" >/dev/null && ok "pulled $MARIADB_IMAGE"
	else echo "WARN  dockerd unavailable during setup; bootstrap will pull $MARIADB_IMAGE"; fi
	if [[ $started -eq 1 ]]; then pkill -x dockerd || true; sleep 2; fi
fi

if [[ $CHECK -eq 1 ]]; then
	[[ $missing_count -eq 0 ]] && echo "base environment complete" || { echo "$missing_count item(s) missing"; exit 1; }
else
	echo "base environment ready (no services left running, no secrets written)"
fi

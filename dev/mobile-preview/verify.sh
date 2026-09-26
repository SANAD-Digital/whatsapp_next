#!/usr/bin/env bash
# verify.sh - checks for the mobile preview. Read-only: it changes nothing, it only sends GET requests.
#
#   ./dev/mobile-preview/verify.sh                 safety + local proxies + public URLs (when hosting)
#   ./dev/mobile-preview/verify.sh --local-only    safety + local proxies
#   ./dev/mobile-preview/verify.sh --safety-only   loopback-only listeners, schedulers, workers
#
# Per site and per target (local proxy, public URL): /login 200 with a Frappe page, the first CSS and
# JS bundle it references 200 with the right type, /api/method/ping = pong, and the correct site:
# a public file unique to that site is served byte-identical, and another site's file is not.
# Safety: PostgreSQL, MariaDB, Redis, gunicorn and proxy ports listen on loopback only; schedulers
# disabled on every preview site; no worker/scheduler processes.
# Exit 1 when any FAIL line is printed.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

MODE=all
case "${1:-}" in
	"") ;;
	--local-only) MODE=local ;;
	--safety-only) MODE=safety ;;
	-h|--help) sed -n '2,14p' "$0"; exit 0 ;;
	*) die "unknown option: $1" ;;
esac

# Public URLs only while this instance's tunnel host runs.
URLS=""
if [[ $MODE == all && -s "$MP_URLS_FILE" && -s "$MP_TUNNEL_ID_FILE" ]] \
	&& mp_alive tunnel "$(mp_tunnel_token "$(cat "$MP_TUNNEL_ID_FILE")")"; then
	URLS=$(cat "$MP_URLS_FILE")
fi

# Scheduler state per site (as frappe; bench reads the site database).
SCHED=""
sched_status() {
	local s
	# The bench's own Python, not the bench CLI: no dependency on the frappe user's PATH or HOME.
	s=$(as_frappe bash -c 'cd "$1/sites" && "$1/env/bin/python" -m frappe.utils.bench_helper frappe --site "$2" scheduler status' \
		_ "$BENCH_DIR" "$2" 2>&1 | tail -1 || true)
	SCHED+="$2	$s"$'\n'
}
mp_each_site sched_status

MODE="$MODE" URLS="$URLS" SCHED="$SCHED" MP_SITES="$MP_SITES" BENCH_DIR="$BENCH_DIR" \
	TUNNEL_EXPECTED="$([[ $MODE == all && -s "$MP_TUNNEL_ID_FILE" ]] && echo 1 || echo 0)" \
	python3 - <<'PY'
import hashlib, json, os, re, socket, struct, sys, urllib.error, urllib.parse, urllib.request
from pathlib import Path

mode = os.environ["MODE"]
bench = Path(os.environ["BENCH_DIR"])
sites = [dict(zip(("key", "site", "web", "proxy"), e.split(":"))) for e in os.environ["MP_SITES"].split()]
urls = dict(l.split(" ", 1) for l in os.environ["URLS"].splitlines() if " " in l)
fails = warns = 0


def report(level, what, detail=""):
	global fails, warns
	fails += level == "FAIL"
	warns += level == "WARN"
	print(f"  [{level:4}] {what:<48} {detail}")


# ---- safety ------------------------------------------------------------------------------------
print("SAFETY")
listeners = {}
for name, fam in (("/proc/net/tcp", 4), ("/proc/net/tcp6", 6)):
	try:
		lines = Path(name).read_text().splitlines()[1:]
	except OSError:
		continue
	for line in lines:
		f = line.split()
		if f[3] != "0A":  # LISTEN
			continue
		hexip, hexport = f[1].split(":")
		raw = bytes.fromhex(hexip)
		if fam == 4:
			ip = socket.inet_ntop(socket.AF_INET, raw[::-1])
		else:
			ip = socket.inet_ntop(socket.AF_INET6, b"".join(raw[i : i + 4][::-1] for i in range(0, 16, 4)))
		listeners.setdefault(int(hexport, 16), set()).add(ip)


def loopback(ip):
	return ip.startswith("127.") or ip in ("::1", "::ffff:127.0.0.1")


guarded = {}
common = {}
try:
	common = json.loads((bench / "sites/common_site_config.json").read_text())
except (OSError, ValueError):
	pass
for s in sites:
	try:
		c = json.loads((bench / "sites" / s["site"] / "site_config.json").read_text())
	except (OSError, ValueError):
		c = {}
	db_type = c.get("db_type") or common.get("db_type") or "mariadb"
	port = int(c.get("db_port") or common.get("db_port") or (5432 if db_type == "postgres" else 3306))
	guarded[port] = f"{'PostgreSQL' if db_type == 'postgres' else 'MariaDB'} ({s['site']})"
	guarded[int(s["web"])] = f"gunicorn {s['site']}"
	guarded[int(s["proxy"])] = f"proxy {s['site']}"
for k in ("redis_cache", "redis_queue", "redis_socketio"):
	m = re.search(r":(\d+)", str(common.get(k, "")))
	if m:
		guarded.setdefault(int(m.group(1)), f"Redis ({k})")
for port in sorted(guarded):
	ips = listeners.get(port)
	if not ips:
		report("INFO", f"{guarded[port]} :{port}", "not listening")
	elif all(loopback(ip) for ip in ips):
		report("PASS", f"{guarded[port]} :{port}", "loopback only (" + ", ".join(sorted(ips)) + ")")
	else:
		report("FAIL", f"{guarded[port]} :{port}", "EXPOSED on " + ", ".join(sorted(ips)))

for line in os.environ["SCHED"].splitlines():
	site, _, status = line.partition("\t")
	if "disabled" in status.lower():
		report("PASS", f"scheduler {site}", "disabled")
	else:
		report("FAIL", f"scheduler {site}", status.strip() or "unknown")

procs = {"worker": [], "scheduler": []}
for p in Path("/proc").iterdir():
	if not p.name.isdigit():
		continue
	try:
		cmd = (p / "cmdline").read_bytes().replace(b"\0", b" ").decode(errors="replace")
	except OSError:
		continue
	if re.search(r"bench_helper frappe worker|rq:worker|\bbench worker\b", cmd):
		procs["worker"].append(p.name)
	elif re.search(r"bench_helper frappe schedule|\bbench schedule\b", cmd):
		procs["scheduler"].append(p.name)
for kind, pids in procs.items():
	report("PASS" if not pids else "WARN", f"{kind} processes", f"{len(pids)} running")

if mode == "safety":
	print(f"\n{fails} FAIL, {warns} WARN")
	sys.exit(1 if fails else 0)

# ---- HTTP checks -------------------------------------------------------------------------------
local_opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
public_opener = urllib.request.build_opener()  # honours HTTPS_PROXY (the session's egress proxy)
MOBILE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1"


def get(opener, url, headers=None, tries=1):
	last = None
	for _ in range(tries):
		req = urllib.request.Request(url, headers=headers or {})
		try:
			with opener.open(req, timeout=45) as r:
				return r.status, r.headers.get("Content-Type", ""), r.read()
		except urllib.error.HTTPError as e:
			return e.code, e.headers.get("Content-Type", ""), e.read()
		except Exception as e:  # network error: retry
			last = e
	return 0, "", str(last).encode()


def site_files(site):
	root = bench / "sites" / site / "public" / "files"
	out = {}
	if root.is_dir():
		for f in sorted(root.rglob("*")):
			if f.is_file():
				out[f.relative_to(root).as_posix()] = hashlib.sha256(f.read_bytes()).hexdigest()
	return out


files = {s["site"]: site_files(s["site"]) for s in sites}


def unique_file(site):
	"""A public file of `site` that no other preview site has with the same content."""
	for rel, digest in files[site].items():
		if all(files[o].get(rel) != digest for o in files if o != site):
			return rel, digest
	return None


def check_target(label, base, opener, site, headers, tries):
	h = dict(headers)
	status, ctype, body = get(opener, base + "/login", h, tries)
	html = body.decode(errors="replace")
	is_frappe = "/assets/frappe/" in html
	report("PASS" if status == 200 and is_frappe else "FAIL", f"{label} /login", f"{status} {'frappe page' if is_frappe else ctype}")
	css = re.search(r'href="(/assets/[^"]+\.css)[^"]*"', html)
	js = re.search(r'src="(/assets/[^"]+\.js)[^"]*"', html)
	for kind, m, want in (("CSS", css, "text/css"), ("JS", js, "javascript")):
		if not m:
			report("FAIL", f"{label} {kind}", "no bundle referenced by /login")
			continue
		st, ct, _ = get(opener, base + m.group(1), h, tries)
		report("PASS" if st == 200 and want in ct else "FAIL", f"{label} {kind}", f"{st} {ct.split(';')[0]} {m.group(1)}")
	st, _, body = get(opener, base + "/api/method/ping", h, tries)
	try:
		pong = json.loads(body).get("message") == "pong"
	except ValueError:
		pong = False
	report("PASS" if st == 200 and pong else "FAIL", f"{label} /api/method/ping", f"{st} {'pong' if pong else body[:60]!r}")
	own = unique_file(site)
	if not own:
		report("WARN", f"{label} site identity", f"{site} has no unique public file to compare")
	else:
		rel, digest = own
		st, _, body = get(opener, base + "/files/" + urllib.parse.quote(rel), h, tries)
		same = st == 200 and hashlib.sha256(body).hexdigest() == digest
		report("PASS" if same else "FAIL", f"{label} public file / site = {site}", f"{st} /files/{rel}")
	for other in files:
		if other == site or not unique_file(other):
			continue
		rel, digest = unique_file(other)
		st, _, body = get(opener, base + "/files/" + urllib.parse.quote(rel), h, tries)
		leaked = st == 200 and hashlib.sha256(body).hexdigest() == digest
		report("FAIL" if leaked else "PASS", f"{label} not serving {other}", f"{st} /files/{rel}")


for s in sites:
	print(f"\n{s['site']}")
	# Arbitrary Host: the site must come from the proxy, not from the hostname.
	check_target("local 127.0.0.1:" + s["proxy"], "http://127.0.0.1:" + s["proxy"], local_opener, s["site"],
		{"Host": "mobile-preview.invalid"}, 1)
	if mode == "all":
		u = urls.get(s["key"])
		if not u:
			level = "FAIL" if os.environ["TUNNEL_EXPECTED"] == "1" else "INFO"
			report(level, "public URL", "tunnel not hosting (run start.sh)")
			continue
		check_target("public", u, public_opener, s["site"], {}, 3)
		st, _, body = get(public_opener, u + "/login", {"User-Agent": MOBILE_UA}, 3)
		html = body.decode(errors="replace")
		if st == 200 and "/assets/frappe/" in html:
			report("PASS", "public /login (phone browser)", f"{st} frappe page")
		elif st == 200:
			report("INFO", "public /login (phone browser)", "Dev Tunnels confirmation page first: tap Continue once")
		else:
			report("FAIL", "public /login (phone browser)", str(st))

print(f"\n{fails} FAIL, {warns} WARN")
sys.exit(1 if fails else 0)
PY

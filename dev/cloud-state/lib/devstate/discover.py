"""Discovery of sites, apps, repositories, tool versions. Nothing here is hard-coded to a site or app."""

from __future__ import annotations

import json
import re
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

from .common import Config, DevStateError, run, tool_version

PROBE = Path(__file__).with_name("probe_site.py")
#: Entries in sites/ that are bench infrastructure, not sites.
NON_SITE_ENTRIES = {"assets", "apps.txt", "apps.json", "common_site_config.json", "currentsite.txt", ".build"}
DB_DEFAULT_PORTS = {"mariadb": 3306, "postgres": 5432}


# ------------------------------------------------------------------------------------------------
# Sites
# ------------------------------------------------------------------------------------------------
def discover_sites(cfg: Config) -> list[str]:
	"""Every directory under sites/ that has a site_config.json. New sites need no script change."""
	if not cfg.sites_dir.is_dir():
		return []
	return sorted(
		p.name
		for p in cfg.sites_dir.iterdir()
		if p.is_dir() and p.name not in NON_SITE_ENTRIES and (p / "site_config.json").is_file()
	)


def read_site_config(cfg: Config, site: str) -> dict:
	return json.loads((cfg.sites_dir / site / "site_config.json").read_text())


def read_common_config(cfg: Config) -> dict:
	path = cfg.sites_dir / "common_site_config.json"
	return json.loads(path.read_text()) if path.exists() else {}


def site_db_info(site_config: dict, common: dict | None = None) -> dict:
	"""Engine and address of a site's database; site config wins over common config."""
	common = common or {}
	db_type = site_config.get("db_type") or common.get("db_type") or "mariadb"
	host = site_config.get("db_host") or common.get("db_host") or "127.0.0.1"
	port = int(site_config.get("db_port") or common.get("db_port") or DB_DEFAULT_PORTS.get(db_type, 0))
	return {
		"db_type": db_type,
		"db_host": host,
		"db_port": port,
		"db_name": site_config.get("db_name"),
		"db_user": site_config.get("db_user") or site_config.get("db_name"),
	}


def probe_site(cfg: Config, site: str, counts=False) -> dict:
	args = [str(cfg.bench_python), str(PROBE), str(cfg.sites_dir), site]
	if counts:
		args.append("--counts")
	result = run(args, user=cfg.FRAPPE_USER, check=False, cwd=str(cfg.sites_dir))
	lines = [ln for ln in (result.stdout or "").splitlines() if ln.startswith("{")]
	if not lines:
		return {"site": site, "ok": False, "error": (result.stderr or "no output").strip()[-400:]}
	return json.loads(lines[-1])


def site_files_summary(cfg: Config, site: str) -> dict:
	out = {}
	for kind in ("public", "private"):
		root = cfg.sites_dir / site / kind / "files"
		files = [p for p in root.rglob("*") if p.is_file()] if root.is_dir() else []
		out[kind] = {
			"exists": root.is_dir(),
			"count": len(files),
			"bytes": sum(p.stat().st_size for p in files),
		}
	return out


# ------------------------------------------------------------------------------------------------
# Apps and repositories
# ------------------------------------------------------------------------------------------------
def bench_apps(cfg: Config) -> dict:
	"""Apps present in apps/ and registered in sites/apps.txt."""
	apps_dir = cfg.bench / "apps"
	present = sorted(p.name for p in apps_dir.iterdir() if p.is_dir()) if apps_dir.is_dir() else []
	txt = cfg.sites_dir / "apps.txt"
	registered = [ln.strip() for ln in txt.read_text().splitlines() if ln.strip()] if txt.exists() else []
	return {"present": present, "registered": registered}


def _strip_credentials(url: str) -> str:
	try:
		parts = urlsplit(url)
	except ValueError:
		return url
	if parts.username or parts.password:
		host = parts.hostname or ""
		if parts.port:
			host = f"{host}:{parts.port}"
		return urlunsplit((parts.scheme, host, parts.path, parts.query, parts.fragment))
	return url


def git(cfg: Config, path: Path, *args, check=False):
	# Run as the frappe user: its git config has safe.directory for the root-owned working copies.
	return run(["git", "-C", str(path), *args], user=cfg.FRAPPE_USER, check=check)


def repo_state(cfg: Config, app: str) -> dict:
	app_path = cfg.bench / "apps" / app
	real = app_path.resolve()
	state = {
		"app": app,
		"bench_path": str(app_path),
		"repo_path": str(real),
		"soft_link": app_path.is_symlink(),
	}
	if not (real / ".git").exists():
		state["git"] = False
		return state
	state["git"] = True
	remotes = [r for r in (git(cfg, real, "remote").stdout or "").split() if r]
	remote = (
		"upstream"
		if "upstream" in remotes
		else ("origin" if "origin" in remotes else (remotes[0] if remotes else None))
	)
	state["remote"] = remote
	state["url"] = (
		_strip_credentials((git(cfg, real, "remote", "get-url", remote).stdout or "").strip())
		if remote
		else None
	)
	state["branch"] = (git(cfg, real, "branch", "--show-current").stdout or "").strip() or None
	state["commit"] = (git(cfg, real, "rev-parse", "HEAD").stdout or "").strip() or None
	state["describe"] = (git(cfg, real, "log", "-1", "--format=%h %s").stdout or "").strip()
	porcelain = (git(cfg, real, "status", "--porcelain", "--untracked-files=all").stdout or "").splitlines()
	modified = [ln[3:] for ln in porcelain if not ln.startswith("??")]
	untracked = [ln[3:] for ln in porcelain if ln.startswith("??")]
	state["dirty"] = bool(porcelain)
	state["modified_files"] = modified
	state["untracked_files"] = untracked
	upstream = git(cfg, real, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}")
	if upstream.returncode == 0:
		ahead = git(cfg, real, "rev-list", "--count", "@{u}..HEAD")
		state["tracking"] = upstream.stdout.strip()
		state["unpushed_commits"] = int((ahead.stdout or "0").strip() or 0)
	else:
		state["tracking"] = None
		state["unpushed_commits"] = None
	return state


# ------------------------------------------------------------------------------------------------
# Tools and services
# ------------------------------------------------------------------------------------------------
def _first_version(text: str | None) -> str | None:
	if not text:
		return None
	match = re.search(r"\d+(?:\.\d+)+", text)
	return match.group(0) if match else text


def tool_versions(cfg: Config) -> dict:
	node = str(Path(cfg.NODE_DIR) / "bin" / "node")
	return {
		"bench_python": _first_version(tool_version([str(cfg.bench_python), "--version"])),
		"system_python": _first_version(tool_version(["python3", "--version"])),
		"node": _first_version(tool_version([node, "--version"])),
		"yarn": _first_version(tool_version([str(Path(cfg.NODE_DIR) / "bin" / "yarn"), "--version"])),
		"bench": _first_version(
			(run(["bash", "-lc", "bench --version"], user=cfg.FRAPPE_USER, check=False).stdout or "").strip()
		),
		"pg_dump": _first_version(tool_version(["pg_dump", "--version"])),
		"pg_restore": _first_version(tool_version(["pg_restore", "--version"])),
		"mariadb_client": _first_version(tool_version(["mariadb", "--version"])),
		"mariadb_dump": _first_version(tool_version(["mariadb-dump", "--version"])),
		"redis_server": _first_version(tool_version(["redis-server", "--version"])),
		"age": _first_version(tool_version(["age", "--version"])),
		"docker": _first_version(tool_version(["docker", "--version"])),
	}


def redis_endpoints(cfg: Config) -> dict:
	common = read_common_config(cfg)
	return {k: common.get(k) for k in ("redis_cache", "redis_queue", "redis_socketio")}


def running_processes() -> dict:
	"""Frappe background processes and dev services currently running on this VM."""
	out = run(["ps", "-eo", "pid,args"], check=False).stdout or ""
	rows = out.splitlines()[1:]

	def match(pattern):
		return [r.strip() for r in rows if re.search(pattern, r) and "ps -eo" not in r]

	return {
		"workers": match(r"frappe\.utils\.bench_helper frappe worker|bench worker|rq:worker|frappe worker"),
		"schedulers": match(r"frappe\.utils\.bench_helper frappe schedule|bench schedule"),
		"web": match(r"gunicorn .*frappe\.app|bench serve|frappe\.utils\.bench_helper frappe serve"),
		"wa_admin_mock": match(r"wa_admin_mock\.py"),
		"redis": match(r"redis-server"),
	}


def assert_bench(cfg: Config):
	if not (cfg.bench / "apps" / "frappe").exists():
		raise DevStateError(f"no Frappe bench at {cfg.bench} (run bootstrap-cloud.sh)")

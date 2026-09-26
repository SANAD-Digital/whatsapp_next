"""restore-dev-state: defensive restore of a snapshot.

Order: resolve -> unpack/decrypt -> verify checksums -> preflight (tools, apps, engines,
connectivity) -> plan -> confirmation -> per site: pre-restore backup (replace only) ->
recreate database -> native restore -> config (reconciled) -> files -> post-checks.
Nothing destructive happens before every preflight check has passed.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import secrets
import shutil
import sys
import tarfile
from pathlib import Path

from . import crypto, discover, snapshot
from .backends import get_backend
from .common import (
	Config,
	DevStateError,
	bench_cmd,
	exclusive_lock,
	frappe_ids,
	log,
	require_root,
	secure_dir,
	secure_file,
	set_log_file,
	utc_id,
	which,
)
from .engines import engine_for, infra_address

#: Site-config keys owned by the CURRENT session's infrastructure, never taken from the snapshot.
INFRA_KEYS = ("db_host", "db_port", "db_socket")
#: Keys describing the site's own database identity (kept for same-name restores, regenerated for --as).
IDENTITY_KEYS = ("db_name", "db_user", "db_password")
HOSTS_MARKER = "# frappe dev site (dev-state)"


# ------------------------------------------------------------------------------------------------
# Resolving and opening a snapshot
# ------------------------------------------------------------------------------------------------
def open_snapshot(cfg: Config, target: str, backend_name: str | None) -> Path:
	"""Return a directory containing the snapshot (manifest.json at its root)."""
	path = Path(target)
	if path.is_dir() and (path / "manifest.json").exists():
		return path
	if path.is_file():
		return _in_work_dir(cfg, lambda work: _unpack_package(cfg, path, work))
	backend = get_backend(cfg, backend_name)
	sid = target
	if target == "latest":
		pointer = backend.latest()
		if not pointer:
			raise DevStateError(f"no latest snapshot in the {backend.name} backend")
		sid = pointer["snapshot_id"]
		log(f"latest snapshot in {backend.name}: {sid}")
	local_dir = cfg.state_dir / "snapshots" / sid
	if local_dir.is_dir() and (local_dir / "manifest.json").exists():
		log(f"using local snapshot directory {local_dir}")
		return local_dir
	if not re.fullmatch(r"[0-9A-Za-z._-]+", sid):
		raise DevStateError(f"invalid snapshot id {sid!r}")
	return _in_work_dir(cfg, lambda work: _unpack_package(cfg, backend.fetch(sid, work), work))


def _in_work_dir(cfg: Config, fn) -> Path:
	"""Run fn in a fresh private work dir, created only when a package must be fetched/decrypted.
	On failure the dir (which may hold decrypted material) is removed before the error propagates;
	on success the caller removes it after the restore."""
	work = secure_dir(cfg.state_dir / "restore-work" / f"{utc_id()}-{secrets.token_hex(3)}", cfg)
	try:
		return fn(work)
	except BaseException:
		shutil.rmtree(work, ignore_errors=True)
		raise


def _unpack_package(cfg: Config, package: Path, work: Path) -> Path:
	if package.name.endswith(".age"):
		plain = work / package.name[: -len(".age")]
		crypto.decrypt(cfg, package, plain)
		package = plain
	root = snapshot.unpack(package, work)
	snapshot.tighten(root, cfg)
	return root


# ------------------------------------------------------------------------------------------------
# Preflight
# ------------------------------------------------------------------------------------------------
def _major(version: str | None) -> int:
	m = re.match(r"(\d+)", version or "")
	return int(m.group(1)) if m else 0


def preflight(cfg: Config, manifest: dict, sites: list[dict]) -> tuple[list[str], list[str], set[str]]:
	"""Return (blockers, warnings, changed_apps). Any blocker stops the restore before anything is
	touched; changed_apps are installed apps whose current commit differs from the snapshot's."""
	blockers, warnings, changed = [], [], set()
	engines = sorted({s["db"]["db_type"] for s in sites})

	# tools
	needs = {"postgres": ["pg_restore", "psql"], "mariadb": ["mariadb", "gunzip"]}
	for eng in engines:
		for tool in needs.get(eng, []):
			if not which(tool):
				blockers.append(f"required tool '{tool}' for {eng} restores is not installed")
	if "postgres" in engines and which("pg_restore"):
		have = _major(discover.tool_versions(cfg).get("pg_restore"))
		dumped = _major(manifest["tools"].get("pg_dump"))
		if have < dumped:
			blockers.append(f"pg_restore {have} is older than the pg_dump {dumped} that made the snapshot")

	# apps: every app installed on a selected site must be present and registered in this bench
	apps_now = discover.bench_apps(cfg)
	repos = {r["app"]: r for r in manifest["repositories"]}
	required = sorted({a for s in sites for a in s["installed_apps"]})
	for app in required:
		if app not in apps_now["present"] or app not in apps_now["registered"]:
			r = repos.get(app, {})
			where = (
				"missing from apps/" if app not in apps_now["present"] else "not registered in sites/apps.txt"
			)
			blockers.append(
				f"app '{app}' is {where}. Expected repository: {r.get('url') or 'unknown'} "
				f"branch {r.get('branch') or 'unknown'} commit {(r.get('commit') or 'unknown')[:12]}"
			)
	# code versions: a different commit is allowed but reported
	for app in required:
		if app not in apps_now["present"] or app not in repos:
			continue
		now = discover.repo_state(cfg, app)
		want = repos[app]
		if now.get("commit") and want.get("commit") and now["commit"] != want["commit"]:
			changed.add(app)
			warnings.append(
				f"app '{app}' is at {now['commit'][:12]} ({now.get('branch')}) but the snapshot was taken at "
				f"{want['commit'][:12]} ({want.get('branch')}); sites using it will be migrated after restore"
			)
		if now.get("dirty"):
			warnings.append(f"app '{app}' currently has uncommitted changes")

	# engines reachable with this session's root credentials
	for eng in engines:
		try:
			version = engine_for(cfg, eng).root_check()
			log(f"{eng} reachable (server {version.splitlines()[0] if version else '?'})", level="ok")
		except DevStateError as exc:
			blockers.append(
				f"{eng} not reachable with this session's root credentials: {str(exc).splitlines()[0]}"
			)
	return blockers, warnings, changed


# ------------------------------------------------------------------------------------------------
# Plan
# ------------------------------------------------------------------------------------------------
def _renamed_identity(target: str, sid: str) -> dict:
	name = "_" + hashlib.sha256(f"{target}:{sid}".encode()).hexdigest()[:16]
	return {"db_name": name, "db_user": name, "db_password": secrets.token_urlsafe(16)}


def plan_sites(cfg: Config, root: Path, manifest: dict, only: list[str], mapping: dict) -> list[dict]:
	selected = [s for s in manifest["sites"] if not only or s["name"] in only]
	unknown = set(only) - {s["name"] for s in manifest["sites"]}
	if unknown:
		raise DevStateError(f"site(s) not in snapshot: {', '.join(sorted(unknown))}")
	plans = []
	for s in selected:
		target = mapping.get(s["name"], s["name"])
		snap_conf = json.loads((root / "sites" / s["name"] / "site_config.json").read_text())
		db_type = s["db"]["db_type"]
		host, port = infra_address(cfg, db_type)
		identity = (
			{k: snap_conf.get(k) for k in IDENTITY_KEYS}
			if target == s["name"]
			else _renamed_identity(target, manifest["snapshot_id"])
		)
		identity["db_user"] = identity.get("db_user") or identity["db_name"]
		site_dir = cfg.sites_dir / target
		exists = (site_dir / "site_config.json").exists()
		engine = engine_for(cfg, db_type)
		try:
			db_exists = engine.database_exists(identity["db_name"])
		except DevStateError:
			db_exists = None  # engine unreachable: preflight reports it as a blocker
		current_db = discover.site_db_info(discover.read_site_config(cfg, target)) if exists else None
		plans.append(
			{
				"source": s["name"],
				"target": target,
				"snapshot_site": s,
				"db_type": db_type,
				"db": {
					"db_type": db_type,
					"db_host": host,
					"db_port": port,
					"db_name": identity["db_name"],
					"db_user": identity["db_user"],
				},
				"password": identity["db_password"],
				"snapshot_config": snap_conf,
				"action": "replace" if exists else "create",
				"db_exists": db_exists,
				"current_db": current_db,
				"destructive": exists or bool(db_exists),
			}
		)
	return plans


def print_plan(plans, manifest):
	log(f"RESTORE PLAN for snapshot {manifest['snapshot_id']} (saved {manifest['created_at']})", level="step")
	for p in plans:
		s = p["snapshot_site"]
		rename = f" (from {p['source']})" if p["target"] != p["source"] else ""
		log(f"  site {p['target']}{rename}: {p['action'].upper()}")
		log(
			f"    database : {p['db_type']} {p['db']['db_host']}:{p['db']['db_port']} name {p['db']['db_name']}"
			+ ("  [EXISTS - will be DROPPED and recreated]" if p["db_exists"] else "  [new]")
		)
		if p["current_db"] and p["current_db"]["db_name"] != p["db"]["db_name"]:
			log(f"    current db {p['current_db']['db_name']} is left in place (not dropped)")
		log(f"    apps     : {', '.join(s['installed_apps'])}")
		log(
			f"    files    : public {s['files']['public']['count']} / private {s['files']['private']['count']}"
			+ ("  [existing files dir REPLACED]" if p["action"] == "replace" else "")
		)
		log(f"    rows     : {s.get('total_rows')} in {s['table_count']} tables")
		log(f"    migrate  : {'yes, app code differs from the snapshot' if p.get('needs_migrate') else 'no'}")


def _confirm(plans, args) -> bool:
	destructive = [p for p in plans if p["destructive"]]
	if destructive and not args.force:
		log(
			"refusing: these targets already exist and would be overwritten: "
			+ ", ".join(p["target"] for p in destructive)
			+ ". Re-run with --force to replace them.",
			level="error",
		)
		return False
	if args.yes:
		return True
	if not sys.stdin.isatty():
		log("no terminal to confirm on; re-run with --yes to proceed non-interactively", level="error")
		return False
	answer = input("Type RESTORE to proceed: ").strip()
	return answer == "RESTORE"


# ------------------------------------------------------------------------------------------------
# Execution
# ------------------------------------------------------------------------------------------------
def _reconciled_config(plan: dict) -> dict:
	conf = dict(plan["snapshot_config"])
	for key in INFRA_KEYS:
		conf.pop(key, None)
	conf.update(
		{"db_type": plan["db_type"], "db_host": plan["db"]["db_host"], "db_port": plan["db"]["db_port"]}
	)
	conf.update(
		{"db_name": plan["db"]["db_name"], "db_user": plan["db"]["db_user"], "db_password": plan["password"]}
	)
	if plan["db"]["db_user"] == plan["db"]["db_name"] and "db_user" not in plan["snapshot_config"]:
		conf.pop("db_user", None)
	return conf


def _pre_restore_backup(cfg: Config, plan: dict):
	target = plan["target"]
	dst = secure_dir(cfg.state_dir / "pre-restore" / f"{utc_id()}-{target}", cfg)
	conf = discover.read_site_config(cfg, target)
	db = discover.site_db_info(conf, discover.read_common_config(cfg))
	engine = engine_for(cfg, db["db_type"])
	if engine.database_exists(db["db_name"]):
		engine.dump(db, conf.get("db_password", ""), dst / f"{target}.{engine.dump_suffix}")
	shutil.copyfile(cfg.sites_dir / target / "site_config.json", dst / "site_config.json")
	for kind in ("public", "private"):
		src = cfg.sites_dir / target / kind / "files"
		if src.is_dir():
			with tarfile.open(dst / f"{kind}-files.tar.gz", "w:gz") as tar:
				tar.add(src, arcname=f"{kind}/files")
	snapshot.tighten(dst, cfg)
	log(f"  pre-restore backup of the current {target}: {dst}", level="ok")


def _ensure_hosts_entry(site: str):
	hosts = Path("/etc/hosts")
	text = hosts.read_text()
	if re.search(rf"^\S+\s+(.*\s)?{re.escape(site)}(\s|$)", text, re.M):
		return
	with open(hosts, "a") as fh:
		fh.write(f"127.0.0.1\t{site}\t{HOSTS_MARKER}\n")


def restore_site(cfg: Config, root: Path, plan: dict, args) -> dict:
	target, s = plan["target"], plan["snapshot_site"]
	log(f"restoring {target}", level="step")
	if plan["action"] == "replace" and not args.no_pre_backup:
		_pre_restore_backup(cfg, plan)
	engine = engine_for(cfg, plan["db_type"])
	engine.recreate(plan["db"], plan["password"])
	engine.restore(plan["db"], plan["password"], root / s["dump"])
	log(f"  {plan['db_type']} database {plan['db']['db_name']} restored with native tools", level="ok")

	site_dir = cfg.sites_dir / target
	for sub in ("public/files", "private/files", "private/backups", "logs", "locks"):
		(site_dir / sub).mkdir(parents=True, exist_ok=True)
	conf_path = site_dir / "site_config.json"
	conf_path.write_text(json.dumps(_reconciled_config(plan), indent=1, sort_keys=True) + "\n")
	for kind in ("public", "private"):
		archive = s.get("file_archives", {}).get(kind)
		files_dir = site_dir / kind / "files"
		if plan["action"] == "replace":
			shutil.rmtree(files_dir, ignore_errors=True)
			files_dir.mkdir(parents=True)
		if archive:
			with tarfile.open(root / "sites" / s["name"] / archive, "r:gz") as tar:
				tar.extractall(site_dir, filter="data")
	uid, gid = frappe_ids(cfg)
	for dirpath, _dirs, files in os.walk(site_dir):
		os.chown(dirpath, uid, gid)
		for name in files:
			os.chown(os.path.join(dirpath, name), uid, gid)
	secure_file(conf_path, cfg)
	_ensure_hosts_entry(target)

	bench_cmd(cfg, "--site", target, "clear-cache")
	# Migrate only when necessary: code differs from the snapshot for an app this site uses.
	migrate = args.migrate or (plan.get("needs_migrate") and not args.no_migrate)
	if migrate:
		log(f"  migrating ({'forced' if args.migrate else 'code differs from the snapshot'})")
		bench_cmd(cfg, "--site", target, "migrate")
	if s["settings"].get("scheduler_enabled") and not args.keep_scheduler:
		bench_cmd(cfg, "--site", target, "disable-scheduler")
		log(
			"  scheduler was enabled in the snapshot; DISABLED for development (use --keep-scheduler to keep it)",
			level="warn",
		)
	return verify_restored(cfg, root, plan, compare_counts=not migrate)


def verify_restored(cfg: Config, root: Path, plan: dict, compare_counts=True) -> dict:
	s = plan["snapshot_site"]
	probe = discover.probe_site(cfg, plan["target"], counts=compare_counts)
	problems = []
	if not probe.get("ok"):
		problems.append(f"site does not open: {probe.get('error')}")
	else:
		if probe["installed_apps"] != s["installed_apps"]:
			problems.append(f"installed apps {probe['installed_apps']} != snapshot {s['installed_apps']}")
		if probe["db_type"] != plan["db_type"]:
			problems.append(f"db_type {probe['db_type']} != {plan['db_type']}")
		if compare_counts:
			expected = json.loads((root / "sites" / s["name"] / "row_counts.json").read_text())
			got = probe.get("row_counts", {})
			if probe["table_count"] != s["table_count"]:
				problems.append(f"table count {probe['table_count']} != snapshot {s['table_count']}")
			diff = sorted(t for t in set(expected) | set(got) if expected.get(t) != got.get(t))
			if diff:
				problems.append(f"{len(diff)} table(s) differ in row count, e.g. {diff[:5]}")
	files_now = discover.site_files_summary(cfg, plan["target"])
	for kind in ("public", "private"):
		if files_now[kind]["count"] != s["files"][kind]["count"]:
			problems.append(
				f"{kind} files {files_now[kind]['count']} != snapshot {s['files'][kind]['count']}"
			)
	status = "OK" if not problems else "MISMATCH"
	log(
		f"  verify {plan['target']}: {status}" + ("" if not problems else " - " + "; ".join(problems)),
		level="ok" if not problems else "error",
	)
	return {
		"site": plan["target"],
		"ok": not problems,
		"problems": problems,
		"tables": probe.get("table_count"),
		"rows": probe.get("total_rows"),
	}


def restore(cfg: Config, args) -> int:
	require_root()
	discover.assert_bench(cfg)
	secure_dir(cfg.state_dir, cfg)
	mapping = {}
	for item in args.as_ or []:
		if "=" not in item:
			raise DevStateError(f"--as expects OLD=NEW, got {item!r}")
		old, new = item.split("=", 1)
		mapping[old.strip()] = new.strip()
	for sub in ("locks", "logs", "staging"):
		secure_dir(cfg.state_dir / sub, cfg)
	with exclusive_lock(cfg.state_dir / "locks" / "state.lock", "save/restore"):
		set_log_file(cfg.state_dir / "logs" / f"restore-{utc_id()}.log", cfg)
		root = open_snapshot(cfg, args.snapshot, args.backend)
		work = cfg.state_dir / "restore-work"
		try:
			return _restore_from(cfg, args, root, mapping)
		finally:
			# A downloaded/decrypted copy holds dumps and secrets: never leave it behind.
			if work in root.parents:
				shutil.rmtree(root.parent, ignore_errors=True)


def _restore_from(cfg: Config, args, root: Path, mapping: dict) -> int:
	problems = snapshot.verify_checksums(root)
	if problems:
		for p in problems[:20]:
			log(p, level="error")
		raise DevStateError(
			f"snapshot {root.name} failed checksum verification ({len(problems)} problem(s)); nothing was changed"
		)
	log(f"checksums verified for {root.name}", level="ok")
	manifest = snapshot.load_manifest(root)
	plans = plan_sites(cfg, root, manifest, args.site or [], mapping)
	blockers, warnings, changed = preflight(cfg, manifest, [p["snapshot_site"] for p in plans])
	for p in plans:
		p["needs_migrate"] = bool(changed & set(p["snapshot_site"]["installed_apps"]))
	print_plan(plans, manifest)
	for w in warnings:
		log(w, level="warn")
	if blockers:
		for b in blockers:
			log(b, level="error")
		raise DevStateError(f"{len(blockers)} preflight blocker(s); nothing was changed")
	log("preflight passed", level="ok")
	if args.dry_run:
		log("--dry-run: stopping before any change")
		return 0
	if not _confirm(plans, args):
		return 2
	results = [restore_site(cfg, root, p, args) for p in plans]
	bad = [r for r in results if not r["ok"]]
	log(
		f"restored {len(results) - len(bad)}/{len(results)} site(s) from {manifest['snapshot_id']}",
		level="ok" if not bad else "error",
	)
	return 0 if not bad else 1

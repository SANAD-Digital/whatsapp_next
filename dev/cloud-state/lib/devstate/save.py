"""save-dev-state: capture every site's database, files and config plus the code/tool state."""

from __future__ import annotations

import json
import os
import shutil
import tarfile
from pathlib import Path

from . import crypto, discover, snapshot, summary
from .backends import get_backend
from .common import (
	MANIFEST_FORMAT,
	TOOL_DIR,
	Config,
	DevStateError,
	exclusive_lock,
	log,
	redact_mapping,
	require_root,
	secure_dir,
	secure_file,
	set_log_file,
	utc_id,
	utc_now,
	write_json,
)
from .engines import engine_for


def _tar_dir(src_parent: Path, rel: str, out: Path, cfg: Config) -> bool:
	if not (src_parent / rel).is_dir():
		return False
	with tarfile.open(out, "w:gz") as tar:
		tar.add(src_parent / rel, arcname=rel)
	secure_file(out, cfg)
	return True


def save(cfg: Config, args) -> int:
	require_root()
	discover.assert_bench(cfg)
	sid = args.id or utc_id()
	secure_dir(cfg.state_dir, cfg)
	for sub in ("locks", "logs", "staging"):
		secure_dir(cfg.state_dir / sub, cfg)
	with exclusive_lock(cfg.state_dir / "locks" / "state.lock", "save/restore"):
		set_log_file(cfg.state_dir / "logs" / f"save-{sid}.log", cfg)
		final_dir = cfg.state_dir / "snapshots" / sid
		if final_dir.exists():
			raise DevStateError(f"snapshot {sid} already exists")
		staging = secure_dir(cfg.state_dir / "staging" / sid, cfg)
		try:
			manifest = _capture(cfg, args, sid, staging)
			snapshot.write_checksums(staging, cfg)
			snapshot.tighten(staging, cfg)
			problems = snapshot.verify_checksums(staging)
			if problems:
				raise DevStateError(
					"fresh snapshot failed its own checksum verification: " + "; ".join(problems[:5])
				)
			secure_dir(final_dir.parent, cfg)
			os.replace(staging, final_dir)
		except BaseException:
			shutil.rmtree(staging, ignore_errors=True)
			raise
		log(f"snapshot {sid} complete: {final_dir}", level="ok")
		summary_out = Path(args.summary_out) if args.summary_out else TOOL_DIR / "dev-state-summary.md"
		published = _package_and_publish(cfg, args, final_dir, manifest)
		summary.write(summary_out, manifest, published)
		log(f"handoff summary (no secrets): {summary_out}", level="ok")
		for w in manifest["warnings"]:
			log(w, level="warn")
		# 3 = saved locally but NOT uploaded, so automation cannot mistake it for a remote save.
		return 3 if published.get("blocked") else 0


def _capture(cfg: Config, args, sid: str, staging: Path) -> dict:
	log("discovering sites, apps and repositories", level="step")
	sites = discover.discover_sites(cfg)
	if not sites:
		raise DevStateError(f"no sites found in {cfg.sites_dir}")
	common = discover.read_common_config(cfg)
	apps = discover.bench_apps(cfg)
	warnings = []

	repos = [discover.repo_state(cfg, app) for app in apps["present"]]
	for r in repos:
		if r.get("dirty"):
			files = r["modified_files"] + [f"{f} (untracked)" for f in r["untracked_files"]]
			shown = ", ".join(files[:8]) + (f" (+{len(files) - 8} more)" if len(files) > 8 else "")
			warnings.append(
				f"repository {r['app']} has UNCOMMITTED changes that are NOT in this snapshot's code record: {shown}"
			)
		if r.get("unpushed_commits"):
			warnings.append(
				f"repository {r['app']} has {r['unpushed_commits']} commit(s) not pushed to {r['tracking']}"
			)
		if r.get("git") is False:
			warnings.append(f"app {r['app']} is not a Git checkout; its code cannot be reproduced from Git")
	for w in warnings:
		log(w, level="warn")
	write_json(secure_dir(staging / "git", cfg) / "repositories.json", repos, cfg=cfg)
	if args.include_dirty_patches:
		_dirty_patches(cfg, repos, staging)

	log("recording tool versions", level="step")
	versions = discover.tool_versions(cfg)
	bench_dir = secure_dir(staging / "bench", cfg)
	write_json(bench_dir / "versions.json", versions, cfg=cfg)
	for name in ("common_site_config.json", "apps.txt", "apps.json"):
		src = cfg.sites_dir / name
		if src.exists():
			shutil.copyfile(src, bench_dir / name)
			secure_file(bench_dir / name, cfg)

	site_entries = []
	db_dir = secure_dir(staging / "databases", cfg)
	for site in sites:
		log(f"site {site}", level="step")
		conf = discover.read_site_config(cfg, site)
		db = discover.site_db_info(conf, common)
		engine = engine_for(cfg, db["db_type"])
		probe = discover.probe_site(cfg, site, counts=True)
		if not probe.get("ok"):
			raise DevStateError(f"site {site}: database not reachable or site broken: {probe.get('error')}")
		engine.site_check(db, conf.get("db_password", ""))
		dump_name = f"{site}.{engine.dump_suffix}"
		log(f"  dumping {db['db_type']} database {db['db_name']} with native tools")
		engine.dump(db, conf.get("db_password", ""), db_dir / dump_name)
		site_dir = secure_dir(staging / "sites" / site, cfg)
		shutil.copyfile(cfg.sites_dir / site / "site_config.json", site_dir / "site_config.json")
		secure_file(site_dir / "site_config.json", cfg)
		archives = {}
		for kind in ("public", "private"):
			name = f"{kind}-files.tar.gz"
			archives[kind] = (
				name if _tar_dir(cfg.sites_dir / site, f"{kind}/files", site_dir / name, cfg) else None
			)
		write_json(site_dir / "row_counts.json", probe.get("row_counts", {}), cfg=cfg)
		settings = probe["settings"]
		if settings.get("scheduler_enabled"):
			warnings.append(f"site {site} has its scheduler ENABLED in the snapshot")
		site_entries.append(
			{
				"name": site,
				"db": {k: db[k] for k in ("db_type", "db_host", "db_port", "db_name", "db_user")},
				"db_server_version": probe.get("db_server_version"),
				"dump": f"databases/{dump_name}",
				"installed_apps": probe["installed_apps"],
				"app_versions": probe["app_versions"],
				"settings": settings,
				"config_keys": sorted(conf),
				"config_public": {k: v for k, v in redact_mapping(conf).items() if k not in ("db_password",)},
				"files": discover.site_files_summary(cfg, site),
				"file_archives": archives,
				"table_count": probe["table_count"],
				"total_rows": probe.get("total_rows"),
			}
		)
		log(
			f"  {probe['table_count']} tables, {probe.get('total_rows')} rows, apps: {', '.join(probe['installed_apps'])}",
			level="ok",
		)

	processes = discover.running_processes()
	manifest = {
		"format": MANIFEST_FORMAT,
		"snapshot_id": sid,
		"label": args.label,
		"created_at": utc_now(),
		"created_on_host": os.uname().nodename,
		"bench": {
			"path": str(cfg.bench),
			"apps_present": apps["present"],
			"apps_registered": apps["registered"],
			"common_config_public": redact_mapping(common),
		},
		"tools": versions,
		"sites": site_entries,
		"repositories": [
			{
				k: r.get(k)
				for k in (
					"app",
					"url",
					"remote",
					"branch",
					"commit",
					"describe",
					"dirty",
					"soft_link",
					"repo_path",
					"modified_files",
					"untracked_files",
					"unpushed_commits",
				)
			}
			for r in repos
		],
		"dirty_patches_included": bool(args.include_dirty_patches),
		"processes_at_save": {k: len(v) for k, v in processes.items()},
		"warnings": warnings,
	}
	write_json(staging / "manifest.json", manifest, cfg=cfg)
	summary.write(staging / "dev-state-summary.md", manifest, None)
	secure_file(staging / "dev-state-summary.md", cfg)
	return manifest


def _dirty_patches(cfg, repos, staging):
	pdir = secure_dir(staging / "git" / "patches", cfg)
	for r in repos:
		if not r.get("dirty"):
			continue
		diff = discover.git(cfg, Path(r["repo_path"]), "diff", "HEAD", "--binary").stdout or ""
		(pdir / f"{r['app']}.diff").write_text(diff)
		secure_file(pdir / f"{r['app']}.diff", cfg)
		if r["untracked_files"]:
			with tarfile.open(pdir / f"{r['app']}.untracked.tar.gz", "w:gz") as tar:
				for rel in r["untracked_files"]:
					tar.add(Path(r["repo_path"]) / rel, arcname=rel)
			secure_file(pdir / f"{r['app']}.untracked.tar.gz", cfg)


def _package_and_publish(cfg: Config, args, snap_dir: Path, manifest: dict) -> dict:
	sid = manifest["snapshot_id"]
	pkg_dir = secure_dir(cfg.state_dir / "packages", cfg)
	backend_name = (args.backend or cfg.DEV_STATE_BACKEND).lower()
	encrypt = crypto.encryption_configured()
	result = {
		"backend": backend_name,
		"encrypted": encrypt,
		"published": False,
		"location": None,
		"blocked": None,
	}

	if backend_name != "local" and not encrypt:
		result["blocked"] = (
			"remote upload BLOCKED: snapshots contain database dumps and site secrets, and no encryption key "
			"is configured (set DEV_STATE_AGE_RECIPIENTS). The local snapshot is kept."
		)
		log(result["blocked"], level="warn")
		return result
	if args.no_publish:
		log("--no-publish: snapshot kept locally, not packaged or published")
		return result

	plain = snapshot.package(snap_dir, pkg_dir / f"{sid}.tar", cfg)
	package_path = plain
	if encrypt:
		package_path = pkg_dir / f"{sid}.tar.age"
		crypto.encrypt(cfg, plain, package_path)
		secure_file(package_path, cfg)
		plain.unlink()
		log(f"encrypted with age for {len(crypto.recipients())} recipient(s)", level="ok")
	elif backend_name == "local":
		log("encryption not configured: local package is UNENCRYPTED (0600, development only)", level="warn")

	meta = snapshot.backend_meta(manifest, package_path, encrypt)
	backend = get_backend(cfg, backend_name)
	stored = backend.publish(package_path, meta)
	result.update(published=True, location=stored["location"])
	# The backend now holds the verified copy; the staging package would only double the disk use.
	package_path.unlink()
	log(f"published to {backend_name} and latest pointer updated -> {sid}", level="ok")
	return result

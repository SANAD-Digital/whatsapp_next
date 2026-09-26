"""verify-dev-state: concise status of infrastructure, bench, sites, repositories and safety.
Exit code 0 = no FAIL lines (WARN allowed), 1 = at least one FAIL."""

from __future__ import annotations

import json
import re
from pathlib import Path

from . import crypto, discover
from .backends import get_backend
from .common import Config, DevStateError, run, which
from .engines import engine_for


class Report:
	def __init__(self):
		self.fails = 0
		self.warns = 0

	def section(self, title):
		print(f"\n{title}")

	def line(self, status, label, detail=""):
		if status == "FAIL":
			self.fails += 1
		elif status == "WARN":
			self.warns += 1
		print(f"  [{status:<4}] {label:<34} {detail}".rstrip())


def _app_version(cfg: Config, app: str) -> str | None:
	init = cfg.bench / "apps" / app / app / "__init__.py"
	if not init.exists():
		return None
	m = re.search(r"__version__\s*=\s*['\"]([^'\"]+)", init.read_text())
	return m.group(1) if m else None


def _redis_ping(url: str | None) -> bool:
	if not url:
		return False
	m = re.match(r"redis://([^:/]+):(\d+)", url)
	if not m:
		return False
	res = run(["redis-cli", "-h", m.group(1), "-p", m.group(2), "ping"], check=False)
	return (res.stdout or "").strip() == "PONG"


def _values(obj):
	if isinstance(obj, dict):
		for v in obj.values():
			yield from _values(v)
	elif isinstance(obj, list):
		for v in obj:
			yield from _values(v)
	else:
		yield obj


def verify(cfg: Config, args) -> int:
	r = Report()
	markers = [m.strip() for m in cfg.PRODUCTION_URL_MARKERS.split(",") if m.strip()]

	r.section("INFRASTRUCTURE")
	v = discover.tool_versions(cfg)
	r.line(
		"OK" if (v.get("bench_python") or "").startswith(cfg.PYTHON_VERSION) else "FAIL",
		"Python (bench env)",
		v.get("bench_python") or "missing",
	)
	r.line(
		"OK" if (v.get("node") or "").startswith(cfg.NODE_MAJOR + ".") else "FAIL",
		"Node",
		v.get("node") or "missing",
	)
	r.line("OK" if v.get("yarn") else "FAIL", "Yarn", v.get("yarn") or "missing")
	r.line("OK" if v.get("bench") else "FAIL", "Bench CLI", v.get("bench") or "missing")
	for eng in ("postgres", "mariadb"):
		try:
			ver = engine_for(cfg, eng).root_check().splitlines()[0]
			r.line("OK", f"{eng} server", ver)
		except DevStateError as exc:
			r.line("FAIL", f"{eng} server", str(exc).splitlines()[0][:90])
	for name, url in discover.redis_endpoints(cfg).items():
		if name == "redis_socketio" and url == discover.redis_endpoints(cfg).get("redis_cache"):
			continue
		r.line("OK" if _redis_ping(url) else "FAIL", name, url or "not configured")

	r.section("BENCH")
	apps = discover.bench_apps(cfg)
	for app in apps["present"]:
		registered = app in apps["registered"]
		r.line(
			"OK" if registered else "WARN",
			f"app {app}",
			f"{_app_version(cfg, app) or '?'}" + ("" if registered else "  (not in apps.txt)"),
		)

	r.section("SITES")
	sites = discover.discover_sites(cfg)
	if not sites:
		r.line("WARN", "sites", "none found")
	site_probes = {}
	for site in sites:
		conf = discover.read_site_config(cfg, site)
		db = discover.site_db_info(conf, discover.read_common_config(cfg))
		probe = discover.probe_site(cfg, site)
		site_probes[site] = (conf, probe)
		if not probe.get("ok"):
			r.line(
				"FAIL",
				site,
				f"{db['db_type']} {db['db_host']}:{db['db_port']} - {probe.get('error', '')[:80]}",
			)
			continue
		st = probe["settings"]
		missing = [a for a in probe["installed_apps"] if a not in apps["present"]]
		r.line(
			"FAIL" if missing else "OK",
			site,
			f"{db['db_type']} {db['db_host']}:{db['db_port']} ({probe.get('db_server_version', '')[:24]})",
		)
		r.line(
			"FAIL" if missing else "OK",
			"  installed apps",
			", ".join(probe["installed_apps"]) + (f"  MISSING IN BENCH: {missing}" if missing else ""),
		)
		r.line("OK" if st["developer_mode"] else "WARN", "  developer_mode", str(st["developer_mode"]))
		r.line(
			"OK" if not st["scheduler_enabled"] else "WARN",
			"  scheduler",
			"ENABLED" if st["scheduler_enabled"] else "disabled",
		)
		r.line("OK" if st["mute_emails"] else "WARN", "  mute_emails", str(st["mute_emails"]))
		r.line(
			"OK" if st.get("resolved_time_zone") else "WARN",
			"  timezone / country",
			f"{st.get('resolved_time_zone')} / {st.get('country')}",
		)
		fs = discover.site_files_summary(cfg, site)
		ok_dirs = fs["public"]["exists"] and fs["private"]["exists"]
		r.line(
			"OK" if ok_dirs else "WARN",
			"  files",
			f"public {fs['public']['count']}, private {fs['private']['count']}",
		)

	r.section("GIT")
	for app in apps["present"]:
		st = discover.repo_state(cfg, app)
		if not st.get("git"):
			r.line("WARN", app, "not a Git checkout")
			continue
		state = "dirty" if st["dirty"] else "clean"
		if st.get("unpushed_commits"):
			state += f", {st['unpushed_commits']} unpushed"
		r.line(
			"WARN" if st["dirty"] else "OK",
			app,
			f"{st.get('branch')} @ {(st.get('commit') or '')[:12]} ({state})",
		)

	r.section("SAFETY")
	configs = {s: c for s, (c, _p) in site_probes.items()}
	configs["common_site_config.json"] = discover.read_common_config(cfg)
	hits = [
		f"{name}"
		for name, conf in configs.items()
		if any(isinstance(v, str) and any(m in v for m in markers) for v in _values(conf))
	]
	r.line(
		"FAIL" if hits else "OK",
		"no production URLs in configs",
		", ".join(hits) or f"checked for: {', '.join(markers)}",
	)
	for site, (conf, probe) in site_probes.items():
		if probe.get("ok") and "snd_whatsapp_platform" in probe["installed_apps"]:
			url = conf.get("wa_admin_api_url")
			# Unset means the platform falls back to the production gateway (wa_admin_provider.py).
			r.line(
				"OK" if url and not any(m in url for m in markers) else "FAIL",
				f"{site} wa_admin_api_url",
				url or "UNSET -> production default",
			)
	enabled = [s for s, (_c, p) in site_probes.items() if p.get("ok") and p["settings"]["scheduler_enabled"]]
	r.line(
		"WARN" if enabled else "OK",
		"schedulers",
		"enabled on " + ", ".join(enabled) if enabled else "disabled on all sites",
	)
	procs = discover.running_processes()
	r.line("WARN" if procs["workers"] else "OK", "background workers", f"{len(procs['workers'])} running")
	r.line(
		"WARN" if procs["schedulers"] else "OK", "scheduler processes", f"{len(procs['schedulers'])} running"
	)
	r.line(
		"OK",
		"web / wa-admin mock",
		f"{len(procs['web'])} web process(es), mock {'running' if procs['wa_admin_mock'] else 'stopped'}",
	)

	r.section("SNAPSHOTS")
	try:
		backend = get_backend(cfg)
		latest = backend.latest()
		r.line(
			"OK" if latest else "WARN",
			f"latest ({backend.name})",
			latest["snapshot_id"] if latest else "none saved yet",
		)
	except DevStateError as exc:
		r.line("WARN", "backend", str(exc)[:100])
	try:
		enc = crypto.encryption_configured()
	except DevStateError as exc:
		r.line("FAIL", "encryption", str(exc)[:100])
	else:
		r.line(
			"OK" if enc else "WARN",
			"encryption (age recipients)",
			"configured" if enc else "not configured: remote upload blocked",
		)
	r.line("OK" if which("age") else "WARN", "age tool", "installed" if which("age") else "missing")

	print(f"\n{r.fails} FAIL, {r.warns} WARN")
	return 1 if r.fails else 0

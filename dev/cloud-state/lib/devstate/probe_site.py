"""Describe one Frappe site as JSON. Runs inside the bench virtualenv as the frappe user.

    env/bin/python probe_site.py <sites_dir> <site> [--counts]

Read-only: it opens a connection, reads, rolls back. Never prints secrets.
"""

import json
import os
import sys


def main():
	sites_dir, site = sys.argv[1], sys.argv[2]
	with_counts = "--counts" in sys.argv[3:]
	os.chdir(sites_dir)
	import frappe

	frappe.init(site=site, sites_path=".")
	out = {"site": site, "ok": False}
	try:
		frappe.connect()
		conf = frappe.conf
		out["db_type"] = conf.get("db_type") or "mariadb"
		apps = frappe.get_installed_apps()
		out["installed_apps"] = apps
		versions = {}
		for app in apps:
			try:
				versions[app] = frappe.get_attr(f"{app}.__version__")
			except Exception:
				versions[app] = None
		out["app_versions"] = versions
		single = frappe.db.get_single_value
		out["settings"] = {
			"scheduler_enabled": bool(single("System Settings", "enable_scheduler")),
			"time_zone": single("System Settings", "time_zone"),
			"resolved_time_zone": frappe.utils.get_system_timezone(),
			"country": single("System Settings", "country"),
			"setup_complete": bool(single("System Settings", "setup_complete")),
			"developer_mode": bool(conf.get("developer_mode")),
			"allow_tests": bool(conf.get("allow_tests")),
			"mute_emails": bool(conf.get("mute_emails")),
			"pause_scheduler": bool(conf.get("pause_scheduler")),
		}
		version_sql = "select version()"
		out["db_server_version"] = str(frappe.db.sql(version_sql)[0][0])
		tables = sorted(frappe.db.get_tables(cached=False))
		out["table_count"] = len(tables)
		if with_counts:
			counts = {}
			for table in tables:
				quoted = f'"{table}"' if out["db_type"] == "postgres" else f"`{table}`"
				counts[table] = int(frappe.db.sql(f"select count(*) from {quoted}")[0][0])
			out["row_counts"] = counts
			out["total_rows"] = sum(counts.values())
		out["ok"] = True
	except Exception as exc:  # report, never raise: the caller decides what a failure means
		out["error"] = f"{type(exc).__name__}: {str(exc)[:300]}"
	finally:
		try:
			frappe.db.rollback()
		except Exception:
			pass
		frappe.destroy()
	print(json.dumps(out, default=str))


if __name__ == "__main__":
	main()

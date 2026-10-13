"""Create or update every WA-FUNCTION Server Script from `scripts/functions/wa_fn_*.py`.

Each file becomes one Server Script named after the file (`wa_fn_ping.py` → `wa_fn_ping`), with
Script Type API, API Method = the same name, enabled, Allow Guest off. An existing script with
that name keeps its record and only gets the script text (and the fixed fields above) rewritten
when they differ. Running it again changes nothing. The files are the repo copy; on a site the
Server Script records are the source of truth.

Server scripts must be enabled on the site (`server_script_enabled`). Run it from the bench:

    cd /home/snd/frappe-bench
    echo 'ns = {}; exec(open("/home/snd/frappe-bench/apps/whatsapp_next/scripts/setup_functions.py").read(), ns); ns["run"]()' \\
        | bench --site whatsapp.dev.sanad.digital console

`ns["run"](["wa_fn_ping"])` limits it to the names given.
"""

import os

import frappe

FUNCTIONS_DIR = "/home/snd/frappe-bench/apps/whatsapp_next/scripts/functions"
FIXED = {"script_type": "API", "disabled": 0, "allow_guest": 0}


def _files() -> list[tuple[str, str]]:
	out = []
	for fn in sorted(os.listdir(FUNCTIONS_DIR)):
		if fn.startswith("wa_fn_") and fn.endswith(".py"):
			with open(os.path.join(FUNCTIONS_DIR, fn), encoding="utf-8") as f:
				out.append((fn[:-3], f.read()))
	return out


def run(only: list[str] | None = None) -> None:
	"""Create or update every `wa_fn_*` file as a Server Script; `only` limits it to those names."""
	frappe.set_user("Administrator")
	for name, script in _files():
		if only and name not in only:
			continue
		wanted = dict(FIXED, api_method=name, script=script)
		if frappe.db.exists("Server Script", name):
			doc = frappe.get_doc("Server Script", name)
			# a script saved from the browser keeps CRLF line ends: the same text, not a change
			current = dict(doc.as_dict(), script=(doc.script or "").replace("\r\n", "\n"))
			changed = [k for k, v in wanted.items() if current.get(k) != v]
			if not changed:
				print(f"same    {name}")
				continue
			doc.update(wanted)
			doc.save()
			print(f"updated {name} ({', '.join(changed)})")
		else:
			doc = frappe.get_doc(dict(wanted, doctype="Server Script"))
			doc.insert(set_name=name)
			print(f"created {name}")
	frappe.db.commit()

# Module role: the WhatsApp hub on this site (owner, 2026-10-29). The platform publishes ready-made
# functions, commands, alerts and notifications; each screen of those opens the hub on its own
# type, shows what this site lacks («Not installed») and what changed since it installed an entry
# («Update available»), and installs or updates an entry here. A record installed from the hub
# keeps the entry's name and checksum (`hub_entry`, `hub_checksum`), which is how both are told.

from __future__ import annotations

from typing import Any

import frappe
from frappe import _

from whatsapp_next.exceptions import WAPermissionError, WAValidationError
from whatsapp_next.providers import registry
from whatsapp_next.services import audit, backup, functions_catalog
from whatsapp_next.services import function_header as fh

#: hub type → the DocType an entry installs as
DOCTYPES: dict[str, str] = {
	"Function": "WhatsApp Function",
	"Command": "WhatsApp Command",
	"Alert": "WhatsApp Notification Alert",
	"Notification": "WhatsApp Notification",
}
#: sent by themselves: a new one arrives switched off, as a backup brings them in
SWITCHED_OFF_ON_INSTALL = ("WhatsApp Notification", "WhatsApp Notification Alert")


def _doctype(hub_type: str) -> str:
	if hub_type not in DOCTYPES:
		frappe.throw(_("Unknown hub type {0}").format(hub_type), WAValidationError)
	return DOCTYPES[hub_type]


def _local(doctype: str, entry: str) -> frappe._dict | None:
	return frappe.db.get_value(doctype, {"hub_entry": entry}, ["name", "hub_checksum"], as_dict=True)


def entries(hub_type: str, txt: str | None = None) -> list[dict[str, Any]]:
	"""The hub's entries of one type, each with `state` — `not_installed`, `update_available` or
	`installed` — and `local`, the record here when there is one."""
	doctype = _doctype(hub_type)
	out = []
	for row in registry.get_provider().list_hub(hub_type, txt):
		local = _local(doctype, row.get("name"))
		state = "not_installed" if not local else ("update_available" if local.hub_checksum != row.get("checksum") else "installed")
		out.append({**row, "state": state, "local": local.name if local else None})
	return out


def entry(name: str) -> dict[str, Any]:
	"""One entry with its data and `state`, for the details view."""
	row = registry.get_provider().get_hub_entry(name)
	if not row:
		frappe.throw(_("This hub entry is not available."), WAValidationError)
	doctype = _doctype(row.get("hub_type"))
	local = _local(doctype, name)
	# what the details view calls each field: the DocType's own label, in the user's language
	meta = frappe.get_meta(doctype)
	row["labels"] = {k: _(meta.get_label(k)) for k in (row.get("payload") or {}) if meta.has_field(k)}
	row["state"] = "not_installed" if not local else ("update_available" if local.hub_checksum != row.get("checksum") else "installed")
	row["local"] = local.name if local else None
	return row


def install(name: str, user: str | None = None) -> dict[str, Any]:
	"""Install the entry, or update the copy installed before → `{doctype, name, created}`."""
	row = entry(name)
	payload = row.get("payload") or {}
	if not isinstance(payload, dict) or not payload:
		frappe.throw(_("This hub entry has no data."), WAValidationError)
	doctype = _doctype(row["hub_type"])
	if doctype == "WhatsApp Function":
		local, created = _install_function(payload)
	else:
		local, created = _install_record(doctype, payload, row.get("local"))
	frappe.db.set_value(doctype, local, {"hub_entry": name, "hub_checksum": row.get("checksum")}, update_modified=False)
	audit.log(
		"Hub Entry Installed",
		reference=(doctype, local),
		user=user,
		summary="Installed from the hub" if created else "Updated from the hub",
		details={"hub_entry": name, "checksum": row.get("checksum")},
	)
	return {"doctype": doctype, "name": local, "created": created}


def _install_record(doctype: str, payload: dict[str, Any], local: str | None) -> tuple[str, bool]:
	"""Create the record from the entry's fields, or update the one installed before; only the
	DocType's own set-up fields are taken (`backup._clean`)."""
	clean = backup._clean(doctype, payload)
	if local and frappe.db.exists(doctype, local):
		doc = frappe.get_doc(doctype, local)
		# an update brings the new set-up, not a switch: what this site turned on or off stays
		if doctype in SWITCHED_OFF_ON_INSTALL:
			clean.pop("enabled", None)
		doc.update(clean)
		doc.flags.ignore_permissions = True
		doc.save(ignore_permissions=True)
		return doc.name, False
	if doctype in SWITCHED_OFF_ON_INSTALL:
		clean["enabled"] = 0
	doc = frappe.get_doc({"doctype": doctype, **clean})
	doc.flags.ignore_permissions = True
	wanted = payload.get("name")
	if wanted and frappe.db.exists(doctype, wanted):
		frappe.throw(_("{0} {1} already exists here and was not installed from the hub.").format(_(doctype), wanted), WAValidationError)
	doc.insert(ignore_permissions=True, set_name=wanted or None)
	return doc.name, True


def _install_function(payload: dict[str, Any]) -> tuple[str, bool]:
	"""A function is code that runs on this site: its Server Script is created (or its code
	replaced) from the entry, then the function is installed or updated from it. System Manager
	only — the same right that writes a Server Script by hand."""
	if "System Manager" not in frappe.get_roles():
		frappe.throw(_("Only a System Manager can install a function: it runs code on this site."), WAPermissionError)
	script_name = str(payload.get("server_script") or "").strip()
	code = str(payload.get("script") or "")
	if not script_name.startswith(fh.API_PREFIX) or not code.strip():
		frappe.throw(_("This hub function has no valid script."), WAValidationError)
	if frappe.db.exists("Server Script", script_name):
		script = frappe.get_doc("Server Script", script_name)
		script.script = code
		script.disabled = 0
		script.save(ignore_permissions=True)
	else:
		frappe.get_doc(
			{
				"doctype": "Server Script",
				"name": script_name,
				"script_type": "API",
				"api_method": script_name,
				"script": code,
			}
		).insert(ignore_permissions=True, set_name=script_name)
	functions_catalog.clear_cache()
	spec, _checksum = functions_catalog.script_spec(script_name)
	key = spec["function"]
	if frappe.db.exists(functions_catalog.DT, key):
		return functions_catalog.update(key), False
	return functions_catalog.install(script_name), True

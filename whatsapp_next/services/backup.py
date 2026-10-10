# Module role: the app's backup file and the account switch (owner, 2026-10-10).
#
# A backup is one JSON file of what this site set up — Settings (no keys, no device), templates,
# document notifications, notification alerts, functions, commands and contact groups — so it can
# be brought back here or into another site (`import_backup`). Nothing tied to a platform account
# is in it: devices, messages, the queue and the WhatsApp Numbers belong to the account that sent
# and received them.
#
# Those are what `purge_account_data` deletes when the site is linked to ANOTHER account: kept,
# they would point at devices the new account does not own. Everything a backup holds stays, with
# its device left empty so the default device answers. ERPNext's own Contacts are never touched.

from __future__ import annotations

import json
from typing import Any

import frappe
from frappe import _
from frappe.utils import now_datetime

from whatsapp_next.exceptions import WAValidationError
from whatsapp_next.services import audit
from whatsapp_next.services import settings as settings_service

FORMAT = "whatsapp_next.backup"
VERSION = 1

#: in import order: a command names its function, a notification its template
DOCTYPES: tuple[str, ...] = (
	"WhatsApp Function",
	"WhatsApp Template",
	"WhatsApp Contact Group",
	"WhatsApp Command",
	"WhatsApp Notification",
	"WhatsApp Notification Alert",
)

#: Settings sections a backup carries, with the fields it leaves out (keys live in their own
#: fields and are never read here; a device belongs to the account)
SETTINGS_SECTIONS: tuple[str, ...] = ("queue", "commands", "policy", "picker", "retention", "webhook")
DEVICE_FIELDS = frozenset({"device", "reply_device", "default_device", "requested_device"})

#: what belongs to the platform account, deleted children-first when the account changes
ACCOUNT_DOCTYPES: tuple[str, ...] = (
	"WhatsApp Queue Item",
	"WhatsApp Webhook Event",
	"WhatsApp Number Check",
	"WhatsApp Status Post",
	"WhatsApp Log",
	"WhatsApp Inbound Message",
	"WhatsApp Number",
	"WhatsApp Device",
)

#: what keeps a device or a message of the old account by name: emptied, not deleted
ACCOUNT_REFERENCES: tuple[tuple[str, str], ...] = (
	("WhatsApp Campaign", "device"),
	("WhatsApp Campaign Recipient", "outbound_message"),
	("WhatsApp Command", "reply_device"),
	("WhatsApp Notification", "device"),
	("WhatsApp Notification Alert", "device"),
)


# ---- the backup file -------------------------------------------------------------------------------


def _settings_values() -> dict[str, Any]:
	from whatsapp_next.api.v1.settings import WRITABLE

	doc = frappe.get_doc("WhatsApp Settings")
	out: dict[str, Any] = {}
	for section in SETTINGS_SECTIONS:
		for fieldname in WRITABLE.get(section, ()):
			if fieldname in DEVICE_FIELDS:
				continue
			if fieldname == "picker_sources":
				out[fieldname] = [
					{f: row.get(f) for f in settings_service.PICKER_SOURCE_FIELDS} for row in doc.get("picker_sources") or []
				]
			else:
				out[fieldname] = doc.get(fieldname)
	return out


def _record(doctype: str, name: str) -> dict[str, Any]:
	doc = frappe.get_doc(doctype, name)
	data = doc.as_dict(no_default_fields=True, no_child_table_fields=True, convert_dates_to_str=True)
	data["name"] = doc.name
	for fieldname in DEVICE_FIELDS:
		data.pop(fieldname, None)
	return data


def export_backup() -> dict[str, Any]:
	"""The backup as a dict — the client saves it as a `.json` file."""
	data: dict[str, Any] = {
		"format": FORMAT,
		"version": VERSION,
		"site": frappe.local.site,
		"exported_at": str(now_datetime()),
		"settings": _settings_values(),
		"records": {},
	}
	for doctype in DOCTYPES:
		names = frappe.get_all(doctype, pluck="name", order_by="creation asc")
		data["records"][doctype] = [_record(doctype, n) for n in names]
	return data


def import_backup(payload: str | dict, user: str | None = None) -> dict[str, Any]:
	"""Bring a backup in: Settings sections are written, every record is created or, when one of
	the same name exists, replaced by the file's version. A record that fails is reported and the
	rest go on. Returns `{settings, created, updated, failed[{doctype, name, error}]}`."""
	data = payload
	if isinstance(payload, str):
		try:
			data = json.loads(payload)
		except ValueError:
			frappe.throw(_("The file is not a valid JSON file."), WAValidationError)
	if not isinstance(data, dict) or data.get("format") != FORMAT:
		frappe.throw(_("This file is not a WhatsApp Next backup."), WAValidationError)
	if int(data.get("version") or 0) > VERSION:
		frappe.throw(_("This backup was made by a newer version of the app."), WAValidationError)

	out: dict[str, Any] = {"settings": [], "created": 0, "updated": 0, "failed": []}
	values = data.get("settings") or {}
	if isinstance(values, dict) and values:
		from whatsapp_next.api.v1.settings import WRITABLE

		for section in SETTINGS_SECTIONS:
			allowed = set(WRITABLE.get(section, ())) - DEVICE_FIELDS
			part = {k: v for k, v in values.items() if k in allowed}
			if part:
				try:
					out["settings"] += settings_service.save_fields(part, section=section, user=user)
				except Exception as exc:
					frappe.db.rollback()
					out["failed"].append({"doctype": "WhatsApp Settings", "name": section, "error": _message(exc)})

	records = data.get("records") or {}
	for doctype in DOCTYPES:
		for row in records.get(doctype) or []:
			if not isinstance(row, dict) or not row.get("name"):
				continue
			name = row["name"]
			clean = {k: v for k, v in row.items() if k not in DEVICE_FIELDS and k not in ("doctype", "name")}
			try:
				frappe.db.savepoint("wa_backup_row")
				if frappe.db.exists(doctype, name):
					doc = frappe.get_doc(doctype, name)
					doc.update(clean)
					doc.flags.ignore_permissions = True
					doc.save(ignore_permissions=True)
					out["updated"] += 1
				else:
					doc = frappe.get_doc({"doctype": doctype, **clean})
					doc.flags.ignore_permissions = True
					doc.insert(ignore_permissions=True, set_name=name)
					out["created"] += 1
			except Exception as exc:
				frappe.db.rollback(save_point="wa_backup_row")
				frappe.clear_last_message()
				out["failed"].append({"doctype": doctype, "name": name, "error": _message(exc)})
	audit.log(
		"Settings Changed",
		user=user,
		details={
			"action": "import_backup",
			"from_site": data.get("site"),
			"created": out["created"],
			"updated": out["updated"],
			"failed": len(out["failed"]),
		},
	)
	return out


def _message(exc: Exception) -> str:
	return frappe.utils.strip_html(str(exc))[:300] or exc.__class__.__name__


# ---- switching account --------------------------------------------------------------------------------


def account_key() -> str | None:
	"""The platform account this site is linked to, by its customer key (stable per account)."""
	try:
		return frappe.get_doc("WhatsApp Settings").get_password("customer_api_key", raise_exception=False) or None
	except Exception:
		return None


def purge_account_data(user: str | None = None) -> dict[str, int]:
	"""Delete what belonged to the account this site leaves: devices, messages both ways, the
	queue, the WhatsApp Numbers and their traces. References to them are emptied first.
	Returns the count deleted per DocType; audited as the credential change it follows.

	Never during tests unless a test asks for it (`frappe.flags.wa_allow_purge`): the test site's
	messages and devices are real data, and a sign-in test with a stand-in provider changes the
	keys like a real switch does (that deleted whatsapp.dev's messages once, 2026-10-10)."""
	if frappe.flags.in_test and not frappe.flags.wa_allow_purge:
		return {}
	for doctype, fieldname in ACCOUNT_REFERENCES:
		if frappe.db.table_exists(doctype) and frappe.get_meta(doctype).has_field(fieldname):
			frappe.db.set_value(doctype, {fieldname: ("is", "set")}, fieldname, None, update_modified=False)
	settings = frappe.get_doc("WhatsApp Settings")
	for fieldname in ("default_device", "reply_device", "numbers_watermark"):
		if settings.meta.has_field(fieldname):
			frappe.db.set_single_value("WhatsApp Settings", fieldname, None, update_modified=False)
	counts: dict[str, int] = {}
	for doctype in ACCOUNT_DOCTYPES:
		if not frappe.db.table_exists(doctype):
			continue
		counts[doctype] = frappe.db.count(doctype)
		frappe.db.delete(doctype)
	frappe.clear_document_cache("WhatsApp Settings", "WhatsApp Settings")
	frappe.cache.delete_keys("wa:")
	audit.log("Credentials Changed", user=user, details={"account_switched": 1, "deleted": counts})
	return counts

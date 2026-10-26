# Module role: the app's backup file and the account switch (owner, 2026-10-10).
#
# A backup is one JSON file of what this site set up — Settings (no keys, no device), templates,
# document notifications, notification alerts, functions, commands, contact groups and campaigns —
# so it can be brought back here or into another site (`preview_backup`, then `import_backup`).
#
# What an import may do is fixed here, not by the file (owner, 2026-10-22, "fix the backup"):
# - only the DocType's own fields are taken, minus the run state (counters, last sent, errors) —
#   a field the file names that the DocType does not have is dropped;
# - notifications and alerts come in switched off, so a restored site does not start sending
#   before someone looks at them;
# - a campaign comes in as a new Draft on this site's default device, its delivery figures left
#   behind; a campaign that already exists here is kept as it is (a sent campaign cannot be
#   rewritten);
# - `preview_backup` says what would be added, replaced and switched off before anything is written. Nothing tied to a platform account
# is in it: devices, messages, the queue and the WhatsApp Numbers belong to the account that sent
# and received them.
#
# Those are what a System Manager may delete once the site is linked to ANOTHER account (see
# "switching account" below): they point at devices the new account does not own. Everything a
# backup holds stays, with its device left empty so the default device answers. ERPNext's own
# Contacts are never touched.

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
	"WhatsApp Campaign",
)

#: per DocType (and child table): fields that record what happened, not what was set up — never
#: exported, never imported
RUN_STATE: dict[str, frozenset[str]] = {
	"WhatsApp Function": frozenset({"call_count", "last_called_at", "avg_ms", "error_count", "last_error", "update_available"}),
	"WhatsApp Template": frozenset({"use_count", "last_used_at"}),
	"WhatsApp Contact Group": frozenset({"member_count", "members_changed_at"}),
	"WhatsApp Command": frozenset({"run_count", "last_run_at"}),
	"WhatsApp Notification": frozenset({"send_count", "last_sent_at", "last_error", "last_error_at"}),
	"WhatsApp Notification Alert": frozenset({"send_count", "last_sent_at", "last_error", "next_run_at"}),
	"WhatsApp Campaign": frozenset({
		"status", "total_recipients", "initial_recipients", "added_count", "removed_count", "pause_count",
		"queued_count", "sent_count", "delivered_count", "read_count", "failed_count", "cancelled_count",
		"first_message_at", "last_message_at", "started_at", "ended_at", "last_batch_started_at", "started_by",
		"paused_at", "paused_by", "cancelled_at", "cancelled_by", "scheduled_at", "pause_reason", "cancel_reason",
	}),
	"WhatsApp Campaign Recipient": frozenset({
		"status", "outbound_message", "error_code", "added_by", "added_at", "removed_by", "removed_at",
	}),
}

#: imported switched off: they send by themselves
SWITCHED_OFF_ON_IMPORT = ("WhatsApp Notification", "WhatsApp Notification Alert")
#: created when missing, never replaced
CREATE_ONLY = ("WhatsApp Campaign",)

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


def _clean(doctype: str, row: dict[str, Any]) -> dict[str, Any]:
	"""`row` reduced to the DocType's own set-up fields: no unknown names, no device, no run state;
	child tables cleaned the same way against their own DocType."""
	from frappe.model import no_value_fields

	meta = frappe.get_meta(doctype)
	skip = DEVICE_FIELDS | RUN_STATE.get(doctype, frozenset())
	out: dict[str, Any] = {}
	for df in meta.fields:
		if df.fieldtype in no_value_fields and df.fieldtype not in ("Table", "Table MultiSelect"):
			continue
		if df.fieldname in skip or df.fieldname not in row:
			continue
		value = row[df.fieldname]
		if df.fieldtype in ("Table", "Table MultiSelect"):
			value = [_clean(df.options, child) for child in (value or []) if isinstance(child, dict)]
		out[df.fieldname] = value
	return out


def _record(doctype: str, name: str) -> dict[str, Any]:
	doc = frappe.get_doc(doctype, name)
	data = _clean(doctype, doc.as_dict(no_default_fields=True, no_child_table_fields=True, convert_dates_to_str=True))
	data["name"] = doc.name
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


def _parse(payload: str | dict) -> dict[str, Any]:
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
	return data


def _rows(data: dict[str, Any], doctype: str) -> list[dict[str, Any]]:
	return [row for row in (data.get("records") or {}).get(doctype) or [] if isinstance(row, dict) and row.get("name")]


def preview_backup(payload: str | dict) -> dict[str, Any]:
	"""What `import_backup` would do with this file, nothing written: `{site, exported_at,
	settings, add[{doctype, name}], replace[{doctype, name}], keep[{doctype, name}],
	switched_off}` — `keep` are campaigns already here, `switched_off` the notifications and
	alerts that come in disabled."""
	data = _parse(payload)
	out: dict[str, Any] = {
		"site": data.get("site"), "exported_at": data.get("exported_at"),
		"settings": len(data.get("settings") or {}), "add": [], "replace": [], "keep": [], "switched_off": 0,
	}
	for doctype in DOCTYPES:
		for row in _rows(data, doctype):
			item = {"doctype": doctype, "name": row["name"]}
			if not frappe.db.exists(doctype, row["name"]):
				out["add"].append(item)
			elif doctype in CREATE_ONLY:
				out["keep"].append(item)
			else:
				out["replace"].append(item)
			if doctype in SWITCHED_OFF_ON_IMPORT and not (doctype in CREATE_ONLY and item in out["keep"]):
				out["switched_off"] += 1
	return out


def import_backup(payload: str | dict, user: str | None = None) -> dict[str, Any]:
	"""Bring a backup in: Settings sections are written, every record is created or, when one of
	the same name exists, replaced by the file's version (campaigns are only created). Only the
	DocType's own set-up fields are taken; notifications and alerts arrive switched off. A record
	that fails is reported and the rest go on. Returns `{settings, created, updated, kept,
	switched_off, failed[{doctype, name, error}]}`."""
	data = _parse(payload)
	out: dict[str, Any] = {"settings": [], "created": 0, "updated": 0, "kept": 0, "switched_off": 0, "failed": []}
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

	for doctype in DOCTYPES:
		for row in _rows(data, doctype):
			name = row["name"]
			clean = _clean(doctype, row)
			if doctype in SWITCHED_OFF_ON_IMPORT:
				clean["enabled"] = 0
			try:
				frappe.db.savepoint("wa_backup_row")
				if frappe.db.exists(doctype, name) and doctype in CREATE_ONLY:
					out["kept"] += 1
					continue
				if frappe.db.exists(doctype, name):
					doc = frappe.get_doc(doctype, name)
					doc.update(clean)
					doc.flags.ignore_permissions = True
					doc.save(ignore_permissions=True)
					out["updated"] += 1
				else:
					if doctype in CREATE_ONLY and frappe.get_meta(doctype).has_field("device"):
						# a draft needs a sender: this site's default device (devices are not in a backup)
						from whatsapp_next.services.devices import default_device

						clean["device"] = default_device()
					doc = frappe.get_doc({"doctype": doctype, **clean})
					doc.flags.ignore_permissions = True
					doc.insert(ignore_permissions=True, set_name=name)
					out["created"] += 1
				if doctype in SWITCHED_OFF_ON_IMPORT:
					out["switched_off"] += 1
			except Exception as exc:
				frappe.db.rollback(save_point="wa_backup_row")
				frappe.clear_last_message()
				out["failed"].append({"doctype": doctype, "name": name, "error": _message(exc)})
	audit.log(
		"Backup Imported",
		user=user,
		details={
			"from_site": data.get("site"),
			"exported_at": data.get("exported_at"),
			"created": out["created"],
			"updated": out["updated"],
			"kept": out["kept"],
			"switched_off": out["switched_off"],
			"failed": len(out["failed"]),
		},
	)
	return out


def _message(exc: Exception) -> str:
	return frappe.utils.strip_html(str(exc))[:300] or exc.__class__.__name__


# ---- switching account --------------------------------------------------------------------------------
#
# Owner, 2026-10-22: switching the account must never delete silently. The site remembers WHICH
# platform account it is linked to (the platform's integration link, the same through a key
# rotation), and when a sign-in or a sign-up links it to another one nothing is deleted on the
# spot: the previous account's devices are switched off (they would answer to keys the site no
# longer holds), and the switch is recorded. A System Manager then sees what the previous account
# left — devices, messages both ways, the queue, the numbers — and deletes it on purpose
# (`delete_previous_account`, a background job in batches, attached files included) or keeps it.
# Only what existed before the switch is in scope: the new account's devices and messages are
# never touched.

ACCOUNT_DEFAULT = "whatsapp_next_platform_account"
SWITCH_DEFAULT = "whatsapp_next_account_switch"
PURGE_BATCH = 1000


def account_key() -> str | None:
	"""The customer key the site holds now (a fallback identity for sites linked before the
	account itself was remembered)."""
	from whatsapp_next.services import secrets

	return secrets.read("customer_api_key")


def current_account() -> str | None:
	"""The platform account (integration link) this site is linked to, when known."""
	return frappe.db.get_default(ACCOUNT_DEFAULT) or None


def note_account(previous_key: str | None, previous_account: str | None, new_account: str | None, user: str | None = None) -> bool:
	"""Called once new keys are stored: remember the account, and when it is another one than
	before, switch the previous account's devices off and record the switch for a decision.
	True when the account changed. Nothing is deleted here.

	Never during tests unless a test asks for it (`frappe.flags.wa_allow_account_switch`): a sign-in
	test with a stand-in provider links the site to a made-up account, and the real device of the
	test site would be switched off (it was, once: 2026-10-22)."""
	if frappe.flags.in_test and not frappe.flags.wa_allow_account_switch:
		return False
	if new_account:
		frappe.db.set_default(ACCOUNT_DEFAULT, new_account)
	if not previous_key and not previous_account:
		return False  # the site's first account
	if previous_account and new_account:
		switched = previous_account != new_account
	else:
		# an account linked before the account was remembered: its key is all there is to compare
		current = account_key()
		switched = bool(previous_key and current and previous_key != current)
	if not switched:
		return False
	devices = frappe.get_all("WhatsApp Device", pluck="name")
	pending = pending_switch_raw() or {}
	record = {
		"from": pending.get("from") or previous_account,
		"to": new_account,
		"at": str(now_datetime()),
		"devices": sorted(set(pending.get("devices") or []) | set(devices)),
	}
	frappe.db.set_default(SWITCH_DEFAULT, json.dumps(record))
	if devices:
		frappe.db.set_value("WhatsApp Device", {"name": ("in", devices)}, {"disabled": 1, "is_default": 0}, update_modified=False)
	for fieldname in ("default_device", "reply_device"):
		frappe.db.set_single_value("WhatsApp Settings", fieldname, None, update_modified=False)
	frappe.clear_document_cache("WhatsApp Settings", "WhatsApp Settings")
	audit.log(
		"Credentials Changed",
		user=user,
		details={"account_switched": 1, "from": record["from"], "to": new_account, "devices_switched_off": len(devices)},
	)
	return True


def pending_switch_raw() -> dict[str, Any] | None:
	"""The recorded account switch as stored (`{from, to, at, devices}`), or None."""
	raw = frappe.db.get_default(SWITCH_DEFAULT)
	if not raw:
		return None
	try:
		data = json.loads(raw)
	except ValueError:
		return None
	return data if isinstance(data, dict) and data.get("at") else None


def _scope(pending: dict[str, Any]) -> dict[str, dict[str, Any]]:
	"""Filters of what the previous account left, per DocType: what existed before the switch."""
	at = pending["at"]
	out = {doctype: {"creation": ("<=", at)} for doctype in ACCOUNT_DOCTYPES}
	out["WhatsApp Device"] = {"name": ("in", pending.get("devices") or [""]), "creation": ("<=", at)}
	# a number the new account has talked to since is the new account's
	out["WhatsApp Number"] = {"modified": ("<=", at)}
	return out


def pending_switch() -> dict[str, Any]:
	"""`{pending, from, to, at, counts{doctype: n}}` — what the previous account left here."""
	pending = pending_switch_raw()
	if not pending:
		return {"pending": False}
	counts = {
		doctype: frappe.db.count(doctype, filters)
		for doctype, filters in _scope(pending).items()
		if frappe.db.table_exists(doctype)
	}
	return {"pending": True, "from": pending.get("from"), "to": pending.get("to"), "at": pending["at"], "counts": counts}


def keep_previous_account(user: str | None = None) -> None:
	"""Keep what the previous account left and stop asking (its devices stay switched off)."""
	pending = pending_switch_raw()
	if not pending:
		return
	frappe.db.set_default(SWITCH_DEFAULT, "")
	audit.log("Settings Changed", user=user, details={"action": "previous_account_kept", "from": pending.get("from")})


def delete_previous_account(user: str | None = None) -> dict[str, Any]:
	"""Queue the deletion of what the previous account left (a System Manager's explicit choice);
	`{queued, counts}`. The job deletes in batches, children first, with attached files."""
	info = pending_switch()
	if not info.get("pending"):
		return {"queued": False, "counts": {}}
	audit.log("Account Data Deleted", user=user, details={"from": info.get("from"), "counts": info["counts"], "stage": "queued"})
	frappe.enqueue(
		"whatsapp_next.services.backup.purge_previous_account",
		queue="long",
		timeout=3600,
		pending=pending_switch_raw(),
		user=user,
		enqueue_after_commit=True,
	)
	return {"queued": True, "counts": info["counts"]}


def purge_previous_account(pending: dict[str, Any], user: str | None = None) -> dict[str, int]:
	"""The background job behind `delete_previous_account`: references to the old devices and
	messages are emptied, then every row in scope is deleted in batches of `PURGE_BATCH` (child
	rows and attached files with it), committing after each batch. ERPNext's own Contacts are
	never touched. Returns the count deleted per DocType."""
	old_devices = pending.get("devices") or []
	if old_devices:
		for doctype, fieldname in ACCOUNT_REFERENCES:
			if fieldname == "outbound_message" or not frappe.db.table_exists(doctype):
				continue
			if frappe.get_meta(doctype).has_field(fieldname):
				frappe.db.set_value(doctype, {fieldname: ("in", old_devices)}, fieldname, None, update_modified=False)
	counts: dict[str, int] = {}
	for doctype, filters in _scope(pending).items():
		if not frappe.db.table_exists(doctype):
			continue
		meta = frappe.get_meta(doctype)
		children = [df.options for df in meta.get_table_fields()]
		counts[doctype] = 0
		while True:
			names = frappe.get_all(doctype, filters=filters, pluck="name", limit=PURGE_BATCH)
			if not names:
				break
			if doctype == "WhatsApp Log":
				frappe.db.set_value("WhatsApp Campaign Recipient", {"outbound_message": ("in", names)}, "outbound_message", None, update_modified=False)
			for child in children:
				frappe.db.delete(child, {"parenttype": doctype, "parent": ("in", names)})
			for file_name in frappe.get_all("File", filters={"attached_to_doctype": doctype, "attached_to_name": ("in", names)}, pluck="name"):
				try:
					frappe.delete_doc("File", file_name, ignore_permissions=True, force=True, delete_permanently=True)
				except Exception:
					frappe.log_error(title="WhatsApp account switch: file not deleted", message=f"File {file_name} of {doctype}")
			frappe.db.delete(doctype, {"name": ("in", names)})
			counts[doctype] += len(names)
			frappe.db.commit()  # nosemgrep - one batch at a time: a long purge never holds one huge transaction
	frappe.db.set_default(SWITCH_DEFAULT, "")
	frappe.cache.delete_keys("wa:")
	audit.log("Account Data Deleted", user=user, details={"from": pending.get("from"), "deleted": counts, "stage": "done"})
	frappe.db.commit()  # nosemgrep - the job's own end
	return counts

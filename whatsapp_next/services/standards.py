# Module role: the standard content the app ships — WhatsApp Templates, Notifications and
# Notification Alerts in `fixtures/standard_*.json` — and what a fixture sync may do to them.
#
# Frappe's `sync_fixtures` runs on install and on every migrate and replaces each fixture record
# (delete, then insert from the file). For content the site owner switches on and adjusts, that
# would undo his work on every update, so the three controllers hand the import to this module
# (`prepare_for_import` / `before_import` / `after_insert`, Frappe's own import hooks):
#
#   * a record that does not exist yet is created as shipped — and always switched off, without a
#     device, with zero counters, whatever the file says;
#   * site-owned state (`SITE_OWNED`: on/off, device, recipients, print format, letter head,
#     counters and timestamps …) is always taken from the site, never from the file;
#   * the rest — the shipped content — follows the file only while the owner has not changed it.
#     Once he edits any content field the record is his: a sync re-creates it exactly as it was.
#
# "Has not changed it" is known from a fingerprint of the content taken when the record was last
# written from the file (`tabDefaultValue`, parent `FINGERPRINT_PARENT`; no schema of its own). A
# record with no fingerprint — the owner's own record that happens to carry a standard name, or
# a site whose fingerprints were lost — is treated as the owner's and left alone.

from __future__ import annotations

import copy
import hashlib
import json
import os
from typing import Any

import frappe
from frappe import _
from frappe.utils import cint, cstr

# doctype → fixture file (the prefix orders the import: templates before what links to them)
FILES: dict[str, str] = {
	"WhatsApp Template": "standard_1_whatsapp_template.json",
	"WhatsApp Notification": "standard_2_whatsapp_notification.json",
	"WhatsApp Notification Alert": "standard_3_whatsapp_notification_alert.json",
}

# Fields a fixture sync never takes from the file once the record exists.
SITE_OWNED: dict[str, tuple[str, ...]] = {
	"WhatsApp Template": (
		"disabled",
		"attachment",
		"print_format",
		"letter_head",
		"file_name_template",
		"use_count",
		"last_used_at",
	),
	"WhatsApp Notification": (
		"enabled",
		"device",
		"print_format",
		"letter_head",
		"recipients",
		"send_count",
		"last_sent_at",
		"last_error",
		"last_error_at",
	),
	"WhatsApp Notification Alert": (
		"enabled",
		"device",
		"print_format",
		"letter_head",
		"filters_json",
		"recipients",
		"send_count",
		"last_sent_at",
		"next_run_at",
		"last_error",
	),
}
# Values the controller derives on save: neither content nor state.
DERIVED: dict[str, tuple[str, ...]] = {"WhatsApp Notification": ("variables_count",)}
# What a record is created with on a site, whatever the file says: nothing sends by itself.
FRESH: dict[str, dict[str, Any]] = {
	"WhatsApp Template": {"use_count": 0, "last_used_at": None},
	"WhatsApp Notification": {
		"enabled": 0,
		"device": None,
		"send_count": 0,
		"last_sent_at": None,
		"last_error": None,
		"last_error_at": None,
	},
	"WhatsApp Notification Alert": {
		"enabled": 0,
		"device": None,
		"send_count": 0,
		"last_sent_at": None,
		"last_error": None,
	},
}
# An alert's schedule: while these stay as they were, a sync keeps the run it was waiting for.
SCHEDULE_FIELDS = ("periodicity", "day_of_week", "day_of_month", "month_of_year", "notification_time")

# A report filter the file cannot know: replaced by the site's default company on the site.
COMPANY_TOKEN = "__default_company__"
FINGERPRINT_PARENT = "__whatsapp_next_standards"
_ROW_KEYS = ("name", "owner", "creation", "modified", "modified_by", "docstatus", "idx", "parent", "parentfield", "parenttype", "doctype")


# ---- the shipped set -----------------------------------------------------------------------


def _path(doctype: str) -> str:
	return frappe.get_app_path("whatsapp_next", "fixtures", FILES[doctype])


_FILE_CACHE: dict[str, tuple[float, dict[str, dict[str, Any]]]] = {}


def records(doctype: str) -> dict[str, dict[str, Any]]:
	"""`{name: record}` as the fixture file of `doctype` ships it (re-read when the file changes)."""
	if doctype not in FILES:
		return {}
	path = _path(doctype)
	if not os.path.exists(path):
		return {}
	stamp = os.path.getmtime(path)
	hit = _FILE_CACHE.get(path)
	if not hit or hit[0] != stamp:
		with open(path, encoding="utf-8") as f:
			hit = (stamp, {row["name"]: row for row in json.load(f)})
		_FILE_CACHE[path] = hit
	return hit[1]


def names(doctype: str) -> list[str]:
	"""Names of the standard records of `doctype`, in file order."""
	return list(records(doctype))


def is_standard(doctype: str | None, name: str | None) -> bool:
	"""True when `name` is one of the records this app ships for `doctype`."""
	return bool(doctype and name and name in records(doctype))


def status(doctype: str, name: str) -> dict[str, bool]:
	"""`{standard, customised}` of one record, for a screen that wants to say so: `customised`
	means the owner changed its content, so updates of the app no longer touch it."""
	standard = is_standard(doctype, name) and bool(frappe.db.exists(doctype, name))
	return {
		"standard": standard,
		"customised": bool(standard and is_customised(frappe.get_doc(doctype, name))),
	}


# ---- fingerprints --------------------------------------------------------------------------


def content_fields(doctype: str) -> list[str]:
	"""The fields whose values are the shipped content: every stored field of the DocType that is
	neither site-owned nor derived."""
	skip = {*SITE_OWNED.get(doctype, ()), *DERIVED.get(doctype, ())}
	return [
		df.fieldname
		for df in frappe.get_meta(doctype).fields
		if df.fieldtype not in frappe.model.no_value_fields and df.fieldname not in skip and not df.is_virtual
	]


def _digest(value: Any) -> str:
	text = "" if value in (None, "", 0) else cstr(value).replace("\r\n", "\n").strip()
	return hashlib.sha1(text.encode("utf-8"), usedforsecurity=False).hexdigest()[:12]


def fingerprint(doc) -> dict[str, str]:
	"""`{fieldname: digest}` of the content of a saved record."""
	return {f: _digest(doc.get(f)) for f in content_fields(doc.doctype)}


def _key(doctype: str, name: str) -> str:
	return f"{doctype}::{name}"


def stored_fingerprint(doctype: str, name: str) -> dict[str, str] | None:
	"""The fingerprint taken when the record was last written from the fixture, or None."""
	raw = frappe.defaults.get_defaults_for(FINGERPRINT_PARENT).get(_key(doctype, name))
	if isinstance(raw, list):
		raw = raw[0] if raw else None
	try:
		value = json.loads(raw) if raw else None
	except ValueError:
		return None
	return value if isinstance(value, dict) else None


def _store_fingerprint(doctype: str, name: str, value: dict[str, str] | None) -> None:
	frappe.defaults.set_default(
		_key(doctype, name), json.dumps(value, sort_keys=True) if value else None, FINGERPRINT_PARENT
	)


def is_customised(doc) -> bool:
	"""True when the content of a standard record is no longer what a fixture wrote: the owner
	edited it, or nothing is known about it. Only the fields fingerprinted then are compared, so
	a field a later version adds to the DocType does not turn every record into a customised one."""
	before = stored_fingerprint(doc.doctype, doc.name)
	if not before:
		return True
	now = fingerprint(doc)
	return any(now.get(f) != digest for f, digest in before.items() if f in now)


# ---- the import hooks (called by the three controllers) ------------------------------------


def _pending() -> dict[tuple[str, str], dict[str, Any]]:
	"""Imports `prepare_for_import` started in this process and `after_insert` has not finished."""
	if frappe.flags.wa_standards_pending is None:
		frappe.flags.wa_standards_pending = {}
	return frappe.flags.wa_standards_pending


def default_company() -> str | None:
	"""The company a standard report alert runs for: the site's default one, or its only one."""
	company = None
	if frappe.db.exists("DocType", "Global Defaults"):
		company = frappe.db.get_single_value("Global Defaults", "default_company")
	company = company or frappe.defaults.get_global_default("company")
	if company and frappe.db.exists("Company", company):
		return company
	if frappe.db.exists("DocType", "Company"):
		only = frappe.get_all("Company", pluck="name", limit=2)
		if len(only) == 1:
			return only[0]
	return None


def _site_filters(shipped: Any, current: Any = None) -> str | None:
	"""An alert's static report filters on this site. A site that has filters keeps them — only
	a company it never chose is filled in; a new record gets the shipped ones. `COMPANY_TOKEN`
	becomes the site's default company (the key is dropped while the site has none, and a later
	sync fills it in)."""

	def load(value: Any) -> Any:
		if isinstance(value, str):
			try:
				return json.loads(value) if value.strip() else None
			except ValueError:
				return value
		return value

	shipped, site = load(shipped), load(current)
	wants_company = isinstance(shipped, dict) and shipped.get("company") == COMPANY_TOKEN
	if site is not None:
		if not (wants_company and isinstance(site, dict) and not site.get("company")):
			return current
		out = dict(site)
	else:
		out = dict(shipped) if isinstance(shipped, dict) else shipped
	if wants_company:
		company = default_company()
		if company:
			out["company"] = company
		else:
			out.pop("company", None)
	if out in (None, {}, []):
		return None
	return out if isinstance(out, str) else json.dumps(out, ensure_ascii=False)


def _rows(doc, fieldname: str) -> list[dict[str, Any]]:
	"""A child table as plain rows a new parent can be built from."""
	return [{k: v for k, v in row.as_dict().items() if k not in _ROW_KEYS} for row in doc.get(fieldname) or []]


def _value(doc, fieldname: str) -> Any:
	df = doc.meta.get_field(fieldname)
	if df and df.fieldtype in frappe.model.table_fields:
		return _rows(doc, fieldname)
	return doc.get(fieldname)


def prepare_for_import(docdict: dict) -> None:
	"""Frappe's `prepare_for_import` hook: called with the record as the file has it, before the
	record on the site is deleted and re-inserted. Rewrites `docdict` in place so that the insert
	brings back what the site owns (see the module header). Records that are not shipped by this
	app pass through untouched."""
	doctype, name = docdict.get("doctype"), docdict.get("name")
	if not is_standard(doctype, name):
		return
	key = (doctype, name)
	if not frappe.db.exists(doctype, name):
		if doctype == "WhatsApp Notification Alert":
			docdict["filters_json"] = _site_filters(docdict.get("filters_json"))
		docdict.update(copy.deepcopy(FRESH[doctype]))
		_pending()[key] = {"mode": "new"}
		return
	old = frappe.get_doc(doctype, name)
	restoring = key in (frappe.flags.wa_standards_restore or ())
	kept = not restoring and is_customised(old)
	if kept:
		# the owner's record: every stored value comes back exactly as it is
		for df in old.meta.fields:
			if df.fieldtype in frappe.model.table_fields or df.fieldtype not in frappe.model.no_value_fields:
				docdict[df.fieldname] = _value(old, df.fieldname)
	else:
		for fieldname in SITE_OWNED[doctype]:
			if fieldname == "filters_json":
				docdict[fieldname] = _site_filters(docdict.get(fieldname), old.get(fieldname))
			else:
				docdict[fieldname] = _value(old, fieldname)
	# the file's timestamp is not this record's: `after_insert` puts the site's back when nothing changed
	docdict.pop("modified", None)
	_pending()[key] = {
		"mode": "kept" if kept else "updated",
		"docdict": docdict,
		"old": old,
	}


def before_import(doc) -> None:
	"""Frappe's `before_import` hook on the document built from the prepared record: a record
	kept as the owner's is re-inserted as it is, without re-validating what was already saved."""
	info = _pending().get((doc.doctype, doc.name))
	if info and info["mode"] == "kept":
		doc.flags.ignore_validate = True
		doc.flags.ignore_mandatory = True


def after_insert(doc) -> None:
	"""Controller `after_insert`: finishes an import `prepare_for_import` started — the record's
	own creation / owner / last change are put back and the content fingerprint is taken."""
	info = _pending().pop((doc.doctype, doc.name), None)
	if not info:
		return
	if info["mode"] == "new":
		_store_fingerprint(doc.doctype, doc.name, fingerprint(frappe.get_doc(doc.doctype, doc.name)))
		return
	old = info["old"]
	values = {"creation": old.creation, "owner": old.owner}
	unchanged = info["mode"] == "kept"
	if not unchanged:
		fresh = frappe.get_doc(doc.doctype, doc.name)
		now = fingerprint(fresh)
		unchanged = now == stored_fingerprint(doc.doctype, doc.name)
		_store_fingerprint(doc.doctype, doc.name, now)
		# an enabled alert whose schedule did not change keeps the run it was waiting for (the
		# controller's validate has just moved it to the next one: a run that was due is not lost)
		if doc.doctype == "WhatsApp Notification Alert" and cint(old.enabled) and old.next_run_at:
			if all(_digest(fresh.get(f)) == _digest(old.get(f)) for f in SCHEDULE_FIELDS):
				values["next_run_at"] = old.next_run_at
	if unchanged:
		# Frappe stamps the record with the file's `modified` after the insert; the dict it reads
		# that from is the one prepared above
		info["docdict"]["modified"] = old.modified
		values["modified_by"] = old.modified_by
	frappe.db.set_value(doc.doctype, doc.name, values, update_modified=False)


# ---- tools ---------------------------------------------------------------------------------


def restore(doctype: str, name: str) -> dict[str, Any]:
	"""Bring one standard record back to the shipped content (the owner's on/off, device,
	recipients and counters stay). For a record the owner customised and wants reset; a record
	that was deleted comes back by itself on the next migrate. P: System Manager / WhatsApp Manager."""
	from frappe.modules.import_file import import_doc

	frappe.only_for(("System Manager", "WhatsApp Manager"))
	if not is_standard(doctype, name):
		frappe.throw(_("{0} is not a standard record of WhatsappNext").format(name))
	record = copy.deepcopy(records(doctype)[name])
	frappe.flags.wa_standards_restore = {(doctype, name)}
	try:
		import_doc(record, data_import=True)
	finally:
		frappe.flags.wa_standards_restore = None
		frappe.flags.in_import = False
	return status(doctype, name)


def overview() -> list[dict[str, Any]]:
	"""Every standard record with its state on this site: `{doctype, name, exists, enabled,
	customised}` — what `bench execute whatsapp_next.services.standards.overview` prints."""
	out = []
	for doctype in FILES:
		flag = "disabled" if doctype == "WhatsApp Template" else "enabled"
		for name in names(doctype):
			exists = bool(frappe.db.exists(doctype, name))
			value = cint(frappe.db.get_value(doctype, name, flag)) if exists else 0
			out.append(
				{
					"doctype": doctype,
					"name": name,
					"exists": exists,
					"enabled": bool(exists and (not value if flag == "disabled" else value)),
					"customised": bool(exists and is_customised(frappe.get_doc(doctype, name))),
				}
			)
	return out

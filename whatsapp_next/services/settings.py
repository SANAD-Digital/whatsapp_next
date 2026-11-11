# Module role: the write path of the Settings page (backend-plan §4.1 `settings.save_settings`,
# A-2 of the phase-8 report). The API owns the per-section allow-list; this writes the fields it
# was given (the picker-sources table row by row), saves once and audits `Settings Changed`.

from __future__ import annotations

from typing import Any

import frappe
from frappe import _
from frappe.utils import cstr

from whatsapp_next.exceptions import WAValidationError
from whatsapp_next.services import audit

SETTINGS = "WhatsApp Settings"
# Lists of chats picked with the contact picker (owner, 2026-11-10): who an edit / deletion reply
# goes to, and who the site may send to. Each row is a number (E.164) or a group (its JID).
TARGET_TABLES: frozenset[str] = frozenset({"edit_reply_to", "delete_reply_to", "send_only_to"})
TARGET_FIELDS: tuple[str, ...] = ("phone_e164", "display_name", "source")
MAX_TARGETS = 500

PICKER_SOURCE_FIELDS: tuple[str, ...] = (
	"document_type",
	"label",
	"phone_source",
	"phone_fieldname",
	"contact_fieldname",
	"name_fieldname",
	"filters_json",
	"enabled",
)


def store_secret(fieldname: str, value: str) -> None:
	"""Store one Settings password outside a document save (a sign-up, a fetched webhook secret).

	`set_encrypted_password` alone fills `__Auth` but leaves the field itself empty in `tabSingles`;
	Frappe's `_save_passwords` reads an empty Password field on the next ordinary save of Settings as
	"cleared" and deletes the stored value. So the field also gets the masked placeholder a document
	save would have written — which is how a sign-up's keys vanished the first time Settings was saved.
	"""
	from frappe.utils.password import set_encrypted_password

	set_encrypted_password(SETTINGS, SETTINGS, value, fieldname)
	frappe.db.set_single_value(SETTINGS, fieldname, "*" * len(value), update_modified=False)


# the platform account's keys: a change to any of them is a change of account
PLATFORM_KEYS: tuple[str, ...] = ("customer_api_key", "customer_api_secret", "api_key", "api_secret")


def save_fields(values: dict[str, Any], *, section: str, user: str | None = None) -> list[str]:
	"""Write `values` (already allow-listed by the caller) into Settings; returns the fieldnames
	that changed. `picker_sources` replaces the whole table."""
	if not values:
		frappe.throw(_("Nothing to save"), WAValidationError)
	doc = frappe.get_doc(SETTINGS)
	changed: list[str] = []
	for fieldname, value in values.items():
		if fieldname == "picker_sources":
			if not isinstance(value, list):
				frappe.throw(_("picker_sources must be a list of rows"), WAValidationError)
			doc.set("picker_sources", [])
			for row in value:
				doc.append(
					"picker_sources", {f: row.get(f) for f in PICKER_SOURCE_FIELDS if f in (row or {})}
				)
			changed.append(fieldname)
			continue
		if fieldname in TARGET_TABLES:
			rows = target_rows(value)
			if rows != target_keys(doc, fieldname, rows_only=True):
				doc.set(fieldname, rows)
				changed.append(fieldname)
			continue
		if doc.get(fieldname) != value:
			doc.set(fieldname, value)
			changed.append(fieldname)
	if changed:
		doc.flags.ignore_permissions = True
		doc.save(ignore_permissions=True)
		audit.record_audit_entry(
			"Settings Changed", fields_written=changed, details={"section": section}, user=user
		)
		if set(changed) & set(PLATFORM_KEYS):
			# new keys may be another account's: the webhook secret kept from the old one would fail
			# every signature, so the account's own secret is fetched again (as the onboarding does)
			frappe.enqueue(
				"whatsapp_next.services.webhook_setup.fetch_secret",
				queue="short",
				job_id="wa-webhook-refetch-secret",
				deduplicate=True,
				enqueue_after_commit=True,
				user=user,
			)
	return changed


def stored_or_default(fieldname: str):
	"""A Settings value, or the field's default when the Settings row was saved before the field
	existed. Frappe hands a never-saved Check back as 0 (not empty), so the stored row is asked."""
	singles = frappe.qb.DocType("Singles")
	stored = (
		frappe.qb.from_(singles)
		.select(singles.value)
		.where((singles.doctype == SETTINGS) & (singles.field == fieldname))
		.run()
	)
	if stored:
		return frappe.get_cached_doc(SETTINGS).get(fieldname)
	df = frappe.get_meta(SETTINGS).get_field(fieldname)
	return df.default if df else None


def target_rows(value) -> list[dict[str, Any]]:
	"""The rows of a chat list as sent by the screen, each key made canonical — a number in E.164,
	a group by its JID — the unreadable and the repeated left out. E: `WAValidationError`."""
	from whatsapp_next.services.phone import classify

	if value in (None, ""):
		return []
	if isinstance(value, str):
		value = frappe.parse_json(value)
	if not isinstance(value, list):
		frappe.throw(_("A list of chats is expected"), WAValidationError)
	if len(value) > MAX_TARGETS:
		frappe.throw(_("A list holds at most {0} chats").format(MAX_TARGETS), WAValidationError)
	rows, seen = [], set()
	for row in value:
		row = row if isinstance(row, dict) else {"phone_e164": row}
		_kind, key = classify(cstr(row.get("phone_e164") or row.get("jid") or "").strip())
		if not key or key in seen:
			continue
		seen.add(key)
		rows.append(
			{
				"phone_e164": key,
				"display_name": cstr(row.get("display_name") or "").strip()[:140] or None,
				"source": cstr(row.get("source") or row.get("source_type") or "").strip()[:140] or None,
			}
		)
	return rows


def target_keys(doc=None, fieldname: str = "send_only_to", rows_only: bool = False):
	"""The chats a Settings list names: their keys (a set; empty means "everyone"), or with
	`rows_only` the rows as `target_rows` writes them."""
	doc = doc or frappe.get_cached_doc(SETTINGS)
	rows = [
		{
			"phone_e164": row.phone_e164,
			"display_name": row.display_name or None,
			"source": row.source or None,
		}
		for row in doc.get(fieldname) or []
	]
	return rows if rows_only else {row["phone_e164"] for row in rows}


def chat_in(fieldname: str, key: str | None) -> bool:
	"""Whether a chat is among those a Settings list names; an empty list names every chat."""
	from whatsapp_next.services.phone import classify

	keys = target_keys(fieldname=fieldname)
	if not keys:
		return True
	return classify(key)[1] in keys

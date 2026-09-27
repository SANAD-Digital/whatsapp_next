# Module role: the write paths of the Commands screen (backend-plan §4.10, A-2 of the phase-8
# report): save from an allow-listed payload, start / stop, restore defaults. The controller
# enforces word uniqueness, override keys and the Active edit lock; this module maps the payload
# onto the document and audits. `api/v1/commands.py` only checks the role and calls in here.

from __future__ import annotations

import json
from typing import Any

import frappe
from frappe import _
from frappe.utils import cint, now_datetime

from whatsapp_next.exceptions import WANotFoundError, WAStateConflictError, WAValidationError
from whatsapp_next.services import audit
from whatsapp_next.whatsapp_next.doctype.whatsapp_command.whatsapp_command import OUTPUT_COPY_FIELDS

# Payload keys accepted by `save_command` (backend-plan §4.10) — never a client fieldname beyond these.
SCALAR_KEYS: tuple[str, ...] = (
	"code",
	"title",
	"function",
	"synonyms",
	"requires_linked_contact",
	"allowed_group",
	"blocked_group",
	"reply_device",
	"description",
)
TABLE_KEYS: tuple[str, ...] = ("allowed_party_types", "settings_overrides", "outputs")
ALLOWED_KEYS: frozenset[str] = frozenset({"name", *SCALAR_KEYS, *TABLE_KEYS})


def get(name: str):
	if not frappe.db.exists("WhatsApp Command", name):
		frappe.throw(_("Command {0} not found").format(name), WANotFoundError)
	return frappe.get_doc("WhatsApp Command", name)


def require_inactive(doc) -> None:
	if doc.status == "Active":
		frappe.throw(
			_("Command {0} is Active; deactivate it before editing").format(doc.name), WAStateConflictError
		)


def save(payload: dict, user: str | None = None) -> str:
	"""Create (`name` absent) or update a command from the allow-listed payload
	`{name?, code, title, function, synonyms, requires_linked_contact, allowed_party_types[],
	allowed_group, blocked_group, reply_device, settings_overrides{}, outputs[], description}`.
	E: `WAStateConflictError` (target Active), `WAValidationError` (unknown key, word collision,
	unknown override key); audited `Command Changed`. Returns the command's name."""
	if not isinstance(payload, dict):
		frappe.throw(_("payload must be an object"), WAValidationError)
	unknown = sorted(set(payload) - ALLOWED_KEYS)
	if unknown:
		frappe.throw(_("Unknown payload keys: {0}").format(", ".join(unknown)), WAValidationError)
	name = payload.get("name")
	if name:
		doc = get(name)
		require_inactive(doc)
	else:
		doc = frappe.new_doc("WhatsApp Command")
		doc.status = "Inactive"
	written: list[str] = []
	for key in SCALAR_KEYS:
		if key in payload:
			value = payload[key]
			if key == "requires_linked_contact":
				value = cint(value)
			if (doc.get(key) or None) != (value or None):
				written.append(key)
			doc.set(key, value)
	if "allowed_party_types" in payload:
		doc.set("allowed_party_types", [])
		for pt in payload.get("allowed_party_types") or []:
			doc.append("allowed_party_types", {"party_type": pt})
		written.append("allowed_party_types")
	if "settings_overrides" in payload:
		overrides = payload.get("settings_overrides")
		if overrides is not None and not isinstance(overrides, dict):
			frappe.throw(_("settings_overrides must be an object"), WAValidationError)
		doc.settings_overrides = json.dumps(overrides, ensure_ascii=False) if overrides else None
		written.append("settings_overrides")
	if "outputs" in payload:
		doc.set("outputs", [])
		for i, row in enumerate(payload.get("outputs") or [], start=1):
			if not isinstance(row, dict):
				frappe.throw(_("outputs[{0}] must be an object").format(i), WAValidationError)
			bad = sorted(set(row) - set(OUTPUT_COPY_FIELDS))
			if bad:
				frappe.throw(
					_("outputs[{0}]: unknown fields {1}").format(i, ", ".join(bad)), WAValidationError
				)
			doc.append("outputs", {f: row.get(f) for f in OUTPUT_COPY_FIELDS if f in row})
		written.append("outputs")
	if doc.is_new():
		doc.insert()
	else:
		doc.save()
	audit.log(
		"Command Changed",
		reference=("WhatsApp Command", doc.name),
		fields_written=written,
		details={"created": bool(not name)},
		user=user,
	)
	return doc.name


def set_status(name: str, status: str) -> str:
	"""Start / stop a command. E: `WANotFoundError`. Returns the status it now has."""
	doc = get(name)
	if doc.status != status:
		doc.status = status
		doc.save()
	return doc.status


def restore_defaults(name: str, user: str | None = None) -> dict[str, Any]:
	"""Re-copy `outputs` from the Function and clear `settings_overrides`.
	E: `WANotFoundError`, `WAStateConflictError` (Active); audited `Command Defaults Restored`."""
	doc = get(name)
	require_inactive(doc)
	doc.copy_outputs_from_function()
	doc.settings_overrides = None
	doc.defaults_restored_at = now_datetime()
	doc.save()
	audit.log(
		"Command Defaults Restored",
		reference=("WhatsApp Command", doc.name),
		fields_written=("outputs", "settings_overrides", "defaults_restored_at"),
		user=user,
	)
	return {
		"outputs": [{f: row.get(f) for f in OUTPUT_COPY_FIELDS} for row in doc.get("outputs") or []],
		"settings_overrides": {},
	}

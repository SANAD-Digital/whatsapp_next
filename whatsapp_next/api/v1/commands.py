# Module role: API of the Commands screen (backend-plan §4.10, screen 8): list with function status
# and 30-day run counts, defaults from the installed Function, save with an allow-listed payload,
# start / stop, restore defaults and a dry-run test through `command_router.dry_run` (nothing
# persisted, nothing sent). The controller enforces word uniqueness, override keys and the Active
# edit lock; this module only maps arguments and audits.

from __future__ import annotations

import json
from typing import Any

import frappe
from frappe import _
from frappe.utils import cint, now_datetime

from whatsapp_next.api._common import api_endpoint, paginate
from whatsapp_next.api.v1 import _bulk
from whatsapp_next.api.v1._roles import MANAGER, VIEWER_UP
from whatsapp_next.exceptions import WANotFoundError, WAStateConflictError, WAValidationError
from whatsapp_next.services import audit, command_router
from whatsapp_next.whatsapp_next.doctype.whatsapp_command.whatsapp_command import OUTPUT_COPY_FIELDS

STATUS_SCHEMA = {"status": {"enum": ["Active", "Inactive"]}}
LIST_FIELDS: tuple[str, ...] = (
	"name",
	"code",
	"title",
	"function",
	"status",
	"synonyms",
	"requires_linked_contact",
	"allowed_group",
	"blocked_group",
	"reply_device",
	"description",
	"run_count",
	"last_run_at",
	"defaults_restored_at",
	"modified",
)
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


def _command(name: str):
	if not frappe.db.exists("WhatsApp Command", name):
		frappe.throw(_("Command {0} not found").format(name), WANotFoundError)
	return frappe.get_doc("WhatsApp Command", name)


def _require_inactive(doc) -> None:
	if doc.status == "Active":
		frappe.throw(
			_("Command {0} is Active; deactivate it before editing").format(doc.name), WAStateConflictError
		)


@api_endpoint(roles=VIEWER_UP, methods=("GET", "POST"))
def list_commands(filters: dict | None = None, page: int = 1, page_length: int = 20) -> dict[str, Any]:
	"""Command rows (+ `function_status`, `function_name`, 30-day `run_count_30d`) filtered by
	`filters{status, function}`. Returns `{rows, total}`. P: Viewer+."""
	allowed = {k: v for k, v in (filters or {}).items() if k in ("status", "function") and v}
	start, length = paginate(page, page_length)
	rows = frappe.get_all(
		"WhatsApp Command",
		filters=allowed,
		fields=list(LIST_FIELDS),
		order_by="code asc",
		start=start,
		page_length=length,
	)
	total = frappe.db.count("WhatsApp Command", allowed)
	function_names = sorted({r.function for r in rows if r.function})
	functions = (
		{
			r.name: r
			for r in frappe.get_all(
				"WhatsApp Function",
				filters={"name": ("in", function_names)},
				fields=["name", "status", "function_name"],
			)
		}
		if function_names
		else {}
	)
	counts = command_router.recent_run_counts([r.name for r in rows], days=30)
	for r in rows:
		fn = functions.get(r.function)
		r["function_status"] = fn.status if fn else None
		r["function_name"] = fn.function_name if fn else None
		r["run_count_30d"] = counts.get(r.name, 0)
	return {"rows": rows, "total": total}


@api_endpoint(roles=MANAGER, methods=("GET", "POST"))
def get_defaults(function: str) -> dict[str, Any]:
	"""`{outputs[], settings[], party_types[], suggested_commands[]}` from the installed Function
	(suggested words come from the catalog manifest snapshot). P: Manager. E: `WANotFoundError`."""
	if not frappe.db.exists("WhatsApp Function", function):
		frappe.throw(_("Function {0} is not installed").format(function), WANotFoundError)
	doc = frappe.get_doc("WhatsApp Function", function)
	try:
		manifest = json.loads(doc.manifest) if doc.manifest else {}
	except ValueError:
		manifest = {}
	return {
		"outputs": [{f: row.get(f) for f in OUTPUT_COPY_FIELDS} for row in doc.get("outputs") or []],
		"settings": [
			{
				"key": row.key,
				"label": row.label,
				"fieldtype": row.fieldtype,
				"choices": row.choices,
				"default_value": row.default_value,
				"value": row.value,
				"notes": row.notes,
			}
			for row in doc.get("settings") or []
		],
		"party_types": [row.party_type for row in doc.get("party_types") or []],
		"suggested_commands": list(manifest.get("suggested_commands") or []),
	}


@api_endpoint(roles=MANAGER)
def save_command(payload: dict) -> dict[str, str]:
	"""Create (`name` absent) or update a command from the allow-listed payload
	`{name?, code, title, function, synonyms, requires_linked_contact, allowed_party_types[],
	allowed_group, blocked_group, reply_device, settings_overrides{}, outputs[], description}`.
	P: Manager. E: `WAStateConflictError` (target Active), `WAValidationError` (unknown key,
	word collision, unknown override key); audited `Command Changed`."""
	if not isinstance(payload, dict):
		frappe.throw(_("payload must be an object"), WAValidationError)
	unknown = sorted(set(payload) - ALLOWED_KEYS)
	if unknown:
		frappe.throw(_("Unknown payload keys: {0}").format(", ".join(unknown)), WAValidationError)
	name = payload.get("name")
	if name:
		doc = _command(name)
		_require_inactive(doc)
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
	)
	return {"name": doc.name}


@api_endpoint(roles=MANAGER, schema=STATUS_SCHEMA)
def set_status(name: str, status: str) -> dict[str, str]:
	"""Start / stop a command. P: Manager. E: `WANotFoundError`."""
	doc = _command(name)
	if doc.status != status:
		doc.status = status
		doc.save()
	return {"status": doc.status}


@api_endpoint(roles=MANAGER)
def restore_defaults(name: str) -> dict[str, Any]:
	"""Re-copy `outputs` from the Function and clear `settings_overrides`. P: Manager.
	E: `WANotFoundError`, `WAStateConflictError` (Active); audited `Command Defaults Restored`."""
	doc = _command(name)
	_require_inactive(doc)
	doc.copy_outputs_from_function()
	doc.settings_overrides = None
	doc.defaults_restored_at = now_datetime()
	doc.save()
	audit.log(
		"Command Defaults Restored",
		reference=("WhatsApp Command", doc.name),
		fields_written=("outputs", "settings_overrides", "defaults_restored_at"),
	)
	return {
		"outputs": [{f: row.get(f) for f in OUTPUT_COPY_FIELDS} for row in doc.get("outputs") or []],
		"settings_overrides": {},
	}


@api_endpoint(roles=MANAGER)
def test_command(text: str, sender_phone: str, device: str | None = None) -> dict[str, Any]:
	"""Dry-run `text` from `sender_phone`: `{matched, status, command, block_reason, args,
	reply_body, replies[], error, function_ms}` — nothing persisted, nothing sent. P: Manager.
	E: `WAInvalidPhoneError`."""
	result = command_router.dry_run(text, sender_phone, device)
	return {
		"matched": result.status not in ("None", "Not Matched"),
		"status": result.status,
		"command": result.command,
		"block_reason": result.block_reason,
		"args": result.args,
		"reply_body": next((r.get("body") for r in result.replies if r.get("body")), None),
		"replies": result.replies,
		"error": result.error,
		"function_ms": result.elapsed_ms,
	}


@api_endpoint(roles=MANAGER, schema=STATUS_SCHEMA)
def set_status_many(names: list[str], status: str) -> dict[str, Any]:
	"""Bulk start / stop; rows already in `status` are `skipped`. P: Manager."""

	def one(name: str) -> None:
		doc = _command(name)
		if doc.status == status:
			raise _bulk.Skip(f"already {status}")
		doc.status = status
		doc.save()

	return _bulk.run_bulk(names, one)

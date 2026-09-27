# Module role: API of the Commands screen (backend-plan §4.10, screen 8): list with function status
# and 30-day run counts, defaults from the installed Function, save with an allow-listed payload,
# start / stop, restore defaults and a dry-run test through `command_router.dry_run` (nothing
# persisted, nothing sent). Writes live in `services/commands.py` (A-2); this module checks the
# role, maps arguments and shapes the reads.

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
from whatsapp_next.services import command_router, commands, permissions
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
	"""Create or update a command (`services.commands.save`). P: Manager."""
	return {"name": commands.save(payload, user=frappe.session.user)}


@api_endpoint(roles=MANAGER, schema=STATUS_SCHEMA)
def set_status(name: str, status: str) -> dict[str, str]:
	"""Start / stop a command. P: Manager. E: `WANotFoundError`."""
	return {"status": commands.set_status(name, status)}


@api_endpoint(roles=MANAGER)
def restore_defaults(name: str) -> dict[str, Any]:
	"""Re-copy `outputs` from the Function and clear `settings_overrides`
	(`services.commands.restore_defaults`). P: Manager."""
	return commands.restore_defaults(name, user=frappe.session.user)


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
		if commands.get(name).status == status:
			raise _bulk.Skip(f"already {status}")
		commands.set_status(name, status)

	return _bulk.run_bulk(names, one)


# ---- the command editor (D-132) --------------------------------------------------------------


@api_endpoint(roles=MANAGER, methods=("GET", "POST"))
def get_editor(name: str | None = None) -> dict[str, Any]:
	"""The editor's opening read (`services.commands.editor`). P: Manager. E: `WANotFoundError`."""
	return commands.editor(name or None)


@api_endpoint(roles=MANAGER, methods=("GET", "POST"))
def get_function_spec(function: str) -> dict[str, Any]:
	"""Inputs, settings, outputs and suggested words of one installed Function. P: Manager."""
	return commands.function_spec(function)


@api_endpoint(roles=MANAGER)
def save_editor(payload: dict) -> dict[str, str]:
	"""Save from the editor, status included (`services.commands.save_editor`). P: Manager."""
	return commands.save_editor(payload, user=frappe.session.user)


@api_endpoint(roles=MANAGER)
def preview_command(payload: dict, sender: dict | None = None, values: dict | None = None) -> dict[str, Any]:
	"""Dry-run the editor's draft for an assumed sender — nothing saved, nothing sent
	(`services.commands.preview`). P: Manager."""
	return commands.preview(payload, sender=sender, values=values)


@api_endpoint(roles=MANAGER)
def delete_command(name: str) -> dict[str, bool]:
	"""Delete a command without run history (`services.commands.delete`). P: Manager."""
	commands.delete(name, user=frappe.session.user)
	return {"deleted": True}


@api_endpoint(roles=MANAGER, methods=("GET", "POST"))
def search_groups(txt: str | None = None) -> list[dict[str, Any]]:
	"""Enabled contact groups for the editor's lists: `[{name, label, member_count}]`. P: Manager."""
	filters: dict[str, Any] = {"disabled": 0}
	if txt:
		filters["group_name"] = ("like", f"%{txt}%")
	rows = frappe.get_all(
		"WhatsApp Contact Group",
		filters=filters,
		fields=["name", "group_name", "member_count"],
		order_by="group_name asc",
		limit=20,
	)
	return [
		{"name": r.name, "label": r.group_name or r.name, "member_count": cint(r.member_count)} for r in rows
	]


@api_endpoint(roles=MANAGER, methods=("GET", "POST"))
def search_contacts(txt: str | None = None, party_type: str | None = None) -> list[dict[str, Any]]:
	"""Contacts for the editor's lists and preview sender, through the contextual permission layer
	(`permissions.list_contacts`, audited): `[{name, label, phone, links[{link_doctype, link_name,
	link_title}]}]`, filtered to contacts linked to a `party_type` when given. P: Manager and
	Contact User | Contact read."""
	permissions.require("read")
	link_doctype = party_type if party_type in permissions.PARTY_TYPES else None
	page = permissions.list_contacts(search=txt or None, link_doctype=link_doctype, page_length=20)
	out = []
	for r in page["rows"]:
		phones = r.get("phone_nos") or []
		phone = next((p.get("wa_phone_e164") for p in phones if p.get("wa_phone_e164")), None)
		out.append(
			{
				"name": r["name"],
				"label": r.get("full_name") or r["name"],
				"phone": phone or next((p.get("phone") for p in phones if p.get("phone")), None),
				"links": r.get("links") or [],
			}
		)
	return out

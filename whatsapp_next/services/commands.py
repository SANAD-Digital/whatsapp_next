# Module role: the write paths of the Commands screen (backend-plan §4.10, A-2 of the phase-8
# report): save from an allow-listed payload, start / stop, restore defaults, delete, plus the
# command editor's reads (`editor`, `function_spec`) and its draft preview (D-132). The controller
# enforces word uniqueness, override keys, the per-type lists and the Active edit lock; this module
# maps the payload onto the document and audits. `api/v1/commands.py` only checks the role and
# calls in here.

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
TABLE_KEYS: tuple[str, ...] = (
	"allowed_party_types",
	"settings_overrides",
	"outputs",
	"disabled_inputs",
	"access",
)
ALLOWED_KEYS: frozenset[str] = frozenset({"name", *SCALAR_KEYS, *TABLE_KEYS})
EDITOR_KEYS: frozenset[str] = frozenset({*ALLOWED_KEYS, "status"})
LIST_MODES: tuple[str, ...] = ("Allow All", "Deny All")


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
	written = _apply(doc, payload)
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


def _apply(doc, payload: dict) -> list[str]:
	"""Map the allow-listed payload onto `doc` (not saved). Returns the keys written."""
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
	if "disabled_inputs" in payload:
		value = payload.get("disabled_inputs") or []
		if isinstance(value, str):
			value = value.splitlines()
		if not isinstance(value, list) or not all(isinstance(v, str) for v in value):
			frappe.throw(_("disabled_inputs must be a list of input keys"), WAValidationError)
		doc.disabled_inputs = "\n".join(v.strip() for v in value if v.strip()) or None
		written.append("disabled_inputs")
	if "access" in payload:
		_apply_access(doc, payload.get("access"))
		written.append("access")
	elif "allowed_party_types" in payload:
		allowed = {r.party_type for r in doc.get("allowed_party_types") or []}
		for table in ("access_modes", "access_entries"):
			doc.set(table, [r for r in doc.get(table) or [] if r.party_type in allowed])
	return written


def _apply_access(doc, access: Any) -> None:
	"""`access{party_type: {mode, groups[], contacts[]}}` → `access_modes` / `access_entries`.
	Types that are not allowed for the command are dropped, as the editor drops them."""
	if access is None:
		access = {}
	if not isinstance(access, dict):
		frappe.throw(_("access must be an object"), WAValidationError)
	allowed = [r.party_type for r in doc.get("allowed_party_types") or []]
	doc.set("access_modes", [])
	doc.set("access_entries", [])
	for party_type, spec in access.items():
		if party_type not in allowed:
			continue
		if not isinstance(spec, dict):
			frappe.throw(_("access[{0}] must be an object").format(party_type), WAValidationError)
		mode = spec.get("mode") or "Allow All"
		if mode not in LIST_MODES:
			frappe.throw(_("Unknown list mode {0}").format(mode), WAValidationError)
		doc.append("access_modes", {"party_type": party_type, "mode": mode})
		for group in spec.get("groups") or []:
			doc.append("access_entries", {"party_type": party_type, "contact_group": str(group)})
		for contact in spec.get("contacts") or []:
			doc.append("access_entries", {"party_type": party_type, "contact": str(contact)})


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


# ---- the command editor (D-132) --------------------------------------------------------------


def save_editor(payload: dict, user: str | None = None) -> dict[str, str]:
	"""The editor's save: the payload plus the `status` its header toggle chose. An Active command is
	stopped, saved and put back to the chosen status in one request, so the edit lock (which guards
	every other write path) never sees a live command change. Returns `{name, status}`."""
	if not isinstance(payload, dict):
		frappe.throw(_("payload must be an object"), WAValidationError)
	unknown = sorted(set(payload) - EDITOR_KEYS)
	if unknown:
		frappe.throw(_("Unknown payload keys: {0}").format(", ".join(unknown)), WAValidationError)
	fields = {k: v for k, v in payload.items() if k != "status"}
	status = payload.get("status")
	if status not in (None, "Active", "Inactive"):
		frappe.throw(_("Unknown status {0}").format(status), WAValidationError)
	name = fields.get("name")
	if name and get(name).status == "Active":
		set_status(name, "Inactive")
		status = status or "Active"
	name = save(fields, user=user)
	if status:
		set_status(name, status)
	return {"name": name, "status": frappe.db.get_value("WhatsApp Command", name, "status")}


def delete(name: str, user: str | None = None) -> None:
	"""Delete a command. A command inbound messages already point at keeps its history: it cannot be
	deleted, only stopped. E: `WANotFoundError`, `WAStateConflictError`; audited `Command Deleted`."""
	doc = get(name)
	if frappe.db.exists("WhatsApp Inbound Message", {"command": name}):
		frappe.throw(
			_("Command {0} has run history; stop it instead of deleting it").format(name),
			WAStateConflictError,
		)
	audit.log(
		"Command Deleted",
		reference=("WhatsApp Command", doc.name),
		details={"code": doc.code, "function": doc.function},
		user=user,
	)
	frappe.delete_doc("WhatsApp Command", name)


def _manifest(function_doc) -> dict[str, Any]:
	raw = function_doc.manifest
	if isinstance(raw, dict):
		return raw
	try:
		return json.loads(raw) if raw else {}
	except ValueError:
		return {}


def function_spec(function: str) -> dict[str, Any]:
	"""What the editor shows for one installed Function: `{name, function_name, category, status,
	when_to_use, example, inputs[], settings[], outputs[], party_types[], suggested_commands[]}`.
	E: `WANotFoundError`."""
	if not frappe.db.exists("WhatsApp Function", function):
		frappe.throw(_("Function {0} is not installed").format(function), WANotFoundError)
	doc = frappe.get_doc("WhatsApp Function", function)
	manifest = _manifest(doc)
	inputs = sorted(
		(i for i in manifest.get("inputs") or [] if isinstance(i, dict) and i.get("key")),
		key=lambda i: cint(i.get("position")) or 99,
	)
	return {
		"name": doc.name,
		"function_name": doc.function_name or doc.name,
		"category": doc.category,
		"status": doc.status,
		"when_to_use": doc.when_to_use,
		"example": manifest.get("example"),
		"inputs": [
			{
				"key": i["key"],
				"label": i.get("label") or i["key"],
				"type": i.get("type") or "str",
				"required": bool(i.get("required")),
				"rest": bool(i.get("rest")),
				"options": i.get("options"),
				"details": i.get("details") or i.get("description"),
				"example": i.get("example"),
			}
			for i in inputs
		],
		"settings": [
			{
				"key": row.key,
				"label": row.label or row.key,
				"fieldtype": row.fieldtype,
				"choices": [c for c in (row.choices or "").splitlines() if c.strip()],
				"default_value": row.value if row.value not in (None, "") else row.default_value,
				"notes": row.notes,
			}
			for row in doc.get("settings") or []
		],
		"outputs": [{f: row.get(f) for f in OUTPUT_COPY_FIELDS} for row in doc.get("outputs") or []],
		"party_types": [row.party_type for row in doc.get("party_types") or []],
		"suggested_commands": list(manifest.get("suggested_commands") or []),
	}


def _contact_labels(names: list[str]) -> dict[str, dict[str, Any]]:
	if not names:
		return {}
	rows = frappe.get_all(
		"Contact", filters={"name": ("in", names)}, fields=["name", "full_name", "mobile_no", "phone"]
	)
	return {r.name: {"label": r.full_name or r.name, "phone": r.mobile_no or r.phone} for r in rows}


def _group_labels(names: list[str]) -> dict[str, str]:
	if not names:
		return {}
	rows = frappe.get_all(
		"WhatsApp Contact Group", filters={"name": ("in", names)}, fields=["name", "group_name"]
	)
	return {r.name: r.group_name or r.name for r in rows}


def _access(doc) -> dict[str, Any]:
	"""`{party_type: {mode, groups[{name,label}], contacts[{name,label,phone}]}}` for the editor."""
	entries = doc.get("access_entries") or []
	groups = _group_labels([r.contact_group for r in entries if r.contact_group])
	contacts = _contact_labels([r.contact for r in entries if r.contact])
	out: dict[str, Any] = {}
	for row in doc.get("allowed_party_types") or []:
		out[row.party_type] = {"mode": "Allow All", "groups": [], "contacts": []}
	for row in doc.get("access_modes") or []:
		out.setdefault(row.party_type, {"groups": [], "contacts": []})["mode"] = row.mode or "Allow All"
	for row in entries:
		spec = out.setdefault(row.party_type, {"mode": "Allow All", "groups": [], "contacts": []})
		if row.contact_group:
			spec["groups"].append(
				{"name": row.contact_group, "label": groups.get(row.contact_group, row.contact_group)}
			)
		elif row.contact:
			info = contacts.get(row.contact, {})
			spec["contacts"].append(
				{"name": row.contact, "label": info.get("label", row.contact), "phone": info.get("phone")}
			)
	return out


def _overrides(doc) -> dict[str, Any]:
	value = doc.settings_overrides
	if isinstance(value, dict):
		return value
	try:
		return json.loads(value) if value else {}
	except ValueError:
		return {}


def editor(name: str | None = None) -> dict[str, Any]:
	"""Everything the editor opens with: `{command, functions[], party_types[], function}` — the
	command (empty for a new one), the installed functions to pick from, the allowed party types and
	the picked function's spec. E: `WANotFoundError`."""
	from whatsapp_next.services.command_router import recent_run_counts
	from whatsapp_next.whatsapp_next.doctype.whatsapp_function.whatsapp_function import ALLOWED_PARTY_TYPES

	command: dict[str, Any] = {
		"name": None,
		"code": "",
		"title": "",
		"function": None,
		"status": "Inactive",
		"synonyms": [],
		"requires_linked_contact": 0,
		"allowed_party_types": [],
		"disabled_inputs": [],
		"settings_overrides": {},
		"outputs": [],
		"access": {},
		"runs_30d": 0,
		"has_history": False,
	}
	if name:
		doc = get(name)
		command.update(
			{
				"name": doc.name,
				"code": doc.code,
				"title": doc.title,
				"function": doc.function,
				"status": doc.status,
				"synonyms": doc.synonym_list(),
				"requires_linked_contact": cint(doc.requires_linked_contact),
				"allowed_party_types": [r.party_type for r in doc.get("allowed_party_types") or []],
				"disabled_inputs": [k for k in (doc.disabled_inputs or "").splitlines() if k.strip()],
				"settings_overrides": _overrides(doc),
				"outputs": [{f: row.get(f) for f in OUTPUT_COPY_FIELDS} for row in doc.get("outputs") or []],
				"access": _access(doc),
				"runs_30d": recent_run_counts([doc.name], days=30).get(doc.name, 0),
				"has_history": bool(frappe.db.exists("WhatsApp Inbound Message", {"command": doc.name})),
			}
		)
	functions = frappe.get_all(
		"WhatsApp Function",
		fields=["name", "function_name", "category", "status"],
		order_by="function_name asc",
	)
	return {
		"command": command,
		"functions": functions,
		"party_types": [{"key": pt, "label": _(pt)} for pt in ALLOWED_PARTY_TYPES],
		"function": function_spec(command["function"]) if command["function"] else None,
	}


def _draft(payload: dict):
	"""An unsaved command built from the editor payload (never inserted)."""
	unknown = sorted(set(payload) - EDITOR_KEYS)
	if unknown:
		frappe.throw(_("Unknown payload keys: {0}").format(", ".join(unknown)), WAValidationError)
	doc = frappe.new_doc("WhatsApp Command")
	fields = {k: v for k, v in payload.items() if k not in ("name", "status")}
	_apply(doc, fields)
	if not fields.get("outputs") and doc.function:
		doc.copy_outputs_from_function()
	doc.name = payload.get("name") or _("(unsaved command)")
	doc.code = (doc.code or "").strip().casefold()
	return doc


def preview(payload: dict, sender: dict | None = None, values: dict | None = None) -> dict[str, Any]:
	"""Run the editor's draft — saved or not — for one assumed sender, the way the router would, with
	`dry_run`: nothing is saved, nothing is sent. `sender{contact, party_type, party_name, phone}`,
	`values{input key → text}`. Returns `{text, status, block_reason, reply_sent, args, missing[],
	replies[], error}`; `reply_sent` says whether a live route would actually send the block reply."""
	if not isinstance(payload, dict):
		frappe.throw(_("payload must be an object"), WAValidationError)
	doc = _draft(payload)
	if not doc.function:
		frappe.throw(_("Pick a function first"), WAValidationError)
	# the preview reports refusals and errors in its result; a message a failed step queued
	# (`frappe.throw` in argument parsing or in the handler) must not also pop up in the desk
	queued = len(frappe.local.message_log or [])
	try:
		return _preview(doc, sender, values)
	finally:
		if frappe.local.message_log:
			del frappe.local.message_log[queued:]


def _preview(doc, sender: dict | None, values: dict | None) -> dict[str, Any]:
	"""`preview` after the payload checks: access, arguments, handler, outputs — all dry."""
	from whatsapp_next.functions.context import Sender
	from whatsapp_next.services import command_router
	from whatsapp_next.services.phone import classify

	sender = sender if isinstance(sender, dict) else {}
	values = values if isinstance(values, dict) else {}
	contact = sender.get("contact") or None
	if contact and not frappe.db.exists("Contact", contact):
		frappe.throw(_("Contact {0} not found").format(contact), WANotFoundError)
	phone = sender.get("phone") or None
	if phone:
		kind, key = classify(phone)
		phone = key if kind == "Individual" else None
	party_type = sender.get("party_type") or None
	party_name = sender.get("party_name") or None
	who = Sender(
		phone_e164=phone,
		jid=None,
		display_name=sender.get("label") or _("Preview"),
		contact=contact,
		party_type=party_type if contact else None,
		party_name=party_name if contact else None,
	)
	spec = function_spec(doc.function)
	off = command_router.disabled_inputs(doc)
	parts = [doc.code]
	for item in spec["inputs"]:
		raw = str(values.get(item["key"]) or "").strip()
		if item["key"] in off or not raw:
			continue
		parts.append(raw if item["rest"] or " " not in raw else json.dumps(raw, ensure_ascii=False))
	text = " ".join(p for p in parts if p)
	missing = [
		{"key": i["key"], "label": i["label"]}
		for i in spec["inputs"]
		if i["required"] and i["key"] not in off and not str(values.get(i["key"]) or "").strip()
	]
	inbound = frappe._dict(
		name=None,
		device=frappe.get_cached_doc("WhatsApp Settings").default_device,
		phone_e164=phone,
		contact=contact,
		display_name=who.display_name,
		message_type="Text",
		body=text,
		is_group=0,
	)
	out: dict[str, Any] = {
		"text": text,
		"status": None,
		"block_reason": None,
		"reply_sent": True,
		"args": {},
		"missing": missing,
		"replies": [],
		"error": None,
	}
	reason = command_router.check_access(doc, inbound, who)
	if reason:
		out.update(
			status="Blocked",
			block_reason=reason,
			reply_sent=bool(cint(frappe.get_cached_doc("WhatsApp Settings").send_receipt_reply)),
			replies=[
				{"message_type": "Text", "body": _("You cannot use this command ({0})").format(_(reason))}
			],
		)
		return out
	try:
		args = command_router.parse_args(doc, text[len(doc.code) :])
	except WAValidationError as exc:
		out.update(status="Failed", error=str(exc), replies=[{"message_type": "Text", "body": str(exc)}])
		return out
	result = command_router.execute(doc, inbound, args, sender=who, dry_run=True)
	out.update(
		status="Failed" if result.error else "Executed",
		args=args,
		error=result.error,
		replies=command_router.render_outputs(doc, result, who, dry_run=True),
	)
	return out

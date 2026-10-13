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
from whatsapp_next.services import function_header as fh

TEMPLATE_FIELDS: tuple[str, ...] = ("param", "language", "text")

# Payload keys accepted by `save_command` (backend-plan §4.10) — never a client fieldname beyond these.
SCALAR_KEYS: tuple[str, ...] = (
	"code",
	"title",
	"function",
	"synonyms",
	"requires_linked_contact",
	"allowed_group",
	"blocked_group",
	"description",
	# inputs asked for over WhatsApp when missing (services/command_sessions), one per line
	"ask_inputs",
)
TABLE_KEYS: tuple[str, ...] = (
	"allowed_party_types",
	"settings_overrides",
	"templates",
	"disabled_inputs",
	"disabled_replies",
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
	allowed_group, blocked_group, settings_overrides{}, templates[{param, language, text}],
	disabled_inputs[], disabled_replies[], ask_inputs, access{}, description}`.
	E: `WAStateConflictError` (target Active), `WAValidationError` (unknown key, word collision,
	a name not in the function's header); audited `Command Changed`. Returns the command's name."""
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
	if "templates" in payload:
		doc.set("templates", [])
		for i, row in enumerate(payload.get("templates") or [], start=1):
			if not isinstance(row, dict):
				frappe.throw(_("templates[{0}] must be an object").format(i), WAValidationError)
			bad = sorted(set(row) - set(TEMPLATE_FIELDS))
			if bad:
				frappe.throw(_("templates[{0}]: unknown fields {1}").format(i, ", ".join(bad)), WAValidationError)
			if not str(row.get("text") or "").strip():
				continue  # an emptied text falls back to the function's
			doc.append("templates", {f: row.get(f) or None for f in TEMPLATE_FIELDS})
		written.append("templates")
	for key in ("disabled_inputs", "disabled_replies"):
		if key in payload:
			value = payload.get(key) or []
			if isinstance(value, str):
				value = value.splitlines()
			if not isinstance(value, list) or not all(isinstance(v, str) for v in value):
				frappe.throw(_("{0} must be a list of names").format(key), WAValidationError)
			doc.set(key, "\n".join(v.strip() for v in value if v.strip()) or None)
			written.append(key)
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
	"""Drop the command's own message texts and parameter values, so it uses the function's again.
	E: `WANotFoundError`, `WAStateConflictError` (Active); audited `Command Defaults Restored`."""
	doc = get(name)
	require_inactive(doc)
	doc.set("templates", [])
	doc.settings_overrides = None
	doc.defaults_restored_at = now_datetime()
	doc.save()
	audit.log(
		"Command Defaults Restored",
		reference=("WhatsApp Command", doc.name),
		fields_written=("templates", "settings_overrides", "defaults_restored_at"),
		user=user,
	)
	return {"templates": [], "settings_overrides": {}}


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


def function_spec(function: str) -> dict[str, Any]:
	"""What the editor shows for one installed function, from its header: `{name, function_name,
	description, status, version, server_script, available, reasons, party_types{mode, types},
	party_types_text, inputs[], settings[], templates[], replies[]}`. `inputs` are the values a sender
	may write; `settings` the other parameters (with the site's value as `default_value`);
	`templates` the message texts (with their per-language defaults, the site's text and the values
	they may use). E: `WANotFoundError`."""
	from whatsapp_next.services import functions_catalog
	from whatsapp_next.services.command_router import _as_input

	if not frappe.db.exists("WhatsApp Function", function):
		frappe.throw(_("Function {0} is not installed").format(function), WANotFoundError)
	doc = frappe.get_doc("WhatsApp Function", function)
	spec = functions_catalog.manifest_of(doc)
	site = functions_catalog.values_of(doc)
	available, reasons = fh.function_availability(spec)
	typed = fh.typed_params(spec)
	return {
		"name": doc.name,
		"function_name": doc.function_name or doc.name,
		"description": doc.description,
		"status": doc.status,
		"version": doc.installed_version,
		"server_script": doc.server_script,
		"available": available,
		"reasons": reasons,
		"party_types": spec.get("party_types") or {"mode": "all", "types": []},
		"party_types_text": fh.party_types_text(spec),
		"inputs": [_as_input(p, n) for n, p in enumerate(typed, start=1)],
		"settings": [
			{
				"key": p["name"],
				"label": p["label"] or p["name"],
				"fieldtype": p["fieldtype"],
				"options": p["options"],
				"choices": list(p["select_options"] or []),
				"required": p["required"],
				"depends_on": p["depends_on"],
				"header_default": p["default"],
				"default_value": site.get(p["name"]) if not fh.is_empty(site.get(p["name"])) else p["default"],
			}
			for p in typed
		],
		"templates": [
			{
				"key": p["name"],
				"label": p["label"] or p["name"],
				"default": p["default"],
				"defaults_by_lang": p["defaults_by_lang"],
				"site": site.get(p["name"]),
				"vars": fh.vars_for(spec, p["name"]),
			}
			for p in fh.command_params(spec)
			if p["fieldtype"] == "Template"
		],
		"replies": spec.get("replies") or [],
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
		"allowed_group": None,
		"blocked_group": None,
		"disabled_inputs": [],
		"ask_inputs": "",
		"settings_overrides": {},
		"templates": [],
		"disabled_replies": [],
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
				"allowed_group": doc.allowed_group,
				"blocked_group": doc.blocked_group,
				"disabled_inputs": [k for k in (doc.disabled_inputs or "").splitlines() if k.strip()],
				"ask_inputs": doc.ask_inputs or "",
				"settings_overrides": _overrides(doc),
				"templates": [{f: row.get(f) for f in TEMPLATE_FIELDS} for row in doc.get("templates") or []],
				"disabled_replies": [k for k in (doc.disabled_replies or "").splitlines() if k.strip()],
				"access": _access(doc),
				"runs_30d": recent_run_counts([doc.name], days=30).get(doc.name, 0),
				"has_history": bool(frappe.db.exists("WhatsApp Inbound Message", {"command": doc.name})),
			}
		)
	functions = frappe.get_all(
		"WhatsApp Function",
		fields=["name", "function_name", "server_script", "status"],
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
	from whatsapp_next.services.command_router import in_reply_language

	try:
		# written as the sender will get it, in the reply language, not the editor's
		with in_reply_language():
			return _preview(doc, sender, values)
	finally:
		if frappe.local.message_log:
			del frappe.local.message_log[queued:]


def _preview_party(
	doc, contact: str | None, party_type: str | None, party_name: str | None
) -> tuple[str | None, str | None]:
	"""The account the preview runs "as": never taken on the client's word — it must be one of the
	contact's own party links (else `WAValidationError`), and without one it is the account the
	router itself would pick for a message from that contact (`command_router.sender_for`)."""
	from whatsapp_next.services import command_router

	if not contact:
		return None, None
	if party_type or party_name:
		linked = party_type in command_router.PARTY_TYPES and frappe.db.exists(
			"Dynamic Link",
			{"parenttype": "Contact", "parent": contact, "link_doctype": party_type, "link_name": party_name},
		)
		if not linked:
			frappe.throw(
				_("{0} {1} is not linked to contact {2}").format(_(party_type or ""), party_name or "", contact),
				WAValidationError,
			)
		return party_type, party_name
	who = command_router.sender_for({"contact": contact}, command_router.allowed_party_types(doc))
	return who.party_type, who.party_name


def _preview(doc, sender: dict | None, values: dict | None) -> dict[str, Any]:
	"""`preview` after the payload checks: access, arguments, handler, outputs — all dry."""
	from whatsapp_next.services import command_router, function_runner
	from whatsapp_next.services.function_runner import Sender
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
	party_type, party_name = _preview_party(doc, contact, sender.get("party_type"), sender.get("party_name"))
	who = Sender(
		phone_e164=phone,
		jid=None,
		display_name=sender.get("label") or _("Preview"),
		contact=contact,
		party_type=party_type,
		party_name=party_name,
	)
	inputs = command_router.command_inputs(doc)
	parts = [doc.code]
	for item in inputs:
		raw = str(values.get(item["key"]) or "").strip()
		if not raw:
			continue
		parts.append(raw if item.get("rest") or " " not in raw else json.dumps(raw, ensure_ascii=False))
	text = " ".join(p for p in parts if p)
	missing = [
		{"key": i["key"], "label": i["label"]}
		for i in inputs
		if i["required"] and not str(values.get(i["key"]) or "").strip()
	]
	inbound = frappe._dict(
		name=None,
		device=_default_device(),
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
				{"message_type": "Text", "body": command_router.block_message(doc, reason, who)}
			],
		)
		return out
	try:
		given = command_router.parse_args(doc, text[len(doc.code) :])
		args, absent = function_runner.prepare(doc, who, given)
	except (WAValidationError, ValueError) as exc:
		out.update(status="Failed", error=str(exc), replies=[{"message_type": "Text", "body": str(exc)}])
		return out
	if any(m["source"] == "sender" for m in absent):
		out.update(status="Blocked", block_reason="Not Linked", replies=[])
		return out
	if absent:
		error = _("{0} is required").format(", ".join(_(m["label"]) for m in absent))
		out.update(status="Failed", error=error, args=args, replies=[{"message_type": "Text", "body": error}])
		return out
	result = command_router.execute(doc, inbound, args, sender=who, dry_run=True)
	out.update(
		status="Failed" if result.error else "Executed",
		args=args,
		error=result.error,
		replies=command_router.render_outputs(doc, result, who, dry_run=True),
	)
	return out


def _default_device() -> str | None:
	"""The default sending device (`services.devices.default_device`)."""
	from whatsapp_next.services.devices import default_device

	return default_device()

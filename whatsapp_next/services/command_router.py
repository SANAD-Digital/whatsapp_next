# Module role: inbound command routing (D-012, backend-plan §7.3 steps 4–11). Matches the first
# token of an inbound text against the cached command map, checks access in a fixed order,
# parses typed arguments from the function manifest, runs the registered handler **as the command
# service user** (restored in `finally`), renders the command's outputs and hands them to the
# dispatcher at priority 1. The **status writer** for `WhatsApp Inbound Message.command_status`.
# Never `frappe.get_attr` on data; never runs a live route inside a web request.

from __future__ import annotations

import json
import re
import shlex
import time
from dataclasses import dataclass, field
from typing import Any

import frappe
from frappe import _
from frappe.utils import cint, getdate, now_datetime

from whatsapp_next.exceptions import WAStateConflictError, WAValidationError
from whatsapp_next.functions import registry
from whatsapp_next.functions.context import FunctionContext, FunctionResult, Sender
from whatsapp_next.services import attachments, dispatch, templates
from whatsapp_next.services.dispatch import OutboundSpec
from whatsapp_next.services.guards import status_writer
from whatsapp_next.services.permissions import PARTY_TYPES

MAP_CACHE_KEY = "wa:commands:map"
HELP_TOKENS = ("*", "?", "help", "مساعدة")
COMMAND_PREFIXES = ("#", "/", "!")
BLOCK_REASONS = (
	"Blacklist",
	"Not Allowed",
	"Party Type",
	"Not Linked",
	"Commands Disabled",
	"Function Inactive",
)
_ARG_RE = re.compile(r"^#?([A-Za-z_][\w]*)=(.*)$")


@dataclass(frozen=True)
class Match:
	command: str
	word: str
	rest: str
	is_help: bool = False


@dataclass
class RouteResult:
	inbound: str | None
	status: str  # None | Not Matched | Blocked | Matched | Executed | Failed
	command: str | None = None
	block_reason: str | None = None
	args: dict[str, Any] = field(default_factory=dict)
	data: dict[str, Any] = field(default_factory=dict)
	replies: list[dict[str, Any]] = field(
		default_factory=list
	)  # {output_key, message_type, body, attachment}
	outbound: list[str] = field(default_factory=list)
	error: str | None = None
	elapsed_ms: int = 0


# ---- matching -------------------------------------------------------------------------------


def command_map(*, refresh: bool = False) -> dict[str, str]:
	"""`{word → command name}` for Active commands (code + synonyms), cached until a Command
	is saved (`clear_map`)."""
	cached = None if refresh else frappe.cache.get_value(MAP_CACHE_KEY)
	if cached is not None:
		return cached
	out: dict[str, str] = {}
	for row in frappe.get_all(
		"WhatsApp Command", filters={"status": "Active"}, fields=["name", "code", "synonyms"]
	):
		out[(row.code or "").strip().casefold()] = row.name
		for s in (row.synonyms or "").splitlines():
			if s.strip():
				out[s.strip().casefold()] = row.name
	frappe.cache.set_value(MAP_CACHE_KEY, out)
	return out


def clear_map() -> None:
	frappe.cache.delete_value(MAP_CACHE_KEY)


def match(text: str | None) -> Match | None:
	"""First token (optionally prefixed with `#`, `/`, `!`) against the map; help tokens too."""
	text = (text or "").strip()
	if not text:
		return None
	head, _sep, rest = text.partition(" ")
	word = head.strip().casefold().lstrip("".join(COMMAND_PREFIXES))
	if word in HELP_TOKENS:
		return Match(command="", word=word, rest=rest.strip(), is_help=True)
	command = command_map().get(word)
	if not command:
		return None
	return Match(command=command, word=word, rest=rest.strip())


def help_text(sender_key: str | None = None) -> str:
	"""One line per Active command: `word — title`."""
	rows = frappe.get_all(
		"WhatsApp Command",
		filters={"status": "Active"},
		fields=["code", "title", "description"],
		order_by="code asc",
	)
	if not rows:
		return _("No commands are available")
	return "\n".join(
		f"{r.code} — {r.title or r.code}" + (f": {r.description}" if r.description else "") for r in rows
	)


# ---- access --------------------------------------------------------------------------------


def _member(group: str | None, key: str | None) -> bool:
	if not group or not key:
		return False
	return bool(
		frappe.db.exists(
			"WhatsApp Contact Group Member",
			{"parent": group, "parenttype": "WhatsApp Contact Group", "phone_e164": key},
		)
	)


def allowed_party_types(command) -> list[str]:
	"""The command's allowed party types (empty = no type restriction)."""
	return [r.party_type for r in command.get("allowed_party_types") or [] if r.party_type]


def sender_for(inbound, allowed_types: list[str] | None = None) -> Sender:
	"""Sender facts for access checks and the handler context. The party comes from the linked
	Contact's Dynamic Links: the first one of an `allowed_types` type when given, else the first."""
	get = inbound.get if hasattr(inbound, "get") else lambda k: getattr(inbound, k, None)
	contact = get("contact")
	party_type = party_name = None
	if contact:
		links = frappe.get_all(
			"Dynamic Link",
			filters={"parenttype": "Contact", "parent": contact, "link_doctype": ("in", list(PARTY_TYPES))},
			fields=["link_doctype", "link_name"],
			order_by="idx asc",
		)
		preferred = [link for link in links if link.link_doctype in (allowed_types or ())]
		chosen = (preferred or links or [None])[0]
		if chosen:
			party_type, party_name = chosen.link_doctype, chosen.link_name
	return Sender(
		phone_e164=get("phone_e164"),
		jid=get("sender_jid") or get("jid"),
		display_name=get("display_name"),
		contact=contact,
		party_type=party_type,
		party_name=party_name,
		is_group=bool(cint(get("is_group"))),
	)


def list_mode(command, party_type: str | None) -> str:
	"""`Allow All` (the type's entries are a blacklist) or `Deny All` (a whitelist) — D-132."""
	for row in command.get("access_modes") or []:
		if row.party_type == party_type:
			return row.mode or "Allow All"
	return "Allow All"


def on_list(command, party_type: str | None, contact: str | None, key: str | None) -> bool:
	"""Whether the sender is on `party_type`'s list: the contact itself, or a member of a listed group."""
	for row in command.get("access_entries") or []:
		if row.party_type != party_type:
			continue
		if row.contact and contact and row.contact == contact:
			return True
		if row.contact_group and _member(row.contact_group, key):
			return True
	return False


def check_access(command, inbound, sender: Sender | None = None) -> str | None:
	"""Block reason in the fixed order: commands enabled → text → global blacklist → blocked
	group → allowed group → requires linked contact → party types → the type's black / white
	list (D-132) → function Active/handler. A sender with no party passes the type check when the
	command does not require a linked contact."""
	settings = frappe.get_cached_doc("WhatsApp Settings")
	if not cint(settings.enable_commands):
		return "Commands Disabled"
	get = inbound.get if hasattr(inbound, "get") else lambda k: getattr(inbound, k, None)
	if (get("message_type") or "Text") != "Text":
		return "Not Allowed"
	allowed_types = allowed_party_types(command)
	sender = sender or sender_for(inbound, allowed_types)
	key = sender.phone_e164 or sender.jid
	if _member(settings.global_blacklist_group, key):
		return "Blacklist"
	if _member(command.blocked_group, key):
		return "Blacklist"
	if command.allowed_group and not _member(command.allowed_group, key):
		return "Not Allowed"
	if cint(command.requires_linked_contact) and not sender.contact:
		return "Not Linked"
	if allowed_types and sender.party_type not in allowed_types:
		if sender.party_type or cint(command.requires_linked_contact):
			return "Party Type"
	if sender.party_type:
		listed = on_list(command, sender.party_type, sender.contact, key)
		mode = list_mode(command, sender.party_type)
		if mode == "Deny All" and not listed:
			return "Not Allowed"
		if mode == "Allow All" and listed:
			return "Blacklist"
	fn = frappe.db.get_value("WhatsApp Function", command.function, ["status", "function_key"], as_dict=True)
	if not fn or fn.status != "Active" or not registry.is_registered(fn.function_key):
		return "Function Inactive"
	return None


# ---- arguments -----------------------------------------------------------------------------


def _manifest_inputs(function: str) -> list[dict[str, Any]]:
	raw = frappe.db.get_value("WhatsApp Function", function, "manifest")
	try:
		manifest = json.loads(raw) if raw else {}
	except ValueError:
		manifest = {}
	return [i for i in manifest.get("inputs") or [] if isinstance(i, dict) and i.get("key")]


def _coerce(value: str, kind: str, spec: dict[str, Any]) -> Any:
	kind = (kind or "str").lower()
	if kind == "int":
		if not re.fullmatch(r"-?\d+", value.strip()):
			raise ValueError(_("{0} must be a whole number").format(spec.get("label") or spec["key"]))
		return int(value)
	if kind == "date":
		try:
			return str(getdate(value.strip()))
		except Exception as exc:
			raise ValueError(_("{0} must be a date").format(spec.get("label") or spec["key"])) from exc
	if kind == "link":
		target = spec.get("options")
		if target and not frappe.db.exists(target, value.strip()):
			raise ValueError(_("{0} {1} not found").format(_(target), value.strip()))
		return value.strip()
	return value.strip()


def disabled_inputs(command) -> set[str]:
	"""Input keys the command switched off (`disabled_inputs`, one per line)."""
	return {k.strip() for k in (command.get("disabled_inputs") or "").splitlines() if k.strip()}


def parse_args(command, text: str) -> dict[str, Any]:
	"""Arguments after the command word per manifest `inputs`: `key=value` tokens first, then
	positional order; the input flagged `rest` swallows the remaining text. Typed by
	`type ∈ str|int|date|link`; missing `required` inputs raise `WAValidationError`. Inputs the
	command disabled are not read."""
	declared = _manifest_inputs(command.function)
	if not declared:
		return {"text": text.strip()} if text.strip() else {}
	off = disabled_inputs(command)
	inputs = sorted((i for i in declared if i["key"] not in off), key=lambda i: cint(i.get("position")) or 99)
	try:
		tokens = shlex.split(text) if text.strip() else []
	except ValueError:
		tokens = text.split()
	named: dict[str, str] = {}
	positional: list[str] = []
	for tok in tokens:
		m = _ARG_RE.match(tok)
		if m:
			named[m.group(1).casefold()] = m.group(2)
		else:
			positional.append(tok)
	out: dict[str, Any] = {}
	errors: list[str] = []
	for spec in inputs:
		key = spec["key"]
		raw: str | None = named.get(key.casefold())
		if raw is None and positional:
			if spec.get("rest"):
				raw = " ".join(positional)
				positional = []
			else:
				raw = positional.pop(0)
		if raw is None or raw == "":
			if spec.get("default") not in (None, ""):
				out[key] = spec["default"]
			elif spec.get("required"):
				errors.append(_("{0} is required").format(spec.get("label") or key))
			continue
		try:
			out[key] = _coerce(raw, spec.get("type") or "str", spec)
		except ValueError as exc:
			errors.append(str(exc))
	if errors:
		frappe.throw("; ".join(errors), WAValidationError)
	return out


def settings_for(command) -> dict[str, Any]:
	"""Function setting values merged with the command's `settings_overrides`."""
	rows = frappe.get_all(
		"WhatsApp Function Setting",
		filters={"parent": command.function, "parenttype": "WhatsApp Function"},
		fields=["key", "value", "default_value", "fieldtype"],
	)
	out: dict[str, Any] = {}
	for r in rows:
		v = r.value if r.value not in (None, "") else r.default_value
		out[r.key] = cint(v) if r.fieldtype in ("Check", "Int") and v not in (None, "") else v
	overrides = command.settings_overrides
	if overrides:
		try:
			parsed = json.loads(overrides) if isinstance(overrides, str) else dict(overrides)
		except ValueError:
			parsed = {}
		out.update(parsed)
	return out


# ---- execution -----------------------------------------------------------------------------


def _service_user() -> str:
	settings = frappe.get_cached_doc("WhatsApp Settings")
	user = settings.command_service_user
	if not user or user == "Administrator":
		frappe.throw(_("Command Service User is not configured"), WAStateConflictError)
	row = frappe.db.get_value("User", user, ["enabled"], as_dict=True)
	if not row or not cint(row.enabled):
		frappe.throw(_("Command Service User {0} is disabled").format(user), WAStateConflictError)
	if "System Manager" in frappe.get_roles(user):
		frappe.throw(_("Command Service User must not be a System Manager"), WAStateConflictError)
	return user


def execute(
	command, inbound, args: dict[str, Any], *, sender: Sender | None = None, dry_run: bool = False
) -> FunctionResult:
	"""Run the handler as the service user; the previous session user is always restored."""
	fn = frappe.db.get_value("WhatsApp Function", command.function, ["function_key", "status"], as_dict=True)
	handler = registry.get_handler(fn.function_key) if fn else None
	if not handler:
		return FunctionResult(error=_("Function is inactive"))
	get = inbound.get if hasattr(inbound, "get") else lambda k: getattr(inbound, k, None)
	ctx = FunctionContext(
		function_key=fn.function_key,
		command=command.name,
		args=args,
		settings=settings_for(command),
		sender=sender or sender_for(inbound),
		device=get("device"),
		inbound=get("name"),
		dry_run=dry_run,
	)
	service_user = _service_user()
	previous = frappe.session.user
	# `frappe.set_user` also overwrites the session id and data and the request's form_dict;
	# restoring only the user would end a web request (the editor preview, the dry-run test) with
	# the browser's session replaced by a bogus one, so the caller's next call arrives as Guest.
	saved_sid, saved_data, saved_form = frappe.session.sid, frappe.session.data, frappe.local.form_dict
	started = time.perf_counter()
	try:
		frappe.set_user(service_user)
		result = handler(ctx)
		if not isinstance(result, FunctionResult):
			result = FunctionResult(data=dict(result or {}))
	except Exception as exc:
		frappe.log_error(
			title=f"WhatsApp function {fn.function_key} failed",
			message=f"command={command.name} inbound={get('name')} {type(exc).__name__}",
		)
		result = FunctionResult(error=f"{type(exc).__name__}: {str(exc)[:200]}")
	finally:
		frappe.set_user(previous)
		frappe.session.sid, frappe.session.data, frappe.local.form_dict = saved_sid, saved_data, saved_form
	elapsed = int((time.perf_counter() - started) * 1000)
	_record_metrics(command.function, elapsed, error=result.error)
	return result


def _record_metrics(function: str, elapsed_ms: int, *, error: str | None) -> None:
	row = frappe.db.get_value(
		"WhatsApp Function", function, ["call_count", "avg_ms", "error_count"], as_dict=True
	)
	if not row:
		return
	count = cint(row.call_count) + 1
	avg = int(((cint(row.avg_ms) * cint(row.call_count)) + elapsed_ms) / count)
	values: dict[str, Any] = {"call_count": count, "avg_ms": avg, "last_called_at": now_datetime()}
	if error:
		values.update({"error_count": cint(row.error_count) + 1, "last_error": error[:500]})
	frappe.db.set_value("WhatsApp Function", function, values, update_modified=False)


def _condition_passes(condition: str | None, data: dict[str, Any]) -> bool:
	condition = (condition or "").strip()
	if not condition:
		return True
	try:
		return bool(frappe.safe_eval(condition, None, {"data": frappe._dict(data)}))
	except Exception:
		return False


def render_outputs(
	command, result: FunctionResult, sender: Sender, *, dry_run: bool = False
) -> list[dict[str, Any]]:
	"""Rendered replies for every output row whose condition passes: `Text` → template over
	`data`; `Document` → Print Format PDF (or a handler file) saved as a private File."""
	if result.error:
		return [{"output_key": "error", "message_type": "Text", "body": result.error, "attachment": None}]
	ctx = {"data": frappe._dict(result.data), "sender": sender, "args": {}, "now": now_datetime()}
	replies: list[dict[str, Any]] = []
	for row in command.get("outputs") or []:
		if not _condition_passes(row.condition, result.data):
			continue
		if row.output_type == "Text":
			rendered = templates.render(row.template or row.default_template, ctx)
			if rendered.ok and rendered.text:
				replies.append(
					{
						"output_key": row.output_key,
						"message_type": "Text",
						"body": rendered.text,
						"attachment": None,
					}
				)
			elif not rendered.ok:
				replies.append(
					{
						"output_key": row.output_key,
						"message_type": "Text",
						"body": _("Reply template error: {0}").format(rendered.error),
						"attachment": None,
					}
				)
			continue
		# Document output: handler files first, else a Print Format render of data.doctype/name
		files = list(result.files)
		if not files and result.data.get("doctype") and result.data.get("name"):
			try:
				pdf = attachments.render_print_pdf(
					result.data["doctype"],
					result.data["name"],
					print_format=row.print_format or None,
					file_name=templates.render_text(
						row.file_name_template, ctx, fallback=str(result.data["name"])
					),
				)
				files = [(pdf.file_name, pdf.content, pdf.mime_type)]
			except Exception as exc:
				replies.append(
					{
						"output_key": row.output_key,
						"message_type": "Text",
						"body": _("Could not render the document: {0}").format(str(exc)[:120]),
						"attachment": None,
					}
				)
				continue
		for file_name, content, mime in files:
			if dry_run:
				replies.append(
					{
						"output_key": row.output_key,
						"message_type": "Document",
						"body": None,
						"attachment": None,
						"file_name": file_name,
						"size": len(content),
						"mime_type": mime,
					}
				)
				continue
			url = attachments.save_private_file(content, file_name)
			replies.append(
				{
					"output_key": row.output_key,
					"message_type": "Document",
					"body": None,
					"attachment": url,
					"file_name": file_name,
					"mime_type": mime,
				}
			)
	return replies


# ---- route ---------------------------------------------------------------------------------


def _set_status(inbound_name: str | None, status: str, **values: Any) -> None:
	if not inbound_name:
		return
	with status_writer():
		frappe.db.set_value(
			"WhatsApp Inbound Message",
			inbound_name,
			{"command_status": status, **values},
			update_modified=True,
		)


def _reply_device(command, inbound) -> str | None:
	settings = frappe.get_cached_doc("WhatsApp Settings")
	get = inbound.get if hasattr(inbound, "get") else lambda k: getattr(inbound, k, None)
	return command.reply_device or settings.reply_device or get("device")


def _send_replies(command, inbound, replies: list[dict[str, Any]], *, is_simulated: bool) -> list[str]:
	get = inbound.get if hasattr(inbound, "get") else lambda k: getattr(inbound, k, None)
	names: list[str] = []
	for r in replies:
		spec = OutboundSpec(
			device=_reply_device(command, inbound),
			phone=get("phone_e164"),
			jid=get("chat_jid") if cint(get("is_group")) else None,
			message_type=r["message_type"],
			body=r.get("body"),
			attachment=r.get("attachment"),
			file_name=r.get("file_name"),
			mime_type=r.get("mime_type"),
			source_type="Command Reply",
			command=command.name,
			trigger_inbound=get("name"),
			display_name=get("display_name"),
			contact=get("contact"),
			is_simulated=is_simulated,
			skip_policy=True,
		)
		outbound = dispatch.create_outbound(spec)
		if not is_simulated:
			dispatch.enqueue([outbound], priority=1)
		names.append(outbound)
	return names


def route(
	inbound_name: str | None = None,
	*,
	inbound=None,
	dry_run: bool = False,
	create_simulated_rows: bool = False,
) -> RouteResult:
	"""Steps 4–11 for one inbound. Live routing (`dry_run=False`) only runs in a job; the
	Simulator passes `dry_run=True` with an unsaved `inbound` doc/dict."""
	if not dry_run and getattr(frappe.local, "request", None) is not None and not frappe.flags.in_test:
		frappe.throw(_("Commands are routed by the worker, not in a web request"), WAStateConflictError)
	if inbound is None:
		inbound = frappe.get_doc("WhatsApp Inbound Message", inbound_name)
		inbound_name = inbound.name
	get = inbound.get if hasattr(inbound, "get") else lambda k: getattr(inbound, k, None)
	started = time.perf_counter()
	settings = frappe.get_cached_doc("WhatsApp Settings")
	result = RouteResult(inbound=inbound_name, status="None")
	text = get("body") or ""
	m = match(text)
	if m is None:
		result.status = "Not Matched"
		_set_status(inbound_name, "Not Matched", command_text=text[:140])
		if cint(settings.enable_commands) and settings.unknown_command_reply and not cint(get("is_group")):
			result.replies = [
				{
					"output_key": "unknown",
					"message_type": "Text",
					"body": settings.unknown_command_reply,
					"attachment": None,
				}
			]
		result.elapsed_ms = int((time.perf_counter() - started) * 1000)
		return _finish(result, inbound, dry_run, create_simulated_rows, command=None)
	if m.is_help:
		result.status = "Executed"
		result.replies = [
			{
				"output_key": "help",
				"message_type": "Text",
				"body": help_text(get("phone_e164")),
				"attachment": None,
			}
		]
		_set_status(inbound_name, "Executed", command_text=text[:140])
		return _finish(result, inbound, dry_run, create_simulated_rows, command=None)
	command = frappe.get_cached_doc("WhatsApp Command", m.command)
	result.command = command.name
	sender = sender_for(inbound, allowed_party_types(command))
	reason = check_access(command, inbound, sender)
	if reason:
		result.status, result.block_reason = "Blocked", reason
		_set_status(
			inbound_name, "Blocked", command=command.name, command_text=text[:140], block_reason=reason
		)
		if cint(settings.send_receipt_reply):
			result.replies = [
				{
					"output_key": "blocked",
					"message_type": "Text",
					"body": _("You cannot use this command ({0})").format(_(reason)),
					"attachment": None,
				}
			]
		return _finish(result, inbound, dry_run, create_simulated_rows, command=command)
	try:
		args = parse_args(command, m.rest)
	except WAValidationError as exc:
		result.status, result.error = "Failed", str(exc)
		_set_status(
			inbound_name,
			"Failed",
			command=command.name,
			command_text=text[:140],
			command_error=str(exc)[:500],
		)
		result.replies = [
			{"output_key": "error", "message_type": "Text", "body": str(exc), "attachment": None}
		]
		return _finish(result, inbound, dry_run, create_simulated_rows, command=command)
	result.args = args
	_set_status(
		inbound_name,
		"Matched",
		command=command.name,
		command_text=text[:140],
		command_args=json.dumps(args, ensure_ascii=False, default=str),
	)
	if cint(settings.send_receipt_reply) and settings.receipt_reply and not dry_run:
		_send_replies(
			command,
			inbound,
			[
				{
					"output_key": "receipt",
					"message_type": "Text",
					"body": settings.receipt_reply,
					"attachment": None,
				}
			],
			is_simulated=False,
		)
	fn_result = execute(command, inbound, args, sender=sender, dry_run=dry_run)
	result.data = fn_result.data
	result.replies = render_outputs(command, fn_result, sender, dry_run=dry_run and not create_simulated_rows)
	if fn_result.error:
		result.status, result.error = "Failed", fn_result.error
		_set_status(inbound_name, "Failed", command_error=fn_result.error[:500])
	else:
		result.status = "Executed"
		_set_status(inbound_name, "Executed")
	if not dry_run:
		frappe.db.set_value(
			"WhatsApp Command",
			command.name,
			{
				"run_count": cint(frappe.db.get_value("WhatsApp Command", command.name, "run_count")) + 1,
				"last_run_at": now_datetime(),
			},
			update_modified=False,
		)
	result.elapsed_ms = int((time.perf_counter() - started) * 1000)
	return _finish(result, inbound, dry_run, create_simulated_rows, command=command)


def _finish(
	result: RouteResult, inbound, dry_run: bool, create_simulated_rows: bool, *, command
) -> RouteResult:
	"""Send (or, for the Simulator, optionally persist `is_simulated`) the replies."""
	if not result.replies or (command is None and result.status not in ("Executed", "Not Matched")):
		return result
	if dry_run and not create_simulated_rows:
		return result
	if command is None:
		# help / unknown-command replies use the inbound device only
		command = frappe._dict(name=None, reply_device=None)
	get = inbound.get if hasattr(inbound, "get") else lambda k: getattr(inbound, k, None)
	try:
		result.outbound = _send_replies(command, inbound, result.replies, is_simulated=dry_run)
	except Exception as exc:
		result.error = result.error or f"reply: {str(exc)[:200]}"
		frappe.log_error(
			title="WhatsApp command reply failed", message=f"inbound={get('name')} {type(exc).__name__}"
		)
		return result
	if result.outbound and get("name") and result.status == "Executed":
		with status_writer():
			frappe.db.set_value(
				"WhatsApp Inbound Message",
				get("name"),
				{"reply_outbound": result.outbound[0], "replied_at": now_datetime()},
				update_modified=False,
			)
	return result


# ---- editor helpers (api.v1.commands) ------------------------------------------------------


def dry_run(text: str, sender_phone: str, device: str | None = None) -> RouteResult:
	"""`commands.test_command`: route `text` from `sender_phone` through `route(dry_run=True)`
	on an in-memory inbound — nothing persisted, nothing sent. `device` defaults to the
	Settings default device."""
	from whatsapp_next.exceptions import WAInvalidPhoneError
	from whatsapp_next.services.permissions import resolve_contact_by_phone
	from whatsapp_next.services.phone import classify

	kind, key = classify(sender_phone)
	if not kind:
		frappe.throw(_("Invalid sender number: {0}").format(sender_phone), WAInvalidPhoneError)
	if not (text or "").strip():
		frappe.throw(_("Message text is required"), WAValidationError)
	device = device or frappe.get_cached_doc("WhatsApp Settings").default_device
	inbound = frappe._dict(
		name=None,
		doctype="WhatsApp Inbound Message",
		device=device,
		phone=key if kind == "Individual" else None,
		phone_e164=key if kind == "Individual" else None,
		jid=key if kind != "Individual" else None,
		chat_jid=key if kind == "Group" else None,
		sender_jid=key if kind != "Individual" else None,
		is_group=1 if kind == "Group" else 0,
		contact=resolve_contact_by_phone(key) if kind == "Individual" else None,
		display_name=_("Simulator"),
		message_type="Text",
		body=text,
		received_at=now_datetime(),
		command_status="None",
		is_simulated=1,
	)
	return route(None, inbound=inbound, dry_run=True)


def recent_run_counts(commands: list[str], days: int = 30) -> dict[str, int]:
	"""`{command → inbound messages that matched it in the last `days` days}` (by `received_at`)."""
	if not commands:
		return {}
	from frappe.utils import add_days

	rows = frappe.get_all(
		"WhatsApp Inbound Message",
		filters={
			"command": ("in", list(commands)),
			"received_at": (">=", add_days(now_datetime(), -abs(cint(days)))),
		},
		fields=["command", {"COUNT": "name", "as": "run_count"}],
		group_by="command",
	)
	return {r.command: cint(r.run_count) for r in rows}

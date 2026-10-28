# Module role: inbound command routing (D-012, backend-plan §7.3 steps 4–11, WHATSAPP_NEXT_INTEGRATION
# §5). Matches the first token of an inbound text against the cached command map, checks access in a
# fixed order (the function's `@requires` and `@party_types` included), reads typed values from the
# text by the function's header parameters, merges and fills them (`function_runner.prepare`), asks
# for what is still missing, runs the function's Server Script **as the command service user**
# (restored in `finally`), checks its messages against `@reply` and hands the replies to the
# dispatcher at priority 1. The **status writer** for `WhatsApp Inbound Message.command_status`.
# Never `frappe.get_attr` on data; never runs a live route inside a web request.

from __future__ import annotations

import json
import re
import shlex
import time
from contextlib import contextmanager
from dataclasses import dataclass, field, replace
from typing import Any

import frappe
from frappe import _
from frappe.utils import cint, cstr, getdate, now_datetime, nowdate

from whatsapp_next.exceptions import WAStateConflictError, WAValidationError
from whatsapp_next.services import command_menu, dispatch, function_runner
from whatsapp_next.services import function_header as fh
from whatsapp_next.services.devices import default_device
from whatsapp_next.services.dispatch import OutboundSpec
from whatsapp_next.services.function_runner import FunctionRun, Sender
from whatsapp_next.services.guards import status_writer
from whatsapp_next.services.permissions import PARTY_TYPES

MAP_CACHE_KEY = "wa:commands:map"
HELP_TOKENS = ("*", "?", "؟", "help", "مساعدة")
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
	"""Forget the cached command-word map; the next inbound message rebuilds it."""
	frappe.cache.delete_value(MAP_CACHE_KEY)


def help_tokens() -> set[str]:
	"""The built-in help words plus the one set in Settings (`command_help_token`)."""
	own = (frappe.get_cached_doc("WhatsApp Settings").get("command_help_token") or "").strip().casefold()
	return {*HELP_TOKENS, own} if own else set(HELP_TOKENS)


def match_inbound(inbound) -> Match | None:
	"""The command an inbound asks for. A tapped button or list row is read by its id when the
	id is itself a command line (`كشف -3m`), else by its title as a bare command word — a title's
	other words are a label, never arguments. A tap that answers a session question is no command."""
	from whatsapp_next.services import command_sessions

	get = inbound.get if hasattr(inbound, "get") else lambda k: getattr(inbound, k, None)
	text = get("body") or ""
	selected = cstr(get("selected_option_id")).strip()
	if get("message_type") != "Interactive Reply" or not selected:
		return match(text)
	if selected in (command_sessions.TYPE_IT, command_sessions.CANCEL) or selected.startswith(
		command_sessions.ARG_PREFIX
	):
		return None
	by_id = match(selected)
	if by_id is not None and not by_id.is_help:
		return by_id
	by_title = match(text)
	if by_title is not None and not by_title.is_help:
		return replace(by_title, rest="")
	return by_title


def match(text: str | None) -> Match | None:
	"""First token (optionally prefixed with `#`, `/`, `!`) against the map; help tokens too.
	A help token alone asks for the command list; beside a command word (`كشف ؟`, `؟ كشف`,
	`كشف؟`) it asks how to use that command (`Match.is_help` with `command` set)."""
	text = (text or "").strip()
	if not text:
		return None
	head, _sep, rest = text.partition(" ")
	prefixes = "".join(COMMAND_PREFIXES)
	word = head.strip().casefold().lstrip(prefixes)
	rest = rest.strip()
	tokens = help_tokens()
	words = command_map()
	if word in tokens:
		target = words.get(rest.split(" ")[0].casefold().lstrip(prefixes)) if rest else None
		return Match(command=target or "", word=word, rest="" if target else rest, is_help=True)
	command = words.get(word)
	if not command:
		# the token typed against the word: `كشف؟`
		stuck = next((t for t in tokens if len(word) > len(t) and word.endswith(t)), None)
		command = words.get(word[: -len(stuck)]) if stuck else None
		if not command:
			return None
		return Match(command=command, word=word[: -len(stuck)], rest="", is_help=True)
	if rest.casefold() in tokens:
		return Match(command=command, word=word, rest="", is_help=True)
	return Match(command=command, word=word, rest=rest)


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


_TYPE_LABELS = {"str": "text", "int": "number", "date": "date", "link": "name", "check": "yes or no", "select": "choice"}


def usage_text(command) -> str:
	"""How to send `command`: its word, then each value the sender may write in the order
	`parse_args` reads them (required in `<>`, optional in `[]`), its type and a ready example.
	Built from the function's header, so it follows the installed version."""
	inputs = command_inputs(command)
	word = command.code
	lines = [f"*{word}* — {command.title or word}"]
	if command.get("description"):
		lines.append(command.description)
	if not inputs:
		lines += ["", _("This command takes no variables. Send: {0}").format(word)]
		return "\n".join(lines)

	def label(i):
		return _(i.get("label") or i["key"])

	shape = " ".join(f"<{label(i)}>" if i.get("required") else f"[{label(i)}]" for i in inputs)
	lines += ["", _("Send: {0}").format(f"{word} {shape}"), "", _("Variables, in this order:")]
	for n, i in enumerate(inputs, start=1):
		kind = _(_TYPE_LABELS.get(i["type"], "text"))
		if i["type"] == "link" and i.get("options"):
			kind = _(i["options"])
		need = _("required") if i.get("required") else _("optional")
		line = f"{n}. {label(i)} ({_('{0}, {1}').format(kind, need)})"
		if i.get("rest"):
			line += " — " + _("takes the rest of the message")
		if i.get("choices"):
			line += " — " + ", ".join(i["choices"])
		lines.append(line)
	lines += ["", _("Example: {0}").format(_example(command, inputs))]
	if len(inputs) > 1:
		lines.append(_("Or by name, in any order: {0}").format(f"{word} {inputs[0]['key']}=…"))
	return "\n".join(lines)


def _example(command, inputs: list[dict[str, Any]]) -> str:
	"""The command's word with a sample of every required value and of the first optional one."""
	samples = {"int": "3", "date": str(getdate(nowdate()))}
	parts = []
	for n, i in enumerate(inputs):
		sample = (i.get("choices") or [None])[0] or samples.get(i["type"])
		if i.get("required") or (n == 0 and sample):
			parts.append(str(sample or _(i.get("label") or i["key"])))
	return " ".join([command.code, *parts]).strip()


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


def block_message(command, reason: str, sender: Sender | None = None) -> str:
	"""What a refused sender reads: the reason in words they can act on, not the status code."""
	key = (sender.phone_e164 or sender.jid) if sender else None
	if reason == "Not Allowed" and command.get("allowed_group") and not _member(command.allowed_group, key):
		title = frappe.db.get_value("WhatsApp Contact Group", command.allowed_group, "group_name")
		return _("This command is for the members of «{0}» only.").format(title or command.allowed_group)
	messages = {
		"Not Allowed": _("This command is not open to your number."),
		"Blacklist": _("Your number cannot use this command."),
		"Not Linked": _("Your number is not linked to an account with us, so this command cannot answer you."),
		"Party Type": _("This command is not for {0} accounts.").format(_(sender.party_type)) if sender and sender.party_type else _("This command is not for your account type."),
		"Commands Disabled": _("Commands are switched off right now."),
		"Function Inactive": _("This command is not available right now."),
	}
	return messages.get(reason) or _("You cannot use this command ({0})").format(_(reason))


def allowed_party_types(command) -> list[str]:
	"""The command's allowed party types (empty = no type restriction)."""
	return [r.party_type for r in command.get("allowed_party_types") or [] if r.party_type]


# the field a party names its primary contact in
PRIMARY_CONTACT_FIELD = {"Customer": "customer_primary_contact", "Supplier": "supplier_primary_contact"}


def _is_primary_contact_of(contact: str, link) -> bool:
	"""Whether `contact` is the primary contact of the linked party. A contact linked to several
	accounts answers for the one it is the primary contact of, not for whichever was linked first."""
	field = PRIMARY_CONTACT_FIELD.get(link.link_doctype)
	if not field or not frappe.get_meta(link.link_doctype).has_field(field):
		return False
	return frappe.db.get_value(link.link_doctype, link.link_name, field) == contact


def sender_for(inbound, allowed_types: list[str] | None = None) -> Sender:
	"""Sender facts for access checks and the handler context. The party comes from the linked
	Contact's Dynamic Links, among those of an `allowed_types` type when given: the one whose
	primary contact the sender is, else the first."""
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
		candidates = preferred or links
		chosen = next((link for link in candidates if _is_primary_contact_of(contact, link)), None) or (
			candidates[0] if candidates else None
		)
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
	if (get("message_type") or "Text") not in ("Text", "Interactive Reply"):
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
	return function_block(command, sender)


def function_block(command, sender: Sender | None = None) -> str | None:
	"""The function's part of the access check: installed, Active and bound to its Server Script;
	every `@requires` met on this site; the sender's party type one `@party_types` allows."""
	fn = frappe.db.get_value("WhatsApp Function", command.function, ["status", "server_script", "manifest"], as_dict=True)
	if not fn or fn.status != "Active" or not fn.server_script:
		return "Function Inactive"
	spec = function_runner.functions_catalog.manifest_of(fn)
	available, _reasons = fh.function_availability(spec)
	if not available:
		return "Function Inactive"
	if sender is not None and sender.party_type and not fh.party_type_allowed(spec, sender.party_type):
		return "Party Type"
	return None


def function_reasons(command) -> list[str]:
	"""Why the command's function cannot run here (`@requires`), for the status log."""
	spec = function_spec(command)
	return fh.function_availability(spec)[1] if spec else []


# ---- arguments -----------------------------------------------------------------------------

_INPUT_TYPES = {"Date": "date", "Int": "int", "Link": "link", "Check": "check", "Select": "select"}


def _as_input(p: dict[str, Any], position: int | None = None) -> dict[str, Any]:
	"""A header parameter as the router's input: `{key, label, type, required, options, choices}`."""
	return {
		"key": p["name"],
		"label": p["label"] or p["name"],
		"type": _INPUT_TYPES.get(p["fieldtype"], "str"),
		"required": bool(p["required"] and not p.get("default")),
		"options": p.get("options"),
		"choices": list(p.get("select_options") or []),
		"position": position,
	}


def function_spec(command) -> dict[str, Any]:
	"""The header spec of the command's function (empty when it is not installed)."""
	return function_runner.spec_of(command.get("function"))


def disabled_inputs(command) -> set[str]:
	"""Parameter names the command switched off for the sender (`disabled_inputs`, one per line)."""
	return {k.strip() for k in (command.get("disabled_inputs") or "").splitlines() if k.strip()}


def _open_params(command, spec: dict[str, Any] | None = None) -> list[dict[str, Any]]:
	"""The parameters a sender may give: typed ones (not the party, not a template) that the command
	neither switched off nor fixed in its `settings_overrides`."""
	spec = function_spec(command) if spec is None else spec
	off = disabled_inputs(command)
	fixed = set(function_runner.command_overrides(command))
	return [p for p in fh.typed_params(spec) if p["name"] not in off and p["name"] not in fixed]


def command_inputs(command, spec: dict[str, Any] | None = None) -> list[dict[str, Any]]:
	"""The values a sender writes after the command word, in the header's order; the last text one
	takes the rest of the message."""
	inputs = [_as_input(p, n) for n, p in enumerate(_open_params(command, spec), start=1)]
	if inputs and inputs[-1]["type"] == "str":
		inputs[-1]["rest"] = True
	return inputs


def _input_spec(command, key: str) -> dict[str, Any]:
	p = fh.param(function_spec(command), key)
	return _as_input(p) if p else {"key": key, "label": key, "type": "str"}


def _coerce(value: str, key: str, command) -> Any:
	"""A sender's value in its parameter's type. E: `ValueError` with a message for the sender."""
	p = fh.param(function_spec(command), key)
	if not p:
		return cstr(value).strip()
	if p["fieldtype"] == "Date":
		from whatsapp_next.services.command_sessions import relative_date

		relative = relative_date(cstr(value))
		if relative:
			return str(relative)
	return fh.coerce(p, cstr(value))


def parse_args(command, text: str, *, partial: bool = False) -> dict[str, Any]:
	"""The values the sender wrote after the command word: `key=value` tokens for any parameter the
	sender may give, then the rest by position (`command_inputs`). Typed by the header; a value of
	the wrong type or not allowed raises `WAValidationError`. Defaults are not applied here (the
	header fills them in `function_runner.prepare`); `partial` is kept for callers and changes
	nothing."""
	inputs = command_inputs(command)
	open_names = {i["key"].casefold(): i["key"] for i in inputs}
	try:
		tokens = shlex.split(text) if text.strip() else []
	except ValueError:
		tokens = text.split()
	named: dict[str, str] = {}
	positional: list[str] = []
	for tok in tokens:
		m = _ARG_RE.match(tok)
		if m and m.group(1).casefold() in open_names:
			named[open_names[m.group(1).casefold()]] = m.group(2)
		elif m:
			continue  # the party, a template, or a value the command fixed: never the sender's
		else:
			positional.append(tok)
	out: dict[str, Any] = {}
	errors: list[str] = []
	for spec in inputs:
		key = spec["key"]
		raw: str | None = named.get(key)
		if raw is None and positional:
			if spec.get("rest"):
				raw, positional = " ".join(positional), []
			else:
				raw = positional.pop(0)
		if raw is None or raw == "":
			continue
		try:
			out[key] = _coerce(raw, key, command)
		except ValueError as exc:
			errors.append(str(exc))
	if errors:
		frappe.throw("; ".join(errors), WAValidationError)
	return out


def ask_keys(command) -> list[str]:
	"""Parameters the command asks the sender for when the text did not give them (`ask_inputs`)."""
	from whatsapp_next.services import command_sessions

	return list(command_sessions.ask_specs(command))


def to_ask(command, provided: dict[str, Any], missing: list[dict[str, Any]]) -> list[str]:
	"""What to ask, in the header's order: required parameters still empty (not the party) and the
	ones the command asks for that the text did not give."""
	spec = function_spec(command)
	wanted = {m["name"] for m in missing if m["source"] != "sender"}
	open_names = {p["name"] for p in _open_params(command, spec)}
	wanted |= {k for k in ask_keys(command) if k in open_names and k not in provided}
	return [p["name"] for p in spec.get("params") or [] if p["name"] in wanted]


# ---- execution -----------------------------------------------------------------------------


def _service_user() -> str:
	settings = frappe.get_cached_doc("WhatsApp Settings")
	user = settings.command_service_user
	if not user or user == "Administrator":
		frappe.throw(_("Messaging Service User is not configured"), WAStateConflictError)
	row = frappe.db.get_value("User", user, ["enabled"], as_dict=True)
	if not row or not cint(row.enabled):
		frappe.throw(_("Messaging Service User {0} is disabled").format(user), WAStateConflictError)
	if "System Manager" in frappe.get_roles(user):
		frappe.throw(_("Messaging Service User must not be a System Manager"), WAStateConflictError)
	return user


def execute(command, inbound, params: dict[str, Any], *, sender: Sender | None = None, dry_run: bool = False) -> FunctionRun:
	"""Run the command's function with ready `params` as the service user; the previous session
	user (and the request's session and form_dict) is always restored."""
	get = inbound.get if hasattr(inbound, "get") else lambda k: getattr(inbound, k, None)
	service_user = _service_user()
	previous = frappe.session.user
	# `frappe.set_user` also overwrites the session id and data and the request's form_dict;
	# restoring only the user would end a web request (the editor preview, the dry-run test) with
	# the browser's session replaced by a bogus one, so the caller's next call arrives as Guest.
	saved_sid, saved_data, saved_form = frappe.session.sid, frappe.session.data, frappe.local.form_dict
	started = time.perf_counter()
	# a dry run (the Simulator, the editor's test) runs the function for real: what it writes is
	# undone, as `function_runner.trial` undoes it, so trying a command changes no record
	if dry_run:
		frappe.db.savepoint("wa_cmd_dry_run")
	try:
		frappe.set_user(service_user)
		run = function_runner.execute(command, params, disabled=function_runner.disabled_replies(command))
	finally:
		if dry_run:
			frappe.db.rollback(save_point="wa_cmd_dry_run")
		frappe.set_user(previous)
		frappe.session.sid, frappe.session.data, frappe.local.form_dict = saved_sid, saved_data, saved_form
	elapsed = int((time.perf_counter() - started) * 1000)
	# a preview, the editor's test or the Simulator is not a call: the function's figures (and
	# its "last error") describe what senders got, and a dry run persists nothing
	if not dry_run:
		_record_metrics(command.function, elapsed, error=run.detail or run.error)
	if run.error and get("name"):
		run.data.setdefault("inbound", get("name"))
	return run


def _record_metrics(function: str, elapsed_ms: int, *, error: str | None) -> None:
	"""Count one call and fold its time into the average in a single UPDATE, so two workers
	finishing at once never overwrite each other's count. MariaDB assigns left to right: the
	average is computed from the count before it is incremented."""
	from frappe.query_builder.functions import Coalesce

	fn = frappe.qb.DocType("WhatsApp Function")
	calls = Coalesce(fn.call_count, 0)
	query = (
		frappe.qb.update(fn)
		.set(fn.avg_ms, (Coalesce(fn.avg_ms, 0) * calls + int(elapsed_ms)) / (calls + 1))
		.set(fn.call_count, calls + 1)
		.set(fn.last_called_at, now_datetime())
		.where(fn.name == function)
	)
	if error:
		query = query.set(fn.error_count, Coalesce(fn.error_count, 0) + 1).set(fn.last_error, error[:500])
	query.run()


def render_outputs(command, result: FunctionRun, sender: Sender | None = None, *, dry_run: bool = False) -> list[dict[str, Any]]:
	"""The replies of a run, in its messages' order (`function_runner.replies_of`)."""
	return function_runner.replies_of(result, dry_run=dry_run)


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
	"""A command is answered from the device that received it — the number the sender wrote to.
	The per-command and settings-wide "Reply Device" were removed from the product; a value left
	in either column is ignored."""
	get = inbound.get if hasattr(inbound, "get") else lambda k: getattr(inbound, k, None)
	return get("device")


# the automatic replies go out at once, not behind the queue's tick: the receipt is only worth
# sending before the function's answer; the unknown-command and help replies are instant echoes
IMMEDIATE_OUTPUTS = frozenset({"receipt", "unknown", "help"})


def _contact_numbers(contact: str | None, asker: str | None) -> list[str]:
	"""The contact's other WhatsApp numbers (individuals, primary first), without the asker's."""
	if not contact:
		return []
	from whatsapp_next.services.phone import classify

	rows = frappe.get_all(
		"Contact Phone",
		filters={"parenttype": "Contact", "parent": contact, "wa_phone_e164": ("is", "set")},
		pluck="wa_phone_e164",
		order_by="is_primary_mobile_no desc, idx asc",
		ignore_permissions=True,
	)
	others: list[str] = []
	for value in rows:
		kind, key = classify(value)
		if kind == "Individual" and key != asker and key not in others:
			others.append(key)
	return others


def _send_replies(command, inbound, replies: list[dict[str, Any]], *, is_simulated: bool) -> list[str]:
	"""Each reply to the number that asked, then to every other WhatsApp number of its contact
	(owner, 2026-10-08): the whole contact reads the answer, not only the phone that asked. A group
	is answered in the group; the receipt and the Simulator stay with the asker. The asker's rows
	come first, so `[0]` is still the reply to the message itself."""
	get = inbound.get if hasattr(inbound, "get") else lambda k: getattr(inbound, k, None)
	is_group = cint(get("is_group"))
	asker = get("phone_e164")
	others = [] if is_group or is_simulated else _contact_numbers(get("contact"), asker)
	names: list[str] = []
	for phone in [asker, *others]:
		own = phone == asker
		for r in replies:
			if not own and r.get("output_key") == "receipt":
				continue
			spec = OutboundSpec(
				device=_reply_device(command, inbound),
				phone=phone,
				jid=get("chat_jid") if is_group else None,
				message_type=r["message_type"],
				body=r.get("body"),
				interactive=r.get("interactive"),
				attachment=r.get("attachment"),
				file_name=r.get("file_name"),
				mime_type=r.get("mime_type"),
				source_type="Command Reply",
				command=command.name,
				trigger_inbound=get("name"),
				display_name=get("display_name") if own else None,
				contact=get("contact"),
				is_simulated=is_simulated,
				skip_policy=True,
				# the answer quotes the message that asked (owner, 2026-10-08): WhatsApp shows it as a
				# reply to that command, which matters in a group where several people ask at once.
				# Only in the asker's chat: the other numbers never saw that message
				extra={"reply_to_provider_message_id": get("provider_message_id")}
				if own and get("provider_message_id")
				else {},
			)
			if own:
				outbound = dispatch.create_outbound(spec)
			else:
				# a blocked or invalid extra number is skipped; the asker's answer still goes
				try:
					outbound = dispatch.create_outbound(spec)
				except frappe.ValidationError:
					frappe.clear_last_message()
					continue
			if not is_simulated:
				if r.get("output_key") in IMMEDIATE_OUTPUTS:
					_send_now_or_queue(outbound)
				else:
					dispatch.enqueue([outbound], priority=1)
			names.append(outbound)
	return names


def _send_now_or_queue(outbound: str) -> None:
	"""`dispatch.send_now`; a send that breaks before the provider answers falls back to the queue,
	so an automatic reply is never lost and never stops the command behind it."""
	try:
		dispatch.send_now(outbound, source="direct")
	except Exception as exc:
		frappe.log_error(
			title="WhatsApp automatic reply: direct send failed",
			message=f"outbound={outbound} {type(exc).__name__}",
		)
		dispatch.enqueue([outbound], priority=1)


def reply_language() -> str:
	"""The language every command reply is written in: Settings' `command_reply_language`, else
	the site's. Not the user's: a reply is read by the sender, not by whoever runs the job."""
	return (
		frappe.get_cached_doc("WhatsApp Settings").get("command_reply_language")
		or frappe.db.get_single_value("System Settings", "language")
		or "en"
	)


@contextmanager
def in_reply_language():
	"""Write everything inside in `reply_language()`, then give the caller's language back."""
	from frappe.translate import print_language

	# a background job resolves its user's language lazily, on its first `_()`, and that
	# overwrites `frappe.local.lang`: let it happen now, or it would switch a reply back mid-way
	_("")
	with print_language(reply_language()):
		yield


def route(
	inbound_name: str | None = None,
	*,
	inbound=None,
	dry_run: bool = False,
	create_simulated_rows: bool = False,
) -> RouteResult:
	"""Steps 4–11 for one inbound. Live routing (`dry_run=False`) only runs in a job; the
	Simulator passes `dry_run=True` with an unsaved `inbound` doc/dict. Replies are written in
	`reply_language()`; the caller's language is restored afterwards."""
	with in_reply_language():
		return _route(
			inbound_name, inbound=inbound, dry_run=dry_run, create_simulated_rows=create_simulated_rows
		)


def _route(
	inbound_name: str | None,
	*,
	inbound,
	dry_run: bool,
	create_simulated_rows: bool,
) -> RouteResult:
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
	m = match_inbound(inbound)
	if not cint(get("is_group")) and command_menu.is_menu_request(inbound):
		menu = command_menu.menu_list()
		if menu:
			from whatsapp_next.services import command_sessions

			if not dry_run:
				command_sessions.clear(get("device"), command_sessions.chat_key(inbound))
			result.status = "Executed"
			result.replies = [menu]
			_set_status(inbound_name, "Executed", command_text=text[:140])
			return _finish(result, inbound, dry_run, create_simulated_rows, command=None)
	if not dry_run and not cint(get("is_group")):
		from whatsapp_next.services import command_sessions

		session = command_sessions.load(get("device"), command_sessions.chat_key(inbound))
		if session:
			# a new command typed instead of an answer starts over; anything else answers
			if m is not None:
				command_sessions.clear(get("device"), command_sessions.chat_key(inbound))
			else:
				return _continue_session(session, inbound, inbound_name, result, settings, started)
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
		result.command = m.command or None
		body = (
			usage_text(frappe.get_cached_doc("WhatsApp Command", m.command))
			if m.command
			else help_text(get("phone_e164"))
		)
		result.replies = [{"output_key": "help", "message_type": "Text", "body": body, "attachment": None}]
		_set_status(inbound_name, "Executed", command_text=text[:140])
		return _finish(result, inbound, dry_run, create_simulated_rows, command=None)
	command = frappe.get_cached_doc("WhatsApp Command", m.command)
	result.command = command.name
	sender = sender_for(inbound, allowed_party_types(command))
	reason = check_access(command, inbound, sender)
	if reason:
		result.status, result.block_reason = "Blocked", reason
		detail = "; ".join(function_reasons(command)) if reason == "Function Inactive" else None
		_set_status(
			inbound_name,
			"Blocked",
			command=command.name,
			command_text=text[:140],
			block_reason=reason,
			**({"command_error": detail[:500]} if detail else {}),
		)
		if cint(settings.send_receipt_reply):
			result.replies = [
				{
					"output_key": "blocked",
					"message_type": "Text",
					"body": block_message(command, reason, sender),
					"attachment": None,
				}
			]
		return _finish(result, inbound, dry_run, create_simulated_rows, command=command)
	try:
		provided = parse_args(command, m.rest)
		params, missing = function_runner.prepare(command, sender, provided)
	except (WAValidationError, ValueError) as exc:
		return _failed(command, inbound, inbound_name, text, result, str(exc), dry_run, create_simulated_rows)
	if any(m_["source"] == "sender" for m_ in missing):
		# the function needs the sender's party and the number is linked to none
		result.status, result.block_reason = "Blocked", "Not Linked"
		_set_status(inbound_name, "Blocked", command=command.name, command_text=text[:140], block_reason="Not Linked")
		return _finish(result, inbound, dry_run, create_simulated_rows, command=command)
	asking = to_ask(command, provided, missing)
	if asking and not dry_run and not cint(get("is_group")):
		return _ask_first(command, inbound, inbound_name, provided, asking, text, result)
	if missing:
		labels = ", ".join(_(m_["label"]) for m_ in missing)
		return _failed(command, inbound, inbound_name, text, result, _("{0} is required").format(labels), dry_run, create_simulated_rows)
	return _run(command, inbound, inbound_name, params, sender, text, settings, started, result, dry_run, create_simulated_rows)


def _failed(command, inbound, inbound_name, text, result, error, dry_run, create_simulated_rows) -> RouteResult:
	"""A value the sender gave that the function cannot take: the reason is the reply."""
	result.status, result.error = "Failed", error
	_set_status(inbound_name, "Failed", command=command.name, command_text=text[:140], command_error=error[:500])
	result.replies = [{"output_key": "error", "message_type": "Text", "body": error, "attachment": None}]
	return _finish(result, inbound, dry_run, create_simulated_rows, command=command)


def _run(command, inbound, inbound_name, args, sender, text, settings, started, result, dry_run, create_simulated_rows):
	"""Steps 9–11: mark Matched, the receipt reply, the function, its outputs, the run counter."""
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
	if not dry_run:
		from whatsapp_next.services import receipts

		receipts.typing(inbound_name)  # "typing…" while the function prepares the answer
	fn_result = execute(command, inbound, args, sender=sender, dry_run=dry_run)
	result.data = fn_result.data
	result.replies = render_outputs(command, fn_result, sender, dry_run=dry_run and not create_simulated_rows)
	if fn_result.error:
		result.status, result.error = "Failed", fn_result.error
		_set_status(inbound_name, "Failed", command_error=(fn_result.detail or fn_result.error)[:500])
	else:
		result.status = "Executed"
		_set_status(inbound_name, "Executed")
	if not dry_run:
		# one UPDATE: concurrent runs of the same command each count
		from frappe.query_builder.functions import Coalesce

		cmd = frappe.qb.DocType("WhatsApp Command")
		(
			frappe.qb.update(cmd)
			.set(cmd.run_count, Coalesce(cmd.run_count, 0) + 1)
			.set(cmd.last_run_at, now_datetime())
			.where(cmd.name == command.name)
		).run()
	result.elapsed_ms = int((time.perf_counter() - started) * 1000)
	return _finish(result, inbound, dry_run, create_simulated_rows, command=command)


def _ask_first(command, inbound, inbound_name, provided, missing, text, result) -> RouteResult:
	"""Keep a session for the chat and ask for the first missing input."""
	from whatsapp_next.services import command_sessions

	get = inbound.get if hasattr(inbound, "get") else lambda k: getattr(inbound, k, None)
	command_sessions.save(
		get("device"),
		command_sessions.chat_key(inbound),
		{"command": command.name, "args": provided, "pending": missing, "text": text[:140], "inbound": inbound_name},
	)
	result.status = "Awaiting Input"
	_set_status(inbound_name, "Awaiting Input", command=command.name, command_text=text[:140])
	result.replies = [command_sessions.question(command, _input_spec(command, missing[0]))]
	return _finish(result, inbound, False, False, command=command)


def _continue_session(session, inbound, inbound_name, result, settings, started) -> RouteResult:
	"""One answer in a running session: fill the pending input, ask the next, or run the command."""
	from whatsapp_next.services import command_sessions

	get = inbound.get if hasattr(inbound, "get") else lambda k: getattr(inbound, k, None)
	device, chat = get("device"), command_sessions.chat_key(inbound)
	if not frappe.db.exists("WhatsApp Command", session.get("command")):
		command_sessions.clear(device, chat)
		return result
	command = frappe.get_cached_doc("WhatsApp Command", session["command"])
	result.command = command.name
	pending = list(session.get("pending") or [])
	if not pending:
		command_sessions.clear(device, chat)
		return result
	spec = _input_spec(command, pending[0])
	kind, raw = command_sessions.answer_of(inbound)
	if kind == "cancel":
		command_sessions.clear(device, chat)
		result.status = "Executed"
		_set_status(inbound_name, "Executed", command=command.name, command_text=_("cancelled"))
		result.replies = [{"output_key": "prompt", "message_type": "Text", "body": _("Cancelled."), "attachment": None}]
		return _finish(result, inbound, False, False, command=command)
	if kind == "type":
		command_sessions.save(device, chat, session)
		result.status = "Awaiting Input"
		_set_status(inbound_name, "Awaiting Input", command=command.name)
		result.replies = [command_sessions.type_it(spec)]
		return _finish(result, inbound, False, False, command=command)
	from whatsapp_next.services import plan_features

	if not plan_features.interactive():
		raw = command_sessions.numbered_answer(command, spec, raw)
	try:
		value = _coerce(cstr(raw), spec["key"], command)
	except ValueError as exc:
		command_sessions.save(device, chat, session)
		result.status = "Awaiting Input"
		_set_status(inbound_name, "Awaiting Input", command=command.name, command_error=str(exc)[:500])
		result.replies = [
			{"output_key": "prompt", "message_type": "Text", "body": str(exc), "attachment": None},
			command_sessions.question(command, spec),
		]
		return _finish(result, inbound, False, False, command=command)
	args = dict(session.get("args") or {})
	args[pending.pop(0)] = value
	if pending:
		session.update({"args": args, "pending": pending})
		command_sessions.save(device, chat, session)
		result.status = "Awaiting Input"
		_set_status(inbound_name, "Awaiting Input", command=command.name)
		result.replies = [command_sessions.question(command, _input_spec(command, pending[0]))]
		return _finish(result, inbound, False, False, command=command)
	command_sessions.clear(device, chat)
	sender = sender_for(inbound, allowed_party_types(command))
	reason = check_access(command, inbound, sender)
	if reason:
		result.status, result.block_reason = "Blocked", reason
		_set_status(inbound_name, "Blocked", command=command.name, block_reason=reason)
		return _finish(result, inbound, False, False, command=command)
	text = session.get("text") or ""
	try:
		# the values nobody asked for take their defaults, as a typed command would
		params, missing = function_runner.prepare(command, sender, args)
	except ValueError as exc:
		return _failed(command, inbound, inbound_name, text, result, str(exc), False, False)
	if missing:
		labels = ", ".join(_(m_["label"]) for m_ in missing)
		return _failed(command, inbound, inbound_name, text, result, _("{0} is required").format(labels), False, False)
	return _run(command, inbound, inbound_name, params, sender, text, settings, started, result, False, False)


def _finish(
	result: RouteResult, inbound, dry_run: bool, create_simulated_rows: bool, *, command
) -> RouteResult:
	"""Send (or, for the Simulator, optionally persist `is_simulated`) the replies."""
	if not result.replies or (command is None and result.status not in ("Executed", "Not Matched")):
		return result
	get = inbound.get if hasattr(inbound, "get") else lambda k: getattr(inbound, k, None)
	if not cint(get("is_group")):
		result.replies = command_menu.decorate(result.replies, result.status)
	if dry_run and not create_simulated_rows:
		return result
	if command is None:
		# help / unknown-command replies use the inbound device only
		command = frappe._dict(name=None)
	get = inbound.get if hasattr(inbound, "get") else lambda k: getattr(inbound, k, None)
	try:
		result.outbound = _send_replies(command, inbound, result.replies, is_simulated=dry_run)
	except Exception as exc:
		result.error = result.error or f"reply: {str(exc)[:200]}"
		frappe.log_error(
			title="WhatsApp command reply failed", message=f"inbound={get('name')} {type(exc).__name__}"
		)
		return result
	if result.outbound and get("name") and not dry_run:
		from whatsapp_next.services import receipts

		receipts.on_command_replied(get("name"))
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
	device = device or default_device()
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
	"""`{command → runs in the last `days` days}` (by `received_at`): inbound messages that matched
	the command and reached it — a Blocked sender is not a run, and Simulator rows are not traffic."""
	if not commands:
		return {}
	from frappe.utils import add_days

	rows = frappe.get_all(
		"WhatsApp Inbound Message",
		filters={
			"command": ("in", list(commands)),
			"command_status": ("!=", "Blocked"),
			"is_simulated": 0,
			"received_at": (">=", add_days(now_datetime(), -abs(cint(days)))),
		},
		fields=["command", {"COUNT": "name", "as": "run_count"}],
		group_by="command",
	)
	return {r.command: cint(r.run_count) for r in rows}


# Module role: one run of a function's Server Script for a command (WHATSAPP_NEXT_INTEGRATION §5–§6).
# Merges the values by priority (what the sender gave → the command's overrides → the function's site
# values; templates from the command's table by language), fills them through the header
# (`function_header.build_params`), runs the script with `run_script` — the parameters in
# `form_dict`, the answer in `frappe.flags.wa_result` — and turns the messages it returned, checked
# against `@reply`, into the router's replies (a `report` printed to a private file).

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any

import frappe
from frappe import _

from whatsapp_next.services import function_header as fh
from whatsapp_next.services import functions_catalog

GENERIC_ERROR = "Could not complete the request."


@dataclass(frozen=True)
class Sender:
	"""Who sent the command. `party_type` / `party_name` come from the linked Contact's Dynamic
	Link rows (first party of an allowed type) — the only source of a function's party."""

	phone_e164: str | None
	jid: str | None
	display_name: str | None
	contact: str | None
	party_type: str | None = None
	party_name: str | None = None
	is_group: bool = False


@dataclass
class FunctionRun:
	"""What a run returned: `error` (a text for the sender) or `messages` (validated), and `data`
	for the log. `params` are the values the script got."""

	error: str | None = None
	# what went wrong, for the status log (`command_error`) when the sender only gets the generic text
	detail: str | None = None
	messages: list[dict[str, Any]] = field(default_factory=list)
	data: dict[str, Any] = field(default_factory=dict)
	params: dict[str, Any] = field(default_factory=dict)

	@property
	def ok(self) -> bool:
		return self.error is None


def spec_of(function: str | None) -> dict[str, Any]:
	"""The installed function's header spec (empty when not installed)."""
	if not function or not frappe.db.exists("WhatsApp Function", function):
		return {}
	spec = functions_catalog.manifest_of(function)
	# a row from before the Server Scripts carries a catalog manifest, not a header
	return spec if "params" in spec and spec.get("function") else {}


def _json(value: Any) -> dict[str, Any]:
	if isinstance(value, dict):
		return value
	try:
		return json.loads(value) if value else {}
	except ValueError:
		return {}


def command_overrides(command) -> dict[str, Any]:
	"""The command's `settings_overrides`, keyed by parameter name."""
	return _json(command.get("settings_overrides"))


def disabled_replies(command) -> set[str]:
	"""`@reply` keys the command switched off, one per line."""
	return {k.strip() for k in (command.get("disabled_replies") or "").splitlines() if k.strip()}


def run_language(command, spec: dict[str, Any] | None = None) -> str:
	"""The language a run writes in: the command's `language` override, else the reply language."""
	from whatsapp_next.services.command_router import reply_language

	return str(command_overrides(command).get("language") or "").strip() or reply_language()


def _template_text(value: Any, language: str) -> str | None:
	"""A site value of a template: one text, or `{language: text}` with `""` for every language."""
	if isinstance(value, dict):
		for key in (language, language.split("-")[0], ""):
			if not fh.is_empty(value.get(key)):
				return value[key]
		return None
	return None if fh.is_empty(value) else value


def merged_values(
	command, spec: dict[str, Any], given: dict[str, Any] | None, language: str
) -> dict[str, Any]:
	"""The values of one run before the header fills them: the sender's (`given`) over the
	command's `settings_overrides` over the function's `values`. A template comes from the
	command's `templates` table in `language`, else the function's value; the header's default
	is applied later (`build_params`). The party never comes from here."""
	site = functions_catalog.values_of(command.function) if command.get("function") else {}
	overrides = command_overrides(command)
	rows = command.get("templates") or []
	out: dict[str, Any] = {}
	for p in fh.command_params(spec):
		name = p["name"]
		if p["fieldtype"] == "Template":
			own = {r.language or "": r.text for r in rows if r.param == name and not fh.is_empty(r.text)}
			value = _template_text(own, language) if own else None
			out[name] = value if value is not None else _template_text(site.get(name), language)
			continue
		for source in (given or {}, overrides, site):
			if not fh.is_empty(source.get(name)):
				out[name] = source[name]
				break
	if "language" in {p["name"] for p in spec.get("params") or []} and fh.is_empty(out.get("language")):
		out["language"] = language.split("-")[0]  # `en-GB` → `en`, as a Select of languages names it
	return out


def prepare(
	command, sender, given: dict[str, Any] | None = None
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
	"""`(params, missing)` for the command's function. E: `ValueError` (a value not allowed)."""
	spec = spec_of(command.function)
	language = run_language(command, spec)
	return fh.build_params(spec, sender, merged_values(command, spec, given, language), language)


def run_function(server_script: str, params: dict[str, Any], spec: dict[str, Any]) -> dict[str, Any]:
	"""Run the script with the parameters in `form_dict` and return its `wa_result`
	`{error, messages, data}`. Every header parameter is set (None when empty) so the script never
	reads a value of the same name left in the request. E: `frappe.ValidationError` when the script
	sets no `wa_result`."""
	from frappe.utils.safe_exec import run_script

	kwargs = {p["name"]: None for p in spec.get("params") or []}
	kwargs.update(params)
	# never run as the function's own URL: the script's guard reads `cmd`
	kwargs["cmd"] = None
	saved = frappe.flags.get("wa_result")
	frappe.flags.wa_result = None
	try:
		flags = run_script(server_script, **kwargs) or {}
		result = flags.get("wa_result") if hasattr(flags, "get") else None
	finally:
		frappe.flags.wa_result = saved
	if not isinstance(result, dict):
		frappe.throw(_("{0} did not set frappe.flags.wa_result").format(server_script))
	return {
		"error": result.get("error"),
		"messages": result.get("messages") or [],
		"data": result.get("data") or {},
	}


def execute(command, params: dict[str, Any], *, disabled: set[str] | None = None) -> FunctionRun:
	"""Run the command's function with ready `params` (caller handles the user and the metrics).
	A script that raises becomes the generic error for the sender, logged with the script's name;
	a message the header did not declare fails the run and nothing is sent."""
	fn = frappe.db.get_value(
		"WhatsApp Function", command.function, ["server_script", "manifest"], as_dict=True
	)
	if not fn or not fn.server_script:
		return FunctionRun(error=_("Function is inactive"), params=params)
	spec = functions_catalog.manifest_of(fn)
	try:
		result = run_function(fn.server_script, params, spec)
	except Exception as exc:
		frappe.log_error(
			title=f"WhatsApp function {fn.server_script} failed",
			message=f"command={command.name} {type(exc).__name__}: {str(exc)[:300]}",
		)
		return FunctionRun(
			error=_(GENERIC_ERROR), detail=f"{type(exc).__name__}: {str(exc)[:300]}", params=params, data={"exception": type(exc).__name__}
		)
	if result["error"]:
		return FunctionRun(error=str(result["error"]), data=result["data"], params=params)
	try:
		messages = fh.validate_messages(spec, result["messages"], disabled=disabled)
	except ValueError as exc:
		frappe.log_error(title=f"WhatsApp function {fn.server_script}: undeclared reply", message=str(exc))
		# the sender is told the request failed; what the script did wrong stays with the team
		return FunctionRun(error=_(GENERIC_ERROR), detail=str(exc), data=result["data"], params=params)
	return FunctionRun(messages=messages, data=result["data"], params=params)


def replies_of(run: FunctionRun, *, dry_run: bool = False) -> list[dict[str, Any]]:
	"""The router's replies for a run: its error alone, else every message in order — a text as
	Text, a report printed (`report_file.render_report_file`) and sent as a Document with its
	caption. A dry run prints nothing; it shows what would be sent."""
	from whatsapp_next.services import attachments
	from whatsapp_next.services.report_file import render_report_file

	if run.error:
		return [{"output_key": "error", "message_type": "Text", "body": run.error, "attachment": None}]
	out: list[dict[str, Any]] = []
	for msg in run.messages:
		if msg["type"] == "text":
			out.append(
				{"output_key": msg["reply"], "message_type": "Text", "body": msg["text"], "attachment": None}
			)
			continue
		if dry_run:
			out.append(
				{
					"output_key": msg["reply"],
					"message_type": "Document",
					"body": msg.get("caption") or None,
					"attachment": None,
					"file_name": msg.get("file_name"),
					"report_name": msg["report_name"],
					"filters": msg.get("filters"),
					"format": msg.get("format"),
				}
			)
			continue
		try:
			file_name, content, mime = render_report_file(msg)
		except Exception as exc:
			frappe.log_error(
				title=f"WhatsApp report reply {msg['report_name']} failed",
				message=f"{type(exc).__name__}: {str(exc)[:300]}",
			)
			out.append(
				{
					"output_key": msg["reply"],
					"message_type": "Text",
					"body": _(GENERIC_ERROR),
					"attachment": None,
				}
			)
			continue
		out.append(
			{
				"output_key": msg["reply"],
				"message_type": "Document",
				"body": msg.get("caption") or None,
				"attachment": attachments.save_private_file(content, file_name),
				"file_name": file_name,
				"mime_type": mime,
			}
		)
	return out


# ---- the Functions Center's "Try" (§4) ------------------------------------------------------------


def trial(
	function_key: str, party_type: str | None = None, party: str | None = None, values: dict | None = None
) -> dict[str, Any]:
	"""The run a command would make, step by step, with nothing sent and nothing kept (the same steps
	as the WA Function Tester): header → `@requires` → `@party_types` → parameters → the script (as
	the command service user) → `@reply`. `values` are the editor's values over the function's own.
	Returns `{steps[{name, ok, detail}], params, missing[], messages[], error}`."""
	from whatsapp_next.services.command_router import _service_user

	out: dict[str, Any] = {"steps": [], "params": {}, "missing": [], "messages": [], "error": None}

	def step(name: str, ok: bool, detail: str = "") -> bool:
		out["steps"].append({"name": name, "ok": ok, "detail": detail})
		return ok

	doc = functions_catalog.installed(function_key)
	try:
		spec, checksum = functions_catalog.script_spec(doc.server_script)
	except frappe.ValidationError as exc:
		frappe.clear_last_message()
		step(_("Header"), False, str(exc))
		return out
	if not step(_("Header"), True, f"{spec['function']} {spec.get('version') or ''}".strip()):
		return out
	if checksum != doc.manifest_checksum:
		step(_("Installed header"), True, _("The script's header changed: update the function to use it"))
		spec = functions_catalog.manifest_of(doc)
	available, reasons = fh.function_availability(spec)
	if not step(_("Requirements (@requires)"), available, " · ".join(reasons) or _("Available")):
		return out
	if not step(
		_("Party type (@party_types)"),
		fh.party_type_allowed(spec, party_type),
		_(party_type) if party_type else _("None"),
	):
		return out
	if party_type and party and not frappe.db.exists(party_type, party):
		step(_("Party"), False, _("{0} {1} not found").format(_(party_type), party))
		return out
	sender = Sender(None, None, None, None, party_type=party_type, party_name=party)
	command = frappe._dict(function=doc.name, settings_overrides=None, templates=[], name=None)
	language = run_language(command, spec)
	try:
		merged = merged_values(command, spec, values or {}, language)
		params, missing = fh.build_params(spec, sender, merged, language)
	except ValueError as exc:
		step(_("Parameters"), False, str(exc))
		return out
	out["params"], out["missing"] = params, missing
	detail = (
		_("Missing: {0}").format(", ".join(m["label"] for m in missing))
		if missing
		else _("{0} values").format(len(params))
	)
	if not step(_("Parameters"), not missing, detail):
		return out
	previous = frappe.session.user
	saved_sid, saved_data, saved_form = frappe.session.sid, frappe.session.data, frappe.local.form_dict
	frappe.db.savepoint("wa_fn_trial")
	started = frappe.utils.now_datetime()
	try:
		frappe.set_user(_service_user())
		result = run_function(doc.server_script, params, spec)
	except Exception as exc:
		frappe.clear_last_message()
		step(_("Run"), False, f"{type(exc).__name__}: {str(exc)[:300]}")
		return out
	finally:
		frappe.db.rollback(save_point="wa_fn_trial")
		frappe.set_user(previous)
		frappe.session.sid, frappe.session.data, frappe.local.form_dict = saved_sid, saved_data, saved_form
	ms = int((frappe.utils.now_datetime() - started).total_seconds() * 1000)
	out["error"] = result["error"]
	if not step(_("Run"), not result["error"], result["error"] or f"{ms} ms"):
		return out
	try:
		out["messages"] = fh.validate_messages(spec, result["messages"])
	except ValueError as exc:
		step(_("Replies (@reply)"), False, str(exc))
		return out
	step(_("Replies (@reply)"), True, _("{0} messages").format(len(out["messages"])))
	return out

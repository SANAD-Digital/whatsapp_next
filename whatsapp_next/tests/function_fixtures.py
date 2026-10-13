# Module role: test fixtures for command functions (WHATSAPP_NEXT_INTEGRATION §2–§7). A function is a
# Server Script (type API, method `wa_fn_…`) with a WA-FUNCTION header; the tests make their OWN small
# scripts named `wa_fn__test_*` declaring `@function _test_*`, install them, bind test commands to
# them and remove all of it afterwards. They never read, change or depend on the site's real
# `wa_fn_*` scripts, functions or commands (رصيد, كشف, فاتورة, عملاء, موردين, صندوق, بنك, فحص).

from __future__ import annotations

import unittest

import frappe

SCRIPT_PREFIX = "wa_fn__test_"  # every fixture Server Script's name starts with this
KEY_PREFIX = "_test_"  # every fixture function key (`@function`) starts with this
SERVICE_USER = "wa-test-fnsvc@example.com"

GUARD = (
	"# ---------- guard: never from the direct URL ----------\n"
	'if (frappe.form_dict.get("cmd") or "").startswith("wa_fn_"):\n'
	'    frappe.throw("Not allowed", frappe.PermissionError)\n'
)


def header(
	key: str, lines: list[str], *, title: str | None = None, version: str = "1.0.0", party_types: str = "all"
) -> str:
	"""A WA-FUNCTION header: `@function`, `@title`, `@version`, `@party_types` (lines 2–5), then
	`lines` from line 6 on."""
	rows = [
		"# ==================== WA-FUNCTION ====================",
		f"# @function     {key}",
		f"# @title        {title or key}",
		f"# @version      {version}",
		f"# @party_types  {party_types}",
	]
	rows += [f"# {line}" if line else "#" for line in lines]
	rows.append("# ================== END WA-FUNCTION ==================")
	return "\n".join(rows) + "\n"


def source(key: str, lines: list[str], body: str, *, guard: bool = True, **kw) -> str:
	"""A whole function script: header, the direct-URL guard (unless `guard=False`), `body`."""
	return header(key, lines, **kw) + "\n" + (GUARD if guard else "") + "\n" + body


# ---- the fixture functions ------------------------------------------------------------------------

ECHO_LINES = [
	"@param  text        | Data                | optional | source=command | Text",
	"@param  party_type  | Link:DocType        | optional | source=sender  | Party type",
	"@param  party       | Dynamic:party_type  | optional | source=sender  | Party",
	"@param  msg_result  | Template            | optional |                | Result message",
	"",
	"@default msg_result",
	"> pong: {{ echo }}",
	"",
	"@var  echo   | msg_result | The text sent",
	"@var  party  | all        | The sender's party",
	"@reply  result_text  | text |  | Result",
]
ECHO_BODY = """form = frappe.form_dict
echo = (form.get("text") or "").strip() or "pong"
ctx = {"echo": echo, "party": form.get("party") or "", "party_type": form.get("party_type") or ""}
frappe.flags.wa_result = {
    "error": None,
    "messages": [{
        "reply": "result_text",
        "type": "text",
        "text": frappe.render_template(form.get("msg_result") or "pong: {{ echo }}", ctx).strip(),
    }],
    "data": {"echo": echo, "party": ctx["party"], "user": frappe.session.user},
}
"""

TYPED_LINES = [
	"@param  party_type  | Link:DocType        | required | source=sender  | Party type",
	"@param  party       | Dynamic:party_type  | required | source=sender  | Party",
	"@param  doc_name    | Data                | required |                | Document",
	"@param  days        | Int                 | optional |                | Days",
	"@param  since       | Date                | optional |                | Since",
	"@reply  result_text  | text |  | Result",
]
TYPED_BODY = """form = frappe.form_dict
doc_name = form.get("doc_name") or ""
if doc_name == "NOPE-1":
    frappe.flags.wa_result = {"error": "Document NOPE-1 not found", "messages": [], "data": {}}
else:
    frappe.flags.wa_result = {
        "error": None,
        "messages": [{"reply": "result_text", "type": "text", "text": "doc " + doc_name + " of " + (form.get("party") or "")}],
        "data": {"days": form.get("days"), "since": form.get("since"), "party": form.get("party")},
    }
"""

# the acceptance function: a date range picked by a Select, a language, a text and a report reply
SPAN_REPORT = "_Test WA Statement"
SPAN_LINES = [
	"@param  party_type  | Link:DocType        | required | source=sender | Party type",
	"@param  party       | Dynamic:party_type  | required | source=sender | Party",
	"@param  timespan    | Select              | optional | default=this month | Time span",
	"@options timespan | today, this month, select date range",
	"@param  from_date   | Date | required | depends_on=timespan:select date range | From date",
	"@param  to_date     | Date | required | depends_on=timespan:select date range | To date",
	"@param  language    | Select | optional | default=@system_language | Language",
	"@options language | ar, en",
	"@param  msg_result  | Template | optional |  | Result message",
	"",
	"@default msg_result",
	"> رصيد {{ party }} {{ span }}",
	"@default msg_result en",
	"> Balance of {{ party }} {{ span }}",
	"",
	"@var  party | msg_result | The sender's party",
	"@var  span  | msg_result | The period",
	"@reply  result_text | text   |  | Result",
	f"@reply  statement   | report | report={SPAN_REPORT} | Statement",
]
SPAN_BODY = """form = frappe.form_dict
span = form.get("timespan") or ""
if span == "select date range":
    span = str(form.get("from_date")) + ".." + str(form.get("to_date"))
ctx = {"party": form.get("party") or "", "span": span}
frappe.flags.wa_result = {
    "error": None,
    "messages": [
        {"reply": "result_text", "type": "text", "text": frappe.render_template(form.get("msg_result") or "{{ party }}", ctx).strip()},
        {"reply": "statement", "type": "report", "filters": {"party": form.get("party")}, "file_name": "statement"},
    ],
    "data": {
        "party_type": form.get("party_type"),
        "party": form.get("party"),
        "timespan": form.get("timespan"),
        "from_date": form.get("from_date"),
        "to_date": form.get("to_date"),
        "language": form.get("language"),
        "user": frappe.session.user,
    },
}
"""

MISBEHAVE_LINES = [
	"@param  mode | Select | optional | default=ok | Mode",
	"@options mode | ok, bad_reply, bad_report, error, raise, none",
	"@reply  result_text | text   |  | Result",
	"@reply  sheet       | report | report=_Test WA Sheet, format=Excel | Sheet",
]
MISBEHAVE_BODY = """mode = frappe.form_dict.get("mode") or "ok"
messages = [{"reply": "result_text", "type": "text", "text": "fine"}]
if mode == "bad_reply":
    messages.append({"reply": "surprise", "type": "text", "text": "not declared"})
if mode == "bad_report":
    messages.append({"reply": "sheet", "type": "report", "report_name": "General Ledger"})
if mode == "raise":
    frappe.throw("boom")
if mode != "none":
    frappe.flags.wa_result = {"error": "Nothing for you" if mode == "error" else None, "messages": messages, "data": {"mode": mode}}
"""

ASON_LINES = [
	"@param  as_on | Date | optional |  | As on",
	"@reply  result_text | text |  | Result",
]
ASON_BODY = """frappe.flags.wa_result = {"error": None, "messages": [{"reply": "result_text", "type": "text", "text": "as on " + str(frappe.form_dict.get("as_on"))}], "data": {}}
"""

NEEDED_REPORT = "_Test WA Needed Report"
NEEDS_LINES = [
	f"@requires report | {NEEDED_REPORT}",
	"@reply  result_text | text |  | Result",
]
OK_BODY = """frappe.flags.wa_result = {"error": None, "messages": [{"reply": "result_text", "type": "text", "text": "ok"}], "data": {}}
"""

# {function key: (script name, source)}
FUNCTIONS: dict[str, tuple[str, str]] = {
	"_test_echo": ("wa_fn__test_echo", source("_test_echo", ECHO_LINES, ECHO_BODY, title="Test Echo")),
	"_test_typed": (
		"wa_fn__test_typed",
		source("_test_typed", TYPED_LINES, TYPED_BODY, title="Test Typed", party_types="Customer, Supplier"),
	),
	"_test_span": (
		"wa_fn__test_span",
		source("_test_span", SPAN_LINES, SPAN_BODY, title="Test Span", party_types="Customer"),
	),
	"_test_misbehave": ("wa_fn__test_misbehave", source("_test_misbehave", MISBEHAVE_LINES, MISBEHAVE_BODY)),
	"_test_ason": ("wa_fn__test_ason", source("_test_ason", ASON_LINES, ASON_BODY, title="Test As On")),
	"_test_needs": ("wa_fn__test_needs", source("_test_needs", NEEDS_LINES, OK_BODY)),
}


# ---- making and removing them ---------------------------------------------------------------------

_CLEANUP_REGISTERED: list[bool] = []


def _register_cleanup() -> None:
	if not _CLEANUP_REGISTERED:
		unittest.addModuleCleanup(drop_all)
		_CLEANUP_REGISTERED.append(True)


def ensure_script(name: str, script: str, *, api_method: str | None = None, disabled: int = 0) -> str:
	"""Create (or bring up to date) the API Server Script `name` (a `wa_fn__test_` name); it and
	everything bound to it are removed when the test module ends."""
	assert name.startswith(SCRIPT_PREFIX), f"fixture scripts are named {SCRIPT_PREFIX}…"
	_register_cleanup()
	from whatsapp_next.services import functions_catalog

	values = {"script_type": "API", "api_method": api_method or name, "script": script, "disabled": disabled}
	if frappe.db.exists("Server Script", name):
		doc = frappe.get_doc("Server Script", name)
		if any(doc.get(k) != v for k, v in values.items()):
			doc.update(values)
			doc.save(ignore_permissions=True)
	else:
		doc = frappe.get_doc({"doctype": "Server Script", "name": name, "__newname": name, **values})
		doc.insert(ignore_permissions=True)
	functions_catalog.clear_cache()
	return doc.name


def ensure_function(key: str, *, status: str = "Active") -> str:
	"""The fixture function `key` (see `FUNCTIONS`): its script made and the function installed."""
	from whatsapp_next.services import functions_catalog

	name, script = FUNCTIONS[key]
	ensure_script(name, script)
	if not frappe.db.exists("WhatsApp Function", key):
		functions_catalog.install(name)
	elif frappe.db.get_value("WhatsApp Function", key, "manifest_checksum") != _checksum(script):
		functions_catalog.update(key)
	if frappe.db.get_value("WhatsApp Function", key, "status") != status:
		frappe.db.set_value("WhatsApp Function", key, "status", status)
	return key


def _checksum(script: str) -> str:
	from whatsapp_next.services.function_header import header_checksum

	return header_checksum(script)


def make_command(code: str, function: str, *, status: str = "Active", **values) -> str:
	"""A test command on fixture `function` (`code` unique to the test module); unless `values`
	says otherwise it does not require a linked contact."""
	from whatsapp_next.services import command_router

	assert function.startswith(KEY_PREFIX)
	if frappe.db.exists("WhatsApp Command", code):
		frappe.delete_doc("WhatsApp Command", code, ignore_permissions=True, force=True)
	doc = frappe.get_doc(
		{
			"doctype": "WhatsApp Command",
			"code": code,
			"function": function,
			"status": status,
			"requires_linked_contact": 0,
			**values,
		}
	)
	doc.insert(ignore_permissions=True)
	command_router.clear_map()
	return doc.name


def ensure_service_user() -> str:
	"""An enabled System User with no role, the command service user of the tests."""
	if not frappe.db.exists("User", SERVICE_USER):
		u = frappe.get_doc(
			{
				"doctype": "User",
				"email": SERVICE_USER,
				"first_name": "WA Fn Svc",
				"user_type": "System User",
				"enabled": 1,
				"send_welcome_email": 0,
			}
		)
		u.flags.no_welcome_mail = True
		u.insert(ignore_permissions=True)
		frappe.db.delete("Has Role", {"parent": SERVICE_USER, "parenttype": "User"})
	frappe.clear_cache(user=SERVICE_USER)
	return SERVICE_USER


def fixture_functions() -> list[str]:
	return [n for n in frappe.get_all("WhatsApp Function", pluck="name") if n.startswith(KEY_PREFIX)]


def fixture_scripts() -> list[str]:
	return [
		n
		for n in frappe.get_all("Server Script", filters={"name": ("like", "wa_fn%")}, pluck="name")
		if n.startswith(SCRIPT_PREFIX)
	]


def drop_commands() -> None:
	"""The commands bound to fixture functions (never one bound to a real function)."""
	from whatsapp_next.services import command_router

	functions = set(fixture_functions())
	for row in frappe.get_all("WhatsApp Command", fields=["name", "function"]):
		if row.function in functions or (row.function or "").startswith(KEY_PREFIX):
			frappe.delete_doc("WhatsApp Command", row.name, ignore_permissions=True, force=True)
	command_router.clear_map()


def drop_all() -> None:
	"""Module cleanup: fixture commands, functions, their audit rows and the `wa_fn__test_` scripts."""
	from whatsapp_next.services import functions_catalog

	_CLEANUP_REGISTERED.clear()
	drop_commands()
	functions = fixture_functions()
	for name in functions:
		frappe.delete_doc("WhatsApp Function", name, ignore_permissions=True, force=True)
	for row in frappe.get_all(
		"WhatsApp Audit Log",
		filters={"reference_doctype": "WhatsApp Function"},
		fields=["name", "reference_name"],
	):
		if (row.reference_name or "").startswith(KEY_PREFIX):
			frappe.delete_doc("WhatsApp Audit Log", row.name, ignore_permissions=True, force=True)
	for name in fixture_scripts():
		frappe.delete_doc("Server Script", name, ignore_permissions=True, force=True)
	for report in (NEEDED_REPORT,):
		if frappe.db.exists("Report", report):
			frappe.delete_doc("Report", report, ignore_permissions=True, force=True)
	functions_catalog.clear_cache()
	frappe.db.commit()

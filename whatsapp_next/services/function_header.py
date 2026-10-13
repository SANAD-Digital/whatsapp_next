# Module role: the WA-FUNCTION header of a function's Server Script (WHATSAPP_NEXT_INTEGRATION §2,
# §11). Reads the comment block at the top of the script into a `spec`, and answers the questions the
# Functions Center and the command router ask of it: is the function available on this site
# (`@requires`), may this party type use it (`@party_types`), which values does a run get
# (`build_params`), which values may a message template use (`vars_for`) and are the messages a run
# returned the ones the header declared (`validate_messages`). Same rules as the WA Function Tester
# (the reference implementation); errors carry the header line they come from.

from __future__ import annotations

import hashlib
from typing import Any

import frappe
from frappe import _
from frappe.utils import add_days, cint, get_first_day, get_year_start, getdate, nowdate

BEGIN = "WA-FUNCTION"
END = "END WA-FUNCTION"
FIELDTYPES = ("Link", "Dynamic", "Date", "Check", "Int", "Data", "Select", "Template")
REPLY_TYPES = ("text", "report")
REQUIRE_KINDS = ("report", "doctype", "app")
SOURCES = ("sender", "command")
# a Server Script whose API method starts with this prefix is a function; its guard refuses the
# direct URL by the same prefix (§7)
API_PREFIX = "wa_fn_"


class HeaderError(ValueError):
	"""A header the parser cannot read; the message names the line."""


def _at(line_no: int | None) -> str:
	return _(" (line {0})").format(line_no) if line_no else ""


def _kv(options: str, line_no: int) -> dict[str, str]:
	out: dict[str, str] = {}
	for item in options.split(","):
		item = item.strip()
		if not item:
			continue
		if "=" not in item:
			raise HeaderError(_("Invalid option «{0}»").format(item) + _at(line_no))
		key, _sep, value = item.partition("=")
		out[key.strip()] = value.strip()
	return out


def header_block(script: str | None) -> list[tuple[int, str]]:
	"""The header's lines as `(line number, text without #)`, between `WA-FUNCTION` and
	`END WA-FUNCTION`. E: `HeaderError`."""
	lines: list[tuple[int, str]] = []
	inside = found = ended = False
	for line_no, raw in enumerate((script or "").splitlines(), start=1):
		st = raw.strip()
		if not st.startswith("#"):
			if inside:
				raise HeaderError(_("A line inside the header is not a comment") + _at(line_no))
			continue
		text = st.lstrip("#").strip()
		if END in text:
			if not inside:
				raise HeaderError(_("Header end without a beginning") + _at(line_no))
			ended = True
			break
		if BEGIN in text:
			inside = found = True
			continue
		if inside and text:
			lines.append((line_no, text))
	if not found:
		raise HeaderError(_("No WA-FUNCTION block at the top of the script"))
	if not ended:
		raise HeaderError(_("The header has no END WA-FUNCTION line"))
	return lines


def header_text(script: str | None) -> str:
	"""The header block's text, for its checksum."""
	return "\n".join(text for _no, text in header_block(script))


def header_checksum(script: str | None) -> str:
	"""sha256 of the header: a change in the header (not in the code below it) is an update."""
	return hashlib.sha256(header_text(script).encode("utf-8")).hexdigest()


def parse_function_header(script: str | None) -> dict[str, Any]:
	"""The header as a spec: `{function, title, version, description, party_types{mode, types},
	requires[], params[], replies[], vars[]}`. Each param: `{name, fieldtype, options, required,
	source, default, defaults_by_lang{}, label, select_options, depends_on}`. E: `HeaderError`."""
	spec: dict[str, Any] = {
		"function": None,
		"title": None,
		"version": None,
		"description": None,
		"party_types": {"mode": "all", "types": []},
		"requires": [],
		"params": [],
		"replies": [],
		"vars": [],
	}
	by_name: dict[str, dict[str, Any]] = {}
	current: tuple[str, str | None] | None = None  # the @default being read: (param, language)

	for line_no, text in header_block(script):
		if text.startswith("-"):  # a section rule
			current = None
			continue
		if text.startswith(">"):
			if current is None:
				raise HeaderError(_("A > line without an @default before it") + _at(line_no))
			chunk = text[1:]
			if chunk.startswith(" "):
				chunk = chunk[1:]
			param, lang = current
			p = by_name[param]
			if lang:
				before = p["defaults_by_lang"].get(lang)
				p["defaults_by_lang"][lang] = chunk if before is None else before + "\n" + chunk
			else:
				p["default"] = chunk if p["default"] is None else p["default"] + "\n" + chunk
			continue
		current = None
		if not text.startswith("@"):
			raise HeaderError(_("Unreadable header line") + _at(line_no) + ": " + text)
		tag, _sep, value = text[1:].partition(" ")
		tag, value = tag.strip(), value.strip()

		if tag in ("function", "title", "version", "description"):
			spec[tag] = value
		elif tag == "party_types":
			low = value.lower()
			if low == "all":
				spec["party_types"] = {"mode": "all", "types": []}
			elif low.startswith("all except"):
				types = [t.strip() for t in value[len("all except") :].split(",") if t.strip()]
				spec["party_types"] = {"mode": "except", "types": types}
			else:
				spec["party_types"] = {
					"mode": "only",
					"types": [t.strip() for t in value.split(",") if t.strip()],
				}
		elif tag == "requires":
			kind, bar, name = value.partition("|")
			kind, name = kind.strip().lower(), name.strip()
			if not bar or kind not in REQUIRE_KINDS or not name:
				raise HeaderError(_("@requires takes report|doctype|app | <name>") + _at(line_no))
			spec["requires"].append({"kind": kind, "name": name})
		elif tag == "param":
			cols = [c.strip() for c in value.split("|")]
			if len(cols) != 5:
				raise HeaderError(_("@param takes 5 columns separated by |") + _at(line_no))
			name, fieldtype, required, options, label = cols
			if required not in ("required", "optional"):
				raise HeaderError(_("The third column is required or optional") + _at(line_no))
			if name in by_name:
				raise HeaderError(_("Parameter «{0}» is declared twice").format(name) + _at(line_no))
			opts = _kv(options, line_no)
			ftype, _sep, ftarget = fieldtype.partition(":")
			if ftype not in FIELDTYPES:
				raise HeaderError(_("Unknown field type «{0}»").format(ftype) + _at(line_no))
			source = opts.get("source", "command")
			if source not in SOURCES:
				raise HeaderError(_("source is sender or command") + _at(line_no))
			dep = None
			if opts.get("depends_on"):
				dp, colon, dv = opts["depends_on"].partition(":")
				if not colon:
					raise HeaderError(_("depends_on takes <parameter>:<value>") + _at(line_no))
				if dp.strip() not in by_name:
					raise HeaderError(_("depends_on names a parameter not declared before it") + _at(line_no))
				dep = {"param": dp.strip(), "value": dv.strip().lower()}
			p = {
				"name": name,
				"fieldtype": ftype,
				"options": ftarget or None,
				"required": required == "required",
				"source": source,
				"default": opts.get("default"),
				"defaults_by_lang": {},
				"label": label,
				"select_options": None,
				"depends_on": dep,
			}
			spec["params"].append(p)
			by_name[name] = p
		elif tag == "options":
			param, _bar, values = value.partition("|")
			if param.strip() not in by_name:
				raise HeaderError(_("@options for a parameter not declared") + _at(line_no))
			by_name[param.strip()]["select_options"] = [o.strip() for o in values.split(",") if o.strip()]
		elif tag == "default":
			param, _sp, lang = value.partition(" ")
			if param not in by_name:
				raise HeaderError(_("@default for a parameter not declared") + _at(line_no))
			current = (param, lang.strip() or None)
		elif tag == "var":
			cols = [c.strip() for c in value.split("|")]
			if len(cols) == 2:
				cols = [cols[0], "all", cols[1]]
			if len(cols) != 3:
				raise HeaderError(_("@var takes 3 columns") + _at(line_no))
			spec["vars"].append(
				{
					"name": cols[0],
					"label": cols[2],
					"messages": [m.strip() for m in cols[1].split(",") if m.strip()],
				}
			)
		elif tag == "reply":
			cols = [c.strip() for c in value.split("|")]
			if len(cols) != 4 or cols[1] not in REPLY_TYPES:
				raise HeaderError(_("@reply takes key | text/report | options | title") + _at(line_no))
			opts = _kv(cols[2], line_no)
			if cols[1] == "report" and not opts.get("report"):
				raise HeaderError(_("A report reply needs report=<report name>") + _at(line_no))
			spec["replies"].append(
				{
					"key": cols[0],
					"type": cols[1],
					"report_name": opts.get("report"),
					"format": opts.get("format") or ("PDF" if cols[1] == "report" else None),
					"label": cols[3],
				}
			)
		else:
			raise HeaderError(_("Unknown tag @{0}").format(tag) + _at(line_no))

	if not spec["function"]:
		raise HeaderError(_("The header has no @function"))
	for p in spec["params"]:
		if p["fieldtype"] == "Select" and not p["select_options"]:
			raise HeaderError(_("Parameter «{0}» is a Select without @options").format(p["name"]))
	keys = [r["key"] for r in spec["replies"]]
	if len(keys) != len(set(keys)):
		raise HeaderError(_("A @reply key is declared twice"))
	return spec


# ---- what the header asks of the site and of the sender -------------------------------------


def function_availability(spec: dict[str, Any]) -> tuple[bool, list[str]]:
	"""`(available, reasons)` from `@requires`: every report enabled, every DocType and app present."""
	reasons: list[str] = []
	for r in spec.get("requires") or []:
		if r["kind"] == "report" and not frappe.db.exists("Report", {"name": r["name"], "disabled": 0}):
			reasons.append(_("Report «{0}» is missing or disabled").format(r["name"]))
		elif r["kind"] == "doctype" and not frappe.db.exists("DocType", r["name"]):
			reasons.append(_("DocType «{0}» is missing").format(r["name"]))
		elif r["kind"] == "app" and r["name"] not in frappe.get_installed_apps():
			reasons.append(_("App «{0}» is not installed").format(r["name"]))
	return (not reasons, reasons)


def party_type_allowed(spec: dict[str, Any], party_type: str | None) -> bool:
	"""Whether `@party_types` lets a sender of `party_type` use the function."""
	rule = spec.get("party_types") or {"mode": "all", "types": []}
	if rule["mode"] == "all":
		return True
	if not party_type:
		return False
	if rule["mode"] == "except":
		return party_type not in rule["types"]
	return party_type in rule["types"]


def party_types_text(spec: dict[str, Any]) -> str:
	"""`@party_types` as one line: «all», «all except A, B» or «A, B»."""
	rule = spec.get("party_types") or {"mode": "all", "types": []}
	if rule["mode"] == "all":
		return _("All")
	types = ", ".join(_(t) for t in rule["types"])
	return _("All except {0}").format(types) if rule["mode"] == "except" else types


def command_params(spec: dict[str, Any]) -> list[dict[str, Any]]:
	"""The parameters a command or the site sets (not the sender's party)."""
	return [p for p in spec.get("params") or [] if p["source"] != "sender"]


def typed_params(spec: dict[str, Any]) -> list[dict[str, Any]]:
	"""The parameters a sender may give in the message text: never the party (it comes from the
	Contact) and never a message template (Jinja is the site's, not the sender's)."""
	return [p for p in command_params(spec) if p["fieldtype"] != "Template"]


def param(spec: dict[str, Any], name: str) -> dict[str, Any] | None:
	return next((p for p in spec.get("params") or [] if p["name"] == name), None)


def vars_for(spec: dict[str, Any], template_param: str) -> list[dict[str, Any]]:
	"""The `@var` values a message template may use: those for every message and those for it."""
	return [v for v in spec.get("vars") or [] if "all" in v["messages"] or template_param in v["messages"]]


# ---- the values of one run -------------------------------------------------------------------


def resolve_date(value: Any):
	"""A date or a date word: today, yesterday, week_start, month_start, year_start, ±Nd."""
	v = str(value).strip().lower()
	today = getdate(nowdate())
	if v in ("today", "اليوم"):
		return today
	if v in ("yesterday", "أمس", "امس"):
		return add_days(today, -1)
	if v == "week_start":
		return add_days(today, -((today.weekday() - 5) % 7))
	if v == "month_start":
		return get_first_day(today)
	if v == "year_start":
		return get_year_start(today)
	if v.endswith("d") and v[:-1].lstrip("-").isdigit():
		return add_days(today, int(v[:-1]))
	return getdate(value)


def current_fiscal_year(company: str | None) -> str | None:
	"""The fiscal year today falls in, for `company` (a year with no companies is everyone's)."""
	fy = frappe.qb.DocType("Fiscal Year")
	today = getdate(nowdate())
	rows = (
		frappe.qb.from_(fy)
		.select(fy.name)
		.where((fy.disabled == 0) & (fy.year_start_date <= today) & (fy.year_end_date >= today))
		.orderby(fy.year_start_date, order=frappe.qb.desc)
		.run(as_dict=True)
	)
	for row in rows:
		companies = frappe.get_all("Fiscal Year Company", filters={"parent": row.name}, pluck="company")
		if not companies or (company and company in companies):
			return row.name
	return None


def resolve_default(default: str, params: dict[str, Any], language: str | None = None) -> Any:
	"""A default as written in the header: a symbol (`@default_company`, `@current_fiscal_year`,
	`@system_language`, `@param:<name>`) or the value itself."""
	if default == "@default_company":
		return frappe.db.get_single_value("Global Defaults", "default_company")
	if default == "@current_fiscal_year":
		return current_fiscal_year(params.get("company"))
	if default == "@system_language":
		lang = language or frappe.db.get_single_value("System Settings", "language") or "en"
		return str(lang).split("-")[0]
	if default.startswith("@param:"):
		return params.get(default.split(":", 1)[1])
	return default


def template_default(p: dict[str, Any], language: str | None) -> str | None:
	"""A message template's default for `language`: `@default <param> <language>`, else `@default <param>`."""
	by_lang = p.get("defaults_by_lang") or {}
	if language and by_lang.get(language) is not None:
		return by_lang[language]
	if language and "-" in language and by_lang.get(language.split("-")[0]) is not None:
		return by_lang[language.split("-")[0]]
	return p.get("default")


def is_empty(value: Any) -> bool:
	return value is None or (isinstance(value, str) and not value.strip())


def coerce(p: dict[str, Any], value: Any) -> Any:
	"""A value in the parameter's type. E: `ValueError` with a message for the sender."""
	ftype = p["fieldtype"]
	if ftype == "Date":
		try:
			return str(resolve_date(value))
		except Exception as exc:
			raise ValueError(_("{0} must be a date").format(p["label"])) from exc
	if ftype == "Check":
		return 1 if str(value).strip().lower() in ("1", "true", "yes", "نعم", "on") else 0
	if ftype == "Int":
		text = str(value).strip()
		if not text.lstrip("-").isdigit():
			raise ValueError(_("{0} must be a whole number").format(p["label"]))
		return cint(text)
	if ftype == "Select":
		text = str(value).strip().lower()
		if text not in [o.lower() for o in p["select_options"] or []]:
			raise ValueError(_("«{0}» is not an allowed value for {1}").format(value, p["label"]))
		return text
	if ftype == "Link" and p.get("options"):
		text = str(value).strip()
		if not frappe.db.exists(p["options"], text):
			raise ValueError(_("{0} {1} not found").format(_(p["options"]), text))
		return text
	return value if ftype == "Template" else str(value).strip()


def build_params(
	spec: dict[str, Any], sender: Any, values: dict[str, Any] | None, language: str | None = None
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
	"""`(params, missing)` for one run. `values` are already merged by priority (what the sender
	gave → the command's overrides → the function's site values); the party always comes from
	`sender` (`party_type`, `party_name`) whatever `values` says. A parameter whose `depends_on`
	does not hold is left out; an empty one takes its default (a template its default in the run's
	language). `missing` lists required parameters still empty: `{name, label, source}`.
	E: `ValueError` for a value of the wrong type or not allowed."""
	values = values or {}
	params: dict[str, Any] = {}
	missing: list[dict[str, Any]] = []
	party_type = getattr(sender, "party_type", None) if sender is not None else None
	party = getattr(sender, "party_name", None) if sender is not None else None
	for p in spec.get("params") or []:
		name = p["name"]
		dep = p["depends_on"]
		if dep and str(params.get(dep["param"]) or "").strip().lower() != dep["value"]:
			continue
		if p["source"] == "sender":
			value = party_type if name == "party_type" else party if name == "party" else None
		else:
			value = values.get(name)
		if is_empty(value):
			if p["fieldtype"] == "Template":
				value = template_default(p, params.get("language") or language)
			elif p["default"]:
				value = resolve_default(p["default"], params, language)
		if not is_empty(value):
			value = coerce(p, value)
		if is_empty(value):
			if p["required"]:
				missing.append({"name": name, "label": p["label"], "source": p["source"]})
			continue
		params[name] = value
	return params, missing


def validate_messages(
	spec: dict[str, Any], messages: list[dict[str, Any]] | None, disabled: list[str] | set[str] | None = None
) -> list[dict[str, Any]]:
	"""The messages a run returned, checked against `@reply`: every one declared, a text not empty,
	a report only the declared one. A reply the command switched off (`disabled`) is dropped.
	E: `ValueError` naming the message — nothing is sent when one is wrong."""
	declared = {r["key"]: r for r in spec.get("replies") or []}
	off = set(disabled or ())
	ready: list[dict[str, Any]] = []
	for i, msg in enumerate(messages or [], start=1):
		if not isinstance(msg, dict):
			raise ValueError(_("Message {0} is not an object").format(i))
		reply = declared.get(msg.get("reply"))
		if not reply:
			raise ValueError(
				_("Message {0}: reply «{1}» is not declared in the header").format(i, msg.get("reply"))
			)
		if reply["key"] in off:
			continue
		if reply["type"] == "text":
			text = str(msg.get("text") or "").strip()
			if not text:
				raise ValueError(_("Message {0}: the text is empty").format(i))
			ready.append({"reply": reply["key"], "type": "text", "text": text})
			continue
		report_name = msg.get("report_name") or reply["report_name"]
		if report_name != reply["report_name"]:
			raise ValueError(_("Message {0}: report «{1}» is not declared").format(i, report_name))
		filters = msg.get("filters") or {}
		if not isinstance(filters, dict):
			raise ValueError(_("Message {0}: the report filters are not an object").format(i))
		ready.append(
			{
				"reply": reply["key"],
				"type": "report",
				"report_name": report_name,
				"filters": filters,
				"format": msg.get("format") or reply["format"],
				"file_name": msg.get("file_name") or report_name,
				"caption": msg.get("caption") or "",
			}
		)
	return ready


def guard_present(script: str | None, lines: int = 40) -> bool:
	"""Whether the code right after the header refuses the direct URL (§7): a line that tests
	`startswith("wa_fn_")` within the first `lines` lines after `END WA-FUNCTION`."""
	text = script or ""
	end = text.find(END)
	if end < 0:
		return False
	after = text[end:].splitlines()[1 : lines + 1]
	return any(f'startswith("{API_PREFIX}")' in ln or f"startswith('{API_PREFIX}')" in ln for ln in after)

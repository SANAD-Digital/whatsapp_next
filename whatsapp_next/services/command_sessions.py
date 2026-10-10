# Module role: asking for a command's missing inputs over WhatsApp, one at a time.
#
# When a matched command lacks an input it needs — a required one, or one the command lists in
# `ask_inputs` — the router does not run it. It keeps a short session for that chat (cache,
# SESSION_TTL) and sends a question shaped by the input's type: a list of date presets, the
# command's own choices, or a request to type the value. The sender's next message — a tap or
# text — fills the input; the next one is asked, and once all are in the command runs. "إلغاء" /
# "cancel" ends the session. Dates accept relative words (today, month_start, -3m …) resolved
# when the answer arrives, so a list sent in a campaign stays right whenever it is tapped.

from __future__ import annotations

import json
import re
from typing import Any

import frappe
from frappe import _
from frappe.utils import add_days, add_months, cstr, get_first_day, get_last_day, getdate, nowdate

SESSION_TTL = 600  # seconds a chat has to answer
ARG_PREFIX = "__arg__:"
TYPE_IT = "__type__"
CANCEL = "__cancel__"
CANCEL_WORDS = {"إلغاء", "الغاء", "إلغاء الأمر", "cancel", "stop", CANCEL}

_REL_RE = re.compile(r"^([+-]\d+)\s*([dwmy])$", re.I)


def relative_date(value: str):
	"""A date word or offset → a date, else `None`: today, yesterday, month_start, month_end,
	last_month_start, last_month_end, year_start, year_end, and ±N d/w/m/y (`-7d`, `-3m`)."""
	word = cstr(value).strip().lower().replace(" ", "_")
	today = getdate(nowdate())
	if word in ("today", "اليوم"):
		return today
	if word in ("yesterday", "أمس", "امس"):
		return add_days(today, -1)
	if word == "month_start":
		return get_first_day(today)
	if word == "month_end":
		return get_last_day(today)
	if word == "last_month_start":
		return get_first_day(add_months(today, -1))
	if word == "last_month_end":
		return get_last_day(add_months(today, -1))
	if word == "year_start":
		return today.replace(month=1, day=1)
	if word == "year_end":
		return today.replace(month=12, day=31)
	m = _REL_RE.match(word)
	if m:
		n, unit = int(m.group(1)), m.group(2).lower()
		if unit == "d":
			return add_days(today, n)
		if unit == "w":
			return add_days(today, 7 * n)
		if unit == "m":
			return add_months(today, n)
		return add_months(today, 12 * n)
	return None


def ask_specs(command) -> dict[str, list[tuple[str, str]]]:
	"""`ask_inputs` of the command: one input per line, `key` or `key: v1, v2=Label, …` →
	`{key: [(value, label), …]}` (an empty list when no choices are given)."""
	out: dict[str, list[tuple[str, str]]] = {}
	for line in cstr(command.get("ask_inputs")).splitlines():
		if not line.strip():
			continue
		key, _sep, rest = line.partition(":")
		choices = []
		for part in rest.split(","):
			part = part.strip()
			if not part:
				continue
			value, _eq, label = part.partition("=")
			choices.append((value.strip(), (label or value).strip()))
		out[key.strip()] = choices
	return out


def missing_inputs(command, inputs: list[dict[str, Any]], provided: dict[str, Any]) -> list[str]:
	"""Keys still to ask, in the inputs' order: required ones and the ones in `ask_inputs`."""
	asked = ask_specs(command)
	keys = []
	for spec in sorted(inputs, key=lambda i: int(i.get("position") or 99)):
		key = spec["key"]
		if key in provided:
			continue
		if spec.get("required") or key in asked:
			keys.append(key)
	return keys


# ---- the session --------------------------------------------------------------------------


def _cache_key(device: str | None, chat: str | None) -> str:
	return f"wa:cmd-session:{device or '-'}:{chat or '-'}"


def chat_key(inbound) -> str | None:
	get = inbound.get if hasattr(inbound, "get") else lambda k: getattr(inbound, k, None)
	return get("phone_e164") or get("sender_jid") or get("jid")


def load(device: str | None, chat: str | None) -> dict[str, Any] | None:
	raw = frappe.cache.get_value(_cache_key(device, chat))
	if not raw:
		return None
	try:
		return json.loads(raw) if isinstance(raw, str) else raw
	except ValueError:
		return None


def save(device: str | None, chat: str | None, session: dict[str, Any]) -> None:
	frappe.cache.set_value(_cache_key(device, chat), json.dumps(session, default=str), expires_in_sec=SESSION_TTL)


def clear(device: str | None, chat: str | None) -> None:
	frappe.cache.delete_value(_cache_key(device, chat))


# ---- questions -----------------------------------------------------------------------------

DATE_PRESETS = (
	("today", "Today"),
	("yesterday", "Yesterday"),
	("month_start", "Start of this month"),
	("last_month_end", "End of last month"),
	("last_month_start", "Start of last month"),
	("year_start", "Start of this year"),
)


def _label(spec: dict[str, Any]) -> str:
	return _(spec.get("label") or spec["key"])


def options(command, spec: dict[str, Any]) -> list[tuple[str, str]]:
	"""The ready answers offered for an input, `[(value, label)]`: the command's own choices, or
	the date presets for a date input without them."""
	choices = ask_specs(command).get(spec["key"]) or []
	if not choices and (spec.get("type") or "str").lower() == "date":
		return [(v, _(t)) for v, t in DATE_PRESETS]
	return choices


def text_question(command, spec: dict[str, Any]) -> dict[str, Any]:
	"""The same question as plain text, for a plan without buttons and lists: the ready answers
	numbered, answered by their number (`numbered_answer`) or by typing the value."""
	label = _label(spec)
	kind = (spec.get("type") or "str").lower()
	lines = [_("Choose {0}").format(label) if options(command, spec) else _("Type {0}").format(label)]
	lines += [f"{i}. {t}" for i, (_v, t) in enumerate(options(command, spec), start=1)]
	hint = _("e.g. 2026-10-31") if kind == "date" else _("a number") if kind == "int" else ""
	if options(command, spec):
		lines.append(_("Reply with the option number, or type another value") + (f" ({hint})" if hint else ""))
	elif hint:
		lines[0] += f" ({hint})"
	lines.append(_("Send «{0}» to stop.").format(_("Cancel")))
	return {"output_key": "prompt", "message_type": "Text", "body": "\n".join(lines), "attachment": None}


def numbered_answer(command, spec: dict[str, Any], raw: str) -> str:
	"""A typed answer to `text_question`: an option's number or label becomes its value; anything
	else is kept as typed."""
	answer = cstr(raw).strip()
	offered = options(command, spec)
	for value, label in offered:
		if answer.casefold() == cstr(label).strip().casefold():
			return value
	if answer.isdigit() and 1 <= int(answer) <= len(offered):
		return offered[int(answer) - 1][0]
	return answer


def question(command, spec: dict[str, Any]) -> dict[str, Any]:
	"""The reply asking for one input: a list (dates, or more than three choices), buttons (up to
	three choices), or buttons with a typed answer expected (text, numbers without choices). A plan
	without buttons and lists gets `text_question` instead."""
	from whatsapp_next.services import plan_features

	if not plan_features.interactive():
		return text_question(command, spec)
	label = _label(spec)
	kind = (spec.get("type") or "str").lower()
	choices = ask_specs(command).get(spec["key"]) or []
	title = _(command.get("title") or command.get("code") or "")
	if kind == "date" and not choices:
		rows = [{"id": ARG_PREFIX + v, "title": _(t)} for v, t in DATE_PRESETS]
		rows.append({"id": TYPE_IT, "title": _("Another date"), "description": _("Type it, e.g. 2026-10-31")})
		rows.append({"id": CANCEL, "title": _("Cancel")})
		return {
			"output_key": "prompt",
			"message_type": "List",
			"body": _("Choose {0}").format(label),
			"interactive": {"title": title, "text": _("Choose {0}").format(label), "button_text": _("Choose"), "sections": [{"title": label, "rows": rows}]},
			"attachment": None,
		}
	if choices:
		if len(choices) <= 2:
			buttons = [{"type": "reply", "id": ARG_PREFIX + v, "text": t} for v, t in choices]
			buttons.append({"type": "reply", "id": CANCEL, "text": _("Cancel")})
			return {
				"output_key": "prompt",
				"message_type": "Buttons",
				"body": _("Choose {0}").format(label),
				"interactive": {"title": title, "text": _("Choose {0}").format(label), "buttons": buttons},
				"attachment": None,
			}
		rows = [{"id": ARG_PREFIX + v, "title": t} for v, t in choices]
		rows.append({"id": TYPE_IT, "title": _("Another value"), "description": _("Type it")})
		rows.append({"id": CANCEL, "title": _("Cancel")})
		return {
			"output_key": "prompt",
			"message_type": "List",
			"body": _("Choose {0}").format(label),
			"interactive": {"title": title, "text": _("Choose {0}").format(label), "button_text": _("Choose"), "sections": [{"title": label, "rows": rows}]},
			"attachment": None,
		}
	hint = _("a number") if kind == "int" else _("a date, e.g. 2026-10-31") if kind == "date" else ""
	text = _("Type {0}").format(label) + (f" ({hint})" if hint else "")
	return {
		"output_key": "prompt",
		"message_type": "Buttons",
		"body": text,
		"interactive": {"title": title, "text": text, "buttons": [{"type": "reply", "id": CANCEL, "text": _("Cancel")}]},
		"attachment": None,
	}


def type_it(spec: dict[str, Any]) -> dict[str, Any]:
	"""After "another date / value": ask for it as text."""
	kind = (spec.get("type") or "str").lower()
	hint = _("e.g. 2026-10-31") if kind == "date" else _("a number") if kind == "int" else ""
	text = _("Type {0}").format(_label(spec)) + (f" ({hint})" if hint else "")
	return {"output_key": "prompt", "message_type": "Text", "body": text, "attachment": None}


def answer_of(inbound) -> tuple[str, str | None]:
	"""What the sender answered: `("cancel", None)`, `("type", None)`, or `("value", raw)`."""
	get = inbound.get if hasattr(inbound, "get") else lambda k: getattr(inbound, k, None)
	selected = cstr(get("selected_option_id")).strip()
	text = cstr(get("body")).strip()
	if selected == CANCEL or text.casefold() in {w.casefold() for w in CANCEL_WORDS}:
		return "cancel", None
	if selected == TYPE_IT:
		return "type", None
	if selected.startswith(ARG_PREFIX):
		return "value", selected[len(ARG_PREFIX) :]
	return "value", text

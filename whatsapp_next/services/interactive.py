# Module role: buttons and lists — the definition stored on a WhatsApp Log (`interactive`, JSON)
# and its validation. They travel in WhatsApp's interactive form, the only one its servers accept
# from a linked device; a recipient's tap comes back as an `Interactive Reply` inbound whose body
# is the tapped title (so keyword commands match it) and `selected_option_id` the id given here.

from __future__ import annotations

import json
import re
from typing import Any

import frappe
from frappe import _
from frappe.utils import cstr

from whatsapp_next.exceptions import WAValidationError

KINDS = {"Buttons": "buttons", "List": "list"}
BUTTON_TYPES = ("reply", "url", "call", "copy")
MAX_BUTTONS = 10
MAX_ROWS = 10
MAX_TEXT = 1024
MAX_SHORT = 60


def _slug(text: str, used: set[str]) -> str:
	base = re.sub(r"\s+", "_", cstr(text).strip().lower())[:40] or "option"
	slug, n = base, 2
	while slug in used:
		slug, n = f"{base}_{n}", n + 1
	used.add(slug)
	return slug


def _short(value: Any, label: str) -> str:
	value = cstr(value).strip()
	if len(value) > MAX_SHORT:
		frappe.throw(_("{0} is longer than {1} characters").format(label, MAX_SHORT), WAValidationError)
	return value


def parse(value: Any) -> dict[str, Any]:
	"""A buttons or list definition from a dict or JSON text; `{}` when there is none. Raises on invalid JSON."""
	if isinstance(value, dict):
		return value
	text = cstr(value).strip()
	if not text:
		return {}
	try:
		parsed = json.loads(text)
	except ValueError:
		frappe.throw(_("Buttons / list definition is not valid JSON"), WAValidationError)
	return parsed if isinstance(parsed, dict) else {}


def normalize(message_type: str, value: Any, body: str | None = None) -> dict[str, Any]:
	"""The stored definition of a `Buttons` / `List` message, validated:
	`{text, title, footer, buttons[{type, id, text, url, phone, code}]}` or
	`{text, title, footer, button_text, sections[{title, rows[{id, title, description}]}]}`.
	Missing ids are made from the titles (unique). E: `WAValidationError`."""
	if message_type not in KINDS:
		frappe.throw(_("Not a buttons or list message"), WAValidationError)
	data = parse(value)
	text = cstr(data.get("text") or body).strip()
	if not text:
		frappe.throw(_("Buttons and lists need a message text"), WAValidationError)
	if len(text) > MAX_TEXT:
		frappe.throw(_("The message text is longer than {0} characters").format(MAX_TEXT), WAValidationError)
	out: dict[str, Any] = {
		"text": text,
		"title": _short(data.get("title"), _("Title")),
		"footer": _short(data.get("footer"), _("Footer")),
	}
	used: set[str] = set()
	if message_type == "Buttons":
		buttons = []
		for b in data.get("buttons") or []:
			b = b if isinstance(b, dict) else {"text": b}
			kind = cstr(b.get("type") or "reply").strip().lower()
			if kind not in BUTTON_TYPES:
				frappe.throw(_("Unknown button type {0}").format(kind), WAValidationError)
			label = _short(b.get("text"), _("Button"))
			if not label:
				continue
			button = {"type": kind, "text": label, "id": cstr(b.get("id")).strip() or _slug(label, used)}
			if kind == "url":
				button["url"] = cstr(b.get("url")).strip()
				if not button["url"].startswith(("https://", "http://")):
					frappe.throw(_("Button {0} needs a web address").format(label), WAValidationError)
			elif kind == "call":
				button["phone"] = cstr(b.get("phone")).strip()
				if not button["phone"]:
					frappe.throw(_("Button {0} needs a phone number").format(label), WAValidationError)
			elif kind == "copy":
				button["code"] = cstr(b.get("code")).strip()
				if not button["code"]:
					frappe.throw(_("Button {0} needs the text to copy").format(label), WAValidationError)
			buttons.append(button)
		if not 1 <= len(buttons) <= MAX_BUTTONS:
			frappe.throw(_("Buttons need 1 to {0} buttons").format(MAX_BUTTONS), WAValidationError)
		out["buttons"] = buttons
	else:
		sections, rows_total = [], 0
		for s in data.get("sections") or []:
			s = s if isinstance(s, dict) else {}
			rows = []
			for r in s.get("rows") or []:
				r = r if isinstance(r, dict) else {"title": r}
				title = _short(r.get("title"), _("Option"))
				if not title:
					continue
				rows.append({"id": cstr(r.get("id")).strip() or _slug(title, used), "title": title, "description": _short(r.get("description"), _("Description"))})
			if rows:
				sections.append({"title": _short(s.get("title"), _("Section")), "rows": rows})
				rows_total += len(rows)
		if not 1 <= rows_total <= MAX_ROWS:
			frappe.throw(_("A list needs 1 to {0} options").format(MAX_ROWS), WAValidationError)
		out["button_text"] = _short(data.get("button_text"), _("List button")) or _("Options")
		out["sections"] = sections
	return out


def to_provider(message_type: str, value: Any) -> dict[str, Any]:
	"""The stored definition as the platform's `interactive` key (kind is the message type)."""
	data = parse(value)
	return {k: v for k, v in data.items() if v not in (None, "", [])}

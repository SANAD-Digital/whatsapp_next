# Module role: the main menu — the commands marked «Show in main menu», offered to the sender.
#
# Settings → Commands → Main menu (`main_menu_mode`) decides how:
#   Off                     nothing is added.
#   List after every reply  the menu list follows the replies.
#   Buttons on the reply    like WhatsApp Business: the last text reply carries buttons — the
#                           menu commands themselves when there are three or fewer, else one
#                           «Main menu» button that opens the list. A reply that cannot carry
#                           buttons (a file, a long text) is followed by a short buttons message.
# A row or button id is the command word, so a tap runs the command (`match_inbound`); MENU_ID or
# one of `main_menu_words` sends the list. A question waiting for an answer gets no menu.

from __future__ import annotations

from typing import Any

import frappe
from frappe import _
from frappe.utils import cint, cstr

MENU_ID = "__menu__"
MAX_BUTTONS = 3
MAX_ROWS = 10  # WhatsApp shows at most ten rows in a list
MAX_BODY = 1024  # longest text a buttons message carries


def mode() -> str:
	settings = frappe.get_cached_doc("WhatsApp Settings")
	if not cint(settings.enable_commands):
		return "Off"
	from whatsapp_next.services import plan_features

	if not plan_features.interactive():
		return "Off"
	return settings.get("main_menu_mode") or "Off"


def items() -> list[frappe._dict]:
	"""Active commands shown in the menu, in `menu_order` then title."""
	rows = frappe.get_all(
		"WhatsApp Command",
		filters={"status": "Active", "show_in_menu": 1},
		fields=["code", "title", "menu_description", "menu_order"],
		order_by="menu_order asc, title asc, code asc",
		limit=MAX_ROWS,
	)
	return [r for r in rows if (r.code or "").strip()]


def is_menu_request(inbound) -> bool:
	"""The «Main menu» button, or a message that is one of `main_menu_words`."""
	if mode() == "Off":
		return False
	get = inbound.get if hasattr(inbound, "get") else lambda k: getattr(inbound, k, None)
	if cstr(get("selected_option_id")).strip() == MENU_ID:
		return True
	words = frappe.get_cached_doc("WhatsApp Settings").get("main_menu_words") or ""
	text = cstr(get("body")).strip().casefold()
	return bool(text) and text in {w.strip().casefold() for w in words.splitlines() if w.strip()}


def _text() -> str:
	return frappe.get_cached_doc("WhatsApp Settings").get("main_menu_text") or _("How can we help?")


def _button() -> str:
	return (frappe.get_cached_doc("WhatsApp Settings").get("main_menu_button") or _("Main menu"))[:20]


def _title(row) -> str:
	return _(row.title or row.code)[:24]


def menu_list(output_key: str = "help") -> dict[str, Any] | None:
	"""The menu as a list message, or `None` when no command is in it. `output_key` decides how it
	is sent (a reply of its own goes at once, like help; one that follows replies goes with them)."""
	rows = items()
	if not rows:
		return None
	text = _text()
	return {
		"output_key": output_key,
		"is_menu": True,
		"message_type": "List",
		"body": text,
		"interactive": {
			"text": text,
			"button_text": _button(),
			"sections": [
				{
					"title": _button(),
					"rows": [
						{"id": r.code.strip(), "title": _title(r), "description": cstr(r.menu_description)[:72]}
						for r in rows
					],
				}
			],
		},
		"attachment": None,
	}


def _buttons(rows) -> list[dict[str, str]]:
	if len(rows) <= MAX_BUTTONS:
		return [{"type": "reply", "id": r.code.strip(), "text": _title(r)[:20]} for r in rows]
	return [{"type": "reply", "id": MENU_ID, "text": _button()}]


def decorate(replies: list[dict[str, Any]], status: str) -> list[dict[str, Any]]:
	"""The replies with the menu added per `main_menu_mode`. Unchanged when the mode is Off, no
	command is in the menu, a question awaits an answer, or the replies already are the menu."""
	current = mode()
	if current == "Off" or not replies or status == "Awaiting Input":
		return replies
	if any(r.get("is_menu") for r in replies):
		return replies
	rows = items()
	if not rows:
		return replies
	after = replies[-1].get("output_key") or "menu"
	if current == "List after every reply":
		return [*replies, menu_list(after)]
	buttons = _buttons(rows)
	last = replies[-1]
	body = cstr(last.get("body"))
	if last.get("message_type") == "Text" and not last.get("attachment") and body and len(body) <= MAX_BODY:
		carried = {
			**last,
			"is_menu": True,
			"message_type": "Buttons",
			"interactive": {"text": body, "buttons": buttons},
		}
		return [*replies[:-1], carried]
	return [
		*replies,
		{
			"output_key": after,
			"is_menu": True,
			"message_type": "Buttons",
			"body": _text(),
			"interactive": {"text": _text(), "buttons": buttons},
			"attachment": None,
		},
	]


# ---- editing the menu (Settings → Commands) --------------------------------------------------

MENU_FIELDS = ("name", "code", "title", "show_in_menu", "menu_order", "menu_description")


def editable_items() -> list[dict[str, Any]]:
	"""Every Active command with its menu fields: the ones in the menu first, in order."""
	rows = frappe.get_all(
		"WhatsApp Command", filters={"status": "Active"}, fields=list(MENU_FIELDS), order_by="title asc, code asc"
	)
	rows.sort(key=lambda r: (not cint(r.show_in_menu), cint(r.menu_order)))
	return rows


def save_items(entries: list[dict[str, Any]], *, user: str | None = None) -> list[str]:
	"""The menu becomes `entries` (`[{command, menu_description}]`, in order): those commands are
	shown, ordered as given; every other command leaves the menu. Returns the commands changed;
	audited `Settings Changed`. E: `WAValidationError`."""
	from whatsapp_next.exceptions import WAValidationError
	from whatsapp_next.services import audit

	if not isinstance(entries, list):
		frappe.throw(_("The menu must be a list of commands"), WAValidationError)
	if len(entries) > MAX_ROWS:
		frappe.throw(_("The menu holds at most {0} commands").format(MAX_ROWS), WAValidationError)
	wanted: dict[str, dict[str, Any]] = {}
	for i, entry in enumerate(entries):
		name = cstr((entry or {}).get("command")).strip()
		if not name or not frappe.db.exists("WhatsApp Command", name):
			frappe.throw(_("Command {0} not found").format(name), WAValidationError)
		description = cstr(entry.get("menu_description")).strip()
		if len(description) > 72:
			frappe.throw(_("The menu description of {0} is longer than 72 characters").format(name), WAValidationError)
		wanted[name] = {"show_in_menu": 1, "menu_order": i, "menu_description": description}
	changed: list[str] = []
	for row in frappe.get_all("WhatsApp Command", fields=list(MENU_FIELDS)):
		target = wanted.get(row.name) or {"show_in_menu": 0, "menu_order": row.menu_order, "menu_description": row.menu_description}
		current = {"show_in_menu": cint(row.show_in_menu), "menu_order": cint(row.menu_order), "menu_description": row.menu_description or ""}
		target = {**target, "menu_order": cint(target["menu_order"]), "menu_description": target["menu_description"] or ""}
		if current != target:
			frappe.db.set_value("WhatsApp Command", row.name, target)
			frappe.clear_document_cache("WhatsApp Command", row.name)
			changed.append(row.name)
	if changed:
		audit.log(
			"Settings Changed",
			fields_written=["show_in_menu", "menu_order", "menu_description"],
			details={"section": "main_menu", "commands": changed},
			user=user,
		)
	return changed

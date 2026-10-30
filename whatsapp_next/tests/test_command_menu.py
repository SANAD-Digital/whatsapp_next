# The main menu (services/command_menu): the list after every reply, buttons on the reply like
# WhatsApp Business, the «Main menu» button and words, and no menu under a pending question.

from __future__ import annotations

from unittest.mock import patch

import frappe
from frappe.tests import IntegrationTestCase

from whatsapp_next.services import command_menu, command_router, command_sessions


class _FnResult:
	def __init__(self):
		self.data, self.error = {}, None


def _text(body, key="result"):
	return {"output_key": key, "message_type": "Text", "body": body, "attachment": None}


def plan(interactive: bool) -> None:
	"""The synced plan, with or without buttons and lists."""
	frappe.db.set_single_value("WhatsApp Settings", "plan_features", frappe.as_json({"allow_interactive": interactive}))
	frappe.clear_document_cache("WhatsApp Settings", "WhatsApp Settings")


class TestCommandMenu(IntegrationTestCase):
	def setUp(self):
		self.commands = frappe.get_all("WhatsApp Command", filters={"status": "Active"}, pluck="name", limit=5)
		self.device = frappe.db.get_value("WhatsApp Device", {}, "name")
		if len(self.commands) < 4 or not self.device:
			self.skipTest("needs four active commands and a device")
		frappe.db.set_value("WhatsApp Command", {"name": ("not in", self.commands)}, "show_in_menu", 0)
		for i, name in enumerate(self.commands):
			frappe.db.set_value("WhatsApp Command", name, {"show_in_menu": 1, "menu_order": i})
		frappe.db.set_single_value("WhatsApp Settings", {"enable_commands": 1, "main_menu_words": "القائمة\nmenu"})
		self._mode("Buttons on the reply")
		plan(True)
		self.phone = "+9677701" + frappe.generate_hash(length=5)[:4].translate(str.maketrans("abcdef", "123456"))
		self.addCleanup(command_sessions.clear, self.device, self.phone)

	def _mode(self, mode):
		frappe.db.set_single_value("WhatsApp Settings", "main_menu_mode", mode)
		frappe.clear_document_cache("WhatsApp Settings", "WhatsApp Settings")

	def _show_only(self, count):
		for i, name in enumerate(self.commands):
			frappe.db.set_value("WhatsApp Command", name, "show_in_menu", int(i < count))

	def test_the_menu_lists_only_what_the_sender_may_use(self):
		"""`allowed` (the sender's access) drops the commands that are not theirs (owner, 2026-10-29)."""
		every = [r.name for r in command_menu.items()]
		if not every:
			return
		hidden = every[0]
		mine = [r.name for r in command_menu.items(lambda name: name != hidden)]
		self.assertNotIn(hidden, mine)
		self.assertEqual(len(mine), len(every) - 1)

	def test_off_changes_nothing(self):
		self._mode("Off")
		replies = [_text("done")]
		self.assertEqual(command_menu.decorate(replies, "Executed"), replies)

	def test_list_after_every_reply(self):
		self._mode("List after every reply")
		out = command_menu.decorate([_text("done")], "Executed")
		self.assertEqual([r["message_type"] for r in out], ["Text", "List"])
		ids = [r["id"] for r in out[1]["interactive"]["sections"][0]["rows"]]
		codes = frappe.get_all("WhatsApp Command", filters={"name": ("in", self.commands)}, pluck="code")
		self.assertEqual(sorted(ids), sorted(c.strip() for c in codes))
		self.assertEqual(out[1]["output_key"], "result")  # goes the way the reply goes

	def test_buttons_on_the_reply(self):
		# more than three commands: one «Main menu» button on the reply itself
		out = command_menu.decorate([_text("Balance: 10")], "Executed")
		self.assertEqual(len(out), 1)
		self.assertEqual((out[0]["message_type"], out[0]["interactive"]["text"]), ("Buttons", "Balance: 10"))
		self.assertEqual([b["id"] for b in out[0]["interactive"]["buttons"]], [command_menu.MENU_ID])
		# three or fewer: the commands themselves
		self._show_only(3)
		out = command_menu.decorate([_text("Balance: 10")], "Executed")
		self.assertEqual(len(out[0]["interactive"]["buttons"]), 3)
		# a file cannot carry buttons: a short buttons message follows it
		file_reply = {"output_key": "pdf", "message_type": "Document", "body": "", "attachment": "/files/x.pdf"}
		out = command_menu.decorate([file_reply], "Executed")
		self.assertEqual([r["message_type"] for r in out], ["Document", "Buttons"])

	def test_no_menu_under_a_question(self):
		replies = [_text("Choose a date", "prompt")]
		self.assertEqual(command_menu.decorate(replies, "Awaiting Input"), replies)

	def _route(self, body, selected=None):
		doc = frappe.get_doc({"doctype": "WhatsApp Inbound Message", "device": self.device, "phone_e164": self.phone,
			"message_type": "Interactive Reply" if selected else "Text", "body": body, "selected_option_id": selected,
			"provider_message_id": f"M-{frappe.generate_hash(length=8)}", "command_status": "None"})
		doc.flags.ignore_mandatory = True
		doc.insert(ignore_permissions=True)
		sent = []
		with patch.object(command_router, "_send_replies", side_effect=lambda c, i, replies, **k: sent.extend(replies) or []), \
			patch.object(command_router, "execute", side_effect=lambda *a, **k: _FnResult()):
			res = command_router.route(doc.name)
		return res, sent

	def test_menu_button_and_words_send_the_list(self):
		for body, selected in (("القائمة الرئيسية", command_menu.MENU_ID), ("Menu", None)):
			res, sent = self._route(body, selected)
			self.assertEqual(res.status, "Executed")
			self.assertEqual([r["message_type"] for r in sent], ["List"])

	def test_save_items_sets_the_menu_in_order(self):
		first, second = self.commands[1], self.commands[0]
		changed = command_menu.save_items([{"command": first, "menu_description": "one"}, {"command": second}])
		self.assertTrue(changed)
		rows = {r.name: r for r in command_menu.editable_items()}
		self.assertEqual((rows[first].show_in_menu, rows[first].menu_order, rows[first].menu_description), (1, 0, "one"))
		self.assertEqual((rows[second].show_in_menu, rows[second].menu_order), (1, 1))
		self.assertEqual(rows[self.commands[2]].show_in_menu, 0)
		self.assertEqual([r.name for r in command_menu.editable_items()][:2], [first, second])
		self.assertEqual(command_menu.save_items([{"command": first, "menu_description": "one"}, {"command": second}]), [])
		with self.assertRaises(frappe.ValidationError):
			command_menu.save_items([{"command": "no-such-command"}])

	def test_no_menu_without_the_plan(self):
		plan(False)
		replies = [_text("done")]
		self.assertEqual(command_menu.mode(), "Off")
		self.assertEqual(command_menu.decorate(replies, "Executed"), replies)
		_res, sent = self._route("menu")
		self.assertNotIn("List", [r["message_type"] for r in sent])

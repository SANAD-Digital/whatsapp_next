# Asking for a command's missing inputs over WhatsApp (services/command_sessions): the question
# by input type, the session per chat, answers by tap or text, cancel, and relative dates.

from __future__ import annotations

from unittest.mock import patch

import frappe
from frappe.tests import IntegrationTestCase
from frappe.utils import add_months, get_first_day, getdate, nowdate

from whatsapp_next.services import command_router, command_sessions


class _FnResult:
	def __init__(self):
		self.data, self.error = {}, None


def plan(interactive: bool) -> None:
	"""The synced plan, with or without buttons and lists."""
	frappe.db.set_single_value("WhatsApp Settings", "plan_features", frappe.as_json({"allow_interactive": interactive}))
	frappe.clear_document_cache("WhatsApp Settings", "WhatsApp Settings")


class TestCommandSessions(IntegrationTestCase):
	def test_relative_dates(self):
		today = getdate(nowdate())
		self.assertEqual(command_sessions.relative_date("today"), today)
		self.assertEqual(command_sessions.relative_date("month_start"), get_first_day(today))
		self.assertEqual(command_sessions.relative_date("-3m"), add_months(today, -3))
		self.assertIsNone(command_sessions.relative_date("2026-10-31"))
		self.assertEqual(command_router._coerce("last_month_start", "date", {"key": "d"}), str(get_first_day(add_months(today, -1))))

	def test_ask_specs(self):
		cmd = frappe._dict(ask_inputs="months: 1, 3=Three months, 6\nas_on")
		self.assertEqual(command_sessions.ask_specs(cmd), {"months": [("1", "1"), ("3", "Three months"), ("6", "6")], "as_on": []})

	def _setup(self):
		self.command = frappe.db.get_value("WhatsApp Command", {"code": "رصيد"}, "name")
		self.device = frappe.db.get_value("WhatsApp Device", {}, "name")
		if not self.command or not self.device:
			self.skipTest("needs the رصيد command and a device")
		frappe.db.set_value("WhatsApp Command", self.command, "ask_inputs", "as_on")
		plan(True)
		frappe.clear_document_cache("WhatsApp Command", self.command)
		self.phone = "+9677700" + frappe.generate_hash(length=5)[:5].translate(str.maketrans("abcdef", "123456"))
		self.addCleanup(command_sessions.clear, self.device, self.phone)

	def _inbound(self, body, selected=None):
		doc = frappe.get_doc({"doctype": "WhatsApp Inbound Message", "device": self.device, "phone_e164": self.phone,
			"message_type": "Interactive Reply" if selected else "Text", "body": body, "selected_option_id": selected,
			"provider_message_id": f"S-{frappe.generate_hash(length=8)}", "command_status": "None"})
		doc.flags.ignore_mandatory = True
		doc.insert(ignore_permissions=True)
		return doc.name

	def _route(self, name):
		sent, runs = [], []
		with patch.object(command_router, "_send_replies", side_effect=lambda c, i, replies, **k: sent.extend(replies) or []), \
			patch.object(command_router, "execute", side_effect=lambda c, i, args, **k: runs.append(args) or _FnResult()), \
			patch.object(command_router, "render_outputs", return_value=[]), \
			patch.object(command_router, "check_access", return_value=None):
			frappe.db.set_single_value("WhatsApp Settings", "enable_commands", 1)
			res = command_router.route(name)
		return res, sent, runs

	def test_missing_date_is_asked_then_the_command_runs(self):
		self._setup()
		res, sent, runs = self._route(self._inbound("رصيد"))
		self.assertEqual((res.status, runs), ("Awaiting Input", []))
		self.assertEqual(sent[0]["message_type"], "List")
		ids = [r["id"] for r in sent[0]["interactive"]["sections"][0]["rows"]]
		self.assertIn(command_sessions.ARG_PREFIX + "month_start", ids)
		res, sent, runs = self._route(self._inbound("بداية هذا الشهر", selected=command_sessions.ARG_PREFIX + "month_start"))
		self.assertEqual(res.status, "Executed")
		self.assertEqual(runs, [{"as_on": str(get_first_day(getdate(nowdate())))}])
		self.assertIsNone(command_sessions.load(self.device, self.phone))

	def test_typed_command_with_the_value_is_not_asked(self):
		self._setup()
		res, sent, runs = self._route(self._inbound("رصيد 2026-01-31"))
		self.assertEqual((res.status, runs), ("Executed", [{"as_on": "2026-01-31"}]))

	def test_cancel_and_bad_value(self):
		self._setup()
		self._route(self._inbound("رصيد"))
		res, sent, runs = self._route(self._inbound("not a date"))
		self.assertEqual((res.status, runs), ("Awaiting Input", []))
		self.assertEqual(sent[-1]["message_type"], "List")  # asked again
		res, sent, runs = self._route(self._inbound("إلغاء"))
		self.assertEqual((res.status, runs), ("Executed", []))
		self.assertIsNone(command_sessions.load(self.device, self.phone))

	def test_menu_tap_title_words_are_not_arguments(self):
		self._setup()
		# a menu row titled "رصيد العميل": "العميل" is a label, so the date is asked, not refused
		res, sent, runs = self._route(self._inbound("رصيد العميل", selected="svc_balance"))
		self.assertEqual((res.status, runs), ("Awaiting Input", []))
		command_sessions.clear(self.device, self.phone)
		# a row whose id is a command line runs it with the id's arguments
		res, sent, runs = self._route(self._inbound("رصيد أول الشهر", selected="رصيد month_start"))
		self.assertEqual((res.status, runs), ("Executed", [{"as_on": str(get_first_day(getdate(nowdate())))}]))

	def test_without_the_plan_questions_are_numbered_text(self):
		self._setup()
		plan(False)
		res, sent, runs = self._route(self._inbound("رصيد"))
		self.assertEqual((res.status, sent[0]["message_type"]), ("Awaiting Input", "Text"))
		self.assertIn("3. ", sent[0]["body"])
		# option 3 is the third date preset: the start of this month
		res, sent, runs = self._route(self._inbound("3"))
		self.assertEqual(runs, [{"as_on": str(get_first_day(getdate(nowdate())))}])

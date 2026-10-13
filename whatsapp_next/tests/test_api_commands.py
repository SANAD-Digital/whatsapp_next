# Tests for api/v1/commands.py (build order B-26) and the router helpers it needed
# (`command_router.dry_run`, `command_router.recent_run_counts`): role gate, list with function
# status and 30-day counts, defaults, allow-listed save with the Active lock, status, restore
# defaults, dry-run test and the bulk `set_status_many`. The commands run the fixture function
# `_test_echo` (function_fixtures.py).

from __future__ import annotations

import json

import frappe
from frappe.tests import IntegrationTestCase
from frappe.utils import add_days, now_datetime

from whatsapp_next.api.v1 import commands as api
from whatsapp_next.exceptions import (
	WAInvalidPhoneError,
	WANotFoundError,
	WAPermissionError,
	WAStateConflictError,
	WAValidationError,
)
from whatsapp_next.services import command_router as cr
from whatsapp_next.tests import function_fixtures as ff
from whatsapp_next.tests.conftest_frappe import as_user, delete_all, ensure_device, ensure_settings

FUNCTION = "_test_echo"
CODE = "apitestping"
SENDER = "+966500930401"


class TestApiCommands(IntegrationTestCase):
	@classmethod
	def setUpClass(cls):
		super().setUpClass()
		cls.device = ensure_device("ApiTest Cmd Device", "WAD-APITEST-CM", phone="+966500930400")
		ensure_settings(enable_commands=1, command_service_user=ff.ensure_service_user(), send_receipt_reply=0)

	@classmethod
	def tearDownClass(cls):
		cls._clean()
		super().tearDownClass()

	def setUp(self):
		self._clean()
		ff.ensure_function(FUNCTION)
		cr.clear_map()

	@staticmethod
	def _clean():
		delete_all("WhatsApp Inbound Message", {"phone_e164": SENDER})
		delete_all("WhatsApp Command", {"code": ("like", "apitest%")})
		delete_all(
			"WhatsApp Audit Log",
			{"reference_doctype": "WhatsApp Command", "reference_name": ("like", "apitest%")},
		)
		cr.clear_map()

	def _command(self, status: str = "Inactive", code: str = CODE) -> str:
		with as_user("WhatsApp Manager"):
			name = api.save_command(
				payload={
					"code": code,
					"title": "Api Ping",
					"function": FUNCTION,
					"synonyms": f"{code}2",
					"requires_linked_contact": 0,
				}
			)["name"]
			if status == "Active":
				api.set_status(name=name, status="Active")
		return name

	def test_role_gate(self):
		with as_user("_none"), self.assertRaises(WAPermissionError):
			api.list_commands()
		with as_user("WhatsApp Viewer"):
			self.assertIn("rows", api.list_commands())
			with self.assertRaises(WAPermissionError):
				api.save_command(payload={"code": CODE, "function": FUNCTION})
		with as_user("WhatsApp Manager"):
			self.assertEqual(
				set(api.get_defaults(function=FUNCTION)),
				{"inputs", "settings", "templates", "replies", "party_types", "party_types_text"},
			)

	def test_list_and_defaults(self):
		name = self._command(status="Active")
		# one run in the window; one too old, one Blocked sender and one Simulator row are not runs
		for days_ago, status, simulated in ((1, "Executed", 0), (40, "Executed", 0), (1, "Blocked", 0), (1, "Executed", 1)):
			frappe.get_doc(
				{
					"doctype": "WhatsApp Inbound Message",
					"device": self.device,
					"phone": SENDER,
					"message_type": "Text",
					"body": f"#{CODE}",
					"provider_message_id": frappe.generate_hash(length=12),
					"received_at": add_days(now_datetime(), -days_ago),
					"command_status": status,
					"command": name,
					"is_simulated": simulated,
				}
			).insert(ignore_permissions=True)
		with as_user("WhatsApp Viewer"):
			out = api.list_commands(filters={"function": FUNCTION, "status": "Active"}, page_length="500")
		row = next(r for r in out["rows"] if r["name"] == name)
		self.assertEqual(
			(row["function_status"], row["function_name"], row["run_count_30d"]), ("Active", "Test Echo", 1)
		)
		self.assertGreaterEqual(out["total"], 1)
		with as_user("WhatsApp Viewer"):
			self.assertEqual(
				api.list_commands(filters={"status": "Inactive", "function": FUNCTION})["rows"], []
			)
		with as_user("WhatsApp Manager"):
			defaults = api.get_defaults(function=FUNCTION)
			self.assertEqual([r["key"] for r in defaults["replies"]], ["result_text"])
			self.assertEqual([t["key"] for t in defaults["templates"]], ["msg_result"])
			self.assertEqual([i["key"] for i in defaults["inputs"]], ["text"])
			self.assertEqual(defaults["party_types"], {"mode": "all", "types": []})
			with self.assertRaises(WANotFoundError):
				api.get_defaults(function="nope")

	def test_save_lock_status_restore(self):
		name = self._command()
		doc = frappe.get_doc("WhatsApp Command", name)
		self.assertEqual((doc.status, doc.synonyms, doc.templates), ("Inactive", f"{CODE}2", []))
		self.assertEqual(
			frappe.db.count("WhatsApp Audit Log", {"action": "Command Changed", "reference_name": name}), 1
		)
		with as_user("WhatsApp Manager"):
			with self.assertRaises(WAValidationError):
				api.save_command(payload={"name": name, "owner": "x"})
			with self.assertRaises(WAValidationError):
				api.save_command(payload={"name": name, "settings_overrides": {"nope": 1}})
			with self.assertRaises(WAValidationError):  # the party is the sender's, never the command's
				api.save_command(payload={"name": name, "settings_overrides": {"party": "X"}})
			with self.assertRaises(WAValidationError):  # the old `outputs` key is gone
				api.save_command(payload={"name": name, "outputs": []})
			with self.assertRaises(WAValidationError):  # word collision with the existing command
				api.save_command(payload={"code": "apitestother", "function": FUNCTION, "synonyms": CODE})
			api.save_command(
				payload={
					"name": name,
					"description": "d",
					"requires_linked_contact": "1",
					"templates": [{"param": "msg_result", "language": "en", "text": "custom {{ echo }}"}],
					"disabled_replies": [],
				}
			)
			doc = frappe.get_doc("WhatsApp Command", name)
			self.assertEqual(
				(doc.description, doc.requires_linked_contact, doc.templates[0].text),
				("d", 1, "custom {{ echo }}"),
			)
			self.assertEqual(api.set_status(name=name, status="Active"), {"status": "Active"})
			with self.assertRaises(WAStateConflictError):
				api.save_command(payload={"name": name, "title": "x"})
			with self.assertRaises(WAStateConflictError):
				api.restore_defaults(name=name)
			with self.assertRaises(WAValidationError):
				api.set_status(name=name, status="Paused")
			api.set_status(name=name, status="Inactive")
			out = api.restore_defaults(name=name)
			self.assertEqual(out, {"templates": [], "settings_overrides": {}})
			self.assertEqual(frappe.get_doc("WhatsApp Command", name).templates, [])
			self.assertIsNotNone(frappe.db.get_value("WhatsApp Command", name, "defaults_restored_at"))
			self.assertEqual(
				frappe.db.count(
					"WhatsApp Audit Log", {"action": "Command Defaults Restored", "reference_name": name}
				),
				1,
			)
			with self.assertRaises(WANotFoundError):
				api.set_status(name="no-such-command", status="Active")

	def test_test_command_is_dry(self):
		name = self._command(status="Active")
		before = frappe.db.count("WhatsApp Log")
		with as_user("WhatsApp Manager"):
			out = api.test_command(text=f"#{CODE} hello there", sender_phone="0500930401", device=self.device)
			self.assertEqual(
				(out["matched"], out["status"], out["command"], out["args"]["text"]),
				(True, "Executed", name, "hello there"),
			)
			self.assertTrue(out["reply_body"].startswith("pong: hello there"))
			self.assertIsInstance(out["function_ms"], int)
			miss = api.test_command(text="#apitestnothing", sender_phone=SENDER)
			self.assertEqual((miss["matched"], miss["status"], miss["command"]), (False, "Not Matched", None))
			with self.assertRaises(WAInvalidPhoneError):
				api.test_command(text="#x", sender_phone="abc")
		self.assertEqual(frappe.db.count("WhatsApp Log"), before)
		self.assertEqual(frappe.db.count("WhatsApp Inbound Message", {"phone_e164": SENDER}), 0)
		self.assertEqual(frappe.session.user, "Administrator")

	def test_set_status_many(self):
		a = self._command(code="apitesta")
		b = self._command(code="apitestb", status="Active")
		with as_user("WhatsApp Manager"):
			res = api.set_status_many(names=[a, b, "no-such-command"], status="Active")
		self.assertEqual(
			(res["count"], res["done"], res["skipped"][0]["name"], res["failed"][0]["name"]),
			(1, [a], b, "no-such-command"),
		)
		self.assertEqual(frappe.db.get_value("WhatsApp Command", a, "status"), "Active")
		self.assertIn(json.dumps(res["failed"][0]["error"]) and "not found", res["failed"][0]["error"])

# Tests for api/v1/functions.py (build order B-26, WHATSAPP_NEXT_INTEGRATION §4): the role gate, the
# catalog of function scripts with their install state, one function's header, preview / install /
# update / remove, status, the site's values, "Try", the update check and the bulk `update_many` /
# `set_status_many`. Fixture scripts only (function_fixtures.py).

from __future__ import annotations

import frappe
from frappe.tests import IntegrationTestCase

from whatsapp_next.api.v1 import functions as api
from whatsapp_next.exceptions import (
	WANotFoundError,
	WAPermissionError,
	WAStateConflictError,
	WAValidationError,
)
from whatsapp_next.tests import function_fixtures as ff
from whatsapp_next.tests.conftest_frappe import as_user, ensure_settings

ECHO, ECHO_SCRIPT = "_test_echo", ff.FUNCTIONS["_test_echo"][0]
TYPED, TYPED_SCRIPT = "_test_typed", ff.FUNCTIONS["_test_typed"][0]


class TestApiFunctions(IntegrationTestCase):
	@classmethod
	def setUpClass(cls):
		super().setUpClass()
		ff.drop_all()
		ensure_settings(command_service_user=ff.ensure_service_user(), command_reply_language="en")

	def setUp(self):
		ff.drop_all()
		for key in (ECHO, TYPED):
			ff.ensure_script(*ff.FUNCTIONS[key])

	def _entries(self) -> dict:
		return {e["server_script"]: e for e in api.get_catalog()["entries"]}

	def test_role_gate(self):
		with as_user("_none"), self.assertRaises(WAPermissionError):
			api.get_catalog()
		with as_user("WhatsApp Viewer"):
			self.assertIn(ECHO_SCRIPT, self._entries())
			self.assertEqual(api.get_manifest(server_script=ECHO_SCRIPT)["function_key"], ECHO)
			for call in (
				lambda: api.install(server_script=ECHO_SCRIPT),
				lambda: api.preview_install(server_script=ECHO_SCRIPT),
				lambda: api.try_function(function_key=ECHO),
				lambda: api.check_updates(),
			):
				with self.assertRaises(WAPermissionError):
					call()
		with as_user("WhatsApp Agent"), self.assertRaises(WAPermissionError):
			api.save_values(function_key=ECHO, values={})
		with as_user("WhatsApp Manager"):
			self.assertEqual(
				api.install(server_script=ECHO_SCRIPT), {"name": ECHO, "installed_version": "1.0.0"}
			)

	def test_catalog_preview_install_update_remove(self):
		with as_user("WhatsApp Manager"):
			out = api.get_catalog()
			self.assertIn("checked_at", out)
			entry = self._entries()[TYPED_SCRIPT]
			self.assertEqual(
				(
					entry["function_key"],
					entry["state"],
					entry["installed"],
					entry["commands_count"],
					entry["calls_30d"],
				),
				(TYPED, "available", False, 0, 0),
			)
			self.assertEqual(entry["party_types"], {"mode": "only", "types": ["Customer", "Supplier"]})
			self.assertEqual([r["key"] for r in entry["replies"]], ["result_text"])
			pre = api.preview_install(server_script=TYPED_SCRIPT)
			self.assertEqual(
				(pre["installed_version"], pre["target_version"], pre["available"]), (None, "1.0.0", True)
			)
			self.assertIn("doc_name", pre["params"]["added"])
			with self.assertRaises(WANotFoundError):
				api.preview_install(server_script="wa_fn__test_nope")
			self.assertEqual(
				api.install(server_script=TYPED_SCRIPT), {"name": TYPED, "installed_version": "1.0.0"}
			)
			with self.assertRaises(WAStateConflictError):
				api.install(server_script=TYPED_SCRIPT)
			ff.make_command("tafdoc", TYPED, status="Inactive")
			entry = self._entries()[TYPED_SCRIPT]
			self.assertEqual(
				(entry["installed"], entry["status"], entry["commands_count"]), (True, "Active", 1)
			)
			self.assertEqual(
				api.update(function_key=TYPED), {"installed_version": "1.0.0", "previous_version": "1.0.0"}
			)
			self.assertEqual(api.set_status(function_key=TYPED, status="Inactive"), {"status": "Inactive"})
			with self.assertRaises(WAValidationError):
				api.set_status(function_key=TYPED, status="Paused")
			frappe.delete_doc("WhatsApp Command", "tafdoc", ignore_permissions=True)
			self.assertEqual(api.remove(function_key=TYPED), {"removed": True})
			with self.assertRaises(WANotFoundError):
				api.remove(function_key=TYPED)
			self.assertFalse(self._entries()[TYPED_SCRIPT]["installed"])

	def test_get_manifest(self):
		with as_user("WhatsApp Viewer"):
			m = api.get_manifest(server_script=ECHO_SCRIPT)
			self.assertEqual((m["version"], m["installed"], m["available"]), ("1.0.0", {}, True))
			self.assertEqual([p["name"] for p in m["params"]], ["text", "msg_result"])
			self.assertEqual([p["name"] for p in m["sender_params"]], ["party_type", "party"])
			self.assertEqual([v["name"] for v in m["params"][1]["vars"]], ["echo", "party"])
			self.assertEqual([r["key"] for r in m["replies"]], ["result_text"])
			with self.assertRaises(frappe.DoesNotExistError):
				api.get_manifest(function_key="_test_nope")
		with as_user("WhatsApp Manager"):
			api.install(server_script=ECHO_SCRIPT)
			api.save_values(
				function_key=ECHO, values={"text": "fixed", "msg_result": {"en": "hi {{ echo }}"}}
			)
			m = api.get_manifest(function_key=ECHO)
			self.assertEqual(
				(m["installed"]["installed_version"], m["installed"]["status"]), ("1.0.0", "Active")
			)
			self.assertEqual(
				{p["name"]: p["value"] for p in m["params"]},
				{"text": "fixed", "msg_result": {"en": "hi {{ echo }}"}},
			)
			self.assertEqual(m["server_script"], ECHO_SCRIPT)

	def test_save_values_and_try(self):
		with as_user("WhatsApp Manager"):
			api.install(server_script=TYPED_SCRIPT)
			out = api.save_values(function_key=TYPED, values={"days": "5"})
			self.assertEqual(out, {"values": {"days": 5}})
			with self.assertRaises(WAValidationError):
				api.save_values(function_key=TYPED, values={"nope": 1})
			with self.assertRaises(WAValidationError):
				api.save_values(function_key=TYPED, values={"days": "maybe"})
			with self.assertRaises(WANotFoundError):
				api.save_values(function_key="_test_nope", values={})
			# "Try" runs as a command would: the party is the one given, the site's values apply
			customer = (frappe.get_all("Customer", limit=1, pluck="name") or [None])[0]
			if customer:
				res = api.try_function(
					function_key=TYPED, party_type="Customer", party=customer, values={"doc_name": "X-1"}
				)
				self.assertTrue(all(s["ok"] for s in res["steps"]), res["steps"])
				self.assertEqual(res["messages"][0]["text"], f"doc X-1 of {customer}")
				self.assertEqual(res["params"]["days"], 5)
			res = api.try_function(function_key=TYPED, party_type="Employee", party=None)
			self.assertFalse(res["steps"][-1]["ok"])  # @party_types
			with self.assertRaises(WANotFoundError):
				api.try_function(function_key="_test_nope")

	def test_update_state_and_bulk(self):
		with as_user("WhatsApp Manager"):
			api.install(server_script=ECHO_SCRIPT)
			api.install(server_script=TYPED_SCRIPT)
		# a new header on the script (a Script Manager's change, not the Manager's)
		script = ff.FUNCTIONS[ECHO][1]
		ff.ensure_script(ECHO_SCRIPT, script.replace("@version      1.0.0", "@version      1.2.0"))
		with as_user("WhatsApp Manager"):
			# the storefront compares the header itself; the daily flag follows on check_updates
			self.assertTrue(self._entries()[ECHO_SCRIPT]["update_available"])
			self.assertFalse(self._entries()[TYPED_SCRIPT]["update_available"])
			counts = api.check_updates()
			self.assertGreaterEqual(counts["updates"], 1)
			self.assertEqual(frappe.db.get_value("WhatsApp Function", ECHO, "update_available"), 1)
			res = api.update_many(function_keys=[ECHO, TYPED, "_test_nope"])
			self.assertEqual(
				(res["count"], res["done"], res["skipped"][0]["name"], res["failed"][0]["name"]),
				(1, [ECHO], TYPED, "_test_nope"),
			)
			self.assertEqual(frappe.db.get_value("WhatsApp Function", ECHO, "installed_version"), "1.2.0")
			res = api.update_many(function_keys=[ECHO])
			self.assertEqual((res["count"], res["skipped"][0]["reason"]), (0, "already latest"))
			res = api.set_status_many(function_keys=[ECHO, TYPED], status="Inactive")
			self.assertEqual((res["count"], res["skipped"]), (2, []))
			res = api.set_status_many(function_keys=[ECHO], status="Inactive")
			self.assertEqual((res["count"], res["skipped"][0]["reason"]), (0, "already Inactive"))
			with self.assertRaises(WAValidationError):
				api.set_status_many(function_keys=[ECHO], status="Nope")

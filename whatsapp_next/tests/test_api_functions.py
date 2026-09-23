# Tests for api/v1/functions.py (build order B-26): role gate, catalog storefront, preview /
# install / update / remove, status and settings, bulk `update_many` / `set_status_many`.
# Uses the shipped catalog functions `ping` and `document_info`.

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
from whatsapp_next.services import functions_catalog as fc
from whatsapp_next.tests.conftest_frappe import as_user, delete_all

KEYS = ["ping", "document_info"]


class TestApiFunctions(IntegrationTestCase):
	def setUp(self):
		self._clean()
		fc.clear_cache()

	def tearDown(self):
		self._clean()

	@staticmethod
	def _clean():
		delete_all("WhatsApp Command", {"function": ("in", KEYS)})
		delete_all("WhatsApp Function", {"name": ("in", KEYS)})

	def test_role_gate(self):
		with as_user("_none"), self.assertRaises(WAPermissionError):
			api.get_catalog()
		with as_user("WhatsApp Viewer"):
			self.assertTrue(api.get_catalog()["entries"])
			with self.assertRaises(WAPermissionError):
				api.install(function_key="ping")
		with as_user("WhatsApp Manager"):
			self.assertEqual(api.install(function_key="ping")["installed_version"], "1.0.0")

	def test_catalog_preview_install_update_remove(self):
		with as_user("WhatsApp Manager"):
			cat = api.get_catalog()
			entry = {e["function_key"]: e for e in cat["entries"]}["document_info"]
			self.assertEqual(
				(entry["installed"], entry["commands_count"], entry["handler_registered"]), (False, 0, True)
			)
			self.assertEqual(entry["changelog"], {"1.0.0": "Initial release."})
			self.assertTrue(cat["catalog_source"])
			pre = api.preview_install(function_key="document_info")
			self.assertEqual(
				pre["diff"]["settings"]["added"], ["document_type", "party_field", "require_party"]
			)
			self.assertEqual((pre["installed_version"], pre["target_version"]), (None, "1.0.0"))
			with self.assertRaises(WANotFoundError):
				api.preview_install(function_key="nope")
			out = api.install(function_key="document_info")
			self.assertEqual(out, {"name": "document_info", "installed_version": "1.0.0"})
			with self.assertRaises(WAStateConflictError):
				api.install(function_key="document_info")
			self.assertEqual(
				api.update(function_key="document_info"),
				{"installed_version": "1.0.0", "previous_version": "1.0.0"},
			)
			self.assertEqual(
				api.set_status(function_key="document_info", status="Inactive"), {"status": "Inactive"}
			)
			with self.assertRaises(WAValidationError):
				api.set_status(function_key="document_info", status="Paused")
			self.assertEqual(api.remove(function_key="document_info"), {"removed": True})
			with self.assertRaises(WANotFoundError):
				api.remove(function_key="document_info")

	def test_save_settings(self):
		with as_user("WhatsApp Manager"):
			api.install(function_key="document_info")
			out = api.save_settings(
				function_key="document_info", values={"document_type": "Sales Order", "require_party": 0}
			)
			self.assertEqual(
				(out["values"]["document_type"], out["values"]["require_party"]), ("Sales Order", "0")
			)
			with self.assertRaises(WAValidationError):
				api.save_settings(function_key="document_info", values={"nope": 1})
			with self.assertRaises(WAValidationError):
				api.save_settings(function_key="document_info", values={"require_party": "maybe"})
			with self.assertRaises(WANotFoundError):
				api.save_settings(function_key="ping", values={})

	def test_bulk(self):
		with as_user("WhatsApp Manager"):
			api.install(function_key="ping")
			api.install(function_key="document_info")
			frappe.db.set_value(
				"WhatsApp Function", "ping", "installed_version", "0.9.0", update_modified=False
			)
			res = api.update_many(function_keys=["ping", "document_info", "nope"])
			self.assertEqual(
				(res["count"], res["done"], res["skipped"][0]["name"], res["failed"][0]["name"]),
				(1, ["ping"], "document_info", "nope"),
			)
			self.assertEqual(frappe.db.get_value("WhatsApp Function", "ping", "installed_version"), "1.0.0")
			res = api.set_status_many(function_keys=["ping", "document_info"], status="Inactive")
			self.assertEqual((res["count"], res["skipped"]), (2, []))
			res = api.set_status_many(function_keys=["ping"], status="Inactive")
			self.assertEqual((res["count"], res["skipped"][0]["reason"]), (0, "already Inactive"))
			with self.assertRaises(WAValidationError):
				api.set_status_many(function_keys=["ping"], status="Nope")

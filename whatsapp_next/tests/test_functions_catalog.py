# Tests for services/functions_catalog.py and functions/registry.py (build order B-14): catalog
# loading and versions, diff-before-install, install / update / remove rules, update checks.

from __future__ import annotations

import frappe
from frappe.tests import IntegrationTestCase

from whatsapp_next.exceptions import WANotFoundError, WAStateConflictError, WAValidationError
from whatsapp_next.functions import registry
from whatsapp_next.services import functions_catalog as fc
from whatsapp_next.tests.conftest_frappe import delete_all


class TestFunctionsCatalog(IntegrationTestCase):
	def setUp(self):
		self._clean()
		fc.clear_cache()

	def tearDown(self):
		self._clean()

	@staticmethod
	def _clean():
		delete_all("WhatsApp Command", {"function": ("in", ["ping", "document_info"])})
		delete_all("WhatsApp Function", {"name": ("in", ["ping", "document_info"])})
		delete_all(
			"WhatsApp Audit Log",
			{"action": ("in", ["Function Installed", "Function Updated", "Function Removed"])},
		)

	def test_catalog_and_registry(self):
		catalog = fc.load_catalog(use_cache=False)
		self.assertIn("ping", catalog.functions)
		self.assertIn("document_info", catalog.functions)
		self.assertEqual(catalog.errors, [])
		self.assertEqual(fc.versions("ping"), ["1.0.0"])
		self.assertEqual(fc.sort_versions(["1.10.0", "1.2.0", "1.0.0"]), ["1.0.0", "1.2.0", "1.10.0"])
		self.assertTrue(registry.is_registered("ping"))
		self.assertFalse(registry.is_registered("nope"))
		self.assertIsNotNone(registry.get_handler("document_info"))
		with self.assertRaises(WANotFoundError):
			fc.get_function("nope")
		with self.assertRaises(WANotFoundError):
			fc.manifest_for("ping", "9.9.9")
		store = {r["function_key"]: r for r in fc.storefront()}
		self.assertFalse(store["ping"]["installed"])
		self.assertTrue(store["ping"]["handler_registered"])

	def test_install_diff_update_remove(self):
		d = fc.diff("document_info")
		self.assertEqual((d.installed_version, d.target_version), (None, "1.0.0"))
		self.assertEqual(d.settings["added"], ["document_type", "party_field", "require_party"])
		self.assertEqual(sorted(d.outputs["added"]), ["document", "summary"])
		self.assertTrue(d.handler_registered)

		name = fc.install("document_info")
		doc = frappe.get_doc("WhatsApp Function", name)
		self.assertEqual((doc.installed_version, doc.status, doc.handler_registered), ("1.0.0", "Active", 1))
		self.assertEqual({r.key: r.value for r in doc.settings}["document_type"], "Sales Invoice")
		self.assertEqual([r.party_type for r in doc.party_types], ["Customer", "Supplier"])
		self.assertEqual(doc.outputs[0].template, doc.outputs[0].default_template)
		self.assertEqual(len(doc.checksum), 64)
		self.assertIn("inputs", frappe.parse_json(doc.manifest))
		self.assertEqual(frappe.db.count("WhatsApp Audit Log", {"action": "Function Installed"}), 1)
		with self.assertRaises(WAStateConflictError):
			fc.install("document_info")

		# site customisations survive an update of the same version
		doc.settings[0].value = "Sales Order"
		doc.outputs[0].template = "custom {{ data.name }}"
		doc.save(ignore_permissions=True)
		fc.update("document_info")
		doc = frappe.get_doc("WhatsApp Function", name)
		self.assertEqual(doc.settings[0].value, "Sales Order")
		self.assertEqual(doc.outputs[0].template, "custom {{ data.name }}")
		d = fc.diff("document_info")
		self.assertEqual((d.installed_version, d.settings["added"], d.outputs["removed"]), ("1.0.0", [], []))

		# an Active command blocks removal
		cmd = frappe.get_doc(
			{
				"doctype": "WhatsApp Command",
				"code": "doc",
				"function": "document_info",
				"status": "Active",
				"requires_linked_contact": 0,
			}
		).insert(ignore_permissions=True)
		self.assertEqual(fc.diff("document_info").commands_impacted, [cmd.name])
		with self.assertRaises(WAStateConflictError):
			fc.remove("document_info")
		cmd.delete(ignore_permissions=True)
		fc.remove("document_info")
		self.assertFalse(frappe.db.exists("WhatsApp Function", "document_info"))
		with self.assertRaises(WANotFoundError):
			fc.remove("document_info")
		with self.assertRaises(WANotFoundError):
			fc.update("document_info")

	def test_install_needs_handler_and_check_updates(self):
		catalog = fc.load_catalog(use_cache=False)
		catalog.functions["ghost"] = fc.CatalogFunction(
			"ghost", "Ghost", None, None, None, [], {"1.0.0": {}}, "test"
		)
		frappe.cache.set_value(fc._CACHE_KEY, fc._to_cache(catalog), expires_in_sec=60)
		with self.assertRaises(WAValidationError):
			fc.install("ghost")
		fc.clear_cache()
		fc.install("ping")
		frappe.db.set_value("WhatsApp Function", "ping", "installed_version", "0.9.0", update_modified=False)
		counts = fc.check_updates()
		self.assertEqual(counts["updates"], 1)
		self.assertEqual(
			frappe.db.get_value(
				"WhatsApp Function", "ping", ["update_available", "latest_version"], as_dict=True
			),
			{"update_available": 1, "latest_version": "1.0.0"},
		)

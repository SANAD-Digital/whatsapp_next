# Smoke test: every package of the app imports, hooks resolve, install seeded roles and the
# disabled command service user, and the composite indexes exist (fields.md F-11).

from __future__ import annotations

import importlib

import frappe
from frappe.tests import IntegrationTestCase

from whatsapp_next.install import PRODUCT_ROLES, command_service_user_email
from whatsapp_next.patches.v0_1.add_indexes import expected_indexes

MODULES = (
	"whatsapp_next.hooks",
	"whatsapp_next.install",
	"whatsapp_next.exceptions",
	"whatsapp_next.api._common",
	"whatsapp_next.api.v1",
	"whatsapp_next.webhooks.v1",
	"whatsapp_next.providers.base",
	"whatsapp_next.providers.registry",
	"whatsapp_next.providers.schemas",
	"whatsapp_next.providers.snd_platform",
	"whatsapp_next.providers.meta_cloud",
	"whatsapp_next.services.phone",
	"whatsapp_next.services.errors",
	"whatsapp_next.services.guards",
	"whatsapp_next.services.audit",
	"whatsapp_next.services.notifications",
	"whatsapp_next.services.numbers_materializer",
	"whatsapp_next.patches.v0_1.add_indexes",
	"whatsapp_next.patches.v0_1.backfill_contact_phone_e164",
)


class TestSmoke(IntegrationTestCase):
	def test_imports(self):
		for module in MODULES:
			with self.subTest(module=module):
				importlib.import_module(module)

	def test_hooks_resolve(self):
		for hook in ("after_install", "after_migrate"):
			for path in frappe.get_hooks(hook, app_name="whatsapp_next"):
				self.assertTrue(callable(frappe.get_attr(path)), path)
		for doctype, events in frappe.get_hooks("doc_events", app_name="whatsapp_next").items():
			for _event, paths in events.items():
				for path in paths if isinstance(paths, list) else [paths]:
					self.assertTrue(callable(frappe.get_attr(path)), f"{doctype}: {path}")

	def test_roles_and_service_user(self):
		for role in PRODUCT_ROLES:
			self.assertTrue(frappe.db.exists("Role", role), role)
		email = command_service_user_email()
		self.assertTrue(frappe.db.exists("User", email))
		self.assertEqual(frappe.db.get_value("User", email, "enabled"), 0)
		self.assertEqual(frappe.db.count("Has Role", {"parent": email}), 0)

	def test_custom_field_and_contact_hook(self):
		self.assertTrue(frappe.db.exists("Custom Field", "Contact Phone-wa_phone_e164"))
		self.assertTrue(frappe.db.has_column("Contact Phone", "wa_phone_e164"))
		from whatsapp_next.tests.conftest_frappe import ensure_contact, ensure_settings

		ensure_settings()
		for name in frappe.get_all("Contact", {"first_name": "WA Smoke Contact"}, pluck="name"):
			frappe.delete_doc("Contact", name, ignore_permissions=True, force=True)
		contact = ensure_contact("WA Smoke Contact", "0501234567")
		e164 = frappe.db.get_value(
			"Contact Phone", {"parent": contact, "parenttype": "Contact"}, "wa_phone_e164"
		)
		self.assertEqual(e164, "+966501234567")

	def test_composite_indexes_exist(self):
		for doctype, index_name in expected_indexes():
			with self.subTest(doctype=doctype, index=index_name):
				self.assertTrue(
					frappe.db.has_index(f"tab{doctype}", index_name), f"{doctype} lacks {index_name}"
				)

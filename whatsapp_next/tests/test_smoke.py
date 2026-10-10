# Smoke test: every package of the app imports, hooks resolve, install seeded roles and the
# disabled command service user, and the composite indexes exist (fields.md F-11).

from __future__ import annotations

import importlib

import frappe
from frappe.tests import IntegrationTestCase

from whatsapp_next.install import PRODUCT_ROLES, command_service_user_email

# DocTypes whose controller module adds composite indexes in `on_doctype_update` (fields.md F-11).
INDEXED_DOCTYPES = (
	"WhatsApp Log",
	"WhatsApp Inbound Message",
	"WhatsApp Queue Item",
	"WhatsApp Audit Log",
	"WhatsApp Notification",
	"WhatsApp Notification Alert",
	"WhatsApp Webhook Event",
)

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
		self.assertTrue(frappe.db.exists("User", command_service_user_email()))
		# The seed itself (the site's own user may since have been enabled by its admin, D-123):
		# a fresh service user is disabled and holds no role.
		from unittest.mock import patch

		from whatsapp_next import install

		email = "wa-commands-smoke@example.com"
		frappe.delete_doc("User", email, ignore_permissions=True, force=True, ignore_missing=True)
		try:
			with patch.object(install, "command_service_user_email", return_value=email):
				self.assertEqual(install.ensure_command_service_user(), email)
			self.assertEqual(frappe.db.get_value("User", email, "enabled"), 0)
			self.assertEqual(frappe.db.count("Has Role", {"parent": email}), 0)
		finally:
			frappe.delete_doc("User", email, ignore_permissions=True, force=True, ignore_missing=True)

	def test_customizations_ship_in_the_custom_folder(self):
		"""Custom fields on core DocTypes live in `whatsapp_next/custom/<doctype>.json`, the file
		Frappe's "Export Customizations" writes and `sync_customizations` applies — not in fixtures."""
		import json
		import os

		path = frappe.get_app_path("whatsapp_next", "whatsapp_next", "custom", "contact_phone.json")
		with open(path, encoding="utf-8") as f:
			data = json.load(f)
		self.assertEqual({"custom_fields", "custom_perms", "property_setters", "links", "doctype", "sync_on_migrate"}, set(data))
		self.assertEqual((data["doctype"], data["sync_on_migrate"]), ("Contact Phone", 1))
		self.assertEqual((data["custom_perms"], data["property_setters"]), ([], []))
		self.assertEqual([f["name"] for f in data["custom_fields"]], ["Contact Phone-wa_phone_e164"])
		field = data["custom_fields"][0]
		self.assertEqual(
			(field["dt"], field["fieldname"], field["fieldtype"], field["module"], field["search_index"], field["hidden"]),
			("Contact Phone", "wa_phone_e164", "Data", "WhatsApp Next", 1, 1),
		)
		# every Custom Field of this module on the site is shipped by a file in that folder
		folder = os.path.dirname(path)
		shipped = set()
		for name in os.listdir(folder):
			with open(os.path.join(folder, name), encoding="utf-8") as f:
				shipped |= {row["name"] for row in json.load(f)["custom_fields"]}
		self.assertEqual(set(frappe.get_all("Custom Field", {"module": "WhatsApp Next"}, pluck="name")), shipped)
		# and nothing of it is left in the fixtures
		self.assertFalse(os.path.exists(frappe.get_app_path("whatsapp_next", "fixtures", "custom_field.json")))
		declared = [f.get("dt") or f.get("doctype") if isinstance(f, dict) else f for f in frappe.get_hooks("fixtures", app_name="whatsapp_next")]
		self.assertFalse({"Custom Field", "Property Setter"} & set(declared))

	def test_syncing_customizations_keeps_the_column_and_its_data(self):
		from unittest.mock import patch

		from frappe.modules.utils import sync_customizations

		def filled():
			return frappe.db.count("Contact Phone", {"wa_phone_e164": ("is", "set")})

		before = filled()
		# Frappe's schema sync commits; a test must not, so it is only observed here (the real
		# run was checked by hand: developer-docs/install-and-configure.md)
		with patch.object(frappe.local.db, "updatedb") as updatedb:
			sync_customizations("whatsapp_next")
			sync_customizations("whatsapp_next")
		updatedb.assert_called_with("Contact Phone")
		self.assertTrue(frappe.db.has_column("Contact Phone", "wa_phone_e164"))
		self.assertEqual(filled(), before)
		self.assertEqual(frappe.db.count("Custom Field", {"dt": "Contact Phone", "fieldname": "wa_phone_e164"}), 1)

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
		"""Each controller declares its composite indexes and Frappe's `on_doctype_update` handler
		builds them; nothing in `install.py` does."""
		total = 0
		for doctype in INDEXED_DOCTYPES:
			module = importlib.import_module(_controller(doctype))
			self.assertTrue(callable(getattr(module, "on_doctype_update", None)), doctype)
			for fields in module.COMPOSITE_INDEXES:
				total += 1
				name = frappe.db.get_index_name(list(fields))
				with self.subTest(doctype=doctype, index=name):
					self.assertTrue(frappe.db.has_index(f"tab{doctype}", name), f"{doctype} lacks {name}")
			for fields in getattr(module, "COMPOSITE_UNIQUE", ()):
				total += 1
				name = "unique_" + "_".join(fields)
				with self.subTest(doctype=doctype, index=name):
					self.assertTrue(frappe.db.has_index(f"tab{doctype}", name), f"{doctype} lacks {name}")
		self.assertEqual(total, 16)

	def test_install_hooks_create_nothing_frappe_syncs(self):
		"""`install.py` holds no desktop icon, role, index or customization code: those are files."""
		from whatsapp_next import install

		for gone in ("ensure_desktop_icons", "ensure_roles", "add_indexes", "ensure_customizations", "ensure_settings_defaults"):
			self.assertFalse(hasattr(install, gone), gone)
		# every product role is named by a DocType's permissions, so syncing the DocTypes creates it
		named = set(frappe.get_all("DocPerm", {"parent": ("like", "WhatsApp %"), "role": ("in", PRODUCT_ROLES)}, pluck="role"))
		self.assertEqual(named, set(PRODUCT_ROLES))


def _controller(doctype: str) -> str:
	scrubbed = frappe.scrub(doctype)
	return f"whatsapp_next.whatsapp_next.doctype.{scrubbed}.{scrubbed}"

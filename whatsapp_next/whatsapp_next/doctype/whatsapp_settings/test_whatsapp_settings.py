# Module role: tests for the WhatsApp Settings Single — permission matrix (D-014: SM writes,
# MGR reads, no secrets for MGR), URL / bound / provider / service-user / picker validation.

from __future__ import annotations

import frappe
from frappe.tests import IntegrationTestCase

from whatsapp_next.exceptions import WAValidationError
from whatsapp_next.install import ensure_roles
from whatsapp_next.tests.conftest_frappe import ensure_settings, ensure_test_user

IGNORE_TEST_RECORD_DEPENDENCIES = [
	"User",
	"Country",
	"Currency",
	"DocType",
	"WhatsApp Device",
	"WhatsApp Contact Group",
]

DOCTYPE = "WhatsApp Settings"


class TestWhatsAppSettings(IntegrationTestCase):
	@classmethod
	def setUpClass(cls) -> None:
		super().setUpClass()
		ensure_roles()
		ensure_settings()

	def _settings(self):
		return frappe.get_single(DOCTYPE)

	def test_permission_matrix(self) -> None:
		expected = {
			"System Manager": {"read": True, "write": True},
			"WhatsApp Manager": {"read": True, "write": False},
			"WhatsApp Agent": {"read": False, "write": False},
			"WhatsApp Viewer": {"read": False, "write": False},
			"WhatsApp Contact User": {"read": False, "write": False},
			"_none": {"read": False, "write": False},
		}
		for role, ptypes in expected.items():
			user = ensure_test_user(role)
			for ptype, allowed in ptypes.items():
				self.assertEqual(
					bool(frappe.has_permission(DOCTYPE, ptype, user=user)), allowed, f"{role} {ptype}"
				)

	def test_secrets_are_permlevel_one_passwords(self) -> None:
		meta = frappe.get_meta(DOCTYPE)
		for fieldname in ("customer_api_key", "api_key", "api_secret", "webhook_secret"):
			df = meta.get_field(fieldname)
			self.assertEqual(df.fieldtype, "Password", fieldname)
			self.assertEqual(df.permlevel, 1, fieldname)
		manager_levels = {p.permlevel for p in meta.permissions if p.role == "WhatsApp Manager"}
		self.assertEqual(manager_levels, {0})

	def test_platform_base_url_normalized(self) -> None:
		settings = self._settings()
		settings.platform_base_url = "  https://w-platform.example.com/  "
		settings.save(ignore_permissions=True)
		self.assertEqual(
			frappe.db.get_single_value(DOCTYPE, "platform_base_url"), "https://w-platform.example.com"
		)
		settings = self._settings()
		settings.platform_base_url = "http://insecure.example.com"
		with self.assertRaises(WAValidationError):
			settings.save(ignore_permissions=True)

	def test_queue_bounds(self) -> None:
		settings = self._settings()
		settings.messages_per_minute = 100
		with self.assertRaises(WAValidationError):
			settings.save(ignore_permissions=True)
		settings = self._settings()
		settings.plan_messages_per_minute = 10
		settings.messages_per_minute = 20
		with self.assertRaises(WAValidationError):
			settings.save(ignore_permissions=True)
		settings = self._settings()
		settings.retry_backoff_seconds = 10
		with self.assertRaises(WAValidationError):
			settings.save(ignore_permissions=True)
		settings = self._settings()
		settings.request_timeout = 200
		with self.assertRaises(WAValidationError):
			settings.save(ignore_permissions=True)

	def test_provider_must_be_registered(self) -> None:
		settings = self._settings()
		settings.provider = "meta_cloud"
		settings.save(ignore_permissions=True)
		self.assertEqual(frappe.db.get_single_value(DOCTYPE, "provider"), "meta_cloud")
		settings = self._settings()
		settings.provider = "nope"
		with self.assertRaises((WAValidationError, frappe.ValidationError)):
			settings.save(ignore_permissions=True)

	def test_command_service_user_rules(self) -> None:
		settings = self._settings()
		settings.enable_commands = 1
		settings.command_service_user = None
		with self.assertRaises(WAValidationError):
			settings.save(ignore_permissions=True)
		settings = self._settings()
		settings.enable_commands = 1
		settings.command_service_user = "Administrator"
		with self.assertRaises(WAValidationError):
			settings.save(ignore_permissions=True)
		settings = self._settings()
		settings.enable_commands = 1
		settings.command_service_user = ensure_test_user("System Manager")
		with self.assertRaises(WAValidationError):
			settings.save(ignore_permissions=True)
		settings = self._settings()
		settings.enable_commands = 1
		settings.command_service_user = ensure_test_user("_none")
		settings.save(ignore_permissions=True)
		self.assertEqual(frappe.db.get_single_value(DOCTYPE, "enable_commands"), 1)

	def test_picker_sources_unique_and_regular(self) -> None:
		settings = self._settings()
		settings.set("picker_sources", [])
		settings.append("picker_sources", {"document_type": "Contact", "phone_source": "Field"})
		settings.append("picker_sources", {"document_type": "Contact", "phone_source": "Field"})
		with self.assertRaises(WAValidationError):
			settings.save(ignore_permissions=True)
		settings = self._settings()
		settings.set("picker_sources", [])
		settings.append("picker_sources", {"document_type": "Contact Phone", "phone_source": "Field"})
		with self.assertRaises(WAValidationError):
			settings.save(ignore_permissions=True)
		settings = self._settings()
		settings.set("picker_sources", [])
		settings.append("picker_sources", {"document_type": "Contact", "phone_source": "Field"})
		settings.save(ignore_permissions=True)
		self.assertEqual(self._settings().picker_sources[0].label, "Contact")

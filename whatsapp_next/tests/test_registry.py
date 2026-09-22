# Tests for providers/registry.py: hook resolution, per-request cache, test override, credentials.

from __future__ import annotations

import frappe
from frappe.tests import IntegrationTestCase

from whatsapp_next.providers import registry
from whatsapp_next.providers.exceptions import NotSupportedError
from whatsapp_next.providers.snd_platform import SndPlatformProvider
from whatsapp_next.tests.conftest_frappe import as_user, ensure_settings, fake_provider


class TestRegistry(IntegrationTestCase):
	def setUp(self):
		ensure_settings(platform_base_url="https://platform.invalid")
		registry.clear_cache()
		registry.clear_override()

	def tearDown(self):
		registry.clear_override()
		registry.clear_cache()

	def test_list_and_get(self):
		keys = {row["key"] for row in registry.list_providers()}
		self.assertTrue({"snd_platform", "meta_cloud"} <= keys)
		provider = registry.get_provider("snd_platform")
		self.assertIsInstance(provider, SndPlatformProvider)
		self.assertIs(registry.get_provider("snd_platform"), provider)  # cached per request
		self.assertEqual(provider.settings.base_url, "https://platform.invalid")
		with self.assertRaises(NotSupportedError):
			registry.get_provider("does_not_exist")

	def test_override_for_tests(self):
		with fake_provider() as fake:
			self.assertIs(registry.get_provider(), fake)
		self.assertIsInstance(registry.get_provider("snd_platform"), SndPlatformProvider)

	def test_credentials_read_with_get_password_and_never_masked(self):
		settings = frappe.get_doc("WhatsApp Settings")
		settings.customer_api_key = "ck-plain"
		settings.api_key = "k-plain"
		settings.api_secret = "s-plain"
		settings.flags.ignore_permissions = True
		settings.save(ignore_permissions=True)
		creds = registry.credentials()
		self.assertEqual(creds["customer_api_key"], "ck-plain")
		self.assertEqual(creds["api_key"], "k-plain")
		self.assertEqual(creds["api_secret"], "s-plain")
		self.assertNotIn("*", "".join(creds.values()))
		# A manager session reads the Settings document with masked secrets (permlevel 1).
		with as_user("WhatsApp Manager"):
			doc = frappe.get_doc("WhatsApp Settings")
			doc.apply_fieldlevel_read_permissions()
			self.assertNotEqual(doc.get("api_secret"), "s-plain")
		self.assertEqual(repr(registry.build_settings()).count("plain"), 0)

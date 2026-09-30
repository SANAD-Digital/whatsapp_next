# Tests for `services.settings.store_secret`: a password written outside a document save (a
# sign-up's platform keys, a fetched webhook secret) must survive the next ordinary save of
# WhatsApp Settings. Before the fix the field stayed empty in `tabSingles`, and Frappe's
# `_save_passwords` read that as "cleared" and deleted the stored key.

from __future__ import annotations

import frappe
from frappe.tests import IntegrationTestCase
from frappe.utils.password import get_decrypted_password, remove_encrypted_password, set_encrypted_password

from whatsapp_next.providers.schemas import SignupState
from whatsapp_next.services import onboarding
from whatsapp_next.services.settings import store_secret

SETTINGS = "WhatsApp Settings"
FIELDS = ("customer_api_key", "customer_api_secret", "api_key", "api_secret", "webhook_secret")


def _read(fieldname: str) -> str | None:
	return get_decrypted_password(SETTINGS, SETTINGS, fieldname, raise_exception=False)


class TestSettingsSecrets(IntegrationTestCase):
	@classmethod
	def setUpClass(cls):
		super().setUpClass()
		# the site's own keys and placeholders, put back exactly as they were
		cls._secrets = {f: _read(f) for f in FIELDS}
		cls._singles = {f: frappe.db.get_single_value(SETTINGS, f) for f in FIELDS}

	@classmethod
	def tearDownClass(cls):
		for f in FIELDS:
			if cls._secrets[f]:
				set_encrypted_password(SETTINGS, SETTINGS, cls._secrets[f], f)
			else:
				remove_encrypted_password(SETTINGS, SETTINGS, f)
			frappe.db.set_single_value(SETTINGS, f, cls._singles[f] or "", update_modified=False)
		frappe.clear_document_cache(SETTINGS, SETTINGS)
		# committed: the runner's rollback must not undo the restore
		frappe.db.commit()
		super().tearDownClass()

	def _save_settings_as_a_screen_would(self):
		frappe.clear_document_cache(SETTINGS, SETTINGS)
		doc = frappe.get_single(SETTINGS)
		doc.flags.ignore_permissions = True
		doc.flags.ignore_validate = True
		doc.save(ignore_permissions=True)

	def test_a_stored_secret_survives_a_settings_save(self):
		store_secret("api_secret", "secret-kept-after-save")
		self.assertEqual(
			frappe.db.get_single_value(SETTINGS, "api_secret"), "*" * len("secret-kept-after-save")
		)
		self._save_settings_as_a_screen_would()
		self.assertEqual(_read("api_secret"), "secret-kept-after-save")

	def test_signup_keys_survive_a_settings_save(self):
		state = SignupState(
			request_key=None,
			status="Active",
			credentials={"customer_api_key": "ck-signup", "api_key": "ak-signup", "api_secret": "as-signup"},
		)
		self.assertTrue(onboarding.store_signup_credentials(state, user="Administrator"))
		self._save_settings_as_a_screen_would()
		self.assertEqual(_read("customer_api_key"), "ck-signup")
		self.assertEqual(_read("api_key"), "ak-signup")
		self.assertEqual(_read("api_secret"), "as-signup")

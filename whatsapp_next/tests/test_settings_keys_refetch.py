# New platform keys may be another account's: saving them fetches the webhook secret again, or every
# signature from the platform would fail against the old account's secret (found 2026-10-13).

from unittest.mock import patch

import frappe
from frappe.tests import IntegrationTestCase

from whatsapp_next.services import settings as settings_service


class TestKeysRefetchSecret(IntegrationTestCase):
	def test_new_keys_refetch_the_webhook_secret(self):
		with patch.object(frappe, "enqueue") as enqueue:
			settings_service.save_fields({"api_key": "wa-test-key-" + frappe.generate_hash(length=6)}, section="credentials")
		methods = [c.args[0] for c in enqueue.call_args_list]
		self.assertIn("whatsapp_next.services.webhook_setup.fetch_secret", methods)
		frappe.db.rollback()

	def test_other_settings_do_not(self):
		doc = frappe.get_doc("WhatsApp Settings")
		with patch.object(frappe, "enqueue") as enqueue:
			settings_service.save_fields({"unknown_command_reply": (doc.unknown_command_reply or "") + " "}, section="commands")
		methods = [c.args[0] for c in enqueue.call_args_list]
		self.assertNotIn("whatsapp_next.services.webhook_setup.fetch_secret", methods)
		frappe.db.rollback()

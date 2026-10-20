"""The platform's call that a sign-up's number is confirmed wakes the waiting page (realtime)."""

from __future__ import annotations

from unittest.mock import patch

import frappe
from frappe.tests import IntegrationTestCase

from whatsapp_next.services import onboarding
from whatsapp_next.tests.conftest_frappe import as_user, fake_provider
from whatsapp_next.webhooks.v1 import signup as callback


class TestSignupCallback(IntegrationTestCase):
	def test_start_hands_the_platform_a_callback_and_keeps_its_token(self):
		with fake_provider() as provider, as_user("System Manager"):
			with patch.object(type(provider), "start_signup", wraps=provider.start_signup) as start:
				state = onboarding.start_signup(None, "+967777667663", "Callback Person", None, "whatsapp")
		sent = start.call_args.kwargs["callback"]
		self.assertTrue(sent["url"].endswith("/api/method/" + onboarding.SIGNUP_CALLBACK))
		kept = frappe.cache.get_value(f"{onboarding.SIGNUP_CALLBACK_KEY}:{sent['token']}")
		self.assertEqual(kept["request_key"], state.request_key)

	def test_a_known_token_wakes_the_page_once(self):
		frappe.cache.set_value(f"{onboarding.SIGNUP_CALLBACK_KEY}:tok-1", {"request_key": "rk-1", "user": "Administrator"})
		with patch.object(frappe, "publish_realtime") as publish:
			self.assertEqual(callback.confirmed(callback_token="tok-1", status="Verified"), {"ok": True})
			self.assertEqual(callback.confirmed(callback_token="tok-1", status="Verified"), {"ok": False})  # used up
			self.assertEqual(callback.confirmed(callback_token="unknown", status="Verified"), {"ok": False})
		publish.assert_called_once()
		self.assertEqual(publish.call_args.args[:2], ("wa:signup:status", {"request_key": "rk-1", "status": "Verified"}))
		self.assertEqual(publish.call_args.kwargs["user"], "Administrator")

# Tests for Settings → Policy → "Send only to": a site that names chats there sends to nothing else,
# whichever platform it sends through (owner, 2026-11-08; the list moved from site_config to the
# screen on 2026-11-10). The request to the platform is replaced in every test here: nothing can leave.

from __future__ import annotations

from unittest.mock import patch

import frappe
from frappe.tests import IntegrationTestCase

from whatsapp_next.providers import exceptions as pex
from whatsapp_next.providers import snd_platform
from whatsapp_next.providers.schemas import NormalizedMessage

ALLOWED = ["967782309999", "+967 777 667 663", "120363000000111@g.us"]


def build_normalized_message(ref, phone=None, jid=None, kind="Individual"):
	return NormalizedMessage(
		client_ref=ref, platform_device="WAD-T", recipient_type=kind, phone_e164=phone, jid=jid, body="hi"
	)


class TestSendAllowlist(IntegrationTestCase):
	def setUp(self):
		from whatsapp_next.services import settings as settings_service

		frappe.db.savepoint("send_only_to")
		self.addCleanup(self._restore)
		settings_service.save_fields({"send_only_to": [{"phone_e164": n} for n in ALLOWED]}, section="policy")
		frappe.clear_document_cache("WhatsApp Settings", "WhatsApp Settings")
		self.provider = snd_platform.SndPlatformProvider.__new__(snd_platform.SndPlatformProvider)

	@staticmethod
	def _restore():
		frappe.db.rollback(save_point="send_only_to")
		frappe.clear_document_cache("WhatsApp Settings", "WhatsApp Settings")

	def test_only_listed_chats_pass(self):
		self.assertTrue(snd_platform.recipient_allowed(build_normalized_message("a", phone="+967782309999")))
		self.assertTrue(snd_platform.recipient_allowed(build_normalized_message("b", phone="+967777667663")))
		self.assertFalse(snd_platform.recipient_allowed(build_normalized_message("c", phone="+966500008003")))
		self.assertTrue(
			snd_platform.recipient_allowed(
				build_normalized_message("d", jid="120363000000111@g.us", kind="Group")
			)
		)
		self.assertFalse(
			snd_platform.recipient_allowed(
				build_normalized_message("e", jid="120363000000999@g.us", kind="Group")
			)
		)

	def test_an_empty_list_sends_to_anyone(self):
		from whatsapp_next.services import settings as settings_service

		settings_service.save_fields({"send_only_to": []}, section="policy")
		frappe.clear_document_cache("WhatsApp Settings", "WhatsApp Settings")
		self.assertTrue(snd_platform.recipient_allowed(build_normalized_message("a", phone="+966500008003")))

	def test_site_config_no_longer_decides(self):
		"""The list left site_config (owner, 2026-11-09: «مكانها غلط»): a key there changes nothing."""
		with patch.dict(frappe.local.conf, {"wa_send_allowlist": ["966500008003"]}):
			self.assertFalse(
				snd_platform.recipient_allowed(build_normalized_message("a", phone="+966500008003"))
			)

	def test_a_single_send_outside_the_list_never_reaches_the_platform(self):
		with patch.object(snd_platform.SndPlatformProvider, "_request") as request:
			with self.assertRaises(pex.ValidationError):
				self.provider.send_message(build_normalized_message("a", phone="+966500008003"))
		request.assert_not_called()

	def test_a_batch_sends_only_its_listed_numbers(self):
		answer = {"accepted": [{"client_ref": "ok", "queue_id": "Q1"}], "errors": []}
		with (
			patch.object(snd_platform.SndPlatformProvider, "_request", return_value=answer) as request,
			patch.object(
				snd_platform.SndPlatformProvider,
				"_message_payload",
				side_effect=lambda m: {"client_ref": m.client_ref},
			),
		):
			result = self.provider.send_batch(
				[
					build_normalized_message("ok", phone="+967782309999"),
					build_normalized_message("no", phone="+966500008003"),
				],
				"B1",
			)

		self.assertEqual([m["client_ref"] for m in request.call_args.kwargs["body"]["messages"]], ["ok"])
		self.assertEqual(
			[(e.client_ref, e.code) for e in result.errors], [("no", snd_platform.NOT_ALLOWED_CODE)]
		)

	def test_a_batch_with_no_listed_number_asks_the_platform_nothing(self):
		with patch.object(snd_platform.SndPlatformProvider, "_request") as request:
			result = self.provider.send_batch([build_normalized_message("no", phone="+966500008003")], "B2")
		request.assert_not_called()
		self.assertEqual(len(result.errors), 1)

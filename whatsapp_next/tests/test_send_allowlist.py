# Tests for `wa_send_allowlist`: a site that has it sends to no other number and no group, whichever
# platform it sends through (owner, 2026-11-08). The request to the platform is replaced in every
# test here: nothing can leave.

from __future__ import annotations

from unittest.mock import patch

import frappe
from frappe.tests import IntegrationTestCase

from whatsapp_next.providers import exceptions as pex
from whatsapp_next.providers import snd_platform
from whatsapp_next.providers.schemas import NormalizedMessage

ALLOWED = ["967782309999", "+967 777 667 663"]


def msg(ref, phone=None, jid=None, kind="Individual"):
	return NormalizedMessage(
		client_ref=ref, platform_device="WAD-T", recipient_type=kind, phone_e164=phone, jid=jid, body="hi"
	)


class TestSendAllowlist(IntegrationTestCase):
	def setUp(self):
		self.conf = patch.dict(frappe.local.conf, {"wa_send_allowlist": ALLOWED})
		self.conf.start()
		self.addCleanup(self.conf.stop)
		self.provider = snd_platform.SndPlatformProvider.__new__(snd_platform.SndPlatformProvider)

	def test_only_listed_numbers_pass(self):
		self.assertTrue(snd_platform.recipient_allowed(msg("a", phone="+967782309999")))
		self.assertTrue(snd_platform.recipient_allowed(msg("b", jid="967777667663@s.whatsapp.net")))
		self.assertFalse(snd_platform.recipient_allowed(msg("c", phone="+966500008003")))
		self.assertFalse(snd_platform.recipient_allowed(msg("d", jid="120363000000@g.us", kind="Group")))

	def test_without_a_list_nothing_changes(self):
		with patch.dict(frappe.local.conf, {"wa_send_allowlist": None}):
			self.assertTrue(snd_platform.recipient_allowed(msg("a", phone="+966500008003")))

	def test_a_single_send_outside_the_list_never_reaches_the_platform(self):
		with patch.object(snd_platform.SndPlatformProvider, "_request") as request:
			with self.assertRaises(pex.ValidationError):
				self.provider.send_message(msg("a", phone="+966500008003"))
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
				[msg("ok", phone="+967782309999"), msg("no", phone="+966500008003")], "B1"
			)

		self.assertEqual([m["client_ref"] for m in request.call_args.kwargs["body"]["messages"]], ["ok"])
		self.assertEqual(
			[(e.client_ref, e.code) for e in result.errors], [("no", snd_platform.NOT_ALLOWED_CODE)]
		)

	def test_a_batch_with_no_listed_number_asks_the_platform_nothing(self):
		with patch.object(snd_platform.SndPlatformProvider, "_request") as request:
			result = self.provider.send_batch([msg("no", phone="+966500008003")], "B2")
		request.assert_not_called()
		self.assertEqual(len(result.errors), 1)

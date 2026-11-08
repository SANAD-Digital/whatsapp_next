# The terms accepted on the setup wizard's terms step reach the platform with the sign-up, so the
# account keeps when and which version was accepted (WN-014). Nothing leaves: the provider's request
# is replaced, and the API test runs on the fake provider.

from __future__ import annotations

from unittest.mock import patch

from frappe.tests import IntegrationTestCase

from whatsapp_next.providers.snd_platform import SndPlatformProvider


class TestTermsAcceptance(IntegrationTestCase):
	def _body(self, **kwargs):
		provider = SndPlatformProvider.__new__(SndPlatformProvider)
		with patch.object(SndPlatformProvider, "_request", return_value={"token": "t"}) as request:
			provider.start_signup("starter", "+967782309999", "Name", "", "whatsapp", **kwargs)
		return request.call_args.kwargs["body"]

	def test_accepted_terms_go_with_the_sign_up(self):
		body = self._body(terms={"version": "2026-10"})
		self.assertEqual((body["terms_accepted"], body["terms_version"]), (1, "2026-10"))

	def test_a_sign_up_without_them_sends_nothing_new(self):
		self.assertNotIn("terms_accepted", self._body())

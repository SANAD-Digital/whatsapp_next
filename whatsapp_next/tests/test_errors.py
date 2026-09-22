# Tests for services/errors.py classification and the exception hierarchy HTTP codes.

from __future__ import annotations

from frappe.tests import IntegrationTestCase

from whatsapp_next import exceptions as wex
from whatsapp_next.providers import exceptions as pex
from whatsapp_next.services.errors import ERROR_CODES, classify


class TestErrors(IntegrationTestCase):
	def test_exception_http_codes(self):
		self.assertEqual(wex.WAPermissionError.http_status_code, 403)
		self.assertEqual(wex.WAValidationError.http_status_code, 417)
		self.assertEqual(wex.WANotFoundError.http_status_code, 404)
		self.assertEqual(wex.WAStateConflictError.http_status_code, 409)
		self.assertEqual(wex.WAProviderAuthError.http_status_code, 502)
		self.assertEqual(wex.WAProviderUnavailableError.http_status_code, 503)
		self.assertEqual(wex.WAProviderRejectedError.http_status_code, 422)
		self.assertEqual(wex.WARateLimitError.http_status_code, 429)
		self.assertEqual(wex.WANotSupportedError.http_status_code, 501)
		self.assertTrue(issubclass(wex.WAInvalidPhoneError, wex.WAValidationError))
		self.assertTrue(issubclass(wex.WADeviceOfflineError, wex.WAStateConflictError))

	def test_classify_exceptions(self):
		self.assertEqual(classify(pex.DeviceOfflineError("x")).code, "device_disconnected")
		self.assertTrue(classify(pex.DeviceOfflineError("x")).retryable)
		self.assertEqual(classify(pex.TransientError("gateway")).code, "timeout")
		self.assertEqual(classify(pex.RateLimitError("slow")).code, "rate_limited")
		self.assertEqual(classify(pex.AuthError("bad key")).code, "auth")
		self.assertEqual(classify(pex.QuotaExceededError("q")).code, "insufficient_balance")
		self.assertFalse(classify(pex.QuotaExceededError("q")).retryable)
		self.assertEqual(classify(pex.FeatureNotInPlanError("f")).code, "platform_rejected")
		self.assertEqual(
			classify(pex.BusinessRejectedError("Recipient is not a registered WhatsApp user")).code,
			"recipient_not_registered",
		)
		self.assertEqual(
			classify(pex.BusinessRejectedError("nope", code="CLIENT_REF_DUPLICATE")).code, "platform_rejected"
		)
		self.assertEqual(classify(pex.NotSupportedError("n")).code, "platform_rejected")

	def test_classify_codes_and_text(self):
		self.assertEqual(classify(None, provider_code="DEVICE_NOT_CONNECTED").code, "device_disconnected")
		self.assertEqual(
			classify("Selected device is not connected. Complete QR authentication first.").code,
			"device_disconnected",
		)
		self.assertEqual(classify("Request timed out").code, "timeout")
		self.assertEqual(classify("Invalid template variables").code, "invalid_template")
		self.assertEqual(classify("Invalid phone number").code, "invalid_phone")
		self.assertEqual(classify("").code, "unknown")
		self.assertEqual(classify("something odd").code, "unknown")
		for code in ERROR_CODES:
			self.assertIsInstance(code, str)

	def test_message_pii_masked(self):
		result = classify("Recipient 966501234567 not registered")
		self.assertNotIn("966501234567", result.message)
		self.assertIn("<phone>", result.message)

# Tests for api/v1/onboarding.py and services/onboarding.py (build order B-18): status steps,
# provider sign-up pass-through with credentials stored (never returned), password reset,
# save_credentials audit, and complete_setup guards.

from __future__ import annotations

import frappe
from frappe.tests import IntegrationTestCase
from frappe.utils.password import remove_encrypted_password, set_encrypted_password

from whatsapp_next.api.v1 import onboarding as api
from whatsapp_next.api.v1 import settings as settings_api
from whatsapp_next.exceptions import (
	WAInvalidPhoneError,
	WAPermissionError,
	WAStateConflictError,
	WAValidationError,
)
from whatsapp_next.services import onboarding as svc
from whatsapp_next.tests.conftest_frappe import (
	as_user,
	delete_all,
	ensure_device,
	ensure_settings,
	fake_provider,
)

SETTINGS = "WhatsApp Settings"
SECRETS = ("customer_api_key", "api_key", "api_secret")
FIELDS = (
	"platform_base_url",
	"connection_status",
	"webhook_status",
	"setup_completed",
	"setup_completed_at",
	"credentials_updated_at",
)
DEVICE = "WAD-APITEST-ONB1"


class TestApiOnboarding(IntegrationTestCase):
	@classmethod
	def setUpClass(cls):
		super().setUpClass()
		ensure_settings()
		s = frappe.get_doc(SETTINGS)
		cls._saved = {f: s.get(f) for f in FIELDS}
		cls._secrets = {f: s.get_password(f, raise_exception=False) for f in SECRETS}

	@classmethod
	def tearDownClass(cls):
		frappe.db.set_value(SETTINGS, SETTINGS, cls._saved, update_modified=False)
		for f, value in cls._secrets.items():
			if value:
				set_encrypted_password(SETTINGS, SETTINGS, value, f)
			else:
				remove_encrypted_password(SETTINGS, SETTINGS, f)
		frappe.clear_document_cache(SETTINGS, SETTINGS)
		delete_all("WhatsApp Device", {"platform_device": DEVICE})
		delete_all("WhatsApp Audit Log", {"action": "Credentials Changed", "user": "wa-test-sm@example.com"})
		super().tearDownClass()

	def test_role_gates(self):
		with as_user("_none"), self.assertRaises(WAPermissionError):
			api.get_status()
		with as_user("WhatsApp Viewer"):
			self.assertIn("steps", api.get_status())
		with as_user("WhatsApp Contact User"):
			self.assertIn("steps", api.get_status())
		with as_user("WhatsApp Manager"), self.assertRaises(WAPermissionError):
			api.save_credentials(api_key="x")

	def test_status_shape(self):
		with as_user("WhatsApp Viewer"):
			out = api.get_status()
		self.assertEqual([s["key"] for s in out["steps"]], list(svc.STEP_KEYS))
		self.assertIn("setup_completed", out)
		self.assertIn("redirect_enabled", out)
		self.assertTrue(out["webhook_url"].endswith("receiver.receive"))

	def test_signup_flow_stores_credentials(self):
		for f in SECRETS:
			remove_encrypted_password(SETTINGS, SETTINGS, f)
		with fake_provider(), as_user("System Manager") as sm:
			with self.assertRaises(WAInvalidPhoneError):
				api.start_signup(plan_code="trial", mobile="12", full_name="Api Test", email="a@b.c")
			with self.assertRaises(WAValidationError):
				api.start_signup(
					plan_code="trial",
					mobile="+966500910001",
					full_name="Api Test",
					email="a@b.c",
					channel="fax",
				)
			started = api.start_signup(
				plan_code="trial", mobile="0500910001", full_name="Api Test", email="a@b.c", channel="sms"
			)
			self.assertEqual(started["request_key"], "req-1")
			self.assertEqual(api.get_signup_status(request_key="req-1")["status"], "Pending")
			done = api.complete_signup(request_key="req-1", code="123456")
			self.assertEqual(done, {"ok": True, "status": "Completed", "credentials_stored": True})
			self.assertNotIn("ck", str(done))
			s = frappe.get_doc(SETTINGS)
			self.assertEqual(s.get_password("api_key", raise_exception=False), "k")
			self.assertTrue(
				frappe.db.exists("WhatsApp Audit Log", {"action": "Credentials Changed", "user": sm})
			)
			self.assertEqual(api.start_password_reset(identifier="a@b.c")["ok"], True)
			# The Settings API still never returns the values.
			creds = settings_api.get_settings(section="credentials")["credentials"]
			self.assertTrue(creds["has_customer_api_key"])
			self.assertNotIn("customer_api_key", creds)

	def test_save_credentials(self):
		with as_user("System Manager"):
			with self.assertRaises(WAValidationError):
				api.save_credentials()
			with self.assertRaises(WAValidationError):
				api.save_credentials(platform_base_url="http://insecure.example")
			out = api.save_credentials(platform_base_url="https://api.example.test/", api_secret="apitest-s")
			self.assertEqual(out, {"ok": True, "fields_written": ["platform_base_url", "api_secret"]})
			self.assertEqual(
				frappe.db.get_single_value(SETTINGS, "platform_base_url"), "https://api.example.test"
			)
			self.assertEqual(
				frappe.get_doc(SETTINGS).get_password("api_secret", raise_exception=False), "apitest-s"
			)
			row = frappe.get_all(
				"WhatsApp Audit Log",
				filters={"action": "Credentials Changed"},
				fields=["fields_written", "details"],
				order_by="creation desc",
				limit=1,
			)[0]
			self.assertEqual(row.fields_written, "api_secret, platform_base_url")
			self.assertNotIn("apitest-s", row.details or "")

	def test_complete_setup_guards(self):
		frappe.db.set_value(
			SETTINGS,
			SETTINGS,
			{"connection_status": "Failed", "webhook_status": None, "setup_completed": 0},
			update_modified=False,
		)
		frappe.clear_document_cache(SETTINGS, SETTINGS)
		with fake_provider(), as_user("System Manager"):
			with self.assertRaises(WAStateConflictError):
				api.complete_setup()
			api.save_credentials(
				platform_base_url="https://api.example.test",
				customer_api_key="c",
				api_key="k",
				api_secret="s",
			)
			self.assertTrue(settings_api.test_connection()["ok"])
			with self.assertRaises(WAStateConflictError):
				api.complete_setup()  # device (unless another test left one Connected) or webhook
			ensure_device("ApiTest Onboarding Device", DEVICE, status="Connected", phone="+966500910002")
			with self.assertRaises(WAStateConflictError) as ctx:
				api.complete_setup()
			self.assertIn("webhook", str(ctx.exception))
			frappe.db.set_value(SETTINGS, SETTINGS, "webhook_status", "Active", update_modified=False)
			frappe.clear_document_cache(SETTINGS, SETTINGS)
			self.assertEqual(api.complete_setup(), {"setup_completed": True})
			self.assertTrue(frappe.db.get_single_value(SETTINGS, "setup_completed"))
			status = api.get_status()
			self.assertTrue(status["setup_completed"])
			self.assertTrue(all(s["done"] for s in status["steps"]))

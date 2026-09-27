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
	WANotSupportedError,
	WAPermissionError,
	WAProviderAuthError,
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
	"webhook_endpoint",
	"webhook_endpoint_url",
	"webhook_events",
	"webhook_max_retries",
	"webhook_synced_at",
)
# Signing in runs `link_site`, which stores the platform's webhook secret: put the site's back.
RESTORED_SECRETS = (*SECRETS, "webhook_secret")
DEVICE = "WAD-APITEST-ONB1"


class TestApiOnboarding(IntegrationTestCase):
	@classmethod
	def setUpClass(cls):
		super().setUpClass()
		ensure_settings()
		s = frappe.get_doc(SETTINGS)
		cls._saved = {f: s.get(f) for f in FIELDS}
		cls._secrets = {f: s.get_password(f, raise_exception=False) for f in RESTORED_SECRETS}

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
			self.assertEqual(
				{k: done[k] for k in ("ok", "status", "credentials_stored")},
				{"ok": True, "status": "Completed", "credentials_stored": True},
			)
			self.assertTrue(done["connection"]["ok"])
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


class TestApiOnboardingPlatformFlow(IntegrationTestCase):
	"""The rest of the setup screen's flow: bootstrap, password sign-up, sign-in, coupons."""

	@classmethod
	def setUpClass(cls):
		super().setUpClass()
		ensure_settings()
		s = frappe.get_doc(SETTINGS)
		cls._saved = {f: s.get(f) for f in FIELDS}
		cls._secrets = {f: s.get_password(f, raise_exception=False) for f in RESTORED_SECRETS}

	@classmethod
	def tearDownClass(cls):
		frappe.db.set_value(SETTINGS, SETTINGS, cls._saved, update_modified=False)
		for f, value in cls._secrets.items():
			if value:
				set_encrypted_password(SETTINGS, SETTINGS, value, f)
			else:
				remove_encrypted_password(SETTINGS, SETTINGS, f)
		frappe.clear_document_cache(SETTINGS, SETTINGS)
		super().tearDownClass()

	def test_bootstrap_carries_the_platform_plans_and_no_second_country_list(self):
		with fake_provider(), as_user("System Manager"):
			out = api.get_signup_bootstrap()
		self.assertEqual(out["plans"][0]["plan_code"], "trial")
		self.assertEqual(out["code_ttl_minutes"], 10)
		self.assertIn("device_ready", out)
		# Countries are api.v1.phone.get_countries' job; two answers would drift apart.
		self.assertNotIn("countries", out)

	def test_signup_carries_a_coupon_and_a_password(self):
		for f in SECRETS:
			remove_encrypted_password(SETTINGS, SETTINGS, f)
		with fake_provider() as provider, as_user("System Manager"):
			api.start_signup(
				plan_code="trial",
				mobile="0500910007",
				full_name="Coupon Tenant",
				email="c@b.c",
				channel="sms",
				coupon_code="BSHQ-FREE2",
			)
			started = dict(provider.calls)["start_signup"]
			self.assertEqual(started["coupon_code"], "BSHQ-FREE2")

			# The code check is its own step now.
			self.assertEqual(api.verify_code(request_key="req-1", code="123456"), {"ok": True, "status": "Verified"})
			with self.assertRaises(WAValidationError):
				api.verify_code(request_key="req-1", code="000000")

			done = api.complete_signup(request_key="req-1", password="a-real-Password-1!")
			self.assertEqual(
				{k: done[k] for k in ("ok", "status", "credentials_stored")},
				{"ok": True, "status": "Completed", "credentials_stored": True},
			)
			self.assertTrue(dict(provider.calls)["complete_signup"]["with_password"])
			self.assertNotIn("a-real-Password-1!", str(done))
			self.assertEqual(
				frappe.get_doc(SETTINGS).get_password("customer_api_key", raise_exception=False), "ck"
			)

	def test_login_stores_the_keys_and_returns_none_of_them(self):
		for f in SECRETS:
			remove_encrypted_password(SETTINGS, SETTINGS, f)
		with fake_provider(), as_user("System Manager") as sm:
			with self.assertRaises(WAProviderAuthError):
				api.login(
					platform_base_url="https://api.example.test",
					email="tenant@example.test",
					password="wrong-password",
				)
			out = api.login(
				platform_base_url="https://api.example.test",
				email="tenant@example.test",
				password="right-password",
			)
		self.assertEqual(out["ok"], True)
		self.assertEqual(out["customer_name"], "Fake Tenant")
		# Not one key, and not the password, may appear in the answer.
		for secret in ("ck", "right-password"):
			self.assertNotIn(secret, str(out))
		self.assertNotIn("credentials", out)
		s = frappe.get_doc(SETTINGS)
		self.assertEqual(s.get_password("customer_api_key", raise_exception=False), "ck")
		self.assertEqual(s.get_password("api_secret", raise_exception=False), "s")
		self.assertEqual(frappe.db.get_single_value(SETTINGS, "platform_base_url"), "https://api.example.test")
		self.assertTrue(
			frappe.db.exists("WhatsApp Audit Log", {"action": "Credentials Changed", "user": sm})
		)

	def test_login_links_the_site(self):
		"""Owner, Gate 2: the keys, the connection test, the account's devices and the webhook all
		come from signing in; the platform address is the default, saved into Settings."""
		from unittest.mock import patch

		from whatsapp_next.providers import registry
		from whatsapp_next.providers.schemas import DeviceState
		from whatsapp_next.services import webhook_setup

		frappe.db.set_single_value(SETTINGS, {"platform_base_url": None, "webhook_endpoint": None, "webhook_events": None})
		frappe.clear_document_cache(SETTINGS, SETTINGS)
		set_encrypted_password(SETTINGS, SETTINGS, "stale-secret", "webhook_secret")
		with fake_provider() as provider, as_user("System Manager"), patch.object(
			registry, "platform_base_url", return_value="https://platform.example.test"
		):
			provider.devices["WAD-ONB-LINK1"] = DeviceState(
				platform_device="WAD-ONB-LINK1", device_name="Front desk", phone_e164="+966500910077", status="Connected"
			)
			try:
				out = api.login(platform_base_url="", email="tenant@example.test", password="right-password")
				self.assertEqual(out["connection"], {"ok": True, "error": None})
				self.assertEqual(out["webhook"], {"ok": True, "status": "Active"})
				self.assertEqual(out["devices"], {"ok": True, "adopted": 1})
				self.assertNotIn("fake-secret", str(out))
				s = frappe.get_doc(SETTINGS)
				self.assertEqual(s.platform_base_url, "https://platform.example.test")
				self.assertEqual(s.connection_status, "OK")
				self.assertEqual(s.webhook_status, "Active")
				self.assertEqual(set(frappe.parse_json(s.webhook_events)), set(webhook_setup.DEFAULT_EVENTS))
				# a stored secret proves nothing after new credentials: it is always refetched
				self.assertEqual(s.get_password("webhook_secret", raise_exception=False), "fake-secret")
				device = frappe.db.get_value(
					"WhatsApp Device", {"platform_device": "WAD-ONB-LINK1"}, ["device_name", "status", "phone_e164"], as_dict=True
				)
				self.assertEqual((device.device_name, device.status, device.phone_e164), ("Front desk", "Connected", "+966500910077"))
				# signing in again adopts nothing twice
				self.assertEqual(api.login(platform_base_url="", email="tenant@example.test", password="right-password")["devices"]["adopted"], 0)
			finally:
				delete_all("WhatsApp Device", {"platform_device": "WAD-ONB-LINK1"})

	def test_a_failed_connection_stops_the_linking_there(self):
		from unittest.mock import patch

		from whatsapp_next.providers.schemas import HealthStatus

		with fake_provider() as provider, as_user("System Manager"):
			with patch.object(provider, "health_check", return_value=HealthStatus(ok=False, error="down")):
				out = api.login(platform_base_url="https://api.example.test", email="t@example.test", password="right-password")
		self.assertTrue(out["ok"])
		self.assertEqual(out["connection"], {"ok": False, "error": "down"})
		self.assertNotIn("webhook", out)
		self.assertNotIn("configure_webhook", dict(provider.calls))

	def test_coupon_validation_is_an_answer_not_an_error(self):
		with fake_provider(), as_user("System Manager"):
			good = api.validate_coupon(code="BSHQ-FREE2")
			bad = api.validate_coupon(code="NOPE-11111")
		self.assertEqual((good["valid"], good["reward_value"]), (True, 1))
		self.assertEqual((bad["valid"], bad["reason"]), (False, "COUPON_NOT_FOUND"))

	def test_referral_coupon_is_readable_by_any_whatsapp_role(self):
		with fake_provider(), as_user("WhatsApp Viewer"):
			out = api.get_referral_coupon()
		self.assertEqual(out["coupon"]["code"], "BSHQ-7K42P")
		self.assertEqual(out["redemption_count"], 2)
		with fake_provider(), as_user("_none"), self.assertRaises(WAPermissionError):
			api.get_referral_coupon()

	def test_password_reset_runs_through_the_provider(self):
		with fake_provider(), as_user("System Manager"):
			started = api.start_password_reset(identifier="a@b.c")
			self.assertEqual((started["ok"], started["request_key"]), (True, "reset-1"))
			self.assertEqual(api.get_password_reset_status(request_key="reset-1")["status"], "Pending")
			done = api.complete_password_reset(request_key="reset-1", password="a-real-Password-1!")
			self.assertEqual(done, {"ok": True, "status": "Completed"})

	def test_the_new_endpoints_are_closed_to_everyone_else(self):
		with fake_provider(), as_user("WhatsApp Manager"):
			for call in (
				lambda: api.get_signup_bootstrap(),
				lambda: api.login(platform_base_url="", email="a@b.c", password="x"),
				lambda: api.validate_coupon(code="BSHQ-FREE2"),
				lambda: api.complete_password_reset(request_key="r", password="x"),
			):
				with self.assertRaises(WAPermissionError):
					call()

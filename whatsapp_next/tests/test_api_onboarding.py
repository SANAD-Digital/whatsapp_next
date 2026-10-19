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
	WAStateConflictError,
	WAValidationError,
)
from whatsapp_next.providers import registry
from whatsapp_next.services import onboarding as svc
from whatsapp_next.services import usage_sync
from whatsapp_next.tests.conftest_frappe import (
	as_user,
	delete_all,
	ensure_device,
	ensure_settings,
	fake_provider,
)

SETTINGS = "WhatsApp Settings"
SECRETS = ("customer_api_key", "customer_api_secret", "api_key", "api_secret")
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
	"redirect_unregistered_to_wizard",
	# `test_connection` runs `sync_subscription` against the fake provider: without these the
	# committed tearDown left "Fake" as the dev site's plan
	*usage_sync.FIELDS,
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
		# committed: the runner's rollback must not undo the restore (it wiped the dev site's keys)
		frappe.db.commit()
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

	def test_every_screen_sends_back_to_the_setup_until_it_is_done(self):
		"""Owner, 2026-10-19: while the site is not signed in to its platform or the wizard was never
		finished, every user is sent back to the setup; whoever cannot run it is told instead."""
		from whatsapp_next.boot import boot_session

		def state(**values):
			frappe.db.set_single_value(SETTINGS, values)
			frappe.clear_document_cache(SETTINGS, SETTINGS)

		# never registered
		state(redirect_unregistered_to_wizard=1, setup_completed=0)
		for f in SECRETS:
			remove_encrypted_password(SETTINGS, SETTINGS, f)
		frappe.clear_document_cache(SETTINGS, SETTINGS)
		with as_user("System Manager"):
			self.assertTrue(svc.should_redirect_to_wizard())
			boot = frappe._dict()
			boot_session(boot)
			self.assertTrue(boot.whatsapp_next.setup_redirect)
			self.assertTrue(boot.whatsapp_next.can_setup)
		with as_user("WhatsApp Manager"):
			self.assertTrue(svc.should_redirect_to_wizard())
			self.assertFalse(svc.can_setup(), "a Manager is told to ask a System Manager")
		with as_user("WhatsApp Agent"):
			self.assertTrue(svc.should_redirect_to_wizard(), "every user is sent back")
			self.assertFalse(svc.can_setup(), "an Agent is told instead of taken to the wizard")
			self.assertTrue(api.get_status()["needs_setup"])

		# the setting switches it off
		state(redirect_unregistered_to_wizard=0)
		with as_user("System Manager"):
			self.assertFalse(svc.should_redirect_to_wizard(), "the setting switches it off")

		# signed in, but the wizard never finished: still sent back
		state(redirect_unregistered_to_wizard=1, platform_base_url="https://platform.example.com", setup_completed=0)
		for f in svc.REQUIRED_CREDENTIALS:
			set_encrypted_password(SETTINGS, SETTINGS, "k-" + f, f)
		frappe.clear_document_cache(SETTINGS, SETTINGS)
		with as_user("WhatsApp Agent"):
			self.assertTrue(svc.should_redirect_to_wizard(), "an unfinished setup still sends back")

		# signed in and finished: the product opens
		state(setup_completed=1)
		with as_user("WhatsApp Agent"):
			self.assertFalse(svc.should_redirect_to_wizard(), "a finished setup lets everyone in")
			self.assertFalse(api.get_status()["needs_setup"])

	def test_a_key_from_another_site_reads_as_signed_out_without_a_dialog(self):
		# a database restored from another site: its secrets are encrypted with that site's key
		from cryptography.fernet import Fernet

		from whatsapp_next.services import secrets

		foreign = Fernet(Fernet.generate_key()).encrypt(b"other-site-key").decode()
		saved = {f: secrets.read(f) for f in ("customer_api_key", "api_key", "api_secret", "customer_api_secret")}
		try:
			for f in saved:
				frappe.db.sql(
					"""insert into `__Auth` (doctype, name, fieldname, password, encrypted) values (%s, %s, %s, %s, 1)
					on duplicate key update password = values(password), encrypted = 1""",
					(SETTINGS, SETTINGS, f, foreign),
				)
			frappe.local.message_log = []
			self.assertIsNone(secrets.read("customer_api_key"))
			self.assertEqual(registry.credentials(), {})
			self.assertFalse(svc.has_credentials())
			with as_user("System Manager"):
				self.assertTrue(api.get_status()["needs_setup"] or not frappe.db.get_single_value(SETTINGS, "redirect_unregistered_to_wizard"))
			# Frappe's "Encryption key is invalid! Please check site_config.json" never reaches the screen
			self.assertEqual(frappe.local.message_log, [])
		finally:
			for f, value in saved.items():
				if value:
					set_encrypted_password(SETTINGS, SETTINGS, value, f)
				else:
					remove_encrypted_password(SETTINGS, SETTINGS, f)

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
			# the address is the site mode's, not the caller's: an old caller's value is ignored
			out = api.save_credentials(platform_base_url="https://api.example.test/", api_secret="apitest-s")
			self.assertEqual(out, {"ok": True, "fields_written": ["api_secret"]})
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
			self.assertEqual(row.fields_written, "api_secret")
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
		# committed: the runner's rollback must not undo the restore (it wiped the dev site's keys)
		frappe.db.commit()
		super().tearDownClass()

	def test_bootstrap_carries_the_platform_plans_and_no_second_country_list(self):
		with fake_provider(), as_user("System Manager"):
			out = api.get_signup_bootstrap()
		self.assertEqual(out["plans"][0]["plan_code"], "trial")
		self.assertEqual(out["code_ttl_minutes"], 10)
		self.assertIn("device_ready", out)
		# Countries are api.v1.phone.get_countries' job; two answers would drift apart.
		self.assertNotIn("countries", out)

	def test_the_form_starts_from_what_the_system_knows(self):
		user = "wa-prefill-test@example.com"
		if not frappe.db.exists("User", user):
			frappe.get_doc({"doctype": "User", "email": user, "first_name": "Prefill", "last_name": "Person", "send_welcome_email": 0}).insert(ignore_permissions=True)
		# the person's own number is not the account's: the number comes from the company's contact
		frappe.db.set_value("User", user, "mobile_no", "+967777000111")
		out = svc.signup_prefill(user)
		self.assertEqual(out["person"], "Prefill Person")
		self.assertEqual(out["email"], user)
		self.assertNotEqual(out.get("phone"), "+967777000111")
		# the Administrator account names no real person
		self.assertNotIn("person", svc.signup_prefill("Administrator"))
		with fake_provider(), as_user("System Manager"):
			self.assertIn("prefill", api.get_signup_bootstrap())

		company = frappe.defaults.get_user_default("Company", user) or frappe.defaults.get_global_default("company")
		if not (frappe.db.exists("DocType", "Company") and company and frappe.db.exists("Company", company)):
			return
		self.assertEqual(out["org"], frappe.db.get_value("Company", company, "company_name"))
		contact = frappe.get_doc(
			{
				"doctype": "Contact",
				"first_name": "Prefill Company Desk",
				"phone_nos": [{"phone": "12", "is_primary_phone": 1}, {"phone": "+967777667663", "is_primary_mobile_no": 1}],
				"links": [{"link_doctype": "Company", "link_name": company}],
			}
		).insert(ignore_permissions=True)
		try:
			# the primary mobile, and a number that is not a real one is skipped
			self.assertEqual(svc.signup_prefill(user)["phone"], "+967777667663")
		finally:
			contact.delete(ignore_permissions=True)

	def test_signup_without_an_email(self):
		"""The email is optional: the platform gives the account a placeholder, and it signs in by
		mobile number or username."""
		with fake_provider() as provider, as_user("System Manager"):
			out = api.start_signup(mobile="0500910009", full_name="No Mail Tenant", channel="sms")
			self.assertEqual(out["request_key"], "req-1")
			self.assertIn("start_signup", dict(provider.calls))

	def test_password_recovery_ends_signed_in(self):
		"""The recovery card used to stop at "instructions sent": no code, no new password. Now one
		call verifies, sets the password and signs the site in."""
		for f in SECRETS:
			remove_encrypted_password(SETTINGS, SETTINGS, f)
		with fake_provider() as provider, as_user("System Manager"):
			started = api.start_password_reset(identifier="+966500910001")
			# nothing is sent on WhatsApp: the page shows the code and the person sends it
			self.assertEqual(
				{k: started.get(k) for k in ("request_key", "channel", "code", "platform_phone", "mobile_hint")},
				{
					"request_key": "reset-1",
					"channel": "whatsapp",
					"code": "504312",
					"platform_phone": "+967782309999",
					"mobile_hint": "96777****938",
				},
			)
			with self.assertRaises(WAValidationError):  # too short
				api.finish_password_reset(request_key="reset-1", password="short", code="123456")
			with self.assertRaises(WAValidationError):  # wrong code
				api.finish_password_reset(request_key="reset-1", password="right-password", code="000000")
			with self.assertRaises(WAValidationError):  # WhatsApp reply not in yet
				api.finish_password_reset(request_key="reset-1", password="right-password")
			self.assertNotIn("complete_password_reset", dict(provider.calls))
			out = api.finish_password_reset(request_key="reset-1", password="right-password", code="123456")
			self.assertTrue(out["ok"])
			self.assertEqual(dict(provider.calls)["login"]["email"], "tenant@example.test")
			self.assertEqual(frappe.get_doc(SETTINGS).get_password("api_key", raise_exception=False), "k")

	def test_verification_route_says_what_the_platform_did(self):
		"""The page claimed a code was sent to the number, while the platform either expects the
		user to SEND the code from that number (WhatsApp) or mailed it (its device offline)."""
		self.assertEqual(
			svc.verification_route({"verification_channel": "WhatsApp", "code": "123456", "device_phone": "967779770054"}),
			{"channel": "whatsapp", "code": "123456", "platform_phone": "+967779770054"},
		)
		self.assertEqual(
			svc.verification_route({"verification_channel": "Email", "code_sent": True, "email": "a***@gmail.com"}),
			{"channel": "email", "email": "a***@gmail.com", "link_sent": False},
		)
		# a WhatsApp answer without the platform's number cannot be followed: no code leaks out
		self.assertNotIn("code", svc.verification_route({"verification_channel": "WhatsApp", "code": "1"}))

	def test_signup_sends_a_plan_the_platform_offers(self):
		"""The page used to send "free", which no platform plan is: every sign-up failed with "The
		selected plan is not available". A code off the bootstrap list, or none, becomes the first
		plan offered (the one the free trial renews to)."""
		for f in SECRETS:
			remove_encrypted_password(SETTINGS, SETTINGS, f)
		for sent in ("free", "free_trial", None):
			with fake_provider() as provider, as_user("System Manager"):
				args = {"mobile": "0500910008", "full_name": "Plan Tenant", "email": "p@b.c", "channel": "sms"}
				if sent:
					args["plan_code"] = sent
				api.start_signup(**args)
				self.assertEqual(dict(provider.calls)["start_signup"]["plan_code"], "trial", sent)

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
			# a wrong password is an answer for the card (HTTP 200), not a 502 the client
			# reports without its text
			wrong = api.login(
				platform_base_url="https://api.example.test",
				email="tenant@example.test",
				password="wrong-password",
			)
			self.assertEqual(wrong["ok"], False)
			self.assertTrue(wrong["message"])
			self.assertNotIn("credentials_stored", wrong)
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
		self.assertEqual(s.get_password("customer_api_secret", raise_exception=False), "cs")
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
				self.assertFalse(s.platform_base_url)  # a default, never copied into Settings
				self.assertTrue(svc.has_credentials(s))  # …yet the credentials step is complete
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

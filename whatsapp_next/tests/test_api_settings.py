# Tests for api/v1/settings.py (build order B-18): role gates, section allow-lists (secrets only
# as `has_*` booleans, permlevel-1 values never), save_settings audit, connection test, subscription
# sync, usage cache, webhook endpoints, audit log listing, picker sources and doctype fields.

from __future__ import annotations

from datetime import date

import frappe
from frappe.tests import IntegrationTestCase
from frappe.utils.password import remove_encrypted_password, set_encrypted_password

from whatsapp_next.api.v1 import settings as api
from whatsapp_next.exceptions import (
	WANotSupportedError,
	WAPermissionError,
	WAProviderAuthError,
	WAValidationError,
)
from whatsapp_next.providers import exceptions as pex
from whatsapp_next.tests.conftest_frappe import as_user, delete_all, ensure_settings, fake_provider
from whatsapp_next.tests.fake_provider import FakeProvider

SETTINGS = "WhatsApp Settings"
WEBHOOK_FIELDS = ("webhook_endpoint", "webhook_endpoint_url", "webhook_status", "webhook_events")
SECRETS = ("customer_api_key", "api_key", "api_secret", "webhook_secret")


class AuthFailingProvider(FakeProvider):
	def get_account(self):
		raise pex.AuthError("invalid key", code="AUTH_INVALID_KEY")


class NoUsageProvider(FakeProvider):
	def get_usage(self, from_, to, group_by="day"):
		raise pex.NotSupportedError("no usage", code="NOT_SUPPORTED")


class TestApiSettings(IntegrationTestCase):
	@classmethod
	def setUpClass(cls):
		super().setUpClass()
		ensure_settings()
		s = frappe.get_doc(SETTINGS)
		cls._saved = {f: s.get(f) for f in (*WEBHOOK_FIELDS, "audit_retention_days", "connection_status")}
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
		delete_all(
			"WhatsApp Audit Log", {"action": "Settings Changed", "fields_written": "audit_retention_days"}
		)
		super().tearDownClass()

	# --- role gates ---------------------------------------------------------------------

	def test_role_gates(self):
		with as_user("_none"), self.assertRaises(WAPermissionError):
			api.get_settings()
		with as_user("WhatsApp Manager"):
			self.assertIn("provider", api.get_settings())
			with self.assertRaises(WAPermissionError):
				api.save_settings(section="retention", values={"audit_retention_days": 100})
		with as_user("WhatsApp Viewer"), self.assertRaises(WAPermissionError):
			api.get_settings()

	# --- get / save ---------------------------------------------------------------------

	def test_get_settings_never_returns_secrets(self):
		set_encrypted_password(SETTINGS, SETTINGS, "apitest-key", "api_key")
		with as_user("WhatsApp Manager"):
			out = api.get_settings()
			creds = out["credentials"]
			self.assertTrue(creds["has_api_key"])
			self.assertNotIn("api_key", creds)
			self.assertNotIn("credentials_updated_at", creds)
			flat = str(out)
			self.assertNotIn("apitest-key", flat)
			self.assertNotIn("'webhook_secret'", flat)
			self.assertIn("has_webhook_secret", out["webhook"])
			only = api.get_settings(section="queue")
			self.assertEqual(list(only), ["queue"])
			self.assertIn("messages_per_minute", only["queue"])
			with self.assertRaises(WAValidationError):
				api.get_settings(section="bogus")

	def test_save_settings_allow_list_and_audit(self):
		with as_user("System Manager") as sm:
			with self.assertRaises(WAValidationError):
				api.save_settings(section="retention", values={"api_key": "x"})
			with self.assertRaises(WAValidationError):
				api.save_settings(section="subscription", values={"plan_code": "x"})
			with self.assertRaises(WAValidationError):
				api.save_settings(section="retention", values={})
			before = frappe.db.get_single_value(SETTINGS, "audit_retention_days")
			out = api.save_settings(section="retention", values={"audit_retention_days": (before or 0) + 1})
			self.assertEqual(out, {"ok": True, "changed": ["audit_retention_days"]})
			self.assertEqual(frappe.db.get_single_value(SETTINGS, "audit_retention_days"), (before or 0) + 1)
			row = frappe.get_all(
				"WhatsApp Audit Log",
				filters={"action": "Settings Changed", "user": sm},
				fields=["fields_written"],
				order_by="creation desc",
				limit=1,
			)[0]
			self.assertEqual(row.fields_written, "audit_retention_days")
			same = api.save_settings(section="retention", values={"audit_retention_days": (before or 0) + 1})
			self.assertEqual(same["changed"], [])

	# --- connection / subscription / usage ----------------------------------------------

	def test_test_connection_and_sync(self):
		with fake_provider(), as_user("WhatsApp Manager"):
			out = api.test_connection()
			self.assertTrue(out["ok"])
			self.assertEqual(out["plan_code"], "fake")
			self.assertEqual(frappe.db.get_single_value(SETTINGS, "connection_status"), "OK")
			self.assertTrue(
				frappe.db.exists(
					"WhatsApp Audit Log", {"action": "Connection Tested", "user": frappe.session.user}
				)
			)
			synced = api.sync_subscription()
			self.assertEqual(synced["plan_code"], "fake")
			self.assertIsNotNone(synced["synced_at"])
		with fake_provider(AuthFailingProvider()), as_user("WhatsApp Manager"):
			with self.assertRaises(WAProviderAuthError):
				api.sync_subscription()

	def test_get_usage_cache_and_not_supported(self):
		frappe.cache.delete_value("wa:usage:2026-01-01:2026-01-07:day")
		with fake_provider() as p, as_user("WhatsApp Viewer"):
			out = api.get_usage(from_date="2026-01-01", to_date="2026-01-07", group_by="day")
			self.assertEqual(out["rows"], [])
			self.assertEqual(out["from"], "2026-01-01")
			calls = len([c for c in p.calls if c[0] == "get_usage"])
			api.get_usage(from_date=date(2026, 1, 1), to_date=date(2026, 1, 7))
			self.assertEqual(len([c for c in p.calls if c[0] == "get_usage"]), calls)  # cached
			with self.assertRaises(WAValidationError):
				api.get_usage(from_date="2026-01-01", to_date="2026-01-07", group_by="hour")
			with self.assertRaises(WAValidationError):
				api.get_usage(from_date="2026-01-08", to_date="2026-01-07")
		frappe.cache.delete_value("wa:usage:2026-02-01:2026-02-02:day")
		with fake_provider(NoUsageProvider()), as_user("WhatsApp Manager"):
			with self.assertRaises(WANotSupportedError):
				api.get_usage(from_date="2026-02-01", to_date="2026-02-02")

	# --- webhook --------------------------------------------------------------------------

	def test_webhook_lifecycle(self):
		with fake_provider(), as_user("System Manager"):
			out = api.setup_webhook()
			self.assertEqual(out["status"], "Active")
			self.assertTrue(out["endpoint_url"].endswith("whatsapp_next.webhooks.v1.receiver.receive"))
			self.assertIn("message.sent", out["events"])
			self.assertEqual(api.set_webhook_status(status="Disabled"), {"status": "Disabled"})
			with self.assertRaises(WAValidationError):
				api.set_webhook_status(status="Locked")
			self.assertEqual(api.set_webhook_events(events=["message.sent"]), {"events": ["message.sent"]})
			with self.assertRaises(WAValidationError):
				api.set_webhook_events(events=["bogus.event"])
			self.assertIsNotNone(api.rotate_webhook_secret()["rotated_at"])
			test = api.test_webhook()
			self.assertEqual(test["status"], "ok")
			self.assertEqual(test["http_status_code"], 200)
			events = api.list_webhook_events_available()
			self.assertTrue(any(e["event_name"] == "message.sent" and e["subscribed"] for e in events))
		with as_user("WhatsApp Manager"), self.assertRaises(WAPermissionError):
			api.setup_webhook()

	# --- audit / picker / fields ----------------------------------------------------------

	def test_list_audit_log(self):
		with as_user("WhatsApp Manager"):
			out = api.list_audit_log(filters={"action": "Settings Changed"}, page=1, page_length=999)
			self.assertLessEqual(len(out["rows"]), 200)
			self.assertTrue(all(r["action"] == "Settings Changed" for r in out["rows"]))
			self.assertGreaterEqual(out["total"], len(out["rows"]))
			with self.assertRaises(WAValidationError):
				api.list_audit_log(filters={"details": "x"})
			ranged = api.list_audit_log(filters={"from": "2000-01-01", "to": "2000-01-02"})
			self.assertEqual(ranged["rows"], [])

	def test_list_picker_sources_and_doctype_fields(self):
		with as_user("WhatsApp Contact User"):
			self.assertIsInstance(api.list_picker_sources(), list)
		with as_user("_none"), self.assertRaises(WAPermissionError):
			api.list_picker_sources()
		with as_user("WhatsApp Manager"):
			fields = api.get_doctype_fields(document_type="Contact")
			names = {f["fieldname"] for f in fields}
			self.assertIn("name", names)
			self.assertIn("mobile_no", names)
			with self.assertRaises(WAValidationError):
				api.get_doctype_fields(document_type="Contact Phone")
			with self.assertRaises(WAValidationError):
				api.get_doctype_fields(document_type="No Such DocType")

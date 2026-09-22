# Tests for services/audit.py: real user, masking, secret-key filter, summary args.

from __future__ import annotations

import json

import frappe
from frappe.tests import IntegrationTestCase

from whatsapp_next.services import audit
from whatsapp_next.tests.conftest_frappe import as_user, delete_all


class TestAudit(IntegrationTestCase):
	def tearDown(self):
		delete_all("WhatsApp Audit Log", {"reason": ("like", "test-audit%")})

	def test_log_records_real_user_and_masks(self):
		with as_user("WhatsApp Manager") as email:
			name = audit.log(
				"Queue Paused",
				reason="test-audit pause",
				count=3,
				details={
					"phone": "+966501234567",
					"api_key": "SECRET",
					"note": "ok",
					"nested": {"token": "x", "recipient_no": "966501234567"},
				},
				summary="Queue paused by {user}",
				summary_args={"user": email},
			)
		row = frappe.get_doc("WhatsApp Audit Log", name)
		self.assertEqual(row.user, email)
		self.assertEqual(row.count, 3)
		self.assertEqual(row.severity, "Action")
		details = json.loads(row.details)
		self.assertNotIn("api_key", details)
		self.assertNotIn("token", details["nested"])
		self.assertNotIn("501234567", details["phone"])
		self.assertNotIn("501234567", details["nested"]["recipient_no"])
		self.assertEqual(details["note"], "ok")
		self.assertEqual(details["summary_args"]["user"], email)
		self.assertIsNotNone(row.timestamp)

	def test_default_severity_and_references(self):
		name = audit.log(
			"Device Deleted",
			reference=("Role", "WhatsApp Manager"),
			target=("Role", "WhatsApp Viewer"),
			fields_written=("b", "a"),
			reason="test-audit delete",
		)
		row = frappe.get_doc("WhatsApp Audit Log", name)
		self.assertEqual(row.severity, "Danger")
		self.assertEqual(row.reference_doctype, "Role")
		self.assertEqual(row.fields_written, "a, b")
		self.assertEqual(row.summary, "Device Deleted")

	def test_no_role_can_write_audit(self):
		for role in ("WhatsApp Manager", "System Manager", "WhatsApp Agent"):
			with as_user(role) as email:
				self.assertFalse(frappe.has_permission("WhatsApp Audit Log", "write", user=email))
				self.assertFalse(frappe.has_permission("WhatsApp Audit Log", "create", user=email))
		with as_user("WhatsApp Manager") as email:
			self.assertTrue(frappe.has_permission("WhatsApp Audit Log", "read", user=email))
		with as_user("WhatsApp Agent") as email:
			self.assertFalse(frappe.has_permission("WhatsApp Audit Log", "read", user=email))

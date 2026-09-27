# Tests for the "Send a bulk message" window (D-136): the selection resolves to deduplicated
# recipients with blacklist members left out (unless that blacklist group is itself picked), the
# estimate, and the send that becomes a started (or scheduled) campaign, audited `Bulk Send`.

from __future__ import annotations

from unittest.mock import patch

import frappe
from frappe.tests import IntegrationTestCase
from frappe.utils import add_to_date, now_datetime

from whatsapp_next.api.v1 import bulk_send as api
from whatsapp_next.exceptions import WAPermissionError, WAValidationError
from whatsapp_next.tests.conftest_frappe import as_user, delete_all, ensure_device

GROUP = "BulkTest Group"
BLACK = "BulkTest Blacklist"
P1, P2, P3 = "+966500940001", "+966500940002", "+966500940003"


def _group(name: str, kind: str, phones: list[str]) -> str:
	if frappe.db.exists("WhatsApp Contact Group", name):
		frappe.delete_doc("WhatsApp Contact Group", name, force=True, ignore_permissions=True)
	return (
		frappe.get_doc(
			{
				"doctype": "WhatsApp Contact Group",
				"group_name": name,
				"kind": kind,
				"source": "Manual",
				"members": [{"phone": p, "source_type": "Manual"} for p in phones],
			}
		)
		.insert(ignore_permissions=True)
		.name
	)


class TestBulkSend(IntegrationTestCase):
	@classmethod
	def setUpClass(cls):
		super().setUpClass()
		cls.device = ensure_device("BulkTest Device", "WAD-TEST-BULK", phone="+966500940000")
		frappe.db.set_value("WhatsApp Device", cls.device, "status", "Connected")
		cls.group = _group(GROUP, "Other", [P1, P2])
		cls.black = _group(BLACK, "Blacklist", [P2])

	@classmethod
	def tearDownClass(cls):
		cls._clean()
		delete_all("WhatsApp Contact Group", {"group_name": ("in", [GROUP, BLACK])})
		super().tearDownClass()

	@classmethod
	def _clean(cls):
		names = frappe.get_all("WhatsApp Campaign", filters={"device": cls.device}, pluck="name")
		if names:
			delete_all(
				"WhatsApp Audit Log",
				{"reference_doctype": "WhatsApp Campaign", "reference_name": ("in", names)},
			)
			delete_all("WhatsApp Campaign", {"name": ("in", names)})

	def test_estimate_excludes_blacklists(self):
		with as_user("WhatsApp Manager"):
			# P2 sits in a blacklist group the sender did not pick: left out; P3 typed twice counts once
			out = api.estimate(groups=[self.group], numbers=[P3, "0500940003", "bad"])
			self.assertEqual((out["total"], out["excluded"], out["invalid"]), (2, 1, 1))
			# picking the blacklist group on purpose sends to it
			out = api.estimate(groups=[self.group, self.black])
			self.assertEqual((out["total"], out["excluded"]), (2, 0))
		with as_user("WhatsApp Agent"), self.assertRaises(WAPermissionError):
			api.estimate(groups=[self.group])

	def test_send_becomes_a_started_campaign(self):
		with as_user("WhatsApp Manager"):
			with self.assertRaises(WAValidationError):
				api.send(payload={"groups": [self.group], "device": self.device})
			with self.assertRaises(WAValidationError):
				api.send(payload={"body": "x", "device": self.device})
			with patch.object(frappe, "enqueue"):
				out = api.send(
					payload={
						"groups": [self.group],
						"numbers": [P3],
						"body": "bulk hello",
						"device": self.device,
						"rate": 12,
					}
				)
		self.assertEqual((out["status"], out["recipients"], out["excluded"]), ("Queued", 2, 1))
		camp = frappe.get_doc("WhatsApp Campaign", out["campaign"])
		self.assertEqual(
			(camp.device, camp.messages_per_minute, camp.messages[0].body), (self.device, 12, "bulk hello")
		)
		self.assertEqual(sorted(r.phone_e164 for r in camp.recipients), [P1, P3])
		self.assertEqual({r.source_type for r in camp.recipients}, {"Contact Group", "Manual"})
		self.assertEqual(
			frappe.db.count("WhatsApp Audit Log", {"action": "Bulk Send", "reference_name": camp.name}), 1
		)
		# scheduled
		with as_user("WhatsApp Manager"):
			with self.assertRaises(WAValidationError):
				api.send(
					payload={
						"numbers": [P3],
						"body": "x",
						"device": self.device,
						"scheduled_at": str(add_to_date(now_datetime(), hours=-1)),
					}
				)
			out = api.send(
				payload={
					"numbers": [P3],
					"body": "later",
					"device": self.device,
					"scheduled_at": str(add_to_date(now_datetime(), hours=2)),
				}
			)
		self.assertEqual(out["status"], "Scheduled")

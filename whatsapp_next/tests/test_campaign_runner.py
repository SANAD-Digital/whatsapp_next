# Tests for services/campaign_runner.py (build order B-15): status machine, start →
# materialize (recipients × messages, staggered schedule, per-recipient rendering, unknown-number
# exclusion), pause / resume / cancel through the dispatcher, counters and finalization.

from __future__ import annotations

from unittest.mock import patch

import frappe
from frappe.tests import IntegrationTestCase
from frappe.utils import add_to_date, now_datetime

from whatsapp_next.exceptions import WAStateConflictError, WAValidationError
from whatsapp_next.services import campaign_runner as runner
from whatsapp_next.services import dispatch
from whatsapp_next.services.guards import status_writer
from whatsapp_next.tests.conftest_frappe import delete_all, ensure_device, ensure_settings, fake_provider

P1, P2, P3 = "+966500000701", "+966500000702", "+966500000703"
NAME = "CampaignTest"


def _campaign(device, recipients=(P1, P2), messages=None, **values):
	doc = frappe.get_doc(
		{
			"doctype": "WhatsApp Campaign",
			"campaign_name": f"{NAME} {frappe.generate_hash(length=4)}",
			"device": device,
			"status": "Draft",
			"messages": messages
			or [
				{
					"message_type": "Text",
					"body": "campaign-test Hello {{ recipient.display_name }}",
					"delay_seconds": 0,
				},
				{"message_type": "Text", "body": "campaign-test Second", "delay_seconds": 30},
			],
			"recipients": [
				{
					"recipient_type": "Individual",
					"phone": p,
					"display_name": f"R{i}",
					"source_type": "Manual",
					"status": "Pending",
				}
				for i, p in enumerate(recipients, start=1)
			],
			**values,
		}
	)
	with status_writer():
		doc.insert(ignore_permissions=True)
	return doc.name


class TestCampaignRunner(IntegrationTestCase):
	@classmethod
	def setUpClass(cls):
		super().setUpClass()
		cls.device = ensure_device("Campaign Device", "WAD-TEST-CP01", phone="+966500000041")
		ensure_settings(default_device=cls.device, queue_paused=0, send_only_to_known_numbers=0)

	def setUp(self):
		self._clean()

	def tearDown(self):
		self._clean()

	@staticmethod
	def _clean():
		delete_all("WhatsApp Queue Item")
		delete_all("WhatsApp Log", {"source_type": "Campaign"})
		delete_all("WhatsApp Campaign", {"campaign_name": ("like", f"{NAME}%")})
		delete_all("WhatsApp Audit Log", {"action": ("like", "Campaign%")})
		frappe.db.commit()

	def _status(self, name):
		return frappe.db.get_value("WhatsApp Campaign", name, "status")

	def _outbound(self, name):
		return frappe.get_all(
			"WhatsApp Log",
			filters={"campaign": name},
			fields=[
				"name",
				"status",
				"body",
				"scheduled_at",
				"campaign_recipient",
				"campaign_message_idx",
				"phone_e164",
			],
			order_by="campaign_message_idx asc, phone_e164 asc",
		)

	def test_state_machine_and_start_guards(self):
		name = _campaign(self.device)
		with self.assertRaises(WAStateConflictError):
			runner.set_status(name, "Running")  # Draft → Running is not allowed
		with self.assertRaises(WAValidationError):
			runner.schedule(name, add_to_date(now_datetime(), hours=-1))
		runner.schedule(name, add_to_date(now_datetime(), hours=1))
		self.assertEqual(self._status(name), "Scheduled")
		runner.unschedule(name)
		self.assertEqual(self._status(name), "Draft")
		empty = _campaign(self.device, recipients=())
		with self.assertRaises(WAValidationError):
			runner.start(empty)
		with patch.object(frappe, "enqueue") as enq:
			runner.start(name)
		self.assertEqual(self._status(name), "Queued")
		self.assertEqual(enq.call_args.args[0], "whatsapp_next.services.campaign_runner.materialize")
		self.assertEqual(
			frappe.db.count("WhatsApp Audit Log", {"action": "Campaign Started", "reference_name": name}), 1
		)
		with self.assertRaises(WAStateConflictError):
			runner.start(name)

	def test_materialize_pause_resume_cancel_and_counters(self):
		name = _campaign(self.device, scheduled_at=None)
		with patch.object(frappe, "enqueue"):
			runner.start(name)
		counts = runner.materialize(name)
		self.assertEqual((counts["recipients"], counts["created"], counts["failed"]), (2, 4, 0))
		self.assertEqual(self._status(name), "Running")
		rows = self._outbound(name)
		self.assertEqual(len(rows), 4)
		first = next(r for r in rows if r.campaign_message_idx == 1 and r.phone_e164 == P1)
		second = next(r for r in rows if r.campaign_message_idx == 2 and r.phone_e164 == P1)
		self.assertEqual(first.body, "campaign-test Hello R1")
		self.assertEqual((second.scheduled_at - first.scheduled_at).total_seconds(), 30)
		self.assertTrue(all(r.status == "Queued" for r in rows))
		recips = {
			r.phone_e164: r
			for r in frappe.get_all(
				"WhatsApp Campaign Recipient",
				filters={"parent": name},
				fields=["phone_e164", "status", "outbound_message"],
			)
		}
		self.assertEqual(recips[P1].status, "Queued")
		self.assertEqual(recips[P1].outbound_message, first.name)
		c = runner.counters_for(name)
		self.assertEqual((c.total, c.queued, c.open), (4, 4, 4))
		self.assertEqual(frappe.db.get_value("WhatsApp Campaign", name, "queued_count"), 4)
		self.assertEqual(runner.materialize(name), {"skipped": 1})  # idempotent: only Queued materializes

		# pause → queue rows Paused, claim skips them
		self.assertEqual(runner.pause(name, reason="hold"), 4)
		self.assertEqual(self._status(name), "Paused")
		self.assertEqual(frappe.db.count("WhatsApp Queue Item", {"campaign": name, "status": "Paused"}), 4)
		self.assertEqual(dispatch.claim_batch(self.device, 10), [])
		self.assertEqual(runner.resume(name), 4)
		self.assertEqual(self._status(name), "Running")
		# send the first (due) messages, then finalize when everything is terminal
		with fake_provider():
			dispatch.dispatch_device_batch(self.device)
		sent_now = [r for r in self._outbound(name) if r.status == "Sending"]
		self.assertEqual(len(sent_now), 2)  # the two delay-0 rows; the +30 s rows are not due yet
		for r in self._outbound(name):
			dispatch.apply_status(r.name, "Sent") if r.status == "Sending" else None
		for r in self._outbound(name):
			if r.status == "Queued":
				with status_writer():
					frappe.db.set_value("WhatsApp Log", r.name, "status", "Failed")
					frappe.db.set_value(
						"WhatsApp Queue Item", {"outbound_message": r.name}, "status", "Dead Letter"
					)
		c = runner.refresh_counters(name)
		self.assertEqual((c.sent, c.failed, c.open), (2, 2, 0))
		self.assertEqual(self._status(name), "Partially Failed")
		self.assertEqual(
			frappe.db.get_value("WhatsApp Campaign Recipient", {"parent": name, "phone_e164": P1}, "status"),
			"Failed",
		)
		with self.assertRaises(WAStateConflictError):
			runner.cancel(name)

	def test_cancel_running_and_exclude_unknown(self):
		name = _campaign(self.device, recipients=(P1, P3), exclude_unknown_numbers=1)
		# P1 is known (an earlier message exists), P3 is not
		with status_writer():
			frappe.get_doc(
				{
					"doctype": "WhatsApp Log",
					"device": self.device,
					"recipient_type": "Individual",
					"phone": P1,
					"message_type": "Text",
					"body": "campaign-test known",
					"status": "Sent",
					"source_type": "API",
				}
			).insert(ignore_permissions=True)
		with patch.object(frappe, "enqueue"):
			runner.start(name)
		counts = runner.materialize(name)
		self.assertEqual((counts["created"], counts["skipped_unknown"]), (2, 1))
		self.assertEqual(
			frappe.db.get_value(
				"WhatsApp Campaign Recipient",
				{"parent": name, "phone_e164": P3},
				["status", "error_code"],
				as_dict=True,
			),
			{"status": "Cancelled", "error_code": "unknown_number_policy"},
		)
		n = runner.cancel(name, reason="stop")
		self.assertEqual(n, 2)
		self.assertEqual(self._status(name), "Cancelled")
		self.assertTrue(all(r.status == "Cancelled" for r in self._outbound(name)))
		self.assertEqual(frappe.db.count("WhatsApp Queue Item", {"campaign": name, "status": "Deleted"}), 2)
		self.assertEqual(
			frappe.db.count("WhatsApp Audit Log", {"action": "Campaign Cancelled", "reference_name": name}), 1
		)
		# terminal campaigns are refused by pause/resume/finalize
		with self.assertRaises(WAStateConflictError):
			runner.pause(name)
		self.assertFalse(runner.finalize_if_done(name))
		self.assertTrue(any(r["name"] == name for r in runner.sending_now()) is False)

	def test_promote_scheduled(self):
		name = _campaign(self.device)
		runner.schedule(name, add_to_date(now_datetime(), minutes=5))
		with patch.object(frappe, "enqueue"):
			self.assertEqual(runner.promote_scheduled(), [])
			frappe.db.set_value(
				"WhatsApp Campaign",
				name,
				"scheduled_at",
				add_to_date(now_datetime(), minutes=-1),
				update_modified=False,
			)
			self.assertEqual(runner.promote_scheduled(), [name])
		self.assertEqual(self._status(name), "Queued")

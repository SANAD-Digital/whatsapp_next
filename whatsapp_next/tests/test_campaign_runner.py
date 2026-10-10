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
from whatsapp_next.tests.conftest_frappe import (
	delete_all,
	delete_test_rows,
	ensure_device,
	ensure_settings,
	fake_provider,
)

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
		delete_test_rows("WhatsApp Queue Item")
		delete_test_rows("WhatsApp Log", {"source_type": "Campaign"})
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

	def test_file_caption_is_rendered_per_recipient(self):
		"""The composer offers the variables over a file's caption too: each recipient gets theirs,
		and the preview shows it (the caption went out as typed, live business test 2026-10-01)."""
		from whatsapp_next.services import attachments

		png = (
			b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06\x00\x00\x00\x1f\x15\xc4\x89"
			b"\x00\x00\x00\rIDATx\x9cc\xf8\xff\xff?\x00\x05\xfe\x02\xfe\xa75\x81\x84\x00\x00\x00\x00IEND\xaeB`\x82"
		)
		url = attachments.save_private_file(png, "campaign-test-offer.png")
		self.addCleanup(lambda: frappe.delete_doc("File", frappe.db.get_value("File", {"file_url": url}), force=True))
		name = _campaign(
			self.device,
			messages=[
				{
					"message_type": "Image",
					"attachment": url,
					"caption": "campaign-test Offer for {{ recipient.display_name }}",
					"delay_seconds": 0,
				}
			],
		)
		row = frappe.db.get_value("WhatsApp Campaign Recipient", {"parent": name, "phone_e164": P1}, "name")
		preview = runner.preview_message(name, 1, row)
		self.assertEqual((preview["body"], preview["caption"]), (None, "campaign-test Offer for R1"))
		self.assertEqual(preview["errors"], [])
		with patch.object(frappe, "enqueue"):
			runner.start(name)
		runner.materialize(name)
		captions = {
			r.phone_e164: r.caption
			for r in frappe.get_all("WhatsApp Log", filters={"campaign": name}, fields=["phone_e164", "caption"])
		}
		self.assertEqual(captions, {P1: "campaign-test Offer for R1", P2: "campaign-test Offer for R2"})

	def test_reconcile_closes_with_the_final_counts(self):
		"""The periodic close writes the counts and recipient statuses, not only the status: a
		campaign whose messages all went out must not end `Completed` with zero sent."""
		from whatsapp_next.services import reconcile

		name = _campaign(
			self.device,
			recipients=(P1,),
			messages=[{"message_type": "Text", "body": "campaign-test hi"}],
			scheduled_at=None,
		)
		with patch.object(frappe, "enqueue"):
			runner.start(name)
			runner.materialize(name)
			with fake_provider():
				dispatch.dispatch_device_batch(self.device)
			for r in self._outbound(name):
				dispatch.apply_status(r.name, "Delivered")
		self.assertEqual(
			frappe.db.get_value("WhatsApp Campaign", name, "sent_count"), 0
		)  # counted at hand-off
		reconcile.finalize_campaigns()
		row = frappe.db.get_value(
			"WhatsApp Campaign", name, ["status", "delivered_count", "queued_count"], as_dict=True
		)
		self.assertEqual((row.status, row.delivered_count, row.queued_count), ("Completed", 1, 0))
		self.assertEqual(
			frappe.db.get_value("WhatsApp Campaign Recipient", {"parent": name}, "status"), "Delivered"
		)
		# "first message" is when the first one really left, not when its row was built
		times = frappe.db.get_value("WhatsApp Campaign", name, ["first_message_at", "last_message_at"], as_dict=True)
		sent_at = frappe.db.get_value("WhatsApp Log", {"campaign": name}, "sent_at")
		self.assertEqual((times.first_message_at, times.last_message_at), (sent_at, sent_at))

	def test_numbers_not_on_whatsapp_are_skipped(self):
		from whatsapp_next.services import number_check

		name = _campaign(self.device, recipients=(P1, P3), exclude_not_on_whatsapp=1)
		with patch.object(frappe, "enqueue"), patch.object(number_check, "check", return_value={P1: True, P3: False}) as check:
			runner.start(name)
			counts = runner.materialize(name)
		self.assertEqual(check.call_args.kwargs.get("device"), self.device)
		self.assertEqual(counts["skipped_not_on_whatsapp"], 1)
		self.assertEqual(
			frappe.db.get_value("WhatsApp Campaign Recipient", {"parent": name, "phone_e164": P3}, ["status", "error_code"]),
			("Cancelled", "recipient_not_registered"),
		)

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

	def test_start_now_drops_the_schedule(self):
		"""A scheduled campaign started by hand goes now: its messages are due now and the list
		reads it as an immediate start. Only the scheduler's own start keeps `scheduled_at`."""
		name = _campaign(self.device)
		runner.schedule(name, add_to_date(now_datetime(), hours=3))
		with patch.object(frappe, "enqueue"):
			runner.start(name)
		self.assertIsNone(frappe.db.get_value("WhatsApp Campaign", name, "scheduled_at"))
		runner.materialize(name)
		first = min(r.scheduled_at for r in self._outbound(name))
		self.assertLess(first, add_to_date(now_datetime(), minutes=1))

	def test_paused_before_materialization_still_gets_its_rows(self):
		name = _campaign(self.device)
		with patch.object(frappe, "enqueue"):
			runner.start(name)
		runner.pause(name, reason="early")  # the materialize job has not run yet
		self.assertEqual(self._status(name), "Paused")
		counts = runner.materialize(name)
		self.assertEqual(counts["created"], 4)
		self.assertEqual(self._status(name), "Paused")
		self.assertEqual(dispatch.claim_batch(self.device, 10), [])  # held while paused
		self.assertEqual(runner.materialize(name), {"skipped": 1})
		runner.resume(name)
		self.assertEqual(runner.counters_for(name).open, 4)

	def test_cancel_during_materialization_stops_it(self):
		name = _campaign(self.device, recipients=(P1, P2, P3))
		with patch.object(frappe, "enqueue"):
			runner.start(name)
		# the cancel lands between two batches of the job
		with patch.object(runner, "MATERIALIZE_BATCH", 2):
			real = runner.dispatch.enqueue

			def enqueue_then_cancel(names, **kw):
				out = real(names, **kw)
				if runner.counters_for(name).total == 2:
					with status_writer():
						frappe.db.set_value("WhatsApp Campaign", name, "status", "Cancelled")
				return out

			with patch.object(runner.dispatch, "enqueue", side_effect=enqueue_then_cancel):
				runner.materialize(name)
		c = runner.counters_for(name)
		self.assertEqual(c.open, 0)
		self.assertLess(c.total, 6)  # the third recipient was never materialized
		self.assertFalse(
			frappe.db.count(
				"WhatsApp Campaign Recipient", {"parent": name, "status": ("in", ["Pending", "Queued"])}
			)
		)

	def test_all_excluded_campaign_closes(self):
		"""Every recipient set aside by the unknown-number policy: nothing to send, so it ends."""
		name = _campaign(self.device, exclude_unknown_numbers=1)
		with patch.object(frappe, "enqueue"), patch(
			"whatsapp_next.services.read_layer.known_keys", return_value=set()
		):
			runner.start(name)
			counts = runner.materialize(name)
		self.assertEqual(counts["created"], 0)
		self.assertEqual(self._status(name), "Completed")

	def test_counters_for_many_matches_counters_for(self):
		a = _campaign(self.device)
		b = _campaign(self.device, recipients=(P3,))
		for n in (a, b):
			with patch.object(frappe, "enqueue"):
				runner.start(n)
			runner.materialize(n)
		many = runner.counters_for_many([a, b])
		self.assertEqual(many[a], runner.counters_for(a))
		self.assertEqual((many[a].total, many[b].total), (4, 2))
		self.assertEqual(runner.counters_for("no-such-campaign").total, 0)

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

	def test_edit_lock_ignores_datetime_round_trip(self):
		"""A Paused campaign saved from the client (datetimes as strings) may still gain recipients;
		only a real change of `scheduled_at` / `device` is refused."""
		import json

		name = _campaign(self.device)
		runner.schedule(name, add_to_date(now_datetime(), minutes=5))
		frappe.db.set_value(
			"WhatsApp Campaign", name, "status", "Paused", update_modified=False
		)  # as the runner leaves it

		def from_client(**changes):
			data = json.loads(frappe.as_json(frappe.get_doc("WhatsApp Campaign", name).as_dict()))
			data.update(changes)
			return frappe.get_doc(data)

		doc = from_client()
		doc.append(
			"recipients",
			{
				"recipient_type": "Individual",
				"phone": P3,
				"display_name": "R3",
				"source_type": "Manual",
				"status": "Pending",
			},
		)
		doc.save(ignore_permissions=True)  # scheduled_at came back as a string: not a change
		self.assertEqual(frappe.db.count("WhatsApp Campaign Recipient", {"parent": name}), 3)

		later = str(add_to_date(now_datetime(), minutes=10))
		with self.assertRaises(WAStateConflictError):
			from_client(scheduled_at=later).save(ignore_permissions=True)

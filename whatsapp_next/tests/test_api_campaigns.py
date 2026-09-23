# Tests for api/v1/campaigns.py (build order B-24): role and document gates, lifecycle through
# the runner (start → materialize, pause / resume / cancel, schedule / unschedule), progress,
# sending-now card, recipients paging with filters and the page cap, message preview, poll
# results through the FakeProvider, and the bulk variants.

from __future__ import annotations

from unittest.mock import patch

import frappe
from frappe.tests import IntegrationTestCase
from frappe.utils import add_to_date, now_datetime

from whatsapp_next.api.v1 import campaigns as api
from whatsapp_next.exceptions import (
	WANotFoundError,
	WAPermissionError,
	WAStateConflictError,
	WAValidationError,
)
from whatsapp_next.services import campaign_runner as runner
from whatsapp_next.services.guards import status_writer
from whatsapp_next.tests.conftest_frappe import (
	as_user,
	delete_all,
	ensure_device,
	ensure_settings,
	fake_provider,
)

P1, P2 = "+966500920401", "+966500920402"
NAME = "ApiTest Campaign"
TAG = "ApiTest camp"


class TestApiCampaigns(IntegrationTestCase):
	@classmethod
	def setUpClass(cls):
		super().setUpClass()
		cls.device = ensure_device("ApiTest Device CP", "WAD-TEST-API24", phone="+966500920004")
		ensure_settings(default_device=cls.device, queue_paused=0, send_only_to_known_numbers=0)

	@classmethod
	def tearDownClass(cls):
		cls._clean()
		super().tearDownClass()

	def setUp(self):
		self._clean()

	@staticmethod
	def _clean():
		campaigns = frappe.get_all(
			"WhatsApp Campaign", filters={"campaign_name": ("like", f"{NAME}%")}, pluck="name"
		)
		if campaigns:
			delete_all("WhatsApp Queue Item", {"campaign": ("in", campaigns)})
			delete_all("WhatsApp Log", {"campaign": ("in", campaigns)})
			delete_all("WhatsApp Audit Log", {"reference_name": ("in", campaigns)})
			delete_all("WhatsApp Campaign", {"name": ("in", campaigns)})
		frappe.db.commit()

	def _campaign(self, recipients=(P1, P2), messages=None, **values):
		doc = frappe.get_doc(
			{
				"doctype": "WhatsApp Campaign",
				"campaign_name": f"{NAME} {frappe.generate_hash(length=4)}",
				"device": self.device,
				"status": "Draft",
				"messages": messages
				or [{"message_type": "Text", "body": f"{TAG} Hello {{{{ recipient.display_name }}}}"}],
				"recipients": [
					{
						"recipient_type": "Individual",
						"phone": p,
						"display_name": f"R{i}",
						"source_type": "Manual" if i == 1 else "Contact",
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

	def _running(self, **values):
		name = self._campaign(**values)
		with patch.object(frappe, "enqueue"):
			runner.start(name)
		runner.materialize(name)
		return name

	def _status(self, name):
		return frappe.db.get_value("WhatsApp Campaign", name, "status")

	# -- gates -------------------------------------------------------------------------

	def test_role_gates(self):
		name = self._campaign()
		with as_user("_none"), self.assertRaises(WAPermissionError):
			api.get_progress(name=name)
		with as_user("WhatsApp Viewer"):
			self.assertEqual(api.get_progress(name=name)["status"], "Draft")
			self.assertIsInstance(api.get_sending_now(), list)
			with self.assertRaises(WAPermissionError):
				api.start(name=name)
			with self.assertRaises(WAPermissionError):
				api.preview_message(name=name, idx=1)
		with as_user("WhatsApp Agent"), self.assertRaises(WAPermissionError):
			api.pause(name=name)
		# Manager role but no document permission → WAPermissionError from the document check
		with as_user("WhatsApp Manager"), patch.object(frappe, "has_permission", return_value=False):
			with self.assertRaises(WAPermissionError):
				api.start(name=name)
		with as_user("WhatsApp Manager"), self.assertRaises(WANotFoundError):
			api.get_progress(name="no-such-ApiTest-campaign")

	# -- lifecycle ---------------------------------------------------------------------

	def test_start_pause_resume_cancel(self):
		name = self._campaign()
		with as_user("WhatsApp Manager"):
			with patch.object(frappe, "enqueue") as enq:
				self.assertEqual(api.start(name=name), {"status": "Queued"})
			self.assertEqual(enq.call_args.args[0], "whatsapp_next.services.campaign_runner.materialize")
			with self.assertRaises(WAStateConflictError):
				api.start(name=name)
			runner.materialize(name)
			self.assertEqual(api.pause(name=name, reason="ApiTest hold"), {"status": "Paused", "count": 2})
			with self.assertRaises(WAStateConflictError):
				api.pause(name=name)
			self.assertEqual(api.resume(name=name), {"status": "Running", "count": 2})
			self.assertEqual(
				api.cancel(name=name, reason="ApiTest stop"), {"status": "Cancelled", "count": 2}
			)
			with self.assertRaises(WAStateConflictError):
				api.cancel(name=name)
		actions = sorted(
			frappe.get_all("WhatsApp Audit Log", filters={"reference_name": name}, pluck="action")
		)
		self.assertEqual(
			actions, ["Campaign Cancelled", "Campaign Paused", "Campaign Resumed", "Campaign Started"]
		)

	def test_schedule_unschedule(self):
		name = self._campaign()
		when = add_to_date(now_datetime(), hours=2).replace(microsecond=0)
		with as_user("WhatsApp Manager"):
			res = api.schedule(name=name, scheduled_at=str(when))
			self.assertEqual((res["status"], res["scheduled_at"]), ("Scheduled", when))
			with self.assertRaises(WAValidationError):
				api.schedule(name=name, scheduled_at="not a date")
			self.assertEqual(api.unschedule(name=name), {"status": "Draft"})
			with self.assertRaises(WAStateConflictError):
				api.unschedule(name=name)
			with self.assertRaises(WAValidationError):
				api.schedule(name=name, scheduled_at=str(add_to_date(now_datetime(), hours=-1)))

	# -- reads -------------------------------------------------------------------------

	def test_progress_and_sending_now(self):
		name = self._running()
		with as_user("WhatsApp Viewer"):
			p = api.get_progress(name=name)
			now = api.get_sending_now()
		self.assertEqual(p["status"], "Running")
		self.assertEqual((p["counters"]["total"], p["counters"]["queued"], p["counters"]["open"]), (2, 2, 2))
		self.assertEqual(
			set(p["rates"]), {"messages_per_minute", "sent_last_minute", "percent", "eta_seconds"}
		)
		self.assertEqual(p["rates"]["percent"], 0.0)
		self.assertEqual(len(p["recent"]), 2)
		self.assertIn(name, [r["name"] for r in now])
		self.assertEqual(next(r for r in now if r["name"] == name)["counters"]["total"], 2)

	def test_overview(self):
		"""Campaign states, what is still in flight, and the shares the console's metric row shows."""
		running = self._running()
		frappe.db.set_value(
			"WhatsApp Campaign",
			running,
			{
				"total_recipients": 10,
				"sent_count": 6,
				"delivered_count": 5,
				"read_count": 2,
				"failed_count": 1,
				"started_at": frappe.utils.now_datetime(),
			},
			update_modified=False,
		)
		with as_user("WhatsApp Viewer"):
			out = api.get_overview(days=30)
		self.assertEqual(out["days"], 30)
		self.assertGreaterEqual(out["states"]["Running"], 1)
		# 10 recipients, 6 sent and 1 failed leaves 3 still to go
		self.assertGreaterEqual(out["in_flight"], 3)
		self.assertGreaterEqual(out["totals"]["sent"], 6)
		self.assertGreaterEqual(out["totals"]["delivered"], 5)
		self.assertGreaterEqual(out["totals"]["read"], 2)
		self.assertGreaterEqual(out["totals"]["failed"], 1)
		self.assertIsNotNone(out["per_minute"])

	def test_overview_window_is_bounded(self):
		with as_user("WhatsApp Viewer"):
			self.assertEqual(api.get_overview(days=9999)["days"], 365)
			self.assertEqual(api.get_overview(days=0)["days"], 30)

	def test_recipients_page(self):
		name = self._running()
		with as_user("WhatsApp Viewer"):
			page = api.get_recipients_page(name=name)
			self.assertEqual(page["total"], 2)
			self.assertEqual([r["phone_e164"] for r in page["rows"]], [P1, P2])
			self.assertEqual(page["rows"][0]["status"], "Queued")
			self.assertEqual(api.get_recipients_page(name=name, status="Queued")["total"], 2)
			self.assertEqual(api.get_recipients_page(name=name, status="Failed")["total"], 0)
			self.assertEqual(api.get_recipients_page(name=name, source_type="Contact")["total"], 1)
			self.assertEqual(api.get_recipients_page(name=name, search="920402")["rows"][0]["phone_e164"], P2)
			self.assertEqual(api.get_recipients_page(name=name, search="R1")["total"], 1)
			self.assertEqual(len(api.get_recipients_page(name=name, page=2, page_length=1)["rows"]), 1)
			self.assertEqual(len(api.get_recipients_page(name=name, page_length="9999")["rows"]), 2)  # capped
			with self.assertRaises(WAValidationError):
				api.get_recipients_page(name=name, status="Bogus")

	def test_preview_message(self):
		name = self._campaign()
		row = frappe.db.get_value("WhatsApp Campaign Recipient", {"parent": name, "phone_e164": P1}, "name")
		with as_user("WhatsApp Manager"):
			sample = api.preview_message(name=name, idx="1")
			self.assertEqual(
				(sample["body"], sample["attachment_name"], sample["errors"]),
				(f"{TAG} Hello Recipient", None, []),
			)
			real = api.preview_message(name=name, idx=1, recipient_row=row)
			self.assertEqual(real["body"], f"{TAG} Hello R1")
			with self.assertRaises(WAValidationError):
				api.preview_message(name=name, idx=7)
			with self.assertRaises(WAValidationError):
				api.preview_message(name=name, idx=1, recipient_row="no-such-row")

	def test_poll_results(self):
		plain = self._campaign()
		name = self._running(
			messages=[
				{"message_type": "Text", "body": f"{TAG} intro"},
				{"message_type": "Poll", "poll_question": f"{TAG}?", "poll_options": '["Yes", "No"]'},
			]
		)
		for r in frappe.get_all(
			"WhatsApp Log", filters={"campaign": name, "message_type": "Poll"}, pluck="name"
		):
			frappe.db.set_value("WhatsApp Log", r, "poll_id", f"poll-{r}", update_modified=False)
		with as_user("WhatsApp Manager"):
			self.assertEqual(api.get_poll_results(name=plain)["results"], [])
			with fake_provider():
				res = api.get_poll_results(name=name, refresh="1")
		self.assertEqual(len(res["results"]), 1)
		poll = res["results"][0]
		self.assertEqual(
			(poll["idx"], poll["question"], poll["sent"], poll["options"]), (2, f"{TAG}?", 2, ["Yes", "No"])
		)
		self.assertEqual(poll["counts"], [{"option": "Yes", "count": 0}, {"option": "No", "count": 0}])
		self.assertEqual(len(poll["by_poll_id"]), 2)
		# cached until refresh
		with as_user("WhatsApp Manager"):
			self.assertEqual(api.get_poll_results(name=name)["fetched_at"], res["fetched_at"])

	# -- bulk --------------------------------------------------------------------------

	def test_bulk_variants(self):
		running = self._running()
		draft = self._campaign()
		with as_user("WhatsApp Manager"):
			res = api.pause_many(names=[running, draft, "no-such-ApiTest", running], reason="ApiTest bulk")
			self.assertEqual((res["count"], res["done"]), (1, [running]))
			self.assertEqual(res["skipped"], [{"name": draft, "reason": "Draft"}])
			self.assertEqual([f["name"] for f in res["failed"]], ["no-such-ApiTest"])
			self.assertEqual(self._status(running), "Paused")
			res = api.resume_many(names=[running, draft])
			self.assertEqual((res["count"], [s["name"] for s in res["skipped"]]), (1, [draft]))
			self.assertEqual(self._status(running), "Running")
			res = api.cancel_many(names=[running, draft], reason="ApiTest bulk cancel")
			self.assertEqual((res["count"], res["skipped"]), (2, []))
			self.assertEqual((self._status(running), self._status(draft)), ("Cancelled", "Cancelled"))
			res = api.cancel_many(names=[running])
			self.assertEqual((res["count"], res["skipped"]), (0, [{"name": running, "reason": "Cancelled"}]))

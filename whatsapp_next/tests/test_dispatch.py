# Tests for services/dispatch.py, reconcile.py and quick_send.py (build order B-10): create /
# enqueue validation, claim ordering and gating, batch outcomes (accepted, held, hard error,
# transient, auth), forward-only status application, pause / resume / delete-as-state / retry,
# global pause, test send, reconcile checks and quick-send composition.

from __future__ import annotations

import frappe
from frappe.tests import IntegrationTestCase
from frappe.utils import add_to_date, now_datetime

from whatsapp_next.exceptions import (
	WABlacklistedError,
	WAInvalidPhoneError,
	WAStateConflictError,
	WAUnknownNumberPolicyError,
	WAValidationError,
)
from whatsapp_next.providers.schemas import MessageStatus
from whatsapp_next.services import dispatch, quick_send, reconcile
from whatsapp_next.services.dispatch import OutboundSpec
from whatsapp_next.services.guards import status_writer
from whatsapp_next.tests.conftest_frappe import (
	as_user,
	delete_all,
	ensure_device,
	ensure_settings,
	fake_provider,
)

P1, P2, P3 = "+966500000301", "+966500000302", "+966500000303"
BLACKLIST = "DispatchTest Blacklist"


def _spec(**kw) -> OutboundSpec:
	base = {"phone": P1, "body": "dispatch-test hello", "source_type": "Quick Send"}
	base.update(kw)
	return OutboundSpec(**base)


class TestDispatch(IntegrationTestCase):
	@classmethod
	def setUpClass(cls):
		super().setUpClass()
		cls.device = ensure_device()
		if not frappe.db.exists("WhatsApp Contact Group", BLACKLIST):
			frappe.get_doc(
				{
					"doctype": "WhatsApp Contact Group",
					"group_name": BLACKLIST,
					"kind": "Blacklist",
					"source": "Manual",
				}
			).insert(ignore_permissions=True)
		ensure_settings(
			global_blacklist_group=BLACKLIST,
			send_only_to_known_numbers=0,
			queue_paused=0,
			messages_per_minute=20,
			max_attempts=3,
			retry_backoff_seconds=300,
			default_device=cls.device,
		)

	@classmethod
	def tearDownClass(cls):
		cls._clean()
		ensure_settings(global_blacklist_group=None, queue_paused=0, send_only_to_known_numbers=0)
		delete_all("WhatsApp Contact Group", {"group_name": BLACKLIST})
		super().tearDownClass()

	def setUp(self):
		self._clean()
		ensure_settings(queue_paused=0, send_only_to_known_numbers=0, messages_per_minute=20)

	@staticmethod
	def _clean():
		delete_all("WhatsApp Queue Item")
		delete_all("WhatsApp Log", {"body": ("like", "dispatch-test%")})
		delete_all("WhatsApp Inbound Message", {"body": ("like", "dispatch-test%")})
		delete_all(
			"WhatsApp Audit Log",
			{
				"action": (
					"in",
					[
						"Queue Paused",
						"Queue Resumed",
						"Queue Items Deleted",
						"Queue Items Retried",
						"Queue Rate Changed",
					],
				)
			},
		)
		if frappe.db.exists("WhatsApp Contact Group", BLACKLIST):
			g = frappe.get_doc("WhatsApp Contact Group", BLACKLIST)
			g.set("members", [])
			g.save(ignore_permissions=True)
		# dispatch_device_batch commits mid-job, so the cleanup must be committed too — otherwise
		# the base class rollback resurrects rows and pollutes later modules.
		frappe.db.commit()

	def _log(self, name):
		return frappe.db.get_value(
			"WhatsApp Log",
			name,
			[
				"status",
				"queue_item",
				"attempts",
				"error_code",
				"platform_queue_id",
				"held_reason",
				"provider_message_id",
				"queued_at",
			],
			as_dict=True,
		)

	def _item(self, name):
		return frappe.db.get_value(
			"WhatsApp Queue Item",
			name,
			[
				"status",
				"attempts",
				"next_attempt_at",
				"last_error_code",
				"platform_queue_id",
				"priority",
				"dead_letter_reason",
				"completed_at",
			],
			as_dict=True,
		)

	# -- create / enqueue --------------------------------------------------------------

	def test_create_outbound_validation(self):
		with self.assertRaises(WAInvalidPhoneError):
			dispatch.create_outbound(_spec(phone="abc"))
		with self.assertRaises(WAValidationError):
			dispatch.create_outbound(_spec(body=""))
		with self.assertRaises(WAValidationError):
			dispatch.create_outbound(_spec(message_type="Image", attachment=None))
		with self.assertRaises(WAValidationError):
			dispatch.create_outbound(_spec(message_type="Poll", poll_question="Q", poll_options="one"))
		with self.assertRaises(WAValidationError):
			dispatch.create_outbound(_spec(message_type="Location", location={"latitude": 1}))
		g = frappe.get_doc("WhatsApp Contact Group", BLACKLIST)
		g.append("members", {"phone": P2, "source_type": "Manual"})
		g.save(ignore_permissions=True)
		with self.assertRaises(WABlacklistedError):
			dispatch.create_outbound(_spec(phone=P2))
		ensure_settings(send_only_to_known_numbers=1)
		with self.assertRaises(WAUnknownNumberPolicyError):
			dispatch.create_outbound(_spec(phone=P3))
		# campaigns and explicit skip bypass the policy; group JIDs are never subject to it
		name = dispatch.create_outbound(_spec(phone=P3, skip_policy=True))
		self.assertEqual(self._log(name).status, "Unsent")
		grp = dispatch.create_outbound(_spec(phone=None, jid="120363000000000009@g.us"))
		row = frappe.db.get_value("WhatsApp Log", grp, ["recipient_type", "jid", "phone_e164"], as_dict=True)
		# for groups the controller stores the JID in `phone_e164` too (the Number key)
		self.assertEqual(
			(row.recipient_type, row.jid, row.phone_e164),
			("Group", "120363000000000009@g.us", "120363000000000009@g.us"),
		)

	def test_create_with_template_poll_and_enqueue_priority(self):
		tpl = frappe.get_doc(
			{
				"doctype": "WhatsApp Template",
				"template_name": "dispatch-test tpl",
				"message_type": "Text",
				"body": "dispatch-test Hi {{ recipient.display_name }}",
			}
		).insert(ignore_permissions=True)
		try:
			name = dispatch.create_outbound(
				_spec(
					body=None,
					template=tpl.name,
					template_context={"recipient": {"display_name": "Ali"}},
					display_name="Ali",
				)
			)
			self.assertEqual(frappe.db.get_value("WhatsApp Log", name, "body"), "dispatch-test Hi Ali")
			self.assertEqual(frappe.db.get_value("WhatsApp Template", tpl.name, "use_count"), 1)
			poll = dispatch.create_outbound(
				_spec(
					message_type="Poll",
					poll_question="dispatch-test?",
					poll_options="a, b",
					body="dispatch-test",
				)
			)
			self.assertEqual(frappe.db.get_value("WhatsApp Log", poll, "poll_options"), '["a", "b"]')
			notif = dispatch.create_outbound(_spec(source_type="Notification"))
			items = dispatch.enqueue([name, poll, notif, name])  # duplicate ignored
			self.assertEqual(len(items), 3)
			self.assertEqual(self._item(items[0]).priority, 1)
			self.assertEqual(self._item(items[2]).priority, 3)
			log = self._log(name)
			self.assertEqual((log.status, log.queue_item), ("Queued", items[0]))
			self.assertIsNotNone(log.queued_at)
			self.assertEqual(dispatch.enqueue([name]), [])  # already queued
		finally:
			delete_all("WhatsApp Queue Item")
			delete_all("WhatsApp Log", {"template": tpl.name})
			tpl.delete(ignore_permissions=True)

	# -- claim -------------------------------------------------------------------------

	def test_claim_orders_and_gates(self):
		low = dispatch.create_and_enqueue(_spec(source_type="Notification"))
		high = dispatch.create_and_enqueue(_spec(phone=P2))
		future = dispatch.create_and_enqueue(
			_spec(phone=P3, scheduled_at=add_to_date(now_datetime(), hours=1))
		)
		claimed = dispatch.claim_batch(self.device, 10)
		self.assertEqual([c.outbound_message for c in claimed], [high[0], low[0]])
		self.assertEqual(self._item(high[1]).status, "Sending")
		self.assertEqual(self._log(high[0]).status, "Sending")
		self.assertEqual(self._item(future[1]).status, "Queued")
		self.assertEqual(dispatch.claim_batch(self.device, 10), [])  # nothing left due
		self.assertEqual(dispatch.claim_batch(self.device, 0), [])
		# a retry scheduled in the future is not claimable
		with status_writer():
			frappe.db.set_value(
				"WhatsApp Queue Item",
				high[1],
				{"status": "Queued", "next_attempt_at": add_to_date(now_datetime(), minutes=5)},
			)
		self.assertEqual(dispatch.claim_batch(self.device, 10), [])

	# -- batch outcomes -----------------------------------------------------------------

	def _queued(self, n=2):
		return [dispatch.create_and_enqueue(_spec(phone=p)) for p in (P1, P2, P3)[:n]]

	def test_batch_accepted_and_held(self):
		rows = self._queued(2)
		with fake_provider() as fp:
			counts = dispatch.dispatch_device_batch(self.device)
			self.assertEqual((counts["claimed"], counts["accepted"]), (2, 2))
			self.assertEqual(fp.calls[-1][0], "send_batch")
			for out, item in rows:
				self.assertEqual(self._item(item).status, "Completed")
				log = self._log(out)
				self.assertEqual(log.status, "Sending")
				self.assertTrue(log.platform_queue_id.startswith("MQ-"))
			# the second tick has nothing to do
			self.assertEqual(dispatch.dispatch_device_batch(self.device), {"claimed": 0})
		held = self._queued(1)[0]
		with fake_provider() as fp:
			fp.batch_mode = "held"
			counts = dispatch.dispatch_device_batch(self.device)
			self.assertEqual(counts["held"], 1)
			self.assertEqual(self._log(held[0]).status, "Held")
			self.assertEqual(self._item(held[1]).status, "Completed")

	def test_batch_hard_error_dead_letters(self):
		out, item = self._queued(1)[0]
		with fake_provider() as fp:
			fp.batch_mode = "error"
			counts = dispatch.dispatch_device_batch(self.device)
		self.assertEqual(counts["dead"], 1)
		qi, log = self._item(item), self._log(out)
		self.assertEqual((qi.status, qi.last_error_code), ("Dead Letter", "invalid_phone"))
		self.assertEqual((log.status, log.error_code, log.attempts), ("Failed", "invalid_phone", 1))
		# manager retry
		self.assertEqual(dispatch.retry_dead_letter([item]), 1)
		self.assertEqual(
			(self._item(item).status, self._item(item).attempts, self._log(out).status),
			("Queued", 0, "Queued"),
		)

	def test_batch_transient_backs_off_then_dead_letters(self):
		out, item = self._queued(1)[0]
		with fake_provider() as fp:
			fp.batch_mode = "transient"
			counts = dispatch.dispatch_device_batch(self.device)
		self.assertEqual(counts["call_failure"], 1)
		qi = self._item(item)
		self.assertEqual((qi.status, qi.attempts, qi.last_error_code), ("Queued", 0, "timeout"))
		self.assertGreater(qi.next_attempt_at, now_datetime())
		self.assertEqual(self._log(out).status, "Queued")
		# per-message transient errors count attempts; the third one dead-letters
		with status_writer():
			frappe.db.set_value("WhatsApp Queue Item", item, {"attempts": 2, "next_attempt_at": None})
		with fake_provider() as fp:
			fp.batch_mode = "accepted"
			fp.send_batch = lambda messages, batch_id: __import__(
				"whatsapp_next.providers.schemas", fromlist=["BatchResult"]
			).BatchResult(
				batch_id=batch_id,
				errors=tuple(
					__import__("whatsapp_next.providers.schemas", fromlist=["BatchError"]).BatchError(
						client_ref=m.client_ref, error="gateway timeout", code="TIMEOUT"
					)
					for m in messages
				),
			)
			counts = dispatch.dispatch_device_batch(self.device)
		self.assertEqual(counts["dead"], 1)
		self.assertEqual(self._item(item).status, "Dead Letter")

	def test_batch_auth_failure_marks_settings(self):
		_out, item = self._queued(1)[0]
		with fake_provider() as fp:
			fp.batch_mode = "auth"
			counts = dispatch.dispatch_device_batch(self.device)
		self.assertEqual(counts["error_code"], "auth")
		self.assertEqual(self._item(item).status, "Queued")
		self.assertEqual(frappe.db.get_single_value("WhatsApp Settings", "connection_status"), "Failed")
		ensure_settings(connection_status="Untested")

	# -- status application ----------------------------------------------------------

	def test_apply_status_forward_only(self):
		out = dispatch.create_outbound(_spec())
		self.assertTrue(dispatch.apply_status(out, "Sent", provider_message_id="pm-1"))
		self.assertTrue(dispatch.apply_status(out, "Read"))
		self.assertFalse(dispatch.apply_status(out, "Delivered"))  # backwards
		self.assertEqual(self._log(out).status, "Read")
		self.assertTrue(
			dispatch.apply_status(out, "Failed", error_code="platform_rejected", reason="late failure")
		)
		self.assertFalse(dispatch.apply_status(out, "Sent"))  # final
		self.assertEqual(self._log(out).error_code, "platform_rejected")
		held = dispatch.create_outbound(_spec(phone=P2))
		dispatch.apply_status(held, "Held", reason="quota")
		self.assertEqual(self._log(held).held_reason, "quota")
		dispatch.apply_status(held, "Sent")
		self.assertEqual((self._log(held).status, self._log(held).held_reason), ("Sent", None))
		self.assertFalse(dispatch.apply_status("no-such-row", "Sent"))

	def test_send_test_message(self):
		out = dispatch.create_outbound(_spec(is_test=True))
		with fake_provider():
			result = dispatch.send_test_message(out)
		self.assertTrue(result.ok)
		log = self._log(out)
		self.assertEqual((log.status, log.attempts), ("Sent", 1))
		self.assertTrue(log.provider_message_id.startswith("pm-"))
		out2 = dispatch.create_outbound(_spec(is_test=True, phone=P2))
		with fake_provider() as fp:
			fp.send_mode = "rejected"
			result = dispatch.send_test_message(out2)
		self.assertFalse(result.ok)
		self.assertEqual(
			(self._log(out2).status, self._log(out2).error_code), ("Failed", "insufficient_balance")
		)

	# -- queue management ------------------------------------------------------------

	def test_pause_resume_delete_rows(self):
		(_o1, i1), (o2, i2) = self._queued(2)
		with as_user("WhatsApp Manager"):
			self.assertEqual(dispatch.pause_items([i1, i2], reason="hold"), 2)
			self.assertEqual(self._item(i1).status, "Paused")
			self.assertEqual(dispatch.claim_batch(self.device, 10), [])
			self.assertEqual(dispatch.resume_items([i1]), 1)
			self.assertEqual(self._item(i1).status, "Queued")
			claimed = dispatch.claim_batch(self.device, 10)
			self.assertEqual([c.name for c in claimed], [i1])
			with self.assertRaises(WAStateConflictError):
				dispatch.delete_items([i1, i2], reason="x")
			self.assertEqual(dispatch.delete_items([i2], reason="no longer needed"), 1)
			self.assertEqual((self._item(i2).status, self._log(o2).status), ("Deleted", "Cancelled"))
			self.assertEqual(frappe.db.count("WhatsApp Queue Item", {"name": i2}), 1)  # never removed
		actions = [
			r.action
			for r in frappe.get_all(
				"WhatsApp Audit Log",
				filters={"action": ("in", ["Queue Paused", "Queue Resumed", "Queue Items Deleted"])},
				fields=["action"],
			)
		]
		self.assertEqual(sorted(actions), ["Queue Items Deleted", "Queue Paused", "Queue Resumed"])

	def test_global_pause_and_rate(self):
		self._queued(1)
		with as_user("WhatsApp Manager"):
			dispatch.pause_queue(reason="maintenance")
			self.assertEqual(dispatch.dispatch_tick(), [])
			self.assertEqual(dispatch.dispatch_device_batch(self.device), {"skipped": 1})
			summary = dispatch.queue_summary(self.device)
			self.assertTrue(summary["paused_globally"])
			self.assertEqual(summary["queued"], 1)
			dispatch.resume_queue()
			self.assertFalse(dispatch.queue_summary()["paused_globally"])
			self.assertEqual(dispatch.set_rate(30), 30)
			with self.assertRaises(WAValidationError):
				dispatch.set_rate(2)
			ensure_settings(plan_messages_per_minute=10, messages_per_minute=10)
			with self.assertRaises(WAValidationError):
				dispatch.set_rate(20)
			ensure_settings(plan_messages_per_minute=0, messages_per_minute=20)

	# -- reconcile -------------------------------------------------------------------

	def test_reconcile_handed_over_and_stale(self):
		(o1, _i1), (o2, i2) = self._queued(2)
		with fake_provider() as fp:
			dispatch.dispatch_device_batch(self.device)
			old = add_to_date(now_datetime(), minutes=-15)
			frappe.db.set_value("WhatsApp Log", o1, "modified", old, update_modified=False)
			frappe.db.set_value("WhatsApp Log", o2, "modified", old, update_modified=False)
			fp.statuses[o1] = MessageStatus(
				client_ref=o1, queue_id="MQ-x", status="Sent", provider_message_id="pm-9"
			)
			fp.statuses.pop(o2)  # unknown to the platform
			counts = reconcile.reconcile_handed_over()
			self.assertEqual((counts["resolved"], counts["requeued"]), (1, 1))
			self.assertEqual((self._log(o1).status, self._log(o1).provider_message_id), ("Sent", "pm-9"))
			self.assertEqual((self._log(o2).status, self._item(i2).status), ("Queued", "Queued"))
			# second unknown → Failed
			dispatch.dispatch_device_batch(self.device)
			frappe.db.set_value("WhatsApp Log", o2, "modified", old, update_modified=False)
			fp.statuses.pop(o2, None)
			counts = reconcile.reconcile_handed_over()
			self.assertEqual(counts["failed_unknown"], 1)
			self.assertEqual(self._log(o2).status, "Failed")
		# stale claim
		o3, i3 = dispatch.create_and_enqueue(_spec(phone=P3))
		dispatch.claim_batch(self.device, 10)
		frappe.db.set_value(
			"WhatsApp Queue Item",
			i3,
			"claimed_at",
			add_to_date(now_datetime(), minutes=-20),
			update_modified=False,
		)
		self.assertEqual(reconcile.requeue_stale_claims(), 1)
		self.assertEqual((self._item(i3).status, self._log(o3).status), ("Queued", "Queued"))
		# coherence: drift fixed from the queue item
		with status_writer():
			frappe.db.set_value("WhatsApp Log", o3, "status", "Sending")
		drifts = reconcile.assert_coherence(fix=True)
		self.assertEqual(
			[(d.queue_status, d.outbound_status, d.fixed_to) for d in drifts],
			[("Queued", "Sending", "Queued")],
		)
		self.assertEqual(reconcile.assert_coherence(), [])

	# -- quick send ------------------------------------------------------------------

	def test_quick_send_compose_and_helpers(self):
		_out, item = quick_send.compose(_spec())
		self.assertEqual(self._item(item).priority, 1)
		with self.assertRaises(WAValidationError):
			quick_send.compose(_spec(source_type="Campaign"))
		ensure_settings(queue_paused=1)
		self.assertEqual(quick_send.warnings_for(self.device), ["queue_paused"])
		ensure_settings(queue_paused=0)
		self.assertEqual(quick_send.warnings_for("no-such-device"), ["device_offline"])
		rec = quick_send.resolve_recipient(phone="0500000301")
		self.assertEqual((rec["phone_e164"], rec["known"], rec["blacklisted"]), (P1, True, False))
		with self.assertRaises(WAInvalidPhoneError):
			quick_send.resolve_recipient(phone="abc")
		pv = quick_send.preview(body="dispatch-test {{ recipient.display_name }}")
		self.assertTrue(pv["body"].startswith("dispatch-test"))
		self.assertEqual(quick_send.preview(body="{{ x ")["errors"][0][:19], "TemplateSyntaxError")

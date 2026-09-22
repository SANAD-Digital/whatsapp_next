# Tests for services/read_layer.py: union order and direction, keyset paging, watermark
# batches, per-key stats, known keys, device stats and reference amounts (build order B-7).

from __future__ import annotations

import datetime as dt

import frappe
from frappe.tests import IntegrationTestCase
from frappe.utils import add_to_date, now_datetime

from whatsapp_next.services import read_layer
from whatsapp_next.services.guards import status_writer
from whatsapp_next.tests.conftest_frappe import delete_all, ensure_device, ensure_settings

KEY_A = "+966500000101"
KEY_B = "+966500000102"
GROUP = "120363000000000001@g.us"
LID = "123456789012345@lid"
TAG = "rl-test"


def _outbound(
	device: str,
	*,
	phone: str | None = KEY_A,
	jid: str | None = None,
	status: str = "Sent",
	ts: dt.datetime | None = None,
	display_name: str | None = None,
	recipient_type: str = "Individual",
) -> str:
	with status_writer():
		doc = frappe.get_doc(
			{
				"doctype": "WhatsApp Log",
				"device": device,
				"recipient_type": recipient_type,
				"phone": phone,
				"jid": jid,
				"message_type": "Text",
				"body": f"{TAG} out",
				"status": status,
				"source_type": "API",
				"display_name": display_name,
			}
		)
		doc.insert(ignore_permissions=True)
	if ts:
		frappe.db.set_value("WhatsApp Log", doc.name, "creation", ts, update_modified=False)
	return doc.name


def _inbound(
	device: str,
	*,
	phone: str | None = KEY_A,
	chat_jid: str | None = None,
	sender_jid: str | None = None,
	ts: dt.datetime | None = None,
	display_name: str | None = None,
) -> str:
	ts = ts or now_datetime()
	doc = frappe.get_doc(
		{
			"doctype": "WhatsApp Inbound Message",
			"device": device,
			"phone": phone,
			"chat_jid": chat_jid,
			"sender_jid": sender_jid,
			"message_type": "Text",
			"body": f"{TAG} in",
			"provider_message_id": frappe.generate_hash(length=12),
			"received_at": ts,
			"command_status": "None",
			"display_name": display_name,
		}
	)
	doc.insert(ignore_permissions=True)
	frappe.db.set_value("WhatsApp Inbound Message", doc.name, "creation", ts, update_modified=False)
	return doc.name


class TestReadLayer(IntegrationTestCase):
	@classmethod
	def setUpClass(cls):
		super().setUpClass()
		ensure_settings()
		# Dedicated devices: other modules' rows on the shared test device must not affect counts.
		cls.device = ensure_device("Read Layer Device", "WAD-TEST-RL01", phone="+966500000011")
		cls.device2 = ensure_device("Read Layer Device 2", "WAD-TEST-RL02", phone="+966500000012")

	def setUp(self):
		self._clean()
		# Two days back: no other module backdates rows there, so window-based tests stay isolated.
		self.t0 = add_to_date(now_datetime(), days=-2)

	def tearDown(self):
		self._clean()

	@staticmethod
	def _clean():
		delete_all("WhatsApp Log", {"body": ("like", f"{TAG}%")})
		delete_all("WhatsApp Inbound Message", {"body": ("like", f"{TAG}%")})

	def _t(self, minutes: int) -> dt.datetime:
		return add_to_date(self.t0, minutes=minutes)

	# -- conversation ------------------------------------------------------------------

	def test_conversation_merges_both_directions_newest_first(self):
		o1 = _outbound(self.device, ts=self._t(1))
		i1 = _inbound(self.device, ts=self._t(2), display_name="Push Name")
		o2 = _outbound(self.device, ts=self._t(3))
		_outbound(self.device, phone=KEY_B, ts=self._t(4))  # other key, must not appear
		page = read_layer.conversation(KEY_A)
		self.assertEqual([r.name for r in page.rows], [o2, i1, o1])
		self.assertEqual([r.direction for r in page.rows], ["Outbound", "Inbound", "Outbound"])
		self.assertFalse(page.has_more)
		self.assertTrue(all(r.key == KEY_A for r in page.rows))
		self.assertEqual(page.rows[1].display_name, "Push Name")

	def test_conversation_keyset_paging(self):
		names = []
		for i in range(5):
			names.append(
				_outbound(self.device, ts=self._t(i)) if i % 2 else _inbound(self.device, ts=self._t(i))
			)
		first = read_layer.conversation(KEY_A, limit=2)
		self.assertTrue(first.has_more)
		self.assertEqual([r.name for r in first.rows], [names[4], names[3]])
		second = read_layer.conversation(KEY_A, before=first.next_cursor, limit=2)
		self.assertEqual([r.name for r in second.rows], [names[2], names[1]])
		third = read_layer.conversation(KEY_A, before=second.next_cursor, limit=2)
		self.assertEqual([r.name for r in third.rows], [names[0]])
		self.assertFalse(third.has_more)
		self.assertIsNone(third.next_cursor)

	def test_conversation_device_filter_and_group_key(self):
		_outbound(self.device, phone=None, jid=GROUP, recipient_type="Group", ts=self._t(1))
		_inbound(
			self.device2, phone=None, chat_jid=GROUP, sender_jid="966500000101@s.whatsapp.net", ts=self._t(2)
		)
		self.assertEqual(len(read_layer.conversation(GROUP).rows), 2)
		self.assertEqual(len(read_layer.conversation(GROUP, device=self.device2).rows), 1)
		self.assertEqual({r.key for r in read_layer.conversation(GROUP).rows}, {GROUP})

	def test_lid_sender_keyed_by_jid(self):
		_inbound(self.device, phone=None, sender_jid=LID, ts=self._t(1))
		rows = read_layer.conversation(LID).rows
		self.assertEqual(len(rows), 1)
		self.assertEqual(rows[0].key, LID)

	# -- cross_direction_rows ---------------------------------------------------------

	def test_cross_direction_rows_direction_and_order(self):
		_outbound(self.device, ts=self._t(1))
		_inbound(self.device, ts=self._t(2))
		_outbound(self.device2, phone=KEY_B, ts=self._t(3))
		rows = read_layer.cross_direction_rows({"device": self.device, "from": self._t(0)}, {"order": "asc"})
		self.assertEqual([r.direction for r in rows], ["Outbound", "Inbound"])
		only_in = read_layer.cross_direction_rows({"direction": "Inbound", "from": self._t(0)})
		self.assertEqual([r.direction for r in only_in], ["Inbound"])
		both_keys = read_layer.cross_direction_rows({"keys": [KEY_A, KEY_B], "from": self._t(0)})
		self.assertEqual(len(both_keys), 3)

	# -- iter_keys_since --------------------------------------------------------------

	def test_iter_keys_since_batches_and_watermark(self):
		for i in range(4):
			_outbound(self.device, phone=KEY_A if i < 2 else KEY_B, ts=self._t(i))
		_inbound(self.device, phone=KEY_B, ts=self._t(4))
		# `upper` stays in the past so rows other modules create "now" fall outside the window.
		upper = self._t(5)
		batches = list(read_layer.iter_keys_since(self._t(-1), upper, batch=2))
		self.assertEqual(len(batches), 3)
		self.assertEqual(set().union(*batches), {KEY_A, KEY_B})
		self.assertEqual(batches[0], {KEY_A})
		later = list(read_layer.iter_keys_since(self._t(3), upper, batch=100))
		self.assertEqual(later, [{KEY_B}])
		self.assertEqual(list(read_layer.iter_keys_since(self._t(4), upper)), [])

	# -- stats_by_key / known_keys ----------------------------------------------------

	def test_stats_by_key(self):
		_outbound(self.device, ts=self._t(1), display_name="Out Name")
		_outbound(self.device, ts=self._t(2))
		_inbound(self.device2, ts=self._t(3), display_name="Push Name")
		_outbound(self.device, phone=KEY_B, ts=self._t(5))
		stats = read_layer.stats_by_key([KEY_A, KEY_B, "+966500000999"])
		self.assertEqual(set(stats), {KEY_A, KEY_B})
		a = stats[KEY_A]
		self.assertEqual((a.outbound_count, a.inbound_count), (2, 1))
		self.assertEqual(a.first_seen, self._t(1))
		self.assertEqual(a.last_seen, self._t(3))
		self.assertEqual(a.last_direction, "Inbound")
		self.assertEqual(a.last_device, self.device2)
		self.assertEqual(a.display_name, "Push Name")
		b = stats[KEY_B]
		self.assertEqual(
			(b.outbound_count, b.inbound_count, b.last_direction, b.last_device),
			(1, 0, "Outbound", self.device),
		)

	def test_known_keys(self):
		_outbound(self.device, ts=self._t(1))
		_inbound(self.device, phone=None, chat_jid=GROUP, sender_jid="1@s.whatsapp.net", ts=self._t(2))
		self.assertEqual(read_layer.known_keys([KEY_A, KEY_B, GROUP, LID, ""]), {KEY_A, GROUP})
		self.assertEqual(read_layer.known_keys([]), set())

	# -- device_stats / reference_amount ----------------------------------------------

	def test_device_stats(self):
		for status in ("Sent", "Delivered", "Failed", "Queued"):
			_outbound(self.device, status=status, ts=self._t(1))
		_inbound(self.device, ts=self._t(2))
		_outbound(self.device2, status="Failed", ts=self._t(3))
		s = read_layer.device_stats(self.device, days=7)
		self.assertEqual((s.sent, s.failed, s.outbound, s.inbound), (2, 1, 4, 1))
		self.assertAlmostEqual(s.fail_rate, 1 / 3, places=3)
		self.assertEqual(s.last_message_at, self._t(2))

	def test_reference_amount(self):
		self.assertIsNone(read_layer.reference_amount("Role", "System Manager"))
		self.assertIsNone(read_layer.reference_amount("Nope DocType", "x"))
		self.assertIsNone(read_layer.reference_amount(None, None))

	def test_single_statement_union(self):
		"""The conversation read is one UNION ALL statement with both branches key-filtered."""
		q = read_layer._union({}, keys=[KEY_A], limit=5)
		sql = str(q)
		self.assertEqual(sql.count("UNION ALL"), 1)
		self.assertEqual(sql.count(KEY_A), 2)
		self.assertIn("`tabWhatsApp Log`", sql)
		self.assertIn("`tabWhatsApp Inbound Message`", sql)

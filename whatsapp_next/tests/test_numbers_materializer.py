# Tests for services/numbers_materializer.py (build order B-13): incremental upsert, nightly
# watermark job, idempotency (running twice changes nothing), contact link on insert only,
# group display names, drift check.

from __future__ import annotations

from unittest.mock import patch

import frappe
from frappe.tests import IntegrationTestCase
from frappe.utils import add_to_date, now_datetime

from whatsapp_next.services import numbers_materializer as nm
from whatsapp_next.services.guards import status_writer
from whatsapp_next.tests.conftest_frappe import delete_all, ensure_contact, ensure_device, ensure_settings

K1, K2, K3 = "+966500000501", "+966500000502", "+966500000503"
GROUP = "120363000000000501@g.us"
TAG = "nm-test"


def _out(device, phone=K1, jid=None, recipient_type="Individual", ts=None, display_name=None, skip_hook=True):
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
				"status": "Sent",
				"source_type": "API",
				"display_name": display_name,
			}
		)
		doc.flags.skip_numbers_upsert = skip_hook
		doc.insert(ignore_permissions=True)
	if ts:
		frappe.db.set_value("WhatsApp Log", doc.name, "creation", ts, update_modified=False)
	return doc.name


def _in(device, phone=K1, chat_jid=None, sender_jid=None, ts=None, display_name=None):
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
	doc.flags.skip_numbers_upsert = True
	doc.insert(ignore_permissions=True)
	frappe.db.set_value("WhatsApp Inbound Message", doc.name, "creation", ts, update_modified=False)
	return doc.name


def _numbers():
	return {
		r.name: r
		for r in frappe.get_all(
			"WhatsApp Number",
			filters={"name": ("in", [K1, K2, K3, GROUP])},
			fields=[
				"name",
				"outbound_count",
				"inbound_count",
				"last_direction",
				"last_device",
				"display_name",
				"contact",
				"link_status",
				"number_type",
				"first_seen",
				"last_seen",
				"modified",
			],
		)
	}


class TestNumbersMaterializer(IntegrationTestCase):
	@classmethod
	def setUpClass(cls):
		super().setUpClass()
		ensure_settings()
		cls.device = ensure_device("Numbers Device", "WAD-TEST-NM01", phone="+966500000021")

	def setUp(self):
		self._clean()
		self.t0 = add_to_date(now_datetime(), minutes=-30)

	def tearDown(self):
		self._clean()

	@staticmethod
	def _clean():
		delete_all("WhatsApp Log", {"body": ("like", f"{TAG}%")})
		delete_all("WhatsApp Inbound Message", {"body": ("like", f"{TAG}%")})
		delete_all("WhatsApp Number", {"name": ("in", [K1, K2, K3, GROUP])})
		ensure_settings(numbers_watermark=None)

	def _t(self, m):
		return add_to_date(self.t0, minutes=m)

	def test_refresh_keys_insert_update_and_idempotent(self):
		contact = ensure_contact("NM Test Contact", K1)
		_out(self.device, ts=self._t(1))
		_out(self.device, ts=self._t(2))
		_in(self.device, ts=self._t(3), display_name="Push K1")
		_in(self.device, phone=K2, ts=self._t(4), display_name="Push K2")
		stats = nm.refresh_keys([K1, K2, K3, "garbage", GROUP])
		self.assertEqual((stats.inserted, stats.updated, stats.invalid, stats.visited), (2, 0, 1, 4))
		rows = _numbers()
		self.assertEqual(set(rows), {K1, K2})  # K3/GROUP have no messages → no row
		r1 = rows[K1]
		self.assertEqual(
			(r1.outbound_count, r1.inbound_count, r1.last_direction, r1.last_device),
			(2, 1, "Inbound", self.device),
		)
		self.assertEqual(
			(r1.contact, r1.link_status, r1.display_name), (contact, "Linked", "NM Test Contact")
		)
		self.assertEqual((rows[K2].link_status, rows[K2].display_name), ("Not Linked", "Push K2"))
		# second run: nothing changes, `modified` untouched
		before = {k: v.modified for k, v in rows.items()}
		stats = nm.refresh_keys([K1, K2])
		self.assertEqual((stats.inserted, stats.updated, stats.unchanged), (0, 0, 2))
		self.assertEqual({k: v.modified for k, v in _numbers().items()}, before)
		# a new message → counters reassigned (not incremented twice)
		_out(self.device, phone=K2, ts=self._t(5))
		nm.refresh_keys([K2])
		nm.refresh_keys([K2])
		r2 = _numbers()[K2]
		self.assertEqual((r2.outbound_count, r2.inbound_count, r2.last_direction), (1, 1, "Outbound"))

	def test_upsert_from_message_and_hook(self):
		name = _out(self.device, phone=K3, ts=self._t(1))
		nm.upsert_from_message("WhatsApp Log", name)
		self.assertEqual(_numbers()[K3].outbound_count, 1)
		self.assertEqual(nm.upsert_from_message("WhatsApp Log", "no-such-row").visited, 0)
		# the after_insert hook enqueues (deduplicated per key) unless the flag is set
		with patch.object(frappe, "enqueue") as enq:
			_out(self.device, phone=K3, ts=self._t(2), skip_hook=False)
			_out(self.device, phone=K3, ts=self._t(3), skip_hook=True)
		self.assertEqual(enq.call_count, 1)
		self.assertEqual(enq.call_args.kwargs["job_id"], nm._job_id(K3))
		self.assertTrue(enq.call_args.kwargs["deduplicate"])

	def test_group_rows_and_display_name(self):
		_out(self.device, phone=None, jid=GROUP, recipient_type="Group", ts=self._t(1))
		_in(self.device, phone=None, chat_jid=GROUP, sender_jid="966500000501@s.whatsapp.net", ts=self._t(2))
		nm.refresh_keys([GROUP])
		g = _numbers()[GROUP]
		self.assertEqual(
			(g.number_type, g.outbound_count, g.inbound_count, g.link_status), ("Group", 1, 1, "Not Linked")
		)
		self.assertTrue(nm.refresh_group_name(GROUP, "Sales Team"))
		self.assertFalse(nm.refresh_group_name(GROUP, "Sales Team"))  # unchanged
		self.assertFalse(nm.refresh_group_name(K1, "x"))
		self.assertEqual(_numbers()[GROUP].display_name, "Sales Team")
		self.assertEqual(
			nm.message_key(
				{
					"doctype": "WhatsApp Inbound Message",
					"is_group": 1,
					"chat_jid": GROUP,
					"phone_e164": "+966500000501",
				}
			),
			GROUP,
		)
		self.assertEqual(nm.message_key({"doctype": "WhatsApp Log", "phone_e164": K1, "jid": None}), K1)

	def test_nightly_watermark_and_idempotency(self):
		_out(self.device, ts=self._t(1))
		_in(self.device, phone=K2, ts=self._t(2))
		with patch.object(frappe.db, "commit"):  # keep the test transaction
			first = nm.nightly_reconcile()
		self.assertGreaterEqual(first["inserted"], 2)
		wm = frappe.db.get_single_value("WhatsApp Settings", "numbers_watermark")
		self.assertIsNotNone(wm)
		snapshot = _numbers()
		with patch.object(frappe.db, "commit"):
			second = nm.nightly_reconcile()
		self.assertEqual((second["inserted"], second["updated"]), (0, 0))
		self.assertEqual(_numbers(), snapshot)
		# a message newer than the watermark is picked up by the next incremental run
		_out(self.device, phone=K3)  # created now: after the last watermark, before the next upper
		with patch.object(frappe.db, "commit"):
			third = nm.nightly_reconcile()
		self.assertEqual(third["inserted"], 1)
		self.assertIn(K3, _numbers())
		# drift: contact set but link_status wrong → fixed
		frappe.db.set_value(
			"WhatsApp Number",
			K1,
			{"contact": ensure_contact("NM Test Contact", K1), "link_status": "Not Linked"},
			update_modified=False,
		)
		with patch.object(frappe.db, "commit"):
			fourth = nm.nightly_reconcile()
		self.assertEqual(fourth["drift"]["link_status_fixed"], 1)
		self.assertEqual(_numbers()[K1].link_status, "Linked")

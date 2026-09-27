# Tests for services/picker.py (build order B-15): sources, manual / Excel / CSV / vCard
# parsing with limits and ownership, preview classification, commit add/remove on both targets
# with audit rows, and the running-campaign behaviour.

from __future__ import annotations

import csv
import io
from unittest.mock import patch

import frappe
from frappe.tests import IntegrationTestCase

from whatsapp_next.exceptions import WAFileError, WAStateConflictError, WAValidationError
from whatsapp_next.services import attachments, picker
from whatsapp_next.services.guards import status_writer
from whatsapp_next.tests.conftest_frappe import (
	as_user,
	delete_all,
	delete_test_rows,
	ensure_device,
	ensure_settings,
)

GROUP = "PickerTest Group"
P1, P2, P3 = "+966500000801", "+966500000802", "+966500000803"


class TestPicker(IntegrationTestCase):
	@classmethod
	def setUpClass(cls):
		super().setUpClass()
		cls.device = ensure_device("Picker Device", "WAD-TEST-PK01", phone="+966500000051")
		ensure_settings(default_device=cls.device)

	def setUp(self):
		self._clean()
		frappe.get_doc(
			{
				"doctype": "WhatsApp Contact Group",
				"group_name": GROUP,
				"kind": "Marketing",
				"source": "Picker",
				"members": [{"phone": P1, "display_name": "One", "source_type": "Manual"}],
			}
		).insert(ignore_permissions=True)

	def tearDown(self):
		self._clean()

	@staticmethod
	def _clean():
		delete_test_rows("WhatsApp Queue Item")
		delete_test_rows("WhatsApp Log", {"source_type": "Campaign"})
		delete_all("WhatsApp Campaign", {"campaign_name": ("like", "PickerTest%")})
		delete_all("WhatsApp Contact Group", {"group_name": ("like", "PickerTest%")})
		delete_all(
			"WhatsApp Audit Log",
			{
				"action": (
					"in",
					["Campaign Recipients Changed", "Contact Group Members Changed", "Queue Items Deleted"],
				)
			},
		)
		for name in frappe.get_all("File", filters={"file_name": ("like", "picker-test%")}, pluck="name"):
			frappe.delete_doc("File", name, ignore_permissions=True, force=True)

	def _campaign(self, status="Draft"):
		doc = frappe.get_doc(
			{
				"doctype": "WhatsApp Campaign",
				"campaign_name": "PickerTest Campaign",
				"device": self.device,
				"status": "Draft",
				"messages": [{"message_type": "Text", "body": "picker-test"}],
				"recipients": [
					{
						"recipient_type": "Individual",
						"phone": P1,
						"source_type": "Manual",
						"status": "Pending",
					}
				],
			}
		)
		with status_writer():
			doc.insert(ignore_permissions=True)
			if status != "Draft":
				frappe.db.set_value("WhatsApp Campaign", doc.name, "status", status)
		return doc.name

	def test_sources_and_manual(self):
		keys = [s["key"] for s in picker.list_sources("WhatsApp Campaign")]
		self.assertEqual(keys, ["Contact Group", "Contact", "DocType", "Excel", "vCard", "Manual"])
		self.assertEqual(picker.search_groups("PickerTest")["rows"][0]["name"], GROUP)
		members = picker.get_group_members(GROUP)
		self.assertEqual(
			(members["total"], members["rows"][0]["phone_e164"], members["rows"][0]["source_name"]),
			(1, P1, GROUP),
		)
		res = picker.parse_manual("0500000802\nAli;0500000803\n+966500000804 Sara\nabc\n\n,")
		self.assertEqual([r["phone_e164"] for r in res.rows], [P2, P3, "+966500000804"])
		self.assertEqual([r["display_name"] for r in res.rows], [None, "Ali", "Sara"])
		self.assertEqual(len(res.invalid), 2)
		self.assertEqual(res.total, 5)
		row = picker.make_row("120363000000000801@g.us", "Team")
		self.assertEqual((row["valid"], row["recipient_type"]), (True, "Group"))

	def test_uploads(self):
		import openpyxl

		wb = openpyxl.Workbook()
		ws = wb.active
		ws.append(["الاسم", "رقم الجوال", "note"])
		ws.append(["Ahmed", "0500000802", "x"])
		ws.append(["Bad", "abc", ""])
		ws.append([None, None, None])
		buf = io.BytesIO()
		wb.save(buf)
		url = attachments.save_private_file(buf.getvalue(), "picker-test.xlsx")
		res = picker.parse_upload(url, "excel")
		self.assertEqual(res.columns, ["الاسم", "رقم الجوال", "note"])
		self.assertEqual((len(res.rows), len(res.invalid), res.total), (1, 1, 2))
		self.assertEqual(
			(res.rows[0]["phone_e164"], res.rows[0]["display_name"], res.rows[0]["source_type"]),
			(P2, "Ahmed", "Excel"),
		)
		unmapped = picker.parse_upload(url, "excel", mapping={"phone": "nope"})
		self.assertTrue(unmapped.needs_mapping)
		self.assertEqual((unmapped.rows, unmapped.columns[:2]), ([], ["الاسم", "رقم الجوال"]))
		res = picker.parse_upload(url, "excel", mapping={"phone": "note", "name": "الاسم"})
		self.assertEqual(len(res.rows), 0)

		out = io.StringIO()
		w = csv.writer(out)
		w.writerow(["Name", "Phone 1 - Value"])
		w.writerow(["Sara", "+966 50 000 0803"])
		url = attachments.save_private_file(out.getvalue().encode("utf-8-sig"), "picker-test.csv")
		res = picker.parse_upload(url, "csv")
		self.assertEqual((res.rows[0]["phone_e164"], res.rows[0]["display_name"]), (P3, "Sara"))

		vcf = "BEGIN:VCARD\nVERSION:3.0\nFN:Omar\nTEL;TYPE=CELL:0500000802\nTEL:0500000803\nEND:VCARD\nBEGIN:VCARD\nVERSION:3.0\nFN:NoPhone\nEND:VCARD\n"
		url = attachments.save_private_file(vcf.encode(), "picker-test.vcf")
		res = picker.parse_upload(url, "vcf")
		self.assertEqual([r["phone_e164"] for r in res.rows], [P2, P3])
		self.assertEqual(len(res.invalid), 1)
		with self.assertRaises(WAValidationError):
			picker.parse_upload(url, "pdf")
		# ownership: another user's private file is refused
		with as_user("WhatsApp Agent"):
			with self.assertRaises(frappe.PermissionError):
				picker.parse_upload(url, "vcf")
		with patch.object(picker, "MAX_UPLOAD_BYTES", 10):
			with self.assertRaises(WAFileError):
				picker.parse_upload(url, "vcf")

	def test_preview_and_commit_group(self):
		rows = [
			{"phone": P1},
			{"phone": "0500000802", "display_name": "Two"},
			{"phone": P2},
			{"phone": "zzz"},
		]
		p = picker.preview("WhatsApp Contact Group", GROUP, rows)
		self.assertEqual(
			(
				[r["phone_e164"] for r in p.available],
				[r["phone_e164"] for r in p.already_added],
				len(p.invalid),
				len(p.duplicates_in_selection),
			),
			([P2], [P1], 1, 1),
		)
		res = picker.commit_add("WhatsApp Contact Group", GROUP, rows, source_type="Manual")
		self.assertEqual(res, {"added": 1, "skipped_duplicates": 2, "skipped_invalid": 1})
		g = frappe.get_doc("WhatsApp Contact Group", GROUP)
		self.assertEqual([m.phone_e164 for m in g.members], [P1, P2])
		self.assertEqual(g.member_count, 2)
		self.assertEqual(
			frappe.db.count(
				"WhatsApp Audit Log", {"action": "Contact Group Members Changed", "reference_name": GROUP}
			),
			1,
		)
		self.assertEqual(
			picker.commit_remove("WhatsApp Contact Group", GROUP, phone_e164s=["0500000801"]), {"removed": 1}
		)
		self.assertEqual(
			[m.phone_e164 for m in frappe.get_doc("WhatsApp Contact Group", GROUP).members], [P2]
		)
		self.assertEqual(
			picker.commit_remove("WhatsApp Contact Group", GROUP, filters={"source_type": "Manual"}),
			{"removed": 1},
		)
		with self.assertRaises(WAValidationError):
			picker.commit_add("WhatsApp Contact Group", GROUP, rows, source_type="Nope")
		with self.assertRaises(WAValidationError):
			picker.preview("User", "Administrator", rows)

	def test_commit_campaign_states(self):
		draft = self._campaign()
		res = picker.commit_add(
			"WhatsApp Campaign",
			draft,
			[{"phone": P2, "display_name": "Two"}],
			source_type="Contact Group",
			source_ref=GROUP,
		)
		self.assertEqual(res["added"], 1)
		rec = frappe.db.get_value(
			"WhatsApp Campaign Recipient",
			{"parent": draft, "phone_e164": P2},
			["status", "contact_group", "source_type"],
			as_dict=True,
		)
		self.assertEqual(
			(rec.status, rec.contact_group, rec.source_type), ("Pending", GROUP, "Contact Group")
		)
		self.assertEqual(frappe.db.get_value("WhatsApp Campaign", draft, "added_count"), 1)
		# remove from a draft deletes the row
		self.assertEqual(
			picker.commit_remove(
				"WhatsApp Campaign", draft, filters={"source_type": "Contact Group", "source_ref": GROUP}
			),
			{"removed": 1},
		)
		self.assertEqual(frappe.db.count("WhatsApp Campaign Recipient", {"parent": draft}), 1)
		# running: add enqueues materialize_pending; remove marks Removed and deletes queue rows
		running = self._campaign(status="Running")
		with patch.object(frappe, "enqueue") as enq:
			picker.commit_add("WhatsApp Campaign", running, [{"phone": P3}], source_type="Manual")
		self.assertEqual(enq.call_args.args[0], "whatsapp_next.services.campaign_runner.materialize_pending")
		from whatsapp_next.services import campaign_runner

		campaign_runner.materialize_pending(running)
		# both Pending recipients (the original P1 and the added P3) get their rows
		self.assertEqual(frappe.db.count("WhatsApp Queue Item", {"campaign": running, "status": "Queued"}), 2)
		self.assertEqual(picker.commit_remove("WhatsApp Campaign", running, phone_e164s=[P3]), {"removed": 1})
		self.assertEqual(
			frappe.db.get_value(
				"WhatsApp Campaign Recipient", {"parent": running, "phone_e164": P3}, "status"
			),
			"Removed",
		)
		self.assertEqual(
			frappe.db.count("WhatsApp Queue Item", {"campaign": running, "status": "Deleted"}), 1
		)
		self.assertEqual(frappe.db.get_value("WhatsApp Campaign", running, "removed_count"), 1)
		# terminal campaigns refuse changes
		done = self._campaign(status="Completed")
		with self.assertRaises(WAStateConflictError):
			picker.commit_add("WhatsApp Campaign", done, [{"phone": P2}])

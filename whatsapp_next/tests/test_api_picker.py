# Tests for api/v1/picker.py (build order B-24): role gates (Manager / Agent / Contact User read,
# write-on-target for preview and commits), the six sources, upload parsing with the kind enum,
# preview classification and commit add / remove on both targets.

from __future__ import annotations

import csv
import io

import frappe
from frappe.tests import IntegrationTestCase

from whatsapp_next.api.v1 import picker as api
from whatsapp_next.exceptions import WAPermissionError, WAValidationError
from whatsapp_next.services import attachments
from whatsapp_next.services.guards import status_writer
from whatsapp_next.tests.conftest_frappe import (
	as_user,
	delete_all,
	ensure_contact,
	ensure_device,
	ensure_settings,
)

GROUP = "ApiTest Picker Group"
CAMPAIGN = "ApiTest Picker Campaign"
CONTACT = "ApiTest Picker Contact"
P1, P2, P3 = "+966500920501", "+966500920502", "+966500920503"


class TestApiPicker(IntegrationTestCase):
	@classmethod
	def setUpClass(cls):
		super().setUpClass()
		cls.device = ensure_device("ApiTest Device PK", "WAD-TEST-API25", phone="+966500920005")
		ensure_settings(default_device=cls.device)
		cls.contact = ensure_contact(CONTACT, P3)

	@classmethod
	def tearDownClass(cls):
		cls._clean()
		delete_all("Contact", {"first_name": CONTACT})
		super().tearDownClass()

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

	@staticmethod
	def _clean():
		campaigns = frappe.get_all(
			"WhatsApp Campaign", filters={"campaign_name": ("like", "ApiTest Picker%")}, pluck="name"
		)
		if campaigns:
			delete_all("WhatsApp Queue Item", {"campaign": ("in", campaigns)})
			delete_all("WhatsApp Log", {"campaign": ("in", campaigns)})
			delete_all("WhatsApp Audit Log", {"reference_name": ("in", campaigns)})
			delete_all("WhatsApp Campaign", {"name": ("in", campaigns)})
		delete_all("WhatsApp Audit Log", {"reference_name": GROUP})
		delete_all("WhatsApp Contact Group", {"group_name": GROUP})
		for name in frappe.get_all("File", filters={"file_name": ("like", "apitest-picker%")}, pluck="name"):
			frappe.delete_doc("File", name, ignore_permissions=True, force=True)

	def _campaign(self):
		doc = frappe.get_doc(
			{
				"doctype": "WhatsApp Campaign",
				"campaign_name": CAMPAIGN,
				"device": self.device,
				"status": "Draft",
				"messages": [{"message_type": "Text", "body": "apitest picker"}],
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
		return doc.name

	# -- gates -------------------------------------------------------------------------

	def test_role_gates(self):
		campaign = self._campaign()
		rows = [{"phone": P2}]
		with as_user("_none"), self.assertRaises(WAPermissionError):
			api.list_sources()
		with as_user("WhatsApp Viewer"), self.assertRaises(WAPermissionError):
			api.search_groups(txt="ApiTest")
		with as_user("WhatsApp Contact User"):
			self.assertTrue(api.list_sources(target_doctype="WhatsApp Contact Group"))
			self.assertEqual(api.search_groups(txt="ApiTest Picker")["rows"][0]["name"], GROUP)
			# CU may write groups but not campaigns
			self.assertIn(
				"available",
				api.preview(target_doctype="WhatsApp Contact Group", target_name=GROUP, rows=rows),
			)
			with self.assertRaises(WAPermissionError):
				api.preview(target_doctype="WhatsApp Campaign", target_name=campaign, rows=rows)
			with self.assertRaises(WAPermissionError):
				api.commit_add(target_doctype="WhatsApp Campaign", target_name=campaign, rows=rows)
		with as_user("WhatsApp Viewer"), self.assertRaises(WAPermissionError):
			api.preview(target_doctype="WhatsApp Contact Group", target_name=GROUP, rows=rows)
		with as_user("WhatsApp Agent"), self.assertRaises(WAPermissionError):
			api.commit_remove(target_doctype="WhatsApp Campaign", target_name=campaign, phone_e164s=[P1])
		with as_user("WhatsApp Manager"):
			self.assertIn(
				"available", api.preview(target_doctype="WhatsApp Campaign", target_name=campaign, rows=rows)
			)
			with self.assertRaises(WAValidationError):
				api.preview(target_doctype="User", target_name="Administrator", rows=rows)
			with self.assertRaises(WAValidationError):
				api.preview(target_doctype="WhatsApp Campaign", target_name="no-such-ApiTest", rows=rows)

	# -- sources -----------------------------------------------------------------------

	def test_sources_groups_contacts_manual(self):
		with as_user("WhatsApp Agent"):
			keys = [s["key"] for s in api.list_sources(target_doctype="WhatsApp Campaign")]
			self.assertEqual(keys, ["Contact Group", "Contact", "DocType", "Excel", "vCard", "Manual"])
			groups = api.search_groups(txt="ApiTest Picker", kind="Marketing")
			self.assertEqual((groups["total"], groups["rows"][0]["member_count"]), (1, 1))
			self.assertEqual(api.search_groups(txt="ApiTest Picker", exclude=GROUP)["total"], 0)
			members = api.get_group_members(group=GROUP)
			self.assertEqual(
				(members["total"], members["rows"][0]["phone_e164"], members["rows"][0]["source_name"]),
				(1, P1, GROUP),
			)
			manual = api.parse_manual(text="0500920502\nAli;0500920503\nabc")
			self.assertEqual([r["phone_e164"] for r in manual["rows"]], [P2, P3])
			self.assertEqual((len(manual["invalid"]), manual["total"]), (1, 3))
		with as_user("WhatsApp Contact User"):
			found = api.search_contacts(txt=CONTACT)
			self.assertEqual(found["total"], len(found["rows"]))
			hit = next(r for r in found["rows"] if r["contact"] == self.contact)
			self.assertEqual((hit["phone_e164"], hit["source_type"], hit["valid"]), (P3, "Contact", True))
			with self.assertRaises(WAValidationError):
				api.search_contacts(txt=CONTACT, link_doctype="User")

	def test_list_doctype_rows(self):
		frappe.db.set_value("Contact", self.contact, "mobile_no", P3)
		settings = ensure_settings()
		previous = [
			{
				k: r.get(k)
				for k in (
					"document_type",
					"label",
					"phone_source",
					"phone_fieldname",
					"contact_fieldname",
					"name_fieldname",
					"filters_json",
					"enabled",
				)
			}
			for r in settings.get("picker_sources") or []
		]
		settings.set("picker_sources", [])
		settings.append(
			"picker_sources",
			{
				"document_type": "Contact",
				"phone_source": "Field",
				"phone_fieldname": "mobile_no",
				"name_fieldname": "full_name",
				"enabled": 1,
			},
		)
		settings.save(ignore_permissions=True)
		try:
			with as_user("WhatsApp Contact User"):
				self.assertTrue(next(s for s in api.list_sources() if s["key"] == "DocType")["enabled"])
				res = api.list_doctype_rows(
					document_type="Contact", filters='[["first_name", "like", "ApiTest Picker%"]]'
				)
				self.assertEqual([r["source_name"] for r in res["rows"]], [self.contact])
				self.assertEqual(
					(res["rows"][0]["phone_e164"], res["rows"][0]["source_doctype"]), (P3, "Contact")
				)
				with self.assertRaises(WAValidationError):
					api.list_doctype_rows(document_type="Contact", filters=[["nope", "=", 1]])
				with self.assertRaises(WAPermissionError):
					api.list_doctype_rows(document_type="User")
		finally:
			settings = ensure_settings()
			settings.set("picker_sources", [])
			for row in previous:
				settings.append("picker_sources", row)
			settings.save(ignore_permissions=True)

	def test_parse_upload(self):
		out = io.StringIO()
		w = csv.writer(out)
		w.writerow(["Name", "Phone"])
		w.writerow(["Sara", "0500920502"])
		w.writerow(["Bad", "abc"])
		with as_user("WhatsApp Manager"):
			url = attachments.save_private_file(out.getvalue().encode("utf-8-sig"), "apitest-picker.csv")
			res = api.parse_upload(file_url=url, kind="csv")
			self.assertEqual((res["columns"], res["total"], len(res["invalid"])), (["Name", "Phone"], 2, 1))
			self.assertEqual((res["rows"][0]["phone_e164"], res["rows"][0]["display_name"]), (P2, "Sara"))
			with self.assertRaises(WAValidationError):
				api.parse_upload(file_url=url, kind="pdf")
		with as_user("WhatsApp Agent"), self.assertRaises(frappe.PermissionError):
			api.parse_upload(file_url=url, kind="csv")  # not the owner

	# -- targets -----------------------------------------------------------------------

	def test_preview_and_commit_group(self):
		rows = [
			{"phone": P1},
			{"phone": "0500920502", "display_name": "Two"},
			{"phone": P2},
			{"phone": "zzz"},
		]
		with as_user("WhatsApp Contact User"):
			p = api.preview(target_doctype="WhatsApp Contact Group", target_name=GROUP, rows=rows)
			self.assertEqual(
				(
					[r["phone_e164"] for r in p["available"]],
					[r["phone_e164"] for r in p["already_added"]],
					len(p["invalid"]),
					len(p["duplicates_in_selection"]),
					p["known_count"],
				),
				([P2], [P1], 1, 1, 0),
			)
			res = api.commit_add(
				target_doctype="WhatsApp Contact Group", target_name=GROUP, rows=rows, source_type="Manual"
			)
			self.assertEqual(res, {"added": 1, "skipped_duplicates": 2, "skipped_invalid": 1})
			self.assertEqual(
				[m.phone_e164 for m in frappe.get_doc("WhatsApp Contact Group", GROUP).members], [P1, P2]
			)
			with self.assertRaises(WAValidationError):
				api.commit_add(
					target_doctype="WhatsApp Contact Group", target_name=GROUP, rows=rows, source_type="Nope"
				)
			self.assertEqual(
				api.commit_remove(
					target_doctype="WhatsApp Contact Group", target_name=GROUP, phone_e164s=["0500920501"]
				),
				{"removed": 1},
			)
			self.assertEqual(
				api.commit_remove(
					target_doctype="WhatsApp Contact Group",
					target_name=GROUP,
					filters={"source_type": "Manual"},
				),
				{"removed": 1},
			)
		self.assertEqual(
			frappe.db.count(
				"WhatsApp Audit Log", {"action": "Contact Group Members Changed", "reference_name": GROUP}
			),
			3,
		)

	def test_commit_campaign(self):
		campaign = self._campaign()
		with as_user("WhatsApp Manager"):
			res = api.commit_add(
				target_doctype="WhatsApp Campaign",
				target_name=campaign,
				rows=[{"phone": P2, "display_name": "Two"}, {"phone": P1}],
				source_type="Contact Group",
				source_ref=GROUP,
			)
			self.assertEqual(res, {"added": 1, "skipped_duplicates": 1, "skipped_invalid": 0})
			rec = frappe.db.get_value(
				"WhatsApp Campaign Recipient",
				{"parent": campaign, "phone_e164": P2},
				["status", "contact_group", "source_type", "added_by"],
				as_dict=True,
			)
			self.assertEqual(
				(rec.status, rec.contact_group, rec.source_type, rec.added_by),
				("Pending", GROUP, "Contact Group", frappe.session.user),
			)
			self.assertEqual(
				api.commit_remove(
					target_doctype="WhatsApp Campaign",
					target_name=campaign,
					filters={"source_type": "Contact Group", "source_ref": GROUP},
				),
				{"removed": 1},
			)
			self.assertEqual(frappe.db.count("WhatsApp Campaign Recipient", {"parent": campaign}), 1)
		self.assertEqual(
			frappe.db.count(
				"WhatsApp Audit Log", {"action": "Campaign Recipients Changed", "reference_name": campaign}
			),
			2,
		)

# Tests for api/v1/numbers.py (build order B-22) and the service helpers it needed
# (`permissions.unlink_number`, `permissions.confirm_conversation`): role gates, get / search,
# link / convert / unlink / confirm with their audit rows, and the bulk `convert_many`.

from __future__ import annotations

import json
from unittest.mock import patch

import frappe
from frappe.tests import IntegrationTestCase

from whatsapp_next.api.v1 import numbers as api
from whatsapp_next.exceptions import WANotFoundError, WAPermissionError, WAValidationError
from whatsapp_next.services import permissions
from whatsapp_next.tests.conftest_frappe import as_user, delete_all, ensure_settings

PREFIX = "ApiTest Number"
N1, N2, N3 = "+966500930101", "+966500930102", "+966500930103"
GROUP = "120363000000930101@g.us"


def _audit(action: str, reference: str) -> list[dict]:
	return frappe.get_all(
		"WhatsApp Audit Log",
		filters={"action": action, "reference_name": reference},
		fields=["name", "details", "target_name", "fields_written"],
		order_by="creation asc",
	)


class TestApiNumbers(IntegrationTestCase):
	@classmethod
	def setUpClass(cls):
		super().setUpClass()
		ensure_settings()

	def setUp(self):
		self._clean()
		for key, display in ((N1, f"{PREFIX} Push"), (N2, None), (N3, None), (GROUP, "ApiTest Group")):
			frappe.get_doc({"doctype": "WhatsApp Number", "phone_e164": key, "display_name": display}).insert(
				ignore_permissions=True
			)

	def tearDown(self):
		self._clean()

	@staticmethod
	def _clean():
		delete_all("WhatsApp Audit Log", {"reference_name": ("in", [N1, N2, N3, GROUP])})
		delete_all("WhatsApp Number", {"name": ("in", [N1, N2, N3, GROUP])})
		delete_all("Contact", {"first_name": ("like", f"{PREFIX}%")})
		delete_all("Contact", {"first_name": ("in", [N2, N3])})

	def _contact(self) -> str:
		with as_user("System Manager"):
			return permissions.create_contact(
				{"first_name": f"{PREFIX} Linked", "phone_nos": [{"phone": N1}]}
			)

	def test_role_gate(self):
		with as_user("_none"), patch.object(frappe, "has_permission", return_value=False):
			with self.assertRaises(WAPermissionError):
				api.get_number(phone_e164=N1)
			with self.assertRaises(WAPermissionError):
				api.link_number(phone_e164=N1, contact="x")
			with self.assertRaises(WAPermissionError):
				api.convert_many(phone_e164s=[N1])
		with as_user("WhatsApp Agent"), self.assertRaises(WAPermissionError):
			api.unlink_number(phone_e164=N1)
		with as_user("WhatsApp Viewer"), self.assertRaises(WAPermissionError):
			api.confirm_conversation(phone_e164=N1, confirmed=True)
		with as_user("WhatsApp Viewer"):
			self.assertEqual(api.get_number(phone_e164=N1)["phone_e164"], N1)
		with as_user("WhatsApp Contact User"):
			self.assertEqual(api.search_numbers(txt="+96650093")["total"], 3)

	def test_get_and_search(self):
		contact = self._contact()
		with as_user("WhatsApp Contact User"):
			api.link_number(phone_e164=N1, contact=contact)
			row = api.get_number(phone_e164="0500930101")
			self.assertEqual((row["contact"], row["link_status"]), (contact, "Linked"))
			self.assertEqual(row["contact_summary"]["first_name"], f"{PREFIX} Linked")
			self.assertNotIn("owner", row["contact_summary"])
			with self.assertRaises(WANotFoundError):
				api.get_number(phone_e164="+966500939999")
		with as_user("WhatsApp Viewer"), patch.object(frappe, "has_permission", return_value=False):
			# a Viewer without Contact permission gets the row but no contact summary
			self.assertIsNone(api.get_number(phone_e164=N1)["contact_summary"])
		with as_user("WhatsApp Viewer"):
			res = api.search_numbers(txt="+96650093", link_status="Not Linked", page_length="1")
			self.assertEqual((res["total"], len(res["rows"])), (2, 1))
			self.assertEqual(set(res["rows"][0]), set(api.SEARCH_FIELDS))
			self.assertEqual(api.search_numbers(txt="ApiTest Group")["rows"][0]["name"], GROUP)
			with self.assertRaises(WAValidationError):
				api.search_numbers(link_status="Bogus")

	def test_link_convert_unlink_confirm(self):
		contact = self._contact()
		with as_user("WhatsApp Contact User"):
			self.assertEqual(
				api.link_number(phone_e164=N1, contact=contact), {"contact": contact, "link_status": "Linked"}
			)
			out = api.convert_number(phone_e164=N2, first_name=f"{PREFIX} Conv", last_name="X")
			self.assertEqual(out["link_status"], "Linked")
			self.assertEqual(frappe.db.get_value("WhatsApp Number", N2, "contact"), out["contact"])
		with as_user("WhatsApp Manager"):
			self.assertEqual(api.unlink_number(phone_e164=N1), {"link_status": "Not Linked"})
			row = frappe.db.get_value(
				"WhatsApp Number", N1, ["contact", "linked_by", "linked_at"], as_dict=True
			)
			self.assertEqual((row.contact, row.linked_by, row.linked_at), (None, None, None))
			self.assertTrue(frappe.db.exists("Contact", contact))  # the Contact is untouched
			rows = _audit("Number Linked", N1)
			self.assertEqual(len(rows), 2)
			self.assertEqual(json.loads(rows[-1].details)["unlinked"], 1)
			self.assertEqual(rows[-1].target_name, contact)
			with self.assertRaises(WANotFoundError):
				api.unlink_number(phone_e164="+966500939999")
		with as_user("WhatsApp Agent") as agent:
			self.assertEqual(
				api.confirm_conversation(phone_e164=N3, confirmed="1", note="ok"),
				{"conversation_confirmed": True},
			)
			row = frappe.db.get_value(
				"WhatsApp Number",
				N3,
				["conversation_confirmed", "conversation_confirmed_by", "conversation_note"],
				as_dict=True,
			)
			self.assertEqual(
				(row.conversation_confirmed, row.conversation_confirmed_by, row.conversation_note),
				(1, agent, "ok"),
			)
			self.assertEqual(
				api.confirm_conversation(phone_e164=N3, confirmed=False), {"conversation_confirmed": False}
			)
			self.assertIsNone(frappe.db.get_value("WhatsApp Number", N3, "conversation_confirmed_by"))
			self.assertEqual(len(_audit("Conversation Confirmed", N3)), 2)
		# 09 G-06: the history, newest first, readable by a Contact User, only the reader's columns
		with as_user("WhatsApp Contact User"):
			log = api.get_conversation_log(phone_e164=N3)["rows"]
		self.assertEqual([r["confirmed"] for r in log], [False, True])
		self.assertEqual(log[1]["note"], "ok")
		self.assertEqual(set(log[0]), {"at", "user", "user_name", "confirmed", "note"})
		# a site that removed role All's Contact rights (D-125): no Contact read, no history
		with as_user("_none"), patch.object(frappe, "has_permission", return_value=False):
			with self.assertRaises(WAPermissionError):
				api.get_conversation_log(phone_e164=N3)
		with as_user("WhatsApp Contact User"), self.assertRaises(WANotFoundError):
			api.get_conversation_log(phone_e164="+966500939999")

	def test_convert_many(self):
		contact = self._contact()
		with as_user("WhatsApp Contact User"):
			api.link_number(phone_e164=N1, contact=contact)
			res = api.convert_many(phone_e164s=[N1, N2, N3, GROUP, "+966500939999"])
		self.assertEqual((res["count"], res["done"]), (2, [N2, N3]))
		self.assertEqual({s["name"] for s in res["skipped"]}, {N1, GROUP})
		self.assertEqual(res["failed"][0]["name"], "+966500939999")
		for key in (N2, N3):
			c = frappe.db.get_value("WhatsApp Number", key, "contact")
			self.assertEqual(
				frappe.db.get_value("Contact", c, "first_name"), key
			)  # no display name → the key

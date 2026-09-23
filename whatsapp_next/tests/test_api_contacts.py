# Tests for api/v1/contacts.py (build order B-22): contextual gate (Contact User passes, a user
# without roles does not), happy paths through the permissions service, argument coercion and
# the bulk `link_many`.

from __future__ import annotations

from unittest.mock import patch

import frappe
from frappe.tests import IntegrationTestCase

from whatsapp_next.api.v1 import contacts as api
from whatsapp_next.exceptions import WANotFoundError, WAPermissionError, WAValidationError
from whatsapp_next.tests.conftest_frappe import as_user, delete_all, ensure_settings

PREFIX = "ApiTest Contact"
P1, P2, P3 = "+966500930001", "+966500930002", "+966500930003"
BLACKLIST = "ApiTest Contacts Blacklist"


class TestApiContacts(IntegrationTestCase):
	@classmethod
	def setUpClass(cls):
		super().setUpClass()
		ensure_settings()
		cls._clean()
		if not frappe.db.exists("WhatsApp Contact Group", BLACKLIST):
			frappe.get_doc(
				{
					"doctype": "WhatsApp Contact Group",
					"group_name": BLACKLIST,
					"kind": "Blacklist",
					"source": "Manual",
				}
			).insert(ignore_permissions=True)
		ensure_settings(global_blacklist_group=BLACKLIST)
		cls.customer = frappe.get_all("Customer", limit=1, pluck="name")
		cls.customer = cls.customer[0] if cls.customer else None

	@classmethod
	def tearDownClass(cls):
		cls._clean()
		ensure_settings(global_blacklist_group=None)
		delete_all("WhatsApp Contact Group", {"group_name": BLACKLIST})
		super().tearDownClass()

	def setUp(self):
		self._clean()

	@staticmethod
	def _clean():
		delete_all("WhatsApp Number", {"phone_e164": ("in", [P1, P2, P3])})
		delete_all("Contact", {"first_name": ("like", f"{PREFIX}%")})

	def _seed(self) -> str:
		with as_user("System Manager"):
			name = api.create_contact(payload={"first_name": f"{PREFIX} A", "phone_nos": [{"phone": P1}]})[
				"name"
			]
		frappe.get_doc(
			{"doctype": "WhatsApp Number", "phone_e164": P1, "outbound_count": 2, "inbound_count": 1}
		).insert(ignore_permissions=True)
		return name

	def test_role_gate(self):
		# a user without the contextual role and without native Contact permission
		with as_user("_none"), patch.object(frappe, "has_permission", return_value=False):
			with self.assertRaises(WAPermissionError):
				api.list_contacts()
			with self.assertRaises(WAPermissionError):
				api.create_contact(payload={"first_name": "x"})
			with self.assertRaises(WAPermissionError):
				api.link_many(names=["x"], link_doctype="Customer", link_name="x")
		with as_user("WhatsApp Viewer"), self.assertRaises(WAPermissionError):
			api.toggle_blacklist(blocked=True, phone=P1)
		with as_user("WhatsApp Contact User"):
			self.assertIn("rows", api.list_contacts(search=PREFIX))

	def test_create_get_update_and_numbers(self):
		with as_user("WhatsApp Contact User"):
			name = api.create_contact(payload={"first_name": f"{PREFIX} One", "phone_nos": [{"phone": P2}]})[
				"name"
			]
			row = api.get_contact(name=name)
			self.assertEqual(row["first_name"], f"{PREFIX} One")
			self.assertEqual(row["numbers"], [P2])
			self.assertNotIn("owner", row)
			out = api.update_contact(name=name, payload={"designation": "CEO"})
			self.assertEqual(out, {"name": name, "fields_written": ["designation"]})
			self.assertEqual(frappe.db.get_value("Contact", name, "designation"), "CEO")
			with self.assertRaises(WANotFoundError):
				api.get_contact(name="no-such-contact")
			with self.assertRaises(WAValidationError):
				api.update_contact(name=name, payload={"owner": "x"})
			self.assertEqual(api.get_contact_numbers(contact=name), [])
		seeded = self._seed()
		with as_user("WhatsApp Contact User"):
			numbers = api.get_contact_numbers(contact=seeded)
			self.assertEqual((numbers[0]["phone_e164"], numbers[0]["outbound_count"]), (P1, 2))
			listed = api.list_contacts(search=PREFIX, has_whatsapp="1", page_length="999")
			self.assertEqual([r["name"] for r in listed["rows"]], [seeded])
			self.assertEqual(listed["page_length"], 200)

	def test_search_party_and_blacklist(self):
		name = self._seed()
		with as_user("WhatsApp Contact User"):
			rows = api.search_party(party_type="Customer", txt="", page_length=3)
			for r in rows:
				self.assertEqual(set(r), {"name", "title"})
			with self.assertRaises(WAValidationError):
				api.search_party(party_type="User")
			self.assertEqual(api.toggle_blacklist(blocked="1", contact=name), {"blocked": True})
			self.assertEqual(api.list_contacts(search=PREFIX, blacklisted=True)["rows"][0]["name"], name)
			self.assertEqual(api.toggle_blacklist(blocked=False, phone=P1), {"blocked": False})
			with self.assertRaises(WAValidationError):
				api.toggle_blacklist(blocked=True)

	def test_link_many(self):
		if not self.customer:
			self.skipTest("no Customer on this site")
		a = self._seed()
		with as_user("WhatsApp Contact User"):
			b = api.create_contact(payload={"first_name": f"{PREFIX} B"})["name"]
			res = api.link_many(
				names=[a, b, "no-such-contact"], link_doctype="Customer", link_name=self.customer
			)
		self.assertEqual((res["count"], res["done"]), (2, [a, b]))
		self.assertEqual(res["failed"][0]["name"], "no-such-contact")
		links = frappe.get_all(
			"Dynamic Link", filters={"parent": b, "link_doctype": "Customer"}, pluck="link_name"
		)
		self.assertEqual(links, [self.customer])
		with as_user("WhatsApp Contact User"):
			again = api.link_many(names=[a], link_doctype="Customer", link_name=self.customer)
		self.assertEqual((again["count"], again["skipped"][0]["name"]), (0, a))

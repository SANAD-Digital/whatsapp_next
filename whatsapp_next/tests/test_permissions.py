# Tests for services/permissions.py — the contextual permission layer (build order B-8, §9):
# elevation gate, declared field sets, query-level filters, audit of elevated reads/writes,
# picker source 3 filter validation and merge, number link/convert, blacklist toggle.

from __future__ import annotations

from unittest.mock import patch

import frappe
from frappe.tests import IntegrationTestCase

from whatsapp_next.exceptions import (
	WANotFoundError,
	WAPermissionError,
	WAStateConflictError,
	WAValidationError,
)
from whatsapp_next.services import permissions
from whatsapp_next.tests.conftest_frappe import as_user, delete_all, ensure_settings

PHONE_1 = "+966500000201"
PHONE_2 = "+966500000202"
PHONE_3 = "+966500000203"
PREFIX = "PermTest"
BLACKLIST = "PermTest Blacklist"


def _audit_rows(action: str) -> list[dict]:
	return frappe.get_all(
		"WhatsApp Audit Log",
		filters={"action": action},
		fields=["name", "user", "count", "fields_written", "details"],
		order_by="creation asc, name asc",
	)


class TestPermissions(IntegrationTestCase):
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

	@classmethod
	def tearDownClass(cls):
		cls._clean()
		ensure_settings(global_blacklist_group=None, picker_sources=[])
		delete_all("WhatsApp Contact Group", {"group_name": BLACKLIST})
		super().tearDownClass()

	def setUp(self):
		self._clean()

	@staticmethod
	def _clean():
		delete_all(
			"WhatsApp Audit Log",
			{
				"action": (
					"in",
					[
						"Elevated Contact Read",
						"Elevated Contact Write",
						"Number Linked",
						"Number Converted",
						"Contact Group Members Changed",
					],
				)
			},
		)
		delete_all("WhatsApp Number", {"phone_e164": ("in", [PHONE_1, PHONE_2, PHONE_3])})
		delete_all("Contact", {"first_name": ("like", f"{PREFIX}%")})
		if frappe.db.exists("WhatsApp Contact Group", BLACKLIST):
			g = frappe.get_doc("WhatsApp Contact Group", BLACKLIST)
			g.set("members", [])
			g.save(ignore_permissions=True)

	# -- elevation --------------------------------------------------------------------

	def test_can_elevate_role_or_native_permission(self):
		with as_user("WhatsApp Contact User"):
			self.assertTrue(permissions.can_elevate("read"))
			self.assertTrue(permissions.is_contact_user())
		with as_user("_none"), patch.object(frappe, "has_permission", return_value=False):
			self.assertFalse(permissions.can_elevate("read"))
			self.assertRaises(WAPermissionError, permissions.list_contacts)
			self.assertRaises(WAPermissionError, permissions.create_contact, {"first_name": "x"})
		self.assertFalse(permissions.can_elevate("read", user="Guest"))

	# -- create / update ---------------------------------------------------------------

	def test_create_rejects_unknown_keys_and_bad_rows(self):
		with as_user("WhatsApp Contact User"):
			self.assertRaises(WAValidationError, permissions.create_contact, {"first_name": "a", "user": "x"})
			self.assertRaises(
				WAValidationError,
				permissions.create_contact,
				{"first_name": "a", "phone_nos": [{"phone": "abc"}]},
			)
			self.assertRaises(
				WAValidationError,
				permissions.create_contact,
				{"first_name": "a", "phone_nos": [{"phone": PHONE_1, "parent": "x"}]},
			)
			self.assertRaises(
				WAValidationError,
				permissions.create_contact,
				{"first_name": "a", "links": [{"link_doctype": "User", "link_name": "Administrator"}]},
			)
			self.assertRaises(
				WAValidationError,
				permissions.create_contact,
				{"first_name": "a", "links": [{"link_doctype": "Customer", "link_name": "no-such-customer"}]},
			)
			self.assertRaises(WAValidationError, permissions.create_contact, {"last_name": "only"})
		self.assertEqual(_audit_rows("Elevated Contact Write"), [])

	def test_create_update_audit_and_field_sets(self):
		with as_user("WhatsApp Contact User") as cu:
			name = permissions.create_contact(
				{
					"first_name": f"{PREFIX} One",
					"email_id": "one@example.com",
					"phone_nos": [{"phone": "0500000201"}],
				}
			)
			doc = frappe.get_doc("Contact", name)
			self.assertEqual(doc.owner, cu)
			self.assertEqual(doc.phone_nos[0].wa_phone_e164, PHONE_1)
			self.assertEqual(doc.phone_nos[0].is_primary_mobile_no, 1)
			writes = _audit_rows("Elevated Contact Write")
			self.assertEqual(len(writes), 1)
			self.assertEqual(writes[0].user, cu)
			self.assertEqual(writes[0].fields_written, "email_id, first_name, phone_nos")

			permissions.update_contact(
				name,
				{
					"designation": "CEO",
					"phone_nos": [{"phone": PHONE_2}, {"phone": PHONE_3, "is_primary_mobile_no": 1}],
				},
			)
			doc = frappe.get_doc("Contact", name)
			self.assertEqual(doc.designation, "CEO")
			self.assertEqual({r.wa_phone_e164 for r in doc.phone_nos}, {PHONE_2, PHONE_3})
			self.assertEqual(permissions.contact_phones(name)[0], PHONE_3)
			self.assertEqual(
				_audit_rows("Elevated Contact Write")[-1].fields_written, "designation, phone_nos"
			)
			# no-op update writes nothing
			permissions.update_contact(name, {"designation": "CEO"})
			self.assertEqual(len(_audit_rows("Elevated Contact Write")), 2)
			self.assertRaises(
				WANotFoundError, permissions.update_contact, "no-such-contact", {"designation": "x"}
			)

	# -- reads -------------------------------------------------------------------------

	def _seed(self) -> tuple[str, str]:
		with as_user("System Manager"):
			a = permissions.create_contact(
				{"first_name": f"{PREFIX} Alpha", "phone_nos": [{"phone": PHONE_1}]}
			)
			b = permissions.create_contact(
				{"first_name": f"{PREFIX} Beta", "phone_nos": [{"phone": PHONE_2}]}
			)
		frappe.get_doc(
			{
				"doctype": "WhatsApp Number",
				"phone_e164": PHONE_1,
				"outbound_count": 3,
				"inbound_count": 1,
				"last_direction": "Inbound",
			}
		).insert(ignore_permissions=True)
		return a, b

	def test_list_contacts_filters_and_audit(self):
		a, b = self._seed()
		with as_user("WhatsApp Contact User") as cu:
			res = permissions.list_contacts(search=PREFIX)
			names = {r["name"] for r in res["rows"]}
			self.assertEqual(names, {a, b})
			self.assertEqual(res["total"], 2)
			row_a = next(r for r in res["rows"] if r["name"] == a)
			self.assertEqual(
				set(row_a)
				- {
					"phone_nos",
					"links",
					"has_whatsapp",
					"blacklisted",
					"last_seen",
					"last_direction",
					"outbound_count",
					"inbound_count",
					"conversation_confirmed",
				},
				set(permissions.CONTACT_READ_FIELDS),
			)
			self.assertEqual(
				(row_a["has_whatsapp"], row_a["outbound_count"], row_a["blacklisted"]), (1, 3, 0)
			)
			self.assertEqual(row_a["phone_nos"][0]["wa_phone_e164"], PHONE_1)
			# phone search hits through Contact Phone
			self.assertEqual({r["name"] for r in permissions.list_contacts(search="0500000202")["rows"]}, {b})
			# has_whatsapp filter is applied in the query
			self.assertEqual(
				{r["name"] for r in permissions.list_contacts(search=PREFIX, has_whatsapp=True)["rows"]}, {a}
			)
			self.assertEqual(
				{r["name"] for r in permissions.list_contacts(search=PREFIX, has_whatsapp=False)["rows"]}, {b}
			)
			# blacklist
			permissions.toggle_blacklist(PHONE_2, True, note="test")
			self.assertEqual(
				{r["name"] for r in permissions.list_contacts(search=PREFIX, blacklisted=True)["rows"]}, {b}
			)
			self.assertEqual(
				next(r for r in permissions.list_contacts(search=PREFIX)["rows"] if r["name"] == b)[
					"blacklisted"
				],
				1,
			)
			# ordering restricted to READ fields
			with self.assertRaises(WAValidationError):
				permissions.list_contacts(order_by="owner desc")
			with self.assertRaises(WAValidationError):
				permissions.list_contacts(link_doctype="User")
			# paging
			self.assertEqual(len(permissions.list_contacts(search=PREFIX, page=2, page_length=1)["rows"]), 1)
			reads = _audit_rows("Elevated Contact Read")
			self.assertTrue(reads and all(r.user == cu for r in reads))
		# a natively permitted user is not audited
		self._clean()
		self._seed()
		with as_user("System Manager"):
			permissions.list_contacts(search=PREFIX)
		self.assertEqual(_audit_rows("Elevated Contact Read"), [])

	def test_get_and_search_contacts(self):
		a, _b = self._seed()
		with as_user("WhatsApp Contact User"):
			row = permissions.get_contact(a)
			self.assertEqual(row["first_name"], f"{PREFIX} Alpha")
			self.assertNotIn("owner", row)
			self.assertRaises(WANotFoundError, permissions.get_contact, "no-such-contact")
			found = permissions.search_contacts(PREFIX)
			self.assertEqual({r["name"] for r in found}, {a, _b})
			self.assertEqual(set(found[0]) - {"phone_nos"}, set(permissions.CONTACT_SEARCH_FIELDS))
			self.assertEqual(len(_audit_rows("Elevated Contact Read")), 2)

	def test_search_party(self):
		with as_user("WhatsApp Contact User"):
			self.assertRaises(WAValidationError, permissions.search_party, "User", "a")
			rows = permissions.search_party("Customer", "", page_length=5)
			for r in rows:
				self.assertEqual(set(r), {"name", "title"})
			self.assertEqual(
				_audit_rows("Elevated Contact Read")[0].details
				and "party_type" in _audit_rows("Elevated Contact Read")[0].details,
				True,
			)

	# -- picker source 3 ---------------------------------------------------------------

	def test_validate_filters(self):
		meta = frappe.get_meta("Contact")
		self.assertEqual(
			permissions.validate_filters(meta, {"status": "Passive"}), [["status", "=", "Passive"]]
		)
		self.assertEqual(
			permissions.validate_filters(meta, [["Contact", "status", "!=", "Open"]]),
			[["status", "!=", "Open"]],
		)
		self.assertEqual(
			permissions.validate_filters(meta, '[["name","like","%a%"]]'), [["name", "like", "%a%"]]
		)
		self.assertRaises(ValueError, permissions.validate_filters, meta, [["nope", "=", 1]])
		self.assertRaises(ValueError, permissions.validate_filters, meta, [["status", "regexp", "x"]])
		self.assertRaises(ValueError, permissions.validate_filters, meta, [["status", "=", {"$gt": 1}]])
		self.assertRaises(ValueError, permissions.validate_filters, meta, "not json")

	def test_list_doctype_rows_merges_server_filters(self):
		a, b = self._seed()
		frappe.db.set_value("Contact", b, "status", "Open")  # default status is Passive
		frappe.db.set_value("Contact", b, "mobile_no", PHONE_2)
		frappe.db.set_value("Contact", a, "mobile_no", PHONE_1)
		settings = ensure_settings()
		settings.set("picker_sources", [])
		settings.append(
			"picker_sources",
			{
				"document_type": "Contact",
				"phone_source": "Field",
				"phone_fieldname": "mobile_no",
				"name_fieldname": "full_name",
				"enabled": 1,
				"filters_json": '[["status","=","Open"]]',
			},
		)
		settings.save(ignore_permissions=True)
		try:
			with as_user("WhatsApp Contact User"):
				res = permissions.list_doctype_rows("Contact", [["first_name", "like", f"{PREFIX}%"]])
				self.assertEqual([r["name"] for r in res["rows"]], [b])  # server filter removed `a`
				self.assertEqual(res["rows"][0]["phone_e164"], PHONE_2)
				self.assertEqual(set(res["rows"][0]), {"name", "label", "phone", "phone_e164", "contact"})
				# the client cannot widen the server filter
				res = permissions.list_doctype_rows(
					"Contact", [["status", "=", "Passive"], ["first_name", "like", f"{PREFIX}%"]]
				)
				self.assertEqual(res["rows"], [])
				self.assertRaises(
					WAValidationError, permissions.list_doctype_rows, "Contact", [["owner_x", "=", 1]]
				)
				self.assertRaises(
					WAValidationError, permissions.list_doctype_rows, "Contact", [["status", "regexp", "x"]]
				)
				self.assertRaises(WAPermissionError, permissions.list_doctype_rows, "User", [])
			# invalid server filters are rejected at Settings save
			settings.picker_sources[0].filters_json = '[["nope","=",1]]'
			self.assertRaises(WAValidationError, settings.save, ignore_permissions=True)
		finally:
			ensure_settings(picker_sources=[])

	# -- numbers / blacklist -----------------------------------------------------------

	def test_link_and_convert_number(self):
		a, _b = self._seed()
		frappe.get_doc({"doctype": "WhatsApp Number", "phone_e164": PHONE_3}).insert(ignore_permissions=True)
		with as_user("WhatsApp Contact User") as cu:
			self.assertRaises(WANotFoundError, permissions.link_number, "+966500009999", a)
			self.assertRaises(WANotFoundError, permissions.link_number, PHONE_1, "no-such-contact")
			permissions.link_number(PHONE_1, a)
			n = frappe.get_doc("WhatsApp Number", PHONE_1)
			self.assertEqual(
				(n.contact, n.link_status, n.linked_by, n.display_name), (a, "Linked", cu, f"{PREFIX} Alpha")
			)
			self.assertEqual(len(_audit_rows("Number Linked")), 1)
			self.assertRaises(WAStateConflictError, permissions.convert_number, PHONE_1, "x")
			contact = permissions.convert_number(PHONE_3, f"{PREFIX} Conv", "Last")
			doc = frappe.get_doc("Contact", contact)
			self.assertEqual(doc.phone_nos[0].wa_phone_e164, PHONE_3)
			self.assertEqual(frappe.db.get_value("WhatsApp Number", PHONE_3, "contact"), contact)
			self.assertEqual(permissions.resolve_contact_by_phone("00966500000203"), contact)
			self.assertEqual(len(_audit_rows("Number Converted")), 1)

	def test_toggle_blacklist(self):
		with as_user("WhatsApp Agent"):
			self.assertTrue(permissions.toggle_blacklist("0500000201", True, note="spam"))
			self.assertTrue(permissions.toggle_blacklist(PHONE_1, True))  # idempotent
			members = frappe.get_doc("WhatsApp Contact Group", BLACKLIST).members
			self.assertEqual([m.phone_e164 for m in members], [PHONE_1])
			self.assertEqual(members[0].note, "spam")
			self.assertFalse(permissions.toggle_blacklist(PHONE_1, False))
			self.assertEqual(frappe.get_doc("WhatsApp Contact Group", BLACKLIST).members, [])
			self.assertEqual(len(_audit_rows("Contact Group Members Changed")), 2)
			self.assertRaises(WAValidationError, permissions.toggle_blacklist, "abc", True)
		with as_user("WhatsApp Viewer"):
			self.assertRaises(WAPermissionError, permissions.toggle_blacklist, PHONE_1, True)

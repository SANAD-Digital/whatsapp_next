"""The owner's own numbers: the only phone numbers a test, a script or a demo may use (owner,
2026-11-12: «لا تعمل اي ارقام ابدا … حطها هي فقط»; a made-up Saudi number got the sending number
banned and reported). Tests that need more numbers repeat these.

The development site keeps real traffic with the same numbers, so the test run starts by
forgetting it (`before_tests`): the owner's word, 2026-11-12 — a development site's data does not
matter. The devices and the "send only to" list stay.
"""

import frappe

OWNER_TEST_NUMBERS = (
	"+967784499996",
	"+967777667663",
	"+967777999579",
	"+967775040850",
	"+967775675566",
	"+967782309999",
	"+967779972929",
)

# (doctype, field) rows that hold a conversation or a record about one of the numbers
NUMBER_ROWS = (
	("WhatsApp Queue Item", "phone_e164"),
	("WhatsApp Log", "phone_e164"),
	("WhatsApp Inbound Message", "phone_e164"),
	("WhatsApp Number Check", "phone_e164"),
	("WhatsApp Number", "name"),
	("WhatsApp Contact Group Member", "phone_e164"),
	("WhatsApp Campaign Recipient", "phone_e164"),
)


def clear_owner_numbers_history():
	"""`before_tests`: delete what the site holds about the owner's numbers, and do it again at the
	start of every test class of this app — the classes share the seven numbers, so what one class
	leaves (a blocked number, a contact, a Numbers row) must not reach the next. Test runs only."""
	if not (getattr(frappe, "in_test", False) or frappe.flags.in_test):
		return
	forget_owner_numbers()
	_forget_again_before_each_test_class()


def forget_owner_numbers():
	"""Delete every row about one of the owner's numbers and take them off contacts."""
	numbers = list(OWNER_TEST_NUMBERS)
	for doctype, field in NUMBER_ROWS:
		frappe.db.delete(doctype, {field: ("in", numbers)})
	_drop_numbers_from_contacts(numbers)
	frappe.db.commit()


def _forget_again_before_each_test_class():
	from frappe.tests import IntegrationTestCase

	original = IntegrationTestCase.setUpClass.__func__
	if getattr(original, "forgets_owner_numbers", False):
		return

	def setUpClass(cls):
		if cls.__module__.startswith("whatsapp_next."):
			forget_owner_numbers()
		original(cls)

	setUpClass.forgets_owner_numbers = True
	IntegrationTestCase.setUpClass = classmethod(setUpClass)


def _drop_numbers_from_contacts(numbers):
	"""A contact found by one of the numbers would answer for the test's own contact."""
	from whatsapp_next.services.phone import normalize_phone_to_e164

	wanted = set(numbers)
	for row in frappe.get_all("Contact Phone", fields=["name", "parent", "phone"]):
		if normalize_phone_to_e164(row.phone) in wanted:
			frappe.db.delete("Contact Phone", {"name": row.name})
			for field in ("mobile_no", "phone"):
				if normalize_phone_to_e164(frappe.db.get_value("Contact", row.parent, field) or "") in wanted:
					frappe.db.set_value("Contact", row.parent, field, None, update_modified=False)

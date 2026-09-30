# Tests for `services/numbers_sync.py`: a device's address book into `WhatsApp Number` —
# update what is here, add what is not, link what a system contact already carries.

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import patch

import frappe
from frappe.tests import IntegrationTestCase

from whatsapp_next.providers.schemas import ProviderContact, ProviderGroup
from whatsapp_next.services import numbers_materializer as nm
from whatsapp_next.services import numbers_sync
from whatsapp_next.services.guards import status_writer
from whatsapp_next.tests.conftest_frappe import delete_all, ensure_contact, ensure_device

K_HERE, K_NEW, K_SYSTEM, K_LINKED = "+966500000801", "+966500000802", "+966500000803", "+966500000804"
LID = "123456789012399@lid"
GROUP = "120363000000000099@g.us"
KEYS = (K_HERE, K_NEW, K_SYSTEM, K_LINKED, LID, GROUP)


def _phone_book():
	return [
		ProviderContact(jid="966500000801@s.whatsapp.net", phone_e164=K_HERE, name="Saved Here"),
		ProviderContact(jid="966500000802@s.whatsapp.net", phone_e164=K_NEW, name="Saved New"),
		ProviderContact(jid="966500000803@s.whatsapp.net", phone_e164=K_SYSTEM, name="Saved System"),
		ProviderContact(jid="966500000804@s.whatsapp.net", phone_e164=K_LINKED, name="Saved Linked"),
		ProviderContact(jid=LID, phone_e164=None, name="Hidden Number"),
		ProviderContact(jid="120363000000000098@g.us", phone_e164=None, name="A Group"),
	]


class TestNumbersSync(IntegrationTestCase):
	@classmethod
	def setUpClass(cls):
		super().setUpClass()
		cls.device = ensure_device("NumSync Device", "WAD-TEST-NS01")
		cls.system = ensure_contact("NumSync System", K_SYSTEM)
		cls.linked = ensure_contact("NumSync Linked", "+966500000899")

	@classmethod
	def tearDownClass(cls):
		cls._clean()
		delete_all("Contact", {"first_name": ("in", ["NumSync System", "NumSync Linked"])})
		super().tearDownClass()

	@classmethod
	def _clean(cls):
		delete_all("WhatsApp Number", {"name": ("in", KEYS)})
		delete_all("WhatsApp Audit Log", {"action": "Numbers Synced", "reference_name": cls.device})

	def setUp(self):
		self._clean()
		with status_writer():
			for key, contact, name in (
				(K_HERE, None, "Push Name"),
				(K_LINKED, self.linked, "NumSync Linked"),
			):
				frappe.get_doc(
					{
						"doctype": "WhatsApp Number",
						"phone_e164": key,
						"number_type": "Individual",
						"display_name": name,
						"contact": contact,
						"link_status": "Linked" if contact else "Not Linked",
						"inbound_count": 2,
					}
				).insert(ignore_permissions=True)

	def _sync(self):
		provider = SimpleNamespace(
			list_device_contacts=lambda platform_device: _phone_book(),
			list_device_groups=lambda platform_device: [
				ProviderGroup(jid=GROUP, name="Team Group", participants_count=4)
			],
		)
		with patch.object(numbers_sync.registry, "get_provider", return_value=provider):
			return numbers_sync.sync_device_contacts(self.device, user="Administrator")

	def _row(self, key):
		return frappe.db.get_value(
			"WhatsApp Number",
			key,
			[
				"display_name",
				"saved_name",
				"synced_device",
				"contact",
				"link_status",
				"number_type",
				"inbound_count",
			],
			as_dict=True,
		)

	def test_updates_adds_and_links(self):
		stats = self._sync()
		# 6 address-book entries (one of them a group, which is not a contact) and 1 device group
		self.assertEqual(
			(
				stats["fetched"],
				stats["added"],
				stats["updated"],
				stats["linked"],
				stats["invalid"],
				stats["groups"],
			),
			(6, 4, 2, 1, 1, 1),
		)
		here = self._row(K_HERE)  # was here, unlinked: takes the saved name, keeps its messages
		self.assertEqual(
			(here.display_name, here.saved_name, here.inbound_count), ("Saved Here", "Saved Here", 2)
		)
		self.assertEqual(here.synced_device, self.device)
		new = self._row(K_NEW)  # was not here: added, not linked
		self.assertEqual(
			(new.display_name, new.link_status, new.number_type), ("Saved New", "Not Linked", "Individual")
		)
		system = self._row(K_SYSTEM)  # a system contact carries it: linked, named after the contact
		self.assertEqual((system.contact, system.link_status), (self.system, "Linked"))
		self.assertEqual(system.display_name, "NumSync System")
		linked = self._row(K_LINKED)  # already linked: keeps its contact and its contact's name
		self.assertEqual(
			(linked.contact, linked.display_name, linked.saved_name),
			(self.linked, "NumSync Linked", "Saved Linked"),
		)
		self.assertEqual(self._row(LID).number_type, "LID")
		group = self._row(GROUP)  # the device's groups come in as Group rows, named after their subject
		self.assertEqual(
			(group.number_type, group.display_name, group.synced_device), ("Group", "Team Group", self.device)
		)
		self.assertTrue(
			frappe.db.exists(
				"WhatsApp Audit Log", {"action": "Numbers Synced", "reference_name": self.device}
			)
		)
		# a second pass changes nothing it already wrote
		again = self._sync()
		self.assertEqual((again["added"], again["updated"], again["linked"]), (0, 0, 0))

	def test_message_refresh_keeps_the_saved_name(self):
		"""The materializer used to overwrite an unlinked number's name with the push name."""
		self._sync()
		nm.refresh_keys([K_HERE, K_NEW])
		self.assertEqual(self._row(K_HERE).display_name, "Saved Here")
		self.assertEqual(self._row(K_NEW).display_name, "Saved New")

	def test_a_group_links_to_a_contact_and_keeps_its_name(self):
		"""A group can belong to a contact (a customer's chat); it keeps its own subject as its name."""
		from whatsapp_next.services import permissions

		self._sync()
		permissions.link_number(GROUP, self.linked, user="Administrator")
		group = self._row(GROUP)
		self.assertEqual(
			(group.contact, group.link_status, group.display_name), (self.linked, "Linked", "Team Group")
		)
		nm.refresh_keys([GROUP])
		self.assertEqual(self._row(GROUP).display_name, "Team Group")

	def test_linking_needs_the_contact_permission(self):
		with patch.object(numbers_sync.permissions, "link_number", side_effect=frappe.PermissionError):
			stats = self._sync()
		self.assertEqual((stats["linked"], stats["link_skipped"]), (0, 1))
		self.assertEqual(self._row(K_SYSTEM).link_status, "Not Linked")

# Tests for services/hub.py (owner, 2026-10-29): the WhatsApp hub on this site — what is not
# installed, installed or has an update; installing a command, and an alert arriving switched off;
# updating the copy installed before; a function (code) only by a System Manager.

from __future__ import annotations

import frappe
from frappe.tests import IntegrationTestCase

from whatsapp_next.exceptions import WAPermissionError
from whatsapp_next.services import hub
from whatsapp_next.tests import function_fixtures as ff
from whatsapp_next.tests.conftest_frappe import as_user, fake_provider
from whatsapp_next.tests.fake_provider import FakeProvider

CODE = "hubtest"


class HubProvider(FakeProvider):
	def __init__(self, *args, **kwargs):
		super().__init__(*args, **kwargs)
		self.checksum = "c1"
		self.text = "first"
		self.function = None

	def _entries(self):
		return {
			"HUB-CMD-1": {
				"name": "HUB-CMD-1", "hub_name": "Hub test command", "hub_type": "Command", "description": "d",
				"checksum": self.checksum, "modified": "2026-10-29 12:00:00",
				"payload": {"name": CODE, "code": CODE, "title": self.text, "enabled": 1, "function": self.function},
			},
			"HUB-FN-1": {
				"name": "HUB-FN-1", "hub_name": "Hub test function", "hub_type": "Function", "description": "",
				"checksum": "f1", "modified": "2026-10-29 12:00:00",
				"payload": {"server_script": "wa_fn_hubtest", "script": "# nothing"},
			},
		}

	def list_hub(self, hub_type=None, txt=None):
		return [{k: v for k, v in e.items() if k != "payload"} for e in self._entries().values() if e["hub_type"] == hub_type]

	def get_hub_entry(self, name):
		return dict(self._entries()[name])


class TestHub(IntegrationTestCase):
	def tearDown(self):
		frappe.set_user("Administrator")
		frappe.db.delete("WhatsApp Command", {"hub_entry": "HUB-CMD-1"})

	def test_states_install_and_update(self):
		provider = HubProvider()
		provider.function = ff.ensure_function(next(iter(ff.FUNCTIONS)))
		with fake_provider(provider), as_user("WhatsApp Manager"):
			(row,) = hub.entries("Command")
			self.assertEqual((row["state"], row["local"]), ("not_installed", None))
			# the details view names each field by its label, not its fieldname
			self.assertEqual(hub.entry("HUB-CMD-1")["labels"]["code"], frappe.get_meta("WhatsApp Command").get_label("code"))
			out = hub.install("HUB-CMD-1")
			self.assertTrue(out["created"])
			self.assertEqual(hub.entries("Command")[0]["state"], "installed")
			provider.checksum, provider.text = "c2", "second"
			self.assertEqual(hub.entries("Command")[0]["state"], "update_available")
			again = hub.install("HUB-CMD-1")
		self.assertFalse(again["created"])
		self.assertEqual(again["name"], out["name"])
		row = frappe.db.get_value("WhatsApp Command", out["name"], ["title", "hub_checksum"], as_dict=True)
		self.assertEqual((row.title, row.hub_checksum), ("second", "c2"))
		self.assertTrue(frappe.db.exists("WhatsApp Audit Log", {"action": "Hub Entry Installed"}))

	def test_a_function_is_for_a_system_manager(self):
		with fake_provider(HubProvider()), as_user("WhatsApp Manager"):
			with self.assertRaises(WAPermissionError):
				hub.install("HUB-FN-1")
		self.assertFalse(frappe.db.exists("Server Script", "wa_fn_hubtest"))

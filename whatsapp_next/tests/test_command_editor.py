# Tests for the command editor (D-132): the per-party-type black / white lists and disabled inputs
# (controller validation and router enforcement), the editor read, the save that keeps an Active
# command Active, the draft preview (nothing saved, nothing sent) and delete.

from __future__ import annotations

from unittest.mock import patch

import frappe
from frappe.tests import IntegrationTestCase

from whatsapp_next.api.v1 import commands as api
from whatsapp_next.exceptions import WAPermissionError, WAStateConflictError, WAValidationError
from whatsapp_next.functions.context import Sender
from whatsapp_next.services import command_router as cr
from whatsapp_next.services import functions_catalog as fc
from whatsapp_next.tests.conftest_frappe import (
	as_user,
	delete_all,
	ensure_contact,
	ensure_device,
	ensure_settings,
)

SERVICE_USER = "wa-test-edsvc@example.com"
CODE = "edtestping"
PHONE = "+966500930501"
GROUP = "EdTest Group"
CUSTOMER = "EdTest Customer"


def _service_user() -> str:
	if not frappe.db.exists("User", SERVICE_USER):
		u = frappe.get_doc(
			{
				"doctype": "User",
				"email": SERVICE_USER,
				"first_name": "WA Editor Svc",
				"user_type": "System User",
				"enabled": 1,
				"send_welcome_email": 0,
			}
		)
		u.flags.no_welcome_mail = True
		u.insert(ignore_permissions=True)
		frappe.db.delete("Has Role", {"parent": SERVICE_USER, "parenttype": "User"})
	frappe.clear_cache(user=SERVICE_USER)
	return SERVICE_USER


class TestCommandEditor(IntegrationTestCase):
	@classmethod
	def setUpClass(cls):
		super().setUpClass()
		ensure_settings(enable_commands=1, command_service_user=_service_user(), send_receipt_reply=0)
		fc.clear_cache()
		if not frappe.db.exists("WhatsApp Function", "ping"):
			fc.install("ping")
		cls.customer = cls._customer()
		cls.contact = ensure_contact("EdTest Contact", PHONE)
		if cls.customer:
			c = frappe.get_doc("Contact", cls.contact)
			if not any(link.link_doctype == "Customer" for link in c.links):
				c.append("links", {"link_doctype": "Customer", "link_name": cls.customer})
				c.save(ignore_permissions=True)
		if not frappe.db.exists("WhatsApp Contact Group", GROUP):
			frappe.get_doc(
				{
					"doctype": "WhatsApp Contact Group",
					"group_name": GROUP,
					"kind": "Other",
					"source": "Manual",
				}
			).insert(ignore_permissions=True)

	@staticmethod
	def _customer() -> str | None:
		"""A Customer to link the test contact to — the site's own, else one this module creates."""
		existing = frappe.get_all("Customer", limit=1, pluck="name")
		if existing:
			return existing[0]
		if not frappe.db.exists("DocType", "Customer"):
			return None
		return (
			frappe.get_doc({"doctype": "Customer", "customer_name": CUSTOMER, "customer_type": "Individual"})
			.insert(ignore_permissions=True)
			.name
		)

	@classmethod
	def tearDownClass(cls):
		cls._clean()
		delete_all("WhatsApp Contact Group", {"group_name": GROUP})
		delete_all("Contact", {"first_name": "EdTest Contact"})
		delete_all("Customer", {"customer_name": CUSTOMER})
		super().tearDownClass()

	def setUp(self):
		self._clean()

	@staticmethod
	def _clean():
		delete_all("WhatsApp Inbound Message", {"phone_e164": PHONE})
		delete_all("WhatsApp Command", {"code": ("like", "edtest%")})
		delete_all(
			"WhatsApp Audit Log",
			{"reference_doctype": "WhatsApp Command", "reference_name": ("like", "edtest%")},
		)
		cr.clear_map()

	def _save(self, **payload) -> str:
		base = {
			"code": CODE,
			"function": "ping",
			"allowed_party_types": ["Customer"],
			"requires_linked_contact": 0,
		}
		with as_user("WhatsApp Manager"):
			return api.save_editor(payload={**base, **payload})["name"]

	def _sender(self) -> Sender:
		return Sender(
			phone_e164=PHONE,
			jid=None,
			display_name="EdTest",
			contact=self.contact,
			party_type="Customer",
			party_name=self.customer,
		)

	def _inbound(self):
		return frappe._dict(phone_e164=PHONE, contact=self.contact, message_type="Text", body=f"#{CODE}")

	# -- model ---------------------------------------------------------------------------

	def test_access_rows_are_validated(self):
		name = self._save()
		doc = frappe.get_doc("WhatsApp Command", name)
		doc.append("access_entries", {"party_type": "Supplier", "contact": self.contact})
		with self.assertRaises(WAValidationError):  # type not allowed for the command
			doc.save(ignore_permissions=True)
		doc.reload()
		doc.append("access_entries", {"party_type": "Customer"})
		with self.assertRaises(WAValidationError):  # neither group nor contact
			doc.save(ignore_permissions=True)
		with as_user("WhatsApp Manager"), self.assertRaises(WAValidationError):
			api.save_editor(payload={"name": name, "access": {"Customer": {"mode": "Maybe"}}})
		# narrowing the allowed types drops the other types' rows
		self._save(
			name=name, allowed_party_types=["Customer", "Supplier"], access={"Supplier": {"mode": "Deny All"}}
		)
		self._save(name=name, allowed_party_types=["Customer"])
		self.assertEqual(frappe.get_doc("WhatsApp Command", name).access_modes, [])

	# -- router --------------------------------------------------------------------------

	def test_router_lists_and_unlinked_senders(self):
		if not self.customer:
			self.skipTest("no Customer on this site")
		name = self._save(status="Active")
		cmd = frappe.get_doc("WhatsApp Command", name)
		self.assertIsNone(cr.check_access(cmd, self._inbound(), self._sender()))
		# Allow All + the contact listed → Blacklist
		self._save(name=name, access={"Customer": {"mode": "Allow All", "contacts": [self.contact]}})
		cmd = frappe.get_doc("WhatsApp Command", name)
		self.assertEqual(cr.check_access(cmd, self._inbound(), self._sender()), "Blacklist")
		# Deny All + not listed → Not Allowed; listed through a group → allowed
		self._save(name=name, access={"Customer": {"mode": "Deny All", "groups": [GROUP]}})
		cmd = frappe.get_doc("WhatsApp Command", name)
		self.assertEqual(cr.check_access(cmd, self._inbound(), self._sender()), "Not Allowed")
		g = frappe.get_doc("WhatsApp Contact Group", GROUP)
		g.append("members", {"phone": PHONE, "source_type": "Manual"})
		g.save(ignore_permissions=True)
		self.assertIsNone(cr.check_access(cmd, self._inbound(), self._sender()))
		# an unlinked number passes the type check unless the command requires a linked contact
		stranger = Sender(phone_e164="+966500930599", jid=None, display_name=None, contact=None)
		self.assertIsNone(cr.check_access(cmd, frappe._dict(message_type="Text"), stranger))
		self._save(name=name, requires_linked_contact=1)
		cmd = frappe.get_doc("WhatsApp Command", name)
		self.assertEqual(cr.check_access(cmd, frappe._dict(message_type="Text"), stranger), "Not Linked")

	def test_disabled_inputs_are_not_read(self):
		name = self._save(disabled_inputs=["text"])
		cmd = frappe.get_doc("WhatsApp Command", name)
		self.assertEqual(cmd.disabled_inputs, "text")
		self.assertEqual(cr.parse_args(cmd, "hello there"), {})

	# -- editor API ----------------------------------------------------------------------

	def test_editor_read_and_role_gate(self):
		with as_user("WhatsApp Viewer"), self.assertRaises(WAPermissionError):
			api.get_editor()
		with as_user("WhatsApp Manager"):
			empty = api.get_editor()
			self.assertIsNone(empty["command"]["name"])
			self.assertIn("Customer", [p["key"] for p in empty["party_types"]])
			self.assertIn("ping", [f["name"] for f in empty["functions"]])
			spec = api.get_function_spec(function="ping")
			self.assertEqual((spec["inputs"][0]["key"], spec["inputs"][0]["rest"]), ("text", True))
			self.assertIn("ping", spec["suggested_commands"])
		name = self._save(
			synonyms="edtestping2", access={"Customer": {"mode": "Deny All", "contacts": [self.contact]}}
		)
		with as_user("WhatsApp Manager"):
			out = api.get_editor(name=name)
		cmd = out["command"]
		self.assertEqual((cmd["synonyms"], cmd["allowed_party_types"]), (["edtestping2"], ["Customer"]))
		self.assertEqual(cmd["access"]["Customer"]["mode"], "Deny All")
		self.assertEqual(cmd["access"]["Customer"]["contacts"][0]["label"], "EdTest Contact")
		self.assertEqual(out["function"]["name"], "ping")

	def test_save_keeps_an_active_command_active(self):
		name = self._save(status="Active")
		self.assertEqual(frappe.db.get_value("WhatsApp Command", name, "status"), "Active")
		with as_user("WhatsApp Manager"):
			out = api.save_editor(payload={"name": name, "synonyms": "edtestpong"})
			self.assertEqual(out["status"], "Active")
			self.assertEqual(frappe.db.get_value("WhatsApp Command", name, "synonyms"), "edtestpong")
			self.assertEqual(cr.command_map(refresh=True).get("edtestpong"), name)
			self.assertEqual(
				api.save_editor(payload={"name": name, "status": "Inactive"})["status"], "Inactive"
			)
			with self.assertRaises(WAValidationError):
				api.save_editor(payload={"name": name, "status": "Paused"})
			with self.assertRaises(WAValidationError):
				api.save_editor(payload={"name": name, "owner": "x"})

	def test_preview_is_dry(self):
		before = frappe.db.count("WhatsApp Log")
		payload = {
			"code": CODE,
			"function": "ping",
			"allowed_party_types": ["Customer"],
			"requires_linked_contact": 0,
		}
		with as_user("WhatsApp Manager"):
			frappe.session.sid, frappe.session.data = "edtest-sid", frappe._dict(marker=1)
			out = api.preview_command(
				payload=payload, sender={"phone": PHONE}, values={"text": "hello there"}
			)
			# running the handler as the service user leaves the caller's web session intact
			self.assertEqual((frappe.session.sid, frappe.session.data.get("marker")), ("edtest-sid", 1))
			self.assertEqual(
				(out["status"], out["text"], out["args"]),
				("Executed", f"{CODE} hello there", {"text": "hello there"}),
			)
			self.assertTrue(out["replies"][0]["body"].startswith("pong: hello there"))
			self.assertFalse(frappe.db.exists("WhatsApp Command", CODE))
			# a draft that requires a linked contact blocks the unlinked sender
			out = api.preview_command(
				payload={**payload, "requires_linked_contact": 1}, sender={"phone": PHONE}
			)
			self.assertEqual((out["status"], out["block_reason"]), ("Blocked", "Not Linked"))

			# a step that fails with frappe.throw reports in the result, without a queued desk message
			def refuse(*_a, **_k):
				frappe.throw("edtest missing", WAValidationError)

			queued = len(frappe.local.message_log or [])
			with patch.object(cr, "parse_args", side_effect=refuse):
				out = api.preview_command(payload=payload, sender={"phone": PHONE})
			self.assertEqual((out["status"], out["error"]), ("Failed", "edtest missing"))
			self.assertEqual(len(frappe.local.message_log or []), queued)
			with self.assertRaises(WAValidationError):
				api.preview_command(payload={"code": CODE})
		self.assertEqual(frappe.db.count("WhatsApp Log"), before)

	def test_delete(self):
		name = self._save()
		with as_user("WhatsApp Manager"):
			api.delete_command(name=name)
		self.assertFalse(frappe.db.exists("WhatsApp Command", name))
		self.assertEqual(
			frappe.db.count("WhatsApp Audit Log", {"action": "Command Deleted", "reference_name": name}), 1
		)
		name = self._save()
		frappe.get_doc(
			{
				"doctype": "WhatsApp Inbound Message",
				"device": ensure_device("EdTest Device", "WAD-TEST-ED01", phone="+966500930500"),
				"provider_message_id": "EDTEST-IN-1",
				"phone": PHONE,
				"phone_e164": PHONE,
				"message_type": "Text",
				"body": f"#{CODE}",
				"command": name,
				"command_status": "Executed",
				"is_simulated": 1,
			}
		).insert(ignore_permissions=True)
		with as_user("WhatsApp Manager"), self.assertRaises(WAStateConflictError):
			api.delete_command(name=name)

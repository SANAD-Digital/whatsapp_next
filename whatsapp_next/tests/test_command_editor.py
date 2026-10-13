# Tests for the command editor (D-132, WHATSAPP_NEXT_INTEGRATION §3.2): the per-party-type black / white
# lists and disabled inputs (controller validation and router enforcement), the command's own message
# texts per language and switched-off replies, the editor read, the save that keeps an Active command
# Active, the draft preview (nothing saved, nothing sent) and delete. The commands run the fixture
# function `_test_echo` (function_fixtures.py).

from __future__ import annotations

from unittest.mock import patch

import frappe
from frappe.tests import IntegrationTestCase

from whatsapp_next.api.v1 import commands as api
from whatsapp_next.exceptions import WAPermissionError, WAStateConflictError, WAValidationError
from whatsapp_next.services import command_router as cr
from whatsapp_next.services.function_runner import Sender
from whatsapp_next.tests import function_fixtures as ff
from whatsapp_next.tests.conftest_frappe import (
	as_user,
	delete_all,
	ensure_contact,
	ensure_device,
	ensure_settings,
)

FUNCTION = "_test_echo"
CODE = "edtestping"
PHONE = "+966500930501"
GROUP = "EdTest Group"
CUSTOMER = "EdTest Customer"


class TestCommandEditor(IntegrationTestCase):
	@classmethod
	def setUpClass(cls):
		super().setUpClass()
		ensure_settings(
			enable_commands=1,
			command_service_user=ff.ensure_service_user(),
			send_receipt_reply=0,
			command_reply_language="en",
		)
		ff.ensure_function(FUNCTION)
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
			"function": FUNCTION,
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
			self.assertIn(FUNCTION, [f["name"] for f in empty["functions"]])
			spec = api.get_function_spec(function=FUNCTION)
			# read from the header: what the sender types, the texts the command may change, the replies
			self.assertEqual([i["key"] for i in spec["inputs"]], ["text"])
			self.assertEqual([s["key"] for s in spec["settings"]], ["text"])
			template = spec["templates"][0]
			self.assertEqual((template["key"], template["default"]), ("msg_result", "pong: {{ echo }}"))
			self.assertEqual([v["name"] for v in template["vars"]], ["echo", "party"])
			self.assertEqual([r["key"] for r in spec["replies"]], ["result_text"])
			self.assertEqual((spec["party_types_text"], spec["available"], spec["server_script"]), ("All", True, "wa_fn__test_echo"))
			with self.assertRaises(frappe.ValidationError):
				api.get_function_spec(function="_test_nope")
		name = self._save(
			synonyms="edtestping2", access={"Customer": {"mode": "Deny All", "contacts": [self.contact]}}
		)
		with as_user("WhatsApp Manager"):
			out = api.get_editor(name=name)
		cmd = out["command"]
		self.assertEqual((cmd["synonyms"], cmd["allowed_party_types"]), (["edtestping2"], ["Customer"]))
		self.assertEqual(cmd["access"]["Customer"]["mode"], "Deny All")
		self.assertEqual(cmd["access"]["Customer"]["contacts"][0]["label"], "EdTest Contact")
		self.assertEqual(out["function"]["name"], FUNCTION)

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
			"function": FUNCTION,
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
				(out["status"], out["text"], out["args"]["text"]),
				("Executed", f"{CODE} hello there", "hello there"),
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

	def test_preview_party_must_be_the_contacts_own(self):
		"""The client's `party_type` / `party_name` are checked against the contact's Dynamic Links;
		without them the preview runs as the account the router would pick."""
		from whatsapp_next.services import commands as svc

		if not self.customer:
			self.skipTest("no Customer on this site")
		payload = {"code": CODE, "function": FUNCTION, "allowed_party_types": ["Customer"]}
		with as_user("WhatsApp Manager"):
			with self.assertRaises(WAValidationError):
				api.preview_command(
					payload=payload,
					sender={"contact": self.contact, "party_type": "Customer", "party_name": "EdTest Not Linked"},
				)
			with self.assertRaises(WAValidationError):
				api.preview_command(
					payload=payload,
					sender={"contact": self.contact, "party_type": "User", "party_name": "Administrator"},
				)
			out = api.preview_command(
				payload=payload,
				sender={"contact": self.contact, "party_type": "Customer", "party_name": self.customer},
				values={"text": "hi"},
			)
			self.assertEqual(out["status"], "Executed")
		draft = frappe._dict(allowed_party_types=[frappe._dict(party_type="Customer")])
		self.assertEqual(svc._preview_party(draft, self.contact, None, None), ("Customer", self.customer))
		self.assertEqual(svc._preview_party(draft, None, "Customer", "anything"), (None, None))

	def test_templates_and_disabled_replies(self):
		"""The command's own message text per language (else the function's, else the header's) and the
		replies it switches off; names outside the header are refused."""
		name = self._save(
			templates=[
				{"param": "msg_result", "language": "en", "text": "hi {{ echo }}"},
				{"param": "msg_result", "language": "ar", "text": ""},  # emptied: falls back
			],
		)
		doc = frappe.get_doc("WhatsApp Command", name)
		self.assertEqual([(r.param, r.language, r.text) for r in doc.templates], [("msg_result", "en", "hi {{ echo }}")])
		with as_user("WhatsApp Manager"):
			cmd = api.get_editor(name=name)["command"]
			self.assertEqual(cmd["templates"], [{"param": "msg_result", "language": "en", "text": "hi {{ echo }}"}])
			out = api.preview_command(payload={"name": name, "code": CODE, "function": FUNCTION, "templates": cmd["templates"], "requires_linked_contact": 0}, sender={"phone": PHONE}, values={"text": "there"})
			self.assertEqual([r["body"] for r in out["replies"]], ["hi there"])
			for bad in (
				{"templates": [{"param": "text", "language": "en", "text": "x"}]},  # not a template
				{"templates": [{"param": "msg_result", "language": "en", "text": "a"}, {"param": "msg_result", "language": "en", "text": "b"}]},
				{"templates": [{"param": "msg_result", "text": "x", "owner": "y"}]},  # unknown field
				{"disabled_replies": ["nope"]},
				{"disabled_inputs": ["party"]},  # the party is never an input
				{"ask_inputs": "msg_result"},
			):
				with self.subTest(payload=bad), self.assertRaises(WAValidationError):
					api.save_editor(payload={"name": name, **bad})
			# a text for every language (no language) stays so, and is used in any reply language
			api.save_editor(payload={"name": name, "templates": [{"param": "msg_result", "language": "", "text": "all {{ echo }}"}]})
			self.assertEqual(
				api.get_editor(name=name)["command"]["templates"],
				[{"param": "msg_result", "language": None, "text": "all {{ echo }}"}],
			)
			from whatsapp_next.services import function_runner

			ensure_settings(command_reply_language="ar")
			try:
				params, _missing = function_runner.prepare(frappe.get_doc("WhatsApp Command", name), self._sender())
			finally:
				ensure_settings(command_reply_language="en")
			self.assertEqual(params["msg_result"], "all {{ echo }}")
			api.save_editor(payload={"name": name, "disabled_replies": ["result_text"]})
			self.assertEqual(api.get_editor(name=name)["command"]["disabled_replies"], ["result_text"])
			out = api.preview_command(payload={"code": CODE, "function": FUNCTION, "disabled_replies": ["result_text"], "requires_linked_contact": 0}, sender={"phone": PHONE})
			self.assertEqual((out["status"], out["replies"]), ("Executed", []))
			# restoring the defaults drops the command's own texts and values
			api.save_editor(payload={"name": name, "settings_overrides": {"text": "fixed"}})
			self.assertEqual(api.restore_defaults(name=name), {"templates": [], "settings_overrides": {}})
		doc.reload()
		self.assertEqual((doc.templates, doc.settings_overrides), ([], None))

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

# Regression tests for the API security review of 2026-09-28: the message template sandbox,
# contact elevation under Frappe's `All` + `if_owner` default, argument bounds, file and record
# checks on user-composed messages, the simulator's party impersonation, `#doc` ownership and
# bulk bounds. The HTTP side of the same review is `scripts/api_live_test.py`.

from __future__ import annotations

from unittest.mock import patch

import frappe
from frappe.tests import IntegrationTestCase

from whatsapp_next.api import _common
from whatsapp_next.api.v1 import _bulk
from whatsapp_next.api.v1 import quick_send as quick_send_api
from whatsapp_next.api.v1 import simulator as simulator_api
from whatsapp_next.exceptions import WAPermissionError, WAValidationError
from whatsapp_next.functions.handlers import document_info
from whatsapp_next.services import attachments, permissions, quick_send, read_layer, templates
from whatsapp_next.tests.conftest_frappe import as_user, ensure_contact

PREFIX = "WA SecTest"


class TestTemplateSandbox(IntegrationTestCase):
	def _render(self, source: str) -> templates.RenderResult:
		ctx = {"doc": frappe.get_doc("User", "Administrator"), "recipient": frappe._dict(display_name="R")}
		return templates.render(source, ctx)

	def test_no_data_access_from_a_message_body(self):
		for source in (
			"{{ frappe.get_all('User') }}",
			"{{ frappe.get_doc('User', 'Administrator') }}",
			"{{ frappe.db.get_value('User', 'Administrator', 'email') }}",
			"{{ frappe.call('frappe.client.get_list', doctype='User') }}",
			"{{ frappe.db.set_value('User', 'Administrator', 'bio', 'x') }}",
		):
			self.assertFalse(self._render(source).ok, source)

	def test_no_write_through_doc_methods(self):
		for source in ("{{ doc.db_set('bio', 'x') }}", "{{ doc.save() }}", "{{ doc.delete() }}"):
			result = self._render(source)
			self.assertFalse(result.ok, source)
			self.assertIn("unsafe", result.error)
		self.assertNotEqual(frappe.db.get_value("User", "Administrator", "bio"), "x")

	def test_documented_context_still_renders(self):
		result = self._render(
			"{{ doc.name }} {{ recipient.display_name }} {{ _('Hello') }} "
			"{{ frappe.utils.flt('2.5') }} {{ frappe.format_value(3, {'fieldtype': 'Int'}) }}"
		)
		self.assertTrue(result.ok, result.error)
		self.assertEqual(result.text, "Administrator R Hello 2.5 3")


class TestContactElevation(IntegrationTestCase):
	def test_all_role_if_owner_does_not_open_every_contact(self):
		"""Frappe says yes at doctype level to `All` + `if_owner`; every logged-in user holds `All`,
		so that must not open the elevated reads and writes."""
		with as_user("_none"):
			self.assertFalse(permissions.can_elevate("read"))
			self.assertFalse(permissions.can_elevate("write"))
			self.assertRaises(WAPermissionError, permissions.require, "read")
		with as_user("WhatsApp Contact User"):
			self.assertTrue(permissions.can_elevate("write"))
		with as_user("System Manager"):
			self.assertTrue(permissions.can_elevate("read"))

	def test_user_permissions_on_contact_close_the_native_path(self):
		with as_user("System Manager") as user:
			with patch("frappe.permissions.get_user_permissions", return_value={"Contact": [{"doc": "x"}]}):
				self.assertFalse(permissions.has_unrestricted_contact_access("read", user))


class TestArgumentBounds(IntegrationTestCase):
	def test_int_beyond_the_database_range_is_refused(self):
		self.assertEqual(_common.coerce_value("page", "2147483647", int), 2147483647)
		with self.assertRaises(WAValidationError):
			_common.coerce_value("page", "99999999999999999999", int)

	def test_list_elements_are_typed(self):
		self.assertEqual(_common.coerce_value("names", '["a", 2]', list[str]), ["a", "2"])
		with self.assertRaises(WAValidationError):
			_common.coerce_value("names", '[{"a": 1}]', list[str])
		with self.assertRaises(WAValidationError):
			_common.coerce_value("rows", '["x"]', list[dict])

	def test_bad_cursor_is_a_validation_error(self):
		for cursor in ("' OR 1=1 --", "not-a-date|x", "x" * 500):
			with self.assertRaises(WAValidationError):
				read_layer.decode_cursor(cursor)
		self.assertEqual(read_layer.decode_cursor("2026-01-01 10:00:00|WAL-1")[1], "WAL-1")

	def test_bulk_selection_is_bounded(self):
		self.assertEqual(_bulk.require_bounded(["a", "a", "", "b"]), ["a", "b"])
		with self.assertRaises(WAValidationError):
			_bulk.require_bounded([f"n{i}" for i in range(_bulk.MAX_BULK + 1)])


class TestUserComposedMessages(IntegrationTestCase):
	def setUp(self):
		self.file = frappe.get_doc(
			{"doctype": "File", "file_name": "wa-sectest-private.txt", "content": b"secret", "is_private": 1}
		).insert(ignore_permissions=True)

	def tearDown(self):
		frappe.delete_doc("File", self.file.name, ignore_permissions=True, force=True)

	def test_private_file_of_someone_else_is_refused(self):
		with as_user("WhatsApp Agent"):
			with self.assertRaises(WAPermissionError):
				attachments.require_readable(self.file.file_url)
			with self.assertRaises(WAPermissionError):
				attachments.message_parts("document", attachment=self.file.file_url)
		attachments.require_readable(self.file.file_url)  # Administrator may

	def test_quick_send_preview_needs_read_on_the_record(self):
		with as_user("WhatsApp Agent"), self.assertRaises(frappe.PermissionError):
			quick_send.preview(body="{{ doc.name }}", reference_doctype="User", reference_name="Administrator")

	def test_quick_send_checks_record_and_file_before_queueing(self):
		with as_user("WhatsApp Agent"), patch.object(quick_send, "compose") as compose:
			with self.assertRaises(frappe.PermissionError):
				quick_send_api.send(
					device="x", phone="+966500000001", body="hi", reference_doctype="User", reference_name="Administrator"
				)
			with self.assertRaises(WAPermissionError):
				quick_send_api.send(
					device="x", phone="+966500000001", message_type="Document", attachment=self.file.file_url
				)
		compose.assert_not_called()


class TestSimulatorImpersonation(IntegrationTestCase):
	def setUp(self):
		customer = frappe.db.get_value("Customer", {}, "name")
		if not customer:
			self.skipTest("no Customer on this site")
		self.contact = ensure_contact(f"{PREFIX} Party", phone="+966500000077")
		doc = frappe.get_doc("Contact", self.contact)
		if not any(link.link_doctype == "Customer" for link in doc.links):
			doc.append("links", {"link_doctype": "Customer", "link_name": customer})
			doc.save(ignore_permissions=True)

	def tearDown(self):
		frappe.delete_doc("Contact", self.contact, ignore_permissions=True, force=True)

	def test_agent_cannot_run_commands_as_a_party(self):
		with as_user("WhatsApp Agent"):
			with self.assertRaises(WAPermissionError):
				simulator_api._require_manager_to_act_as_party("+966500000077")
			simulator_api._require_manager_to_act_as_party("+966500000078")  # no party: allowed
		with as_user("WhatsApp Manager"):
			simulator_api._require_manager_to_act_as_party("+966500000077")


class TestDocumentInfoOwnership(IntegrationTestCase):
	def _run(self, settings: dict, party_name: str | None, name: str):
		ctx = frappe._dict(
			settings=settings,
			args={"name": name},
			sender=frappe._dict(party_type="Customer", party_name=party_name),
		)
		return document_info.handle(ctx)

	def test_blank_party_field_is_refused_not_open(self):
		invoice = frappe.db.get_value("Sales Invoice", {}, ["name", "customer"], as_dict=True)
		if not invoice:
			self.skipTest("no Sales Invoice on this site")
		base = {"document_type": "Sales Invoice", "require_party": 1}
		self.assertIn("party_field", self._run({**base, "party_field": ""}, "Someone", invoice.name).error)
		other = self._run({**base, "party_field": "customer"}, "Someone Else", invoice.name)
		missing = self._run({**base, "party_field": "customer"}, "Someone Else", "NO-SUCH-DOC")
		# one answer for "not yours" and "does not exist"
		self.assertEqual(other.error.replace(invoice.name, "?"), missing.error.replace("NO-SUCH-DOC", "?"))
		self.assertIsNone(self._run({**base, "party_field": "customer"}, invoice.customer, invoice.name).error)

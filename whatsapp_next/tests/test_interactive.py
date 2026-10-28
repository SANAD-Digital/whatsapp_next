# Buttons and lists: the definition is validated and stored on the outbound, travels to the
# platform as `interactive`, and a recipient's tap comes back as an `Interactive Reply` inbound.

from __future__ import annotations

import json

import frappe
from frappe.tests import IntegrationTestCase

from whatsapp_next.exceptions import WANotSupportedError, WAValidationError
from whatsapp_next.providers.schemas import ProviderSettings
from whatsapp_next.providers.snd_platform import SndPlatformProvider, _parse_inbound
from whatsapp_next.services import dispatch, interactive
from whatsapp_next.tests.conftest_frappe import ensure_device


def plan(interactive: bool) -> None:
	"""The synced plan, with or without buttons and lists."""
	frappe.db.set_single_value("WhatsApp Settings", "plan_features", frappe.as_json({"allow_interactive": interactive}))
	frappe.clear_document_cache("WhatsApp Settings", "WhatsApp Settings")


class TestInteractive(IntegrationTestCase):
	def setUp(self):
		plan(True)

	def test_buttons_are_validated_and_given_ids(self):
		d = interactive.normalize("Buttons", {"text": "Continue?", "buttons": [{"text": "Yes"}, {"text": "Yes"}, {"type": "url", "text": "Site", "url": "https://sanad.digital"}]})
		self.assertEqual([b["id"] for b in d["buttons"]], ["yes", "yes_2", "site"])
		for bad in ({"buttons": [{"text": "x"}]}, {"text": "t"}, {"text": "t", "buttons": [{"type": "url", "text": "x"}]}, {"text": "t", "buttons": [{"type": "nope", "text": "x"}]}):
			with self.assertRaises(WAValidationError):
				interactive.normalize("Buttons", bad)

	def test_list_needs_rows(self):
		d = interactive.normalize("List", {"text": "Pick", "sections": [{"title": "S", "rows": [{"id": "a", "title": "A"}, {"title": "B"}]}]})
		self.assertEqual((d["button_text"], [r["id"] for r in d["sections"][0]["rows"]]), ("Options", ["a", "b"]))
		with self.assertRaises(WAValidationError):
			interactive.normalize("List", {"text": "Pick", "sections": []})

	def test_outbound_stores_and_sends_the_definition(self):
		device = frappe.db.get_value("WhatsApp Device", {}, "name") or ensure_device()
		name = dispatch.create_outbound(dispatch.OutboundSpec(device=device, phone="+967770000001", message_type="List", skip_policy=True,
			interactive={"text": "Pick", "button_text": "Open", "sections": [{"rows": [{"id": "a", "title": "A"}]}]}))
		row = frappe.get_doc("WhatsApp Log", name)
		self.assertEqual((row.body, json.loads(row.interactive)["button_text"]), ("Pick", "Open"))
		message = dispatch.build_message(row, "PLAT-DEV")
		provider = SndPlatformProvider(ProviderSettings(provider_key="snd_platform", base_url="https://p.invalid/", timeout=5, credentials={"customer_api_key": "k"}))
		payload = provider._message_payload(message)
		self.assertEqual((payload["message_type"], payload["interactive"]["button_text"]), ("List", "Open"))

	def test_a_plan_without_buttons_and_lists_refuses_them(self):
		device = frappe.db.get_value("WhatsApp Device", {}, "name") or ensure_device()
		plan(False)
		with self.assertRaises(WANotSupportedError):
			dispatch.create_outbound(dispatch.OutboundSpec(device=device, phone="+967770000001", message_type="Buttons", skip_policy=True,
				interactive={"text": "Continue?", "buttons": [{"text": "Yes"}]}))

	def test_a_tap_is_an_interactive_reply(self):
		p = _parse_inbound({"message_id": "R1", "message_type": "Interactive Reply", "text": "كشف حساب", "selected_id": "svc_invoice", "reply_to_message_id": "LIST1"}, None)
		self.assertEqual((p.message_type, p.body, p.selected_id, p.quoted_id), ("Interactive Reply", "كشف حساب", "svc_invoice", "LIST1"))

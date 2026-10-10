# Importing past conversations (services/history_import): received and sent rows land with their
# own time and no side effect, a message already here is skipped, edits / deletions / reactions
# apply to the messages they name, and the job pages through the provider with a cursor.

from __future__ import annotations

from datetime import datetime, timezone
from unittest.mock import patch

import frappe
from frappe.tests import IntegrationTestCase

from whatsapp_next.providers.schemas import HistoryMessage, HistoryPage, InboundPayload
from whatsapp_next.services import history_import

AT = datetime(2026, 3, 1, 9, 30, tzinfo=timezone.utc).replace(tzinfo=None)


def _msg(kind, mid, *, from_me=False, body="hello", phone="967711000001", original=None, **extra):
	p = InboundPayload(provider_message_id=mid, sender_phone=None if from_me else phone,
		sender_jid=f"{phone}@s.whatsapp.net", chat_jid=f"{phone}@s.whatsapp.net", message_type="Text",
		body=body, received_at=AT, **extra)
	return HistoryMessage(kind=kind, from_me=from_me, inbound=p, counterpart_phone=phone, original_id=original)


class TestHistoryImport(IntegrationTestCase):
	def setUp(self):
		self.device = frappe.db.get_value("WhatsApp Device", {}, "name")
		if not self.device:
			self.skipTest("needs a device")
		self.tag = frappe.generate_hash(length=6)
		# Settings' «Import Past Messages» is off by default; these tests run the import itself
		allowed = patch.object(history_import, "allowed", return_value=True)
		allowed.start()
		self.addCleanup(allowed.stop)

	def test_nothing_is_imported_while_the_setting_is_off(self):
		"""Off (the default): no import at pairing, hourly or by hand, and a queued job stops."""
		with patch.object(history_import, "allowed", return_value=False), patch("frappe.enqueue") as enqueue:
			with self.assertRaises(frappe.ValidationError):
				history_import.start(self.device)
			frappe.db.set_value("WhatsApp Device", self.device, "history_started_at", None)
			history_import.on_connected(self.device)
			history_import.catch_up()
			with patch("whatsapp_next.providers.registry.get_provider") as provider:
				self.assertEqual(history_import.run(self.device)["off"], True)
				provider.assert_not_called()
		enqueue.assert_not_called()

	def test_received_and_sent_rows_keep_their_time_and_act_on_nothing(self):
		with patch("whatsapp_next.services.inbound._after_insert") as after, patch("frappe.enqueue") as enqueue:
			key = history_import.apply(self.device, _msg("text", f"H-in-{self.tag}"))
			out = history_import.apply(self.device, _msg("image", f"H-out-{self.tag}", from_me=True, body="photo"))
		self.assertEqual(key, "+967711000001")
		self.assertTrue(out)
		after.assert_not_called()
		enqueue.assert_not_called()
		row = frappe.db.get_value("WhatsApp Inbound Message", {"provider_message_id": f"H-in-{self.tag}"},
			["is_history", "command_status", "received_at", "phone_e164"], as_dict=True)
		self.assertEqual((row.is_history, row.command_status, row.received_at, row.phone_e164), (1, "None", AT, "+967711000001"))
		log = frappe.db.get_value("WhatsApp Log", {"provider_message_id": f"H-out-{self.tag}"},
			["source_type", "status", "message_type", "creation", "phone_e164"], as_dict=True)
		self.assertEqual((log.source_type, log.status, log.message_type, log.creation, log.phone_e164),
			("History", "Sent", "Image", AT, "+967711000001"))

	def test_a_message_already_here_is_skipped(self):
		history_import.apply(self.device, _msg("text", f"H-dup-{self.tag}"))
		self.assertIsNone(history_import.apply(self.device, _msg("text", f"H-dup-{self.tag}")))
		self.assertEqual(frappe.db.count("WhatsApp Inbound Message", {"provider_message_id": f"H-dup-{self.tag}"}), 1)

	def test_edit_delete_and_reaction_apply_to_their_message(self):
		target = f"H-t-{self.tag}"
		history_import.apply(self.device, _msg("text", target, body="first"))
		self.assertTrue(history_import.apply(self.device, _msg("edit", f"H-e-{self.tag}", body="second", original=target)))
		row = frappe.db.get_value("WhatsApp Inbound Message", {"provider_message_id": target}, ["body", "original_body"], as_dict=True)
		self.assertEqual((row.body, row.original_body), ("second", "first"))
		self.assertTrue(history_import.apply(self.device, _msg("revoke", f"H-r-{self.tag}", body=None, original=target)))
		self.assertTrue(frappe.db.get_value("WhatsApp Inbound Message", {"provider_message_id": target}, "deleted_at"))
		history_import.apply(self.device, _msg("reaction", f"H-x-{self.tag}", body=None, reaction="👍", reaction_to=target))
		self.assertEqual(frappe.db.get_value("WhatsApp Inbound Message", {"provider_message_id": f"H-x-{self.tag}"},
			["message_type", "reaction_to_provider_message_id"]), ("Reaction", target))
		# the number's own reactions and plumbing are not messages
		self.assertIsNone(history_import.apply(self.device, _msg("reaction", f"H-y-{self.tag}", from_me=True, reaction="👍")))
		self.assertIsNone(history_import.apply(self.device, _msg("unknown", f"H-z-{self.tag}")))

	def test_the_job_pages_with_the_cursor(self):
		pages = [
			HistoryPage(messages=[_msg("text", f"H-p1-{self.tag}")], next_after=10, has_more=True, total=2),
			HistoryPage(messages=[_msg("text", f"H-p2-{self.tag}")], next_after=20, has_more=False),
		]
		calls = []

		class Provider:
			def list_history(self, platform_device, *, after, limit, since, total):
				calls.append(after)
				return pages[len(calls) - 1]

		frappe.db.set_value("WhatsApp Device", self.device, {"history_cursor": 0, "history_imported": 0})
		with patch("whatsapp_next.providers.registry.get_provider", return_value=Provider()), \
			patch("frappe.db.commit"), patch.object(history_import, "_refresh"):
			result = history_import.run(self.device)
		self.assertEqual((calls, result["imported"], result["more"]), ([0, 10], 2, False))
		row = frappe.db.get_value("WhatsApp Device", self.device, ["history_cursor", "history_status", "history_total"], as_dict=True)
		self.assertEqual((row.history_cursor, row.history_status, row.history_total), (20, "Done", 2))

	def test_a_full_slice_queues_the_next_after_the_lock_is_free(self):
		page = HistoryPage(messages=[], next_after=5, has_more=True)

		class Provider:
			def list_history(self, platform_device, **kwargs):
				return page

		seen = []
		with patch("whatsapp_next.providers.registry.get_provider", return_value=Provider()), \
			patch.object(history_import, "PAGES_PER_RUN", 1), patch("frappe.db.commit"), \
			patch.object(history_import, "start", side_effect=lambda d, **k: seen.append(history_import.is_running(d))):
			result = history_import.run(self.device)
			# a second run while one holds the lock does nothing
			self.assertTrue(history_import._acquire(self.device))
			self.assertEqual(history_import.run(self.device), {"ok": False, "busy": True})
			history_import._release(self.device)
		self.assertTrue(result["more"])
		self.assertEqual(seen, [False])

	def test_a_message_that_cannot_be_stored_is_skipped(self):
		bad = _msg("text", f"H-bad-{self.tag}", from_me=True, phone="")
		good = _msg("text", f"H-ok-{self.tag}")

		class Provider:
			def list_history(self, platform_device, **kwargs):
				return HistoryPage(messages=[bad, good], next_after=3, has_more=False)

		frappe.db.set_value("WhatsApp Device", self.device, {"history_cursor": 0, "history_imported": 0})
		with patch("whatsapp_next.providers.registry.get_provider", return_value=Provider()), \
			patch("frappe.db.commit"), patch.object(history_import, "_refresh"):
			result = history_import.run(self.device)
		self.assertEqual(result["imported"], 1)
		self.assertTrue(frappe.db.exists("WhatsApp Inbound Message", {"provider_message_id": f"H-ok-{self.tag}"}))

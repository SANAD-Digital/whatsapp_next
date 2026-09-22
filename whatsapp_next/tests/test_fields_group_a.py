# Module role: schema regression test for the group-A DocTypes (fields.md RC-01): every fieldname
# of the binding tables exists in the installed meta with the same fieldtype and, for Selects,
# the same options. Expectations are Python literals transcribed from plan/fields.md §1-6, 10,
# 11, 24 with the D-029 / D-031 refinements applied.

from __future__ import annotations

import frappe
from frappe.tests import IntegrationTestCase

# fieldname -> fieldtype, or (fieldtype, options) for Select / Link / Table / Dynamic Link.
EXPECTED: dict[str, dict[str, str | tuple[str, str]]] = {
	"WhatsApp Settings": {
		"provider": ("Select", "snd_platform\nmeta_cloud"),
		"platform_base_url": "Data",
		"request_timeout": "Int",
		"customer_api_key": "Password",
		"api_key": "Password",
		"api_secret": "Password",
		"webhook_secret": "Password",
		"credentials_updated_at": "Datetime",
		"connection_status": ("Select", "Untested\nOK\nFailed"),
		"last_connection_test_at": "Datetime",
		"last_connection_latency_ms": "Int",
		"last_connection_error": "Small Text",
		"webhook_endpoint": "Data",
		"webhook_endpoint_url": "Data",
		"webhook_status": ("Select", "\nActive\nDisabled\nLocked\nRevoked"),
		"webhook_events": "JSON",
		"webhook_max_retries": ("Select", "1\n3\n5"),
		"webhook_synced_at": "Datetime",
		"webhook_last_event_at": "Datetime",
		"messages_per_minute": "Int",
		"max_attempts": "Int",
		"retry_backoff_seconds": "Int",
		"queue_paused": "Check",
		"queue_paused_by": ("Link", "User"),
		"queue_paused_at": "Datetime",
		"queue_pause_reason": "Small Text",
		"enable_commands": "Check",
		"command_service_user": ("Link", "User"),
		"unknown_command_reply": "Small Text",
		"send_receipt_reply": "Check",
		"receipt_reply": "Small Text",
		"reply_device": ("Link", "WhatsApp Device"),
		"default_device": ("Link", "WhatsApp Device"),
		"default_country": ("Link", "Country"),
		"global_blacklist_group": ("Link", "WhatsApp Contact Group"),
		"send_only_to_known_numbers": "Check",
		"picker_sources": ("Table", "WhatsApp Settings Picker Source"),
		"outbound_retention_days": "Int",
		"inbound_retention_days": "Int",
		"queue_retention_days": "Int",
		"webhook_event_retention_days": "Int",
		"audit_retention_days": "Int",
		"plan_code": "Data",
		"plan_name": "Data",
		"subscription_status": "Data",
		"message_limit": "Int",
		"messages_used": "Int",
		"messages_remaining": "Int",
		"plan_messages_per_minute": "Int",
		"device_limit": "Int",
		"wallet_balance": "Currency",
		"wallet_currency": ("Link", "Currency"),
		"subscription_start": "Date",
		"subscription_end": "Date",
		"plan_features": "JSON",
		"subscription_synced_at": "Datetime",
		"numbers_watermark": "Datetime",
		"numbers_last_run_at": "Datetime",
		"setup_completed": "Check",
		"setup_completed_at": "Datetime",
		"redirect_unregistered_to_wizard": "Check",
	},
	"WhatsApp Settings Picker Source": {
		"document_type": ("Link", "DocType"),
		"label": "Data",
		"phone_source": ("Select", "Field\nLinked Contact"),
		"phone_fieldname": "Data",
		"contact_fieldname": "Data",
		"name_fieldname": "Data",
		"filters_json": "Code",
		"enabled": "Check",
	},
	"WhatsApp Device": {
		"device_name": "Data",
		"phone": "Data",
		"phone_e164": "Data",
		"platform_device": "Data",
		"wa_device_id": "Data",
		"status": ("Select", "Pending QR\nConnected\nDisconnected\nLogged Out"),
		"is_default": "Check",
		"disabled": "Check",
		"last_seen": "Datetime",
		"connected_at": "Datetime",
		"disconnected_at": "Datetime",
		"logged_out_at": "Datetime",
		"webhook_registered": "Check",
		"webhook_registered_at": "Datetime",
		"last_error": "Small Text",
		"last_status_event_at": "Datetime",
		"notes": "Small Text",
	},
	"WhatsApp Log": {
		"device": ("Link", "WhatsApp Device"),
		"recipient_type": ("Select", "Individual\nGroup"),
		"phone": "Data",
		"phone_e164": "Data",
		"jid": "Data",
		"display_name": "Data",
		"contact": ("Link", "Contact"),
		"message_type": ("Select", "Text\nDocument\nImage\nVideo\nAudio\nSticker\nLocation\nPoll"),
		"body": "Text",
		"caption": "Small Text",
		"attachment": "Attach",
		"file_name": "Data",
		"mime_type": "Data",
		"view_once": "Check",
		"print_format": ("Link", "Print Format"),
		"letter_head": ("Link", "Letter Head"),
		"language": ("Link", "Language"),
		"location_latitude": "Float",
		"location_longitude": "Float",
		"location_name": "Data",
		"location_address": "Small Text",
		"poll_question": "Data",
		"poll_options": "JSON",
		"poll_allow_multiple": "Check",
		"poll_id": "Data",
		"status": ("Select", "Unsent\nQueued\nSending\nSent\nDelivered\nRead\nFailed\nCancelled\nHeld"),
		"scheduled_at": "Datetime",
		"queued_at": "Datetime",
		"sent_at": "Datetime",
		"delivered_at": "Datetime",
		"read_at": "Datetime",
		"failed_at": "Datetime",
		"cancelled_at": "Datetime",
		"held_at": "Datetime",
		"held_reason": "Small Text",
		"error_code": "Data",
		"error_message": "Small Text",
		"attempts": "Int",
		"source_type": (
			"Select",
			"Quick Send\nForm\nCampaign\nNotification\nNotification Alert\nCommand Reply\nSimulator\nAPI",
		),
		"reference_doctype": ("Link", "DocType"),
		"reference_name": ("Dynamic Link", "reference_doctype"),
		"campaign": ("Link", "WhatsApp Campaign"),
		"campaign_recipient": "Data",
		"campaign_message_idx": "Int",
		"template": ("Link", "WhatsApp Template"),
		"notification": ("Link", "WhatsApp Notification"),
		"notification_alert": ("Link", "WhatsApp Notification Alert"),
		"command": ("Link", "WhatsApp Command"),
		"trigger_inbound": ("Link", "WhatsApp Inbound Message"),
		"queue_item": ("Link", "WhatsApp Queue Item"),
		"provider": "Data",
		"provider_message_id": "Data",
		"platform_queue_id": "Data",
		"platform_message_log": "Data",
		"requested_device": ("Link", "WhatsApp Device"),
		"device_fallback": "Check",
		"is_test": "Check",
		"is_simulated": "Check",
	},
	"WhatsApp Inbound Message": {
		"device": ("Link", "WhatsApp Device"),
		"phone": "Data",
		"phone_e164": "Data",
		"jid": "Data",
		"chat_jid": "Data",
		"sender_jid": "Data",
		"is_group": "Check",
		"display_name": "Data",
		"contact": ("Link", "Contact"),
		"message_type": (
			"Select",
			"Text\nDocument\nImage\nVideo\nAudio\nSticker\nLocation\nPoll\nReaction\nContact\nOther",
		),
		"body": "Text",
		"caption": "Small Text",
		"media_url": "Data",
		"media_mime_type": "Data",
		"attachment": "Attach",
		"location_latitude": "Float",
		"location_longitude": "Float",
		"location_name": "Data",
		"reaction": "Data",
		"reaction_to_provider_message_id": "Data",
		"quoted_provider_message_id": "Data",
		"provider_message_id": "Data",
		"received_at": "Datetime",
		"webhook_event": ("Link", "WhatsApp Webhook Event"),
		"command_status": ("Select", "None\nMatched\nExecuted\nFailed\nNot Matched\nBlocked"),
		"command": ("Link", "WhatsApp Command"),
		"command_text": "Data",
		"command_args": "JSON",
		"command_error": "Small Text",
		"block_reason": (
			"Select",
			"\nBlacklist\nNot Allowed\nParty Type\nNot Linked\nCommands Disabled\nFunction Inactive",
		),
		"reply_outbound": ("Link", "WhatsApp Log"),
		"replied_at": "Datetime",
		"is_simulated": "Check",
	},
	"WhatsApp Queue Item": {
		"outbound_message": ("Link", "WhatsApp Log"),
		"client_ref": "Data",
		"device": ("Link", "WhatsApp Device"),
		"phone_e164": "Data",
		"display_name": "Data",
		"campaign": ("Link", "WhatsApp Campaign"),
		"priority": "Int",
		"scheduled_at": "Datetime",
		"status": ("Select", "Queued\nSending\nPaused\nDeleted\nCompleted\nDead Letter"),
		"attempts": "Int",
		"max_attempts": "Int",
		"next_attempt_at": "Datetime",
		"last_error_code": "Data",
		"last_error": "Small Text",
		"job_id": "Data",
		"claimed_at": "Datetime",
		"batch_id": "Data",
		"platform_queue_id": "Data",
		"paused_by": ("Link", "User"),
		"paused_at": "Datetime",
		"pause_reason": "Small Text",
		"deleted_by": ("Link", "User"),
		"deleted_at": "Datetime",
		"delete_reason": "Small Text",
		"dead_letter_reason": "Small Text",
		"completed_at": "Datetime",
	},
	"WhatsApp Template": {
		"template_name": "Data",
		"category": "Data",
		"message_type": ("Select", "Text\nDocument\nImage"),
		"body": "Code",
		"attachment": "Attach",
		"print_format": ("Link", "Print Format"),
		"letter_head": ("Link", "Letter Head"),
		"file_name_template": "Data",
		"reference_doctype": ("Link", "DocType"),
		"language": ("Link", "Language"),
		"description": "Small Text",
		"sample_context": "JSON",
		"disabled": "Check",
		"use_count": "Int",
		"last_used_at": "Datetime",
	},
	"WhatsApp Number": {
		"link_status": ("Select", "Linked\nNot Linked"),
		"phone_e164": "Data",
		"phone": "Data",
		"jid": "Data",
		"number_type": ("Select", "Individual\nGroup\nLID"),
		"display_name": "Data",
		"contact": ("Link", "Contact"),
		"linked_by": ("Link", "User"),
		"linked_at": "Datetime",
		"first_seen": "Datetime",
		"last_seen": "Datetime",
		"last_direction": ("Select", "\nOutbound\nInbound"),
		"last_device": ("Link", "WhatsApp Device"),
		"outbound_count": "Int",
		"inbound_count": "Int",
		"conversation_confirmed": "Check",
		"conversation_confirmed_by": ("Link", "User"),
		"conversation_confirmed_at": "Datetime",
		"conversation_note": "Small Text",
	},
	"WhatsApp Webhook Event": {
		"event_id": "Data",
		"event_name": "Data",
		"received_at": "Datetime",
		"event_timestamp": "Datetime",
		"signature_valid": "Check",
		"timestamp_fresh": "Check",
		"device": ("Link", "WhatsApp Device"),
		"platform_device": "Data",
		"client_ref": "Data",
		"provider_message_id": "Data",
		"payload": "JSON",
		"status": ("Select", "Received\nProcessed\nIgnored\nFailed"),
		"duplicate_count": "Int",
		"error": "Small Text",
		"processed_at": "Datetime",
		"processing_ms": "Int",
		"inbound_message": ("Link", "WhatsApp Inbound Message"),
		"outbound_message": ("Link", "WhatsApp Log"),
	},
}

# Single-column indexes / unique constraints fields.md lists under "Indexes (JSON)".
UNIQUE: dict[str, tuple[str, ...]] = {
	"WhatsApp Device": ("platform_device",),
	"WhatsApp Template": ("template_name",),
	"WhatsApp Queue Item": ("outbound_message",),
	"WhatsApp Number": ("phone_e164",),
	"WhatsApp Webhook Event": ("event_id",),
}
SEARCH_INDEX: dict[str, tuple[str, ...]] = {
	"WhatsApp Device": ("phone_e164", "status"),
	"WhatsApp Log": ("phone_e164", "status", "provider_message_id"),
	"WhatsApp Inbound Message": ("phone_e164", "provider_message_id", "received_at", "command_status"),
	"WhatsApp Queue Item": ("next_attempt_at", "batch_id"),
	"WhatsApp Template": ("disabled", "category"),
	"WhatsApp Number": ("link_status", "last_seen", "number_type"),
	"WhatsApp Webhook Event": ("event_name", "received_at", "status", "client_ref"),
}
NAMING: dict[str, tuple[str, str | None]] = {
	"WhatsApp Device": ("WA-DEV-.###", "device_name"),
	"WhatsApp Log": ("hash", "display_name"),
	"WhatsApp Inbound Message": ("hash", "display_name"),
	"WhatsApp Queue Item": ("hash", "display_name"),
	"WhatsApp Template": ("field:template_name", None),
	"WhatsApp Number": ("field:phone_e164", "display_name"),
	"WhatsApp Webhook Event": ("hash", "event_name"),
}
TRACK_CHANGES: dict[str, int] = {
	"WhatsApp Settings": 1,
	"WhatsApp Device": 1,
	"WhatsApp Template": 1,
	"WhatsApp Log": 0,
	"WhatsApp Inbound Message": 0,
	"WhatsApp Queue Item": 0,
	"WhatsApp Number": 0,
	"WhatsApp Webhook Event": 0,
}


class TestFieldsGroupA(IntegrationTestCase):
	def test_every_field_exists_with_type_and_options(self) -> None:
		for doctype, fields in EXPECTED.items():
			meta = frappe.get_meta(doctype)
			self.assertEqual(meta.module, "WhatsApp Next", doctype)
			for fieldname, expected in fields.items():
				df = meta.get_field(fieldname)
				self.assertIsNotNone(df, f"{doctype}.{fieldname} missing")
				fieldtype, options = expected if isinstance(expected, tuple) else (expected, None)
				self.assertEqual(df.fieldtype, fieldtype, f"{doctype}.{fieldname}")
				if options is not None:
					self.assertEqual(df.options, options, f"{doctype}.{fieldname} options")

	def test_no_unplanned_value_fields(self) -> None:
		layout = {"Section Break", "Column Break", "Tab Break"}
		for doctype, fields in EXPECTED.items():
			meta = frappe.get_meta(doctype)
			actual = {df.fieldname for df in meta.fields if df.fieldtype not in layout}
			self.assertEqual(actual, set(fields), doctype)

	def test_indexes_and_uniques(self) -> None:
		for doctype, names in UNIQUE.items():
			meta = frappe.get_meta(doctype)
			for fieldname in names:
				self.assertEqual(meta.get_field(fieldname).unique, 1, f"{doctype}.{fieldname} unique")
		for doctype, names in SEARCH_INDEX.items():
			meta = frappe.get_meta(doctype)
			for fieldname in names:
				self.assertEqual(meta.get_field(fieldname).search_index, 1, f"{doctype}.{fieldname} index")
		inbound = frappe.get_meta("WhatsApp Inbound Message").get_field("provider_message_id")
		self.assertFalse(inbound.unique, "composite unique lives in add_indexes.py (D-029)")

	def test_naming_and_flags(self) -> None:
		for doctype, (autoname, title_field) in NAMING.items():
			meta = frappe.get_meta(doctype)
			self.assertEqual(meta.autoname, autoname, doctype)
			self.assertEqual(meta.title_field or None, title_field, doctype)
			if autoname == "hash":
				self.assertEqual(meta.show_title_field_in_link, 1, doctype)
			self.assertEqual(meta.sort_field, "creation", doctype)
			self.assertEqual(meta.sort_order, "DESC", doctype)
		for doctype, flag in TRACK_CHANGES.items():
			self.assertEqual(frappe.get_meta(doctype).track_changes or 0, flag, doctype)
		self.assertEqual(frappe.get_meta("WhatsApp Settings").issingle, 1)
		self.assertEqual(frappe.get_meta("WhatsApp Settings Picker Source").istable, 1)
		self.assertEqual(frappe.get_meta("WhatsApp Template").allow_rename, 1)
		self.assertEqual(frappe.get_meta("WhatsApp Number").allow_rename or 0, 0)
		self.assertEqual(
			frappe.get_meta("WhatsApp Settings").get_field("webhook_endpoint_url").description,
			"`https://{site}/api/method/whatsapp_next.webhooks.v1.receiver.receive` (D-031)",
		)

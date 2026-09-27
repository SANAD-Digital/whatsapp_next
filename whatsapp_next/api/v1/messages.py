# Module role: API of the Outbound / Inbound lists and the message drawer (backend-plan §4.4
# `messages.*`, screens 4/5). Reads project the rows (no payloads, explicit field lists), the
# conversation goes through the read layer, resend / cancel go through the dispatcher — the
# single status writer. Bulk `resend_many` is the 09 G-01 additive variant.

from __future__ import annotations

from typing import Any

import frappe
from frappe import _

from whatsapp_next.api._common import api_endpoint
from whatsapp_next.api.v1 import _bulk
from whatsapp_next.api.v1._roles import AGENT_UP, MANAGER, VIEWER_UP
from whatsapp_next.exceptions import WANotFoundError, WAPermissionError
from whatsapp_next.services import dispatch, inbound, read_layer
from whatsapp_next.services.dispatch import OUTBOUND_TERMINAL

OUTBOUND_FIELDS: tuple[str, ...] = (
	"name",
	"creation",
	"modified",
	"owner",
	"device",
	"requested_device",
	"device_fallback",
	"recipient_type",
	"phone",
	"phone_e164",
	"jid",
	"display_name",
	"contact",
	"message_type",
	"body",
	"caption",
	"attachment",
	"file_name",
	"mime_type",
	"view_once",
	"print_format",
	"letter_head",
	"language",
	"location_latitude",
	"location_longitude",
	"location_name",
	"location_address",
	"poll_question",
	"poll_options",
	"poll_allow_multiple",
	"poll_id",
	"status",
	"scheduled_at",
	"queued_at",
	"sent_at",
	"delivered_at",
	"read_at",
	"failed_at",
	"cancelled_at",
	"held_at",
	"held_reason",
	"error_code",
	"error_message",
	"attempts",
	"source_type",
	"reference_doctype",
	"reference_name",
	"template",
	"campaign",
	"campaign_recipient",
	"campaign_message_idx",
	"notification",
	"notification_alert",
	"command",
	"trigger_inbound",
	"is_test",
	"is_simulated",
	"queue_item",
	"provider",
	"provider_message_id",
	"platform_queue_id",
	"platform_message_log",
)
QUEUE_ITEM_FIELDS: tuple[str, ...] = (
	"name",
	"status",
	"priority",
	"scheduled_at",
	"attempts",
	"max_attempts",
	"next_attempt_at",
	"last_error_code",
	"last_error",
	"claimed_at",
	"batch_id",
	"platform_queue_id",
	"paused_by",
	"paused_at",
	"pause_reason",
	"deleted_by",
	"deleted_at",
	"delete_reason",
	"dead_letter_reason",
	"completed_at",
	"creation",
	"modified",
)
# Never the payload (PII, backend-plan §4.0).
WEBHOOK_EVENT_FIELDS: tuple[str, ...] = (
	"name",
	"event_name",
	"event_id",
	"received_at",
	"event_timestamp",
	"status",
	"error",
	"processed_at",
	"signature_valid",
	"duplicate_count",
)
INBOUND_FIELDS: tuple[str, ...] = (
	"name",
	"creation",
	"device",
	"phone",
	"phone_e164",
	"jid",
	"chat_jid",
	"sender_jid",
	"is_group",
	"display_name",
	"contact",
	"message_type",
	"body",
	"caption",
	"media_url",
	"media_mime_type",
	"attachment",
	"location_latitude",
	"location_longitude",
	"location_name",
	"reaction",
	"reaction_to_provider_message_id",
	"quoted_provider_message_id",
	"provider_message_id",
	"received_at",
	"webhook_event",
	"is_simulated",
	"reply_outbound",
	"replied_at",
)
COMMAND_TRACE_FIELDS: tuple[str, ...] = (
	"command_status",
	"command",
	"command_text",
	"command_args",
	"command_error",
	"block_reason",
)
REPLY_FIELDS: tuple[str, ...] = (
	"name",
	"status",
	"body",
	"message_type",
	"sent_at",
	"error_code",
	"creation",
)


def _require_read(doctype: str, name: str) -> None:
	if not frappe.has_permission(doctype, "read", doc=name):
		frappe.throw(_("Not permitted to read {0} {1}").format(_(doctype), name), WAPermissionError)


@api_endpoint(roles=VIEWER_UP, methods=("GET", "POST"))
def get_outbound(name: str) -> dict[str, Any]:
	"""Drawer payload of one outbound row: fields + `reference{doctype, name, amount}` +
	`timeline{queue_item, webhook_events[]}`. `WANotFoundError` when unknown."""
	row = frappe.db.get_value("WhatsApp Log", name, list(OUTBOUND_FIELDS), as_dict=True)
	if not row:
		frappe.throw(_("WhatsApp Log {0} not found").format(name), WANotFoundError)
	_require_read("WhatsApp Log", name)
	queue_item = (
		frappe.db.get_value("WhatsApp Queue Item", row.queue_item, list(QUEUE_ITEM_FIELDS), as_dict=True)
		if row.queue_item
		else None
	)
	events = frappe.get_all(
		"WhatsApp Webhook Event",
		filters={"outbound_message": name},
		fields=list(WEBHOOK_EVENT_FIELDS),
		order_by="received_at asc, creation asc",
	)
	row["reference"] = {
		"doctype": row.reference_doctype,
		"name": row.reference_name,
		"amount": read_layer.reference_amount(row.reference_doctype, row.reference_name),
	}
	row["timeline"] = {"queue_item": queue_item, "webhook_events": events}
	return row


@api_endpoint(roles=VIEWER_UP, methods=("GET", "POST"))
def get_inbound(name: str) -> dict[str, Any]:
	"""One inbound row: fields + `command_trace{...}` + `reply_outbound{...}` (the reply's
	status / body) + `ui` (the realtime-safe projection). `WANotFoundError` when unknown."""
	row = frappe.db.get_value(
		"WhatsApp Inbound Message", name, list(INBOUND_FIELDS + COMMAND_TRACE_FIELDS), as_dict=True
	)
	if not row:
		frappe.throw(_("WhatsApp Inbound Message {0} not found").format(name), WANotFoundError)
	_require_read("WhatsApp Inbound Message", name)
	row["command_trace"] = {f: row.pop(f) for f in COMMAND_TRACE_FIELDS}
	reply_name = row.pop("reply_outbound")
	row["reply_outbound"] = (
		frappe.db.get_value("WhatsApp Log", reply_name, list(REPLY_FIELDS), as_dict=True)
		if reply_name
		else None
	)
	row["ui"] = inbound.as_dict_for_ui(name)
	return row


@api_endpoint(roles=None, methods=("GET", "POST"))
def get_conversation(
	key: str, device: str | None = None, before: str | None = None, limit: int = 50
) -> dict[str, Any]:
	"""Newest-first messages of both directions with `key` (E.164 or group JID) through the read
	layer → `{rows[], has_more, next_cursor}`; `before` is a row `cursor`. Requires read on
	**both** WhatsApp Log and WhatsApp Inbound Message (D-029 OQ-5: a Contact User without
	Viewer gets `WAPermissionError`)."""
	if not (
		frappe.has_permission("WhatsApp Log", "read")
		and frappe.has_permission("WhatsApp Inbound Message", "read")
	):
		frappe.throw(_("Not permitted to read conversations"), WAPermissionError)
	page = read_layer.conversation(key, device=device, before=before, limit=limit)
	rows = []
	for r in page.rows:
		d = {c: getattr(r, c) for c in read_layer.COLUMNS}
		d["cursor"] = r.cursor
		rows.append(d)
	return {"rows": rows, "has_more": page.has_more, "next_cursor": page.next_cursor}


@api_endpoint(roles=AGENT_UP)
def resend(name: str) -> dict[str, Any]:
	"""New outbound row from a terminal one (`source_type` copied, `attempts` 0), queued →
	`{outbound, queue_item}`. Non-terminal rows raise `WAStateConflictError`."""
	outbound, queue_item = dispatch.resend_outbound(name, user=frappe.session.user)
	return {"outbound": outbound, "queue_item": queue_item}


@api_endpoint(roles=AGENT_UP)
def resend_many(names: list[str]) -> dict[str, Any]:
	"""Bulk resend (09 G-01): terminal rows are resent one by one, each in its own savepoint;
	non-terminal rows are reported in `skipped` → `{count, done[], failed[], skipped[]}`."""
	statuses = {
		r.name: r.status
		for r in frappe.get_all("WhatsApp Log", filters={"name": ("in", names)}, fields=["name", "status"])
	}

	def one(name: str) -> None:
		status = statuses.get(name)
		if status is None:
			frappe.throw(_("WhatsApp Log {0} not found").format(name), WANotFoundError)
		if status not in OUTBOUND_TERMINAL:
			raise _bulk.Skip(status)
		dispatch.resend_outbound(name, user=frappe.session.user)

	return _bulk.run_bulk(names, one)


@api_endpoint(roles=MANAGER)
def cancel(name: str, reason: str | None = None) -> dict[str, Any]:
	"""Cancel a queued / paused message (`dispatch.delete_items`: queue row `Deleted`, outbound
	`Cancelled`) → `{status}`. `WAStateConflictError` while `Sending` or when not queued."""
	return {"status": dispatch.cancel_outbound(name, user=frappe.session.user, reason=reason)}


@api_endpoint(roles=VIEWER_UP, methods=("GET", "POST"))
def get_inbound_summary(days: int | None = 30) -> dict[str, Any]:
	"""The Inbound screen's figures (09 G-07): total, match rate, unmatched, average reply time
	over the last `days` (0 = all time). P: Viewer+."""
	return inbound.summary(days)

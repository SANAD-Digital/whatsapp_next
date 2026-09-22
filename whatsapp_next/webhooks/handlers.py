# Module role: webhook event processing (backend-plan §7.2). `process_event` runs as a `short`
# job per stored `WhatsApp Webhook Event`, re-parses the payload through the provider and
# dispatches by event name to the owning service (dispatch / inbound / devices / numbers).
# Sets `Processed` / `Failed` / `Ignored`, timings, links, and blanks terminal `message.*`
# payloads. Failures are retried up to 3× by `reprocess_failed` (cron `*/10`).

from __future__ import annotations

import json
import re
import time
from typing import Any

import frappe
from frappe.utils import cint, now_datetime

from whatsapp_next.providers import registry
from whatsapp_next.providers.schemas import WebhookEvent
from whatsapp_next.services import devices, dispatch, errors, inbound
from whatsapp_next.services.guards import status_writer

MAX_TRIES = 3
_TRY_RE = re.compile(r"^\[try (\d+)\] ")

STATUS_EVENTS = {
	"message.sent": "Sent",
	"message.delivered": "Delivered",
	"message.read": "Read",
	"message.failed": "Failed",
	"message.held": "Held",
}
TERMINAL_MESSAGE_EVENTS = frozenset({"message.sent", "message.delivered", "message.read", "message.failed"})


def _resolve_outbound(event: WebhookEvent) -> str | None:
	"""Outbound by `client_ref` (= WhatsApp Log name) else by `provider_message_id` (indexed)."""
	if event.client_ref and frappe.db.exists("WhatsApp Log", event.client_ref):
		return event.client_ref
	if event.provider_message_id:
		return frappe.db.get_value("WhatsApp Log", {"provider_message_id": event.provider_message_id}, "name")
	return None


def handle_event(
	event: WebhookEvent, *, webhook_event_name: str, device: str | None
) -> tuple[str, dict[str, Any]]:
	"""Dispatch one parsed event. Returns `(status, links)` where status is
	`Processed` | `Ignored` and links may carry `outbound_message` / `inbound_message`."""
	name = event.event_name
	if name in STATUS_EVENTS:
		outbound = _resolve_outbound(event)
		if not outbound:
			return "Ignored", {}
		status = STATUS_EVENTS[name]
		if status == "Failed":
			cls = errors.classify(
				event.reason, provider_code=event.status if event.status and event.status.isupper() else None
			)
			dispatch.apply_status(
				outbound,
				"Failed",
				at=event.timestamp,
				error_code=cls.code,
				reason=cls.message,
				platform_message_log=event.platform_message_log,
				source="webhook",
			)
		elif status == "Held":
			dispatch.apply_status(outbound, "Held", at=event.timestamp, reason=event.reason, source="webhook")
		else:
			dispatch.apply_status(
				outbound,
				status,
				at=event.timestamp,
				provider_message_id=event.provider_message_id,
				platform_message_log=event.platform_message_log,
				source="webhook",
			)
		return "Processed", {"outbound_message": outbound}
	if name == "message.received":
		if not device:
			return "Ignored", {}
		inbound_name = inbound.record_inbound(event, webhook_event_name, device=device)
		return ("Processed", {"inbound_message": inbound_name}) if inbound_name else ("Ignored", {})
	if name == "message.reaction":
		if not device:
			return "Ignored", {}
		inbound_name = inbound.record_reaction(event, webhook_event_name, device=device)
		return ("Processed", {"inbound_message": inbound_name}) if inbound_name else ("Ignored", {})
	if name.startswith("connection."):
		change = devices.apply_connection_event(event)
		return ("Processed", {}) if change else ("Ignored", {})
	if name in ("group.updated", "group.participants.updated"):
		from whatsapp_next.services import numbers_materializer

		jid = (
			(event.raw or {}).get("group_id")
			or (event.raw or {}).get("jid")
			or (event.raw or {}).get("chat_jid")
		)
		group_name = (
			(event.raw or {}).get("subject")
			or (event.raw or {}).get("group_name")
			or (event.raw or {}).get("name")
		)
		refresh = getattr(numbers_materializer, "refresh_group_name", None)
		if refresh and jid:
			refresh(jid, group_name)
		return "Processed", {}
	return "Ignored", {}


def process_event(event: str) -> str:
	"""Job entry point: load the stored row, handle it, record the outcome. Returns the status."""
	row = frappe.db.get_value(
		"WhatsApp Webhook Event",
		event,
		["name", "event_name", "status", "payload", "device", "error", "event_id"],
		as_dict=True,
	)
	if not row:
		return "missing"
	if row.status in ("Processed", "Ignored"):
		return row.status
	started = time.perf_counter()
	try:
		body = json.loads(row.payload) if row.payload else {}
		headers = {"X-SND-Event": row.event_name, "X-SND-Event-ID": row.event_id}
		parsed = registry.get_provider().parse_webhook(headers, body)
		device = row.device or devices.by_platform_device(parsed.platform_device)
		status, links = handle_event(parsed, webhook_event_name=row.name, device=device)
		values: dict[str, Any] = {
			"status": status,
			"processed_at": now_datetime(),
			"processing_ms": int((time.perf_counter() - started) * 1000),
			"error": None,
			**links,
		}
		if row.event_name in TERMINAL_MESSAGE_EVENTS and status == "Processed":
			values["payload"] = None
		with status_writer():
			frappe.db.set_value("WhatsApp Webhook Event", event, values, update_modified=True)
		return status
	except Exception as exc:
		tries = _tries(row.error) + 1
		message = f"[try {tries}] {type(exc).__name__}: {str(exc)[:300]}"
		with status_writer():
			frappe.db.set_value(
				"WhatsApp Webhook Event",
				event,
				{
					"status": "Failed",
					"error": message,
					"processed_at": now_datetime(),
					"processing_ms": int((time.perf_counter() - started) * 1000),
				},
				update_modified=True,
			)
		frappe.log_error(
			title="WhatsApp webhook: handler failed",
			message=f"event={row.event_name} id={row.event_id} try={tries}",
		)
		return "Failed"


def _tries(error: str | None) -> int:
	m = _TRY_RE.match(error or "")
	return cint(m.group(1)) if m else 0


def reprocess_failed(limit: int = 100) -> int:
	"""Cron `*/10`: re-run `Failed` events that have fewer than 3 tries. Returns the count."""
	rows = frappe.get_all(
		"WhatsApp Webhook Event",
		filters={"status": "Failed"},
		fields=["name", "error"],
		order_by="received_at asc",
		limit=cint(limit) or 100,
	)
	n = 0
	for r in rows:
		if _tries(r.error) >= MAX_TRIES:
			continue
		with status_writer():
			frappe.db.set_value("WhatsApp Webhook Event", r.name, "status", "Received", update_modified=False)
		process_event(r.name)
		n += 1
	return n

# Module role: exactly-once intake of provider webhooks (backend-plan §7.1 step 6). One
# `WhatsApp Webhook Event` row per `(event_name, event_id)` (composite unique, D-047 — the
# platform reuses one event id across the status events of a message); a repeat only bumps
# `duplicate_count`. Also the `Ignored` store for rejected deliveries (payload blanked).

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any

import frappe
from frappe.utils import cint, now_datetime

from whatsapp_next.services.guards import status_writer

MAX_ERROR = 500


@dataclass(frozen=True)
class Claim:
	name: str
	duplicate: bool


def claim(
	event_id: str,
	event_name: str,
	*,
	payload: dict[str, Any] | None,
	device: str | None,
	platform_device: str | None,
	client_ref: str | None,
	provider_message_id: str | None,
	event_timestamp=None,
	signature_valid: bool = True,
	timestamp_fresh: bool = True,
	status: str = "Received",
	error: str | None = None,
) -> Claim:
	"""Insert the event row, or count a duplicate. Safe under concurrent deliveries: an insert
	race surfaces as `DuplicateEntryError` and is treated as a duplicate."""
	existing = _find(event_name, event_id)
	if existing:
		_bump_duplicate(existing)
		return Claim(name=existing, duplicate=True)
	try:
		with status_writer():
			doc = frappe.get_doc(
				{
					"doctype": "WhatsApp Webhook Event",
					"event_id": event_id,
					"event_name": event_name,
					"received_at": now_datetime(),
					"event_timestamp": event_timestamp,
					"signature_valid": 1 if signature_valid else 0,
					"timestamp_fresh": 1 if timestamp_fresh else 0,
					"duplicate_count": 0,
					"device": device,
					"platform_device": platform_device,
					"client_ref": client_ref,
					"provider_message_id": provider_message_id,
					"payload": json.dumps(payload, ensure_ascii=False, default=str)
					if payload is not None
					else None,
					"status": status,
					"error": (error or "")[:MAX_ERROR] or None,
				}
			)
			doc.flags.ignore_permissions = True
			doc.insert(ignore_permissions=True)
	except frappe.DuplicateEntryError:
		existing = _find(event_name, event_id)
		if existing:
			_bump_duplicate(existing)
		return Claim(name=existing or "", duplicate=True)
	return Claim(name=doc.name, duplicate=False)


def _find(event_name: str, event_id: str) -> str | None:
	return frappe.db.get_value(
		"WhatsApp Webhook Event", {"event_name": event_name, "event_id": event_id}, "name"
	)


def _bump_duplicate(name: str) -> None:
	current = cint(frappe.db.get_value("WhatsApp Webhook Event", name, "duplicate_count"))
	frappe.db.set_value("WhatsApp Webhook Event", name, "duplicate_count", current + 1, update_modified=False)


def store_ignored(
	event_id: str | None,
	event_name: str | None,
	*,
	reason: str,
	signature_valid: bool,
	timestamp_fresh: bool,
	platform_device: str | None = None,
) -> str | None:
	"""Record a rejected delivery as `Ignored` with a blanked payload (forensics without PII).
	Deliveries without an event id are not stored at all (step 1)."""
	if not event_id:
		return None
	c = claim(
		event_id,
		event_name or "unknown",
		payload=None,
		device=None,
		platform_device=platform_device,
		client_ref=None,
		provider_message_id=None,
		signature_valid=signature_valid,
		timestamp_fresh=timestamp_fresh,
		status="Ignored",
		error=reason,
	)
	return c.name

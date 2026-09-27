# Module role: inbound message intake (backend-plan §7.3 steps 1–3). Turns a parsed
# `WebhookEvent` (`message.received` / `message.reaction`) into a `WhatsApp Inbound Message`
# row, deduplicated on `(device, provider_message_id)` (D-035), links the Contact through
# `Contact Phone.wa_phone_e164`, enqueues the Numbers upsert and the command router, and
# publishes `wa:inbound:received` without a phone in the payload.

from __future__ import annotations

import hashlib
import json
from typing import Any

import frappe
from frappe.utils import cint, now_datetime

from whatsapp_next.providers.schemas import WebhookEvent
from whatsapp_next.services.guards import status_writer
from whatsapp_next.services.phone import is_group_or_lid, key_for, normalize

COMMAND_TOKENS = ("#", "/", "!")


def resolve_contact(phone_e164: str | None) -> str | None:
	"""Contact linked to the number through `Contact Phone.wa_phone_e164` (D-028)."""
	from whatsapp_next.services.permissions import resolve_contact_by_phone

	return resolve_contact_by_phone(phone_e164)


def _sender_fields(event: WebhookEvent) -> dict[str, Any]:
	p = event.inbound
	raw_phone = p.sender_phone or None
	e164 = normalize(raw_phone) if raw_phone else None
	sender_jid = p.sender_jid or p.from_jid
	if not e164 and sender_jid and not is_group_or_lid(sender_jid):
		e164 = normalize(sender_jid)
	chat_jid = p.chat_jid or sender_jid
	is_group = bool(p.is_group) or bool(chat_jid and chat_jid.lower().endswith("@g.us"))
	return {
		"phone": raw_phone or e164,
		"phone_e164": e164,
		"jid": sender_jid,
		"chat_jid": chat_jid,
		"sender_jid": sender_jid,
		"is_group": 1 if is_group else 0,
	}


def _existing(device: str, provider_message_id: str | None) -> str | None:
	if not provider_message_id:
		return None
	return frappe.db.get_value(
		"WhatsApp Inbound Message", {"device": device, "provider_message_id": provider_message_id}, "name"
	)


def record_inbound(
	event: WebhookEvent, webhook_event_name: str | None = None, *, device: str | None = None
) -> str | None:
	"""Store a `message.received` event; returns the Inbound name (existing one on a repeat).

	`device` is the local device name (resolved by the receiver). Returns `None` when the event
	carries no inbound payload."""
	if not event.inbound:
		return None
	device = device or _device_for(event)
	if not device:
		return None
	p = event.inbound
	dup = _existing(device, p.provider_message_id)
	if dup:
		return dup
	fields = _sender_fields(event)
	contact = (
		resolve_contact(fields["phone_e164"]) if fields["phone_e164"] and not fields["is_group"] else None
	)
	values: dict[str, Any] = {
		"doctype": "WhatsApp Inbound Message",
		"device": device,
		**fields,
		"display_name": p.push_name,
		"contact": contact,
		"message_type": p.message_type or "Text",
		"body": p.body,
		"caption": p.caption,
		"media_url": p.media_url,
		"media_mime_type": p.media_mime_type,
		"provider_message_id": p.provider_message_id or event.event_id,
		"quoted_provider_message_id": p.quoted_id,
		"received_at": p.received_at or event.timestamp or now_datetime(),
		"webhook_event": webhook_event_name,
		"command_status": "None",
	}
	if p.location:
		values.update(
			{
				"location_latitude": p.location.latitude,
				"location_longitude": p.location.longitude,
				"location_name": p.location.name,
			}
		)
	try:
		with status_writer():
			doc = frappe.get_doc(values)
			doc.flags.ignore_permissions = True
			doc.insert(ignore_permissions=True)
	except frappe.DuplicateEntryError:
		return _existing(device, values["provider_message_id"])
	_after_insert(doc.name, device, fields, p.message_type or "Text", p.body)
	return doc.name


def record_reaction(
	event: WebhookEvent, webhook_event_name: str | None = None, *, device: str | None = None
) -> str | None:
	"""Store a `message.reaction` as an Inbound row of type `Reaction`."""
	if not event.inbound:
		return None
	device = device or _device_for(event)
	if not device:
		return None
	p = event.inbound
	dup = _existing(device, p.provider_message_id)
	if dup:
		return dup
	fields = _sender_fields(event)
	values = {
		"doctype": "WhatsApp Inbound Message",
		"device": device,
		**fields,
		"display_name": p.push_name,
		"contact": resolve_contact(fields["phone_e164"]) if fields["phone_e164"] else None,
		"message_type": "Reaction",
		"body": p.reaction,
		"reaction": p.reaction,
		"reaction_to_provider_message_id": p.reaction_to,
		"provider_message_id": p.provider_message_id or event.event_id,
		"received_at": p.received_at or event.timestamp or now_datetime(),
		"webhook_event": webhook_event_name,
		"command_status": "None",
	}
	try:
		with status_writer():
			doc = frappe.get_doc(values)
			doc.flags.ignore_permissions = True
			doc.insert(ignore_permissions=True)
	except frappe.DuplicateEntryError:
		return _existing(device, values["provider_message_id"])
	_publish(
		doc.name,
		device,
		key_for(fields["phone_e164"], fields["chat_jid"] if fields["is_group"] else fields["sender_jid"]),
	)
	return doc.name


def _device_for(event: WebhookEvent) -> str | None:
	from whatsapp_next.services import devices

	return devices.by_platform_device(event.platform_device)


def _after_insert(
	name: str, device: str, fields: dict[str, Any], message_type: str, body: str | None
) -> None:
	key = key_for(fields["phone_e164"], fields["chat_jid"] if fields["is_group"] else fields["sender_jid"])
	frappe.enqueue(
		"whatsapp_next.services.numbers_materializer.upsert_from_message",
		doctype="WhatsApp Inbound Message",
		name=name,
		queue="short",
		job_id=f"wa-num-{key}",
		deduplicate=True,
		enqueue_after_commit=True,
	)
	_publish(name, device, key)
	if should_route(message_type, body, bool(fields["is_group"])):
		frappe.enqueue(
			"whatsapp_next.services.command_router.route",
			inbound_name=name,
			queue="short",
			job_id=f"wa-cmd-{name}",
			deduplicate=True,
			enqueue_after_commit=True,
			timeout=120,
		)


def should_route(message_type: str, body: str | None, is_group: bool, *, enabled: bool | None = None) -> bool:
	"""Commands enabled (`Settings.enable_commands` unless `enabled` is given), text message,
	and (direct chat or a group message starting with a command token)."""
	if enabled is None:
		enabled = bool(cint(frappe.get_cached_doc("WhatsApp Settings").enable_commands))
	if not enabled:
		return False
	if message_type != "Text" or not (body or "").strip():
		return False
	if is_group:
		return (body or "").lstrip().startswith(COMMAND_TOKENS)
	return True


def key_hash(key: str | None) -> str | None:
	return hashlib.sha1((key or "").encode("utf-8")).hexdigest() if key else None


def _publish(name: str, device: str, key: str | None) -> None:
	frappe.publish_realtime(
		"wa:inbound:received",
		{"inbound": name, "device": device, "key_hash": key_hash(key)},
		after_commit=True,
	)


def link_display_name(inbound: str) -> str | None:
	"""Contact full name when linked, else the push name (used by drawers and Numbers)."""
	row = frappe.db.get_value("WhatsApp Inbound Message", inbound, ["contact", "display_name"], as_dict=True)
	if not row:
		return None
	if row.contact:
		return frappe.db.get_value("Contact", row.contact, "full_name") or row.display_name
	return row.display_name


def as_dict_for_ui(inbound: str) -> dict[str, Any]:
	"""Safe projection for realtime consumers (no raw payload)."""
	row = frappe.db.get_value(
		"WhatsApp Inbound Message",
		inbound,
		[
			"name",
			"device",
			"message_type",
			"body",
			"display_name",
			"contact",
			"received_at",
			"is_group",
			"command_status",
		],
		as_dict=True,
	)
	return json.loads(json.dumps(row, default=str)) if row else {}


MATCHED_STATUSES = ("Matched", "Executed", "Failed", "Blocked")
REPLY_SAMPLE = 5000


def summary(days: int | None = 30) -> dict[str, Any]:
	"""The Inbound screen's figures (09 G-07) over the last `days` (all time when falsy):
	`{total, by_status{}, matched, executed, unmatched, match_rate, avg_reply_seconds,
	replies_measured}`. `matched` = a command recognised the message (whatever happened next);
	the average runs from `received_at` to `replied_at` over the newest replied rows."""
	from frappe.utils import add_days, get_datetime, nowdate

	msg = frappe.qb.DocType("WhatsApp Inbound Message")
	since = get_datetime(add_days(nowdate(), -(cint(days) - 1))) if cint(days) else None
	query = (
		frappe.qb.from_(msg)
		.select(msg.command_status, frappe.query_builder.functions.Count("*"))
		.groupby(msg.command_status)
	)
	if since:
		query = query.where(msg.received_at >= since)
	by_status = {(status or "None"): int(n) for status, n in query.run()}
	total = sum(by_status.values())
	matched = sum(by_status.get(s, 0) for s in MATCHED_STATUSES)
	filters: dict[str, Any] = {"replied_at": ("is", "set"), "received_at": ("is", "set")}
	if since:
		filters["received_at"] = (">=", since)
	pairs = frappe.get_all(
		"WhatsApp Inbound Message",
		filters=filters,
		fields=["received_at", "replied_at"],
		order_by="received_at desc",
		limit=REPLY_SAMPLE,
	)
	gaps = [
		(get_datetime(p.replied_at) - get_datetime(p.received_at)).total_seconds()
		for p in pairs
		if p.replied_at and p.received_at and get_datetime(p.replied_at) >= get_datetime(p.received_at)
	]
	return {
		"days": cint(days) or None,
		"total": total,
		"by_status": by_status,
		"matched": matched,
		"executed": by_status.get("Executed", 0),
		"unmatched": by_status.get("Not Matched", 0),
		"match_rate": round(matched * 100 / total, 1) if total else None,
		"avg_reply_seconds": round(sum(gaps) / len(gaps), 2) if gaps else None,
		"replies_measured": len(gaps),
	}

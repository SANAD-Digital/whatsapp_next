# Module role: inbound message intake (backend-plan §7.3 steps 1–3). Turns a parsed
# `WebhookEvent` (`message.received` / `message.reaction`) into a `WhatsApp Inbound Message`
# row, deduplicated on `(device, provider_message_id)` (D-035), links the Contact through
# `Contact Phone.wa_phone_e164`, enqueues the Numbers upsert and the command router, and
# publishes `wa:inbound:received` without a phone in the payload.

from __future__ import annotations

import hashlib
import json
import os
import re
from typing import Any

import frappe
from frappe.utils import cint, cstr, now_datetime

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
		# the sender's own WhatsApp name, else a name this site knows them by; in a group, the
		# group's name beside it (owner, 2026-10-08)
		"display_name": p.push_name or _known_name(fields, contact),
		"group_name": p.group_name if fields.get("is_group") else None,
		"contact": contact,
		"message_type": p.message_type or "Text",
		"body": p.body,
		"caption": p.caption,
		"media_url": p.media_url,
		"media_mime_type": p.media_mime_type,
		"provider_message_id": p.provider_message_id or event.event_id,
		"quoted_provider_message_id": p.quoted_id,
		"selected_option_id": p.selected_id,
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
	if p.media_url:
		frappe.enqueue(
			"whatsapp_next.services.inbound.fetch_media",
			inbound_name=doc.name,
			file_name=p.media_file_name,
			queue="short",
			job_id=f"wa-media-{doc.name}",
			deduplicate=True,
			enqueue_after_commit=True,
			timeout=300,
		)
	return doc.name


#: Extensions a received file may keep. The sender names the file and Frappe serves a private
#: file inline with a type guessed from that name, so anything a browser could run (`.xhtml`,
#: `.svg`, `.html` …) would execute in Desk when opened; every other name gets `.bin` appended.
SAFE_MEDIA_EXTENSIONS = frozenset(
	"jpg jpeg png gif webp heic heif bmp tif tiff "
	"mp4 3gp mov webm mkv avi m4v "
	"mp3 ogg oga opus m4a aac amr wav flac "
	"pdf doc docx xls xlsx ppt pptx odt ods odp rtf "
	"txt csv vcf zip rar 7z gz tar apk".split()
)


def safe_file_name(name: str | None, fallback: str = "attachment") -> str:
	"""The sender's file name without path or control characters, ≤ 140 characters, with `.bin`
	appended unless its extension is in `SAFE_MEDIA_EXTENSIONS`."""
	name = os.path.basename(str(name or "").replace("\\", "/"))
	name = re.sub(r"[\x00-\x1f\x7f]", "", name).strip().strip(".") or str(fallback or "attachment")
	stem, ext = os.path.splitext(name)
	if ext.lower().lstrip(".") not in SAFE_MEDIA_EXTENSIONS:
		stem, ext = name, ".bin"
	return stem[: 140 - len(ext)] + ext


def fetch_media(inbound_name: str, file_name: str | None = None) -> str | None:
	"""Download a received file from the provider and attach it to the Inbound (`attachment`).

	Runs as a job after the insert; a failure is logged and leaves `media_url` for a retry."""
	from whatsapp_next.providers import registry

	row = frappe.db.get_value(
		"WhatsApp Inbound Message", inbound_name, ["media_url", "attachment", "provider_message_id"], as_dict=True
	)
	if not row or not row.media_url or row.attachment:
		return row.attachment if row else None
	try:
		content, _content_type = registry.get_provider().download_media(row.media_url)
	except Exception:
		frappe.log_error(title="WhatsApp inbound media download failed", message=frappe.get_traceback())
		return None
	file_doc = frappe.get_doc(
		{
			"doctype": "File",
			"file_name": safe_file_name(file_name, fallback=row.provider_message_id or inbound_name),
			"attached_to_doctype": "WhatsApp Inbound Message",
			"attached_to_name": inbound_name,
			"attached_to_field": "attachment",
			"is_private": 1,
			"content": content,
		}
	)
	file_doc.flags.ignore_permissions = True
	file_doc.insert(ignore_permissions=True)
	frappe.db.set_value("WhatsApp Inbound Message", inbound_name, "attachment", file_doc.file_url, update_modified=False)
	return file_doc.file_url


def record_change(event: WebhookEvent, *, device: str) -> str | None:
	"""Apply a gateway `message.edited` / `message.deleted` to the Inbound it names.

	An edit replaces `body` with the new text and keeps the first text in `original_body`; a delete
	stamps `deleted_at` / `deleted_by` and keeps the text, so the conversation can show what was
	removed and by whom. Returns the Inbound name, or `None` when the message is not stored here
	(sent from this device, or before this site existed)."""
	raw = event.raw if isinstance(event.raw, dict) else {}
	message_id = raw.get("message_id")
	name = _existing(device, message_id) if message_id else None
	if not name:
		return None
	row = frappe.db.get_value("WhatsApp Inbound Message", name, ["body", "original_body"], as_dict=True)
	at = event.timestamp or now_datetime()
	if event.event_name == "message.edited":
		values = {"body": raw.get("new_text") or row.body, "edited_at": at}
		if not row.original_body:
			values["original_body"] = raw.get("original_text") or row.body
	else:
		values = {
			"deleted_at": at,
			"deleted_by": raw.get("deleted_by_number") or raw.get("deleted_by") or "",
		}
		if raw.get("original_text") and not row.body:
			values["body"] = raw.get("original_text")
	with status_writer():
		frappe.db.set_value("WhatsApp Inbound Message", name, values, update_modified=True)
	fields = frappe.db.get_value("WhatsApp Inbound Message", name, ["is_group", "chat_jid", "jid", "phone_e164"], as_dict=True)
	_publish(name, device, _conversation_key(dict(fields)))
	# what the message said before this change (`row` was read before the update)
	original = raw.get("original_text") or row.original_body or row.body or ""
	_reply_to_change(name, device, event.event_name, original, message_id)
	return name


def _reply_to_change(inbound_name: str, device: str, event_name: str, original: str, message_id: str) -> str | None:
	"""The settings' answer to an edit or a deletion: the configured text, then what the message
	said — an edit as a reply quoting the edited message, a deletion as a message in the same chat.
	Returns the outbound name, or `None` when the setting is off, out of scope, or there is no text."""
	from whatsapp_next.services import dispatch

	settings = frappe.get_cached_doc("WhatsApp Settings")
	edit = event_name == "message.edited"
	if not cint(settings.get("reply_on_edit" if edit else "reply_on_delete")):
		return None
	lead = cstr(settings.get("edit_reply_text" if edit else "delete_reply_text")).strip()
	original = cstr(original).strip()
	if not lead and not original:
		return None
	row = frappe.db.get_value(
		"WhatsApp Inbound Message",
		inbound_name,
		["is_group", "chat_jid", "jid", "phone_e164", "display_name", "contact"],
		as_dict=True,
	)
	scope = settings.get("changes_reply_scope") or "All chats"
	if (scope == "Groups only" and not row.is_group) or (scope == "Private chats only" and row.is_group):
		return None
	body = "\n\n".join(p for p in (lead, original) if p)
	spec = dispatch.OutboundSpec(
		device=device,
		phone=None if row.is_group else row.phone_e164,
		jid=row.chat_jid if row.is_group else (None if row.phone_e164 else row.jid),
		message_type="Text",
		body=body,
		source_type="Command Reply",
		trigger_inbound=inbound_name,
		display_name=row.display_name,
		contact=row.contact,
		skip_policy=True,
		extra={"reply_to_provider_message_id": message_id} if edit else {},
	)
	try:
		outbound = dispatch.create_outbound(spec)
		dispatch.enqueue([outbound], priority=1)
	except Exception:
		frappe.log_error(title="WhatsApp edit/delete reply not sent", message=frappe.get_traceback())
		return None
	return outbound


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
	_publish(doc.name, device, _conversation_key(fields))
	return doc.name


def _conversation_key(fields: dict[str, Any]) -> str | None:
	"""The Number key the message is filed under — the read layer's own expression, so a LID sender
	whose number is known is keyed by the number and an open conversation drawer (keyed by the
	number) matches the realtime `key_hash`."""
	from whatsapp_next.services.numbers_materializer import message_key

	return message_key({**fields, "doctype": "WhatsApp Inbound Message"})


def _known_name(fields: dict[str, Any], contact: str | None) -> str | None:
	"""A name for a sender WhatsApp delivered without a push name — the linked contact's, else the
	one on the sender's WhatsApp Number row (as `dispatch._recipient_name` does for outbound). In a
	group the sender, not the group, is named."""
	if contact:
		name = frappe.db.get_value("Contact", contact, "full_name")
		if name:
			return name
	key = fields["phone_e164"] or key_for(None, fields["sender_jid"])
	if not key:
		return None
	row = frappe.db.get_value("WhatsApp Number", key, ["display_name", "contact"], as_dict=True)
	if not row:
		return None
	if row.contact and not contact:
		name = frappe.db.get_value("Contact", row.contact, "full_name")
		if name:
			return name
	return row.display_name or None


def _device_for(event: WebhookEvent) -> str | None:
	from whatsapp_next.services import devices

	return devices.by_platform_device(event.platform_device)


def _after_insert(
	name: str, device: str, fields: dict[str, Any], message_type: str, body: str | None
) -> None:
	# The Numbers upsert is enqueued by the `after_insert` doc hook
	# (`numbers_materializer.on_message_insert`); only the realtime event and the router go here.
	_publish(name, device, _conversation_key(fields))
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
	from whatsapp_next.services import receipts

	receipts.on_received(name)


def should_route(message_type: str, body: str | None, is_group: bool, *, enabled: bool | None = None) -> bool:
	"""Commands enabled (`Settings.enable_commands` unless `enabled` is given), text message,
	and (direct chat or a group message starting with a command token)."""
	if enabled is None:
		enabled = bool(cint(frappe.get_cached_doc("WhatsApp Settings").enable_commands))
	if not enabled:
		return False
	# a tap on buttons / a list carries its title as the text: it routes like a typed keyword
	if message_type not in ("Text", "Interactive Reply") or not (body or "").strip():
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
	the average runs from `creation` (the site clock at intake) to `replied_at` (also the site
	clock) over the newest replied rows — `received_at` is the gateway's clock and only picks the
	window."""
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
		fields=["creation", "replied_at"],
		order_by="received_at desc",
		limit=REPLY_SAMPLE,
	)
	gaps = [
		(get_datetime(p.replied_at) - get_datetime(p.creation)).total_seconds()
		for p in pairs
		if p.replied_at and p.creation and get_datetime(p.replied_at) >= get_datetime(p.creation)
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

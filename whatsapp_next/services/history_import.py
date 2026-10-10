# Module role: importing a device's past conversations (D-143).
#
# The platform keeps every message the linked number exchanged — its history at pairing, and live
# ones since — and serves them in batches (`BaseProvider.list_history`). This job reads them after
# a cursor stored on the device and writes them as ordinary rows: received ones as WhatsApp Inbound
# Message (`is_history`), the number's own as WhatsApp Log (`source_type = History`, status Sent).
#
# A past message must not act now, so rows are inserted directly — never through
# `inbound.record_inbound` — and so run no command, send no automatic reply, publish no realtime
# event and fetch no file (media is fetched when someone opens it). A message already stored here
# (it arrived live, or this site sent it) is skipped by its WhatsApp id. Edits, deletions and
# reactions are applied to the messages they name. The window is the inbound retention period:
# anything older would be purged the next night anyway.
#
# Runs on the `long` queue in slices (`PAGES_PER_RUN`) and re-enqueues itself until the platform
# has no more; the cursor makes every run resumable, and an hourly catch-up keeps it current.

from __future__ import annotations

from typing import Any

import frappe
from frappe import _
from frappe.utils import add_days, cint, get_datetime, now_datetime

from whatsapp_next.exceptions import WAStateConflictError
from whatsapp_next.providers import exceptions as pex
from whatsapp_next.providers.schemas import HistoryMessage, WebhookEvent
from whatsapp_next.services.guards import status_writer
from whatsapp_next.services.phone import key_for, normalize

PAGE_SIZE = 500
PAGES_PER_RUN = 20  # ≤ 10 000 messages per job, then the job queues the next slice
JOB_TIMEOUT = 1800
INBOUND = "WhatsApp Inbound Message"
OUTBOUND = "WhatsApp Log"
DEVICE = "WhatsApp Device"

#: provider kinds → the Inbound / Log message type
INBOUND_TYPES = {
	"text": "Text", "image": "Image", "video": "Video", "audio": "Audio", "document": "Document",
	"sticker": "Sticker", "location": "Location", "poll": "Poll", "contact": "Contact",
	"interactive_reply": "Interactive Reply", "interactivereply": "Interactive Reply",
}
OUTBOUND_TYPES = {
	"text": "Text", "image": "Image", "video": "Video", "audio": "Audio", "document": "Document",
	"sticker": "Sticker", "location": "Location", "poll": "Poll", "interactive": "Buttons",
}


# ---- starting -------------------------------------------------------------------------------


def _lock_key(device: str) -> str:
	return frappe.cache.make_key(f"wa:history-lock:{device}")


def _acquire(device: str) -> bool:
	"""One import per device at a time. A slice queues the next while it still runs, so the queue's
	job-id de-duplication cannot be used; this lock (expiring with the job) is the guard."""
	return bool(frappe.cache.set(_lock_key(device), 1, nx=True, ex=JOB_TIMEOUT + 60))


def _release(device: str) -> None:
	frappe.cache.delete(_lock_key(device))


def is_running(device: str) -> bool:
	return bool(frappe.cache.exists(_lock_key(device)))


def allowed() -> bool:
	"""Settings' `import_past_messages` (off by default, owner 2026-10-08): without it nothing is
	read from a number's past — not at pairing, not hourly, not by hand."""
	# the cached document, not `get_single_value`: a site not migrated yet has no such field and
	# reads it as off instead of failing every hour
	return bool(cint(frappe.get_cached_doc("WhatsApp Settings").get("import_past_messages")))


def start(device: str, *, restart: bool = False) -> None:
	"""Queue the import of `device` (one job per device at a time). `restart` reads from the start
	again; rows already here are skipped, so it only fills gaps. Refused while Settings forbid it."""
	if not allowed():
		frappe.throw(
			_("Importing past messages is switched off. Switch on «Import Past Messages» in Settings → Policy first."),
			WAStateConflictError,
		)
	values: dict[str, Any] = {"history_status": "Running", "history_error": None}
	if restart or not frappe.db.get_value(DEVICE, device, "history_started_at"):
		values.update({"history_cursor": 0, "history_imported": 0, "history_started_at": now_datetime(),
			"history_finished_at": None})
	frappe.db.set_value(DEVICE, device, values, update_modified=False)
	frappe.enqueue(
		"whatsapp_next.services.history_import.run",
		device=device,
		queue="long",
		timeout=JOB_TIMEOUT,
		enqueue_after_commit=True,
	)


def on_connected(device: str) -> None:
	"""A device that never imported its history starts when it connects. The phone keeps handing
	its history to the platform for a while after pairing; what lands after this run is read by
	the hourly `catch_up`, since the cursor follows the platform's storage order."""
	if allowed() and not frappe.db.get_value(DEVICE, device, "history_started_at"):
		start(device)


def catch_up() -> None:
	"""Hourly: continue every connected device's import from its cursor — new messages the
	platform stored since (sent from the phone, or a webhook that never arrived) come in too."""
	if not allowed():
		return
	for name in frappe.get_all(DEVICE, filters={"status": "Connected", "disabled": 0}, pluck="name"):
		if not is_running(name):
			start(name)


# ---- the job ----------------------------------------------------------------------------------


def since_timestamp() -> int | None:
	"""The oldest moment worth importing: inbound retention (0 keeps everything)."""
	days = cint(frappe.db.get_single_value("WhatsApp Settings", "inbound_retention_days"))
	return int(get_datetime(add_days(now_datetime(), -days)).timestamp()) if days > 0 else None


def run(device: str) -> dict[str, Any]:
	"""One slice of the import of `device`; re-enqueues itself while the platform has more. A job
	queued before the setting was switched off stops here."""
	if not allowed():
		frappe.db.set_value(DEVICE, device, "history_status", "Not Started" if not frappe.db.get_value(DEVICE, device, "history_imported") else "Done", update_modified=False)
		return {"ok": False, "off": True}
	if not _acquire(device):
		return {"ok": False, "busy": True}
	try:
		result = _run(device)
	finally:
		_release(device)
	if result.get("more"):
		start(device)  # the next slice, queued only once the lock is free
		frappe.db.commit()
	return result


def _run(device: str) -> dict[str, Any]:
	from whatsapp_next.providers import registry

	row = frappe.db.get_value(DEVICE, device, ["platform_device", "history_cursor", "history_imported"], as_dict=True)
	if not row:
		return {"ok": False}
	provider = registry.get_provider()
	cursor, imported, keys, skipped = cint(row.history_cursor), cint(row.history_imported), set(), 0
	since = since_timestamp()
	try:
		for i in range(PAGES_PER_RUN):
			page = provider.list_history(row.platform_device, after=cursor, limit=PAGE_SIZE, since=since, total=i == 0 and not cursor)
			for message in page.messages:
				try:
					frappe.db.savepoint("wa_history_row")
					key = apply(device, message)
				except Exception:
					# one message this site cannot hold (no usable number, text the database
					# refuses …) never stops the rest; the first such failure of a slice is logged
					frappe.db.rollback(save_point="wa_history_row")
					if not skipped:
						frappe.log_error(title="WhatsApp history import: a message was skipped",
							message=f"device={device} message={message.inbound.provider_message_id}\n{frappe.get_traceback()}")
					skipped += 1
					continue
				if key:
					imported += 1
					if key is not True:
						keys.add(key)
			cursor = page.next_after
			values: dict[str, Any] = {"history_cursor": cursor, "history_imported": imported}
			if page.total is not None:
				values["history_total"] = cint(page.total)
			frappe.db.set_value(DEVICE, device, values, update_modified=False)
			frappe.db.commit()
			if not page.has_more:
				break
		else:
			_refresh(keys)
			return {"ok": True, "imported": imported, "more": True}
	except (pex.ProviderError, pex.NotSupportedError) as exc:
		frappe.db.rollback()
		frappe.db.set_value(DEVICE, device, {"history_status": "Failed", "history_error": str(exc)[:500]}, update_modified=False)
		frappe.db.commit()
		return {"ok": False, "error": str(exc)}
	_refresh(keys)
	frappe.db.set_value(DEVICE, device, {"history_status": "Done", "history_finished_at": now_datetime()}, update_modified=False)
	frappe.db.commit()
	return {"ok": True, "imported": imported, "more": False}


def _refresh(keys: set[str]) -> None:
	"""WhatsApp Numbers for every counterpart the slice touched, once (the per-row hook is off)."""
	if not keys:
		return
	from whatsapp_next.services.numbers_materializer import refresh_keys

	refresh_keys(sorted(keys))
	frappe.db.commit()


# ---- one message --------------------------------------------------------------------------------


def apply(device: str, message: HistoryMessage) -> str | bool | None:
	"""Store or apply one past message. Returns the counterpart's Number key for a new row, `True`
	for a change applied to an existing one, `None` when nothing was written."""
	p = message.inbound
	if not p.provider_message_id:
		return None
	if message.kind == "edit":
		return _apply_edit(device, message)
	if message.kind == "revoke":
		return _apply_revoke(device, message)
	if message.kind == "reaction":
		return None if message.from_me else _insert_inbound(device, message, "Reaction")
	if message.from_me:
		return _insert_outbound(device, message)
	message_type = INBOUND_TYPES.get(message.kind)
	return _insert_inbound(device, message, message_type) if message_type else None


def _text(value: str | None) -> str | None:
	"""Text as the database takes it: a lone surrogate half (an emoji cut in two) is dropped."""
	if value is None:
		return None
	return str(value).encode("utf-8", "ignore").decode("utf-8")


def _event(device: str, message: HistoryMessage) -> WebhookEvent:
	return WebhookEvent(event_id=message.inbound.provider_message_id, event_name="message.received",
		inbound=message.inbound, raw=message.raw)


def _insert_inbound(device: str, message: HistoryMessage, message_type: str) -> str | None:
	from whatsapp_next.services import inbound

	p = message.inbound
	if frappe.db.exists(INBOUND, {"device": device, "provider_message_id": p.provider_message_id}):
		return None
	fields = inbound._sender_fields(_event(device, message))
	contact = inbound.resolve_contact(fields["phone_e164"]) if fields["phone_e164"] and not fields["is_group"] else None
	values: dict[str, Any] = {
		"doctype": INBOUND,
		"device": device,
		**fields,
		"display_name": _text(p.push_name) or inbound._known_name(fields, contact),
		"contact": contact,
		"message_type": message_type,
		"body": _text(p.reaction if message_type == "Reaction" else p.body),
		"caption": _text(p.caption),
		"media_url": p.media_url,
		"media_mime_type": p.media_mime_type,
		"reaction": p.reaction,
		"reaction_to_provider_message_id": p.reaction_to,
		"provider_message_id": p.provider_message_id,
		"quoted_provider_message_id": p.quoted_id,
		"selected_option_id": p.selected_id,
		"received_at": p.received_at or now_datetime(),
		"command_status": "None",
		"is_history": 1,
	}
	if p.location:
		values.update({"location_latitude": p.location.latitude, "location_longitude": p.location.longitude,
			"location_name": p.location.name})
	doc = frappe.get_doc(values)
	doc.flags.ignore_permissions = True
	doc.flags.skip_numbers_upsert = True
	try:
		with status_writer():
			doc.insert(ignore_permissions=True)
	except frappe.DuplicateEntryError:
		return None
	return key_for(fields["phone_e164"], fields["chat_jid"] if fields["is_group"] else fields["jid"]) or True


def _insert_outbound(device: str, message: HistoryMessage) -> str | None:
	p = message.inbound
	if frappe.db.exists(OUTBOUND, {"provider_message_id": p.provider_message_id}):
		return None
	message_type = OUTBOUND_TYPES.get(message.kind)
	if not message_type:
		return None
	is_group = bool(p.is_group) or str(p.chat_jid or "").endswith("@g.us")
	phone = None if is_group else normalize(message.counterpart_phone) if message.counterpart_phone else None
	jid = p.chat_jid if is_group else None
	if not phone and not jid:
		return None  # a private chat whose number the platform could not resolve
	at = p.received_at or now_datetime()
	values: dict[str, Any] = {
		"doctype": OUTBOUND,
		"device": device,
		"recipient_type": "Group" if is_group else "Individual",
		"phone": phone,
		"phone_e164": phone,
		"jid": jid,
		"message_type": message_type,
		"body": _text(p.body),
		"caption": _text(p.caption),
		"mime_type": p.media_mime_type,
		"status": "Sent",
		"sent_at": at,
		"source_type": "History",
		"provider_message_id": p.provider_message_id,
		"reply_to_provider_message_id": p.quoted_id,
	}
	doc = frappe.get_doc(values)
	doc.flags.ignore_permissions = True
	doc.flags.skip_numbers_upsert = True
	try:
		with status_writer():
			doc.insert(ignore_permissions=True)
	except frappe.DuplicateEntryError:
		return None
	# the read layer orders the outbound side by `creation`, and retention purges by it: the
	# message's own time, not the import's (insert always stamps now)
	frappe.db.set_value(OUTBOUND, doc.name, {"creation": at, "modified": at}, update_modified=False)
	return key_for(phone, jid) or True


def _apply_edit(device: str, message: HistoryMessage) -> bool | None:
	p = message.inbound
	target = message.original_id
	if not target or p.body is None:
		return None
	at = p.received_at or now_datetime()
	name = frappe.db.get_value(INBOUND, {"device": device, "provider_message_id": target}, "name")
	if name:
		row = frappe.db.get_value(INBOUND, name, ["body", "original_body", "edited_at"], as_dict=True)
		if row.edited_at and get_datetime(row.edited_at) >= get_datetime(at):
			return None
		values = {"body": _text(p.body), "edited_at": at}
		if not row.original_body:
			values["original_body"] = row.body
		with status_writer():
			frappe.db.set_value(INBOUND, name, values, update_modified=False)
		return True
	name = frappe.db.get_value(OUTBOUND, {"provider_message_id": target}, "name")
	if name:
		with status_writer():
			frappe.db.set_value(OUTBOUND, name, "body", _text(p.body), update_modified=False)
		return True
	return None


def _apply_revoke(device: str, message: HistoryMessage) -> bool | None:
	target = message.original_id
	if not target:
		return None
	name = frappe.db.get_value(INBOUND, {"device": device, "provider_message_id": target, "deleted_at": ("is", "not set")}, "name")
	if not name:
		return None
	p = message.inbound
	with status_writer():
		frappe.db.set_value(INBOUND, name, {"deleted_at": p.received_at or now_datetime(),
			"deleted_by": p.sender_phone or p.sender_jid or ""}, update_modified=False)
	return True

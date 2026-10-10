# Module role: what the sender sees while their message is handled — read receipts (blue ticks)
# and "typing…" — per Settings `mark_read_mode` / `typing_indicator`. Best-effort: a receipt that
# cannot be sent never stops a command or a reply, and nothing is sent for simulated messages.

from __future__ import annotations

import frappe
from frappe.utils import cint

INBOUND = "WhatsApp Inbound Message"


def _settings():
	return frappe.get_cached_doc("WhatsApp Settings")


def _mode() -> str:
	from whatsapp_next.services.settings import stored_or_default

	return stored_or_default("mark_read_mode") or "When a command replies"


def _typing_on() -> bool:
	from whatsapp_next.services.settings import stored_or_default

	return bool(cint(stored_or_default("typing_indicator")))


def _row(inbound_name: str | None):
	if not inbound_name:
		return None
	row = frappe.db.get_value(INBOUND, inbound_name, ["device", "chat_jid", "sender_jid", "jid", "is_group",
		"provider_message_id", "is_simulated", "is_history"], as_dict=True)
	if not row or cint(row.is_simulated) or cint(row.is_history) or not row.provider_message_id:
		return None
	row.chat = row.chat_jid or row.sender_jid or row.jid
	return row if row.chat and "@" in row.chat else None


def _platform_device(device: str | None) -> str | None:
	return frappe.db.get_value("WhatsApp Device", device, "platform_device") if device else None


def mark_read(inbound_name: str) -> bool:
	"""Send the read receipt of one received message; returns True when sent."""
	from whatsapp_next.providers import registry

	row = _row(inbound_name)
	platform_device = _platform_device(row.device) if row else None
	if not platform_device:
		return False
	try:
		registry.get_provider().mark_read(platform_device, row.chat, [row.provider_message_id],
			row.sender_jid if cint(row.is_group) else None)
		return True
	except Exception:
		frappe.log_error(title="WhatsApp read receipt not sent", message=f"inbound={inbound_name}")
		return False


def typing(inbound_name: str, state: str = "composing") -> bool:
	"""Show "typing…" in the chat of a received message (per `typing_indicator`)."""
	from whatsapp_next.providers import registry

	if not _typing_on():
		return False
	row = _row(inbound_name)
	platform_device = _platform_device(row.device) if row else None
	if not platform_device:
		return False
	try:
		registry.get_provider().send_presence(platform_device, row.chat, state)
		return True
	except Exception:
		return False  # a missing "typing…" is not worth an error log


def on_received(inbound_name: str) -> None:
	"""After a message is stored: queue its receipt when every received message is marked read."""
	if _mode() == "Every received message":
		frappe.enqueue("whatsapp_next.services.receipts.mark_read", inbound_name=inbound_name, queue="short",
			enqueue_after_commit=True, job_id=f"wa-read-{inbound_name}", deduplicate=True)


def on_command_replied(inbound_name: str) -> None:
	"""After a command answered: its message is marked read (unless receipts are off)."""
	if _mode() == "When a command replies":  # "every" marks on arrival
		mark_read(inbound_name)

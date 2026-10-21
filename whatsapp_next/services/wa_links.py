# Module role: links that open a WhatsApp chat with the business number and a message already
# typed — `https://wa.me/<number>?text=…` — and their QR code, for print formats (Jinja
# `whatsapp_link`, `whatsapp_qr`) and the Settings preview. Scanning the code on an invoice opens
# the chat with, say, «كشف» ready to send, so the customer's statement is one tap away.

from __future__ import annotations

import re
from urllib.parse import quote

import frappe
from frappe import _
from markupsafe import Markup, escape

from whatsapp_next.exceptions import WAStateConflictError
from whatsapp_next.services.devices import default_device

MAX_TEXT = 500


def _number(device: str | None) -> str:
	"""The digits of the device's own number (the default device when none is named)."""
	name = device or default_device()
	phone = frappe.db.get_value("WhatsApp Device", name, "phone_e164") if name else None
	if not phone:
		phone = frappe.db.get_value("WhatsApp Device", {"disabled": 0, "phone_e164": ("is", "set")}, "phone_e164")
	digits = re.sub(r"\D", "", phone or "")
	if not digits:
		frappe.throw(_("No WhatsApp device has a number yet"), WAStateConflictError)
	return digits


def link(text: str | None = None, device: str | None = None) -> str:
	"""`https://wa.me/<number>` with `text` typed in the chat when given."""
	url = f"https://wa.me/{_number(device)}"
	text = (text or "").strip()[:MAX_TEXT]
	return f"{url}?text={quote(text, safe='')}" if text else url


def qr_data_uri(text: str | None = None, device: str | None = None, scale: int = 4) -> str:
	"""The QR code of `link(text, device)` as a PNG data URI."""
	import pyqrcode

	code = pyqrcode.create(link(text, device), error="M")
	return "data:image/png;base64," + code.png_as_base64_str(scale=max(1, min(int(scale or 4), 10)), quiet_zone=2)


def whatsapp_link(text: str | None = None, device: str | None = None) -> str:
	"""Jinja: `{{ whatsapp_link("كشف") }}` → the link (empty when no device has a number)."""
	try:
		return link(text, device)
	except Exception:
		return ""


def whatsapp_qr(text: str | None = None, device: str | None = None, size: int = 120) -> Markup:
	"""Jinja: `{{ whatsapp_qr("كشف " ~ doc.customer) }}` → an `<img>` of the QR code, `size` px wide
	(nothing when no device has a number, so a print never fails over it)."""
	try:
		src = qr_data_uri(text, device)
	except Exception:
		return Markup("")
	px = max(48, min(int(size or 120), 600))
	alt = escape(_("Scan to chat on WhatsApp"))
	return Markup(f'<img src="{src}" width="{px}" height="{px}" alt="{alt}" style="image-rendering: pixelated;">')

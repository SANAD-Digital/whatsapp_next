# Module role: API of the QuickSend composer (backend-plan §4.4 `quick_send.*`, screens spec §3.4).
# Thin wrappers over services/quick_send.py and services/dispatch.py: composer context, template
# preview and the single send (priority 1). Sending itself is always the dispatcher's job.

from __future__ import annotations

from datetime import datetime
from typing import Any

import frappe

from whatsapp_next.api._common import api_endpoint
from whatsapp_next.api.v1._roles import AGENT_UP
from whatsapp_next.services import quick_send
from whatsapp_next.services.dispatch import OutboundSpec

MESSAGE_TYPES = ("Text", "Document", "Image", "Video", "Audio", "Sticker", "Location", "Poll")


@api_endpoint(roles=AGENT_UP, methods=("GET", "POST"))
def get_context(
	phone: str | None = None,
	contact: str | None = None,
	number: str | None = None,
	reference_doctype: str | None = None,
	reference_name: str | None = None,
) -> dict[str, Any]:
	"""`{devices[], default_device, templates[], recipient{...}, policy{...}}` for the composer.
	`recipient` is `None` until a phone, contact or WhatsApp Number is given (`WAInvalidPhoneError`)."""
	return quick_send.get_context(
		phone=phone,
		contact=contact,
		number=number,
		reference_doctype=reference_doctype,
		reference_name=reference_name,
	)


@api_endpoint(roles=AGENT_UP, methods=("GET", "POST"))
def preview(
	template: str | None = None,
	body: str | None = None,
	reference_doctype: str | None = None,
	reference_name: str | None = None,
) -> dict[str, Any]:
	"""`{body, errors[]}` — the template (or ad-hoc body) rendered over the reference document
	or a sample context; render errors are returned, never raised."""
	return quick_send.preview(
		template=template, body=body, reference_doctype=reference_doctype, reference_name=reference_name
	)


@api_endpoint(roles=AGENT_UP, schema={"message_type": {"enum": list(MESSAGE_TYPES)}})
def send(
	device: str,
	phone: str | None = None,
	contact: str | None = None,
	jid: str | None = None,
	message_type: str = "Text",
	body: str | None = None,
	template: str | None = None,
	attachment: str | None = None,
	caption: str | None = None,
	print_format: str | None = None,
	reference_doctype: str | None = None,
	reference_name: str | None = None,
	scheduled_at: datetime | None = None,
	poll_question: str | None = None,
	poll_options: list[str] | None = None,
	poll_allow_multiple: bool = False,
	location: dict | None = None,
) -> dict[str, Any]:
	"""Queue one message at priority 1 → `{outbound, queue_item, warnings[]}`.

	`device_offline` / `queue_paused` come back as warnings (the row is queued anyway). Raises
	`WAInvalidPhoneError`, `WABlacklistedError`, `WAUnknownNumberPolicyError`, `WAFileError`."""
	display_name = frappe.db.get_value("Contact", contact, "full_name") if contact else None
	spec = OutboundSpec(
		device=device,
		phone=phone,
		jid=jid,
		message_type=message_type,
		body=body,
		template=template,
		attachment=attachment,
		caption=caption,
		print_format=print_format,
		reference_doctype=reference_doctype,
		reference_name=reference_name,
		scheduled_at=scheduled_at,
		poll_question=poll_question,
		poll_options=poll_options,
		poll_allow_multiple=bool(poll_allow_multiple),
		location=location,
		contact=contact,
		display_name=display_name,
		source_type="Quick Send",
	)
	outbound, queue_item = quick_send.compose(spec, user=frappe.session.user)
	return {"outbound": outbound, "queue_item": queue_item, "warnings": quick_send.warnings_for(device)}

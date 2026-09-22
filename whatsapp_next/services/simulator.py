# Module role: the WhatsApp Simulator backend (backend-plan §3 `simulator.py`, screen 9). Runs a
# "message on behalf" of a sender through the command router in dry-run (D-029 OQ-8 default),
# optionally persisting `is_simulated` Inbound / Outbound rows that the dispatcher never sends,
# and starts the single test send (`is_test`) job.

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import frappe
from frappe import _
from frappe.utils import now_datetime

from whatsapp_next.exceptions import WAInvalidPhoneError, WAValidationError
from whatsapp_next.services import command_router, dispatch
from whatsapp_next.services.dispatch import OutboundSpec
from whatsapp_next.services.guards import status_writer
from whatsapp_next.services.permissions import resolve_contact_by_phone
from whatsapp_next.services.phone import classify


@dataclass
class SimResult:
	inbound: str | None
	status: str
	command: str | None
	block_reason: str | None
	args: dict[str, Any]
	data: dict[str, Any]
	replies: list[dict[str, Any]]
	outbound: list[str]
	error: str | None
	elapsed_ms: int
	dry_run: bool

	def as_dict(self) -> dict[str, Any]:
		return dict(self.__dict__)


def _inbound_stub(device: str, sender_key: str, text: str, *, persist: bool):
	kind, key = classify(sender_key)
	if not kind:
		frappe.throw(_("Invalid sender number: {0}").format(sender_key), WAInvalidPhoneError)
	values = {
		"doctype": "WhatsApp Inbound Message",
		"device": device,
		"phone": key if kind == "Individual" else None,
		"phone_e164": key if kind == "Individual" else None,
		"jid": key if kind != "Individual" else None,
		"chat_jid": key if kind == "Group" else None,
		"sender_jid": key if kind != "Individual" else None,
		"is_group": 1 if kind == "Group" else 0,
		"contact": resolve_contact_by_phone(key) if kind == "Individual" else None,
		"display_name": _("Simulator"),
		"message_type": "Text",
		"body": text,
		"provider_message_id": "sim-" + frappe.generate_hash(length=10),
		"received_at": now_datetime(),
		"command_status": "None",
		"is_simulated": 1,
	}
	doc = frappe.get_doc(values)
	if persist:
		with status_writer():
			doc.flags.ignore_permissions = True
			doc.flags.skip_numbers_upsert = True
			doc.insert(ignore_permissions=True)
	return doc


def simulate_inbound(
	device: str,
	sender: str,
	text: str,
	*,
	run_commands: bool = True,
	persist: bool = False,
	user: str | None = None,
) -> SimResult:
	"""Route `text` as if `sender` had sent it to `device`.

	Dry-run by default: nothing is stored and nothing is sent. With `persist=True` the Inbound
	row and reply Outbound rows are stored with `is_simulated=1` (never enqueued)."""
	if not (text or "").strip():
		frappe.throw(_("Message text is required"), WAValidationError)
	if not frappe.db.exists("WhatsApp Device", device):
		frappe.throw(_("WhatsApp Device {0} not found").format(device), WAValidationError)
	doc = _inbound_stub(device, sender, text, persist=persist)
	if not run_commands:
		return SimResult(doc.name if persist else None, "None", None, None, {}, {}, [], [], None, 0, True)
	routed = command_router.route(
		doc.name if persist else None, inbound=doc, dry_run=True, create_simulated_rows=persist
	)
	return SimResult(
		inbound=doc.name if persist else None,
		status=routed.status,
		command=routed.command,
		block_reason=routed.block_reason,
		args=routed.args,
		data=routed.data,
		replies=routed.replies,
		outbound=routed.outbound,
		error=routed.error,
		elapsed_ms=routed.elapsed_ms,
		dry_run=True,
	)


def send_test(device: str, phone: str, body: str, user: str | None = None) -> str:
	"""Create an `is_test` outbound and start `dispatch.send_test_message` (D-010, D-024)."""
	if not (body or "").strip():
		frappe.throw(_("Message text is required"), WAValidationError)
	outbound = dispatch.create_outbound(
		OutboundSpec(
			device=device, phone=phone, body=body, source_type="Simulator", is_test=True, skip_policy=True
		),
		user=user,
	)
	frappe.enqueue(
		"whatsapp_next.services.dispatch.send_test_message",
		outbound=outbound,
		queue="short",
		job_id=f"wa-test-{outbound}",
		deduplicate=True,
		enqueue_after_commit=True,
		timeout=120,
	)
	from whatsapp_next.services import audit

	audit.log("Test Send", reference=("WhatsApp Log", outbound), user=user, details={"device": device})
	return outbound

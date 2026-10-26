# Module role: the WhatsApp Simulator backend (backend-plan §3 `simulator.py`, screen 9). Runs a
# "message on behalf" of a sender through the command router in dry-run (D-029 OQ-8 default),
# optionally persisting `is_simulated` Inbound / Outbound rows that the dispatcher never sends,
# and starts the single test send (`is_test`) job.

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import frappe
from frappe import _
from frappe.utils import cint, now_datetime

from whatsapp_next.exceptions import WAInvalidPhoneError, WAValidationError
from whatsapp_next.services import command_router, dispatch
from whatsapp_next.services.devices import default_device
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
		"""The simulation result as the API returns it."""
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


def send_test(
	device: str,
	phone: str,
	body: str | None = None,
	user: str | None = None,
	*,
	kind: str | None = None,
	attachment: str | None = None,
	contact: str | None = None,
	location: dict | None = None,
	interactive: dict | None = None,
) -> str:
	"""Create an `is_test` outbound and start `dispatch.send_test_message` (D-010, D-024). `kind`
	is what the composer's "+" picked (text · image · video · document · audio · location ·
	contact, D-137); the typed text is a file's caption."""
	from whatsapp_next.services.attachments import message_parts

	if (kind or "").lower() in ("buttons", "list"):
		# buttons / a list: the typed text is the message, the definition comes with it
		parts = {"message_type": kind.capitalize(), "body": body, "interactive": interactive}
	else:
		parts = message_parts(kind, body=body, attachment=attachment, contact=contact, location=location)
	outbound = dispatch.create_outbound(
		OutboundSpec(
			device=device, phone=phone, source_type="Simulator", is_test=True, skip_policy=True, **parts
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

	audit.log(
		"Test Send",
		reference=("WhatsApp Log", outbound),
		user=user,
		details={"device": device, "message_type": parts["message_type"]},
	)
	return outbound


def get_context() -> dict[str, Any]:
	"""Simulator page bootstrap: enabled devices, Active commands and recent individual numbers
	as sample senders (screen 11)."""
	settings = frappe.get_cached_doc("WhatsApp Settings")
	devices = frappe.get_all(
		"WhatsApp Device",
		filters={"disabled": 0},
		fields=["name", "device_name", "status", "is_default", "phone_e164"],
		order_by="is_default desc, device_name asc",
	)
	commands = frappe.get_all(
		"WhatsApp Command",
		filters={"status": "Active"},
		fields=["name", "code", "title", "function", "synonyms", "description", "requires_linked_contact"],
		order_by="code asc",
	)
	sample_contacts = frappe.get_all(
		"WhatsApp Number",
		filters=[["phone_e164", "not like", "%@%"]],
		fields=["phone_e164", "display_name", "contact", "link_status", "last_seen"],
		order_by="last_seen desc",
		limit=10,
	)
	return {
		"devices": devices,
		"default_device": default_device(),
		"commands": commands,
		"commands_enabled": bool(cint(settings.enable_commands)),
		"sample_contacts": sample_contacts,
	}


def dry_run_command(text: str, sender: str, device: str | None = None) -> dict[str, Any]:
	"""One dry-run route on an in-memory inbound (`command_router.dry_run`) — the shared body of
	`api.simulator.dry_run_command` and `api.commands.test_command`. Nothing is persisted and
	nothing is sent.

	Returns `{matched, status, command, block_reason, args, reply_body, replies, error, function_ms}`."""
	res = command_router.dry_run(text, sender, device)
	return {
		"matched": res.status not in ("None", "Not Matched"),
		"status": res.status,
		"command": res.command,
		"block_reason": res.block_reason,
		"args": res.args,
		"reply_body": next((r.get("body") for r in res.replies if r.get("body")), None),
		"replies": res.replies,
		"error": res.error,
		"function_ms": res.elapsed_ms,
	}


CONVERSATION_FIELDS: tuple[str, ...] = (
	"name",
	"phone_e164",
	"number_type",
	"display_name",
	"contact",
	"link_status",
	"last_seen",
	"last_direction",
	"outbound_count",
	"inbound_count",
)


def _last_messages(doctype: str, keys: list[str], *, group: bool = False) -> dict[str, dict[str, Any]]:
	"""`{key: newest message}` for many conversations of one table in two grouped reads (the
	newest `creation` per key, then the rows at it). A group's inbound rows carry the member who
	wrote as `phone_e164` and the group as `chat_jid`: they belong to the group's conversation,
	never to that member's own."""
	if not keys:
		return {}
	from frappe.query_builder.functions import Max

	t = frappe.qb.DocType(doctype)
	if doctype == "WhatsApp Inbound Message":
		col = t.chat_jid if group else t.phone_e164
		cond = t.is_group == (1 if group else 0)
	else:
		col = t.phone_e164
		cond = None
	newest = frappe.qb.from_(t).select(col.as_("k"), Max(t.creation).as_("at")).where(col.isin(keys))
	if cond is not None:
		newest = newest.where(cond)
	newest = newest.groupby(col)
	query = (
		frappe.qb.from_(t)
		.join(newest)
		.on((col == newest.k) & (t.creation == newest.at))
		.select(col.as_("k"), t.body, t.message_type, t.creation)
		.orderby(t.name, order=frappe.qb.desc)
	)
	if cond is not None:
		query = query.where(cond)
	out: dict[str, dict[str, Any]] = {}
	for row in query.run(as_dict=True):
		out.setdefault(row.k, row)
	return out


def conversations(txt: str | None = None, limit: int = 30) -> dict[str, Any]:
	"""The simulator's conversation list (the prototype's rail): individual numbers and groups
	(`number_type`), newest first,
	each with its party type (the contact's first account link: `Customer`, `Supplier`, …, `None`
	for a contact with no account, absent for an unsaved number) and a one-line preview of the last
	message either way. `{rows, total}`."""
	from whatsapp_next.services.permissions import PARTY_TYPES

	filters: list = [["number_type", "in", ["Individual", "Group"]]]
	or_filters: dict[str, Any] = {}
	if txt and txt.strip():
		like = f"%{txt.strip()}%"
		or_filters = {"phone_e164": ("like", like), "display_name": ("like", like)}
	rows = frappe.get_all(
		"WhatsApp Number",
		filters=filters,
		or_filters=or_filters,
		fields=list(CONVERSATION_FIELDS),
		order_by="last_seen desc, name asc",
		limit=max(1, min(cint(limit) or 30, 100)),
	)
	total = cint(
		frappe.get_all(
			"WhatsApp Number",
			filters=filters,
			or_filters=or_filters,
			fields=[{"COUNT": "*", "as": "total"}],
		)[0].total
	)
	contacts = sorted({r.contact for r in rows if r.contact})
	party: dict[str, str] = {}
	if contacts:
		for link in frappe.get_all(
			"Dynamic Link",
			filters={
				"parenttype": "Contact",
				"parent": ("in", contacts),
				"link_doctype": ("in", list(PARTY_TYPES)),
			},
			fields=["parent", "link_doctype"],
			order_by="idx asc",
		):
			party.setdefault(link.parent, link.link_doctype)
	singles = [r.phone_e164 for r in rows if r.number_type != "Group"]
	groups = [r.phone_e164 for r in rows if r.number_type == "Group"]
	last_out = _last_messages("WhatsApp Log", singles + groups)
	last_in = {
		**_last_messages("WhatsApp Inbound Message", singles),
		**_last_messages("WhatsApp Inbound Message", groups, group=True),
	}
	for r in rows:
		r["party_type"] = party.get(r.contact) if r.contact else None
		picks = [m for m in (last_out.get(r.phone_e164), last_in.get(r.phone_e164)) if m]
		last = max(picks, key=lambda m: m.creation) if picks else None
		# a message with no text reads as its kind, in the reader's language ("نص", not "Text")
		r["last_body"] = ((last.body or _(last.message_type or "")) if last else "")[:120]
		r["last_at"] = last.creation if last else r.last_seen
	return {"rows": rows, "total": total}


def identity(phone_e164: str) -> dict[str, Any]:
	"""The simulator's "who is this" panel for one number: `{phone_e164, name, contact, party_type,
	link_status, outbound_count, inbound_count, last_seen, accounts[{doctype, name, title}],
	groups[{name, label, kind, member_count}]}` — the contact's own account links and the contact
	groups the number is a member of; `is_group` for a WhatsApp group, whose contact is only the
	one it was linked to. E: `WAInvalidPhoneError`."""
	from whatsapp_next.services.permissions import PARTY_TYPES

	kind, key = classify(phone_e164)
	if kind not in ("Individual", "Group"):
		frappe.throw(_("Invalid phone number: {0}").format(phone_e164), WAInvalidPhoneError)
	number = (
		frappe.db.get_value(
			"WhatsApp Number",
			key,
			["display_name", "contact", "link_status", "outbound_count", "inbound_count", "last_seen"],
			as_dict=True,
		)
		or frappe._dict()
	)
	contact = number.contact or (resolve_contact_by_phone(key) if kind == "Individual" else None)
	accounts = (
		frappe.get_all(
			"Dynamic Link",
			filters={"parenttype": "Contact", "parent": contact, "link_doctype": ("in", list(PARTY_TYPES))},
			fields=["link_doctype", "link_name", "link_title"],
			order_by="idx asc",
		)
		if contact
		else []
	)
	memberships = frappe.get_all(
		"WhatsApp Contact Group Member",
		filters={"parenttype": "WhatsApp Contact Group", "phone_e164": key},
		pluck="parent",
	)
	groups = (
		frappe.get_all(
			"WhatsApp Contact Group",
			filters={"name": ("in", sorted(set(memberships)))},
			fields=["name", "group_name", "kind", "member_count"],
			order_by="group_name asc",
		)
		if memberships
		else []
	)
	return {
		"phone_e164": key,
		"is_group": kind == "Group",
		"name": number.display_name
		or (frappe.db.get_value("Contact", contact, "full_name") if contact else None),
		"contact": contact,
		"party_type": accounts[0].link_doctype if accounts else None,
		"link_status": number.link_status or ("Linked" if contact else "Not Linked"),
		"outbound_count": cint(number.outbound_count),
		"inbound_count": cint(number.inbound_count),
		"last_seen": number.last_seen,
		"accounts": [
			{"doctype": a.link_doctype, "name": a.link_name, "title": a.link_title or a.link_name}
			for a in accounts
		],
		"groups": [
			{
				"name": g.name,
				"label": g.group_name or g.name,
				"kind": g.kind,
				"member_count": cint(g.member_count),
			}
			for g in groups
		],
	}

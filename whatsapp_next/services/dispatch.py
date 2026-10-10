# Module role: the outbound dispatcher (backend-plan §3 `dispatch.py`, §5 queue design, D-046).
# **Single status writer** for `WhatsApp Log` and `WhatsApp Queue Item`: every status change of
# either table goes through this module inside `guards.status_writer()`. Responsibilities:
# create → enqueue → per-device claim (`FOR UPDATE SKIP LOCKED`) → provider batch send → apply
# result (accepted / per-message error / whole-call failure, exponential backoff, dead letter),
# webhook status application (forward-only), pause / resume / delete-as-state / retry, global
# pause, and the single test send. No HTTP outside jobs; realtime ticks carry no PII.

from __future__ import annotations

import json
import random
import uuid
from collections.abc import Iterable
from dataclasses import dataclass, field
from typing import Any

import frappe
from frappe import _
from frappe.utils import add_to_date, cint, get_datetime, now_datetime

from whatsapp_next.exceptions import (
	WABlacklistedError,
	WADeviceOfflineError,
	WAInvalidPhoneError,
	WANotFoundError,
	WAStateConflictError,
	WAUnknownNumberPolicyError,
	WAValidationError,
)
from whatsapp_next.providers import exceptions as pex
from whatsapp_next.providers import registry
from whatsapp_next.providers.base import MAX_BATCH
from whatsapp_next.providers.schemas import BatchResult, Location, NormalizedMessage, SendResult, Source
from whatsapp_next.services import attachments, audit, errors, polls, templates
from whatsapp_next.services.guards import status_writer
from whatsapp_next.services.phone import classify, is_group_or_lid, key_for, normalize
from whatsapp_next.services.wa_format import tidy_markers

# ---- vocabulary ---------------------------------------------------------------------------

OUTBOUND_STATUSES = (
	"Unsent",
	"Queued",
	"Sending",
	"Sent",
	"Delivered",
	"Read",
	"Failed",
	"Cancelled",
	"Held",
)
OUTBOUND_TERMINAL = frozenset({"Sent", "Delivered", "Read", "Failed", "Cancelled"})
# Forward-only ordering of delivery statuses (a later webhook never moves a row backwards).
_DELIVERY_RANK = {"Unsent": 0, "Queued": 1, "Sending": 2, "Held": 2, "Sent": 3, "Delivered": 4, "Read": 5}

QUEUE_STATUSES = ("Queued", "Sending", "Paused", "Deleted", "Completed", "Dead Letter")
QUEUE_OPEN = frozenset({"Queued", "Sending", "Paused"})

PRIORITY_BY_SOURCE: dict[str, int] = {
	"Quick Send": 1,
	"Command Reply": 1,
	"Form": 1,
	"Simulator": 1,
	"API": 3,
	"Notification": 3,
	"Notification Alert": 3,
	"Campaign": 5,
}
CAMPAIGN_EXEMPT_FROM_POLICY = frozenset({"Campaign"})  # known-number policy is a campaign option (D-029)
ATTACHMENT_TYPES = frozenset({"Document", "Image", "Video", "Audio", "Sticker"})

RATE_MIN, RATE_MAX = 5, 60
CLAIM_HARD_CAP = MAX_BATCH
BACKOFF_JITTER = 0.10
PROGRESS_THROTTLE_SECONDS = 1


@dataclass
class OutboundSpec:
	"""Everything `create_outbound` needs. Phones are raw; normalization happens here."""

	device: str | None = None
	phone: str | None = None
	jid: str | None = None
	recipient_type: str | None = None  # Individual | Group; derived from jid when omitted
	message_type: str = "Text"
	body: str | None = None
	caption: str | None = None
	attachment: str | None = None  # File url (already stored; PDFs are rendered by the caller)
	file_name: str | None = None
	mime_type: str | None = None
	view_once: bool = False
	print_format: str | None = None
	letter_head: str | None = None
	language: str | None = None
	location: dict[str, Any] | None = None  # {latitude, longitude, name, address}
	poll_question: str | None = None
	poll_options: Any = None
	poll_allow_multiple: bool = False
	interactive: dict[str, Any] | None = None  # Buttons / List definition (services/interactive)
	template: str | None = None  # WhatsApp Template name; body rendered when `body` is empty
	template_context: dict[str, Any] | None = None
	source_type: str = "API"
	reference_doctype: str | None = None
	reference_name: str | None = None
	campaign: str | None = None
	campaign_recipient: str | None = None
	campaign_message_idx: int | None = None
	notification: str | None = None
	notification_alert: str | None = None
	command: str | None = None
	trigger_inbound: str | None = None
	display_name: str | None = None
	contact: str | None = None
	scheduled_at: Any = None
	is_test: bool = False
	is_simulated: bool = False
	skip_policy: bool = False  # campaigns decide the known-number policy themselves
	extra: dict[str, Any] = field(default_factory=dict)


# ---- settings helpers ---------------------------------------------------------------------


# A message is tried at most this many times by the dispatcher before it is dead-lettered, whatever
# Settings or an older queue row says; a person can still retry it from the queue (owner, 2026-09-30).
MAX_AUTOMATIC_ATTEMPTS = 3


def _settings():
	return frappe.get_cached_doc("WhatsApp Settings")


def _blacklisted(key: str | None) -> bool:
	if not key:
		return False
	group = _settings().global_blacklist_group
	if not group:
		return False
	return bool(
		frappe.db.exists(
			"WhatsApp Contact Group Member",
			{"parent": group, "parenttype": "WhatsApp Contact Group", "phone_e164": key},
		)
	)


def _known(key: str | None) -> bool:
	from whatsapp_next.services import read_layer

	return bool(key) and key in read_layer.known_keys([key])


def _resolve_device(name: str | None) -> str:
	if not name:
		from whatsapp_next.services.devices import default_device

		name = default_device()
	if not name:
		devices = frappe.get_all(
			"WhatsApp Device",
			filters={"status": "Connected", "disabled": 0},
			pluck="name",
			order_by="is_default desc, modified desc",
			limit=1,
		)
		name = devices[0] if devices else None
	if not name or not frappe.db.exists("WhatsApp Device", name):
		frappe.throw(_("No WhatsApp device is configured"), WADeviceOfflineError)
	return name


# ---- create / enqueue ---------------------------------------------------------------------


def _recipient_fields(spec: OutboundSpec) -> dict[str, Any]:
	"""Normalize the recipient; raise `WAInvalidPhoneError` when neither a phone nor a JID parses."""
	jid = (spec.jid or "").strip() or None
	if jid and is_group_or_lid(jid):
		kind, key = classify(jid)
		return {
			"recipient_type": "Group" if kind == "Group" else "Individual",
			"jid": key,
			"phone": spec.phone,
			"phone_e164": None if kind == "Group" else spec.phone,
		}
	raw = spec.phone or jid
	e164 = normalize(raw)
	if not e164:
		frappe.throw(_("Invalid WhatsApp number: {0}").format(raw or ""), WAInvalidPhoneError)
	return {"recipient_type": "Individual", "phone": raw, "phone_e164": e164, "jid": None}


def _recipient_name(spec: OutboundSpec, key: str | None) -> tuple[str | None, str | None]:
	"""`(display_name, contact)` for the row: what the caller gave, else what the system already
	knows about the number — its contact's name, else the name on its WhatsApp Number row (the
	contact's, or the one the phone saves it under). A reply to a sender WhatsApp sent without a
	push name must not read "no name" when the number is a known contact."""
	return recipient_identity(key, spec.display_name, spec.contact)


def recipient_identity(
	key: str | None, display_name: str | None = None, contact: str | None = None
) -> tuple[str | None, str | None]:
	"""`(display_name, contact)` of the number `key`: what the caller already has, completed from
	the number's Contact and its WhatsApp Number row. Whoever renders a body for a recipient asks
	here, so the text greets by the same name the log row will carry."""
	name = display_name
	if name and contact:
		return name, contact
	row = (
		frappe.db.get_value("WhatsApp Number", key, ["display_name", "contact"], as_dict=True)
		if key
		else None
	)
	contact = contact or (row.contact if row else None)
	if not name and contact:
		name = frappe.db.get_value("Contact", contact, "full_name")
	return name or (row.display_name if row else None), contact


def _render_body(spec: OutboundSpec, recipient: dict[str, Any] | None = None) -> tuple[str | None, str | None]:
	"""`(body, template_error)` — template rendering never raises here (legacy F2). `recipient`
	is who the row goes to, so a template can greet them by name."""
	if spec.body or not spec.template:
		return spec.body, None
	tpl = frappe.db.get_value("WhatsApp Template", spec.template, ["body", "disabled"], as_dict=True)
	if not tpl:
		frappe.throw(_("WhatsApp Template {0} not found").format(spec.template), WANotFoundError)
	if cint(tpl.disabled):
		frappe.throw(_("WhatsApp Template {0} is disabled").format(spec.template), WAValidationError)
	ctx = spec.template_context or templates.context_for(
		spec.reference_doctype, spec.reference_name, recipient=recipient
	)
	result = templates.render(tpl.body, ctx)
	return (result.text if result.ok else None), result.error


def create_outbound(spec: OutboundSpec, *, user: str | None = None) -> str:
	"""Validate and insert one `WhatsApp Log` in status `Unsent`; returns its name.

	Checks in order: device, recipient (E.164 / JID), global blacklist, known-number policy
	(unless `skip_policy` or a Campaign source), template render, attachment type, poll shape."""
	device = _resolve_device(spec.device)
	rec = _recipient_fields(spec)
	key = key_for(rec["phone_e164"], rec["jid"])
	if _blacklisted(key):
		frappe.throw(_("Recipient is on the global blacklist"), WABlacklistedError)
	if (
		not spec.skip_policy
		and spec.source_type not in CAMPAIGN_EXEMPT_FROM_POLICY
		and rec["recipient_type"] == "Individual"
		and cint(_settings().send_only_to_known_numbers)
		and not _known(key)
	):
		frappe.throw(_("Sending is restricted to known WhatsApp numbers"), WAUnknownNumberPolicyError)

	display_name, contact = _recipient_name(spec, key)
	body, template_error = _render_body(
		spec,
		{"phone_e164": rec["phone_e164"], "jid": rec["jid"], "display_name": display_name, "contact": contact},
	)
	if spec.message_type == "Text" and not (body or "").strip():
		frappe.throw(
			_("Message body is empty") + (f" ({template_error})" if template_error else ""), WAValidationError
		)
	values: dict[str, Any] = {
		"doctype": "WhatsApp Log",
		"device": device,
		"requested_device": spec.device or None,
		**rec,
		"display_name": display_name,
		"contact": contact,
		"message_type": spec.message_type,
		# WhatsApp draws *bold* only when the marker touches the text: repair `* text*` once, here
		"body": tidy_markers(body),
		"caption": tidy_markers(spec.caption),
		"view_once": 1 if spec.view_once else 0,
		"print_format": spec.print_format,
		"letter_head": spec.letter_head,
		"language": spec.language,
		"status": "Unsent",
		"scheduled_at": get_datetime(spec.scheduled_at) if spec.scheduled_at else None,
		"source_type": spec.source_type,
		"reference_doctype": spec.reference_doctype,
		"reference_name": spec.reference_name,
		"template": spec.template,
		"campaign": spec.campaign,
		"campaign_recipient": spec.campaign_recipient,
		"campaign_message_idx": spec.campaign_message_idx,
		"notification": spec.notification,
		"notification_alert": spec.notification_alert,
		"command": spec.command,
		"trigger_inbound": spec.trigger_inbound,
		"is_test": 1 if spec.is_test else 0,
		"is_simulated": 1 if spec.is_simulated else 0,
		"provider": _settings().provider,
		"attempts": 0,
		**(spec.extra or {}),
	}
	if spec.message_type in ATTACHMENT_TYPES:
		if not spec.attachment:
			frappe.throw(_("{0} messages need an attachment").format(_(spec.message_type)), WAValidationError)
		meta = attachments.file_meta(spec.attachment)
		values.update(
			{
				"attachment": spec.attachment,
				"file_name": spec.file_name or meta["file_name"],
				"mime_type": spec.mime_type or meta["mime_type"],
			}
		)
		attachments.check_mime_for_type(spec.message_type, values["mime_type"])
	elif spec.message_type == "Location":
		loc = spec.location or {}
		if loc.get("latitude") is None or loc.get("longitude") is None:
			frappe.throw(_("Location messages need latitude and longitude"), WAValidationError)
		values.update(
			{
				"location_latitude": loc["latitude"],
				"location_longitude": loc["longitude"],
				"location_name": loc.get("name"),
				"location_address": loc.get("address"),
			}
		)
	elif spec.message_type in ("Buttons", "List"):
		from whatsapp_next.services import interactive, plan_features

		plan_features.require_interactive()
		definition = interactive.normalize(spec.message_type, spec.interactive, values.get("body"))
		values.update({"interactive": json.dumps(definition, ensure_ascii=False), "body": definition["text"]})
	elif spec.message_type == "Poll":
		poll = polls.validate(spec.poll_question, spec.poll_options, spec.poll_allow_multiple)
		values.update(
			{
				"poll_question": poll.question,
				"poll_options": polls.to_json(list(poll.options)),
				"poll_allow_multiple": 1 if poll.allow_multiple else 0,
			}
		)
	if template_error:
		values["error_message"] = f"template: {template_error}"[:500]
	with status_writer():
		doc = frappe.get_doc(values)
		doc.flags.ignore_permissions = True
		if user:
			doc.owner = user
		doc.insert(ignore_permissions=True)
	if spec.template:
		frappe.db.set_value(
			"WhatsApp Template",
			spec.template,
			{
				"use_count": cint(frappe.db.get_value("WhatsApp Template", spec.template, "use_count")) + 1,
				"last_used_at": now_datetime(),
			},
			update_modified=False,
		)
	return doc.name


def enqueue(
	outbound_names: Iterable[str], priority: int | None = None, scheduled_at: Any = None
) -> list[str]:
	"""Insert one `WhatsApp Queue Item` per `Unsent` outbound and move the outbound to `Queued`.

	Returns the Queue Item names. Rows already queued (or terminal) are skipped."""
	names = [n for n in outbound_names if n]
	if not names:
		return []
	rows = frappe.get_all(
		"WhatsApp Log",
		filters={"name": ("in", names)},
		fields=[
			"name",
			"status",
			"device",
			"campaign",
			"phone_e164",
			"jid",
			"display_name",
			"source_type",
			"scheduled_at",
		],
	)
	by_name = {r.name: r for r in rows}
	max_attempts = min(cint(_settings().max_attempts) or 1, MAX_AUTOMATIC_ATTEMPTS)
	created: list[str] = []
	due_devices: set[str] = set()
	now = now_datetime()
	with status_writer():
		for name in dict.fromkeys(names):  # input order, duplicates dropped
			row = by_name.get(name)
			if row is None:
				continue
			if row.status != "Unsent":
				continue
			when = (
				get_datetime(scheduled_at)
				if scheduled_at
				else (get_datetime(row.scheduled_at) if row.scheduled_at else now)
			)
			item = frappe.get_doc(
				{
					"doctype": "WhatsApp Queue Item",
					"outbound_message": row.name,
					"client_ref": row.name,
					"device": row.device,
					"campaign": row.campaign,
					"phone_e164": key_for(row.phone_e164, row.jid),
					"display_name": row.display_name,
					"priority": priority
					if priority is not None
					else PRIORITY_BY_SOURCE.get(row.source_type, 5),
					"scheduled_at": when,
					"status": "Queued",
					"attempts": 0,
					"max_attempts": max_attempts,
				}
			)
			item.flags.ignore_permissions = True
			item.insert(ignore_permissions=True)
			frappe.db.set_value(
				"WhatsApp Log",
				row.name,
				{"status": "Queued", "queued_at": now, "queue_item": item.name, "scheduled_at": when},
				update_modified=True,
			)
			created.append(item.name)
			if row.device and when <= now:
				due_devices.add(row.device)
	_kick_dispatch(due_devices)
	return created


def _kick_dispatch(devices: Iterable[str]) -> None:
	"""Ask for a device's batch as soon as the transaction commits, instead of leaving a message
	that is due now to wait for the next `dispatch_tick`: that cron runs once a minute on the
	`default` queue, behind every other scheduled job of the bench. Same job id as the tick, so a
	batch already waiting is not doubled; the batch itself honours the pause, the rate and the
	device's state. Not from a test run: its jobs would reach the bench's real workers."""
	if frappe.flags.in_test and not frappe.flags.wa_kick_dispatch_in_test:
		return
	for device in sorted(set(devices)):
		frappe.enqueue(
			"whatsapp_next.services.dispatch.dispatch_device_batch",
			device=device,
			queue="short",
			job_id=f"wa-dispatch-{device}",
			deduplicate=True,
			enqueue_after_commit=True,
			timeout=300,
		)


def create_and_enqueue(
	spec: OutboundSpec, *, user: str | None = None, priority: int | None = None
) -> tuple[str, str]:
	"""`create_outbound` + `enqueue` in one call → `(outbound, queue_item)`."""
	outbound = create_outbound(spec, user=user)
	items = enqueue([outbound], priority=priority)
	return outbound, items[0]


# ---- tick / claim / send ------------------------------------------------------------------


def dispatch_tick() -> list[str]:
	"""Cron `* * * * *`: fan out one `dispatch_device_batch` job per connected, enabled device.

	Skipped entirely while `Settings.queue_paused`. Returns the devices enqueued."""
	if cint(_settings().queue_paused):
		return []
	devices = frappe.get_all("WhatsApp Device", filters={"status": "Connected", "disabled": 0}, pluck="name")
	for device in devices:
		frappe.enqueue(
			"whatsapp_next.services.dispatch.dispatch_device_batch",
			device=device,
			queue="short",
			job_id=f"wa-dispatch-{device}",
			deduplicate=True,
			timeout=300,
		)
	return devices


def sent_this_minute(device: str) -> int:
	"""Queue Items completed for `device` in the last 60 s (rate accounting)."""
	since = add_to_date(now_datetime(), seconds=-60)
	return cint(
		frappe.db.count(
			"WhatsApp Queue Item",
			{"device": device, "status": "Completed", "completed_at": (">=", since)},
		)
	)


def paused_campaigns() -> set[str]:
	return set(frappe.get_all("WhatsApp Campaign", filters={"status": "Paused"}, pluck="name"))


def claim_batch(device: str, limit: int, *, job_id: str | None = None) -> list[frappe._dict]:
	"""Atomically move up to `limit` due `Queued` rows of `device` to `Sending` and return them.

	`FOR UPDATE SKIP LOCKED` so concurrent workers never claim the same row; per-campaign
	`messages_per_minute` is applied on the claimed set (surplus rows released back to `Queued`)."""
	limit = max(0, min(cint(limit), CLAIM_HARD_CAP))
	if not limit:
		return []
	now = now_datetime()
	Q = frappe.qb.DocType("WhatsApp Queue Item")
	paused = paused_campaigns()
	query = (
		frappe.qb.from_(Q)
		.select(Q.name, Q.outbound_message, Q.campaign, Q.attempts, Q.max_attempts, Q.priority)
		.where((Q.status == "Queued") & (Q.device == device) & (Q.scheduled_at <= now))
		.where(Q.next_attempt_at.isnull() | (Q.next_attempt_at <= now))
	)
	if paused:
		query = query.where(Q.campaign.isnull() | Q.campaign.notin(list(paused)))
	rows = (
		query.orderby(Q.priority)
		.orderby(Q.scheduled_at)
		.orderby(Q.creation)
		.limit(limit)
		.for_update(skip_locked=True)
		.run(as_dict=True)
	)
	if not rows:
		return []
	# Per-campaign pacing on the claimed set.
	keep: list[frappe._dict] = []
	per_campaign: dict[str, int] = {}
	caps: dict[str, int] = {}
	for r in rows:
		if r.campaign:
			if r.campaign not in caps:
				caps[r.campaign] = (
					cint(frappe.db.get_value("WhatsApp Campaign", r.campaign, "messages_per_minute")) or 0
				)
			cap = caps[r.campaign]
			if cap and per_campaign.get(r.campaign, 0) >= cap:
				continue
			per_campaign[r.campaign] = per_campaign.get(r.campaign, 0) + 1
		keep.append(r)
	if not keep:
		return []
	names = [r.name for r in keep]
	job = job_id or f"wa-dispatch-{device}"
	with status_writer():
		Qn = frappe.qb.DocType("WhatsApp Queue Item")
		frappe.qb.update(Qn).set(Qn.status, "Sending").set(Qn.claimed_at, now).set(Qn.job_id, job).set(
			Qn.modified, now
		).where(Qn.name.isin(names)).run()
		L = frappe.qb.DocType("WhatsApp Log")
		frappe.qb.update(L).set(L.status, "Sending").set(L.modified, now).where(
			L.name.isin([r.outbound_message for r in keep])
		).run()
	for r in keep:
		r.job_id = job
	return keep


def build_message(
	outbound: frappe._dict | Any, platform_device: str, *, priority: int = 5
) -> NormalizedMessage:
	"""`NormalizedMessage` for one WhatsApp Log row (dict or doc). Attachments are inlined."""
	get = outbound.get if hasattr(outbound, "get") else lambda k: getattr(outbound, k, None)
	mt = get("message_type") or "Text"
	location = poll = None
	if mt == "Location":
		location = Location(
			latitude=float(get("location_latitude") or 0),
			longitude=float(get("location_longitude") or 0),
			name=get("location_name"),
			address=get("location_address"),
		)
	elif mt == "Poll":
		poll = polls.validate(get("poll_question"), get("poll_options"), get("poll_allow_multiple"))
	return NormalizedMessage(
		client_ref=get("name"),
		platform_device=platform_device,
		recipient_type=get("recipient_type") or "Individual",
		phone_e164=get("phone_e164"),
		jid=get("jid"),
		message_type=mt,
		body=get("body"),
		caption=get("caption"),
		attachment=attachments.attachment_ref(outbound) if mt in ATTACHMENT_TYPES else None,
		view_once=bool(cint(get("view_once"))),
		location=location,
		poll=poll,
		source=Source(
			type=get("source_type") or "API",
			doctype=get("reference_doctype"),
			docname=get("reference_name"),
			site=frappe.local.site,
		),
		priority=priority,
		reply_to=get("reply_to_provider_message_id"),
		interactive=_interactive_payload(mt, get("interactive")),
	)


def _interactive_payload(message_type: str, value: Any) -> dict | None:
	if message_type not in ("Buttons", "List") or not value:
		return None
	from whatsapp_next.services import interactive

	return interactive.to_provider(message_type, value)


def build_messages(
	items: list[frappe._dict], platform_device: str
) -> tuple[list[NormalizedMessage], list[tuple[frappe._dict, Exception]]]:
	"""Messages for claimed items; rows whose build fails (missing file, bad poll) come back as
	`(item, exception)` so the caller dead-letters them instead of aborting the batch."""
	names = [i.outbound_message for i in items]
	docs = {d.name: d for d in frappe.get_all("WhatsApp Log", filters={"name": ("in", names)}, fields=["*"])}
	messages: list[NormalizedMessage] = []
	failed: list[tuple[frappe._dict, Exception]] = []
	for item in items:
		try:
			messages.append(
				build_message(docs[item.outbound_message], platform_device, priority=cint(item.priority) or 5)
			)
		except Exception as exc:
			failed.append((item, exc))
	return messages, failed


def _backoff_delay(attempts: int) -> int:
	base = cint(_settings().retry_backoff_seconds) or 300
	delay = base * (2 ** max(0, attempts - 1))
	jitter = delay * BACKOFF_JITTER
	return int(delay + random.uniform(-jitter, jitter))


def _item(name: str) -> frappe._dict:
	row = frappe.db.get_value(
		"WhatsApp Queue Item",
		name,
		["name", "outbound_message", "campaign", "attempts", "max_attempts", "status", "device"],
		as_dict=True,
	)
	if not row:
		frappe.throw(_("Queue Item {0} not found").format(name), WANotFoundError)
	return row


def _set(doctype: str, name: str, values: dict[str, Any]) -> None:
	frappe.db.set_value(doctype, name, values, update_modified=True)


def _dead_letter(item: frappe._dict, reason: str, code: str, *, at) -> None:
	_set(
		"WhatsApp Queue Item",
		item.name,
		{
			"status": "Dead Letter",
			"dead_letter_reason": reason[:500],
			"last_error_code": code,
			"last_error": reason[:500],
			"completed_at": at,
		},
	)
	_set(
		"WhatsApp Log",
		item.outbound_message,
		{
			"status": "Failed",
			"failed_at": at,
			"error_code": code,
			"error_message": reason[:500],
			"attempts": cint(item.attempts) + 1,
		},
	)
	_publish_message_status(item.outbound_message, "Failed", at, code)


def _retry_later(
	item: frappe._dict, reason: str, code: str, *, at, count_attempt: bool = True, delay: int | None = None
) -> str:
	attempts = cint(item.attempts) + (1 if count_attempt else 0)
	max_attempts = min(
		cint(item.get("max_attempts")) or cint(_settings().max_attempts) or 1, MAX_AUTOMATIC_ATTEMPTS
	)
	if count_attempt and attempts >= max_attempts:
		_dead_letter(item, reason, code, at=at)
		return "Dead Letter"
	next_at = add_to_date(at, seconds=delay if delay is not None else _backoff_delay(max(attempts, 1)))
	_set(
		"WhatsApp Queue Item",
		item.name,
		{
			"status": "Queued",
			"attempts": attempts,
			"next_attempt_at": next_at,
			"last_error_code": code,
			"last_error": reason[:500],
			"job_id": None,
			"claimed_at": None,
		},
	)
	_set(
		"WhatsApp Log",
		item.outbound_message,
		{"status": "Queued", "attempts": attempts, "error_code": code, "error_message": reason[:500]},
	)
	return "Queued"


def apply_batch_result(items: list[frappe._dict], result: BatchResult) -> dict[str, int]:
	"""Apply a provider `BatchResult` to the claimed items. Accepted → Queue Item `Completed`,
	outbound stays `Sending` (or `Held`) until webhooks; errors → retry with backoff or dead
	letter by `errors.classify`. Returns counters."""
	now = now_datetime()
	by_ref = {i.outbound_message: i for i in items}
	counts = {"accepted": 0, "held": 0, "retry": 0, "dead": 0}
	with status_writer():
		for acc in result.accepted:
			item = by_ref.pop(acc.client_ref, None)
			if not item:
				continue
			_set(
				"WhatsApp Queue Item",
				item.name,
				{
					"status": "Completed",
					"platform_queue_id": acc.queue_id,
					"batch_id": result.batch_id,
					"completed_at": now,
					"attempts": cint(item.attempts) + 1,
				},
			)
			values: dict[str, Any] = {"platform_queue_id": acc.queue_id, "attempts": cint(item.attempts) + 1}
			if acc.status == "Held":
				values.update({"status": "Held", "held_at": now, "held_reason": "held by platform"})
				counts["held"] += 1
			else:
				counts["accepted"] += 1
			_set("WhatsApp Log", item.outbound_message, values)
		for err in result.errors:
			item = by_ref.pop(err.client_ref, None) if err.client_ref else None
			if not item:
				continue
			cls = errors.classify(err.error, provider_code=err.code)
			if cls.retryable:
				outcome = _retry_later(item, cls.message or err.error, cls.code, at=now)
				counts["dead" if outcome == "Dead Letter" else "retry"] += 1
			else:
				_dead_letter(item, cls.message or err.error, cls.code, at=now)
				counts["dead"] += 1
		# Rows the provider did not mention at all: treat as transient, retry.
		for item in by_ref.values():
			outcome = _retry_later(item, "no result from provider for this message", "timeout", at=now)
			counts["dead" if outcome == "Dead Letter" else "retry"] += 1
	return counts


def apply_call_failure(items: list[frappe._dict], exc: Exception, *, device: str) -> str:
	"""Whole-call failure: every claimed row back to `Queued` with backoff, attempts unchanged.
	`DeviceOfflineError` also flips the device; `AuthError` marks Settings `connection_status`."""
	now = now_datetime()
	cls = errors.classify(exc)
	delay = None
	if isinstance(exc, pex.RateLimitError) and getattr(exc, "retry_after", None):
		delay = cint(exc.retry_after)
	with status_writer():
		for item in items:
			_retry_later(item, cls.message or str(exc), cls.code, at=now, count_attempt=False, delay=delay)
	if isinstance(exc, pex.DeviceOfflineError):
		from whatsapp_next.services import devices

		devices.apply_state(device, "Disconnected", source="dispatch", reason=cls.message)
	if isinstance(exc, pex.AuthError):
		frappe.db.set_single_value(
			"WhatsApp Settings", {"connection_status": "Failed", "last_connection_error": cls.message[:500]}
		)
		frappe.log_error(
			title="WhatsApp dispatch: provider auth failed", message=f"device={device} code={exc.code}"
		)
	return cls.code


def dispatch_device_batch(device: str) -> dict[str, int]:
	"""Job (`short`, `wa-dispatch-{device}`): claim → build → `send_batch` → apply. Returns counters."""
	settings = _settings()
	if cint(settings.queue_paused):
		return {"skipped": 1}
	dev = frappe.db.get_value(
		"WhatsApp Device", device, ["status", "disabled", "platform_device"], as_dict=True
	)
	if not dev or dev.status != "Connected" or cint(dev.disabled) or not dev.platform_device:
		return {"skipped": 1}
	rate = cint(settings.messages_per_minute) or 20
	limit = min(rate - sent_this_minute(device), CLAIM_HARD_CAP)
	items = claim_batch(device, limit)
	if not items:
		return {"claimed": 0}
	frappe.db.commit()  # the claim is visible to other workers before the HTTP call
	messages, build_failures = build_messages(items, dev.platform_device)
	now = now_datetime()
	with status_writer():
		for item, exc in build_failures:
			cls = errors.classify(exc)
			_dead_letter(
				item,
				cls.message or str(exc),
				cls.code if cls.code != "unknown" else "platform_rejected",
				at=now,
			)
	counts: dict[str, int] = {"claimed": len(items), "build_failed": len(build_failures)}
	if messages:
		sendable = [i for i in items if i.outbound_message in {m.client_ref for m in messages}]
		batch_id = f"{device}-{uuid.uuid4().hex[:12]}"
		try:
			result = registry.get_provider().send_batch(messages, batch_id)
		except pex.ProviderError as exc:
			counts["call_failure"] = 1
			counts["error_code"] = apply_call_failure(sendable, exc, device=device)  # type: ignore[assignment]
		else:
			counts.update(apply_batch_result(sendable, result))
	frappe.db.commit()
	publish_progress(device)
	campaigns = {i.campaign for i in items if i.campaign}
	for campaign in campaigns:
		frappe.enqueue(
			"whatsapp_next.services.campaign_runner.refresh_counters",
			campaign=campaign,
			queue="short",
			job_id=f"wa-camp-cnt-{campaign}",
			deduplicate=True,
			timeout=60,
		)
	_kick_followup(device, counts)
	return counts


def _due_now(device: str) -> bool:
	"""Whether a non-campaign row of `device` is due and waiting. Campaign rows are left to the
	tick: their `messages_per_minute` is a cap per batch, and a batch after a batch would lift it."""
	now = now_datetime()
	Q = frappe.qb.DocType("WhatsApp Queue Item")
	return bool(
		frappe.qb.from_(Q)
		.select(Q.name)
		.where((Q.status == "Queued") & (Q.device == device) & (Q.scheduled_at <= now) & Q.campaign.isnull())
		.where(Q.next_attempt_at.isnull() | (Q.next_attempt_at <= now))
		.limit(1)
		.run()
	)


def _kick_followup(device: str, counts: dict[str, int]) -> None:
	"""A message queued while this batch was running asked for a batch and was refused — the job
	id was taken by the very batch that had already claimed its rows — so it waited for the next
	tick: a receipt went out 171 s after its row, beside a thank-you sent in 4 s (live business
	test 2026-10-01). When this batch did send and such a row is waiting, one more batch is asked
	for. It stops by itself: a batch that claims nothing (the rate is used up, the queue is
	paused, the device is down) or whose call failed asks for nothing."""
	if frappe.flags.in_test and not frappe.flags.wa_kick_dispatch_in_test:
		return
	if not counts.get("claimed") or counts.get("call_failure") or not _due_now(device):
		return
	frappe.enqueue(
		"whatsapp_next.services.dispatch.dispatch_device_batch",
		device=device,
		queue="short",
		job_id=f"wa-dispatch-{device}-next",
		deduplicate=True,
		enqueue_after_commit=True,
		timeout=300,
	)


# ---- status application (webhooks / reconcile / test send) --------------------------------

_STATUS_TIMESTAMP = {
	"Sent": "sent_at",
	"Delivered": "delivered_at",
	"Read": "read_at",
	"Failed": "failed_at",
	"Cancelled": "cancelled_at",
	"Held": "held_at",
}


def apply_status(
	outbound: str,
	status: str,
	*,
	at=None,
	provider_message_id: str | None = None,
	platform_message_log: str | None = None,
	error_code: str | None = None,
	reason: str | None = None,
	source: str = "webhook",
) -> bool:
	"""Apply a delivery status to an outbound row, forward-only. Returns True when written.

	`Failed` after hand-over is final (no auto-retry, D-029 OQ-4). `Held` is only applied from
	`Sending`/`Queued`; a later `Sent`/`Failed` resolves it."""
	if status not in OUTBOUND_STATUSES:
		frappe.throw(_("Unknown outbound status {0}").format(status), WAValidationError)
	# A locking read: `message.sent` and `message.delivered` arrive within milliseconds and are
	# handled by different workers. Read without the lock, both saw `Sending`, and whichever
	# wrote last won — a delivered message went back to `Sent` with its `delivered_at` filled.
	row = frappe.db.get_value(
		"WhatsApp Log",
		outbound,
		[
			"status", "campaign", "device", "provider_message_id", "platform_message_log", "sent_at", "delivered_at",
			"message_type", "poll_id",
		],
		as_dict=True,
		for_update=True,
	)
	if not row:
		return False
	current = row.status
	if current in ("Failed", "Cancelled"):
		return False
	if (
		status in _DELIVERY_RANK
		and current in _DELIVERY_RANK
		and _DELIVERY_RANK[status] < _DELIVERY_RANK[current]
	):
		return False
	repeat = status == current
	if repeat and not (
		(provider_message_id and provider_message_id != row.provider_message_id)
		or (platform_message_log and platform_message_log != row.platform_message_log)
	):
		return False  # the same receipt again (a platform retry under a new event id): nothing new
	at = get_datetime(at) if at else now_datetime()
	values: dict[str, Any] = {"status": status}
	# a repeated status only completes the ids: its time stays the first receipt's
	if status in _STATUS_TIMESTAMP and not repeat:
		values[_STATUS_TIMESTAMP[status]] = at
	# read means delivered, and delivered means sent: a receipt that overtakes the one before it
	# fills the gap, so "Sent at" is never empty on a message the recipient already has
	if status == "Read" and not row.delivered_at:
		values["delivered_at"] = at
	if status in ("Delivered", "Read") and not row.sent_at:
		values["sent_at"] = at
	if provider_message_id:
		values["provider_message_id"] = provider_message_id
		# a poll is asked for by the id of the message that carried it: nothing ever wrote `poll_id`,
		# so a campaign's poll results read "sent to 0" and could not collect a vote
		if row.message_type == "Poll" and not row.poll_id:
			values["poll_id"] = provider_message_id
	if platform_message_log:
		values["platform_message_log"] = platform_message_log
	if status == "Failed":
		values["error_code"] = error_code or "unknown"
		values["error_message"] = (reason or "")[:500] or None
	if status == "Held":
		values["held_reason"] = (reason or "held by platform")[:500]
	if status == "Sent" and current == "Held":
		values["held_reason"] = None
	with status_writer():
		_set("WhatsApp Log", outbound, values)
		if status == "Failed":
			_close_queue_item(outbound, values["error_code"], values["error_message"])
	_publish_message_status(outbound, status, at, error_code, campaign=row.campaign, device=row.device)
	# the document the message was about says so on its own timeline: once when it first went out,
	# and once if it failed (owner, 2026-10-08)
	if (status in ("Sent", "Delivered", "Read") and not row.sent_at) or (status == "Failed" and current != "Failed"):
		comment_on_reference(outbound, "Failed" if status == "Failed" else "Sent", reason=values.get("error_message"))
	if row.campaign:
		# the batch hand-off counted these rows while still `Sending`: count them again now that
		# the platform has answered, which also closes the campaign once nothing is left open
		frappe.enqueue(
			"whatsapp_next.services.campaign_runner.refresh_counters",
			campaign=row.campaign,
			queue="short",
			job_id=f"wa-camp-cnt-{row.campaign}",
			deduplicate=True,
			enqueue_after_commit=True,
			timeout=60,
		)
	return True


def comment_on_reference(outbound: str, outcome: str, *, reason: str | None = None) -> None:
	"""A line on the timeline of the document a message was about: "WhatsApp message sent to …"
	or "… could not be sent", linking the message. Tests and simulations write none, a message
	about no document writes none, and a comment never stands in the way of a status: it never
	raises."""
	try:
		log = frappe.db.get_value(
			"WhatsApp Log",
			outbound,
			["reference_doctype", "reference_name", "phone_e164", "phone", "display_name", "is_test", "is_simulated"],
			as_dict=True,
		)
		if not log or log.is_test or log.is_simulated or not log.reference_doctype or not log.reference_name:
			return
		if not frappe.db.exists(log.reference_doctype, log.reference_name):
			return
		to = log.phone_e164 or log.phone or ""
		who = f"{log.display_name} ({to})" if log.display_name and to else (log.display_name or to)
		link = frappe.utils.get_link_to_form("WhatsApp Log", outbound, _("view the message"))
		if outcome == "Failed":
			text = _("WhatsApp message to {0} could not be sent: {1}. {2}").format(
				frappe.utils.escape_html(who), frappe.utils.escape_html(reason or _("unknown reason")), link
			)
		else:
			text = _("WhatsApp message sent to {0}. {1}").format(frappe.utils.escape_html(who), link)
		frappe.get_doc(
			{
				"doctype": "Comment",
				"comment_type": "Info",
				"reference_doctype": log.reference_doctype,
				"reference_name": log.reference_name,
				"content": text,
			}
		).insert(ignore_permissions=True)
	except Exception:
		frappe.log_error(title="WhatsApp document comment")


def _close_queue_item(outbound: str, code: str, reason: str | None) -> None:
	"""A message the platform took (its Queue Item `Completed`) and failed later: the Queue Item
	goes to `Dead Letter` with the platform's own error, as a failure at hand-over already does
	(`_dead_letter`), so the queue and the message never tell two different stories."""
	item = frappe.db.get_value("WhatsApp Queue Item", {"outbound_message": outbound, "status": "Completed"})
	if item:
		_set(
			"WhatsApp Queue Item",
			item,
			{
				"status": "Dead Letter",
				"dead_letter_reason": (reason or code)[:500],
				"last_error_code": code,
				"last_error": (reason or "")[:500] or None,
			},
		)


def _publish_message_status(
	outbound: str,
	status: str,
	at,
	error_code: str | None = None,
	*,
	campaign: str | None = None,
	device: str | None = None,
) -> None:
	payload = {
		"outbound": outbound,
		"status": status,
		"at": str(at),
		"error_code": error_code,
		"campaign": campaign,
		"device": device,
	}
	frappe.publish_realtime("wa:message:status", payload, after_commit=True)
	frappe.publish_realtime(
		"wa:message:status", payload, doctype="WhatsApp Log", docname=outbound, after_commit=True
	)


def send_test_message(outbound: str) -> SendResult:
	"""Job (`short`, `wa-test-{outbound}`): `send_now` for an `is_test` row (D-024)."""
	return send_now(outbound, source="test")


def send_now(outbound: str, *, source: str = "direct") -> SendResult:
	"""One synchronous `send_message`, bypassing the queue, its rate and its batching: test sends
	(D-024) and the router's automatic replies (receipt, unknown command), which the sender must
	get at once. Runs inside a job, never a web request. Outbound goes `Sending → Sent | Failed`."""
	doc = frappe.get_doc("WhatsApp Log", outbound)
	platform_device = frappe.db.get_value("WhatsApp Device", doc.device, "platform_device")
	if not platform_device:
		frappe.throw(
			_("Device {0} is not registered on the platform").format(doc.device), WADeviceOfflineError
		)
	with status_writer():
		_set("WhatsApp Log", outbound, {"status": "Sending", "attempts": cint(doc.attempts) + 1})
	try:
		result = registry.get_provider().send_message(build_message(doc, platform_device, priority=1))
	except pex.ProviderError as exc:
		cls = errors.classify(exc)
		apply_status(outbound, "Failed", error_code=cls.code, reason=cls.message, source=source)
		if isinstance(exc, pex.DeviceOfflineError):
			from whatsapp_next.services import devices

			devices.apply_state(doc.device, "Disconnected", source="dispatch", reason=cls.message)
		return SendResult(ok=False, rejected=False, reason=cls.message, code=cls.code)
	if result.ok:
		apply_status(
			outbound,
			"Sent",
			provider_message_id=result.provider_message_id,
			platform_message_log=result.platform_message_log,
			source=source,
		)
		if result.device_fallback:
			frappe.db.set_value("WhatsApp Log", outbound, {"device_fallback": 1}, update_modified=False)
	else:
		cls = errors.classify(result.reason, provider_code=result.code)
		apply_status(
			outbound,
			"Failed",
			error_code=cls.code,
			reason=cls.message,
			platform_message_log=result.platform_message_log,
			source=source,
		)
	return result


# ---- queue management (rows) --------------------------------------------------------------


def _select_items(filters: dict[str, Any] | list[str] | None, statuses: Iterable[str]) -> list[frappe._dict]:
	"""The selection's rows still in `statuses`, locked until the request commits.

	Every caller changes the status of what it reads. Without the lock a row `claim_batch` took
	between this read and the write (`Queued → Sending`) was paused, or deleted and its message
	marked Cancelled, while the platform was already sending it. `claim_batch` skips locked rows
	and a locking read sees the claim once it commits, so neither side waits on the other for long."""
	if isinstance(filters, list | tuple | set):
		names = list(filters)
		if not names:
			return []
		flt: dict[str, Any] = {"name": ("in", names)}
	else:
		flt = dict(filters or {})
	flt["status"] = ("in", list(statuses))
	return frappe.db.get_values(
		"WhatsApp Queue Item",
		flt,
		["name", "outbound_message", "campaign", "status", "device"],
		as_dict=True,
		for_update=True,
		order_by="creation asc",
	)


def pause_items(
	filters: dict[str, Any] | list[str], user: str | None = None, reason: str | None = None
) -> int:
	"""`Queued → Paused` for the selection; audited `Queue Paused` with the count."""
	rows = _select_items(filters, ["Queued"])
	if not rows:
		return 0
	now = now_datetime()
	with status_writer():
		for r in rows:
			_set(
				"WhatsApp Queue Item",
				r.name,
				{
					"status": "Paused",
					"paused_by": user or frappe.session.user,
					"paused_at": now,
					"pause_reason": reason,
				},
			)
	audit.log("Queue Paused", count=len(rows), reason=reason, user=user, details={"scope": "items"})
	publish_progress(None, force=True)
	return len(rows)


def resume_items(filters: dict[str, Any] | list[str], user: str | None = None) -> int:
	"""`Paused → Queued`; audited `Queue Resumed`."""
	rows = _select_items(filters, ["Paused"])
	if not rows:
		return 0
	with status_writer():
		for r in rows:
			_set(
				"WhatsApp Queue Item",
				r.name,
				{
					"status": "Queued",
					"paused_by": None,
					"paused_at": None,
					"pause_reason": None,
					"next_attempt_at": None,
				},
			)
	audit.log("Queue Resumed", count=len(rows), user=user, details={"scope": "items"})
	publish_progress(None, force=True)
	return len(rows)


def delete_items(
	filters: dict[str, Any] | list[str], user: str | None = None, reason: str | None = None
) -> int:
	"""`Queued|Paused → Deleted` (state, never a row removal); outbound `Cancelled`. `Sending`
	rows in the selection raise `WAStateConflictError`."""
	if isinstance(filters, list | tuple | set):
		sending = _select_items(filters, ["Sending"])
		if sending:
			frappe.throw(
				_("{0} item(s) are being sent and cannot be deleted").format(len(sending)),
				WAStateConflictError,
			)
	rows = _select_items(filters, ["Queued", "Paused"])
	if not rows:
		return 0
	now = now_datetime()
	with status_writer():
		for r in rows:
			_set(
				"WhatsApp Queue Item",
				r.name,
				{
					"status": "Deleted",
					"deleted_by": user or frappe.session.user,
					"deleted_at": now,
					"delete_reason": reason,
				},
			)
			_set("WhatsApp Log", r.outbound_message, {"status": "Cancelled", "cancelled_at": now})
			_publish_message_status(
				r.outbound_message, "Cancelled", now, campaign=r.campaign, device=r.device
			)
	recipients = frappe.get_all(
		"WhatsApp Log",
		filters={"name": ("in", [r.outbound_message for r in rows]), "campaign_recipient": ("is", "set")},
		fields=["campaign_recipient"],
	)
	for rec in recipients:
		if frappe.db.exists("WhatsApp Campaign Recipient", rec.campaign_recipient):
			with status_writer():
				frappe.db.set_value(
					"WhatsApp Campaign Recipient",
					rec.campaign_recipient,
					"status",
					"Cancelled",
					update_modified=False,
				)
	audit.log("Queue Items Deleted", count=len(rows), reason=reason, user=user)
	publish_progress(None, force=True)
	return len(rows)


def retry_dead_letter(names: Iterable[str], user: str | None = None) -> int:
	"""`Dead Letter → Queued` with `attempts = 0`; outbound back to `Queued`. Audited."""
	rows = _select_items(list(names), ["Dead Letter"])
	if not rows:
		return 0
	with status_writer():
		for r in rows:
			_set(
				"WhatsApp Queue Item",
				r.name,
				{
					"status": "Queued",
					"attempts": 0,
					"next_attempt_at": None,
					"dead_letter_reason": None,
					"last_error_code": None,
					"last_error": None,
					"job_id": None,
					"claimed_at": None,
					# `_dead_letter` stamps the give-up time here; a row back in the queue has not
					# completed, and the drawer read the stale stamp as "handed to the platform"
					"completed_at": None,
				},
			)
			_set(
				"WhatsApp Log",
				r.outbound_message,
				{"status": "Queued", "error_code": None, "error_message": None, "failed_at": None},
			)
			_publish_message_status(r.outbound_message, "Queued", now_datetime(), campaign=r.campaign, device=r.device)
	audit.log("Queue Items Retried", count=len(rows), user=user)
	publish_progress(None, force=True)
	return len(rows)


# ---- global pause / rate ------------------------------------------------------------------


def pause_queue(user: str | None = None, reason: str | None = None) -> None:
	"""Global pause: `Settings.queue_paused = 1`; rows stay `Queued`. Audited, realtime."""
	now = now_datetime()
	frappe.db.set_single_value(
		"WhatsApp Settings",
		{
			"queue_paused": 1,
			"queue_paused_by": user or frappe.session.user,
			"queue_paused_at": now,
			"queue_pause_reason": reason,
		},
	)
	frappe.clear_document_cache("WhatsApp Settings", "WhatsApp Settings")
	audit.log("Queue Paused", reason=reason, user=user, details={"scope": "global"})
	publish_progress(None, force=True)


def resume_queue(user: str | None = None) -> None:
	frappe.db.set_single_value(
		"WhatsApp Settings",
		{"queue_paused": 0, "queue_paused_by": None, "queue_paused_at": None, "queue_pause_reason": None},
	)
	frappe.clear_document_cache("WhatsApp Settings", "WhatsApp Settings")
	audit.log("Queue Resumed", user=user, details={"scope": "global"})
	publish_progress(None, force=True)


def set_rate(messages_per_minute: int, user: str | None = None) -> int:
	"""Bound the global rate to 5–60 and to the plan's rate when known; audited."""
	rate = cint(messages_per_minute)
	plan_rate = cint(_settings().plan_messages_per_minute)
	upper = min(RATE_MAX, plan_rate) if plan_rate else RATE_MAX
	if rate < RATE_MIN or rate > upper:
		frappe.throw(
			_("Rate must be between {0} and {1} messages per minute").format(RATE_MIN, upper),
			WAValidationError,
		)
	frappe.db.set_single_value("WhatsApp Settings", "messages_per_minute", rate)
	frappe.clear_document_cache("WhatsApp Settings", "WhatsApp Settings")
	audit.log("Queue Rate Changed", user=user, details={"messages_per_minute": rate})
	return rate


def queue_summary(device: str | None = None) -> dict[str, Any]:
	"""Counts by status (+ pause state) for the Queue summary card and realtime ticks."""
	Q = frappe.qb.DocType("WhatsApp Queue Item")
	from frappe.query_builder.functions import Count

	q = frappe.qb.from_(Q).select(Q.status, Count("*").as_("n")).groupby(Q.status)
	if device:
		q = q.where(Q.device == device)
	counts = {s: 0 for s in QUEUE_STATUSES}
	for r in q.run(as_dict=True):
		counts[r.status] = cint(r.n)
	held = frappe.db.count("WhatsApp Log", {"status": "Held", **({"device": device} if device else {})})
	s = _settings()
	return {
		"device": device,
		"queued": counts["Queued"],
		"sending": counts["Sending"],
		"paused": counts["Paused"],
		"dead_letter": counts["Dead Letter"],
		"completed": counts["Completed"],
		"held": held,
		"sent_last_minute": sent_this_minute(device) if device else None,
		"paused_globally": bool(cint(s.queue_paused)),
		"paused_by": s.queue_paused_by,
		"paused_at": s.queue_paused_at,
		"pause_reason": s.queue_pause_reason,
		"rate": cint(s.messages_per_minute),
		"plan_rate": cint(s.plan_messages_per_minute) or None,
	}


def publish_progress(device: str | None, *, force: bool = False) -> None:
	"""`wa:queue:progress` (site room), throttled to one tick per second per device."""
	key = f"wa:progress:{device or '_all'}"
	if not force and frappe.cache.get_value(key):
		return
	frappe.cache.set_value(key, 1, expires_in_sec=PROGRESS_THROTTLE_SECONDS)
	frappe.publish_realtime("wa:queue:progress", queue_summary(device), after_commit=True)


PLATFORM_QUEUE_CACHE_KEY = "wa:platform_queue"
PLATFORM_QUEUE_TTL = 60


def platform_queue_status() -> dict[str, Any] | None:
	"""The provider's own queue view (`get_queue_status`), cached 60 s; `None` when unavailable."""
	cached = frappe.cache.get_value(PLATFORM_QUEUE_CACHE_KEY)
	if cached:
		return cached
	try:
		state = registry.get_provider().get_queue_status()
	except pex.ProviderError as exc:
		frappe.log_error(title="WhatsApp platform queue status failed", message=f"code={exc.code}")
		return None
	data = {
		"counts": dict(state.counts or {}),
		"messages_per_minute": cint(state.messages_per_minute),
		"messages_remaining": cint(state.messages_remaining),
		"held_reason": state.held_reason,
		"fetched_at": str(now_datetime()),
	}
	frappe.cache.set_value(PLATFORM_QUEUE_CACHE_KEY, data, expires_in_sec=PLATFORM_QUEUE_TTL)
	return data


def queue_position(row: dict[str, Any]) -> int | None:
	"""1-based rank of a `Queued` row among the `Queued` rows of its device, ordered by
	`(priority, scheduled_at, creation)` — the order `claim_batch` uses. `None` for other states."""
	if row.get("status") != "Queued":
		return None
	Q = frappe.qb.DocType("WhatsApp Queue Item")
	from frappe.query_builder.functions import Count

	priority = cint(row.get("priority"))
	scheduled_at = get_datetime(row.get("scheduled_at"))
	creation = get_datetime(row.get("creation"))
	ahead = (
		frappe.qb.from_(Q)
		.select(Count("*").as_("n"))
		.where((Q.status == "Queued") & (Q.device == row.get("device")))
		.where(
			(Q.priority < priority)
			| ((Q.priority == priority) & (Q.scheduled_at < scheduled_at))
			| ((Q.priority == priority) & (Q.scheduled_at == scheduled_at) & (Q.creation < creation))
		)
		.run()
	)
	return cint(ahead[0][0]) + 1


# ---- resend / cancel of one row (api.messages) --------------------------------------------

# Content and source fields copied verbatim from the original row on a resend.
RESEND_COPY_FIELDS: tuple[str, ...] = (
	"message_type",
	"body",
	"caption",
	"attachment",
	"file_name",
	"mime_type",
	"print_format",
	"letter_head",
	"language",
	"poll_question",
	"poll_options",
	"template",
	"source_type",
	"reference_doctype",
	"reference_name",
	"campaign",
	"campaign_recipient",
	"campaign_message_idx",
	"notification",
	"notification_alert",
	"command",
	"trigger_inbound",
	"display_name",
	"contact",
)


def resend_outbound(outbound: str, *, user: str | None = None) -> tuple[str, str]:
	"""New `WhatsApp Log` from a **terminal** row (content, source and reference copied,
	`attempts` 0) queued at the source's priority; returns `(new_outbound, queue_item)`.

	Non-terminal rows raise `WAStateConflictError`; unknown names `WANotFoundError`."""
	row = frappe.db.get_value("WhatsApp Log", outbound, "*", as_dict=True)
	if not row:
		frappe.throw(_("WhatsApp Log {0} not found").format(outbound), WANotFoundError)
	if row.status not in OUTBOUND_TERMINAL:
		frappe.throw(
			_("Only sent, failed or cancelled messages can be resent (this one is {0})").format(
				_(row.status)
			),
			WAStateConflictError,
		)
	is_group = row.recipient_type == "Group"
	spec = OutboundSpec(
		device=row.requested_device or row.device,
		phone=None if is_group else (row.phone_e164 or row.phone),
		jid=row.jid if is_group else None,
		recipient_type=row.recipient_type,
		view_once=bool(cint(row.view_once)),
		poll_allow_multiple=bool(cint(row.poll_allow_multiple)),
		location=(
			{
				"latitude": row.location_latitude,
				"longitude": row.location_longitude,
				"name": row.location_name,
				"address": row.location_address,
			}
			if row.message_type == "Location"
			else None
		),
		**{f: row.get(f) for f in RESEND_COPY_FIELDS},
	)
	new = create_outbound(spec, user=user)
	items = enqueue([new])
	return new, items[0]


def cancel_outbound(outbound: str, *, user: str | None = None, reason: str | None = None) -> str:
	"""Delete-as-state the open queue rows of one outbound (`delete_items`); returns the
	outbound's resulting status. `Sending` raises `WAStateConflictError`; a row with no open
	queue item cannot be cancelled either."""
	if not frappe.db.exists("WhatsApp Log", outbound):
		frappe.throw(_("WhatsApp Log {0} not found").format(outbound), WANotFoundError)
	items = frappe.get_all(
		"WhatsApp Queue Item",
		filters={"outbound_message": outbound, "status": ("in", list(QUEUE_OPEN))},
		pluck="name",
	)
	if not items:
		frappe.throw(
			_("Message {0} is not queued and cannot be cancelled").format(outbound), WAStateConflictError
		)
	delete_items(items, user=user, reason=reason)
	return frappe.db.get_value("WhatsApp Log", outbound, "status")

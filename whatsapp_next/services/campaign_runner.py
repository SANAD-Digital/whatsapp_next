# Module role: campaign lifecycle (backend-plan §3 `campaign_runner.py`, fields.md §7 status
# machine). The **status writer** for `WhatsApp Campaign` and its recipient rows: start /
# schedule / promote / pause / resume / cancel, materialization (recipients × messages → outbound
# + queue rows in bulk, PDFs rendered here, one Numbers refresh for the whole set), counters from
# one grouped query, and finalization. Sending itself is the dispatcher's job.

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import frappe
from frappe import _
from frappe.query_builder.functions import Count, Max
from frappe.utils import add_to_date, cint, get_datetime, now_datetime

from whatsapp_next.exceptions import WAStateConflictError, WAValidationError
from whatsapp_next.services import attachments, audit, dispatch, numbers_materializer, polls, templates
from whatsapp_next.services.dispatch import OutboundSpec
from whatsapp_next.services.guards import status_writer
from whatsapp_next.services.phone import key_for

STATUSES = ("Draft", "Scheduled", "Queued", "Running", "Paused", "Completed", "Partially Failed", "Cancelled")
TERMINAL = frozenset({"Completed", "Partially Failed", "Cancelled"})
EDITABLE = frozenset({"Draft", "Scheduled"})
OPEN_OUTBOUND = frozenset({"Unsent", "Queued", "Sending", "Held"})
MATERIALIZE_BATCH = 500

_TRANSITIONS: dict[str, frozenset[str]] = {
	"Draft": frozenset({"Scheduled", "Queued", "Cancelled"}),
	"Scheduled": frozenset({"Queued", "Draft", "Cancelled"}),
	"Queued": frozenset({"Running", "Cancelled", "Completed", "Partially Failed"}),
	"Running": frozenset({"Paused", "Completed", "Partially Failed", "Cancelled"}),
	"Paused": frozenset({"Running", "Cancelled"}),
}

_RECIPIENT_BY_OUTBOUND = {
	"Queued": "Queued",
	"Sending": "Queued",
	"Sent": "Sent",
	"Delivered": "Delivered",
	"Read": "Read",
	"Failed": "Failed",
	"Cancelled": "Cancelled",
	"Held": "Queued",
	"Unsent": "Queued",
}


@dataclass
class Counters:
	total: int = 0
	queued: int = 0
	sent: int = 0
	delivered: int = 0
	read: int = 0
	failed: int = 0
	cancelled: int = 0
	open: int = 0

	def as_values(self) -> dict[str, int]:
		return {
			"queued_count": self.queued,
			"sent_count": self.sent,
			"delivered_count": self.delivered,
			"read_count": self.read,
			"failed_count": self.failed,
			"cancelled_count": self.cancelled,
		}


# ---- status writer ---------------------------------------------------------------------


def _doc(campaign: str):
	if not frappe.db.exists("WhatsApp Campaign", campaign):
		frappe.throw(_("WhatsApp Campaign {0} not found").format(campaign), WAValidationError)
	return frappe.get_doc("WhatsApp Campaign", campaign)


def set_status(campaign: str, status: str, **values: Any) -> str:
	"""Transition the campaign (validated against the machine) and publish `wa:campaign:status`."""
	current = frappe.db.get_value("WhatsApp Campaign", campaign, "status")
	if current is None:
		frappe.throw(_("WhatsApp Campaign {0} not found").format(campaign), WAValidationError)
	if status != current and status not in _TRANSITIONS.get(current, frozenset()):
		frappe.throw(
			_("Campaign {0} cannot go from {1} to {2}").format(campaign, _(current), _(status)),
			WAStateConflictError,
		)
	with status_writer():
		frappe.db.set_value("WhatsApp Campaign", campaign, {"status": status, **values}, update_modified=True)
	frappe.clear_document_cache("WhatsApp Campaign", campaign)
	_publish(campaign, status)
	return status


def _publish(campaign: str, status: str, counters: Counters | None = None) -> None:
	payload = {"campaign": campaign, "status": status, "counters": counters.__dict__ if counters else None}
	frappe.publish_realtime(
		"wa:campaign:status", payload, doctype="WhatsApp Campaign", docname=campaign, after_commit=True
	)
	frappe.publish_realtime("wa:campaign:status", payload, after_commit=True)


# ---- lifecycle -------------------------------------------------------------------------


def _check_startable(doc) -> None:
	if not doc.get("messages"):
		frappe.throw(_("Campaign has no messages"), WAValidationError)
	active = [r for r in doc.get("recipients") or [] if r.status != "Removed"]
	if not active:
		frappe.throw(_("Campaign has no recipients"), WAValidationError)
	device = doc.device or frappe.get_cached_doc("WhatsApp Settings").default_device
	if not device:
		frappe.throw(_("Choose a device for the campaign"), WAValidationError)


def start(campaign: str, user: str | None = None) -> str:
	"""`Draft|Scheduled → Queued` now; materialization runs in a `long` job."""
	doc = _doc(campaign)
	if doc.status not in EDITABLE:
		frappe.throw(_("Campaign {0} is {1}").format(campaign, _(doc.status)), WAStateConflictError)
	_check_startable(doc)
	set_status(
		campaign,
		"Queued",
		started_at=now_datetime(),
		started_by=user or frappe.session.user,
		scheduled_at=doc.scheduled_at or now_datetime(),
	)
	audit.log(
		"Campaign Started",
		reference=("WhatsApp Campaign", campaign),
		user=user,
		count=len([r for r in doc.recipients if r.status != "Removed"]),
	)
	frappe.enqueue(
		"whatsapp_next.services.campaign_runner.materialize",
		campaign=campaign,
		queue="long",
		job_id=f"wa-campaign-{campaign}",
		deduplicate=True,
		enqueue_after_commit=True,
		timeout=3600,
	)
	return "Queued"


def schedule(campaign: str, at, user: str | None = None) -> str:
	"""`Draft → Scheduled` at a future time; `promote_scheduled` starts it."""
	doc = _doc(campaign)
	if doc.status != "Draft":
		frappe.throw(_("Only Draft campaigns can be scheduled"), WAStateConflictError)
	when = get_datetime(at)
	if not when or when <= now_datetime():
		frappe.throw(_("Scheduled time must be in the future"), WAValidationError)
	_check_startable(doc)
	set_status(campaign, "Scheduled", scheduled_at=when)
	return "Scheduled"


def unschedule(campaign: str, user: str | None = None) -> str:
	if frappe.db.get_value("WhatsApp Campaign", campaign, "status") != "Scheduled":
		frappe.throw(_("Campaign is not scheduled"), WAStateConflictError)
	return set_status(campaign, "Draft", scheduled_at=None)


def promote_scheduled() -> list[str]:
	"""Cron `* * * * *`: start every `Scheduled` campaign whose time has come."""
	due = frappe.get_all(
		"WhatsApp Campaign",
		filters={"status": "Scheduled", "scheduled_at": ("<=", now_datetime())},
		pluck="name",
	)
	for name in due:
		try:
			start(name, user="Administrator")
		except Exception:
			frappe.log_error(title="WhatsApp campaign: promote failed", message=name)
	return due


def pause(campaign: str, user: str | None = None, reason: str | None = None) -> int:
	"""`Running → Paused`: the campaign's open queue rows become `Paused`."""
	if frappe.db.get_value("WhatsApp Campaign", campaign, "status") not in ("Running", "Queued"):
		frappe.throw(_("Only a running campaign can be paused"), WAStateConflictError)
	if frappe.db.get_value("WhatsApp Campaign", campaign, "status") == "Queued":
		set_status(campaign, "Running")
	n = dispatch.pause_items(
		{"campaign": campaign}, user=user, reason=reason or f"campaign {campaign} paused"
	)
	set_status(
		campaign,
		"Paused",
		paused_at=now_datetime(),
		paused_by=user or frappe.session.user,
		pause_reason=reason,
	)
	frappe.db.set_value(
		"WhatsApp Campaign",
		campaign,
		"pause_count",
		cint(frappe.db.get_value("WhatsApp Campaign", campaign, "pause_count")) + 1,
		update_modified=False,
	)
	audit.log("Campaign Paused", reference=("WhatsApp Campaign", campaign), user=user, reason=reason, count=n)
	return n


def resume(campaign: str, user: str | None = None) -> int:
	if frappe.db.get_value("WhatsApp Campaign", campaign, "status") != "Paused":
		frappe.throw(_("Campaign is not paused"), WAStateConflictError)
	n = dispatch.resume_items({"campaign": campaign}, user=user)
	set_status(campaign, "Running", paused_at=None, paused_by=None, pause_reason=None)
	audit.log("Campaign Resumed", reference=("WhatsApp Campaign", campaign), user=user, count=n)
	return n


def cancel(campaign: str, user: str | None = None, reason: str | None = None) -> int:
	"""Any non-terminal status → `Cancelled`; open queue rows → `Deleted` (outbound `Cancelled`)."""
	status = frappe.db.get_value("WhatsApp Campaign", campaign, "status")
	if status in TERMINAL:
		frappe.throw(_("Campaign {0} is already {1}").format(campaign, _(status)), WAStateConflictError)
	n = dispatch.delete_items(
		{"campaign": campaign}, user=user, reason=reason or f"campaign {campaign} cancelled"
	)
	set_status(
		campaign,
		"Cancelled",
		cancelled_at=now_datetime(),
		cancelled_by=user or frappe.session.user,
		cancel_reason=reason,
		ended_at=now_datetime(),
	)
	with status_writer():
		frappe.db.set_value(
			"WhatsApp Campaign Recipient",
			{"parent": campaign, "parenttype": "WhatsApp Campaign", "status": ("in", ["Pending", "Queued"])},
			"status",
			"Cancelled",
			update_modified=False,
		)
	audit.log(
		"Campaign Cancelled", reference=("WhatsApp Campaign", campaign), user=user, reason=reason, count=n
	)
	refresh_counters(campaign)
	return n


# ---- materialization ---------------------------------------------------------------------


def _render_message_body(msg, recipient, campaign_doc) -> str | None:
	source = msg.body
	if not source and msg.template:
		source = frappe.db.get_value("WhatsApp Template", msg.template, "body")
	if not source:
		return None
	ctx = templates.context_for(
		None,
		None,
		{"campaign": frappe._dict(name=campaign_doc.name, campaign_name=campaign_doc.campaign_name)},
		doc=frappe._dict(),
		recipient={
			"phone_e164": recipient.phone_e164,
			"display_name": recipient.display_name,
			"contact": recipient.contact,
			"source_doctype": recipient.source_doctype,
			"source_name": recipient.source_name,
		},
	)
	if (
		recipient.source_doctype
		and recipient.source_name
		and frappe.db.exists(recipient.source_doctype, recipient.source_name)
	):
		ctx["doc"] = frappe.get_doc(recipient.source_doctype, recipient.source_name)
	return templates.render_text(source, ctx, fallback=source)


def _recipient_attachment(msg, recipient, campaign_doc) -> dict[str, Any]:
	"""Per-recipient Document render (Print Format over the recipient's source document) or
	the campaign's shared attachment."""
	if (
		msg.message_type == "Document"
		and msg.print_format
		and recipient.source_doctype
		and recipient.source_name
	):
		pdf = attachments.render_print_pdf(
			recipient.source_doctype,
			recipient.source_name,
			print_format=msg.print_format,
			file_name=templates.render_text(
				msg.file_name_template,
				{"doc": frappe._dict(name=recipient.source_name), "recipient": recipient},
				fallback=recipient.source_name,
			),
		)
		url = attachments.save_private_file(
			pdf.content, pdf.file_name, ("WhatsApp Campaign", campaign_doc.name)
		)
		return {"attachment": url, "file_name": pdf.file_name, "mime_type": pdf.mime_type}
	return {"attachment": msg.attachment}


def materialize(campaign: str) -> dict[str, int]:
	"""Job (`long`): one outbound + queue row per (recipient × message), inserted in batches
	with commits; scheduled_at staggered by cumulative `delay_seconds`; `Queued → Running`."""
	doc = _doc(campaign)
	if doc.status != "Queued":
		return {"skipped": 1}
	set_status(campaign, "Running")
	counts = _materialize_recipients(
		doc, [r for r in doc.recipients if r.status == "Pending" and not r.outbound_message]
	)
	frappe.db.set_value(
		"WhatsApp Campaign",
		campaign,
		{
			"initial_recipients": cint(
				frappe.db.get_value("WhatsApp Campaign", campaign, "initial_recipients")
			)
			or counts["recipients"],
			"first_message_at": now_datetime() if counts["created"] else None,
		},
		update_modified=False,
	)
	refresh_counters(campaign)
	frappe.db.commit()
	return counts


def materialize_pending(campaign: str) -> dict[str, int]:
	"""Job (`long`): recipients added while `Running`/`Paused` (still `Pending`) get their rows."""
	doc = _doc(campaign)
	if doc.status not in ("Running", "Paused"):
		return {"skipped": 1}
	counts = _materialize_recipients(
		doc, [r for r in doc.recipients if r.status == "Pending" and not r.outbound_message]
	)
	if doc.status == "Paused" and counts["created"]:
		dispatch.pause_items({"campaign": campaign, "status": "Queued"}, reason=f"campaign {campaign} paused")
	refresh_counters(campaign)
	frappe.db.commit()
	return counts


def _materialize_recipients(doc, recipients) -> dict[str, int]:
	campaign = doc.name
	device = doc.device or frappe.get_cached_doc("WhatsApp Settings").default_device
	exclude_unknown = cint(doc.exclude_unknown_numbers)
	base = (
		get_datetime(doc.scheduled_at)
		if doc.scheduled_at and get_datetime(doc.scheduled_at) > now_datetime()
		else now_datetime()
	)
	counts = {"recipients": len(recipients), "created": 0, "skipped_unknown": 0, "failed": 0}
	keys = [key_for(r.phone_e164, r.jid) for r in recipients]
	known: set[str] = set()
	if exclude_unknown:
		from whatsapp_next.services import read_layer

		known = read_layer.known_keys([k for k in keys if k])
	created_batch: list[str] = []
	for idx, recipient in enumerate(recipients):
		key = keys[idx]
		if exclude_unknown and recipient.recipient_type != "Group" and key not in known:
			with status_writer():
				frappe.db.set_value(
					"WhatsApp Campaign Recipient",
					recipient.name,
					{"status": "Cancelled", "error_code": "unknown_number_policy"},
					update_modified=False,
				)
			counts["skipped_unknown"] += 1
			continue
		offset = 0
		first_outbound = None
		for m_idx, msg in enumerate(doc.messages, start=1):
			offset += cint(msg.delay_seconds)
			spec = OutboundSpec(
				device=device,
				phone=recipient.phone_e164,
				jid=recipient.jid,
				message_type=msg.message_type,
				body=_render_message_body(msg, recipient, doc),
				caption=msg.caption,
				poll_question=msg.poll_question,
				poll_options=polls.parse_options(msg.poll_options),
				poll_allow_multiple=bool(cint(msg.poll_allow_multiple)),
				source_type="Campaign",
				campaign=campaign,
				campaign_recipient=recipient.name,
				campaign_message_idx=m_idx,
				display_name=recipient.display_name,
				contact=recipient.contact,
				scheduled_at=add_to_date(base, seconds=offset),
				skip_policy=True,
			)
			try:
				spec.__dict__.update(_recipient_attachment(msg, recipient, doc))
				name = dispatch.create_outbound(spec)
				dispatch.enqueue([name], priority=5, scheduled_at=spec.scheduled_at)
			except Exception as exc:
				counts["failed"] += 1
				frappe.log_error(
					title="WhatsApp campaign: message not created",
					message=f"campaign={campaign} recipient={recipient.name} msg={m_idx} "
					f"{type(exc).__name__}\n{frappe.get_traceback()}",
				)
				continue
			first_outbound = first_outbound or name
			created_batch.append(name)
			counts["created"] += 1
		with status_writer():
			frappe.db.set_value(
				"WhatsApp Campaign Recipient",
				recipient.name,
				{"status": "Queued" if first_outbound else "Failed", "outbound_message": first_outbound},
				update_modified=False,
			)
		if len(created_batch) >= MATERIALIZE_BATCH:
			frappe.db.commit()
			created_batch = []
	frappe.db.commit()
	numbers_materializer.refresh_keys([k for k in keys if k])
	return counts


# ---- counters / finalization ------------------------------------------------------------


def counters_for(campaign: str) -> Counters:
	L = frappe.qb.DocType("WhatsApp Log")
	rows = (
		frappe.qb.from_(L)
		.select(L.status, Count("*").as_("n"))
		.where(L.campaign == campaign)
		.groupby(L.status)
		.run(as_dict=True)
	)
	c = Counters()
	for r in rows:
		n = cint(r.n)
		c.total += n
		if r.status in ("Queued", "Sending", "Unsent", "Held"):
			c.queued += n
			c.open += n
		elif r.status == "Sent":
			c.sent += n
		elif r.status == "Delivered":
			c.delivered += n
		elif r.status == "Read":
			c.read += n
		elif r.status == "Failed":
			c.failed += n
		elif r.status == "Cancelled":
			c.cancelled += n
	return c


def refresh_counters(campaign: str) -> Counters:
	"""Job (`short`, `wa-camp-cnt-{name}`): grouped count → campaign counters and recipient
	statuses; then `finalize_if_done`."""
	c = counters_for(campaign)
	L = frappe.qb.DocType("WhatsApp Log")
	last_row = (
		frappe.qb.from_(L)
		.select(Max(L.sent_at).as_("last"))
		.where((L.campaign == campaign) & L.status.isin(["Sent", "Delivered", "Read"]))
		.run(as_dict=True)
	)
	last = last_row[0].last if last_row else None
	frappe.db.set_value(
		"WhatsApp Campaign", campaign, {**c.as_values(), "last_message_at": last}, update_modified=False
	)
	_sync_recipient_statuses(campaign)
	_publish(campaign, frappe.db.get_value("WhatsApp Campaign", campaign, "status"), c)
	finalize_if_done(campaign, counters=c)
	return c


def _sync_recipient_statuses(campaign: str) -> None:
	"""Recipient status mirrors its first outbound (the recipient's "worst" message)."""
	rows = frappe.get_all(
		"WhatsApp Log",
		filters={"campaign": campaign, "campaign_recipient": ("is", "set")},
		fields=["campaign_recipient", "status"],
	)
	by_recipient: dict[str, list[str]] = {}
	for r in rows:
		by_recipient.setdefault(r.campaign_recipient, []).append(r.status)
	rank = ["Failed", "Cancelled", "Queued", "Sent", "Delivered", "Read"]
	for recipient, statuses in by_recipient.items():
		mapped = [_RECIPIENT_BY_OUTBOUND.get(s, "Queued") for s in statuses]
		worst = min(mapped, key=lambda s: rank.index(s) if s in rank else 99)
		with status_writer():
			frappe.db.set_value(
				"WhatsApp Campaign Recipient", recipient, "status", worst, update_modified=False
			)


def finalize_if_done(campaign: str, counters: Counters | None = None) -> bool:
	"""`Running` with no open outbound → `Completed` (no failures) or `Partially Failed`."""
	status = frappe.db.get_value("WhatsApp Campaign", campaign, "status")
	if status not in ("Running", "Queued"):
		return False
	c = counters or counters_for(campaign)
	if c.total == 0 or c.open:
		return False
	if frappe.db.count(
		"WhatsApp Campaign Recipient",
		{"parent": campaign, "parenttype": "WhatsApp Campaign", "status": "Pending"},
	):
		return False
	final = "Completed" if c.failed == 0 else "Partially Failed"
	set_status(campaign, final, ended_at=now_datetime())
	return True


def sending_now() -> list[dict[str, Any]]:
	"""Campaigns `Running`/`Queued` with live counters (Home / list stats card)."""
	out = []
	for r in frappe.get_all(
		"WhatsApp Campaign",
		filters={"status": ("in", ["Running", "Queued", "Paused"])},
		fields=[
			"name",
			"campaign_name",
			"status",
			"device",
			"total_recipients",
			"sent_count",
			"failed_count",
			"queued_count",
			"started_at",
		],
	):
		out.append({**r, "counters": counters_for(r.name).__dict__})
	return out


# ---- read helpers for api.campaigns --------------------------------------------------------

PROGRESS_FIELDS: tuple[str, ...] = (
	"name",
	"campaign_name",
	"status",
	"device",
	"scheduled_at",
	"messages_per_minute",
	"total_recipients",
	"initial_recipients",
	"added_count",
	"removed_count",
	"pause_count",
	"started_at",
	"ended_at",
	"paused_at",
	"paused_by",
	"pause_reason",
	"first_message_at",
	"last_message_at",
)
RECENT_LIMIT = 10
POLL_CACHE_SECONDS = 600


def progress(campaign: str) -> dict[str, Any]:
	"""Live counters, rates (configured rate, sent in the last minute, percent done, ETA) and the
	`RECENT_LIMIT` most recently changed outbound rows of one campaign."""
	row = frappe.db.get_value("WhatsApp Campaign", campaign, list(PROGRESS_FIELDS), as_dict=True)
	if not row:
		frappe.throw(_("WhatsApp Campaign {0} not found").format(campaign), WAValidationError)
	c = counters_for(campaign)
	rate = cint(row.messages_per_minute) or cint(
		frappe.get_cached_doc("WhatsApp Settings").messages_per_minute
	)
	since = add_to_date(now_datetime(), seconds=-60)
	sent_last_minute = frappe.db.count(
		"WhatsApp Log",
		{"campaign": campaign, "status": ("in", ["Sent", "Delivered", "Read"]), "sent_at": (">=", since)},
	)
	done = c.total - c.open
	recent = frappe.get_all(
		"WhatsApp Log",
		filters={"campaign": campaign},
		fields=[
			"name",
			"phone_e164",
			"display_name",
			"status",
			"message_type",
			"campaign_message_idx",
			"sent_at",
			"failed_at",
			"error_code",
			"modified",
		],
		order_by="modified desc",
		limit=RECENT_LIMIT,
	)
	return {
		**row,
		"counters": dict(c.__dict__),
		"rates": {
			"messages_per_minute": rate,
			"sent_last_minute": cint(sent_last_minute),
			"percent": round(done * 100 / c.total, 1) if c.total else 0.0,
			"eta_seconds": int(c.open * 60 / rate) if rate and c.open else 0,
		},
		"recent": recent,
	}


def preview_message(campaign: str, idx: int, recipient_row: str | None = None) -> dict[str, Any]:
	"""Render message `idx` (1-based) of the campaign as one recipient would receive it —
	`recipient_row` is a recipient child-row name, else a sample recipient — with the attachment
	(or rendered document) file name and compile errors of the source."""
	doc = _doc(campaign)
	messages = doc.get("messages") or []
	idx = cint(idx)
	if idx < 1 or idx > len(messages):
		frappe.throw(_("Campaign has no message {0}").format(idx), WAValidationError)
	msg = messages[idx - 1]
	recipient = None
	if recipient_row:
		recipient = next((r for r in doc.get("recipients") or [] if r.name == recipient_row), None)
		if recipient is None:
			frappe.throw(_("Recipient row {0} not found").format(recipient_row), WAValidationError)
	if recipient is None:
		recipient = frappe._dict(
			phone_e164="+966500000000",
			display_name=_("Recipient"),
			contact=None,
			source_doctype=None,
			source_name=None,
		)
	source = msg.body or (
		frappe.db.get_value("WhatsApp Template", msg.template, "body") if msg.template else None
	)
	attachment_name = None
	if msg.attachment:
		attachment_name = (
			frappe.db.get_value("File", {"file_url": msg.attachment}, "file_name") or msg.attachment
		)
	elif msg.message_type == "Document" and msg.print_format:
		attachment_name = templates.render_text(
			msg.file_name_template,
			{"doc": frappe._dict(name=recipient.source_name), "recipient": recipient},
			fallback=recipient.source_name or msg.print_format,
		)
	return {
		"idx": idx,
		"message_type": msg.message_type,
		"body": _render_message_body(msg, recipient, doc),
		"attachment_name": attachment_name,
		"errors": templates.compile_check(source),
	}


def poll_results(campaign: str, *, refresh: bool = False) -> dict[str, Any]:
	"""Aggregated poll results per Poll message of the campaign (`polls.fetch_results` over the
	sent rows' `poll_id`), cached `POLL_CACHE_SECONDS` unless `refresh`."""
	key = f"wa:poll-results:{campaign}"
	if not refresh:
		cached = frappe.cache.get_value(key)
		if cached:
			return cached
	doc = _doc(campaign)
	poll_messages = {
		i: m for i, m in enumerate(doc.get("messages") or [], start=1) if m.message_type == "Poll"
	}
	out: dict[str, Any] = {"campaign": campaign, "fetched_at": now_datetime(), "results": []}
	if not poll_messages:
		return out
	device = doc.device or frappe.get_cached_doc("WhatsApp Settings").default_device
	platform_device = frappe.db.get_value("WhatsApp Device", device, "platform_device") if device else None
	if not platform_device:
		frappe.throw(_("Campaign device is not registered on the platform"), WAValidationError)
	rows = frappe.get_all(
		"WhatsApp Log",
		filters={"campaign": campaign, "message_type": "Poll", "poll_id": ("is", "set")},
		fields=["poll_id", "campaign_message_idx"],
	)
	ids_by_idx: dict[int, list[str]] = {}
	for r in rows:
		ids_by_idx.setdefault(cint(r.campaign_message_idx) or 1, []).append(r.poll_id)
	for idx, msg in poll_messages.items():
		options = polls.parse_options(msg.poll_options)
		ids = ids_by_idx.get(idx, [])
		res = (
			polls.fetch_results(platform_device, ids, options) if ids else polls.PollResults(options=options)
		)
		out["results"].append({"idx": idx, "question": msg.poll_question, "sent": len(ids), **res.as_dict()})
	frappe.cache.set_value(key, out, expires_in_sec=POLL_CACHE_SECONDS)
	return out

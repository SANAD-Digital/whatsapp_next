# Module role: API of the Campaigns screen (backend-plan §4.6 `campaigns.*`, screen 6). Thin
# wrappers over services/campaign_runner.py — the single status writer of WhatsApp Campaign —
# plus read helpers (progress, sending-now card, recipients page, message preview, poll
# results). Writes need the Manager role **and** write permission on the campaign document.
# `pause_many` / `resume_many` / `cancel_many` are the 09 G-01 additive bulk variants.

from __future__ import annotations

from collections.abc import Callable
from datetime import datetime
from typing import Any

import json

import frappe
from frappe import _
from frappe.query_builder.functions import Count
from frappe.utils import add_to_date, cint, now_datetime

from whatsapp_next.api._common import api_endpoint, paginate
from whatsapp_next.api.v1 import _bulk
from whatsapp_next.api.v1._roles import MANAGER, VIEWER_UP
from whatsapp_next.exceptions import WANotFoundError, WAPermissionError, WAValidationError
from whatsapp_next.services import campaign_runner as runner

RECIPIENT_FIELDS: tuple[str, ...] = (
	"name",
	"idx",
	"recipient_type",
	"phone",
	"phone_e164",
	"jid",
	"display_name",
	"contact",
	"source_type",
	"contact_group",
	"source_doctype",
	"source_name",
	"status",
	"outbound_message",
	"error_code",
	"added_by",
	"added_at",
	"removed_by",
	"removed_at",
)
RECIPIENT_STATUSES = ("Pending", "Queued", "Sent", "Delivered", "Read", "Failed", "Cancelled", "Removed")
ORDERABLE_RECIPIENT_FIELDS = ("idx", "display_name", "phone_e164", "status", "source_type", "added_at")
SOURCE_TYPES = ("Contact Group", "Contact", "DocType", "Excel", "vCard", "Manual")


def _require(name: str, ptype: str) -> None:
	"""Existence (`WANotFoundError`) + document permission (`WAPermissionError`) on a campaign."""
	if not frappe.db.exists("WhatsApp Campaign", name):
		frappe.throw(_("WhatsApp Campaign {0} not found").format(name), WANotFoundError)
	if not frappe.has_permission("WhatsApp Campaign", ptype, doc=name):
		frappe.throw(_("Not permitted to {0} campaign {1}").format(_(ptype), name), WAPermissionError)


def _status(name: str) -> str:
	return frappe.db.get_value("WhatsApp Campaign", name, "status")


# ---- lifecycle -------------------------------------------------------------------------


@api_endpoint(roles=MANAGER)
def start(name: str) -> dict[str, Any]:
	"""`Draft | Scheduled → Queued` now; materialization runs in a `long` job → `{status}`.
	`WAStateConflictError` in any other status, `WAValidationError` when not startable."""
	_require(name, "write")
	return {"status": runner.start(name, user=frappe.session.user)}


@api_endpoint(roles=MANAGER)
def schedule(name: str, scheduled_at: datetime) -> dict[str, Any]:
	"""`Draft → Scheduled` at a future time → `{status, scheduled_at}`."""
	_require(name, "write")
	status = runner.schedule(name, scheduled_at, user=frappe.session.user)
	return {"status": status, "scheduled_at": frappe.db.get_value("WhatsApp Campaign", name, "scheduled_at")}


@api_endpoint(roles=MANAGER)
def unschedule(name: str) -> dict[str, Any]:
	"""`Scheduled → Draft` → `{status}`."""
	_require(name, "write")
	return {"status": runner.unschedule(name, user=frappe.session.user)}


@api_endpoint(roles=MANAGER)
def pause(name: str, reason: str | None = None) -> dict[str, Any]:
	"""`Running → Paused`; open queue rows paused → `{status, count}`; audited."""
	_require(name, "write")
	count = runner.pause(name, user=frappe.session.user, reason=reason)
	return {"status": _status(name), "count": count}


@api_endpoint(roles=MANAGER)
def resume(name: str) -> dict[str, Any]:
	"""`Paused → Running`; paused queue rows resumed → `{status, count}`; audited."""
	_require(name, "write")
	count = runner.resume(name, user=frappe.session.user)
	return {"status": _status(name), "count": count}


@api_endpoint(roles=MANAGER)
def cancel(name: str, reason: str | None = None) -> dict[str, Any]:
	"""Any non-terminal status → `Cancelled`; open queue rows deleted-as-state → `{status, count}`."""
	_require(name, "write")
	count = runner.cancel(name, user=frappe.session.user, reason=reason)
	return {"status": _status(name), "count": count}


def _many(names: list[str], applies: Callable[[str], bool], action: Callable[[str], int]) -> dict[str, Any]:
	"""Bulk helper (09 G-01) over `_bulk.run_bulk`: campaigns whose status does not apply are
	reported in `skipped`; each action runs in its own savepoint."""

	def one(name: str) -> None:
		status = _status(name)
		if status is None:
			frappe.throw(_("WhatsApp Campaign {0} not found").format(name), WANotFoundError)
		if not applies(status):
			raise _bulk.Skip(status)
		_require(name, "write")
		action(name)

	return _bulk.run_bulk(names, one)


@api_endpoint(roles=MANAGER)
def pause_many(names: list[str], reason: str | None = None) -> dict[str, Any]:
	"""Pause every `Running` / `Queued` campaign in `names` (others skipped)."""
	return _many(
		names,
		lambda s: s in ("Running", "Queued"),
		lambda n: runner.pause(n, user=frappe.session.user, reason=reason),
	)


@api_endpoint(roles=MANAGER)
def resume_many(names: list[str]) -> dict[str, Any]:
	"""Resume every `Paused` campaign in `names` (others skipped)."""
	return _many(names, lambda s: s == "Paused", lambda n: runner.resume(n, user=frappe.session.user))


@api_endpoint(roles=MANAGER)
def cancel_many(names: list[str], reason: str | None = None) -> dict[str, Any]:
	"""Cancel every non-terminal campaign in `names` (terminal ones skipped)."""
	return _many(
		names,
		lambda s: s not in runner.TERMINAL,
		lambda n: runner.cancel(n, user=frappe.session.user, reason=reason),
	)


# ---- reads -----------------------------------------------------------------------------


@api_endpoint(roles=VIEWER_UP, methods=("GET", "POST"))
def get_progress(name: str) -> dict[str, Any]:
	"""Campaign fields + `counters{}` + `rates{messages_per_minute, sent_last_minute, percent,
	eta_seconds}` + `recent[]` (last changed outbound rows)."""
	_require(name, "read")
	return runner.progress(name)


@api_endpoint(roles=VIEWER_UP, methods=("GET", "POST"))
def get_overview(days: int = 30) -> dict[str, Any]:
	"""What every campaign together is doing — the console's metric row.

	`states` counts campaigns by status; `in_flight` is the recipients of the active campaigns
	that have neither been sent nor failed; `per_minute` is what campaign messages actually
	achieved over the last hour; `totals` are the recipients, sent, delivered, read and failed of
	the campaigns started in the last `days` (1–365), which is what the delivery and read rates
	are a share of.
	"""
	window = max(1, min(cint(days) or 30, 365))
	since = add_to_date(now_datetime(), days=-window)

	states: dict[str, int] = dict.fromkeys(runner.STATUSES, 0)
	C = frappe.qb.DocType("WhatsApp Campaign")
	for row in frappe.qb.from_(C).select(C.status, Count("*").as_("n")).groupby(C.status).run(as_dict=True):
		states[row["status"]] = cint(row["n"])

	active = frappe.get_all(
		"WhatsApp Campaign",
		filters={"status": ("in", ("Running", "Queued", "Paused"))},
		fields=["total_recipients", "sent_count", "failed_count"],
		limit_page_length=0,
	)
	in_flight = sum(max(0, cint(r.total_recipients) - cint(r.sent_count) - cint(r.failed_count)) for r in active)

	# The campaign counters are four disjoint buckets: a message that was read is not also counted
	# as sent. The rates a console shows are stage shares, so the buckets are rolled up here —
	# `sent` is everything that left, `delivered` everything that arrived (read included).
	totals = {"recipients": 0, "sent": 0, "delivered": 0, "read": 0, "failed": 0}
	for row in frappe.get_all(
		"WhatsApp Campaign",
		filters={"started_at": (">=", since)},
		fields=[
			"total_recipients",
			"sent_count",
			"delivered_count",
			"read_count",
			"failed_count",
		],
		limit_page_length=0,
	):
		totals["recipients"] += cint(row.total_recipients)
		totals["sent"] += cint(row.sent_count) + cint(row.delivered_count) + cint(row.read_count)
		totals["delivered"] += cint(row.delivered_count) + cint(row.read_count)
		totals["read"] += cint(row.read_count)
		totals["failed"] += cint(row.failed_count)

	# what campaign sending actually achieved in the last hour, not the rate someone configured
	L = frappe.qb.DocType("WhatsApp Log")
	sent_last_hour = cint(
		(
			frappe.qb.from_(L)
			.select(Count("*"))
			.where(L.campaign.notnull() & (L.sent_at >= add_to_date(now_datetime(), minutes=-60)))
		).run()[0][0]
	)

	return {
		"days": window,
		"states": states,
		"in_flight": in_flight,
		"sent_last_hour": sent_last_hour,
		"per_minute": round(sent_last_hour / 60, 2),
		"totals": totals,
	}


@api_endpoint(roles=VIEWER_UP, methods=("GET", "POST"))
def get_sending_now() -> list[dict[str, Any]]:
	"""Campaigns `Running` / `Queued` / `Paused` with live counters (list stats card)."""
	return runner.sending_now()


def _one_or_many(name: str, value: Any, allowed: tuple[str, ...]) -> list[str]:
	"""A filter value as the list it filters on: `None`/"" → `[]`, a string → `[it]`, a JSON list
	string or a list → its members; anything outside `allowed` is refused."""
	if value in (None, "", [], ()):
		return []
	if isinstance(value, str) and value.lstrip().startswith("["):
		try:
			value = json.loads(value)
		except ValueError:
			frappe.throw(_("Invalid value for {0}").format(name), WAValidationError)
	values = [value] if isinstance(value, str) else list(value)
	bad = [v for v in values if v not in allowed]
	if bad:
		frappe.throw(_("Invalid value for {0}: {1}").format(name, ", ".join(map(str, bad))), WAValidationError)
	return values


@api_endpoint(
	roles=VIEWER_UP,
	methods=("GET", "POST"),
)
def get_recipients_page(
	name: str,
	status: str | list[str] | None = None,
	source_type: str | list[str] | None = None,
	search: str | None = None,
	page: int = 1,
	page_length: int = 50,
	order_by: str = "idx asc",
) -> dict[str, Any]:
	"""One page of the recipients child table → `{rows, total, counts}`.

	`search` matches phone or name. `status` and `source_type` take one value or a list (a JSON
	list over the wire) — a filter bar with checkboxes asks for several at once. `counts` is every
	status this campaign's recipients hold under the same search and source filter — the panel's
	chips carry them, so the reader sees how many are still pending before choosing a chip, and
	`counts["All"]` is the panel's own total.
	"""
	_require(name, "read")
	filters: list[list[Any]] = [
		["WhatsApp Campaign Recipient", "parent", "=", name],
		["WhatsApp Campaign Recipient", "parenttype", "=", "WhatsApp Campaign"],
	]
	status_in = _one_or_many("status", status, RECIPIENT_STATUSES)
	source_in = _one_or_many("source_type", source_type, SOURCE_TYPES)
	if status_in:
		filters.append(["WhatsApp Campaign Recipient", "status", "in", status_in])
	if source_in:
		filters.append(["WhatsApp Campaign Recipient", "source_type", "in", source_in])
	or_filters: list[list[Any]] = []
	if search:
		like = f"%{search.strip()}%"
		or_filters = [
			["WhatsApp Campaign Recipient", "phone_e164", "like", like],
			["WhatsApp Campaign Recipient", "phone", "like", like],
			["WhatsApp Campaign Recipient", "display_name", "like", like],
		]
	field, _sep, direction = (order_by or "idx asc").strip().partition(" ")
	if field not in ORDERABLE_RECIPIENT_FIELDS or direction.lower() not in ("", "asc", "desc"):
		frappe.throw(_("Cannot order by {0}").format(order_by), WAValidationError)
	start, length = paginate(page, page_length)
	rows = frappe.get_all(
		"WhatsApp Campaign Recipient",
		filters=filters,
		or_filters=or_filters,
		fields=list(RECIPIENT_FIELDS),
		order_by=f"{field} {direction or 'asc'}",
		start=start,
		page_length=length,
	)
	total = frappe.get_all(
		"WhatsApp Campaign Recipient",
		filters=filters,
		or_filters=or_filters,
		fields=[{"COUNT": "name", "as": "n"}],
	)[0].n

	# Each field's counts ignore that field's own filter — a chip has to say how many rows it would
	# show — but keep every other filter and the search, so they describe the rows being looked at.
	counts: dict[str, dict[str, int]] = {}
	for field in ("status", "source_type"):
		own: dict[str, int] = {}
		for row in frappe.get_all(
			"WhatsApp Campaign Recipient",
			filters=[f for f in filters if f[1] != field],
			or_filters=or_filters,
			fields=[field, {"COUNT": "name", "as": "n"}],
			group_by=field,
		):
			own[row[field]] = int(row["n"] or 0)
		own["All"] = sum(own.values())
		counts[field] = own

	return {"rows": rows, "total": int(total or 0), "counts": counts}


@api_endpoint(roles=MANAGER, methods=("GET", "POST"))
def preview_message(name: str, idx: int, recipient_row: str | None = None) -> dict[str, Any]:
	"""Message `idx` (1-based) rendered for `recipient_row` (a recipients child-row name) or a
	sample recipient → `{body, attachment_name, message_type, errors[]}`."""
	_require(name, "read")
	return runner.preview_message(name, idx, recipient_row=recipient_row)


@api_endpoint(roles=MANAGER, methods=("GET", "POST"))
def get_poll_results(name: str, refresh: bool = False) -> dict[str, Any]:
	"""Aggregated poll results per Poll message (cached 10 min unless `refresh`) →
	`{results[{idx, question, options, counts, responses, errors, by_poll_id}]}`."""
	_require(name, "read")
	return runner.poll_results(name, refresh=refresh)


@api_endpoint(roles=VIEWER_UP, methods=("GET", "POST"))
def get_readiness(name: str) -> dict[str, Any]:
	"""The five checks that decide whether the campaign can start → `{ok, status, checks[]}`;
	each check is `{key, ok, …facts}` and the screen writes the sentence."""
	_require(name, "read")
	return runner.readiness(name)


@api_endpoint(roles=VIEWER_UP, methods=("GET", "POST"))
def get_failures(name: str) -> dict[str, Any]:
	"""Failures by `error_code` → `{total, retryable, rows[{error_code, count, share, retryable,
	sample}]}` — what to fix, in the order it costs."""
	_require(name, "read")
	return runner.failures(name)


@api_endpoint(roles=VIEWER_UP, methods=("GET", "POST"))
def get_message_stats(name: str) -> dict[str, Any]:
	"""Each message of the campaign with the counts of its own outbound rows →
	`{rows[{idx, message_type, delay_seconds, preview, attachment, counts{}, total}]}`."""
	_require(name, "read")
	return runner.message_stats(name)


@api_endpoint(roles=VIEWER_UP, methods=("GET", "POST"))
def get_timeline(name: str) -> dict[str, Any]:
	"""What happened to the campaign and when → `{events[{key, at, …}], status}`. Audit events are
	included only for a reader who may read the audit log."""
	_require(name, "read")
	return runner.timeline(name)


@api_endpoint(roles=MANAGER)
def retry_failed(name: str, error_code: str | None = None, limit: int = runner.RETRY_LIMIT) -> dict[str, Any]:
	"""Resend failed messages of the campaign (retryable codes, or one bucket) →
	`{retried, refused, remaining}`. Each resend is a new message row; audited."""
	_require(name, "write")
	return runner.retry_failed(name, error_code=error_code, user=frappe.session.user, limit=cint(limit))

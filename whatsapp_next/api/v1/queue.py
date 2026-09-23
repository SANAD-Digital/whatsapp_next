# Module role: whitelisted endpoints of the Queue screen (backend-plan §4.5 `api.queue`,
# screen 9). Reads `WhatsApp Queue Item` rows with their position / ETA and wraps the
# `services.dispatch` queue operations (global pause / resume / rate, per-row pause / resume /
# delete-as-state / retry). Thin: no state changes outside `dispatch`.

from __future__ import annotations

from typing import Any

import frappe
from frappe import _
from frappe.utils import add_to_date, cint, get_datetime, now_datetime

from whatsapp_next.api._common import api_endpoint, paginate
from whatsapp_next.api.v1._roles import MANAGER, VIEWER_UP
from whatsapp_next.exceptions import WAValidationError
from whatsapp_next.services import dispatch

QUEUE_FIELDS = (
	"name",
	"outbound_message",
	"device",
	"campaign",
	"phone_e164",
	"display_name",
	"priority",
	"scheduled_at",
	"status",
	"attempts",
	"max_attempts",
	"next_attempt_at",
	"last_error_code",
	"last_error",
	"claimed_at",
	"paused_by",
	"paused_at",
	"pause_reason",
	"deleted_by",
	"deleted_at",
	"delete_reason",
	"dead_letter_reason",
	"completed_at",
	"creation",
)
LIST_FILTERS = ("status", "device", "campaign", "phone")
SELECTION_FILTERS = ("device", "campaign", "phone_e164")


def _list_query(filters: dict | None) -> dict[str, Any]:
	f = filters or {}
	unknown = sorted(set(f) - set(LIST_FILTERS))
	if unknown:
		frappe.throw(_("Unknown filters: {0}").format(", ".join(unknown)), WAValidationError)
	query: dict[str, Any] = {}
	if f.get("status"):
		if f["status"] not in dispatch.QUEUE_STATUSES:
			frappe.throw(_("Invalid value for {0}").format("status"), WAValidationError)
		query["status"] = f["status"]
	for key in ("device", "campaign"):
		if f.get(key):
			query[key] = f[key]
	if f.get("phone"):
		query["phone_e164"] = ("like", f"%{f['phone']}%")
	return query


def _selection(names: list[str] | None, filters: dict | None) -> list[str] | dict[str, Any]:
	"""`names[]` wins; otherwise a filter dict restricted to `SELECTION_FILTERS`."""
	if names:
		return list(names)
	f = dict(filters or {})
	unknown = sorted(set(f) - set(SELECTION_FILTERS))
	if unknown or not f:
		frappe.throw(
			_("Provide names[] or filters on {0}").format(", ".join(SELECTION_FILTERS)), WAValidationError
		)
	return f


@api_endpoint(roles=VIEWER_UP, methods=("GET", "POST"))
def list_queue(filters: dict | None = None, page: int = 1, page_length: int = 20) -> dict[str, Any]:
	"""Queue rows (newest first) with `position` (rank among the `Queued` rows of the same device
	over `priority, scheduled_at, creation`) and `eta_minutes` = position ÷ `messages_per_minute`."""
	query = _list_query(filters)
	start, length = paginate(page, page_length)
	rows = frappe.get_all(
		"WhatsApp Queue Item",
		filters=query,
		fields=list(QUEUE_FIELDS),
		order_by="creation desc",
		start=start,
		page_length=length,
	)
	summary = dispatch.queue_summary()
	rate = cint(summary.get("rate")) or dispatch.RATE_MIN
	now = now_datetime()
	for row in rows:
		position = dispatch.queue_position(row)
		row["position"] = position
		row["eta_minutes"] = round(position / rate, 2) if position else None
		row["eta"] = add_to_date(now, minutes=position / rate) if position else None
	return {"rows": rows, "total": frappe.db.count("WhatsApp Queue Item", query), "summary": summary}


@api_endpoint(roles=VIEWER_UP, methods=("GET", "POST"))
def get_summary() -> dict[str, Any]:
	"""Counts by status, global pause state, rate / plan rate and the provider's queue view (60 s cache)."""
	s = dispatch.queue_summary()
	return {
		"counts_by_status": {
			"Queued": s["queued"],
			"Sending": s["sending"],
			"Paused": s["paused"],
			"Dead Letter": s["dead_letter"],
			"Completed": s["completed"],
			"Held": s["held"],
		},
		"paused": s["paused_globally"],
		"paused_by": s["paused_by"],
		"paused_at": s["paused_at"],
		"reason": s["pause_reason"],
		"rate": s["rate"],
		"plan_rate": s["plan_rate"],
		"platform_queue": dispatch.platform_queue_status(),
	}


@api_endpoint(roles=VIEWER_UP, methods=("GET", "POST"))
def get_throughput(minutes: int = 60) -> dict[str, Any]:
	"""What actually left the queue, one bucket per minute over the last `minutes` (5–180).

	The console draws this as a sparkline beside the send rate, so an operator sees whether the
	rate they set is the rate the queue is really achieving. Zero-filled and oldest first.
	"""
	window = max(5, min(cint(minutes) or 60, 180))
	now = now_datetime()
	since = add_to_date(now, minutes=-window)
	rows = frappe.get_all(
		"WhatsApp Queue Item",
		filters={"status": "Completed", "completed_at": (">=", since)},
		fields=["completed_at"],
		limit_page_length=0,
	)
	buckets = [0] * window
	for row in rows:
		at = get_datetime(row.completed_at)
		index = int((now - at).total_seconds() // 60)
		if 0 <= index < window:
			buckets[window - 1 - index] += 1
	sent = sum(buckets)
	return {
		"minutes": window,
		"buckets": buckets,
		"sent": sent,
		"peak": max(buckets) if buckets else 0,
		# the achieved rate over the window, which is what the sparkline is compared against
		"per_minute": round(sent / window, 2),
	}


@api_endpoint(roles=MANAGER)
def pause_queue(reason: str | None = None) -> dict[str, Any]:
	"""Global pause (rows stay `Queued`); audited `Queue Paused`, realtime tick."""
	dispatch.pause_queue(user=frappe.session.user, reason=reason)
	return {"paused_at": frappe.db.get_single_value("WhatsApp Settings", "queue_paused_at")}


@api_endpoint(roles=MANAGER)
def resume_queue() -> dict[str, Any]:
	"""Lift the global pause; audited `Queue Resumed`."""
	dispatch.resume_queue(user=frappe.session.user)
	return {"resumed_at": now_datetime()}


@api_endpoint(roles=MANAGER)
def set_rate(messages_per_minute: int) -> dict[str, Any]:
	"""Global send rate, bounded 5–60 and by the plan rate; audited `Queue Rate Changed`."""
	return {"messages_per_minute": dispatch.set_rate(messages_per_minute, user=frappe.session.user)}


@api_endpoint(roles=MANAGER)
def pause_items(
	names: list[str] | None = None, filters: dict | None = None, reason: str | None = None
) -> dict[str, Any]:
	"""`Queued → Paused` for `names[]` or a filter selection → `{count}`."""
	return {
		"count": dispatch.pause_items(_selection(names, filters), user=frappe.session.user, reason=reason)
	}


@api_endpoint(roles=MANAGER)
def resume_items(names: list[str] | None = None, filters: dict | None = None) -> dict[str, Any]:
	"""`Paused → Queued` for the selection → `{count}`."""
	return {"count": dispatch.resume_items(_selection(names, filters), user=frappe.session.user)}


@api_endpoint(roles=MANAGER)
def delete_items(
	names: list[str] | None = None, filters: dict | None = None, reason: str | None = None
) -> dict[str, Any]:
	"""State `Deleted` (outbound `Cancelled`, recipient `Cancelled`); `WAStateConflictError` when a
	named row is `Sending`; audited `Queue Items Deleted`."""
	return {
		"count": dispatch.delete_items(_selection(names, filters), user=frappe.session.user, reason=reason)
	}


@api_endpoint(roles=MANAGER)
def retry_dead_letter(names: list[str]) -> dict[str, Any]:
	"""`Dead Letter → Queued` with `attempts = 0` → `{count}`; audited `Queue Items Retried`."""
	if not names:
		frappe.throw(_("names[] is required"), WAValidationError)
	return {"count": dispatch.retry_dead_letter(names, user=frappe.session.user)}

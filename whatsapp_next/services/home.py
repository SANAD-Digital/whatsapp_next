# Module role: the Home dashboard's period reads (A-3 of the phase-8 report): exact per-status
# and per-error totals for a period and the one before it, the period's shape per hour / day,
# the scheduled campaigns, the last send and the live feed. Grouping happens in the database
# (`frappe.qb`), so the page draws numbers instead of counting rows it fetched itself.

from __future__ import annotations

from datetime import datetime
from typing import Any

import frappe
from frappe.query_builder.functions import Count, Date, Extract
from frappe.utils import add_days, get_datetime, nowdate
from pypika.enums import DatePart

OUT = "WhatsApp Log"
IN = "WhatsApp Inbound Message"
CAMPAIGN = "WhatsApp Campaign"

# key → (days back from today, grain); the same three periods the page offers
PERIODS: dict[str, tuple[int, str]] = {"today": (0, "hour"), "7d": (6, "day"), "30d": (29, "day")}
FEED_LIMIT = 5
PANEL_LIMIT = 5


def _window(period: str) -> tuple[datetime, datetime, int, str]:
	days, grain = PERIODS[period]
	start = get_datetime(add_days(nowdate(), -days))
	previous_start = get_datetime(add_days(start, -(days + 1)))
	return start, previous_start, days, grain


def _group(field: str, start: datetime, end: datetime | None = None, **equals: Any) -> dict[str, int]:
	log = frappe.qb.DocType(OUT)
	column = log[field]
	query = frappe.qb.from_(log).select(column, Count("*")).where(log.creation >= start).groupby(column)
	if end is not None:
		query = query.where(log.creation < end)
	for fieldname, value in equals.items():
		query = query.where(log[fieldname] == value)
	return {(key if key is not None else ""): int(count) for key, count in query.run()}


def traffic(period: str) -> dict[str, Any]:
	"""`{from, now, previous, errors}` — status totals of the period and of the one before it,
	and the error codes of its failures. Exact."""
	start, previous_start, _days, _grain = _window(period)
	return {
		"from": str(start.date()),
		"now": _group("status", start),
		"previous": _group("status", previous_start, start),
		"errors": _group("error_code", start, status="Failed"),
	}


def series(period: str) -> list[dict[str, Any]]:
	"""`[{key, status, count}]` per hour ("00".."23", today) or per day ("YYYY-MM-DD")."""
	start, _previous, _days, grain = _window(period)
	log = frappe.qb.DocType(OUT)
	bucket = Extract(DatePart.hour, log.creation) if grain == "hour" else Date(log.creation)
	rows = (
		frappe.qb.from_(log)
		.select(bucket.as_("bucket"), log.status, Count("*"))
		.where(log.creation >= start)
		.groupby(bucket, log.status)
		.run()
	)
	out = []
	for key, status, count in rows:
		key = f"{int(key):02d}" if grain == "hour" else str(key)[:10]
		out.append({"key": key, "status": status, "count": int(count)})
	return out


def scheduled_campaigns() -> list[dict[str, Any]]:
	"""Campaigns waiting for their hour (`sending_now` only returns the live ones)."""
	return frappe.get_all(
		CAMPAIGN,
		fields=["name", "campaign_name", "status", "total_recipients", "scheduled_at"],
		filters={"status": "Scheduled"},
		order_by="scheduled_at asc",
		limit=PANEL_LIMIT,
	)


def last_sent():
	"""When a message last left, whatever period is on screen."""
	rows = frappe.get_all(OUT, fields=["sent_at"], filters={"sent_at": ("is", "set")}, order_by="sent_at desc", limit=1)
	return rows[0].sent_at if rows else None


def feed() -> list[dict[str, Any]]:
	"""The last movements in both directions, newest first."""
	out = frappe.get_all(
		OUT,
		fields=["name", "display_name", "phone_e164", "status", "device", "creation", "sent_at"],
		order_by="creation desc",
		limit=FEED_LIMIT,
	)
	inbound = frappe.get_all(
		IN,
		fields=["name", "display_name", "phone_e164", "device", "received_at", "creation"],
		order_by="creation desc",
		limit=FEED_LIMIT,
	)
	rows = [{**r, "doctype": OUT, "direction": "out", "at": r.creation} for r in out] + [
		{**r, "doctype": IN, "direction": "in", "at": r.received_at or r.creation} for r in inbound
	]
	rows.sort(key=lambda r: get_datetime(r["at"]), reverse=True)
	return rows[:FEED_LIMIT]


def activity(period: str) -> dict[str, Any]:
	"""Everything the Home page draws for one period, in one call."""
	return {
		"period": period,
		"traffic": traffic(period),
		"series": series(period),
		"scheduled": scheduled_campaigns(),
		"last_sent": last_sent(),
		"feed": feed(),
	}

# Module role: date helpers for Notification Alert dynamic filters (backend-plan §11). Pure
# functions over the site date; `resolve(token)` turns a manifest token such as `month_start`,
# `last_days:7` or `fiscal_year_end` into a date string for report filters.

from __future__ import annotations

import calendar
from datetime import date, timedelta

import frappe
from frappe.utils import add_days, getdate, nowdate

TOKENS = (
	"today",
	"yesterday",
	"tomorrow",
	"week_start",
	"week_end",
	"month_start",
	"month_end",
	"quarter_start",
	"quarter_end",
	"year_start",
	"year_end",
	"fiscal_year_start",
	"fiscal_year_end",
	"last_days:N",
	"days_ago:N",
	"days_ahead:N",
)


def _today(today: date | str | None = None) -> date:
	return getdate(today) if today else getdate(nowdate())


def relative_date(days: int, today: date | str | None = None) -> date:
	"""`today + days` (negative = past)."""
	return add_days(_today(today), days)


def week_range(today: date | str | None = None, first_weekday: int = 0) -> tuple[date, date]:
	"""Monday–Sunday by default; `first_weekday` 0 = Monday … 6 = Sunday."""
	t = _today(today)
	start = t - timedelta(days=(t.weekday() - first_weekday) % 7)
	return start, start + timedelta(days=6)


def month_range(today: date | str | None = None) -> tuple[date, date]:
	t = _today(today)
	return t.replace(day=1), t.replace(day=calendar.monthrange(t.year, t.month)[1])


def quarter_range(today: date | str | None = None) -> tuple[date, date]:
	t = _today(today)
	q_start_month = ((t.month - 1) // 3) * 3 + 1
	start = t.replace(month=q_start_month, day=1)
	end_month = q_start_month + 2
	return start, t.replace(month=end_month, day=calendar.monthrange(t.year, end_month)[1])


def year_range(today: date | str | None = None) -> tuple[date, date]:
	t = _today(today)
	return t.replace(month=1, day=1), t.replace(month=12, day=31)


def fiscal_year_range(today: date | str | None = None, company: str | None = None) -> tuple[date, date]:
	"""ERPNext Fiscal Year containing `today`; falls back to the calendar year."""
	t = _today(today)
	if frappe.db.exists("DocType", "Fiscal Year"):
		rows = frappe.get_all(
			"Fiscal Year",
			filters={"year_start_date": ("<=", t), "year_end_date": (">=", t), "disabled": 0},
			fields=["year_start_date", "year_end_date"],
			limit=1,
		)
		if rows:
			return getdate(rows[0].year_start_date), getdate(rows[0].year_end_date)
	return year_range(t)


def last_days_range(days: int, today: date | str | None = None) -> tuple[date, date]:
	"""`(today - days + 1, today)` — the last N days including today."""
	t = _today(today)
	return t - timedelta(days=max(int(days), 1) - 1), t


def resolve(token: str | None, today: date | str | None = None) -> str | None:
	"""Token → `YYYY-MM-DD`; unknown tokens are returned unchanged (literal filter values)."""
	if token is None:
		return None
	text = str(token).strip()
	key, _sep, arg = text.partition(":")
	key = key.lower()
	n = int(arg) if arg.strip().lstrip("-").isdigit() else 0
	if key == "today":
		return str(_today(today))
	if key == "yesterday":
		return str(relative_date(-1, today))
	if key == "tomorrow":
		return str(relative_date(1, today))
	if key in ("week_start", "week_end"):
		return str(week_range(today)[0 if key.endswith("start") else 1])
	if key in ("month_start", "month_end"):
		return str(month_range(today)[0 if key.endswith("start") else 1])
	if key in ("quarter_start", "quarter_end"):
		return str(quarter_range(today)[0 if key.endswith("start") else 1])
	if key in ("year_start", "year_end"):
		return str(year_range(today)[0 if key.endswith("start") else 1])
	if key in ("fiscal_year_start", "fiscal_year_end"):
		return str(fiscal_year_range(today)[0 if key.endswith("start") else 1])
	if key == "last_days":
		return str(last_days_range(n or 7, today)[0])
	if key == "days_ago":
		return str(relative_date(-n, today))
	if key == "days_ahead":
		return str(relative_date(n, today))
	return text

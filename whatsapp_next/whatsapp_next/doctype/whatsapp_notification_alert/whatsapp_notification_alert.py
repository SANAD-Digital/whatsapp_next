# Module role: WhatsApp Notification Alert controller — scheduled report digests (D-016, fields.md §22).
# Validation only: report / body / day-of-month / JSON filters / PNG binary (D-029 OQ-E) / recipients, and
# `next_run_at` via `compute_next_run`. Sending lives in `services/alerts.py`.

from __future__ import annotations

import calendar
import json
import shutil
from datetime import datetime, time, timedelta

import frappe
from frappe import _
from frappe.model.document import Document
from frappe.utils import cint, get_datetime, now_datetime

from whatsapp_next.exceptions import WAValidationError
from whatsapp_next.services.phone import set_phone_pair

WEEKDAYS = ("Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday")
MONTHS = (
	"January",
	"February",
	"March",
	"April",
	"May",
	"June",
	"July",
	"August",
	"September",
	"October",
	"November",
	"December",
)
PNG_BINARY = "wkhtmltoimage"


class WhatsAppNotificationAlert(Document):
	"""A report (or static message) sent on a Daily … Yearly schedule."""

	def validate(self) -> None:
		"""Run every rule and recompute `next_run_at`."""
		self.check_content()
		self.check_schedule()
		self.check_json_fields()
		self.check_attachment_format()
		self.normalize_recipients()
		self.next_run_at = self.compute_next_run()

	def check_content(self) -> None:
		"""Report required for Report content; a Template or an inline Message always."""
		if self.content_type == "Report" and not self.report:
			frappe.throw(_("Report is required when Content is Report"), WAValidationError)
		if not self.template and not (self.message or "").strip():
			frappe.throw(_("Choose a Template or write a Message"), WAValidationError)

	def check_schedule(self) -> None:
		"""`day_of_month` 1–28; weekday / month present for the periodicities that need them."""
		if self.periodicity in ("Monthly", "Quarterly", "Yearly") and not 1 <= cint(self.day_of_month) <= 28:
			frappe.throw(_("Day of Month must be between 1 and 28"), WAValidationError)
		if self.periodicity == "Weekly" and self.day_of_week not in WEEKDAYS:
			frappe.throw(_("Day of Week is required for a Weekly alert"), WAValidationError)
		if self.periodicity == "Yearly" and self.month_of_year not in MONTHS:
			frappe.throw(_("Month is required for a Yearly alert"), WAValidationError)
		if not self.notification_time:
			frappe.throw(_("Time is required"), WAValidationError)

	def check_json_fields(self) -> None:
		"""`filters_json` / `dynamic_filters_json` must parse when set."""
		for fieldname in ("filters_json", "dynamic_filters_json"):
			value = (self.get(fieldname) or "").strip()
			if not value:
				continue
			try:
				json.loads(value)
			except ValueError:
				frappe.throw(
					_("{0} must be valid JSON").format(_(self.meta.get_label(fieldname))), WAValidationError
				)

	def check_attachment_format(self) -> None:
		"""PNG attachments need `wkhtmltoimage` on the bench PATH (D-029 OQ-E)."""
		if self.content_type == "Report" and self.attachment_format == "PNG" and not shutil.which(PNG_BINARY):
			frappe.throw(
				_("PNG attachments need {0} installed on the server; choose PDF or None").format(PNG_BINARY),
				WAValidationError,
			)

	def normalize_recipients(self) -> None:
		"""≥ 1 row; Phone rows get the normalized `phone_e164`."""
		rows = self.get("recipients") or []
		if not rows:
			frappe.throw(_("Add at least one recipient"), WAValidationError)
		for row in rows:
			if row.recipient_type == "Phone":
				set_phone_pair(row, "phone", "phone_e164", required=True)

	def compute_next_run(self, now: datetime | None = None) -> datetime:
		"""Next occurrence strictly after `now` (site time) for the configured periodicity."""
		now = get_datetime(now) if now else now_datetime()
		at = _as_time(self.notification_time)
		day = max(1, min(28, cint(self.day_of_month) or 1))
		if self.periodicity == "Weekly":
			candidate = datetime.combine(now.date(), at)
			ahead = (WEEKDAYS.index(self.day_of_week) - now.weekday()) % 7
			candidate += timedelta(days=ahead)
			if candidate <= now:
				candidate += timedelta(days=7)
			return candidate
		if self.periodicity == "Monthly":
			candidate = datetime.combine(now.date().replace(day=day), at)
			if candidate <= now:
				candidate = datetime.combine(_add_months(now.date().replace(day=1), 1).replace(day=day), at)
			return candidate
		if self.periodicity == "Quarterly":
			quarter_start = ((now.month - 1) // 3) * 3 + 1
			candidate = datetime.combine(now.date().replace(month=quarter_start, day=day), at)
			if candidate <= now:
				first = _add_months(now.date().replace(month=quarter_start, day=1), 3)
				candidate = datetime.combine(first.replace(day=day), at)
			return candidate
		if self.periodicity == "Yearly":
			month = MONTHS.index(self.month_of_year) + 1
			candidate = datetime.combine(now.date().replace(month=month, day=day), at)
			if candidate <= now:
				candidate = candidate.replace(year=candidate.year + 1)
			return candidate
		# Daily
		candidate = datetime.combine(now.date(), at)
		if candidate <= now:
			candidate += timedelta(days=1)
		return candidate


def _as_time(value) -> time:
	if isinstance(value, timedelta):
		return (datetime.min + value).time()
	if isinstance(value, time):
		return value
	parts = [int(p) for p in str(value).split(":")[:3]]
	while len(parts) < 3:
		parts.append(0)
	return time(*parts)


def _add_months(day1, months: int):
	month_index = day1.month - 1 + months
	year = day1.year + month_index // 12
	month = month_index % 12 + 1
	return day1.replace(year=year, month=month, day=min(day1.day, calendar.monthrange(year, month)[1]))

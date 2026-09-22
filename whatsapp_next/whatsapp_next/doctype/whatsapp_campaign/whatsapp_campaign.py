# Module role: WhatsApp Campaign controller — validation and lifecycle only (fields.md §7). Start / pause /
# resume / cancel and every status transition live in `services/campaign_runner.py` (the single status
# writer, RC-04); this file rejects edits that the state machine forbids.

from __future__ import annotations

import frappe
from frappe import _
from frappe.model.document import Document
from frappe.utils import cint, now_datetime

from whatsapp_next.exceptions import WAStateConflictError, WAValidationError
from whatsapp_next.services.guards import assert_status_writer
from whatsapp_next.services.phone import set_phone_pair

EDITABLE_STATUSES = ("Draft", "Scheduled")
LOCKED_FIELDS = ("device", "scheduled_at")
MESSAGE_ROW_FIELDS = (
	"message_type",
	"template",
	"body",
	"caption",
	"attachment",
	"print_format",
	"file_name_template",
	"poll_question",
	"poll_options",
	"poll_allow_multiple",
	"delay_seconds",
)


class WhatsAppCampaign(Document):
	"""Bulk send definition: messages × recipients, driven by the campaign runner."""

	def validate(self) -> None:
		"""Messages ≥ 1, recipients normalized, rate ≤ Settings, edit lock outside Draft/Scheduled, status guard."""
		assert_status_writer(self)
		self.check_messages()
		self.normalize_recipients()
		self.check_rate_limit()
		self.check_edit_lock()
		self.total_recipients = len([r for r in self.get("recipients") or [] if r.status != "Removed"])

	def check_messages(self) -> None:
		"""At least one message row."""
		if not self.get("messages"):
			frappe.throw(_("A campaign needs at least one message"), WAValidationError)

	def normalize_recipients(self) -> None:
		"""Fill `phone_e164` (required for Individual rows); Group rows need a `jid`."""
		for row in self.get("recipients") or []:
			is_individual = row.recipient_type != "Group"
			set_phone_pair(row, "phone", "phone_e164", required=is_individual)
			if not is_individual and not (row.jid or "").strip():
				frappe.throw(_("Row {0}: a Group recipient needs a JID").format(row.idx), WAValidationError)
			if not row.added_by:
				row.added_by = frappe.session.user
			if not row.added_at:
				row.added_at = now_datetime()

	def check_rate_limit(self) -> None:
		"""`messages_per_minute` may not exceed the Settings value when one is configured."""
		if not self.messages_per_minute:
			return
		if cint(self.messages_per_minute) < 1:
			frappe.throw(_("Messages per Minute must be at least 1"), WAValidationError)
		limit = settings_rate_limit()
		if limit and cint(self.messages_per_minute) > limit:
			frappe.throw(
				_("Messages per Minute cannot exceed the queue rate of {0}").format(limit),
				WAValidationError,
			)

	def check_edit_lock(self) -> None:
		"""`messages`, `device` and `scheduled_at` may only change while the saved status is Draft/Scheduled."""
		if self.is_new():
			return
		before = self.get_doc_before_save()
		if before is None or before.status in EDITABLE_STATUSES:
			return
		changed = [f for f in LOCKED_FIELDS if (before.get(f) or None) != (self.get(f) or None)]
		if _message_rows(before) != _message_rows(self):
			changed.append("messages")
		if changed:
			frappe.throw(
				_("{0} cannot be changed while the campaign is {1}").format(
					", ".join(_(self.meta.get_label(f)) for f in changed), _(before.status)
				),
				WAStateConflictError,
			)


def settings_rate_limit() -> int:
	"""`WhatsApp Settings.messages_per_minute` (meta default applies) or 0 when Settings is not installed."""
	if not frappe.db.exists("DocType", "WhatsApp Settings"):
		return 0
	try:
		return cint(frappe.get_cached_doc("WhatsApp Settings").messages_per_minute)
	except Exception:
		return 0


def _message_rows(doc: Document) -> list[tuple]:
	return [tuple(row.get(f) for f in MESSAGE_ROW_FIELDS) for row in doc.get("messages") or []]

# Module role: WhatsApp Contact Group controller — member rows normalized to E.164, duplicate guard,
# `member_count` / `members_changed_at` maintenance, and the global-blacklist disable guard (fields.md §12).

from __future__ import annotations

import frappe
from frappe import _
from frappe.model.document import Document
from frappe.utils import now_datetime

from whatsapp_next.exceptions import WAStateConflictError, WAValidationError
from whatsapp_next.services.phone import set_phone_pair

MEMBER_COMPARE_FIELDS = ("phone_e164", "display_name", "contact", "source_type", "note")


class WhatsAppContactGroup(Document):
	"""A named list of phone numbers used by campaigns, commands and the global blacklist."""

	def validate(self) -> None:
		"""Normalize members, reject duplicates, maintain counters, guard the global blacklist."""
		self.normalize_members()
		self.check_duplicate_members()
		self.update_member_stats()
		self.check_blacklist_disable()

	def normalize_members(self) -> None:
		"""Fill `phone_e164` on every row (required) and stamp `added_by` / `added_on` on new rows."""
		for row in self.get("members") or []:
			set_phone_pair(row, "phone", "phone_e164", required=True)
			if not row.added_by:
				row.added_by = frappe.session.user
			if not row.added_on:
				row.added_on = now_datetime()

	def check_duplicate_members(self) -> None:
		"""Reject the same `phone_e164` appearing twice in the table."""
		seen: set[str] = set()
		for row in self.get("members") or []:
			if row.phone_e164 in seen:
				frappe.throw(
					_("Row {0}: number {1} is already a member of this group").format(
						row.idx, row.phone_e164
					),
					WAValidationError,
				)
			seen.add(row.phone_e164)

	def update_member_stats(self) -> None:
		"""Set `member_count`; bump `members_changed_at` when the member set changed."""
		self.member_count = len(self.get("members") or [])
		if self.is_new():
			if self.member_count:
				self.members_changed_at = now_datetime()
			return
		before = self.get_doc_before_save()
		if before is None or _member_signature(before) != _member_signature(self):
			self.members_changed_at = now_datetime()

	def check_blacklist_disable(self) -> None:
		"""A `Blacklist` group cannot be disabled while it is `WhatsApp Settings.global_blacklist_group`."""
		if not (self.disabled and self.kind == "Blacklist") or self.is_new():
			return
		if not frappe.db.exists("DocType", "WhatsApp Settings"):
			return
		try:
			global_group = frappe.db.get_single_value("WhatsApp Settings", "global_blacklist_group")
		except Exception:
			return
		if global_group and global_group == self.name:
			frappe.throw(
				_("{0} is the global blacklist and cannot be disabled").format(self.name),
				WAStateConflictError,
			)


def _member_signature(doc: Document) -> list[tuple]:
	return sorted(tuple(row.get(f) for f in MEMBER_COMPARE_FIELDS) for row in doc.get("members") or [])

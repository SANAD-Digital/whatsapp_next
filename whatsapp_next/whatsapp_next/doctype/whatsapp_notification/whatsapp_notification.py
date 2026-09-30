# Module role: WhatsApp Notification controller — doc-event send rules (D-016, fields.md §20). Validation
# only: safe `document_type`, body source (template or inline, OQ-9), doc-event allow-list for `method`
# (D-012), compilable condition, recipients, variable count; cache invalidation for `services/notifications`.

from __future__ import annotations

import json
import re

import frappe
from frappe import _
from frappe.model.document import Document
from frappe.utils.data import evaluate_filters

from whatsapp_next.exceptions import WAValidationError
from whatsapp_next.services.notifications import clear_cache
from whatsapp_next.services.phone import set_phone_pair

ALLOWED_METHODS = (
	"validate",
	"on_update",
	"on_submit",
	"on_cancel",
	"after_insert",
	"on_change",
	"on_update_after_submit",
)
# Not offered: `before_insert` / `before_save` / `on_trash`. The send runs after commit and reloads
# the document — before an insert it has no name yet, after a trash it is gone.
VARIABLE_PATTERN = re.compile(r"\{\{\s*(.*?)\s*\}\}", re.DOTALL)


class WhatsAppNotification(Document):
	"""Send a WhatsApp message when a document event fires and the condition holds."""

	def validate(self) -> None:
		"""Run every rule; each raises `WAValidationError` with a user message."""
		self.check_document_type()
		self.check_body()
		self.check_method()
		self.check_condition_type()
		self.check_condition()
		self.check_filters()
		self.normalize_recipients()
		self.variables_count = count_variables(self.body_source())

	def on_update(self) -> None:
		"""Invalidate the per-DocType cache (old and new `document_type`)."""
		self.invalidate_cache()

	def on_trash(self) -> None:
		"""Invalidate the per-DocType cache."""
		self.invalidate_cache()

	def invalidate_cache(self) -> None:
		"""Clear the cache for the current and (when changed) the previous `document_type`."""
		clear_cache(self.document_type)
		before = self.get_doc_before_save()
		if before is not None and before.document_type and before.document_type != self.document_type:
			clear_cache(before.document_type)

	def check_document_type(self) -> None:
		"""Not a child table, not a Single, not one of this app's own DocTypes (loop guard)."""
		if not self.document_type:
			frappe.throw(_("Document Type is required"), WAValidationError)
		if self.document_type.startswith("WhatsApp "):
			frappe.throw(
				_("Notifications cannot be attached to {0} (WhatsApp DocTypes would loop)").format(
					self.document_type
				),
				WAValidationError,
			)
		meta = frappe.get_meta(self.document_type)
		if meta.istable:
			frappe.throw(_("{0} is a child table").format(self.document_type), WAValidationError)
		if meta.issingle:
			frappe.throw(_("{0} is a Single DocType").format(self.document_type), WAValidationError)

	def check_body(self) -> None:
		"""Either a linked Template or an inline Message (OQ-9)."""
		if not self.template and not (self.message or "").strip():
			frappe.throw(_("Choose a Template or write a Message"), WAValidationError)

	def check_method(self) -> None:
		"""`method` must be a doc-event name from the allow-list, never a dotted path (D-012)."""
		if self.event != "Method":
			return
		method = (self.method or "").strip()
		if method not in ALLOWED_METHODS:
			frappe.throw(
				_("Method must be one of {0}").format(", ".join(ALLOWED_METHODS)),
				WAValidationError,
			)
		self.method = method

	def check_condition_type(self) -> None:
		"""One condition at a time, as Frappe's Notification: Filters clear the Python condition and
		the other way round."""
		if self.condition_type == "Filters":
			self.condition = None
		else:
			self.condition_type = "Python"
			self.filters = None

	def check_filters(self) -> None:
		"""Filters are a JSON list of `[doctype, field, operator, value]` that Frappe can evaluate
		against a record of the document type; an empty list means every record."""
		if self.condition_type != "Filters" or not self.filters:
			return
		try:
			filters = json.loads(self.filters)
		except ValueError:
			frappe.throw(_("Filters are not valid JSON"), WAValidationError)
		if not isinstance(filters, list):
			frappe.throw(_("Filters must be a list"), WAValidationError)
		if not filters:
			self.filters = None
			return
		# `evaluate_filters` compares a missing field as empty instead of failing, so a mistyped one
		# would quietly stop every send: each field must exist on the document type
		meta = frappe.get_meta(self.document_type)
		standard = set(frappe.model.default_fields)
		for f in filters:
			fieldname = f[1] if isinstance(f, (list, tuple)) and len(f) > 2 else None
			if fieldname and fieldname not in standard and not meta.has_field(fieldname):
				frappe.throw(_("{0} has no field {1}").format(_(self.document_type), fieldname), WAValidationError)
		try:
			evaluate_filters(frappe.new_doc(self.document_type), filters)
		except Exception as exc:
			frappe.throw(_("The filters cannot be checked on {0}: {1}").format(_(self.document_type), exc), WAValidationError)

	def check_condition(self) -> None:
		"""The condition must be a compilable Python expression."""
		condition = (self.condition or "").strip()
		if not condition:
			return
		try:
			compile(condition, "<condition>", "eval")
		except SyntaxError as exc:
			frappe.throw(_("Condition is not a valid expression: {0}").format(exc.msg), WAValidationError)

	def normalize_recipients(self) -> None:
		"""≥ 1 row; Fixed Number rows get the normalized `phone_e164`."""
		rows = self.get("recipients") or []
		if not rows:
			frappe.throw(_("Add at least one recipient"), WAValidationError)
		for row in rows:
			if row.recipient_type == "Fixed Number":
				set_phone_pair(row, "phone", "phone_e164", required=True)

	def body_source(self) -> str:
		"""The Jinja source whose variables are counted: the template body when linked, else `message`."""
		if self.template and frappe.db.table_exists("WhatsApp Template"):
			return frappe.db.get_value("WhatsApp Template", self.template, "body") or ""
		return self.message or ""


def count_variables(source: str) -> int:
	"""Number of distinct `{{ … }}` tokens in `source`."""
	return len({m.strip() for m in VARIABLE_PATTERN.findall(source or "")})

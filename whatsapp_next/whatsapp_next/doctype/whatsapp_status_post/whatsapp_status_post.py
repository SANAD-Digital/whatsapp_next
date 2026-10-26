# Copyright (c) 2026, SANAD Digital and contributors
# For license information, please see license.txt

# Module role: a WhatsApp status post — thin: what may be edited and when. Posting, scheduling,
# deleting and views live in services/status_posts.

import frappe
from frappe import _
from frappe.model.document import Document

from whatsapp_next.exceptions import WAValidationError

MAX_TEXT = 700
EDITABLE_STATES = ("Draft", "Scheduled", "Failed")


class WhatsAppStatusPost(Document):
	def validate(self):
		if self.kind == "Text" and len(self.text or "") > MAX_TEXT:
			frappe.throw(_("The status text is longer than {0} characters").format(MAX_TEXT), WAValidationError)
		if not self.is_new() and self.state not in EDITABLE_STATES and self.has_value_changed_any():
			frappe.throw(_("A posted status cannot be changed; delete it and post a new one"), WAValidationError)

	def has_value_changed_any(self) -> bool:
		"""True when any field that shapes the post changed since it was last saved."""
		before = self.get_doc_before_save()
		if not before:
			return False
		return any(self.get(f) != before.get(f) for f in ("kind", "text", "background_color", "font", "media", "caption", "device"))

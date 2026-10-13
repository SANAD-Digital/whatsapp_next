# Module role: child of WhatsApp Command (`templates`) — the command's own text for one of its function's
# message templates, per language; the parent checks `param` against the function's header.

from __future__ import annotations

from frappe.model.document import Document


class WhatsAppCommandTemplate(Document):
	"""A command's text for one Template parameter of its function, in one language (or all)."""

	def __setup__(self) -> None:
		# an empty `language` means every language: Frappe must not fill it with the site's default
		# language (the global `language` default) when the row is inserted
		self.dont_update_if_missing = ["language"]

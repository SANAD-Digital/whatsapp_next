# Module role: child-table controller for the ContactPicker DocType whitelist (Settings tab
# "Picker"). Row validation lives in the parent `WhatsApp Settings` controller.

from __future__ import annotations

from frappe.model.document import Document


class WhatsAppSettingsPickerSource(Document):
	"""One whitelisted DocType the ContactPicker (source 3) may read numbers from."""

	pass

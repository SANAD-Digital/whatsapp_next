# Copyright (c) 2026, Sanad Digital and contributors
# For license information, please see license.txt

# Module role: one chat a WhatsApp Settings list names — a number (E.164) or a group (its JID),
# chosen from the contact picker: who an edit / deletion reply goes to, and who the site may send to.

from frappe.model.document import Document


class WhatsAppSettingsTarget(Document):
	pass

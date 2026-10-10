# Copyright (c) 2026, SANAD Digital and contributors
# For license information, please see license.txt

# Module role: one row per number checked against WhatsApp (services/number_check) — whether it
# is registered, its WhatsApp id and a business's verified name. A cache: written only by the
# service, read by campaigns and screens; a row older than the service's age limit is asked again.

from frappe.model.document import Document


class WhatsAppNumberCheck(Document):
	pass

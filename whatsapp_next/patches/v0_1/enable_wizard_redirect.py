# Module role: phase 10 turns on the Home → Onboarding Wizard redirect (spec #1). The field's
# default is now 1; this sets it on sites installed while it was still 0 and unwired, so nobody
# could have switched it off on purpose. Only System Managers on a site without platform
# credentials are ever redirected (`services.onboarding.should_redirect_to_wizard`).

import frappe


def execute():
	"""Set `WhatsApp Settings.redirect_unregistered_to_wizard` to 1."""
	frappe.db.set_single_value("WhatsApp Settings", "redirect_unregistered_to_wizard", 1)

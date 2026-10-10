# Module role: `boot_session` hook — adds `frappe.boot.whatsapp_next` for the Desk client. It only
# carries what a page must know before its first call: whether Home sends this user to the
# Onboarding Wizard (spec #1, enabled in phase 10), and which plan features its screens may offer.
# Never raises: a broken Settings row must not break Desk boot.

from __future__ import annotations

import frappe


def boot_session(bootinfo) -> None:
	"""`bootinfo.whatsapp_next = {"setup_redirect": bool, "features": {"interactive": bool}}`."""
	redirect, features = False, {}
	try:
		from whatsapp_next.services import onboarding, plan_features

		redirect = onboarding.should_redirect_to_wizard()
		features = plan_features.for_boot()
	except Exception:
		frappe.log_error(title="whatsapp_next boot_session")
	bootinfo.whatsapp_next = frappe._dict(setup_redirect=redirect, features=features)

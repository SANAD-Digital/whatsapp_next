# Module role: the platform tells this site that a sign-up's number is confirmed (owner, 2026-10-20:
# "why is the confirmation not a webhook"). `services.onboarding.start_signup` gave the platform this
# address and a one-time token kept here with the user whose setup page waits; the platform calls
# it once, the moment the request turns Verified, and the page is told at once (realtime) instead of
# asking the platform every few seconds.
#
# A guest endpoint — the site is not linked to the platform yet, so there is no signing secret —
# safe because it only accepts a token this site made and still holds, says nothing back, and does
# nothing but wake a page: finishing the account still takes the password from that page.

from __future__ import annotations

import frappe
from frappe.rate_limiter import rate_limit

from whatsapp_next.services.onboarding import SIGNUP_CALLBACK_KEY


@frappe.whitelist(allow_guest=True, methods=["POST"])
@rate_limit(limit=60, seconds=60)
def confirmed(callback_token: str | None = None, status: str | None = None) -> dict:
	"""`POST {callback_token, status}` from the platform → `wa:signup:status` to the waiting user."""
	token = str(callback_token or "").strip()
	key = f"{SIGNUP_CALLBACK_KEY}:{token}"
	entry = frappe.cache.get_value(key) if token else None
	if not entry:
		return {"ok": False}
	frappe.cache.delete_value(key)  # one call per sign-up
	frappe.publish_realtime(
		"wa:signup:status",
		{"request_key": entry.get("request_key"), "status": str(status or "Verified")},
		user=entry.get("user"),
		after_commit=False,
	)
	return {"ok": True}

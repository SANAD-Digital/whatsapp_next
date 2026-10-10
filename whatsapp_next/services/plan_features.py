# Module role: what the subscription plan includes, read from the cached `plan_features` that the
# usage sync (services/usage_sync) copies from the platform. A feature the plan leaves out is not
# offered anywhere — no option on a screen, no message built with it — and the platform refuses it
# as well. Until the first sync nothing is included.

from __future__ import annotations

import frappe
from frappe import _

from whatsapp_next.exceptions import WANotSupportedError

INTERACTIVE = "allow_interactive"  # buttons and lists
GROUPS = "allow_groups"  # sending to and creating WhatsApp groups


def included(flag: str) -> bool:
	"""True when the synced plan includes `flag`."""
	raw = frappe.get_cached_doc("WhatsApp Settings").get("plan_features")
	try:
		features = frappe.parse_json(raw) if raw else {}
	except Exception:
		features = {}
	return bool((features or {}).get(flag))


def interactive() -> bool:
	"""Buttons and lists are in the plan."""
	return included(INTERACTIVE)


def require_interactive() -> None:
	"""E: `WANotSupportedError` when the plan does not include buttons and lists."""
	if not interactive():
		frappe.throw(_("Your plan does not include buttons and lists"), WANotSupportedError)


def require_groups() -> None:
	"""E: `WANotSupportedError` when the plan does not include WhatsApp groups."""
	if not included(GROUPS):
		frappe.throw(_("Your plan does not include WhatsApp groups"), WANotSupportedError)


def for_boot() -> dict[str, bool]:
	"""The flags a screen needs before its first call (`frappe.boot.whatsapp_next.features`)."""
	return {"interactive": interactive(), "groups": included(GROUPS), "status": included("allow_status")}

# Module role: is a number on WhatsApp? Asked through a connected device (provider
# `check_numbers`) and remembered in WhatsApp Number Check for `MAX_AGE_DAYS`; a WhatsApp Number
# row of the same number carries the answer too (`on_whatsapp`), for its list and filters. Used by
# campaigns (`exclude_not_on_whatsapp`) and the "Check on WhatsApp" actions of the screens.

from __future__ import annotations

from typing import Any

import frappe
from frappe import _
from frappe.utils import add_days, now_datetime

from whatsapp_next.exceptions import WAStateConflictError, WAValidationError
from whatsapp_next.services.phone import classify

CHECK = "WhatsApp Number Check"
MAX_AGE_DAYS = 30
BATCH = 1000  # the platform's limit per call
MAX_PER_REQUEST = 5000  # what one screen action may ask


def _device(device: str | None) -> tuple[str, str]:
	"""(device, platform_device) of the given or default connected device."""
	name = device or frappe.db.get_single_value("WhatsApp Settings", "default_device")
	row = frappe.db.get_value("WhatsApp Device", name, ["name", "platform_device", "status"], as_dict=True) if name else None
	if not row or row.status != "Connected":
		row = frappe.db.get_value("WhatsApp Device", {"status": "Connected", "disabled": 0}, ["name", "platform_device", "status"], as_dict=True)
	if not row:
		frappe.throw(_("No WhatsApp device is connected to check numbers with"), WAStateConflictError)
	return row.name, row.platform_device


def cached(keys: list[str], max_age_days: int = MAX_AGE_DAYS) -> dict[str, bool]:
	"""Fresh answers already here, `{e164: on_whatsapp}`."""
	if not keys:
		return {}
	since = add_days(now_datetime(), -max_age_days)
	rows = frappe.get_all(CHECK, filters={"name": ("in", keys), "checked_at": (">=", since)},
		fields=["name", "on_whatsapp"])
	return {r.name: r.on_whatsapp == "Yes" for r in rows}


def check(numbers: list[str], *, device: str | None = None, force: bool = False,
		max_age_days: int = MAX_AGE_DAYS) -> dict[str, bool]:
	"""`{e164: on_whatsapp}` for every individual number given (others are left out). Fresh answers
	come from the cache unless `force`; the rest are asked through the device and remembered."""
	keys = []
	for n in numbers or []:
		kind, key = classify(n)
		if kind == "Individual" and key not in keys:
			keys.append(key)
	if not keys:
		return {}
	out = {} if force else cached(keys, max_age_days)
	missing = [k for k in keys if k not in out]
	if not missing:
		return out
	from whatsapp_next.providers import registry

	device, platform_device = _device(device)
	provider = registry.get_provider()
	now = now_datetime()
	for start in range(0, len(missing), BATCH):
		chunk = missing[start : start + BATCH]
		answered = {r.phone_e164: r for r in provider.check_numbers(platform_device, chunk)}
		for key in chunk:
			r = answered.get(key)
			on = bool(r and r.on_whatsapp)
			_remember(key, on, r.jid if r else None, r.verified_name if r else None, now, device)
			out[key] = on
	return out


def _remember(key: str, on: bool, jid: str | None, verified_name: str | None, at, device: str) -> None:
	values = {"on_whatsapp": "Yes" if on else "No", "jid": jid, "verified_name": verified_name,
		"checked_at": at, "device": device}
	if frappe.db.exists(CHECK, key):
		frappe.db.set_value(CHECK, key, values, update_modified=False)
	else:
		frappe.get_doc({"doctype": CHECK, "phone_e164": key, **values}).insert(ignore_permissions=True)
	if frappe.db.exists("WhatsApp Number", key):
		frappe.db.set_value("WhatsApp Number", key, {"on_whatsapp": values["on_whatsapp"], "whatsapp_checked_at": at},
			update_modified=False)


def check_for(source_doctype: str, names: list[str], *, force: bool = True) -> dict[str, Any]:
	"""The "Check on WhatsApp" action of a screen: the numbers behind the selected records
	(Contacts, contact groups or WhatsApp Numbers), checked → `{checked, on_whatsapp, not_on,
	results[{phone_e164, display_name, on_whatsapp}]}`."""
	from whatsapp_next.services import wa_groups

	members = wa_groups.members_from(source_doctype, names)
	if len(members) > MAX_PER_REQUEST:
		frappe.throw(_("Check at most {0} numbers at a time").format(MAX_PER_REQUEST), WAValidationError)
	answers = check([m["phone_e164"] for m in members], force=force)
	results = [{**m, "on_whatsapp": answers.get(m["phone_e164"])} for m in members]
	return {
		"checked": len(results),
		"on_whatsapp": sum(1 for r in results if r["on_whatsapp"]),
		"not_on": sum(1 for r in results if r["on_whatsapp"] is False),
		"results": results,
	}

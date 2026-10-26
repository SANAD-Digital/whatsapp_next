# Module role: bring a device's WhatsApp address book into `WhatsApp Number` (the "Fetch from
# WhatsApp" action of the Numbers screen). One pass per device: a number already here is updated
# (the name it is saved under, where and when it was synced), a new one is added, and a number that
# matches a system Contact but is not linked yet is linked through the contextual permission layer
# (`permissions.link_number`, audited `Number Linked`). Message counters are never touched: they
# stay the materializer's (`numbers_materializer.refresh_keys`).

from __future__ import annotations

from dataclasses import asdict, dataclass

import frappe
from frappe import _
from frappe.utils import now_datetime

from whatsapp_next.exceptions import WANotFoundError, WAValidationError
from whatsapp_next.providers import registry
from whatsapp_next.services import audit, devices, permissions
from whatsapp_next.services.guards import status_writer
from whatsapp_next.services.phone import classify

REALTIME_EVENT = "wa:numbers:synced"
STATE_KEY = "wa:numbers:sync:{device}"
STATE_TTL = 3600


def set_state(device: str, state: dict) -> None:
	"""Where a fetch stands (`running` / `done` / `failed`, with its counts or error), for a page
	that did not hear the realtime event: it asks `state_of` instead."""
	frappe.cache.set_value(STATE_KEY.format(device=device), state, expires_in_sec=STATE_TTL)


def state_of(device: str) -> dict | None:
	"""The last known sync state of `device` (cache), or None."""
	return frappe.cache.get_value(STATE_KEY.format(device=device))


@dataclass
class SyncStats:
	fetched: int = 0
	added: int = 0
	updated: int = 0
	unchanged: int = 0
	linked: int = 0
	groups: int = 0
	link_skipped: int = 0
	invalid: int = 0


def _contacts_by_key(keys: list[str]) -> dict[str, str]:
	"""`{E.164 → Contact}` in one read, first match as `resolve_contact_by_phone` orders them."""
	if not keys:
		return {}
	out: dict[str, str] = {}
	for r in frappe.get_all(
		"Contact Phone",
		filters={"parenttype": "Contact", "wa_phone_e164": ("in", keys)},
		fields=["parent", "wa_phone_e164"],
		order_by="is_primary_mobile_no desc, creation asc",
		ignore_permissions=True,
	):
		out.setdefault(r.wa_phone_e164, r.parent)
	return out


def sync_device_contacts(device: str, user: str | None = None) -> dict[str, int]:
	"""Fetch `device`'s contacts from the provider and upsert them into `WhatsApp Number`.
	Returns the counts of what happened (`SyncStats`)."""
	user = user or frappe.session.user
	contacts = registry.get_provider().list_device_contacts(devices.platform_device(device))
	stats = SyncStats(fetched=len(contacts))
	wanted: dict[str, tuple[str, object]] = {}
	for c in contacts:
		kind, key = classify(c.phone_e164 or c.jid)
		if not kind or kind == "Group":
			stats.invalid += 1
			continue
		wanted[key] = (kind, c)
	existing = {
		r.name: r
		for r in frappe.get_all(
			"WhatsApp Number",
			filters={"name": ("in", list(wanted))},
			fields=["name", "contact", "display_name", "saved_name", "synced_device"],
		)
	}
	system = _contacts_by_key([k for k, (kind, _c) in wanted.items() if kind == "Individual"])
	now = now_datetime()
	to_link: list[tuple[str, str]] = []
	for key, (kind, c) in wanted.items():
		saved = (c.name or "").strip() or None
		row = existing.get(key)
		if row is None:
			with status_writer():
				doc = frappe.get_doc(
					{
						"doctype": "WhatsApp Number",
						"phone_e164": key,
						"phone": c.phone_e164 or None,
						"jid": c.jid or None,
						"number_type": kind,
						"display_name": saved,
						"saved_name": saved,
						"synced_device": device,
						"synced_at": now,
						"link_status": "Not Linked",
					}
				)
				doc.flags.ignore_permissions = True
				doc.insert(ignore_permissions=True)
			stats.added += 1
		else:
			values = {"synced_device": device, "synced_at": now}
			if saved and saved != row.saved_name:
				values["saved_name"] = saved
			# a linked number keeps its contact's name; an unlinked one takes the saved name
			if saved and not row.contact and saved != row.display_name:
				values["display_name"] = saved
			# decided before the write: `set_value` adds `modified` to the dict it is given
			changed = bool(set(values) - {"synced_device", "synced_at"}) or row.synced_device != device
			frappe.db.set_value("WhatsApp Number", key, values, update_modified=changed)
			if changed:
				stats.updated += 1
			else:
				stats.unchanged += 1
		if system.get(key) and not (row and row.contact):
			to_link.append((key, system[key]))
	_sync_groups(device, stats, now)
	for key, contact in to_link:
		try:
			permissions.link_number(key, contact, user=user)
			stats.linked += 1
		except frappe.PermissionError:
			stats.link_skipped += 1
	audit.log(
		"Numbers Synced",
		reference=("WhatsApp Device", device),
		count=stats.fetched,
		details=asdict(stats),
		user=user,
	)
	return asdict(stats)


def _sync_groups(device: str, stats: SyncStats, now) -> None:
	"""The device's groups as `Group` rows: a group already here takes its current subject, a new
	one is added. Groups are never linked to a Contact."""
	groups = registry.get_provider().list_device_groups(devices.platform_device(device))
	keyed = {}
	for g in groups:
		kind, key = classify(g.jid)
		if kind == "Group":
			keyed[key] = g
	existing = {
		r.name: r
		for r in frappe.get_all(
			"WhatsApp Number",
			filters={"name": ("in", list(keyed) or [""])},
			fields=["name", "display_name", "saved_name", "synced_device"],
		)
	}
	for key, g in keyed.items():
		stats.groups += 1
		name = (g.name or "").strip() or None
		row = existing.get(key)
		if row is None:
			with status_writer():
				frappe.get_doc(
					{
						"doctype": "WhatsApp Number",
						"phone_e164": key,
						"jid": key,
						"number_type": "Group",
						"display_name": name,
						"saved_name": name,
						"synced_device": device,
						"synced_at": now,
						"link_status": "Not Linked",
					}
				).insert(ignore_permissions=True)
			stats.added += 1
			continue
		values = {"synced_device": device, "synced_at": now}
		if name and name != row.saved_name:
			values["saved_name"] = name
		if name and name != row.display_name:
			values["display_name"] = name
		changed = bool(set(values) - {"synced_device", "synced_at"}) or row.synced_device != device
		frappe.db.set_value("WhatsApp Number", key, values, update_modified=changed)
		if changed:
			stats.updated += 1
		else:
			stats.unchanged += 1


def run_sync_job(device: str, user: str) -> dict[str, int]:
	"""Job (`long`, `wa-numbers-sync-{device}`): `sync_device_contacts`, then tell the user who
	asked (`wa:numbers:synced` with the counts, or the error)."""
	try:
		stats = sync_device_contacts(device, user=user)
	except Exception as exc:
		frappe.db.rollback()
		frappe.log_error(title="WhatsApp Numbers: device sync failed", message=f"device={device}")
		error = str(exc)[:300]
		set_state(device, {"status": "failed", "error": error, "at": str(now_datetime())})
		frappe.publish_realtime(
			REALTIME_EVENT, {"device": device, "error": error}, user=user, after_commit=False
		)
		raise
	frappe.db.commit()
	set_state(device, {"status": "done", "stats": stats, "at": str(now_datetime())})
	frappe.publish_realtime(REALTIME_EVENT, {"device": device, **stats}, user=user, after_commit=False)
	return stats

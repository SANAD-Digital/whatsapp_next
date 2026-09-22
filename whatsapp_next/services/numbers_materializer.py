# Module role: WhatsApp Number materialization (architecture.md, backend-plan §10). One row per
# normalized key (E.164 or group / LID JID) — a stored DISTINCT over both message tables, never
# the source of truth. Counters and timestamps are always **assigned from a fresh aggregate**
# (`read_layer.stats_by_key`), never incremented, which makes every entry point idempotent:
# the `after_insert` incremental job, the nightly watermark job and a campaign's bulk refresh
# all converge on the same values.

from __future__ import annotations

import hashlib
from collections.abc import Iterable
from dataclasses import dataclass, field
from typing import Any

import frappe
from frappe.utils import add_to_date, cint, get_datetime, now_datetime

from whatsapp_next.services import read_layer
from whatsapp_next.services.guards import status_writer
from whatsapp_next.services.phone import classify, key_for

NIGHTLY_BATCH = 5000
WATERMARK_OVERLAP_SECONDS = 60
NUMBER_FIELDS = (
	"name",
	"contact",
	"link_status",
	"display_name",
	"number_type",
	"outbound_count",
	"inbound_count",
	"first_seen",
	"last_seen",
	"last_direction",
	"last_device",
)


@dataclass
class RefreshStats:
	visited: int = 0
	inserted: int = 0
	updated: int = 0
	unchanged: int = 0
	invalid: int = 0
	keys_invalid: list[str] = field(default_factory=list)


def _job_id(key: str) -> str:
	return "wa-num-" + hashlib.sha1(key.encode("utf-8")).hexdigest()[:16]


# ---- hooks ---------------------------------------------------------------------------------


def on_message_insert(doc, method: str | None = None) -> None:
	"""`after_insert` of WhatsApp Log / WhatsApp Inbound Message: enqueue the incremental upsert
	(after commit, deduplicated per key). Campaign materialization skips this and refreshes
	all keys in one call."""
	if getattr(doc.flags, "skip_numbers_upsert", False):
		return
	key = message_key(doc)
	if not key:
		return
	frappe.enqueue(
		"whatsapp_next.services.numbers_materializer.upsert_from_message",
		doctype=doc.doctype,
		name=doc.name,
		queue="short",
		job_id=_job_id(key),
		deduplicate=True,
		enqueue_after_commit=True,
		timeout=60,
	)


def message_key(row) -> str | None:
	"""The Number key of a message row / dict of either table."""
	get = row.get if hasattr(row, "get") else lambda k: getattr(row, k, None)
	if (
		get("doctype") == "WhatsApp Inbound Message"
		or get("sender_jid") is not None
		or get("chat_jid") is not None
	):
		if cint(get("is_group")) and get("chat_jid"):
			return key_for(None, get("chat_jid"))
		return key_for(get("phone_e164"), get("sender_jid"))
	return key_for(get("phone_e164"), get("jid"))


def upsert_from_message(doctype: str, name: str) -> RefreshStats:
	"""Job: refresh the single key of one message row (no-op when the row is gone)."""
	row = frappe.db.get_value(
		doctype,
		name,
		["phone_e164", "jid", "sender_jid", "chat_jid", "is_group"]
		if doctype == "WhatsApp Inbound Message"
		else ["phone_e164", "jid"],
		as_dict=True,
	)
	if not row:
		return RefreshStats()
	row["doctype"] = doctype
	key = message_key(row)
	return refresh_keys([key]) if key else RefreshStats()


# ---- core ----------------------------------------------------------------------------------


def _contact_name(contact: str | None) -> str | None:
	return frappe.db.get_value("Contact", contact, "full_name") if contact else None


def refresh_keys(keys: Iterable[str]) -> RefreshStats:
	"""Recompute every given key from the message tables and write only the differences.

	Existing rows: counters, first/last seen, last direction / device, display name (Contact
	name when linked, else the latest inbound push name, else unchanged). Missing rows are
	inserted with `contact` resolved once (D-029 02-OQ-5); `contact` is never changed here."""
	from whatsapp_next.services.permissions import resolve_contact_by_phone

	stats = RefreshStats()
	wanted: dict[str, str] = {}
	for raw in keys:
		kind, key = classify(raw)
		if not kind:
			stats.invalid += 1
			stats.keys_invalid.append(str(raw)[:32])
			continue
		wanted[key] = kind
	if not wanted:
		return stats
	aggregates = read_layer.stats_by_key(list(wanted))
	existing = {
		r.name: r
		for r in frappe.get_all(
			"WhatsApp Number", filters={"name": ("in", list(wanted))}, fields=list(NUMBER_FIELDS)
		)
	}
	for key, kind in wanted.items():
		stats.visited += 1
		agg = aggregates.get(key)
		row = existing.get(key)
		if agg is None and row is None:
			continue  # never seen in either table: nothing to materialize
		values: dict[str, Any] = {
			"number_type": kind,
			"outbound_count": agg.outbound_count if agg else 0,
			"inbound_count": agg.inbound_count if agg else 0,
			"first_seen": agg.first_seen if agg else None,
			"last_seen": agg.last_seen if agg else None,
			"last_direction": agg.last_direction if agg else None,
			"last_device": agg.last_device if agg else None,
		}
		if row is None:
			contact = resolve_contact_by_phone(key) if kind == "Individual" else None
			values.update(
				{
					"doctype": "WhatsApp Number",
					"phone_e164": key,
					"contact": contact,
					"link_status": "Linked" if contact else "Not Linked",
					"display_name": _contact_name(contact) or (agg.display_name if agg else None),
				}
			)
			with status_writer():
				doc = frappe.get_doc(values)
				doc.flags.ignore_permissions = True
				doc.insert(ignore_permissions=True)
			stats.inserted += 1
			continue
		display = (
			_contact_name(row.contact)
			if row.contact
			else (agg.display_name if agg and agg.display_name else None)
		)
		if display:
			values["display_name"] = display
		values["link_status"] = "Linked" if row.contact else "Not Linked"
		changed = {k: v for k, v in values.items() if _differs(row.get(k), v)}
		if not changed:
			stats.unchanged += 1
			continue
		frappe.db.set_value("WhatsApp Number", key, changed, update_modified=True)
		stats.updated += 1
	return stats


def _differs(current: Any, new: Any) -> bool:
	if current in (None, "", 0) and new in (None, "", 0):
		return False
	if hasattr(current, "isoformat") or hasattr(new, "isoformat"):
		return get_datetime(current) != get_datetime(new) if current and new else bool(current) != bool(new)
	return current != new


def refresh_group_name(jid: str, name: str | None) -> bool:
	"""`display_name` of a `Group` row from `group.updated` webhooks; no-op for other kinds."""
	kind, key = classify(jid)
	if kind != "Group" or not name:
		return False
	row = frappe.db.get_value("WhatsApp Number", key, ["display_name", "number_type"], as_dict=True)
	if not row or row.number_type != "Group" or row.display_name == name:
		return False
	frappe.db.set_value("WhatsApp Number", key, "display_name", name, update_modified=True)
	return True


# ---- nightly -------------------------------------------------------------------------------


def nightly_reconcile(full: bool = False, batch: int = NIGHTLY_BATCH) -> dict[str, Any]:
	"""Cron `30 2 * * *` (`long`): visit every key with messages created since the watermark
	(minus a 60 s overlap), recompute, then advance the watermark. Commits per batch.

	`full=True` (CLI safety valve) ignores the watermark and re-visits everything. Re-running
	changes nothing: values are assigned from aggregates, never incremented."""
	settings = frappe.get_single("WhatsApp Settings")
	upper = now_datetime()
	watermark = (
		None
		if full or not settings.numbers_watermark
		else add_to_date(get_datetime(settings.numbers_watermark), seconds=-WATERMARK_OVERLAP_SECONDS)
	)
	totals = RefreshStats()
	batches = 0
	for keys in read_layer.iter_keys_since(watermark, upper, batch=batch):
		s = refresh_keys(keys)
		for f in ("visited", "inserted", "updated", "unchanged", "invalid"):
			setattr(totals, f, getattr(totals, f) + getattr(s, f))
		batches += 1
		frappe.db.commit()
	drift = _drift_check()
	frappe.db.set_value(
		"WhatsApp Settings",
		"WhatsApp Settings",
		{"numbers_watermark": upper, "numbers_last_run_at": now_datetime()},
		update_modified=False,
	)
	frappe.clear_document_cache("WhatsApp Settings", "WhatsApp Settings")
	frappe.db.commit()
	return {
		"batches": batches,
		"watermark": str(upper),
		"drift": drift,
		**{k: getattr(totals, k) for k in ("visited", "inserted", "updated", "unchanged", "invalid")},
	}


def _drift_check() -> dict[str, int]:
	"""Fix `contact` set but `link_status != Linked`; count (never delete) rows with both
	counters at zero."""
	fixed = 0
	for name in frappe.get_all(
		"WhatsApp Number", filters={"contact": ("is", "set"), "link_status": ("!=", "Linked")}, pluck="name"
	):
		frappe.db.set_value("WhatsApp Number", name, "link_status", "Linked", update_modified=False)
		fixed += 1
	empty = frappe.db.count("WhatsApp Number", {"outbound_count": 0, "inbound_count": 0})
	if empty:
		frappe.log_error(
			title="WhatsApp Numbers: rows without messages",
			message=f"{empty} row(s) have zero counters (kept; deletion is blocked by spec)",
		)
	return {"link_status_fixed": fixed, "empty_rows": int(empty)}

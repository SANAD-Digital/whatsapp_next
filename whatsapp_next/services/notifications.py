# Module role: WhatsApp Notification doc-event sends (D-016, backend-plan §11). Phase 3 ships the
# hook entry point with the per-DocType cache short-circuit so `doc_events["*"]` costs nothing
# for DocTypes without notifications; evaluation and sending land in phase 4 (B-16).

from __future__ import annotations

import frappe

CACHE_PREFIX = "wa:notif:"
HANDLED_EVENTS = ("validate", "on_update", "on_submit", "on_cancel", "after_insert", "on_change")


def cache_key(doctype: str) -> str:
	"""Cache key holding the list of enabled notification names for `doctype`."""
	return f"{CACHE_PREFIX}{doctype}"


def active_for(doctype: str) -> list[str]:
	"""Names of enabled WhatsApp Notification rows for `doctype` (cached; empty list cached too)."""
	cached = frappe.cache.get_value(cache_key(doctype))
	if cached is not None:
		return cached
	names: list[str] = []
	if frappe.db.table_exists("WhatsApp Notification"):
		names = frappe.get_all(
			"WhatsApp Notification",
			filters={"document_type": doctype, "enabled": 1},
			pluck="name",
		)
	frappe.cache.set_value(cache_key(doctype), names)
	return names


def clear_cache(doctype: str | None = None) -> None:
	"""Invalidate the per-DocType cache (all DocTypes when `doctype` is None)."""
	if doctype:
		frappe.cache.delete_value(cache_key(doctype))
		return
	frappe.cache.delete_keys(CACHE_PREFIX)


def on_doc_event(doc, method: str | None = None) -> None:
	"""`doc_events["*"]` entry point. Returns immediately when nothing is configured for the DocType."""
	if method not in HANDLED_EVENTS:
		return
	if frappe.flags.in_install or frappe.flags.in_migrate or frappe.flags.in_patch:
		return
	if doc.doctype.startswith("WhatsApp ") or (getattr(doc, "flags", None) and doc.flags.in_wa_notification):
		return
	if not active_for(doc.doctype):
		return
	# Phase 4 (B-16): evaluate conditions and enqueue `send_for_document` after commit.
	return

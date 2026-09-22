# Module role: WhatsApp Number materialization (architecture.md, backend-plan §10). Phase 3 ships
# the `after_insert` hook entry point only; `refresh_keys`, the incremental upsert job and the
# nightly watermark job land in phase 4 (B-13).

from __future__ import annotations


def on_message_insert(doc, method: str | None = None) -> None:
	"""`after_insert` of WhatsApp Log / WhatsApp Inbound Message: enqueue the incremental upsert.

	Phase 4 wires `frappe.enqueue(upsert_from_message, ..., enqueue_after_commit=True)`; until then
	this is a deliberate no-op so inserts never fail because of the hook.
	"""
	return

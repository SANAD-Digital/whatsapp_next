# Module role: status reconcile job (backend-plan §8, cron `*/5`). Repairs what webhooks and
# workers can miss: handed-over messages without a status webhook, stale claims of crashed
# workers, Queue Item / outbound status drift, campaigns that finished silently, and expired
# holds. Every write goes through `services/dispatch.py` (the single status writer).

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import frappe
from frappe.utils import add_to_date, cint, now_datetime

from whatsapp_next.providers import exceptions as pex
from whatsapp_next.providers import registry
from whatsapp_next.services import dispatch, errors
from whatsapp_next.services.guards import status_writer

STALE_MINUTES = 10
HELD_EXPIRY_DAYS = 7
MAX_REFS = 200

# Allowed (Queue Item status → outbound statuses) pairs (fields.md §6 coherence).
ALLOWED: dict[str, frozenset[str]] = {
	"Queued": frozenset({"Queued"}),
	"Sending": frozenset({"Sending"}),
	"Paused": frozenset({"Queued"}),
	"Deleted": frozenset({"Cancelled"}),
	"Completed": frozenset({"Sending", "Sent", "Delivered", "Read", "Failed", "Held", "Cancelled"}),
	"Dead Letter": frozenset({"Failed"}),
}


@dataclass(frozen=True)
class Drift:
	queue_item: str
	outbound: str
	queue_status: str
	outbound_status: str
	fixed_to: str | None


def reconcile_statuses() -> dict[str, Any]:
	"""Job (`short`, `wa-reconcile`): run every check once; returns counters (no PII)."""
	out = {
		"handed_over": reconcile_handed_over(),
		"stale_claims": requeue_stale_claims(),
		"drift": len(assert_coherence(fix=True)),
		"held_expired": resolve_expired_holds(),
		"campaigns": finalize_campaigns(),
	}
	return out


def _lookup(refs: list[str]) -> tuple[dict, list[str]] | None:
	try:
		statuses, unknown = registry.get_provider().get_message_status(refs)
	except pex.ProviderError as exc:
		frappe.log_error(
			title="WhatsApp reconcile: status lookup failed", message=f"code={exc.code} refs={len(refs)}"
		)
		return None
	return {s.client_ref: s for s in statuses}, list(unknown)


def _apply_platform_status(outbound: str, s) -> str:
	"""Map a platform `MessageStatus` onto the outbound row; returns the action taken."""
	status = (s.status or "").strip()
	if status == "Sent" or (s.message_status in ("Sent", "Delivered", "Read")):
		final = s.message_status if s.message_status in ("Sent", "Delivered", "Read") else "Sent"
		dispatch.apply_status(
			outbound,
			final,
			at=s.sent_at,
			provider_message_id=s.provider_message_id,
			platform_message_log=s.platform_message_log,
			source="reconcile",
		)
		return final
	if status == "Failed":
		cls = errors.classify(s.reason)
		dispatch.apply_status(
			outbound,
			"Failed",
			error_code=cls.code,
			reason=cls.message,
			platform_message_log=s.platform_message_log,
			source="reconcile",
		)
		return "Failed"
	if status == "Held":
		dispatch.apply_status(outbound, "Held", reason=s.reason, source="reconcile")
		return "Held"
	if status == "Cancelled":
		dispatch.apply_status(
			outbound,
			"Failed",
			error_code="platform_rejected",
			reason=s.reason or "cancelled on platform (hold expired)",
			source="reconcile",
		)
		return "Failed"
	# Queued / Sending on the platform: still in flight — touch so it is not re-checked at once.
	frappe.db.set_value("WhatsApp Log", outbound, "modified", now_datetime(), update_modified=False)
	return "wait"


def reconcile_handed_over(limit: int = MAX_REFS) -> dict[str, int]:
	"""Outbound `Sending` with `platform_queue_id`, untouched > 10 min → ask the provider.

	`unknown` refs: first time a fresh Queue Item attempt (`Queued`), second time `Failed`."""
	cutoff = add_to_date(now_datetime(), minutes=-STALE_MINUTES)
	rows = frappe.get_all(
		"WhatsApp Log",
		filters={"status": "Sending", "platform_queue_id": ("is", "set"), "modified": ("<", cutoff)},
		fields=["name", "attempts", "queue_item"],
		order_by="modified asc",
		limit=min(cint(limit) or MAX_REFS, MAX_REFS),
	)
	counts = {"checked": len(rows), "resolved": 0, "requeued": 0, "failed_unknown": 0, "wait": 0}
	if not rows:
		return counts
	looked = _lookup([r.name for r in rows])
	if looked is None:
		return counts
	by_ref, unknown = looked
	for r in rows:
		s = by_ref.get(r.name)
		if s:
			action = _apply_platform_status(r.name, s)
			counts["wait" if action == "wait" else "resolved"] += 1
		elif r.name in unknown:
			if not cint(
				frappe.db.get_value("WhatsApp Log", r.name, "device_fallback")
			) and _requeue_unknown_once(r):
				counts["requeued"] += 1
			else:
				dispatch.apply_status(
					r.name,
					"Failed",
					error_code="platform_rejected",
					reason="unknown to the platform after hand-over",
					source="reconcile",
				)
				counts["failed_unknown"] += 1
	return counts


def _requeue_unknown_once(row) -> bool:
	"""First `unknown`: back to `Queued` via the existing Queue Item (marked with a reason);
	a second `unknown` on the same row (reason already set) returns False."""
	marker = "reconcile: unknown on platform"
	item = (
		frappe.db.get_value("WhatsApp Queue Item", row.queue_item, ["name", "last_error"], as_dict=True)
		if row.queue_item
		else None
	)
	if not item or (item.last_error or "").startswith(marker):
		return False
	with status_writer():
		frappe.db.set_value(
			"WhatsApp Queue Item",
			item.name,
			{
				"status": "Queued",
				"next_attempt_at": now_datetime(),
				"platform_queue_id": None,
				"job_id": None,
				"claimed_at": None,
				"last_error": marker,
				"last_error_code": "timeout",
			},
			update_modified=True,
		)
		frappe.db.set_value(
			"WhatsApp Log", row.name, {"status": "Queued", "platform_queue_id": None}, update_modified=True
		)
	return True


def requeue_stale_claims(older_than_minutes: int = STALE_MINUTES) -> int:
	"""Queue Items `Sending` claimed > N min ago without `platform_queue_id` → `Queued` now."""
	cutoff = add_to_date(now_datetime(), minutes=-cint(older_than_minutes or STALE_MINUTES))
	rows = frappe.get_all(
		"WhatsApp Queue Item",
		filters={"status": "Sending", "claimed_at": ("<", cutoff), "platform_queue_id": ("is", "not set")},
		fields=["name", "outbound_message"],
	)
	if not rows:
		return 0
	now = now_datetime()
	with status_writer():
		for r in rows:
			frappe.db.set_value(
				"WhatsApp Queue Item",
				r.name,
				{"status": "Queued", "next_attempt_at": now, "job_id": None, "claimed_at": None},
				update_modified=True,
			)
			frappe.db.set_value(
				"WhatsApp Log", r.outbound_message, {"status": "Queued"}, update_modified=True
			)
	frappe.log_error(
		title="WhatsApp reconcile: stale claims requeued", message="\n".join(r.name for r in rows)
	)
	return len(rows)


def assert_coherence(fix: bool = False) -> list[Drift]:
	"""Pairs whose `(Queue Item.status, outbound.status)` is not allowed. With `fix`, the outbound
	is corrected from the Queue Item (the dispatcher's own state) and the count is logged."""
	Q = frappe.qb.DocType("WhatsApp Queue Item")
	L = frappe.qb.DocType("WhatsApp Log")
	rows = (
		frappe.qb.from_(Q)
		.join(L)
		.on(L.name == Q.outbound_message)
		.select(Q.name.as_("queue_item"), Q.status.as_("qs"), L.name.as_("outbound"), L.status.as_("os"))
		.where(Q.status.isin(list(ALLOWED)))
		.run(as_dict=True)
	)
	drifts: list[Drift] = []
	fix_to = {
		"Queued": "Queued",
		"Sending": "Sending",
		"Paused": "Queued",
		"Deleted": "Cancelled",
		"Dead Letter": "Failed",
	}
	for r in rows:
		if r.os in ALLOWED[r.qs]:
			continue
		target = fix_to.get(r.qs)
		drifts.append(Drift(r.queue_item, r.outbound, r.qs, r.os, target if fix else None))
		if fix and target:
			with status_writer():
				values: dict[str, Any] = {"status": target}
				if target == "Failed":
					values.update({"error_code": "unknown", "error_message": "reconciled from dead letter"})
				frappe.db.set_value("WhatsApp Log", r.outbound, values, update_modified=True)
	if drifts:
		frappe.log_error(
			title="WhatsApp reconcile: status drift",
			message=f"{len(drifts)} pair(s)" + (" fixed" if fix else ""),
		)
	return drifts


def resolve_expired_holds(days: int = HELD_EXPIRY_DAYS) -> int:
	"""`Held` outbound older than N days → ask the provider once; `Cancelled`/unknown → `Failed`."""
	cutoff = add_to_date(now_datetime(), days=-cint(days or HELD_EXPIRY_DAYS))
	rows = frappe.get_all(
		"WhatsApp Log", filters={"status": "Held", "held_at": ("<", cutoff)}, pluck="name", limit=MAX_REFS
	)
	if not rows:
		return 0
	looked = _lookup(rows)
	if looked is None:
		return 0
	by_ref, unknown = looked
	n = 0
	for name in rows:
		s = by_ref.get(name)
		if s and _apply_platform_status(name, s) != "wait":
			n += 1
		elif name in unknown or (s and s.status == "Held"):
			dispatch.apply_status(
				name, "Failed", error_code="platform_rejected", reason="hold expired", source="reconcile"
			)
			n += 1
	return n


def finalize_campaigns() -> int:
	"""`Running` campaigns with no open outbound → `campaign_runner.finalize_if_done`."""
	try:
		from whatsapp_next.services import campaign_runner
	except ImportError:  # phase order: campaign_runner lands in B-15
		return 0
	n = 0
	for name in frappe.get_all("WhatsApp Campaign", filters={"status": "Running"}, pluck="name"):
		if campaign_runner.finalize_if_done(name):
			n += 1
	return n

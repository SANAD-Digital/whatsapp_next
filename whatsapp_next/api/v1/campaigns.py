# Module role: API of the Campaigns screen (backend-plan §4.6 `campaigns.*`, screen 6). Thin
# wrappers over services/campaign_runner.py — the single status writer of WhatsApp Campaign —
# plus read helpers (progress, sending-now card, recipients page, message preview, poll
# results). Writes need the Manager role **and** write permission on the campaign document.
# `pause_many` / `resume_many` / `cancel_many` are the 09 G-01 additive bulk variants.

from __future__ import annotations

from collections.abc import Callable
from datetime import datetime
from typing import Any

import frappe
from frappe import _

from whatsapp_next.api._common import api_endpoint, paginate
from whatsapp_next.api.v1 import _bulk
from whatsapp_next.api.v1._roles import MANAGER, VIEWER_UP
from whatsapp_next.exceptions import WANotFoundError, WAPermissionError
from whatsapp_next.services import campaign_runner as runner

RECIPIENT_FIELDS: tuple[str, ...] = (
	"name",
	"idx",
	"recipient_type",
	"phone",
	"phone_e164",
	"jid",
	"display_name",
	"contact",
	"source_type",
	"contact_group",
	"source_doctype",
	"source_name",
	"status",
	"outbound_message",
	"error_code",
	"added_by",
	"added_at",
	"removed_by",
	"removed_at",
)
RECIPIENT_STATUSES = ("Pending", "Queued", "Sent", "Delivered", "Read", "Failed", "Cancelled", "Removed")
SOURCE_TYPES = ("Contact Group", "Contact", "DocType", "Excel", "vCard", "Manual")


def _require(name: str, ptype: str) -> None:
	"""Existence (`WANotFoundError`) + document permission (`WAPermissionError`) on a campaign."""
	if not frappe.db.exists("WhatsApp Campaign", name):
		frappe.throw(_("WhatsApp Campaign {0} not found").format(name), WANotFoundError)
	if not frappe.has_permission("WhatsApp Campaign", ptype, doc=name):
		frappe.throw(_("Not permitted to {0} campaign {1}").format(_(ptype), name), WAPermissionError)


def _status(name: str) -> str:
	return frappe.db.get_value("WhatsApp Campaign", name, "status")


# ---- lifecycle -------------------------------------------------------------------------


@api_endpoint(roles=MANAGER)
def start(name: str) -> dict[str, Any]:
	"""`Draft | Scheduled → Queued` now; materialization runs in a `long` job → `{status}`.
	`WAStateConflictError` in any other status, `WAValidationError` when not startable."""
	_require(name, "write")
	return {"status": runner.start(name, user=frappe.session.user)}


@api_endpoint(roles=MANAGER)
def schedule(name: str, scheduled_at: datetime) -> dict[str, Any]:
	"""`Draft → Scheduled` at a future time → `{status, scheduled_at}`."""
	_require(name, "write")
	status = runner.schedule(name, scheduled_at, user=frappe.session.user)
	return {"status": status, "scheduled_at": frappe.db.get_value("WhatsApp Campaign", name, "scheduled_at")}


@api_endpoint(roles=MANAGER)
def unschedule(name: str) -> dict[str, Any]:
	"""`Scheduled → Draft` → `{status}`."""
	_require(name, "write")
	return {"status": runner.unschedule(name, user=frappe.session.user)}


@api_endpoint(roles=MANAGER)
def pause(name: str, reason: str | None = None) -> dict[str, Any]:
	"""`Running → Paused`; open queue rows paused → `{status, count}`; audited."""
	_require(name, "write")
	count = runner.pause(name, user=frappe.session.user, reason=reason)
	return {"status": _status(name), "count": count}


@api_endpoint(roles=MANAGER)
def resume(name: str) -> dict[str, Any]:
	"""`Paused → Running`; paused queue rows resumed → `{status, count}`; audited."""
	_require(name, "write")
	count = runner.resume(name, user=frappe.session.user)
	return {"status": _status(name), "count": count}


@api_endpoint(roles=MANAGER)
def cancel(name: str, reason: str | None = None) -> dict[str, Any]:
	"""Any non-terminal status → `Cancelled`; open queue rows deleted-as-state → `{status, count}`."""
	_require(name, "write")
	count = runner.cancel(name, user=frappe.session.user, reason=reason)
	return {"status": _status(name), "count": count}


def _many(names: list[str], applies: Callable[[str], bool], action: Callable[[str], int]) -> dict[str, Any]:
	"""Bulk helper (09 G-01) over `_bulk.run_bulk`: campaigns whose status does not apply are
	reported in `skipped`; each action runs in its own savepoint."""

	def one(name: str) -> None:
		status = _status(name)
		if status is None:
			frappe.throw(_("WhatsApp Campaign {0} not found").format(name), WANotFoundError)
		if not applies(status):
			raise _bulk.Skip(status)
		_require(name, "write")
		action(name)

	return _bulk.run_bulk(names, one)


@api_endpoint(roles=MANAGER)
def pause_many(names: list[str], reason: str | None = None) -> dict[str, Any]:
	"""Pause every `Running` / `Queued` campaign in `names` (others skipped)."""
	return _many(
		names,
		lambda s: s in ("Running", "Queued"),
		lambda n: runner.pause(n, user=frappe.session.user, reason=reason),
	)


@api_endpoint(roles=MANAGER)
def resume_many(names: list[str]) -> dict[str, Any]:
	"""Resume every `Paused` campaign in `names` (others skipped)."""
	return _many(names, lambda s: s == "Paused", lambda n: runner.resume(n, user=frappe.session.user))


@api_endpoint(roles=MANAGER)
def cancel_many(names: list[str], reason: str | None = None) -> dict[str, Any]:
	"""Cancel every non-terminal campaign in `names` (terminal ones skipped)."""
	return _many(
		names,
		lambda s: s not in runner.TERMINAL,
		lambda n: runner.cancel(n, user=frappe.session.user, reason=reason),
	)


# ---- reads -----------------------------------------------------------------------------


@api_endpoint(roles=VIEWER_UP, methods=("GET", "POST"))
def get_progress(name: str) -> dict[str, Any]:
	"""Campaign fields + `counters{}` + `rates{messages_per_minute, sent_last_minute, percent,
	eta_seconds}` + `recent[]` (last changed outbound rows)."""
	_require(name, "read")
	return runner.progress(name)


@api_endpoint(roles=VIEWER_UP, methods=("GET", "POST"))
def get_sending_now() -> list[dict[str, Any]]:
	"""Campaigns `Running` / `Queued` / `Paused` with live counters (list stats card)."""
	return runner.sending_now()


@api_endpoint(
	roles=VIEWER_UP,
	methods=("GET", "POST"),
	schema={"status": {"enum": list(RECIPIENT_STATUSES)}, "source_type": {"enum": list(SOURCE_TYPES)}},
)
def get_recipients_page(
	name: str,
	status: str | None = None,
	source_type: str | None = None,
	search: str | None = None,
	page: int = 1,
	page_length: int = 50,
) -> dict[str, Any]:
	"""One page of the recipients child table → `{rows, total}`; `search` matches phone or name."""
	_require(name, "read")
	filters: list[list[Any]] = [
		["WhatsApp Campaign Recipient", "parent", "=", name],
		["WhatsApp Campaign Recipient", "parenttype", "=", "WhatsApp Campaign"],
	]
	if status:
		filters.append(["WhatsApp Campaign Recipient", "status", "=", status])
	if source_type:
		filters.append(["WhatsApp Campaign Recipient", "source_type", "=", source_type])
	or_filters: list[list[Any]] = []
	if search:
		like = f"%{search.strip()}%"
		or_filters = [
			["WhatsApp Campaign Recipient", "phone_e164", "like", like],
			["WhatsApp Campaign Recipient", "phone", "like", like],
			["WhatsApp Campaign Recipient", "display_name", "like", like],
		]
	start, length = paginate(page, page_length)
	rows = frappe.get_all(
		"WhatsApp Campaign Recipient",
		filters=filters,
		or_filters=or_filters,
		fields=list(RECIPIENT_FIELDS),
		order_by="idx asc",
		start=start,
		page_length=length,
	)
	total = frappe.get_all(
		"WhatsApp Campaign Recipient",
		filters=filters,
		or_filters=or_filters,
		fields=[{"COUNT": "name", "as": "n"}],
	)[0].n
	return {"rows": rows, "total": int(total or 0)}


@api_endpoint(roles=MANAGER, methods=("GET", "POST"))
def preview_message(name: str, idx: int, recipient_row: str | None = None) -> dict[str, Any]:
	"""Message `idx` (1-based) rendered for `recipient_row` (a recipients child-row name) or a
	sample recipient → `{body, attachment_name, message_type, errors[]}`."""
	_require(name, "read")
	return runner.preview_message(name, idx, recipient_row=recipient_row)


@api_endpoint(roles=MANAGER, methods=("GET", "POST"))
def get_poll_results(name: str, refresh: bool = False) -> dict[str, Any]:
	"""Aggregated poll results per Poll message (cached 10 min unless `refresh`) →
	`{results[{idx, question, options, counts, responses, errors, by_poll_id}]}`."""
	_require(name, "read")
	return runner.poll_results(name, refresh=refresh)

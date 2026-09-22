# Module role: the one audit insert function (security.md "audit every elevated write", fields.md
# §19, backend-plan §3). Rows are written under the real session user with `ignore_permissions`;
# phones are masked; secret-like keys are refused; scheduler jobs record their job name.

from __future__ import annotations

import json
import re
from collections.abc import Iterable
from typing import Any

import frappe
from frappe.utils import now_datetime

from whatsapp_next.services.phone import mask

SECRET_KEY_RE = re.compile(r"(key|secret|token|password|passwd|credential)", re.IGNORECASE)
PHONE_KEY_RE = re.compile(r"(phone|mobile|number|recipient|sender|jid)", re.IGNORECASE)
_PHONE_VALUE_RE = re.compile(r"^\+?\d{7,15}(@[a-z.]+)?$")

SEVERITY_BY_ACTION: dict[str, str] = {
	"Device Deleted": "Danger",
	"Credentials Changed": "Warning",
	"Queue Items Deleted": "Warning",
	"Campaign Cancelled": "Warning",
	"Function Removed": "Warning",
	"Retention Purge": "Info",
	"Connection Tested": "Info",
	"Elevated Contact Read": "Info",
}


def sanitize_details(details: dict[str, Any] | None) -> dict[str, Any]:
	"""Drop secret-like keys, mask phone-like values, and make the dict JSON-serialisable."""
	if not details:
		return {}
	out: dict[str, Any] = {}
	for key, value in details.items():
		if SECRET_KEY_RE.search(str(key)):
			continue
		out[str(key)] = _sanitize_value(str(key), value)
	return out


def _sanitize_value(key: str, value: Any) -> Any:
	if isinstance(value, dict):
		return sanitize_details(value)
	if isinstance(value, list | tuple | set):
		return [_sanitize_value(key, v) for v in value]
	if isinstance(value, str):
		if PHONE_KEY_RE.search(key) or _PHONE_VALUE_RE.match(value.strip()):
			return mask(value)
		return value[:500]
	if isinstance(value, int | float | bool) or value is None:
		return value
	return str(value)[:200]


def log(
	action: str,
	*,
	reference: tuple[str, str] | None = None,
	target: tuple[str, str] | None = None,
	fields_written: Iterable[str] = (),
	reason: str | None = None,
	count: int | None = None,
	details: dict[str, Any] | None = None,
	severity: str | None = None,
	summary: str | None = None,
	summary_args: dict[str, Any] | None = None,
	user: str | None = None,
) -> str:
	"""Insert one WhatsApp Audit Log row and return its name.

	- `reference` / `target`: `(doctype, name)` tuples (acted-on record, secondary record).
	- `fields_written`: fieldnames only, never values (security.md condition 3).
	- `summary`: an English template key rendered with `__()` at read time; `summary_args` go to
	  `details.summary_args` (D-029 fields OQ-C). Defaults to `action`.
	- Runs under `frappe.session.user`; in a scheduler job the RQ job name is recorded too.
	"""
	job = getattr(frappe.local, "job", None)
	safe_details = sanitize_details(details)
	if summary_args:
		safe_details["summary_args"] = sanitize_details(summary_args)
	doc = frappe.get_doc(
		{
			"doctype": "WhatsApp Audit Log",
			"action": action,
			"severity": severity or SEVERITY_BY_ACTION.get(action, "Action"),
			"summary": (summary or action)[:140],
			"user": user or frappe.session.user,
			"job_name": getattr(job, "name", None) if job else None,
			"timestamp": now_datetime(),
			"reference_doctype": reference[0] if reference else None,
			"reference_name": reference[1] if reference else None,
			"target_doctype": target[0] if target else None,
			"target_name": target[1] if target else None,
			"fields_written": ", ".join(sorted(set(fields_written))) or None,
			"reason": (reason or "")[:500] or None,
			"count": count,
			"ip_address": getattr(frappe.local, "request_ip", None),
			"details": json.dumps(safe_details, default=str, ensure_ascii=False) if safe_details else None,
		}
	)
	doc.flags.ignore_permissions = True
	doc.flags.wa_audit_insert = True
	doc.insert(ignore_permissions=True)
	return doc.name

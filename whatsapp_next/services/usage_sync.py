# Module role: subscription / usage cache (backend-plan §3 `usage_sync.py`). Mirrors the
# provider's account view into the `WhatsApp Settings` cache fields (plan, limits, wallet,
# features) hourly and after a connection test. System cache — no audit, `ignore_permissions`.

from __future__ import annotations

from datetime import date
from typing import Any

import frappe
from frappe.utils import cint, flt, now_datetime

from whatsapp_next.providers import exceptions as pex
from whatsapp_next.providers import registry
from whatsapp_next.providers.schemas import AccountInfo, UsageReport

FIELDS = (
	"plan_code",
	"plan_name",
	"subscription_status",
	"message_limit",
	"messages_used",
	"messages_remaining",
	"plan_messages_per_minute",
	"device_limit",
	"wallet_balance",
	"wallet_currency",
	"subscription_start",
	"subscription_end",
	"plan_features",
	"subscription_synced_at",
)


def _values(info: AccountInfo) -> dict[str, Any]:
	return {
		"plan_code": info.plan_code,
		"plan_name": info.plan_name,
		"subscription_status": info.status,
		"message_limit": cint(info.message_limit),
		"messages_used": cint(info.messages_used),
		"messages_remaining": cint(info.messages_remaining),
		"plan_messages_per_minute": cint(info.messages_per_minute),
		"device_limit": cint(info.device_limit),
		"wallet_balance": flt(info.wallet_balance) if info.wallet_balance is not None else None,
		"wallet_currency": info.wallet_currency
		if info.wallet_currency and frappe.db.exists("Currency", info.wallet_currency)
		else None,
		"subscription_start": info.start_date,
		"subscription_end": info.end_date,
		"plan_features": frappe.as_json(
			{**(info.features or {}), "webhook_events": info.webhook_events or {}}
		),
		"subscription_synced_at": now_datetime(),
	}


def sync_subscription() -> dict[str, Any] | None:
	"""Hourly (+ after `test_connection`): `get_account` → Settings cache fields. Never raises."""
	try:
		info = registry.get_provider().get_account()
	except pex.ProviderError as exc:
		frappe.log_error(title="WhatsApp usage sync failed", message=f"code={exc.code}")
		return None
	values = _values(info)
	# Never let the local rate exceed the plan's rate (Settings validation would reject saves).
	current_rate = cint(frappe.db.get_single_value("WhatsApp Settings", "messages_per_minute"))
	if values["plan_messages_per_minute"] and current_rate > values["plan_messages_per_minute"]:
		values["messages_per_minute"] = values["plan_messages_per_minute"]
	frappe.db.set_value("WhatsApp Settings", "WhatsApp Settings", values, update_modified=False)
	frappe.clear_document_cache("WhatsApp Settings", "WhatsApp Settings")
	return values


def sync_usage(from_: date, to: date, group_by: str = "day") -> UsageReport | None:
	"""Usage rows for a period (Settings page charts); `None` when the provider cannot report."""
	try:
		return registry.get_provider().get_usage(from_, to, group_by)
	except pex.NotSupportedError:
		return None
	except pex.ProviderError as exc:
		frappe.log_error(title="WhatsApp usage report failed", message=f"code={exc.code}")
		return None


def snapshot() -> dict[str, Any]:
	"""The cached fields as a dict for the Settings page."""
	s = frappe.get_cached_doc("WhatsApp Settings")
	out = {f: s.get(f) for f in FIELDS}
	try:
		out["plan_features"] = frappe.parse_json(s.plan_features) if s.plan_features else {}
	except Exception:
		out["plan_features"] = {}
	return out

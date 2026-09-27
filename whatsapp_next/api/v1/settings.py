# Module role: whitelisted endpoints of the Settings screen (backend-plan §4.1 `api.settings`,
# screen 15). Reads and writes `WhatsApp Settings` by section allow-list, exposes secrets only as
# `has_<field>` booleans, and wraps `services.onboarding` (connection test), `usage_sync`,
# `webhook_setup`, the audit log and the picker-source configuration. Thin: no business logic.

from __future__ import annotations

from dataclasses import asdict
from datetime import date
from typing import Any

import frappe
from frappe import _
from frappe.utils import cint

from whatsapp_next.api._common import api_endpoint, paginate
from whatsapp_next.api.v1._roles import AGENT_UP, CONTACT_USER, MANAGER, SYSTEM_MANAGER, VIEWER_UP
from whatsapp_next.exceptions import WANotSupportedError, WAProviderUnavailableError, WAValidationError
from whatsapp_next.providers.schemas import CANONICAL_EVENTS
from whatsapp_next.services import audit, onboarding, permissions, usage_sync, webhook_setup

SETTINGS = "WhatsApp Settings"

# Section → readable non-secret fieldnames (fields.md §15 tabs). Password fields are never listed;
# they surface as `has_<field>` (see SECRET_FIELDS). permlevel-1 values are never returned.
SECTIONS: dict[str, tuple[str, ...]] = {
	"provider": (
		"provider",
		"platform_base_url",
		"request_timeout",
		"connection_status",
		"last_connection_test_at",
		"last_connection_latency_ms",
		"last_connection_error",
	),
	"credentials": (),
	"webhook": (
		"webhook_endpoint",
		"webhook_endpoint_url",
		"webhook_status",
		"webhook_events",
		"webhook_max_retries",
		"webhook_synced_at",
		"webhook_last_event_at",
	),
	"queue": (
		"messages_per_minute",
		"max_attempts",
		"retry_backoff_seconds",
		"queue_paused",
		"queue_paused_by",
		"queue_paused_at",
		"queue_pause_reason",
	),
	"commands": (
		"enable_commands",
		"command_service_user",
		"unknown_command_reply",
		"send_receipt_reply",
		"receipt_reply",
		"reply_device",
	),
	"policy": ("default_device", "default_country", "global_blacklist_group", "send_only_to_known_numbers"),
	"picker": ("picker_sources",),
	"retention": (
		"outbound_retention_days",
		"inbound_retention_days",
		"queue_retention_days",
		"webhook_event_retention_days",
		"audit_retention_days",
		"numbers_watermark",
		"numbers_last_run_at",
	),
	"subscription": tuple(usage_sync.FIELDS),
	"onboarding": ("setup_completed", "setup_completed_at", "redirect_unregistered_to_wizard"),
}

# Section → fieldnames `save_settings` may write. Credentials go through `onboarding.save_credentials`;
# webhook events / status, queue pause / rate and the subscription cache have their own endpoints.
WRITABLE: dict[str, tuple[str, ...]] = {
	"provider": ("provider", "platform_base_url", "request_timeout"),
	"webhook": ("webhook_max_retries",),
	"queue": ("max_attempts", "retry_backoff_seconds"),
	"commands": SECTIONS["commands"],
	"policy": SECTIONS["policy"],
	"picker": ("picker_sources",),
	"retention": SECTIONS["retention"][:5],
	"onboarding": ("redirect_unregistered_to_wizard",),
}

# Password fields exposed as `has_<field>` booleans (section they belong to).
SECRET_FIELDS: dict[str, tuple[str, ...]] = {
	"credentials": ("customer_api_key", "api_key", "api_secret"),
	"webhook": ("webhook_secret",),
}

PICKER_SOURCE_FIELDS = (
	"document_type",
	"label",
	"phone_source",
	"phone_fieldname",
	"contact_fieldname",
	"name_fieldname",
	"filters_json",
	"enabled",
)
DOCTYPE_FIELD_TYPES = ("Data", "Phone", "Link", "Dynamic Link", "Small Text")
AUDIT_FIELDS = (
	"name",
	"action",
	"severity",
	"summary",
	"user",
	"job_name",
	"timestamp",
	"reference_doctype",
	"reference_name",
	"target_doctype",
	"target_name",
	"fields_written",
	"reason",
	"count",
	"ip_address",
	"details",
)
USAGE_CACHE_SECONDS = 600


def _section_values(doc, section: str) -> dict[str, Any]:
	out: dict[str, Any] = {}
	for fieldname in SECTIONS[section]:
		value = doc.get(fieldname)
		if fieldname == "picker_sources":
			value = [{f: row.get(f) for f in PICKER_SOURCE_FIELDS} for row in (value or [])]
		out[fieldname] = value
	for fieldname in SECRET_FIELDS.get(section, ()):
		out[f"has_{fieldname}"] = onboarding.has_secret(doc, fieldname)
	if section == "policy":
		out.update(_policy_extras())
	return out


@api_endpoint(roles=MANAGER, methods=("GET", "POST"), schema={"section": {"enum": list(SECTIONS)}})
def get_settings(section: str | None = None) -> dict[str, Any]:
	"""Non-secret Settings values per section (all sections when `section` is omitted); Password
	fields appear only as `has_<field>` booleans."""
	doc = frappe.get_doc(SETTINGS)
	if section:
		return {section: _section_values(doc, section)}
	return {s: _section_values(doc, s) for s in SECTIONS}


def _policy_extras() -> dict[str, Any]:
	"""Computed, read-only: what role `All` can still do on `Contact` (R-028, D-125)."""
	return {"contact_open_to_all": permissions.contact_open_to_all()}


@api_endpoint(roles=SYSTEM_MANAGER, schema={"section": {"enum": list(WRITABLE)}})
def save_settings(section: str, values: dict) -> dict[str, Any]:
	"""Write the given fields of one section (fieldnames validated against the section's
	allow-list); audited `Settings Changed` with `fields_written`."""
	allowed = WRITABLE[section]
	unknown = sorted(set(values or {}) - set(allowed))
	if unknown:
		frappe.throw(
			_("Fields not allowed in section {0}: {1}").format(section, ", ".join(unknown)), WAValidationError
		)
	if not values:
		frappe.throw(_("Nothing to save"), WAValidationError)
	doc = frappe.get_doc(SETTINGS)
	changed: list[str] = []
	for fieldname, value in values.items():
		if fieldname == "picker_sources":
			if not isinstance(value, list):
				frappe.throw(_("picker_sources must be a list of rows"), WAValidationError)
			doc.set("picker_sources", [])
			for row in value:
				doc.append(
					"picker_sources", {f: row.get(f) for f in PICKER_SOURCE_FIELDS if f in (row or {})}
				)
			changed.append(fieldname)
			continue
		if doc.get(fieldname) != value:
			doc.set(fieldname, value)
			changed.append(fieldname)
	if changed:
		doc.flags.ignore_permissions = True
		doc.save(ignore_permissions=True)
		audit.log("Settings Changed", fields_written=changed, details={"section": section})
	return {"ok": True, "changed": changed}


@api_endpoint(roles=MANAGER)
def test_connection() -> dict[str, Any]:
	"""Provider health check → `{ok, latency_ms, plan_code, error}`; writes `connection_status*`
	and never raises on provider failure."""
	return onboarding.test_connection(user=frappe.session.user)


@api_endpoint(roles=MANAGER)
def sync_subscription() -> dict[str, Any]:
	"""Refresh the plan / usage cache from the provider now (`WAProviderAuthError` on bad keys)."""
	values = usage_sync.sync_subscription(raise_errors=True)
	return {"synced_at": values.get("subscription_synced_at") if values else None, **usage_sync.snapshot()}


@api_endpoint(
	roles=VIEWER_UP, methods=("GET", "POST"), schema={"group_by": {"enum": ["day", "week", "month"]}}
)
def get_usage(from_date: date, to_date: date, group_by: str = "day") -> dict[str, Any]:
	"""Usage rows for a period from the provider, cached 10 minutes (`WANotSupportedError` when
	the provider cannot report usage)."""
	if from_date > to_date:
		frappe.throw(_("from_date must not be after to_date"), WAValidationError)
	key = f"wa:usage:{from_date}:{to_date}:{group_by}"
	cached = frappe.cache.get_value(key)
	if cached:
		return cached
	report = usage_sync.sync_usage(from_date, to_date, group_by)
	if report is None:
		frappe.throw(_("Usage reports are not available for this provider"), WANotSupportedError)
	out = {
		"rows": [asdict(r) for r in report.rows],
		"from": str(report.from_),
		"to": str(report.to),
		"group_by": report.group_by,
	}
	frappe.cache.set_value(key, out, expires_in_sec=USAGE_CACHE_SECONDS)
	return out


def _endpoint(summary: webhook_setup.EndpointSummary) -> dict[str, Any]:
	data = asdict(summary)
	data["endpoint_url"] = data.pop("url")
	data["events"] = list(summary.events)
	return data


@api_endpoint(roles=SYSTEM_MANAGER)
def setup_webhook() -> dict[str, Any]:
	"""Register (or re-point) the provider endpoint at this site's receiver; audited."""
	return _endpoint(webhook_setup.ensure_endpoint(user=frappe.session.user))


@api_endpoint(roles=SYSTEM_MANAGER, schema={"status": {"enum": ["Active", "Disabled"]}})
def set_webhook_status(status: str) -> dict[str, Any]:
	"""`Active` / `Disabled` (`Active` also unlocks a `Locked` endpoint)."""
	return {"status": webhook_setup.set_status(status, user=frappe.session.user).status}


@api_endpoint(roles=SYSTEM_MANAGER)
def set_webhook_events(events: list[str]) -> dict[str, Any]:
	"""Replace the subscribed event list (canonical names only)."""
	unknown = sorted(set(events or []) - set(CANONICAL_EVENTS))
	if unknown or not events:
		frappe.throw(_("Unknown webhook events: {0}").format(", ".join(unknown) or "-"), WAValidationError)
	summary = webhook_setup.ensure_endpoint(user=frappe.session.user, events=list(events))
	return {"events": list(summary.events)}


@api_endpoint(roles=SYSTEM_MANAGER)
def rotate_webhook_secret() -> dict[str, Any]:
	"""Fetch the (rotated) signing secret from the provider again; audited `Credentials Changed`."""
	if not webhook_setup.rotate_secret(user=frappe.session.user):
		frappe.throw(_("The provider did not return a webhook secret"), WAProviderUnavailableError)
	return {"rotated_at": frappe.db.get_single_value(SETTINGS, "credentials_updated_at")}


@api_endpoint(roles=MANAGER)
def test_webhook() -> dict[str, Any]:
	"""Ask the provider to deliver a `test.webhook` event → `{status, http_status_code}`."""
	result = webhook_setup.test(user=frappe.session.user)
	detail = result.get("detail") or {}
	return {
		"status": "ok" if result.get("ok") else "failed",
		"http_status_code": cint(detail.get("http_status_code") or detail.get("http_status")) or None,
		"detail": detail,
	}


@api_endpoint(roles=MANAGER, methods=("GET", "POST"))
def list_webhook_events_available() -> list[dict[str, Any]]:
	"""`[{event_name, enabled, disabled_reason, subscribed}]` from the provider."""
	return webhook_setup.available_events()


@api_endpoint(roles=MANAGER, methods=("GET", "POST"))
def list_audit_log(filters: dict | None = None, page: int = 1, page_length: int = 20) -> dict[str, Any]:
	"""Audit rows newest first; `filters{action, user, from, to}`."""
	f = filters or {}
	unknown = sorted(set(f) - {"action", "user", "from", "to"})
	if unknown:
		frappe.throw(_("Unknown filters: {0}").format(", ".join(unknown)), WAValidationError)
	query: dict[str, Any] = {}
	if f.get("action"):
		query["action"] = f["action"]
	if f.get("user"):
		query["user"] = f["user"]
	if f.get("from") and f.get("to"):
		query["timestamp"] = ("between", [f["from"], f["to"]])
	elif f.get("from"):
		query["timestamp"] = (">=", f["from"])
	elif f.get("to"):
		query["timestamp"] = ("<=", f["to"])
	start, length = paginate(page, page_length)
	rows = frappe.get_all(
		"WhatsApp Audit Log",
		filters=query,
		fields=list(AUDIT_FIELDS),
		order_by="timestamp desc, name desc",
		start=start,
		page_length=length,
	)
	return {"rows": rows, "total": frappe.db.count("WhatsApp Audit Log", query)}


@api_endpoint(roles=AGENT_UP + CONTACT_USER, methods=("GET", "POST"))
def list_picker_sources() -> list[dict[str, Any]]:
	"""Configured `WhatsApp Settings Picker Source` rows (ContactPicker source 3)."""
	doc = frappe.get_cached_doc(SETTINGS)
	return [{f: row.get(f) for f in PICKER_SOURCE_FIELDS} for row in (doc.get("picker_sources") or [])]


@api_endpoint(roles=MANAGER, methods=("GET", "POST"))
def get_doctype_fields(document_type: str) -> list[dict[str, Any]]:
	"""`[{fieldname, label, fieldtype, options}]` of the phone / name / link candidate fields of a
	regular DocType (picker source form, notification recipient selects)."""
	if not frappe.db.exists("DocType", document_type):
		frappe.throw(_("DocType {0} not found").format(document_type), WAValidationError)
	meta = frappe.get_meta(document_type)
	if meta.istable or meta.issingle:
		frappe.throw(_("{0} must be a regular DocType").format(document_type), WAValidationError)
	out = [{"fieldname": "name", "label": _("ID"), "fieldtype": "Data", "options": None}]
	for df in meta.fields:
		if df.fieldtype in DOCTYPE_FIELD_TYPES:
			out.append(
				{
					"fieldname": df.fieldname,
					"label": _(df.label or df.fieldname),
					"fieldtype": df.fieldtype,
					"options": df.options,
				}
			)
	return out

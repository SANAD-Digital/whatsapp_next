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
from frappe.utils import add_days, cint, get_datetime, getdate

from whatsapp_next.api._common import api_endpoint, paginate
from whatsapp_next.api.v1._roles import AGENT_UP, CONTACT_USER, MANAGER, SYSTEM_MANAGER, VIEWER_UP
from whatsapp_next.exceptions import WANotSupportedError, WAProviderUnavailableError, WAValidationError
from whatsapp_next.providers.schemas import CANONICAL_EVENTS
from whatsapp_next.services import audit, command_menu, onboarding, permissions, usage_sync, webhook_setup
from whatsapp_next.services import settings as settings_service
from whatsapp_next.services.settings import PICKER_SOURCE_FIELDS

SETTINGS = "WhatsApp Settings"

# Section → readable non-secret fieldnames (fields.md §15 tabs). Password fields are never listed;
# they surface as `has_<field>` (see SECRET_FIELDS). permlevel-1 values are never returned.
SECTIONS: dict[str, tuple[str, ...]] = {
	"provider": (
		"platform_base_url",
		"request_timeout",
		"connection_status",
		"last_connection_test_at",
		"last_connection_latency_ms",
		"last_connection_error",
		# the user the site sends and receives as (`services/service_user.py`)
		"command_service_user",
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
		"unknown_command_reply",
		"command_help_token",
		"command_reply_language",
		"send_receipt_reply",
		"receipt_reply",
		"reply_on_edit",
		"edit_reply_text",
		"reply_on_delete",
		"delete_reply_text",
		"changes_reply_scope",
		"main_menu_mode",
		"main_menu_text",
		"main_menu_button",
		"main_menu_words",
		"mark_read_mode",
		"typing_indicator",
	),
	"policy": (
		"default_device",
		"default_country",
		"global_blacklist_group",
		"send_only_to_known_numbers",
		"import_past_messages",
	),
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
	"provider": ("platform_base_url", "request_timeout"),
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
	"credentials": ("customer_api_key", "customer_api_secret", "api_key", "api_secret"),
	"webhook": ("webhook_secret",),
}

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
		# a field added after the Settings row was saved shows its default, which is also what
		# the services act on (`settings.stored_or_default`)
		value = settings_service.stored_or_default(fieldname)
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
	changed = settings_service.save_fields(values, section=section, user=frappe.session.user)
	return {"ok": True, "changed": changed}


@api_endpoint(roles=MANAGER, methods=("GET", "POST"), schema={"text": {"max_length": 500}})
def get_whatsapp_link(text: str | None = None, device: str | None = None) -> dict[str, Any]:
	"""The wa.me link and its QR code (data URI) for a message typed in advance — the preview of
	the print-format functions `whatsapp_link` / `whatsapp_qr`."""
	from whatsapp_next.services import wa_links

	return {"url": wa_links.link(text, device), "qr": wa_links.qr_data_uri(text, device)}


@api_endpoint(roles=MANAGER, methods=("GET", "POST"))
def get_main_menu() -> dict[str, Any]:
	"""Every Active command with its main-menu fields, the menu's own first and in order."""
	return {"commands": command_menu.editable_items(), "max": command_menu.MAX_ROWS}


@api_endpoint(roles=SYSTEM_MANAGER)
def save_main_menu(commands: list) -> dict[str, Any]:
	"""The main menu becomes `commands` (`[{command, menu_description}]`, in order); audited."""
	changed = command_menu.save_items(commands, user=frappe.session.user)
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


@api_endpoint(roles=VIEWER_UP, methods=("GET", "POST"))
def get_site_usage(from_date: date, to_date: date) -> dict[str, Any]:
	"""Messages this site sent per day — sent, delivered, read, failed — from its own outbound
	log, every day of the period included. Always available, unlike the provider's report."""
	if from_date > to_date:
		frappe.throw(_("from_date must not be after to_date"), WAValidationError)
	if (to_date - from_date).days >= usage_sync.SITE_MAX_DAYS:
		frappe.throw(_("A usage period is at most {0} days").format(usage_sync.SITE_MAX_DAYS), WAValidationError)
	return {"rows": usage_sync.site_daily(from_date, to_date), "from": str(from_date), "to": str(to_date)}


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
	query: list[list[Any]] = []
	if f.get("action"):
		query.append(["action", "=", f["action"]])
	if f.get("user"):
		query.append(["user", "=", f["user"]])
	# `from` / `to` are days and `timestamp` a date-time: the period runs from the start of `from`
	# to the end of `to` (a bare `<= to` stopped at its midnight and dropped the whole last day)
	try:
		if f.get("from"):
			query.append(["timestamp", ">=", get_datetime(getdate(f["from"]))])
		if f.get("to"):
			query.append(["timestamp", "<", get_datetime(add_days(getdate(f["to"]), 1))])
	except Exception:
		frappe.throw(_("from and to must be dates"), WAValidationError)
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


@api_endpoint(roles=MANAGER, methods=("GET", "POST"))
def list_picker_candidates() -> list[dict[str, Any]]:
	"""The screens that can give the contact picker numbers, best first (`services.picker_sources`)."""
	from whatsapp_next.services import picker_sources

	return picker_sources.candidates()


# System Manager, as saving a source is: it reads records of any screen, past their permissions
@api_endpoint(roles=SYSTEM_MANAGER, methods=("GET", "POST"))
def analyze_picker_doctype(document_type: str) -> dict[str, Any]:
	"""A screen's number, name and contact fields, with how many records fill each and a best guess."""
	from whatsapp_next.services import picker_sources

	return picker_sources.analyze(document_type)


# System Manager, as saving a source is: it reads records of any screen, past their permissions
@api_endpoint(roles=SYSTEM_MANAGER, methods=("GET", "POST"))
def preview_picker_source(source: str | dict) -> dict[str, Any]:
	"""How a source being edited reaches people → `{total, with_number, sample[]}`."""
	from whatsapp_next.services import picker_sources

	return picker_sources.preview(source)


@api_endpoint(roles=MANAGER, methods=("GET", "POST"))
def export_backup() -> dict[str, Any]:
	"""The app's backup (Settings without keys or devices, templates, notifications, alerts,
	functions, commands, contact groups) as a dict; the client saves it as a JSON file."""
	from whatsapp_next.services import backup

	data = backup.export_backup()
	counts = {doctype: len(rows) for doctype, rows in data["records"].items()}
	audit.log("Backup Exported", user=frappe.session.user, details={"records": counts})
	return data


@api_endpoint(roles=SYSTEM_MANAGER)
def preview_backup(data: str) -> dict[str, Any]:
	"""What importing this backup file would do, nothing written → `{site, exported_at, settings,
	add[], replace[], keep[], switched_off}` (services.backup)."""
	from whatsapp_next.services import backup

	return backup.preview_backup(data)


@api_endpoint(roles=SYSTEM_MANAGER)
def import_backup(data: str) -> dict[str, Any]:
	"""Bring a backup file in → `{settings, created, updated, kept, switched_off, failed[]}`
	(services.backup)."""
	from whatsapp_next.services import backup

	return backup.import_backup(data, user=frappe.session.user)

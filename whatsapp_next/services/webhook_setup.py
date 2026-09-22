# Module role: registration and upkeep of this site's webhook endpoint on the provider
# (backend-plan §3 `webhook_setup.py`, D-018). Stores the signing secret with
# `set_password` (never logged, never returned), mirrors the endpoint state
# (`Active / Disabled / Locked / Revoked`) into Settings, and writes the
# `Webhook Changed` / `Credentials Changed` audit rows.

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import frappe
from frappe import _
from frappe.utils import cint, get_url, now_datetime

from whatsapp_next.exceptions import WAValidationError
from whatsapp_next.providers import exceptions as pex
from whatsapp_next.providers import registry
from whatsapp_next.providers.schemas import WebhookEndpointState
from whatsapp_next.services import audit

RECEIVER_METHOD = "whatsapp_next.webhooks.v1.receiver.receive"
DEFAULT_EVENTS = (
	"message.sent",
	"message.delivered",
	"message.read",
	"message.failed",
	"message.held",
	"message.received",
	"message.reaction",
	"connection.connected",
	"connection.disconnected",
	"connection.logged_out",
	"group.updated",
	"group.participants.updated",
)


@dataclass(frozen=True)
class EndpointSummary:
	endpoint_id: str | None
	url: str
	status: str | None
	events: tuple[str, ...]
	max_retries: int
	consecutive_failures: int
	locked_at: Any = None
	lock_reason: str | None = None
	last_event_at: Any = None
	synced_at: Any = None


def receiver_url() -> str:
	"""Absolute URL of the versioned receiver (D-031)."""
	return f"{get_url()}/api/method/{RECEIVER_METHOD}"


def _settings():
	return frappe.get_single("WhatsApp Settings")


def _mirror(state: WebhookEndpointState | None, *, synced: bool = True) -> None:
	values: dict[str, Any] = {"webhook_synced_at": now_datetime()} if synced else {}
	if state:
		values.update(
			{
				"webhook_endpoint": state.endpoint_id,
				"webhook_endpoint_url": state.url,
				"webhook_status": state.status
				if state.status in ("Active", "Disabled", "Locked", "Revoked")
				else None,
				"webhook_events": frappe.as_json(list(state.events)),
				"webhook_max_retries": str(state.max_retries)
				if str(state.max_retries) in ("1", "3", "5")
				else "3",
			}
		)
	frappe.db.set_value("WhatsApp Settings", "WhatsApp Settings", values, update_modified=False)
	frappe.clear_document_cache("WhatsApp Settings", "WhatsApp Settings")


def _events(settings) -> list[str]:
	try:
		events = frappe.parse_json(settings.webhook_events) if settings.webhook_events else None
	except Exception:
		events = None
	return list(events) if events else list(DEFAULT_EVENTS)


def summary() -> EndpointSummary:
	"""What Settings knows (no provider call)."""
	s = _settings()
	return EndpointSummary(
		endpoint_id=s.webhook_endpoint,
		url=s.webhook_endpoint_url or receiver_url(),
		status=s.webhook_status,
		events=tuple(_events(s)),
		max_retries=cint(s.webhook_max_retries) or 3,
		consecutive_failures=0,
		last_event_at=s.webhook_last_event_at,
		synced_at=s.webhook_synced_at,
	)


def fetch_secret(user: str | None = None) -> bool:
	"""Pull the signing secret from the provider and store it as a password; audited."""
	try:
		secret = registry.get_provider().get_webhook_secret()
	except pex.ProviderError as exc:
		frappe.log_error(title="WhatsApp webhook: secret fetch failed", message=f"code={exc.code}")
		return False
	from frappe.utils.password import set_encrypted_password

	set_encrypted_password("WhatsApp Settings", "WhatsApp Settings", secret, "webhook_secret")
	frappe.db.set_value(
		"WhatsApp Settings",
		"WhatsApp Settings",
		"credentials_updated_at",
		now_datetime(),
		update_modified=False,
	)
	frappe.clear_document_cache("WhatsApp Settings", "WhatsApp Settings")
	from whatsapp_next.webhooks import verify

	verify.reset_signature_failures()
	audit.log("Credentials Changed", user=user or "Administrator", details={"what": "webhook_secret"})
	return True


def ensure_endpoint(
	user: str | None = None, events: list[str] | None = None, max_retries: int | None = None
) -> EndpointSummary:
	"""Register (or re-point) the provider endpoint at this site's receiver, fetch the secret
	when none is stored, mirror the state. Idempotent."""
	s = _settings()
	provider = registry.get_provider()
	wanted_events = events or _events(s)
	retries = cint(max_retries) or cint(s.webhook_max_retries) or 3
	url = receiver_url()
	existing = None
	for ep in provider.list_webhook_endpoints():
		if ep.endpoint_id == s.webhook_endpoint or ep.url == url:
			existing = ep
			break
	if existing:
		changed = existing.url != url or set(existing.events) != set(wanted_events)
		state = (
			provider.update_webhook_endpoint(
				existing.endpoint_id,
				None,
				wanted_events if changed else None,
				url if existing.url != url else None,
			)
			if changed
			else existing
		)
	else:
		state = provider.configure_webhook(url, wanted_events, retries)
	_mirror(state)
	if not (s.get_password("webhook_secret", raise_exception=False) or ""):
		fetch_secret(user)
	audit.log(
		"Webhook Changed",
		user=user,
		details={
			"endpoint": state.endpoint_id,
			"status": state.status,
			"events": len(state.events),
			"action": "ensure",
		},
	)
	return summary()


def rotate_secret(user: str | None = None) -> bool:
	"""Ask the provider for the current secret again (after a platform-side rotation)."""
	ok = fetch_secret(user)
	if ok:
		audit.log("Webhook Changed", user=user, details={"action": "rotate_secret"})
	return ok


def set_status(status: str, user: str | None = None) -> EndpointSummary:
	"""`Active` / `Disabled` (Active also unlocks a `Locked` endpoint, A-06)."""
	if status not in ("Active", "Disabled"):
		frappe.throw(_("Status must be Active or Disabled"), WAValidationError)
	s = _settings()
	if not s.webhook_endpoint:
		frappe.throw(_("No webhook endpoint is registered yet"), WAValidationError)
	state = registry.get_provider().update_webhook_endpoint(s.webhook_endpoint, status, None, None)
	_mirror(state)
	audit.log("Webhook Changed", user=user, details={"action": "set_status", "status": status})
	return summary()


def sync_status() -> EndpointSummary | None:
	"""Hourly: mirror the provider's endpoint state (lock, failures) into Settings."""
	s = _settings()
	if not s.webhook_endpoint:
		return None
	try:
		for ep in registry.get_provider().list_webhook_endpoints():
			if ep.endpoint_id == s.webhook_endpoint:
				_mirror(ep)
				if ep.status == "Locked" and s.webhook_status != "Locked":
					frappe.log_error(
						title="WhatsApp webhook endpoint locked",
						message=f"reason={ep.lock_reason} failures={ep.consecutive_failures}",
					)
				return summary()
		_mirror(None)
		frappe.db.set_value(
			"WhatsApp Settings", "WhatsApp Settings", "webhook_status", "Revoked", update_modified=False
		)
	except pex.ProviderError as exc:
		frappe.log_error(title="WhatsApp webhook: sync failed", message=f"code={exc.code}")
	return summary()


def test(user: str | None = None) -> dict[str, Any]:
	"""Ask the provider to deliver a `test.webhook` event to this site."""
	s = _settings()
	if not s.webhook_endpoint:
		frappe.throw(_("No webhook endpoint is registered yet"), WAValidationError)
	result = registry.get_provider().test_webhook_endpoint(s.webhook_endpoint)
	audit.log("Connection Tested", user=user, details={"what": "webhook", "ok": bool(result.get("ok", True))})
	return {
		"ok": bool(result.get("ok", True)),
		"detail": {
			k: v
			for k, v in (result or {}).items()
			if k in ("ok", "status", "http_status", "delivered_at", "error")
		},
	}

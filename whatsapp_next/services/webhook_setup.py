# Module role: registration and upkeep of this site's webhook endpoint on the provider
# (backend-plan §3 `webhook_setup.py`, D-018). Stores the signing secret with
# `set_password` (never logged, never returned), mirrors the endpoint state
# (`Active / Disabled / Locked / Revoked`) into Settings, and writes the
# `Webhook Changed` / `Credentials Changed` audit rows.

from __future__ import annotations

from dataclasses import dataclass
from typing import Any
from urllib.parse import urlsplit, urlunsplit

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
	"message.edited",
	"message.deleted",
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


def _public_address(base: str) -> str:
	"""The site's address as the platform reaches it. Frappe 15 adds the bench's `webserver_port`
	on any server not run by supervisor or systemd (Frappe 16 only in developer mode): that port
	is inside the server, and a webhook registered at `https://site:8000` receives nothing while
	sending goes on working. A port someone chose (`host_name`, `http_port`) stays."""
	port = cint(frappe.conf.webserver_port)
	chosen = urlsplit(frappe.local.conf.host_name or frappe.local.conf.hostname or "").port
	address = urlsplit(base)
	if not port or address.port != port or chosen or frappe.conf.http_port or frappe.conf.developer_mode:
		return base
	return urlunsplit(address._replace(netloc=address.hostname))


def receiver_url() -> str:
	"""Absolute URL of the versioned receiver (D-031), on the site's own address (`get_url`).
	Nothing of this app is read from the site config (owner, 2026-10-19)."""
	base = _public_address(get_url().rstrip("/"))
	return f"{base}/api/method/{RECEIVER_METHOD}"


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
	frappe.db.set_single_value("WhatsApp Settings", values, update_modified=False)
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
	from whatsapp_next.services.settings import store_secret

	store_secret("webhook_secret", secret)
	frappe.db.set_single_value(
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
	user: str | None = None,
	events: list[str] | None = None,
	max_retries: int | None = None,
	refresh_secret: bool = False,
	url: str | None = None,
) -> EndpointSummary:
	"""Register (or re-point) the provider endpoint at this site's receiver, fetch the secret
	when none is stored (always with `refresh_secret`: new credentials may be another
	account's, so a stored secret proves nothing), mirror the state. Idempotent.

	`url`: keep this address. A background job passes the endpoint's own: outside a request Frappe
	cannot know the address people reach the site at (`http://`, and on Frappe 15 the bench's port)."""
	s = _settings()
	provider = registry.get_provider()
	wanted_events = events or _events(s)
	retries = cint(max_retries) or cint(s.webhook_max_retries) or 3
	url = url or receiver_url()
	existing = None
	endpoints = provider.list_webhook_endpoints()
	for ep in endpoints:
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
	_drop_duplicates(provider, endpoints, state)
	from whatsapp_next.services import secrets

	if refresh_secret or not secrets.read("webhook_secret"):
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


def _drop_duplicates(provider, endpoints: list[WebhookEndpointState], kept: WebhookEndpointState) -> None:
	"""Other endpoints of the account at this same address go. Each has its own signing secret and
	this site keeps one, so a second endpoint's deliveries were refused (401) and retried for ever
	(whatsapp.dev, 2026-11-08). One that cannot be removed is logged, never raised."""
	for ep in endpoints:
		if ep.endpoint_id == kept.endpoint_id or ep.url != kept.url or ep.status == "Revoked":
			continue
		try:
			provider.delete_webhook_endpoint(ep.endpoint_id)
		except Exception:
			frappe.log_error(title="WhatsApp webhook: a duplicate endpoint could not be removed", message=ep.endpoint_id)


def _own_endpoint(endpoints: list[WebhookEndpointState]) -> WebhookEndpointState | None:
	"""The account's endpoint on a site that never recorded one (its sign-in stopped half-way). An
	account belongs to one site, so it is the one pointing at this app's receiver."""
	ours = [ep for ep in endpoints if ep.status != "Revoked" and RECEIVER_METHOD in (ep.url or "")]
	return ours[0] if len(ours) == 1 else None


def _repair(ep: WebhookEndpointState) -> EndpointSummary | None:
	"""Bring back what a sign-in left unfinished, keeping the endpoint's address: only the
	device's connection events (the platform's seed, never a set-up this site chose: no message,
	receipt or reply would arrive), or no signing secret (every delivery would be refused)."""
	from whatsapp_next.services import secrets

	seed_only = not any(not e.startswith("connection.") for e in ep.events)
	if ep.status != "Active" or not (seed_only or not secrets.read("webhook_secret")):
		return None
	return ensure_endpoint(events=list(DEFAULT_EVENTS) if seed_only else list(ep.events), url=ep.url)


def sync_status() -> EndpointSummary | None:
	"""Hourly: mirror the provider's endpoint state (lock, failures) into Settings, and finish what
	a sign-in left undone (`_repair`)."""
	from whatsapp_next.services import secrets

	s = _settings()
	if not s.webhook_endpoint and not secrets.read("customer_api_key"):
		return None  # not linked to an account
	try:
		endpoints = registry.get_provider().list_webhook_endpoints()
		ep = next((e for e in endpoints if e.endpoint_id == s.webhook_endpoint), None) if s.webhook_endpoint else _own_endpoint(endpoints)
		if ep:
			repaired = _repair(ep)
			if repaired:
				return repaired
			_mirror(ep)
			if ep.status == "Locked" and s.webhook_status != "Locked":
				frappe.log_error(
					title="WhatsApp webhook endpoint locked",
					message=f"reason={ep.lock_reason} failures={ep.consecutive_failures}",
				)
			return summary()
		if not s.webhook_endpoint:
			return None
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
			if k in ("ok", "status", "http_status", "http_status_code", "delivered_at", "error")
		},
	}


def available_events() -> list[dict[str, Any]]:
	"""`[{event_name, enabled, disabled_reason}]` from the provider, marking which ones this site
	currently subscribes to (`subscribed`)."""
	subscribed = set(_events(_settings()))
	out = []
	for row in registry.get_provider().list_available_webhook_events():
		name = row.get("event_name")
		# an event this app does nothing with (polls, for now) is shown, not offered: ticking it
		# would only fill the log with events marked Ignored
		handled = name in DEFAULT_EVENTS
		out.append(
			{
				"event_name": name,
				"enabled": bool(row.get("enabled", True)) and handled,
				"disabled_reason": row.get("disabled_reason") or ("" if handled else _("This app does not use this event yet.")),
				"subscribed": name in subscribed,
			}
		)
	return out

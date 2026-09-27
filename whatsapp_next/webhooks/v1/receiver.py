# Module role: the **only guest endpoint** of the app (security.md; backend-plan §7.1; D-031
# versioned path `whatsapp_next.webhooks.v1.receiver.receive`). It authenticates the delivery
# (HMAC over `<ts>.<body>` + freshness), rate-limits per source IP, stores exactly one Webhook
# Event per `event_id`, resolves the device (never creates one) and hands processing to a
# `short` job. Target: < 50 ms, no business logic here.

from __future__ import annotations

import json
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

import frappe
from frappe.utils import now_datetime

from whatsapp_next.api._common import api_endpoint
from whatsapp_next.providers import registry
from whatsapp_next.webhooks import idempotency, verify

RATE_LIMIT_PER_MINUTE = 600  # per source IP (D-029 OQ-P6: a constant, not a setting)
RATE_KEY = "wa:webhook:rl:{ip}"
SECRET_MISSING_LOG_KEY = "wa:webhook:nosecret:logged"


@dataclass(frozen=True)
class Outcome:
	http_status: int
	body: dict[str, Any]
	event: str | None = None


def _rate_limited(ip: str | None) -> bool:
	if not ip:
		return False
	key = frappe.cache.make_key(RATE_KEY.format(ip=ip))
	count = int(frappe.cache.incr(key))
	if count == 1:
		frappe.cache.expire(key, 60)
	return count > RATE_LIMIT_PER_MINUTE


def _secret() -> str | None:
	settings = frappe.get_cached_doc("WhatsApp Settings")
	try:
		return settings.get_password("webhook_secret", raise_exception=False) or None
	except Exception:
		return None


def handle(headers: Mapping[str, str], raw_body: bytes, *, remote_ip: str | None = None) -> Outcome:
	"""Pure-ish core of the receiver (tests call it directly). Returns HTTP status + JSON body."""
	envelope = registry.get_provider().webhook_envelope(headers)
	event_id, event_name = envelope.event_id, envelope.event_name
	# 1. required headers (their names are the provider's: A-1)
	if not event_id or not envelope.signed:
		return Outcome(401, {"ok": False, "error": "missing headers"})
	if _rate_limited(remote_ip):
		return Outcome(429, {"ok": False, "error": "rate limited"})
	# 2. secret
	secret = _secret()
	if not secret:
		if not frappe.cache.get_value(SECRET_MISSING_LOG_KEY):
			frappe.cache.set_value(SECRET_MISSING_LOG_KEY, 1, expires_in_sec=600)
			frappe.log_error(title="WhatsApp webhook: secret not configured", message="receiver returned 503")
		return Outcome(503, {"ok": False, "error": "webhook secret not configured"})
	# 3–4. freshness + signature
	sig = verify.check(headers, raw_body, secret)
	if not sig.valid or not sig.fresh:
		if not sig.valid:
			verify.note_signature_failure()
		idempotency.store_ignored(
			event_id,
			event_name,
			reason="stale timestamp" if sig.valid else "invalid signature",
			signature_valid=sig.valid,
			timestamp_fresh=sig.fresh,
		)
		return Outcome(401, {"ok": False, "error": "stale timestamp" if sig.valid else "invalid signature"})
	# 5. parse
	try:
		body = json.loads(raw_body.decode("utf-8") if isinstance(raw_body, bytes) else raw_body)
		if not isinstance(body, dict):
			raise ValueError("body is not an object")
	except (ValueError, UnicodeDecodeError):
		return Outcome(400, {"ok": False, "error": "invalid json"})
	event = registry.get_provider().parse_webhook(headers, body)
	event_name = event.event_name or event_name or "unknown"
	# 7. device (never created)
	from whatsapp_next.services import devices

	device = devices.by_platform_device(event.platform_device)
	status, error = "Received", None
	if event.platform_device and not device:
		status, error = "Ignored", "unknown device"
		if event_name.startswith("connection."):
			frappe.log_error(
				title="WhatsApp webhook: connection event for unknown device",
				message=f"event={event_name} id={event.event_id}",
			)
	# 6 + 8. claim / duplicate
	c = idempotency.claim(
		event.event_id or event_id,
		event_name,
		payload=body,
		device=device,
		platform_device=event.platform_device,
		client_ref=event.client_ref,
		provider_message_id=event.provider_message_id,
		event_timestamp=event.timestamp,
		signature_valid=True,
		timestamp_fresh=True,
		status=status,
		error=error,
	)
	if c.duplicate:
		return Outcome(200, {"ok": True, "duplicate": True}, event=c.name)
	frappe.db.set_value(
		"WhatsApp Settings",
		"WhatsApp Settings",
		"webhook_last_event_at",
		now_datetime(),
		update_modified=False,
	)
	if status == "Ignored":
		return Outcome(200, {"ok": True, "ignored": True}, event=c.name)
	# 9. process in a job
	frappe.enqueue(
		"whatsapp_next.webhooks.handlers.process_event",
		event=c.name,
		queue="short",
		job_id=f"wa-webhook-{event.event_id or event_id}",
		deduplicate=True,
		enqueue_after_commit=True,
		timeout=120,
	)
	return Outcome(200, {"ok": True}, event=c.name)


@api_endpoint(allow_guest=True, methods=("POST",))
def receive(**_kwargs) -> dict[str, Any]:
	"""`POST /api/method/whatsapp_next.webhooks.v1.receiver.receive` — the provider's target."""
	request = frappe.request
	raw = request.get_data() if request else b""
	headers = dict(request.headers) if request else {}
	outcome = handle(headers, raw, remote_ip=getattr(frappe.local, "request_ip", None))
	frappe.local.response["http_status_code"] = outcome.http_status
	return outcome.body

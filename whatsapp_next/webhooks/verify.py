# Module role: signature and freshness check of an inbound provider webhook (backend-plan §7.1
# steps 3–4). Delegates the provider-specific rule (headers, HMAC formula) to
# `provider.verify_webhook`; owns the failure counter that triggers a secret re-fetch (PR-01).

from __future__ import annotations

from collections.abc import Mapping

import frappe

from whatsapp_next.providers import registry
from whatsapp_next.providers.schemas import SignatureCheck

MAX_SKEW_SECONDS = 300
SIGFAIL_KEY = "wa:webhook:sigfail"
SIGFAIL_WINDOW_SECONDS = 600
SIGFAIL_THRESHOLD = 5
SIGFAIL_REFETCH_FLAG = "wa:webhook:sigfail:refetch"


def check(headers: Mapping[str, str], raw_body: bytes, secret: str | None) -> SignatureCheck:
	"""`SignatureCheck(valid, fresh, event_timestamp, reason)` for the active provider."""
	if not secret:
		return SignatureCheck(valid=False, fresh=False, reason="no secret")
	return registry.get_provider().verify_webhook(headers, raw_body, secret, MAX_SKEW_SECONDS)


def note_signature_failure() -> int:
	"""Count invalid signatures in a 10-minute window; at the threshold enqueue one
	`webhook_setup.fetch_secret` (the platform may have rotated the secret). Returns the count."""
	key = frappe.cache.make_key(SIGFAIL_KEY)
	count = int(frappe.cache.incr(key))
	if count == 1:
		frappe.cache.expire(key, SIGFAIL_WINDOW_SECONDS)
	if count >= SIGFAIL_THRESHOLD and not frappe.cache.get_value(SIGFAIL_REFETCH_FLAG):
		frappe.cache.set_value(SIGFAIL_REFETCH_FLAG, 1, expires_in_sec=SIGFAIL_WINDOW_SECONDS)
		frappe.enqueue(
			"whatsapp_next.services.webhook_setup.fetch_secret",
			queue="short",
			job_id="wa-webhook-refetch-secret",
			deduplicate=True,
			enqueue_after_commit=True,
		)
	return int(count)


def reset_signature_failures() -> None:
	frappe.cache.delete(frappe.cache.make_key(SIGFAIL_KEY))
	frappe.cache.delete_value(SIGFAIL_REFETCH_FLAG)

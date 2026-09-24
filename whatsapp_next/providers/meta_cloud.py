# Module role: Meta WhatsApp Cloud API — a skeleton that proves the abstraction (architecture.md,
# backend-plan §2.6). Every network method raises NotImplementedError; pairing methods raise
# NotSupportedError (the Cloud API has no QR / pair code). `verify_webhook` and `parse_webhook`
# are real and pure so the contract test can exercise them.

from __future__ import annotations

import hashlib
import hmac
from collections.abc import Mapping
from datetime import date, datetime

from whatsapp_next.providers import exceptions as pex
from whatsapp_next.providers.base import DEFAULT_MAX_SKEW, BaseProvider
from whatsapp_next.providers.schemas import (
	AccountInfo,
	BatchResult,
	DeviceState,
	HealthStatus,
	InboundPayload,
	MessageStatus,
	NormalizedMessage,
	PairingPayload,
	ProviderContact,
	ProviderGroup,
	QueueStatus,
	SendResult,
	SignatureCheck,
	SignupState,
	UsageReport,
	WebhookEndpointState,
	WebhookEvent,
)

_STATUS_EVENTS = {
	"sent": "message.sent",
	"delivered": "message.delivered",
	"read": "message.read",
	"failed": "message.failed",
}


def _not_implemented(what: str):
	raise NotImplementedError(f"MetaCloudProvider.{what} is a skeleton — not implemented yet")


class MetaCloudProvider(BaseProvider):
	"""Meta WhatsApp Cloud API skeleton."""

	key = "meta_cloud"
	display_name = "Meta Cloud API"
	capabilities = frozenset({"template", "interactive", "webhooks"})

	# --- account ---
	def health_check(self) -> HealthStatus:
		return HealthStatus(ok=False, error="not implemented", checked_at=datetime.now())

	def get_account(self) -> AccountInfo:
		_not_implemented("get_account")

	def get_usage(self, from_: date, to: date, group_by: str = "day") -> UsageReport:
		raise pex.NotSupportedError("Usage report is not available for the Meta Cloud API")

	def get_signup_bootstrap(self) -> dict:
		raise pex.NotSupportedError("Sign-up is handled in Meta Business Manager")

	def start_signup(
		self,
		plan_code: str,
		mobile_e164: str,
		full_name: str,
		email: str,
		channel: str,
		coupon_code: str | None = None,
	) -> SignupState:
		raise pex.NotSupportedError("Sign-up is handled in Meta Business Manager")

	def get_signup_status(self, request_key: str) -> SignupState:
		raise pex.NotSupportedError("Sign-up is handled in Meta Business Manager")

	def verify_signup_code(self, request_key: str, code: str, purpose: str | None = None) -> SignupState:
		raise pex.NotSupportedError("Sign-up is handled in Meta Business Manager")

	def complete_signup(self, request_key: str, code: str, password: str | None = None) -> SignupState:
		raise pex.NotSupportedError("Sign-up is handled in Meta Business Manager")

	def start_password_reset(self, identifier: str) -> SignupState:
		raise pex.NotSupportedError("Password reset is handled in Meta Business Manager")

	def get_password_reset_status(self, request_key: str) -> SignupState:
		raise pex.NotSupportedError("Password reset is handled in Meta Business Manager")

	def complete_password_reset(self, request_key: str, password: str) -> SignupState:
		raise pex.NotSupportedError("Password reset is handled in Meta Business Manager")

	def login(self, email: str, password: str) -> dict:
		raise pex.NotSupportedError("Sign-in is handled in Meta Business Manager")

	def validate_coupon(self, code: str, email: str | None = None, mobile_e164: str | None = None) -> dict:
		raise pex.NotSupportedError("Meta Cloud has no coupons")

	def get_referral_coupon(self) -> dict:
		raise pex.NotSupportedError("Meta Cloud has no coupons")

	# --- devices (phone numbers) ---
	def create_device(self, device_name: str, phone_e164: str | None, pairing_mode: str) -> DeviceState:
		_not_implemented("create_device")

	def list_devices(self) -> list[DeviceState]:
		_not_implemented("list_devices")

	def get_device(self, platform_device: str) -> DeviceState:
		_not_implemented("get_device")

	def update_device(
		self, platform_device: str, device_name: str | None, phone_e164: str | None
	) -> DeviceState:
		_not_implemented("update_device")

	def get_qr(self, platform_device: str) -> PairingPayload:
		raise pex.NotSupportedError("The Cloud API has no QR pairing")

	def get_pair_code(self, platform_device: str) -> PairingPayload:
		raise pex.NotSupportedError("The Cloud API has no pair-code pairing")

	def verify_device(self, platform_device: str) -> DeviceState:
		_not_implemented("verify_device")

	def reconnect_device(self, platform_device: str) -> DeviceState:
		raise pex.NotSupportedError("The Cloud API has no session to reconnect")

	def disconnect_device(self, platform_device: str) -> DeviceState:
		raise pex.NotSupportedError("The Cloud API has no session to disconnect")

	def delete_device(self, platform_device: str, delete_remote: bool) -> None:
		_not_implemented("delete_device")

	# --- sending ---
	def send_message(self, message: NormalizedMessage) -> SendResult:
		_not_implemented("send_message")

	def send_batch(self, messages: list[NormalizedMessage], batch_id: str) -> BatchResult:
		raise pex.NotSupportedError("The Cloud API has no batch enqueue; send one by one")

	def get_message_status(self, client_refs: list[str]) -> tuple[list[MessageStatus], list[str]]:
		raise pex.NotSupportedError("The Cloud API reports status through webhooks only")

	def get_queue_status(self) -> QueueStatus:
		raise pex.NotSupportedError("The Cloud API has no server-side queue")

	def cancel_queued(self, client_refs: list[str] | None, batch_id: str | None) -> int:
		raise pex.NotSupportedError("The Cloud API has no server-side queue")

	def get_poll_results(self, platform_device: str, poll_ids: list[str]) -> dict[str, dict]:
		raise pex.NotSupportedError("Polls are not available on the Cloud API")

	# --- contacts / groups ---
	def list_device_contacts(self, platform_device: str) -> list[ProviderContact]:
		raise pex.NotSupportedError("The Cloud API exposes no contact list")

	def list_device_groups(self, platform_device: str) -> list[ProviderGroup]:
		raise pex.NotSupportedError("The Cloud API exposes no groups")

	# --- webhooks (real, pure) ---
	def verify_webhook(
		self, headers: Mapping[str, str], raw_body: bytes, secret: str, max_skew: int = DEFAULT_MAX_SKEW
	) -> SignatureCheck:
		"""`X-Hub-Signature-256: sha256=<hex HMAC(app_secret, raw_body)>`; no timestamp header → fresh."""
		h = {str(k).lower(): str(v) for k, v in (headers or {}).items()}
		header = h.get("x-hub-signature-256", "")
		if not header.startswith("sha256=") or not secret:
			return SignatureCheck(valid=False, fresh=True, reason="missing signature")
		expected = hmac.new(secret.encode("utf-8"), raw_body, hashlib.sha256).hexdigest()
		valid = hmac.compare_digest(expected, header[7:].strip().lower())
		return SignatureCheck(valid=valid, fresh=True, reason=None if valid else "signature")

	def parse_webhook(self, headers: Mapping[str, str], body: dict) -> WebhookEvent:
		"""Graph webhook envelope (`entry[].changes[].value`) → the first message or status."""
		value: dict = {}
		for entry in body.get("entry") or []:
			for change in entry.get("changes") or []:
				value = change.get("value") or {}
				break
			if value:
				break
		metadata = value.get("metadata") or {}
		platform_device = metadata.get("phone_number_id")
		messages = value.get("messages") or []
		statuses = value.get("statuses") or []
		if messages:
			m = messages[0]
			contact = (value.get("contacts") or [{}])[0]
			mtype = str(m.get("type") or "text")
			text = (
				(m.get("text") or {}).get("body") if mtype == "text" else (m.get(mtype) or {}).get("caption")
			)
			inbound = InboundPayload(
				provider_message_id=m.get("id"),
				sender_phone=("+" + m["from"]) if m.get("from") else None,
				sender_jid=(m.get("from") + "@s.whatsapp.net") if m.get("from") else None,
				chat_jid=(m.get("from") + "@s.whatsapp.net") if m.get("from") else None,
				from_jid=(m.get("from") + "@s.whatsapp.net") if m.get("from") else None,
				push_name=(contact.get("profile") or {}).get("name"),
				message_type=mtype.capitalize()
				if mtype in ("text", "image", "video", "audio", "document", "sticker", "location", "reaction")
				else "Other",
				body=text,
				reaction=(m.get("reaction") or {}).get("emoji"),
				reaction_to=(m.get("reaction") or {}).get("message_id"),
				received_at=datetime.fromtimestamp(int(m["timestamp"]))
				if str(m.get("timestamp") or "").isdigit()
				else None,
			)
			return WebhookEvent(
				event_id=str(m.get("id") or ""),
				event_name="message.reaction" if mtype == "reaction" else "message.received",
				timestamp=inbound.received_at,
				platform_device=platform_device,
				provider_message_id=m.get("id"),
				inbound=inbound,
				raw=body,
			)
		if statuses:
			s = statuses[0]
			name = _STATUS_EVENTS.get(str(s.get("status") or "").lower(), "message.status")
			errors = s.get("errors") or []
			return WebhookEvent(
				event_id=f"{s.get('id')}:{s.get('status')}",
				event_name=name,
				timestamp=datetime.fromtimestamp(int(s["timestamp"]))
				if str(s.get("timestamp") or "").isdigit()
				else None,
				platform_device=platform_device,
				client_ref=s.get("biz_opaque_callback_data"),
				provider_message_id=s.get("id"),
				status=str(s.get("status") or "").capitalize(),
				reason=(errors[0].get("title") if errors else None),
				raw=body,
			)
		return WebhookEvent(
			event_id=str(body.get("id") or ""),
			event_name=str(value.get("messaging_product") or "unknown"),
			raw=body,
		)

	def get_webhook_secret(self) -> str:
		raise pex.NotSupportedError("The app secret is configured in the Meta app dashboard")

	def configure_webhook(
		self, endpoint_url: str, events: list[str], max_retries: int
	) -> WebhookEndpointState:
		raise pex.NotSupportedError("Webhooks are configured in the Meta app dashboard")

	def list_webhook_endpoints(self) -> list[WebhookEndpointState]:
		raise pex.NotSupportedError("Webhooks are configured in the Meta app dashboard")

	def update_webhook_endpoint(
		self, endpoint_id: str, status: str | None, events: list[str] | None, url: str | None
	) -> WebhookEndpointState:
		raise pex.NotSupportedError("Webhooks are configured in the Meta app dashboard")

	def test_webhook_endpoint(self, endpoint_id: str) -> dict:
		raise pex.NotSupportedError("Webhooks are configured in the Meta app dashboard")

	def delete_webhook_endpoint(self, endpoint_id: str) -> None:
		raise pex.NotSupportedError("Webhooks are configured in the Meta app dashboard")

	def list_available_webhook_events(self) -> list[dict]:
		return [
			{"event_name": e, "enabled": True, "disabled_reason": None}
			for e in (
				"message.received",
				"message.sent",
				"message.delivered",
				"message.read",
				"message.failed",
			)
		]

# Module role: a scripted in-memory provider for tests (backend-plan RC-2). No network. Every
# call is recorded in `calls`; responses come from simple attributes so a test can script
# accepted / held / error / transient outcomes.

from __future__ import annotations

import hashlib
import hmac
import time
from collections.abc import Mapping
from datetime import date, datetime, timedelta

from whatsapp_next.providers import exceptions as pex
from whatsapp_next.providers.base import DEFAULT_MAX_SKEW, MAX_BATCH, BaseProvider
from whatsapp_next.providers.schemas import (
	AccountInfo,
	BatchAccepted,
	BatchError,
	BatchResult,
	DeviceState,
	HealthStatus,
	MessageStatus,
	NormalizedMessage,
	PairingPayload,
	ProviderContact,
	ProviderGroup,
	ProviderSettings,
	QueueStatus,
	SendResult,
	SignatureCheck,
	SignupState,
	UsageReport,
	WebhookEndpointState,
	WebhookEvent,
)
from whatsapp_next.providers.snd_platform import SndPlatformProvider


class FakeProvider(BaseProvider):
	"""Scripted provider. Set `batch_mode` to `accepted|held|error|transient|auth` before `send_batch`."""

	key = "fake"
	display_name = "Fake Provider"
	capabilities = frozenset(
		{"batch_send", "pair_code", "qr", "signup", "usage", "queue_cancel", "polls", "webhooks"}
	)

	def __init__(self, settings: ProviderSettings | None = None) -> None:
		super().__init__(
			settings
			or ProviderSettings(
				provider_key="fake",
				base_url="https://fake.invalid",
				credentials={"webhook_secret": "fake-secret"},
			)
		)
		self.calls: list[tuple[str, dict]] = []
		self.batch_mode = "accepted"
		self.send_mode = "ok"
		self.devices: dict[str, DeviceState] = {}
		self.statuses: dict[str, MessageStatus] = {}
		self.endpoints: dict[str, WebhookEndpointState] = {}
		self.secret = "fake-secret"
		self._counter = 0
		# Reuse the platform's pure helpers for signature / parsing so fixtures stay identical.
		self._snd = SndPlatformProvider(self.settings)

	def _record(self, name: str, **kwargs) -> None:
		self.calls.append((name, kwargs))

	def _next(self, prefix: str) -> str:
		self._counter += 1
		return f"{prefix}-{self._counter:04d}"

	# --- account ---
	def health_check(self) -> HealthStatus:
		self._record("health_check")
		return HealthStatus(ok=True, latency_ms=1, checked_at=datetime.now(), plan_code="fake")

	def get_account(self) -> AccountInfo:
		self._record("get_account")
		return AccountInfo(
			plan_code="fake",
			plan_name="Fake",
			status="Active",
			message_limit=1000,
			messages_used=10,
			messages_remaining=990,
			messages_per_minute=60,
			device_limit=3,
			devices_used=len(self.devices),
			features={"allow_webhooks": True},
		)

	def get_usage(self, from_: date, to: date, group_by: str = "day") -> UsageReport:
		self._record("get_usage", from_=from_, to=to, group_by=group_by)
		return UsageReport(from_=from_, to=to, group_by=group_by, rows=())

	def get_signup_bootstrap(self) -> dict:
		self._record("get_signup_bootstrap")
		return {
			"ok": True,
			"plans": [{"plan_code": "trial", "plan_name": "Fake Trial", "monthly_price": 0}],
			"code_ttl_minutes": 10,
		}

	def start_signup(self, plan_code, mobile_e164, full_name, email, channel, coupon_code=None) -> SignupState:
		self._record("start_signup", plan_code=plan_code, coupon_code=coupon_code)
		return SignupState(request_key="req-1", status="Pending")

	def get_signup_status(self, request_key) -> SignupState:
		return SignupState(request_key=request_key, status="Pending")

	def verify_signup_code(self, request_key, code, purpose=None) -> SignupState:
		self._record("verify_signup_code", request_key=request_key)
		if code != "123456":
			raise pex.ValidationError("Invalid verification code.", code="VALIDATION_ERROR")
		return SignupState(request_key=request_key, status="Verified")

	def complete_signup(self, request_key, code, password=None) -> SignupState:
		self._record("complete_signup", request_key=request_key, with_password=bool(password))
		return SignupState(
			request_key=request_key,
			status="Completed",
			credentials={"customer_api_key": "ck", "api_key": "k", "api_secret": "s"},
		)

	def start_password_reset(self, identifier) -> SignupState:
		return SignupState(request_key="reset-1", status="Pending")

	def get_password_reset_status(self, request_key) -> SignupState:
		return SignupState(request_key=request_key, status="Pending")

	def complete_password_reset(self, request_key, password) -> SignupState:
		self._record("complete_password_reset", request_key=request_key)
		return SignupState(request_key=request_key, status="Completed")

	def login(self, email, password) -> dict:
		self._record("login", email=email)
		if password != "right-password":
			raise pex.AuthError("Incorrect email or password", code="LOGIN_FAILED", http_status=401)
		return {
			"ok": True,
			"customer": "WAC-FAKE-1",
			"customer_name": "Fake Tenant",
			"integration_link": "WAIL-FAKE-1",
			"api_base_url": "https://fake.invalid/api/method/x",
			"credentials": {"customer_api_key": "ck", "api_key": "k", "api_secret": "s"},
		}

	def validate_coupon(self, code, email=None, mobile_e164=None) -> dict:
		self._record("validate_coupon", code=code)
		if code == "BSHQ-FREE2":
			return {
				"ok": True,
				"valid": True,
				"code": code,
				"kind": "Referral",
				"reward_kind": "Extra Free Months",
				"reward_value": 1,
				"message": "1 extra free month(s) on your subscription.",
			}
		return {
			"ok": True,
			"valid": False,
			"code": code,
			"reason": "COUPON_NOT_FOUND",
			"message": "This coupon code is not valid",
		}

	def get_referral_coupon(self) -> dict:
		self._record("get_referral_coupon")
		return {
			"ok": True,
			"customer": "WAC-FAKE-1",
			"redemption_count": 2,
			"coupon": {"code": "BSHQ-7K42P", "kind": "Referral", "reward_value": 1, "enabled": True},
		}

	# --- devices ---
	def create_device(self, device_name, phone_e164, pairing_mode) -> DeviceState:
		self._record("create_device", device_name=device_name, pairing_mode=pairing_mode)
		if pairing_mode == "Code" and not phone_e164:
			raise pex.ValidationError("phone required", code="PHONE_REQUIRED_FOR_PAIR_CODE")
		state = DeviceState(
			platform_device=self._next("WAD"),
			device_name=device_name,
			phone_e164=phone_e164,
			status="Pending QR",
			wa_device_id=self._next("wa"),
			pairing_mode=pairing_mode,
		)
		self.devices[state.platform_device] = state
		return state

	def list_devices(self) -> list[DeviceState]:
		self._record("list_devices")
		return list(self.devices.values())

	def get_device(self, platform_device) -> DeviceState:
		if platform_device not in self.devices:
			raise pex.NotFoundError("no such device", code="DEVICE_NOT_FOUND")
		return self.devices[platform_device]

	def update_device(self, platform_device, device_name, phone_e164) -> DeviceState:
		state = self.get_device(platform_device)
		state = DeviceState(
			**{
				**state.__dict__,
				"device_name": device_name or state.device_name,
				"phone_e164": phone_e164 or state.phone_e164,
			}
		)
		self.devices[platform_device] = state
		return state

	def get_qr(self, platform_device) -> PairingPayload:
		self._record("get_qr", device=platform_device)
		self.get_device(platform_device)
		now = datetime.now()
		return PairingPayload(
			mode="QR",
			qr_code="data:image/png;base64,QUJD",
			generated_at=now,
			expires_at=now + timedelta(seconds=60),
		)

	def get_pair_code(self, platform_device) -> PairingPayload:
		self._record("get_pair_code", device=platform_device)
		state = self.get_device(platform_device)
		if not state.phone_e164:
			raise pex.ValidationError("phone required", code="PHONE_REQUIRED_FOR_PAIR_CODE")
		now = datetime.now()
		return PairingPayload(
			mode="Code",
			pair_code="ABCD-1234",
			generated_at=now,
			expires_at=now + timedelta(seconds=60),
			phone_e164=state.phone_e164,
		)

	def verify_device(self, platform_device) -> DeviceState:
		self._record("verify_device", device=platform_device)
		return self.get_device(platform_device)

	def set_device_status(self, platform_device: str, status: str) -> DeviceState:
		"""Test helper: flip a scripted device's status."""
		state = self.get_device(platform_device)
		state = DeviceState(**{**state.__dict__, "status": status})
		self.devices[platform_device] = state
		return state

	def reconnect_device(self, platform_device) -> DeviceState:
		return self.set_device_status(platform_device, "Connected")

	def disconnect_device(self, platform_device) -> DeviceState:
		self._record("disconnect_device", device=platform_device)
		return self.set_device_status(platform_device, "Logged Out")

	def delete_device(self, platform_device, delete_remote) -> None:
		self._record("delete_device", device=platform_device, delete_remote=delete_remote)
		self.devices.pop(platform_device, None)

	# --- sending ---
	def send_message(self, message: NormalizedMessage) -> SendResult:
		self._record("send_message", client_ref=message.client_ref)
		if self.send_mode == "offline":
			raise pex.DeviceOfflineError(
				"device offline", device_status="Disconnected", code="DEVICE_NOT_CONNECTED"
			)
		if self.send_mode == "rejected":
			return SendResult(
				ok=False,
				rejected=True,
				reason="quota",
				code="QUOTA_EXCEEDED",
				platform_message_log=self._next("ML"),
			)
		return SendResult(
			ok=True,
			provider_message_id=self._next("pm"),
			platform_message_log=self._next("ML"),
			device=message.platform_device,
		)

	def send_batch(self, messages: list[NormalizedMessage], batch_id: str) -> BatchResult:
		self._record("send_batch", batch_id=batch_id, count=len(messages))
		if len(messages) > MAX_BATCH:
			raise pex.ValidationError("batch too large", code="BATCH_TOO_LARGE")
		if self.batch_mode == "transient":
			raise pex.TransientError("gateway timeout", code="TIMEOUT")
		if self.batch_mode == "auth":
			raise pex.AuthError("invalid key", code="AUTH_INVALID_KEY")
		if self.batch_mode == "error":
			return BatchResult(
				batch_id=batch_id,
				errors=tuple(
					BatchError(
						client_ref=m.client_ref, error="recipient not registered", code="RECIPIENT_REQUIRED"
					)
					for m in messages
				),
			)
		status = "Held" if self.batch_mode == "held" else "Queued"
		accepted = []
		for m in messages:
			qid = self._next("MQ")
			accepted.append(BatchAccepted(client_ref=m.client_ref, queue_id=qid, status=status))
			self.statuses[m.client_ref] = MessageStatus(client_ref=m.client_ref, queue_id=qid, status=status)
		return BatchResult(batch_id=batch_id, accepted=tuple(accepted))

	def get_message_status(self, client_refs: list[str]) -> tuple[list[MessageStatus], list[str]]:
		self._record("get_message_status", refs=list(client_refs))
		found = [self.statuses[r] for r in client_refs if r in self.statuses]
		return found, [r for r in client_refs if r not in self.statuses]

	def get_queue_status(self) -> QueueStatus:
		counts: dict[str, int] = {}
		for s in self.statuses.values():
			counts[s.status] = counts.get(s.status, 0) + 1
		return QueueStatus(counts=counts, messages_per_minute=60, messages_remaining=990)

	def cancel_queued(self, client_refs, batch_id) -> int:
		n = 0
		for ref in list(client_refs or []):
			if ref in self.statuses and self.statuses[ref].status in ("Queued", "Held"):
				self.statuses[ref] = MessageStatus(
					client_ref=ref, queue_id=self.statuses[ref].queue_id, status="Cancelled"
				)
				n += 1
		return n

	def get_poll_results(self, platform_device, poll_ids) -> dict[str, dict]:
		return {p: {"votes": []} for p in poll_ids}

	# --- contacts / groups ---
	def list_device_contacts(self, platform_device) -> list[ProviderContact]:
		return [
			ProviderContact(
				jid="966500000009@s.whatsapp.net", phone_e164="+966500000009", name="Fake Contact"
			)
		]

	def list_device_groups(self, platform_device) -> list[ProviderGroup]:
		return [ProviderGroup(jid="120363000000000000@g.us", name="Fake Group", participants_count=3)]

	# --- webhooks ---
	def sign(self, timestamp: str, raw_body: bytes | str) -> str:
		"""Sign like the platform (helper for receiver tests)."""
		body = raw_body.decode() if isinstance(raw_body, bytes) else raw_body
		return hmac.new(self.secret.encode(), f"{timestamp}.{body}".encode(), hashlib.sha256).hexdigest()

	def verify_webhook(
		self, headers: Mapping[str, str], raw_body: bytes, secret: str, max_skew: int = DEFAULT_MAX_SKEW
	) -> SignatureCheck:
		return self._snd.verify_webhook(headers, raw_body, secret, max_skew)

	def parse_webhook(self, headers: Mapping[str, str], body: dict) -> WebhookEvent:
		return self._snd.parse_webhook(headers, body)

	def webhook_envelope(self, headers: Mapping[str, str]):
		return self._snd.webhook_envelope(headers)

	def replay_headers(self, event_name: str, event_id: str | None) -> dict[str, str]:
		return self._snd.replay_headers(event_name, event_id)

	def get_webhook_secret(self) -> str:
		self._record("get_webhook_secret")
		return self.secret

	def configure_webhook(self, endpoint_url, events, max_retries) -> WebhookEndpointState:
		self._record("configure_webhook", url=endpoint_url, events=list(events))
		state = WebhookEndpointState(
			endpoint_id=self._next("WAWE"),
			url=endpoint_url,
			status="Active",
			events=tuple(events),
			max_retries=max_retries,
		)
		self.endpoints[state.endpoint_id] = state
		return state

	def list_webhook_endpoints(self) -> list[WebhookEndpointState]:
		return list(self.endpoints.values())

	def update_webhook_endpoint(self, endpoint_id, status, events, url) -> WebhookEndpointState:
		state = self.endpoints[endpoint_id]
		state = WebhookEndpointState(
			**{
				**state.__dict__,
				"status": status or state.status,
				"events": tuple(events) if events is not None else state.events,
				"url": url or state.url,
			}
		)
		self.endpoints[endpoint_id] = state
		return state

	def test_webhook_endpoint(self, endpoint_id) -> dict:
		return {"ok": True, "http_status_code": 200}

	def delete_webhook_endpoint(self, endpoint_id) -> None:
		self.endpoints.pop(endpoint_id, None)

	def list_available_webhook_events(self) -> list[dict]:
		from whatsapp_next.providers.schemas import CANONICAL_EVENTS

		return [
			{"event_name": e, "enabled": True, "disabled_reason": None}
			for e in CANONICAL_EVENTS
			if e != "test.webhook"
		]


def signed_headers(
	secret: str, event: str, event_id: str, raw_body: bytes | str, timestamp: int | None = None
) -> dict[str, str]:
	"""Build platform-style webhook headers for a body (tests of the receiver and the verifier)."""
	ts = str(timestamp or int(time.time()))
	body = raw_body.decode() if isinstance(raw_body, bytes) else raw_body
	sig = hmac.new(secret.encode(), f"{ts}.{body}".encode(), hashlib.sha256).hexdigest()
	return {
		"X-SND-Event": event,
		"X-SND-Event-ID": event_id,
		"X-SND-Timestamp": ts,
		"X-SND-Signature": sig,
		"Content-Type": "application/json",
	}

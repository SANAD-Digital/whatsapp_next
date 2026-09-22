# Module role: the provider contract (architecture.md, backend-plan §2.3). Every concrete provider
# subclasses `BaseProvider`; the contract test asserts each abstract method is implemented.
# Providers do outbound I/O only — no DocType writes, no `frappe.db` access beyond `frappe.cache`.

from __future__ import annotations

from abc import ABC, abstractmethod
from collections.abc import Mapping
from datetime import date

from whatsapp_next.providers.schemas import (
	AccountInfo,
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

MAX_BATCH = 200
MAX_STATUS_REFS = 200
MAX_POLL_IDS = 100
DEFAULT_MAX_SKEW = 300


class BaseProvider(ABC):
	"""Abstract WhatsApp provider. Attributes `key`, `display_name`, `capabilities` are class-level."""

	key: str = ""
	display_name: str = ""
	capabilities: frozenset[str] = frozenset()

	def __init__(self, settings: ProviderSettings) -> None:
		self.settings = settings

	def supports(self, capability: str) -> bool:
		"""True when the provider declares `capability` (e.g. `batch_send`, `pair_code`)."""
		return capability in self.capabilities

	# --- account / tenant linkage ---
	@abstractmethod
	def health_check(self) -> HealthStatus:
		"""Never raises; errors are reported in the result."""

	@abstractmethod
	def get_account(self) -> AccountInfo:
		"""Plan, usage, limits, features, wallet."""

	@abstractmethod
	def get_usage(self, from_: date, to: date, group_by: str = "day") -> UsageReport:
		"""Usage rows for the period (NotSupportedError until the provider exposes it)."""

	@abstractmethod
	def start_signup(
		self, plan_code: str, mobile_e164: str, full_name: str, email: str, channel: str
	) -> SignupState:
		"""Begin a tenant sign-up; returns a request key."""

	@abstractmethod
	def get_signup_status(self, request_key: str) -> SignupState:
		"""Poll a sign-up request."""

	@abstractmethod
	def complete_signup(self, request_key: str, code: str, password: str | None = None) -> SignupState:
		"""Finish a sign-up; credentials (if returned) come back exactly once and are never logged."""

	@abstractmethod
	def start_password_reset(self, identifier: str) -> SignupState:
		"""Begin a password reset for a tenant user."""

	# --- device lifecycle ---
	@abstractmethod
	def create_device(self, device_name: str, phone_e164: str | None, pairing_mode: str) -> DeviceState:
		"""Create a device on the provider; `phone_e164` is required for `Code` pairing."""

	@abstractmethod
	def list_devices(self) -> list[DeviceState]:
		"""All devices of this tenant."""

	@abstractmethod
	def get_device(self, platform_device: str) -> DeviceState:
		"""One device (NotFoundError when unknown)."""

	@abstractmethod
	def update_device(
		self, platform_device: str, device_name: str | None, phone_e164: str | None
	) -> DeviceState:
		"""Rename / re-number a device (NotSupportedError until A-05)."""

	@abstractmethod
	def get_qr(self, platform_device: str) -> PairingPayload:
		"""QR payload for pairing (DeviceOfflineError when the device has no token)."""

	@abstractmethod
	def get_pair_code(self, platform_device: str) -> PairingPayload:
		"""8-digit pairing code (ValidationError when the device has no phone)."""

	@abstractmethod
	def verify_device(self, platform_device: str) -> DeviceState:
		"""Ask the provider for the live connection state."""

	@abstractmethod
	def reconnect_device(self, platform_device: str) -> DeviceState:
		"""Reconnect an existing session (NotSupportedError until A-05)."""

	@abstractmethod
	def disconnect_device(self, platform_device: str) -> DeviceState:
		"""Log the device out."""

	@abstractmethod
	def delete_device(self, platform_device: str, delete_remote: bool) -> None:
		"""Delete the device on the provider (and locally there when `delete_remote`)."""

	# --- sending ---
	@abstractmethod
	def send_message(self, message: NormalizedMessage) -> SendResult:
		"""Single synchronous send — test send only (D-024)."""

	@abstractmethod
	def send_batch(self, messages: list[NormalizedMessage], batch_id: str) -> BatchResult:
		"""Batch enqueue (≤ MAX_BATCH; ValidationError above, before any I/O)."""

	@abstractmethod
	def get_message_status(self, client_refs: list[str]) -> tuple[list[MessageStatus], list[str]]:
		"""Return `(statuses, unknown_refs)` for ≤ MAX_STATUS_REFS refs."""

	@abstractmethod
	def get_queue_status(self) -> QueueStatus:
		"""Counts per status on the provider queue."""

	@abstractmethod
	def cancel_queued(self, client_refs: list[str] | None, batch_id: str | None) -> int:
		"""Cancel queued messages; returns the count (NotSupportedError until A-11)."""

	@abstractmethod
	def get_poll_results(self, platform_device: str, poll_ids: list[str]) -> dict[str, dict]:
		"""Poll results keyed by poll id (≤ MAX_POLL_IDS)."""

	# --- contacts / groups ---
	@abstractmethod
	def list_device_contacts(self, platform_device: str) -> list[ProviderContact]:
		"""Contacts known to the device."""

	@abstractmethod
	def list_device_groups(self, platform_device: str) -> list[ProviderGroup]:
		"""Groups the device is a member of."""

	# --- webhooks ---
	@abstractmethod
	def verify_webhook(
		self, headers: Mapping[str, str], raw_body: bytes, secret: str, max_skew: int = DEFAULT_MAX_SKEW
	) -> SignatureCheck:
		"""Constant-time signature check plus timestamp freshness; pure (no DB)."""

	@abstractmethod
	def parse_webhook(self, headers: Mapping[str, str], body: dict) -> WebhookEvent:
		"""Wire payload → `WebhookEvent`; pure; unknown events keep their name and `is_known` False."""

	@abstractmethod
	def get_webhook_secret(self) -> str:
		"""Fetch the signing secret (caller stores it with `set_password`; never logged)."""

	@abstractmethod
	def configure_webhook(
		self, endpoint_url: str, events: list[str], max_retries: int
	) -> WebhookEndpointState:
		"""Register the client receiver URL and event subscriptions."""

	@abstractmethod
	def list_webhook_endpoints(self) -> list[WebhookEndpointState]:
		"""Endpoints registered for this tenant."""

	@abstractmethod
	def update_webhook_endpoint(
		self, endpoint_id: str, status: str | None, events: list[str] | None, url: str | None
	) -> WebhookEndpointState:
		"""Change status (Active/Disabled = unlock), events or URL (A-06)."""

	@abstractmethod
	def test_webhook_endpoint(self, endpoint_id: str) -> dict:
		"""Ask the provider to POST a `test.webhook` event."""

	@abstractmethod
	def delete_webhook_endpoint(self, endpoint_id: str) -> None:
		"""Delete an endpoint."""

	@abstractmethod
	def list_available_webhook_events(self) -> list[dict]:
		"""`[{event_name, enabled, disabled_reason}]` per the tenant's plan."""

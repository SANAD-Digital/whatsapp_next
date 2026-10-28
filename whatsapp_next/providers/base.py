# Module role: the provider contract (architecture.md, backend-plan §2.3). Every concrete provider
# subclasses `BaseProvider`; the contract test asserts each abstract method is implemented.
# Providers do outbound I/O only — no DocType writes, no `frappe.db` access beyond `frappe.cache`.

from __future__ import annotations

from abc import ABC, abstractmethod
from collections.abc import Mapping
from datetime import date

from whatsapp_next.providers import exceptions as pex
from whatsapp_next.providers.schemas import (
	AccountInfo,
	BatchResult,
	ContactProfile,
	DeviceState,
	GroupCreated,
	HealthStatus,
	HistoryPage,
	MessageStatus,
	NormalizedMessage,
	NumberCheck,
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
	WebhookEnvelope,
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
	#: the header that carries a webhook's signature (read by the replay check, `webhooks/verify.py`)
	webhook_signature_header: str = ""

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
	def get_signup_bootstrap(self) -> dict:
		"""What the sign-up form needs before anything is typed (plans, code TTL)."""

	@abstractmethod
	def start_signup(
		self,
		plan_code: str,
		mobile_e164: str,
		full_name: str,
		email: str,
		channel: str,
		coupon_code: str | None = None,
		callback: dict | None = None,
		company: dict | None = None,
	) -> SignupState:
		"""Begin a tenant sign-up; returns a request key. A coupon is validated here. `callback`
		(`{url, token}`) is where the provider tells this site the moment the number is confirmed."""

	@abstractmethod
	def get_signup_status(self, request_key: str) -> SignupState:
		"""Poll a sign-up request."""

	@abstractmethod
	def verify_signup_code(self, request_key: str, code: str, purpose: str | None = None) -> SignupState:
		"""Check the verification code of a sign-up or password-reset request."""

	@abstractmethod
	def complete_signup(self, request_key: str, code: str, password: str | None = None) -> SignupState:
		"""Finish a sign-up; credentials (if returned) come back exactly once and are never logged."""

	@abstractmethod
	def start_password_reset(self, identifier: str, callback: dict | None = None) -> SignupState:
		"""Begin a password reset for a tenant user. `callback` (`{url, token}`) is called by the
		provider the moment the reset is confirmed, as for a sign-up."""

	@abstractmethod
	def get_password_reset_status(self, request_key: str) -> SignupState:
		"""Poll a password-reset request."""

	@abstractmethod
	def complete_password_reset(self, request_key: str, password: str) -> SignupState:
		"""Set the new password of a verified password-reset request."""

	@abstractmethod
	def login(self, email: str, password: str) -> dict:
		"""Authenticate a tenant user; returns their credentials once. Never logged."""

	@abstractmethod
	def validate_coupon(self, code: str, email: str | None = None, mobile_e164: str | None = None) -> dict:
		"""Is a coupon usable and what does it give? Never redeems."""

	@abstractmethod
	def get_referral_coupon(self) -> dict:
		"""This tenant's own referral coupon (NotSupportedError where there are none)."""

	# --- billing: plan, wallet and payments (capability `billing`) ---
	# Not abstract: a provider that bills elsewhere keeps these defaults, and the site says so.
	def get_wallet(self) -> dict:
		"""`{balance, currency, transactions[], billing_entries[], renewal{…}}`."""
		raise pex.NotSupportedError("This provider does not bill through this site", code="NOT_SUPPORTED")

	def list_plans(self) -> dict:
		"""`{plans[{plan_code, plan_name, monthly_price, currency, message_limit, device_limit,
		features, is_current, is_trial, …}], current_plan}`."""
		raise pex.NotSupportedError("This provider does not bill through this site", code="NOT_SUPPORTED")

	def get_payment_methods(self) -> dict:
		"""`{paypal: {enabled, currency}, methods[{name, title, method_type, …account details}]}`."""
		raise pex.NotSupportedError("This provider does not bill through this site", code="NOT_SUPPORTED")

	def renew_subscription(self) -> dict:
		"""Renew from the wallet now → `{done, subscription, payment_required?, amount?, …}`."""
		raise pex.NotSupportedError("This provider does not bill through this site", code="NOT_SUPPORTED")

	def change_plan(self, plan_code: str) -> dict:
		"""Move to `plan_code` now, paid from the wallet; the same answer as `renew_subscription`."""
		raise pex.NotSupportedError("This provider does not bill through this site", code="NOT_SUPPORTED")

	def request_topup(
		self,
		amount: float,
		payment_option: str | None = None,
		reference_no: str | None = None,
		remarks: str | None = None,
		receipt: tuple[str, str, str] | None = None,
		plan_code: str | None = None,
	) -> dict:
		"""A top-up paid by transfer, for the platform to approve. `receipt` is `(filename, mime,
		base64)`. → `{transaction, status, amount, currency}`."""
		raise pex.NotSupportedError("This provider does not bill through this site", code="NOT_SUPPORTED")

	def start_paypal_topup(self, amount: float, return_url: str, plan_code: str | None = None) -> dict:
		"""→ `{order_id, approve_url}`; the payer comes back to `return_url` with `token`."""
		raise pex.NotSupportedError("This provider does not bill through this site", code="NOT_SUPPORTED")

	def confirm_paypal_topup(self, order_id: str) -> dict:
		"""→ `{state: completed|pending|not_approved|failed, transaction}`; safe to repeat."""
		raise pex.NotSupportedError("This provider does not bill through this site", code="NOT_SUPPORTED")

	def get_account_statement(self, from_date: str | None = None, to_date: str | None = None) -> dict:
		"""→ `{currency, from_date, to_date, opening, total_in, total_out, closing, rows[]}`."""
		raise pex.NotSupportedError("This provider does not bill through this site", code="NOT_SUPPORTED")

	# --- the WhatsApp hub: ready-made functions, commands, alerts and notifications ---
	def list_hub(self, hub_type: str | None = None, txt: str | None = None) -> list[dict]:
		"""`[{name, hub_name, hub_type, description, checksum, modified}]`, published entries."""
		raise pex.NotSupportedError("This provider has no hub", code="NOT_SUPPORTED")

	def get_hub_entry(self, name: str) -> dict:
		"""One entry with its `payload`."""
		raise pex.NotSupportedError("This provider has no hub", code="NOT_SUPPORTED")

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

	def download_media(self, url: str, max_bytes: int | None = None) -> tuple[bytes, str]:
		"""The file behind a received message's `media_url`, as `(content, content_type)`.

		Not abstract: a provider whose webhooks carry no downloadable media keeps this default."""
		raise pex.NotSupportedError("This provider does not serve received media", code="NOT_SUPPORTED")

	def post_status(self, platform_device: str, payload: dict) -> str:
		"""Post a status (story) → its WhatsApp id. `payload`: `{kind: text, text, background_color,
		font}` or `{kind: image|video, media_base64, caption}`.

		Not abstract: a provider without status keeps this default."""
		raise pex.NotSupportedError("This provider cannot post status", code="NOT_SUPPORTED")

	def delete_status(self, platform_device: str, status_id: str) -> None:
		"""Take a posted status down."""
		raise pex.NotSupportedError("This provider cannot delete status", code="NOT_SUPPORTED")

	def get_status_views(self, platform_device: str, status_ids: list[str]) -> dict[str, dict]:
		"""`{status_id: {count, viewers[{jid, number, viewed_at}]}}` for the device's own posts."""
		raise pex.NotSupportedError("This provider cannot read status views", code="NOT_SUPPORTED")

	def mark_read(self, platform_device: str, chat_jid: str, message_ids: list[str], sender_jid: str | None = None) -> None:
		"""Read receipts for received messages of one chat (JIDs as they came in).

		Not abstract: a provider without read receipts keeps this default."""
		raise pex.NotSupportedError("This provider cannot send read receipts", code="NOT_SUPPORTED")

	def send_presence(self, platform_device: str, chat_jid: str, state: str = "composing") -> None:
		"""Show "typing…" (`composing`) or stop it (`paused`) in a chat.

		Not abstract: a provider without presence keeps this default."""
		raise pex.NotSupportedError("This provider cannot show typing", code="NOT_SUPPORTED")

	def check_numbers(self, platform_device: str, numbers: list[str]) -> list[NumberCheck]:
		"""Which of `numbers` (E.164, ≤ 1000) are on WhatsApp, asked through the device.

		Not abstract: a provider that cannot tell keeps this default."""
		raise pex.NotSupportedError("This provider cannot check numbers", code="NOT_SUPPORTED")

	def get_contact_profiles(
		self, platform_device: str, numbers: list[str], known_pictures: dict[str, str] | None = None
	) -> list[ContactProfile]:
		"""WhatsApp profiles of up to 50 numbers (E.164); `known_pictures` maps a number to the photo
		id already held, so an unchanged photo is not linked again.

		Not abstract: a provider that cannot read profiles keeps this default."""
		raise pex.NotSupportedError("This provider cannot read contact profiles", code="NOT_SUPPORTED")

	def create_group(
		self, platform_device: str, name: str, participants: list[str], description: str | None = None
	) -> GroupCreated:
		"""Create a group with the device as its admin and `participants` (numbers) as members.

		Not abstract: a provider that cannot create groups keeps this default."""
		raise pex.NotSupportedError("This provider cannot create groups", code="NOT_SUPPORTED")

	def list_history(
		self, platform_device: str, *, after: int = 0, limit: int = 200, since: int | None = None, total: bool = False
	) -> HistoryPage:
		"""A batch of the device's past messages, both directions, oldest stored first: those after
		cursor `after`, sent at or after unix time `since`. `total` asks for the count as well.

		Not abstract: a provider that keeps no history keeps this default."""
		raise pex.NotSupportedError("This provider keeps no message history", code="NOT_SUPPORTED")

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

	def webhook_envelope(self, headers: Mapping[str, str]) -> WebhookEnvelope:
		"""Event id, event name and whether a signature is present, read from the delivery's
		headers (their names are the provider's, never the receiver's). Default: nothing, so a
		provider that does not deliver webhooks is refused at step 1."""
		return WebhookEnvelope(event_id=None, event_name=None, signed=False)

	def replay_headers(self, event_name: str, event_id: str | None) -> dict[str, str]:
		"""Headers that let `parse_webhook` re-read a stored event (the stored row keeps the body
		and the id / name, not the wire headers)."""
		return {}

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

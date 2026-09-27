# Module role: normalized dataclasses exchanged between services/ and providers/ (backend-plan
# §2.1). Providers translate their wire format into these; services never see raw payloads except
# through `WebhookEvent.raw` (stored on WhatsApp Webhook Event, never logged).

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, datetime
from typing import Any

RECIPIENT_TYPES = ("Individual", "Group")
MESSAGE_TYPES = (
	"Text",
	"Document",
	"Image",
	"Video",
	"Audio",
	"Sticker",
	"Location",
	"Poll",
	"Template",
	"Interactive",
)
DEVICE_STATUSES = ("Pending QR", "Connected", "Disconnected", "Logged Out")
WEBHOOK_ENDPOINT_STATUSES = ("Active", "Disabled", "Locked", "Revoked")

# Canonical webhook event names (platform SUPPORTED_WEBHOOK_EVENTS + test.webhook).
CANONICAL_EVENTS: tuple[str, ...] = (
	"message.received",
	"message.sent",
	"message.delivered",
	"message.read",
	"message.failed",
	"message.held",
	"message.reaction",
	"connection.connected",
	"connection.disconnected",
	"connection.logged_out",
	"group.updated",
	"group.participants.updated",
	"test.webhook",
)


@dataclass(frozen=True)
class ProviderSettings:
	"""What a provider needs to talk to its backend. `credentials` come from `get_password`."""

	provider_key: str
	base_url: str
	timeout: int = 30
	credentials: dict[str, str] = field(default_factory=dict, repr=False)

	def __repr__(self) -> str:  # never print secrets
		return f"ProviderSettings(provider_key={self.provider_key!r}, base_url={self.base_url!r}, timeout={self.timeout})"


@dataclass(frozen=True)
class AttachmentRef:
	"""A file to send: either inline bytes (base64) or a URL the provider can fetch."""

	file_name: str
	mime_type: str
	content_b64: str | None = None
	url: str | None = None


@dataclass(frozen=True)
class Location:
	latitude: float
	longitude: float
	name: str | None = None
	address: str | None = None


@dataclass(frozen=True)
class Poll:
	question: str
	options: tuple[str, ...]
	allow_multiple: bool = False


@dataclass(frozen=True)
class TemplateRef:
	"""Meta-style template reference (name, language, components)."""

	name: str
	language: str = "ar"
	components: tuple[dict, ...] = ()


@dataclass(frozen=True)
class Source:
	"""Who created the message (mirrors platform `source_*` keys)."""

	type: str = "External API"
	doctype: str | None = None
	docname: str | None = None
	site: str | None = None


@dataclass(frozen=True)
class NormalizedMessage:
	"""One outbound message ready for any provider (built by services/dispatch)."""

	client_ref: str
	platform_device: str
	recipient_type: str = "Individual"
	phone_e164: str | None = None
	jid: str | None = None
	message_type: str = "Text"
	body: str | None = None
	caption: str | None = None
	attachment: AttachmentRef | None = None
	view_once: bool = False
	location: Location | None = None
	poll: Poll | None = None
	template: TemplateRef | None = None
	interactive: dict | None = None
	source: Source = field(default_factory=Source)
	priority: int = 5


@dataclass(frozen=True)
class SendResult:
	ok: bool
	provider_message_id: str | None = None
	platform_message_log: str | None = None
	device_fallback: bool = False
	requested_device: str | None = None
	rejected: bool = False
	reason: str | None = None
	code: str | None = None
	device: str | None = None


@dataclass(frozen=True)
class BatchAccepted:
	client_ref: str
	queue_id: str
	status: str = "Queued"


@dataclass(frozen=True)
class BatchError:
	client_ref: str | None
	error: str
	code: str | None = None
	queue_id: str | None = None


@dataclass(frozen=True)
class BatchResult:
	batch_id: str
	accepted: tuple[BatchAccepted, ...] = ()
	errors: tuple[BatchError, ...] = ()


@dataclass(frozen=True)
class MessageStatus:
	client_ref: str
	queue_id: str | None
	status: str
	reason: str | None = None
	platform_message_log: str | None = None
	attempt_count: int = 0
	provider_message_id: str | None = None
	device: str | None = None
	sent_at: datetime | None = None
	delivered_at: datetime | None = None
	read_at: datetime | None = None
	message_status: str | None = None


@dataclass(frozen=True)
class DeviceState:
	platform_device: str
	device_name: str | None = None
	phone_e164: str | None = None
	status: str = "Pending QR"
	wa_device_id: str | None = None
	last_seen: datetime | None = None
	webhook_registered: bool = False
	webhook_url: str | None = None
	raw_status: str | None = None
	pairing_mode: str | None = None
	last_status_change_at: datetime | None = None
	last_status_reason: str | None = None


@dataclass(frozen=True)
class PairingPayload:
	"""Served to the pairing page from a 60 s cache; never persisted (D-014)."""

	mode: str  # QR | Code
	qr_code: str | None = None
	pair_code: str | None = None
	generated_at: datetime | None = None
	expires_at: datetime | None = None
	expires_in: int = 60
	phone_e164: str | None = None


@dataclass(frozen=True)
class InboundPayload:
	provider_message_id: str | None
	sender_phone: str | None = None
	sender_jid: str | None = None
	chat_jid: str | None = None
	from_jid: str | None = None
	is_group: bool = False
	push_name: str | None = None
	message_type: str = "Text"
	body: str | None = None
	caption: str | None = None
	media_url: str | None = None
	media_mime_type: str | None = None
	location: Location | None = None
	reaction: str | None = None
	reaction_to: str | None = None
	quoted_id: str | None = None
	received_at: datetime | None = None


@dataclass(frozen=True)
class WebhookEvent:
	"""A parsed provider webhook. `raw` is the full body (PII) — stored, never logged."""

	event_id: str
	event_name: str
	timestamp: datetime | None = None
	platform_device: str | None = None
	client_ref: str | None = None
	provider_message_id: str | None = None
	queue_id: str | None = None
	platform_message_log: str | None = None
	status: str | None = None
	reason: str | None = None
	device: DeviceState | None = None
	inbound: InboundPayload | None = None
	raw: dict = field(default_factory=dict, repr=False)

	@property
	def is_known(self) -> bool:
		return self.event_name in CANONICAL_EVENTS


@dataclass(frozen=True)
class AccountInfo:
	plan_code: str | None = None
	plan_name: str | None = None
	status: str | None = None
	message_limit: int = 0
	messages_used: int = 0
	messages_remaining: int = 0
	messages_per_minute: int = 0
	device_limit: int = 0
	devices_used: int = 0
	start_date: date | None = None
	end_date: date | None = None
	features: dict[str, bool] = field(default_factory=dict)
	wallet_balance: float | None = None
	wallet_currency: str | None = None
	webhook_events: dict[str, bool] = field(default_factory=dict)


@dataclass(frozen=True)
class UsageRow:
	key: str
	sent: int = 0
	failed: int = 0
	units: int = 0
	rejected: int = 0


@dataclass(frozen=True)
class UsageReport:
	from_: date
	to: date
	group_by: str
	rows: tuple[UsageRow, ...] = ()


@dataclass(frozen=True)
class QueueStatus:
	counts: dict[str, int] = field(default_factory=dict)
	messages_per_minute: int = 0
	messages_remaining: int = 0
	held_reason: str | None = None


@dataclass(frozen=True)
class ProviderContact:
	jid: str
	phone_e164: str | None = None
	name: str | None = None


@dataclass(frozen=True)
class ProviderGroup:
	jid: str
	name: str | None = None
	participants_count: int = 0


@dataclass(frozen=True)
class WebhookEndpointState:
	endpoint_id: str
	url: str
	status: str = "Active"
	events: tuple[str, ...] = ()
	max_retries: int = 3
	consecutive_failures: int = 0
	locked_at: datetime | None = None
	lock_reason: str | None = None
	last_http_status: int | None = None
	lock_after_failures: int | None = None
	unlocked_at: datetime | None = None


@dataclass(frozen=True)
class HealthStatus:
	ok: bool
	latency_ms: int | None = None
	error: str | None = None
	checked_at: datetime | None = None
	plan_code: str | None = None


@dataclass(frozen=True)
class SignatureCheck:
	valid: bool
	fresh: bool
	event_timestamp: datetime | None = None
	reason: str | None = None


@dataclass(frozen=True)
class WebhookEnvelope:
	"""What the receiver needs from a delivery's headers before it trusts the body (A-1)."""

	event_id: str | None
	event_name: str | None
	signed: bool


@dataclass(frozen=True)
class SignupState:
	request_key: str | None
	status: str
	credentials: dict[str, str] | None = field(default=None, repr=False)
	message: str | None = None
	extra: dict[str, Any] = field(default_factory=dict)

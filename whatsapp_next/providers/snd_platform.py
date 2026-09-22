# Module role: the SND WhatsApp Platform provider (backend-plan §2.5). One transport (`_request`)
# with the three credentials of D-020, typed exception mapping (200 `ok:false` → business
# rejection, 4xx/5xx → typed errors, A-09 `code` preferred over text), batch enqueue with
# `client_ref` (D-024), HMAC webhook verification and a single webhook parser (D-013).

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import time
from collections.abc import Mapping
from datetime import date, datetime, timedelta
from typing import Any

import requests

from whatsapp_next.providers import exceptions as pex
from whatsapp_next.providers.base import (
	DEFAULT_MAX_SKEW,
	MAX_BATCH,
	MAX_POLL_IDS,
	MAX_STATUS_REFS,
	BaseProvider,
)
from whatsapp_next.providers.schemas import (
	AccountInfo,
	BatchAccepted,
	BatchError,
	BatchResult,
	DeviceState,
	HealthStatus,
	InboundPayload,
	Location,
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
	UsageRow,
	WebhookEndpointState,
	WebhookEvent,
)

API_PREFIX = "/api/method/snd_whatsapp_platform.snd_whatsapp_platform.api."
V1_PREFIX = "/api/method/snd_whatsapp_platform.snd_whatsapp_platform.api.v1."

HEADER_EVENT = "X-SND-Event"
HEADER_EVENT_ID = "X-SND-Event-ID"
HEADER_TIMESTAMP = "X-SND-Timestamp"
HEADER_SIGNATURE = "X-SND-Signature"

STATUS_MAP: dict[str, str] = {
	"connected": "Connected",
	"open": "Connected",
	"ready": "Connected",
	"authenticated": "Connected",
	"pending qr": "Pending QR",
	"pending_qr": "Pending QR",
	"pending": "Pending QR",
	"not_logged_in": "Pending QR",
	"disconnected": "Disconnected",
	"closed": "Disconnected",
	"logged out": "Logged Out",
	"logged_out": "Logged Out",
}

AUTH_TEXT = (
	"api key",
	"api secret",
	"unauthorized",
	"invalid key",
	"invalid api",
	"not permitted",
	"authentication",
)
DEVICE_TEXT = (
	"not connected",
	"no provider token",
	"qr authentication",
	"not logged in",
	"device does not exist",
)
QUOTA_TEXT = ("quota", "limit", "insufficient", "balance", "expired", "inactive")

_PAYLOAD_KEYS = (
	"device",
	"recipient_type",
	"recipient_no",
	"group_id",
	"message_type",
	"message_body",
	"caption",
	"attachment",
	"media_type",
	"media_url",
	"media_base64",
	"media_filename",
	"media_mime_type",
	"view_once",
	"location_latitude",
	"location_longitude",
	"location_name",
	"location_address",
	"poll_question",
	"poll_options",
	"poll_allow_multiple_answers",
	"source_type",
	"source_site",
	"source_doctype",
	"source_docname",
)


def _digits(value: str | None) -> str | None:
	"""Provider boundary form of a number: digits without `+`; JIDs unchanged (platform PB-05)."""
	if not value:
		return None
	if "@" in value:
		return value
	return "".join(ch for ch in value if ch.isdigit())


def _dt(value: Any) -> datetime | None:
	if value in (None, ""):
		return None
	if isinstance(value, datetime):
		return value
	if isinstance(value, int | float):
		return datetime.fromtimestamp(float(value))
	text = str(value).strip()
	if text.isdigit():
		return datetime.fromtimestamp(int(text) if len(text) <= 10 else int(text) / 1000)
	for fmt in ("%Y-%m-%d %H:%M:%S.%f", "%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M:%S.%f", "%Y-%m-%dT%H:%M:%S"):
		try:
			return datetime.strptime(text.replace("Z", ""), fmt)
		except ValueError:
			continue
	return None


def _d(value: Any) -> date | None:
	dt = _dt(value)
	return dt.date() if dt else None


class SndPlatformProvider(BaseProvider):
	"""Provider for the SND WhatsApp Platform (`snd_whatsapp_platform`)."""

	key = "snd_platform"
	display_name = "SND Platform"
	capabilities = frozenset(
		{"batch_send", "pair_code", "qr", "signup", "usage", "queue_cancel", "polls", "webhooks"}
	)

	def __init__(self, settings) -> None:
		super().__init__(settings)
		self._session = requests.Session()
		self._latency_ms: int | None = None

	# ------------------------------------------------------------------ transport
	def _headers(self) -> dict[str, str]:
		creds = self.settings.credentials
		headers = {"Accept": "application/json", "Content-Type": "application/json"}
		if creds.get("customer_api_key"):
			headers["X-SND-API-Key"] = creds["customer_api_key"]
		if creds.get("api_key") and creds.get("api_secret"):
			headers["Authorization"] = f"token {creds['api_key']}:{creds['api_secret']}"
		if creds.get("api_secret"):
			headers["X-SND-API-Secret"] = creds["api_secret"]
		return headers

	def _url(self, endpoint: str, *, v1: bool = False) -> str:
		if not self.settings.base_url:
			raise pex.AuthError("Platform base URL is not configured", code="NOT_CONFIGURED")
		return self.settings.base_url.rstrip("/") + (V1_PREFIX if v1 else API_PREFIX) + endpoint

	def _request(
		self,
		method: str,
		endpoint: str,
		*,
		params: dict | None = None,
		body: dict | None = None,
		v1: bool = False,
		guest: bool = False,
	) -> dict:
		"""Call one platform endpoint; unwrap Frappe's `message`; map failures to typed errors."""
		if not guest and not self.settings.credentials.get("customer_api_key"):
			raise pex.AuthError("Customer API Key is not configured", code="AUTH_KEY_MISSING")
		url = self._url(endpoint, v1=v1)
		headers = (
			{"Accept": "application/json", "Content-Type": "application/json"} if guest else self._headers()
		)
		started = time.monotonic()
		try:
			response = self._session.request(
				method.upper(),
				url,
				params=params or None,
				json=body if body is not None and method.upper() != "GET" else None,
				headers=headers,
				timeout=self.settings.timeout,
				allow_redirects=False,
			)
		except requests.Timeout as exc:
			raise pex.TransientError("Platform request timed out", code="TIMEOUT") from exc
		except requests.ConnectionError as exc:
			raise pex.TransientError("Platform connection failed", code="CONNECTION") from exc
		except requests.RequestException as exc:
			raise pex.TransientError(
				f"Platform request error: {exc.__class__.__name__}", code="REQUEST"
			) from exc
		self._latency_ms = int((time.monotonic() - started) * 1000)
		return self._unwrap(response)

	def _unwrap(self, response: requests.Response) -> dict:
		status = response.status_code
		try:
			payload = response.json() if response.content else {}
		except ValueError:
			payload = {}
		data = payload.get("message") if isinstance(payload, dict) and "message" in payload else payload
		if not isinstance(data, dict):
			data = {"value": data}
		if 200 <= status < 300:
			if data.get("ok") is False:
				self._raise_business(data, status)
			return data
		self._raise_http(status, data if data else payload if isinstance(payload, dict) else {}, response)
		return {}  # pragma: no cover

	@staticmethod
	def _message_text(data: dict, response: requests.Response | None = None) -> str:
		text = data.get("error") or data.get("exception") or data.get("message") or ""
		if not text and data.get("_server_messages"):
			try:
				msgs = json.loads(data["_server_messages"])
				text = " ".join(json.loads(m).get("message", "") for m in msgs)
			except (ValueError, TypeError, AttributeError):
				text = str(data.get("_server_messages"))
		if not text and response is not None:
			text = f"HTTP {response.status_code}"
		return str(text)[:500]

	def _raise_business(self, data: dict, status: int) -> None:
		code = (data.get("code") or "").upper() or None
		text = self._message_text(data)
		lower = text.lower()
		kwargs = {"code": code, "http_status": status, "details": {"rejected": bool(data.get("rejected"))}}
		if code in ("QUOTA_EXCEEDED", "SUBSCRIPTION_INACTIVE", "SUBSCRIPTION_EXPIRED") or (
			not code and any(t in lower for t in QUOTA_TEXT)
		):
			raise pex.QuotaExceededError(
				text, reason=text, platform_message_log=data.get("message_log"), **kwargs
			)
		if code == "FEATURE_NOT_IN_PLAN" or code == "WEBHOOKS_NOT_IN_PLAN":
			raise pex.FeatureNotInPlanError(
				text, reason=text, platform_message_log=data.get("message_log"), **kwargs
			)
		if code in ("DEVICE_NOT_CONNECTED", "DEVICE_NO_TOKEN") or (
			not code and any(t in lower for t in DEVICE_TEXT)
		):
			raise pex.DeviceOfflineError(text, device_status=data.get("device_status"), **kwargs)
		raise pex.BusinessRejectedError(
			text, reason=text, platform_message_log=data.get("message_log"), **kwargs
		)

	def _raise_http(self, status: int, data: dict, response: requests.Response) -> None:
		code = (data.get("code") or "").upper() or None
		text = self._message_text(data, response)
		lower = text.lower()
		exc_type = str(data.get("exc_type") or "")
		kwargs = {"code": code, "http_status": status}
		if status == 429 or code == "RATE_LIMITED" or "RateLimit" in exc_type:
			retry_after = response.headers.get("Retry-After")
			raise pex.RateLimitError(
				text,
				retry_after=int(retry_after) if retry_after and retry_after.isdigit() else None,
				**kwargs,
			)
		if status == 401 or (code or "").startswith("AUTH_") or "AuthenticationError" in exc_type:
			raise pex.AuthError(text, **kwargs)
		if status == 403:
			if code in ("NOT_OWNER", "PERMISSION_DENIED") or "PermissionError" in exc_type:
				raise pex.PermissionDeniedError(text, **kwargs)
			if code == "FEATURE_NOT_IN_PLAN" or code == "WEBHOOKS_NOT_IN_PLAN":
				raise pex.FeatureNotInPlanError(text, reason=text, **kwargs)
			raise pex.AuthError(text, **kwargs)
		if status == 402 or code in ("QUOTA_EXCEEDED", "SUBSCRIPTION_INACTIVE", "SUBSCRIPTION_EXPIRED"):
			raise pex.QuotaExceededError(text, reason=text, **kwargs)
		if status == 404:
			raise pex.NotFoundError(text, **kwargs)
		if status == 409:
			if code in ("DEVICE_NOT_CONNECTED", "DEVICE_NO_TOKEN") or any(t in lower for t in DEVICE_TEXT):
				raise pex.DeviceOfflineError(text, device_status=data.get("device_status"), **kwargs)
			raise pex.BusinessRejectedError(
				text, reason=text, platform_message_log=data.get("message_log"), **kwargs
			)
		if status in (400, 413, 415, 422) or (status == 417 and "ValidationError" in exc_type):
			if any(t in lower for t in AUTH_TEXT) and status == 417:
				raise pex.AuthError(text, **kwargs)
			raise pex.ValidationError(text, **kwargs)
		if status == 417:
			if any(t in lower for t in AUTH_TEXT):
				raise pex.AuthError(text, **kwargs)
			if any(t in lower for t in DEVICE_TEXT):
				raise pex.DeviceOfflineError(text, **kwargs)
			if any(t in lower for t in QUOTA_TEXT):
				raise pex.QuotaExceededError(text, reason=text, **kwargs)
			raise pex.ValidationError(text, **kwargs)
		if status == 501:
			raise pex.NotSupportedError(text, **kwargs)
		if status >= 500 or status == 408:
			raise pex.TransientError(text, **kwargs)
		raise pex.ProviderError(text, **kwargs)

	# ------------------------------------------------------------------ account
	def health_check(self) -> HealthStatus:
		"""`get_subscription_status` round-trip; never raises."""
		try:
			data = self._request("GET", "get_subscription_status")
			return HealthStatus(
				ok=True,
				latency_ms=self._latency_ms,
				checked_at=datetime.now(),
				plan_code=data.get("plan_code"),
			)
		except pex.ProviderError as exc:
			return HealthStatus(
				ok=False, latency_ms=self._latency_ms, error=str(exc)[:200], checked_at=datetime.now()
			)
		except Exception as exc:  # defensive: health must never raise
			return HealthStatus(ok=False, error=exc.__class__.__name__, checked_at=datetime.now())

	def get_account(self) -> AccountInfo:
		"""Subscription + wallet; uses `get_account_api` (A-01) when available, else the two legacy calls."""
		try:
			data = self._request("GET", "get_account_api", v1=True)
			sub = data.get("subscription") or {}
			link = data.get("link") or {}
			return AccountInfo(
				plan_code=sub.get("plan_code"),
				plan_name=sub.get("plan_name") or sub.get("plan"),
				status=sub.get("status"),
				message_limit=int(sub.get("message_limit") or 0),
				messages_used=int(sub.get("messages_used") or 0),
				messages_remaining=int(sub.get("messages_remaining") or 0),
				messages_per_minute=int(sub.get("messages_per_minute") or 0),
				device_limit=int(sub.get("device_limit") or 0),
				devices_used=int(sub.get("devices_used") or 0),
				start_date=_d(sub.get("start_date")),
				end_date=_d(sub.get("end_date")),
				features=dict(data.get("features") or {}),
				webhook_events=dict(data.get("webhook_events") or {}),
				wallet_balance=(data.get("wallet") or {}).get("balance"),
				wallet_currency=(data.get("wallet") or {}).get("currency") or link.get("currency"),
			)
		except (pex.NotFoundError, pex.NotSupportedError, pex.ValidationError):
			pass
		sub = self._request("GET", "get_subscription_status")
		wallet: dict = {}
		try:
			wallet = self._request("GET", "get_wallet_balance_api")
		except pex.ProviderError:
			wallet = {}
		return AccountInfo(
			plan_code=sub.get("plan_code"),
			plan_name=sub.get("plan"),
			status=sub.get("status"),
			message_limit=int(sub.get("message_limit") or 0),
			messages_used=int(sub.get("messages_used") or 0),
			messages_remaining=int(sub.get("messages_remaining") or 0),
			messages_per_minute=int(sub.get("messages_per_minute") or 0),
			device_limit=int(sub.get("device_limit") or 0),
			devices_used=int(sub.get("devices_used") or 0),
			start_date=_d(sub.get("start_date")),
			end_date=_d(sub.get("end_date")),
			features=dict(sub.get("features") or {}),
			wallet_balance=wallet.get("balance"),
			wallet_currency=wallet.get("currency"),
		)

	def get_usage(self, from_: date, to: date, group_by: str = "day") -> UsageReport:
		"""`get_usage_api` (A-04); NotSupportedError while the platform does not expose it."""
		try:
			data = self._request(
				"GET",
				"get_usage_api",
				v1=True,
				params={"from": str(from_), "to": str(to), "group_by": group_by},
			)
		except pex.NotFoundError as exc:
			raise pex.NotSupportedError(
				"Usage report is not available on this platform yet", code="NOT_SUPPORTED"
			) from exc
		rows = tuple(
			UsageRow(
				key=str(r.get("key")),
				sent=int(r.get("sent") or 0),
				failed=int(r.get("failed") or 0),
				units=int(r.get("usage_units") or r.get("units") or 0),
				rejected=int(r.get("rejected") or 0),
			)
			for r in data.get("rows") or []
		)
		return UsageReport(from_=from_, to=to, group_by=group_by, rows=rows)

	# ------------------------------------------------------------------ signup (guest)
	def start_signup(
		self, plan_code: str, mobile_e164: str, full_name: str, email: str, channel: str
	) -> SignupState:
		data = self._request(
			"POST",
			"start_signup",
			guest=True,
			body={
				"full_name": full_name,
				"email": email,
				"mobile_no": _digits(mobile_e164),
				"plan_code": plan_code,
			},
		)
		return SignupState(
			request_key=data.get("token") or data.get("request_key"),
			status=str(data.get("status") or "Pending"),
			extra=data,
		)

	def get_signup_status(self, request_key: str) -> SignupState:
		data = self._request("POST", "get_signup_status", guest=True, body={"token": request_key})
		return SignupState(request_key=request_key, status=str(data.get("status") or "Pending"), extra=data)

	def complete_signup(self, request_key: str, code: str, password: str | None = None) -> SignupState:
		data = self._request(
			"POST", "verify_email_code", guest=True, body={"token": request_key, "code": code}
		)
		if password:
			data = self._request(
				"POST", "complete_signup", guest=True, body={"token": request_key, "password": password}
			)
		creds = {k: v for k, v in (data.get("credentials") or {}).items() if v}
		public = {k: v for k, v in data.items() if k != "credentials"}
		return SignupState(
			request_key=request_key,
			status=str(data.get("status") or "Completed"),
			credentials=creds or None,
			extra=public,
		)

	def start_password_reset(self, identifier: str) -> SignupState:
		data = self._request("POST", "start_password_reset", guest=True, body={"identifier": identifier})
		return SignupState(
			request_key=data.get("token"), status=str(data.get("status") or "Pending"), extra=data
		)

	# ------------------------------------------------------------------ devices
	def _device_state(self, row: dict) -> DeviceState:
		raw = str(row.get("status") or "")
		status = STATUS_MAP.get(
			raw.strip().lower(),
			raw if raw in ("Pending QR", "Connected", "Disconnected", "Logged Out") else "Pending QR",
		)
		phone = row.get("phone_number")
		return DeviceState(
			platform_device=str(row.get("device") or row.get("name")),
			device_name=row.get("device_name"),
			phone_e164=("+" + phone) if phone and str(phone).isdigit() else phone,
			status=status,
			wa_device_id=row.get("wa_device_id"),
			last_seen=_dt(row.get("last_seen")),
			webhook_registered=bool(row.get("wa_webhook_id") or row.get("wa_webhook_registered_at")),
			raw_status=raw or None,
			pairing_mode=row.get("pairing_mode"),
			last_status_change_at=_dt(row.get("last_status_change_at")),
			last_status_reason=row.get("last_status_reason"),
		)

	def create_device(self, device_name: str, phone_e164: str | None, pairing_mode: str) -> DeviceState:
		if pairing_mode == "Code" and not phone_e164:
			raise pex.ValidationError(
				"A phone number is required for pair-code pairing", code="PHONE_REQUIRED_FOR_PAIR_CODE"
			)
		data = self._request(
			"POST",
			"create_device_api",
			body={
				"device_name": device_name,
				"phone_number": _digits(phone_e164) or "",
				"pairing_mode": pairing_mode,
			},
		)
		return self._device_state(
			{
				**data,
				"device": data.get("device"),
				"device_name": device_name,
				"phone_number": _digits(phone_e164),
			}
		)

	def list_devices(self) -> list[DeviceState]:
		data = self._request("GET", "list_devices_api")
		return [self._device_state(row) for row in data.get("devices") or []]

	def get_device(self, platform_device: str) -> DeviceState:
		for state in self.list_devices():
			if state.platform_device == platform_device:
				return state
		raise pex.NotFoundError(
			f"Device {platform_device} not found on the platform", code="DEVICE_NOT_FOUND"
		)

	def update_device(
		self, platform_device: str, device_name: str | None, phone_e164: str | None
	) -> DeviceState:
		body: dict[str, Any] = {"device": platform_device}
		if device_name is not None:
			body["device_name"] = device_name
		if phone_e164 is not None:
			body["phone_number"] = _digits(phone_e164)
		try:
			data = self._request("POST", "update_device_api", v1=True, body=body)
		except pex.NotFoundError as exc:
			raise pex.NotSupportedError("update_device_api is not available on this platform yet") from exc
		return self._device_state(data.get("device") if isinstance(data.get("device"), dict) else data)

	def _pairing(self, data: dict, mode: str) -> PairingPayload:
		expires_in = int(data.get("qr_expires_in") or 60)
		generated_at = _dt(data.get("qr_generated_at")) or datetime.now()
		expires_at = _dt(data.get("qr_expires_at")) or (generated_at + timedelta(seconds=expires_in))
		phone = data.get("phone_number")
		return PairingPayload(
			mode=mode,
			qr_code=data.get("qr_code") if mode == "QR" else None,
			pair_code=data.get("pair_code") if mode == "Code" else None,
			generated_at=generated_at,
			expires_at=expires_at,
			expires_in=expires_in,
			phone_e164=("+" + phone) if phone and str(phone).isdigit() else phone,
		)

	def get_qr(self, platform_device: str) -> PairingPayload:
		data = self._request("GET", "get_device_qr_api", params={"device": platform_device})
		if not data.get("qr_code"):
			raise pex.DeviceOfflineError(
				"QR is not available for this device", code="PROVIDER_QR_UNAVAILABLE"
			)
		return self._pairing(data, "QR")

	def get_pair_code(self, platform_device: str) -> PairingPayload:
		data = self._request("GET", "get_device_pair_code_api", params={"device": platform_device})
		if not data.get("pair_code"):
			raise pex.ValidationError(
				"Pair code is not available for this device", code="PHONE_REQUIRED_FOR_PAIR_CODE"
			)
		return self._pairing(data, "Code")

	def verify_device(self, platform_device: str) -> DeviceState:
		data = self._request("GET", "verify_device_connection_api", params={"device": platform_device})
		return self._device_state(data)

	def reconnect_device(self, platform_device: str) -> DeviceState:
		try:
			data = self._request("POST", "reconnect_device_api", v1=True, body={"device": platform_device})
		except pex.NotFoundError as exc:
			raise pex.NotSupportedError("reconnect_device_api is not available on this platform yet") from exc
		return self._device_state(data.get("device") if isinstance(data.get("device"), dict) else data)

	def disconnect_device(self, platform_device: str) -> DeviceState:
		data = self._request("POST", "disconnect_device_api", body={"device": platform_device})
		return self._device_state(
			{**data, "device": platform_device, "status": data.get("status") or "Logged Out"}
		)

	def delete_device(self, platform_device: str, delete_remote: bool) -> None:
		self._request(
			"POST",
			"delete_device_api",
			body={"device": platform_device, "delete_local": 1 if delete_remote else 0},
		)

	# ------------------------------------------------------------------ sending
	def _message_payload(self, message: NormalizedMessage) -> dict[str, Any]:
		"""`NormalizedMessage` → platform keys (only `_PAYLOAD_KEYS` + `client_ref`, `priority`)."""
		payload: dict[str, Any] = {
			"device": message.platform_device,
			"client_ref": message.client_ref,
			"priority": message.priority,
			"recipient_type": message.recipient_type,
			"message_type": message.message_type,
			"source_type": message.source.type,
			"source_site": message.source.site,
			"source_doctype": message.source.doctype,
			"source_docname": message.source.docname,
		}
		if message.recipient_type == "Group":
			payload["group_id"] = message.jid
		else:
			payload["recipient_no"] = _digits(message.phone_e164)
		if message.message_type == "Text":
			payload["message_body"] = message.body or ""
		elif message.message_type in ("Document", "Image", "Video", "Audio", "Sticker"):
			att = message.attachment
			payload["caption"] = message.caption or message.body or ""
			payload["media_type"] = message.message_type.lower()
			if att:
				payload["media_filename"] = att.file_name
				payload["media_mime_type"] = att.mime_type
				if att.content_b64:
					payload["media_base64"] = att.content_b64
				elif att.url:
					payload["media_url"] = att.url
			payload["view_once"] = 1 if message.view_once else 0
		elif message.message_type == "Location" and message.location:
			payload.update(
				{
					"location_latitude": message.location.latitude,
					"location_longitude": message.location.longitude,
					"location_name": message.location.name,
					"location_address": message.location.address,
				}
			)
		elif message.message_type == "Poll" and message.poll:
			payload.update(
				{
					"poll_question": message.poll.question,
					"poll_options": list(message.poll.options),
					"poll_allow_multiple_answers": 1 if message.poll.allow_multiple else 0,
				}
			)
		elif message.message_type in ("Template", "Interactive"):
			raise pex.NotSupportedError(
				f"{message.message_type} messages are not supported by the SND platform", code="NOT_SUPPORTED"
			)
		return {k: v for k, v in payload.items() if v is not None}

	def send_message(self, message: NormalizedMessage) -> SendResult:
		"""Single synchronous send via `send_message_api` (test send only, D-024); `allow_fallback=0`."""
		payload = self._message_payload(message)
		payload["allow_fallback"] = 0
		data = self._request("POST", "send_message_api", body=payload)
		return SendResult(
			ok=bool(data.get("ok")),
			provider_message_id=data.get("provider_message_id"),
			platform_message_log=data.get("message_log"),
			device_fallback=bool(data.get("device_fallback")),
			requested_device=data.get("requested_device"),
			rejected=bool(data.get("rejected")),
			reason=data.get("error"),
			code=data.get("code"),
			device=data.get("device") or message.platform_device,
		)

	def send_batch(self, messages: list[NormalizedMessage], batch_id: str) -> BatchResult:
		"""`enqueue_messages_api` with `client_ref` per message (D-024); ≤ MAX_BATCH."""
		if not messages:
			raise pex.ValidationError("Batch is empty", code="BATCH_EMPTY")
		if len(messages) > MAX_BATCH:
			raise pex.ValidationError(f"A batch carries at most {MAX_BATCH} messages", code="BATCH_TOO_LARGE")
		body = {"messages": [self._message_payload(m) for m in messages], "batch_id": batch_id[:64]}
		data = self._request("POST", "enqueue_messages_api", body=body)
		accepted = tuple(
			BatchAccepted(
				client_ref=str(a.get("client_ref")),
				queue_id=str(a.get("queue_id")),
				status=str(a.get("status") or "Queued"),
			)
			for a in data.get("accepted") or []
		)
		errors = tuple(
			BatchError(
				client_ref=e.get("client_ref"),
				error=str(e.get("error") or ""),
				code=e.get("code"),
				queue_id=e.get("queue_id"),
			)
			for e in data.get("errors") or []
		)
		return BatchResult(batch_id=str(data.get("batch_id") or batch_id), accepted=accepted, errors=errors)

	def get_message_status(self, client_refs: list[str]) -> tuple[list[MessageStatus], list[str]]:
		refs = [r for r in client_refs if r][:MAX_STATUS_REFS]
		if not refs:
			return [], []
		data = self._request("POST", "get_message_status_api", body={"refs": refs})
		statuses = [
			MessageStatus(
				client_ref=str(s.get("client_ref")),
				queue_id=s.get("queue_id"),
				status=str(s.get("status") or ""),
				reason=s.get("reason"),
				platform_message_log=s.get("message_log"),
				attempt_count=int(s.get("attempt_count") or 0),
				provider_message_id=s.get("provider_message_id"),
				device=s.get("device"),
				sent_at=_dt(s.get("sent_at")),
				delivered_at=_dt(s.get("delivered_at")),
				read_at=_dt(s.get("read_at")),
				message_status=s.get("message_status"),
			)
			for s in data.get("statuses") or []
		]
		return statuses, [str(u) for u in data.get("unknown") or []]

	def get_queue_status(self) -> QueueStatus:
		data = self._request("GET", "get_queue_status_api")
		return QueueStatus(
			counts={str(k): int(v) for k, v in (data.get("counts") or {}).items()},
			messages_per_minute=int(data.get("messages_per_minute") or 0),
			messages_remaining=int(data.get("messages_remaining") or 0),
			held_reason=data.get("held_reason"),
		)

	def cancel_queued(self, client_refs: list[str] | None, batch_id: str | None) -> int:
		body: dict[str, Any] = {}
		if client_refs:
			body["refs"] = client_refs[:MAX_STATUS_REFS]
		if batch_id:
			body["batch_id"] = batch_id
		try:
			data = self._request("POST", "cancel_queued_messages_api", v1=True, body=body)
		except pex.NotFoundError as exc:
			raise pex.NotSupportedError(
				"cancel_queued_messages_api is not available on this platform yet"
			) from exc
		return len(data.get("cancelled") or [])

	def get_poll_results(self, platform_device: str, poll_ids: list[str]) -> dict[str, dict]:
		ids = list(dict.fromkeys(p for p in poll_ids if p))[:MAX_POLL_IDS]
		if not ids:
			return {}
		data = self._request(
			"POST", "get_poll_results_api", body={"device": platform_device, "poll_ids": ids}
		)
		out: dict[str, dict] = {}
		for row in data.get("results") or []:
			out[str(row.get("poll_id"))] = row.get("result") if row.get("ok") else {"error": row.get("error")}
		return out

	# ------------------------------------------------------------------ contacts / groups
	def list_device_contacts(self, platform_device: str) -> list[ProviderContact]:
		data = self._request("GET", "list_device_contacts_api", params={"device": platform_device})
		out = []
		for row in data.get("contacts") or []:
			jid = str(row.get("jid") or row.get("id") or "")
			phone = (
				row.get("phone")
				or row.get("mobile_no")
				or (jid.split("@")[0] if jid and "@" in jid and not jid.endswith("@lid") else None)
			)
			out.append(
				ProviderContact(
					jid=jid,
					phone_e164=("+" + str(phone)) if phone and str(phone).isdigit() else phone,
					name=row.get("name") or row.get("push_name"),
				)
			)
		return out

	def list_device_groups(self, platform_device: str) -> list[ProviderGroup]:
		data = self._request("GET", "list_device_groups_api", params={"device": platform_device})
		return [
			ProviderGroup(
				jid=str(row.get("jid") or row.get("id") or ""),
				name=row.get("name") or row.get("subject"),
				participants_count=int(
					row.get("participants_count") or len(row.get("participants") or []) or 0
				),
			)
			for row in data.get("groups") or []
		]

	# ------------------------------------------------------------------ webhooks
	@staticmethod
	def sign(secret: str, timestamp: str, raw_body: bytes | str) -> str:
		"""hex(HMAC-SHA256(secret, f"{timestamp}.{raw_body}")) — the platform's signing rule."""
		body = raw_body.decode("utf-8") if isinstance(raw_body, bytes) else raw_body
		return hmac.new(secret.encode("utf-8"), f"{timestamp}.{body}".encode(), hashlib.sha256).hexdigest()

	def verify_webhook(
		self, headers: Mapping[str, str], raw_body: bytes, secret: str, max_skew: int = DEFAULT_MAX_SKEW
	) -> SignatureCheck:
		"""Constant-time compare of `X-SND-Signature`; freshness of `X-SND-Timestamp` within `max_skew`."""
		h = _ci_headers(headers)
		signature = h.get(HEADER_SIGNATURE.lower(), "")
		timestamp = h.get(HEADER_TIMESTAMP.lower(), "")
		if not signature or not timestamp:
			return SignatureCheck(valid=False, fresh=False, reason="missing headers")
		if not secret:
			return SignatureCheck(valid=False, fresh=False, reason="no secret")
		try:
			ts = int(float(timestamp))
		except ValueError:
			return SignatureCheck(valid=False, fresh=False, reason="bad timestamp")
		event_ts = datetime.fromtimestamp(ts)
		fresh = abs(int(time.time()) - ts) <= max_skew
		expected = self.sign(secret, timestamp, raw_body)
		valid = hmac.compare_digest(expected, signature.strip().lower())
		reason = None if valid and fresh else ("stale" if valid else "signature")
		return SignatureCheck(valid=valid, fresh=fresh, event_timestamp=event_ts, reason=reason)

	def parse_webhook(self, headers: Mapping[str, str], body: dict) -> WebhookEvent:
		"""Platform payload + headers → `WebhookEvent` (pure). Unknown events keep their name."""
		h = _ci_headers(headers)
		event_name = h.get(HEADER_EVENT.lower()) or str(body.get("event") or "")
		if event_name == "message.status":
			event_name = _status_alias(body)
		event_id = h.get(HEADER_EVENT_ID.lower()) or str(body.get("event_id") or "")
		ts_header = h.get(HEADER_TIMESTAMP.lower())
		timestamp = _dt(ts_header) or _dt(body.get("occurred_at")) or _dt(body.get("timestamp"))
		platform_device = body.get("device") if isinstance(body.get("device"), str) else None
		status = body.get("status")
		reason = body.get("held_reason") or body.get("reason") or body.get("error")

		device = None
		if event_name.startswith("connection.") or platform_device:
			device = DeviceState(
				platform_device=platform_device or "",
				device_name=body.get("device_name"),
				phone_e164=("+" + str(body["phone_number"]))
				if str(body.get("phone_number") or "").isdigit()
				else body.get("phone_number"),
				status=STATUS_MAP.get(
					str(status or "").lower(),
					str(status)
					if status in ("Pending QR", "Connected", "Disconnected", "Logged Out")
					else _status_from_event(event_name),
				),
				wa_device_id=body.get("wa_device_id"),
				raw_status=str(status) if status else None,
				last_status_reason=body.get("last_status_reason"),
			)

		inbound = None
		if event_name in ("message.received", "message.reaction"):
			inbound = _parse_inbound(body, timestamp)

		provider_message_id = body.get("provider_message_id") or (
			inbound.provider_message_id if inbound else None
		)
		if (
			not provider_message_id
			and event_name in ("message.sent", "message.delivered", "message.read")
			and event_id
			and not event_id.startswith("evt_")
		):
			provider_message_id = event_id

		return WebhookEvent(
			event_id=event_id,
			event_name=event_name,
			timestamp=timestamp,
			platform_device=platform_device,
			client_ref=body.get("client_ref"),
			provider_message_id=provider_message_id,
			queue_id=body.get("queue_id"),
			platform_message_log=body.get("message_log"),
			status=str(status) if status is not None else None,
			reason=str(reason) if reason else None,
			device=device,
			inbound=inbound,
			raw=body,
		)

	def get_webhook_secret(self) -> str:
		data = self._request("GET", "get_integration_webhook_secret_api")
		secret = data.get("webhook_secret")
		if not secret:
			raise pex.ProviderError("Platform returned no webhook secret", code="NO_SECRET")
		return str(secret)

	def configure_webhook(
		self, endpoint_url: str, events: list[str], max_retries: int
	) -> WebhookEndpointState:
		"""Register the receiver URL on the link, then create the events endpoint (never passes `secret`)."""
		self._request("POST", "configure_integration_webhook_api", body={"endpoint_url": endpoint_url})
		for state in self.list_webhook_endpoints():
			if state.url == endpoint_url and state.status != "Revoked":
				return state
		data = self._request(
			"POST",
			"create_webhook_endpoint_api",
			body={
				"endpoint_url": endpoint_url,
				"events": events,
				"max_retries": max_retries,
				"endpoint_name": "whatsapp_next",
			},
		)
		return WebhookEndpointState(
			endpoint_id=str(data.get("webhook_endpoint")),
			url=str(data.get("endpoint_url") or endpoint_url),
			status=str(data.get("status") or "Active"),
			events=tuple(data.get("events") or events),
			max_retries=max_retries,
			lock_after_failures=data.get("lock_after_failures"),
		)

	def _endpoint_state(self, row: dict) -> WebhookEndpointState:
		events = row.get("events") or []
		names = (
			tuple(e.get("event_name") for e in events if isinstance(e, dict) and e.get("enabled", 1))
			if events and isinstance(events[0], dict)
			else tuple(events)
		)
		return WebhookEndpointState(
			endpoint_id=str(row.get("name") or row.get("webhook_endpoint")),
			url=str(row.get("endpoint_url") or ""),
			status=str(row.get("status") or "Active"),
			events=names,
			max_retries=int(row.get("max_retries") or 3),
			consecutive_failures=int(row.get("consecutive_failures") or 0),
			locked_at=_dt(row.get("locked_at")),
			lock_reason=row.get("lock_reason"),
			last_http_status=row.get("last_http_status"),
			lock_after_failures=row.get("lock_after_failures"),
			unlocked_at=_dt(row.get("unlocked_at")),
		)

	def list_webhook_endpoints(self) -> list[WebhookEndpointState]:
		data = self._request("GET", "list_webhook_endpoints_api")
		return [self._endpoint_state(row) for row in data.get("webhooks") or []]

	def update_webhook_endpoint(
		self, endpoint_id: str, status: str | None, events: list[str] | None, url: str | None
	) -> WebhookEndpointState:
		body: dict[str, Any] = {"webhook_endpoint": endpoint_id}
		if status is not None:
			body["status"] = status
		if events is not None:
			body["events"] = events
		if url is not None:
			body["endpoint_url"] = url
		try:
			data = self._request("POST", "update_webhook_endpoint_api", v1=True, body=body)
		except pex.NotFoundError as exc:
			if (exc.code or "") in ("WEBHOOK_NOT_FOUND",):
				raise
			raise pex.NotSupportedError(
				"update_webhook_endpoint_api is not available on this platform yet"
			) from exc
		row = data.get("webhook") if isinstance(data.get("webhook"), dict) else data
		return self._endpoint_state(
			{**row, "name": row.get("name") or row.get("webhook_endpoint") or endpoint_id}
		)

	def test_webhook_endpoint(self, endpoint_id: str) -> dict:
		return self._request("POST", "test_webhook_endpoint_api", body={"webhook_endpoint": endpoint_id})

	def delete_webhook_endpoint(self, endpoint_id: str) -> None:
		self._request("POST", "delete_webhook_endpoint_api", body={"webhook_endpoint": endpoint_id})

	def list_available_webhook_events(self) -> list[dict]:
		data = self._request("GET", "list_available_webhook_events_api")
		return [
			{
				"event_name": e.get("event_name"),
				"enabled": bool(e.get("enabled")),
				"disabled_reason": e.get("disabled_reason") or e.get("reason"),
			}
			for e in data.get("events") or []
		]


# ---------------------------------------------------------------------- helpers
def _ci_headers(headers: Mapping[str, str]) -> dict[str, str]:
	return {str(k).lower(): str(v) for k, v in (headers or {}).items()}


def _status_alias(body: dict) -> str:
	status = str(body.get("status") or "").lower()
	return {
		"sent": "message.sent",
		"delivered": "message.delivered",
		"read": "message.read",
		"failed": "message.failed",
		"held": "message.held",
		"cancelled": "message.failed",
	}.get(status, "message.status")


def _status_from_event(event_name: str) -> str:
	return {
		"connection.connected": "Connected",
		"connection.disconnected": "Disconnected",
		"connection.logged_out": "Logged Out",
	}.get(event_name, "Pending QR")


_INBOUND_TYPE_MAP = {
	"text": "Text",
	"conversation": "Text",
	"extendedtextmessage": "Text",
	"image": "Image",
	"imagemessage": "Image",
	"video": "Video",
	"videomessage": "Video",
	"audio": "Audio",
	"audiomessage": "Audio",
	"ptt": "Audio",
	"document": "Document",
	"documentmessage": "Document",
	"sticker": "Sticker",
	"stickermessage": "Sticker",
	"location": "Location",
	"locationmessage": "Location",
	"poll": "Poll",
	"pollcreationmessage": "Poll",
	"reaction": "Reaction",
	"reactionmessage": "Reaction",
	"contact": "Contact",
	"contactmessage": "Contact",
	"vcard": "Contact",
}


def _first(*values):
	for v in values:
		if v not in (None, "", [], {}):
			return v
	return None


def _parse_inbound(body: dict, timestamp: datetime | None) -> InboundPayload:
	"""Best-effort extraction from the platform's `message.received` payload (D-023 enrichment)."""
	msg = body.get("message") if isinstance(body.get("message"), dict) else {}
	data = body.get("data") if isinstance(body.get("data"), dict) else {}
	nested = msg or data or {}
	sender_jid = _first(
		body.get("sender_jid"),
		body.get("from"),
		body.get("participant"),
		nested.get("from"),
		nested.get("sender"),
	)
	chat_jid = _first(
		body.get("chat_jid"),
		body.get("chat"),
		body.get("chat_id"),
		nested.get("chat"),
		nested.get("chat_id"),
		body.get("from"),
	)
	from_jid = _first(body.get("from"), body.get("from_jid"), sender_jid)
	sender_mobile = _first(body.get("sender_mobile_no"), body.get("sender_phone"), body.get("mobile_no"))
	text = _first(
		body.get("text"),
		body.get("body"),
		msg.get("text") if isinstance(msg, dict) else None,
		msg.get("body") if isinstance(msg, dict) else None,
		msg.get("conversation") if isinstance(msg, dict) else None,
		body.get("message") if isinstance(body.get("message"), str) else None,
		body.get("caption"),
	)
	raw_type = str(_first(body.get("message_type"), body.get("type"), nested.get("type"), "text") or "text")
	message_type = _INBOUND_TYPE_MAP.get(
		raw_type.lower().replace("_", ""), "Other" if raw_type.lower() not in ("text",) else "Text"
	)
	if body.get("event") == "message.reaction" or body.get("reaction"):
		message_type = "Reaction"
	provider_message_id = _first(
		body.get("provider_message_id"),
		body.get("message_id"),
		body.get("messageId"),
		body.get("id"),
		nested.get("id"),
		nested.get("message_id"),
	)
	location = None
	lat = _first(body.get("latitude"), body.get("location_latitude"), nested.get("latitude"))
	lng = _first(body.get("longitude"), body.get("location_longitude"), nested.get("longitude"))
	if lat is not None and lng is not None:
		try:
			location = Location(
				latitude=float(lat),
				longitude=float(lng),
				name=_first(body.get("location_name"), nested.get("name")),
				address=_first(body.get("location_address"), nested.get("address")),
			)
		except (TypeError, ValueError):
			location = None
	reaction = _first(body.get("reaction"), nested.get("reaction"), nested.get("emoji"))
	if isinstance(reaction, dict):
		reaction = reaction.get("text") or reaction.get("emoji")
	is_group = bool(body.get("is_group")) or str(chat_jid or "").endswith("@g.us")
	return InboundPayload(
		provider_message_id=str(provider_message_id) if provider_message_id else None,
		sender_phone=str(sender_mobile) if sender_mobile else None,
		sender_jid=str(sender_jid) if sender_jid else None,
		chat_jid=str(chat_jid) if chat_jid else None,
		from_jid=str(from_jid) if from_jid else None,
		is_group=is_group,
		push_name=_first(
			body.get("push_name"),
			body.get("pushName"),
			body.get("sender_name"),
			nested.get("pushName"),
			nested.get("push_name"),
		),
		message_type=message_type,
		body=str(text) if text is not None else None,
		caption=_first(body.get("caption"), nested.get("caption")),
		media_url=_first(body.get("media_url"), body.get("url"), nested.get("url"), nested.get("media_url")),
		media_mime_type=_first(
			body.get("media_mime_type"),
			body.get("mime_type"),
			nested.get("mimetype"),
			nested.get("mime_type"),
		),
		location=location,
		reaction=str(reaction) if reaction else None,
		reaction_to=_first(
			body.get("reaction_to"),
			body.get("reacted_message_id"),
			nested.get("reacted_message_id"),
			body.get("quoted_message_id") if message_type == "Reaction" else None,
		),
		quoted_id=_first(
			body.get("quoted_message_id"), body.get("quoted_provider_message_id"), nested.get("quoted_id")
		),
		received_at=_dt(body.get("received_at"))
		or _dt(body.get("timestamp"))
		or _dt(nested.get("timestamp"))
		or timestamp,
	)


def b64(content: bytes) -> str:
	"""Base64 helper for attachment bytes (kept here so services never import base64 for the wire)."""
	return base64.b64encode(content).decode("ascii")

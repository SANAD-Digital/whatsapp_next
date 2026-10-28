# Module role: the SND WhatsApp Platform provider (backend-plan §2.5). One transport (`_request`)
# with the three credentials of D-020, typed exception mapping (200 `ok:false` → business
# rejection, 4xx/5xx → typed errors, A-09 `code` preferred over text), batch enqueue with
# `client_ref` (D-024), HMAC webhook verification and a single webhook parser (D-013).

from __future__ import annotations

import hashlib
import hmac
import json
import time
from collections.abc import Mapping
from datetime import date, datetime, timedelta, timezone
from typing import Any

import frappe
import requests
from frappe.utils import convert_utc_to_system_timezone

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
	ContactProfile,
	DeviceState,
	GroupCreated,
	GroupMember,
	HealthStatus,
	HistoryMessage,
	HistoryPage,
	InboundPayload,
	Location,
	MessageStatus,
	NormalizedMessage,
	NumberCheck,
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
	WebhookEnvelope,
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
	"reply_to_message_id",
	"interactive",
	"source_type",
	"source_site",
	"source_doctype",
	"source_docname",
)


def _language() -> str:
	"""This request's language as the platform names it: "ar" or "en"."""
	lang = str(getattr(frappe.local, "lang", None) or "en").split("-")[0].split("_")[0].lower()
	return lang if lang in ("ar", "en") else "en"


def _digits(value: str | None) -> str | None:
	"""Provider boundary form of a number: digits without `+`; JIDs unchanged (platform PB-05)."""
	if not value:
		return None
	if "@" in value:
		return value
	return "".join(ch for ch in value if ch.isdigit())


def _site_time(moment: datetime) -> datetime:
	"""An absolute instant as this site's own wall clock, naive like every Datetime Frappe stores.
	`datetime.fromtimestamp()` alone gives the server OS's clock (Europe/Berlin here), and the
	platform's own local times are another zone again (Asia/Aden), while the site may be neither."""
	if moment.tzinfo is None:
		return moment
	return convert_utc_to_system_timezone(moment.astimezone(timezone.utc)).replace(tzinfo=None)


# The zone the SND platform runs in (its System Settings): its API returns Datetime fields bare,
# and its webhook `occurred_at` is that zone's wall clock with no offset.
PLATFORM_TIME_ZONE = "Asia/Aden"


def _platform_zone():
	"""The zone the platform writes its zoneless times in, `PLATFORM_TIME_ZONE`. Taking them as
	written made a site in another zone read every `last_seen` / `sent_at` off by the difference
	(2 h 30 min between Aden and Kolkata). Nothing of this app is read from the site config."""
	name = PLATFORM_TIME_ZONE
	try:
		from zoneinfo import ZoneInfo

		return ZoneInfo(name)
	except Exception:
		return None


def _dt(value: Any) -> datetime | None:
	"""A time from the platform as the site's wall clock. Unix times and ISO strings that carry a
	zone are exact; a zoneless ISO string (the platform's `occurred_at`, its Datetime fields) is
	the platform's wall clock (`_platform_zone`)."""
	if value in (None, ""):
		return None
	if isinstance(value, datetime):
		return _site_time(value)
	if isinstance(value, int | float) or (isinstance(value, str) and value.strip().replace(".", "", 1).isdigit()):
		number = float(value)
		return _site_time(datetime.fromtimestamp(number / 1000 if number > 1e11 else number, timezone.utc))
	text = str(value).strip()
	try:
		parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
		return _site_time(parsed) if parsed.tzinfo is not None else _placed(parsed)
	except ValueError:
		pass
	for fmt in ("%Y-%m-%d %H:%M:%S.%f", "%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M:%S.%f", "%Y-%m-%dT%H:%M:%S"):
		try:
			return _placed(datetime.strptime(text.replace("Z", ""), fmt))
		except ValueError:
			continue
	return None


def _placed(naive: datetime) -> datetime:
	"""A zoneless platform time on the site's clock, when the platform's zone is known."""
	zone = _platform_zone()
	return _site_time(naive.replace(tzinfo=zone)) if zone else naive


def _d(value: Any) -> date | None:
	"""A calendar date. A bare `YYYY-MM-DD` is a day, not an instant: it is read as written (it
	used to come back empty, which is why the subscription's start and end never showed)."""
	if isinstance(value, date) and not isinstance(value, datetime):
		return value
	if isinstance(value, str) and len(value.strip()) == 10:
		try:
			return date.fromisoformat(value.strip())
		except ValueError:
			pass
	dt = _dt(value)
	return dt.date() if dt else None


class SndPlatformProvider(BaseProvider):
	"""Provider for the SND WhatsApp Platform (`snd_whatsapp_platform`)."""

	key = "snd_platform"
	display_name = "SND Platform"
	capabilities = frozenset(
		{"batch_send", "pair_code", "qr", "signup", "usage", "queue_cancel", "polls", "webhooks", "billing"}
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
		# the integration's own secret (D-129): a factor of its own, not the user's token secret
		if creds.get("customer_api_secret"):
			headers["X-SND-API-Secret"] = creds["customer_api_secret"]
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
				# A guest call (sign-up, sign-in, recovery) carries this user's language the way the
				# platform's own switcher does, so the account it opens or signs into speaks it too.
				cookies={"preferred_language": _language()} if guest else None,
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
		# an error keeps the envelope's own keys (`exc_type`, `_server_messages`, `code`) beside the
		# unwrapped `message`: reading only one of them lost the type (a 417 PermissionError read
		# as a validation error) or, for a string `message`, the text itself
		error = dict(payload) if isinstance(payload, dict) else {}
		if isinstance(error.get("message"), dict):
			error.pop("message")
		error.update({k: v for k, v in data.items() if k != "value"})
		self._raise_http(status, error, response)
		return {}  # pragma: no cover

	@staticmethod
	def _message_text(data: dict, response: requests.Response | None = None) -> str:
		text = data.get("error") or data.get("message") or ""
		if not text and data.get("_server_messages"):
			try:
				msgs = json.loads(data["_server_messages"])
				text = " ".join(json.loads(m).get("message", "") for m in msgs)
			except (ValueError, TypeError, AttributeError):
				text = str(data.get("_server_messages"))
		if not text and data.get("exception"):
			# the platform's raw `module.ExceptionClass: message`: keep the message, not the
			# platform's internals, since this text reaches the caller of our API
			text = str(data["exception"]).split(": ", 1)[-1]
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
		if "AccountExistsError" in exc_type or code == "ACCOUNT_EXISTS":
			raise pex.AccountExistsError(text, **kwargs)
		# the platform refuses an account with no live subscription either with its code or, from
		# older paths (`services/subscriptions.py`), with a plain `frappe.throw` of the same text
		if code in ("SUBSCRIPTION_INACTIVE", "SUBSCRIPTION_EXPIRED") or "subscription is not active" in lower:
			kwargs["code"] = code or "SUBSCRIPTION_INACTIVE"
			raise pex.QuotaExceededError(text, reason=text, **kwargs)
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
				account_id=link.get("name"),
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
	def get_signup_bootstrap(self) -> dict:
		"""`{plans[], device_phone, device_ready, code_ttl_minutes}` before anything is typed."""
		return self._request("GET", "get_signup_bootstrap", guest=True)

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
		body: dict[str, Any] = {
			"full_name": full_name,
			"email": email or "",
			"mobile_no": _digits(mobile_e164),
			"plan_code": plan_code,
		}
		# Older platforms reject an unknown argument, so it is sent only when used.
		if coupon_code:
			body["coupon_code"] = coupon_code
		optional: dict[str, Any] = {}
		if callback and callback.get("url") and callback.get("token"):
			optional.update({"callback_url": callback["url"], "callback_token": callback["token"]})
		# the company the account is for, and what it does: the platform names the customer after it
		company = company or {}
		if company.get("name"):
			optional["company_name"] = company["name"]
		if company.get("activity"):
			optional["business_activity"] = company["activity"]
		try:
			data = self._request("POST", "start_signup", guest=True, body={**body, **optional})
		except pex.ProviderError as exc:
			# a platform from before these arguments refuses them: ask again without (the page then
			# only asks for the status, and the customer is named after the person)
			if not optional or "unexpected keyword" not in str(exc).lower():
				raise
			data = self._request("POST", "start_signup", guest=True, body=body)
		return SignupState(
			request_key=data.get("token") or data.get("request_key"),
			status=str(data.get("status") or "Pending"),
			extra=data,
		)

	def get_signup_status(self, request_key: str) -> SignupState:
		data = self._request("POST", "get_signup_status", guest=True, body={"token": request_key})
		return SignupState(request_key=request_key, status=str(data.get("status") or "Pending"), extra=data)

	def verify_signup_code(self, request_key: str, code: str, purpose: str | None = None) -> SignupState:
		body: dict[str, Any] = {"token": request_key, "code": code}
		if purpose:
			body["purpose"] = purpose
		data = self._request("POST", "verify_email_code", guest=True, body=body)
		return SignupState(request_key=request_key, status=str(data.get("status") or "Verified"), extra=data)

	def complete_signup(self, request_key: str, code: str, password: str | None = None) -> SignupState:
		data: dict[str, Any] = {}
		if code:
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
			# only the call that set the password completes the account; a code alone verifies it
			status=str(data.get("status") or ("Completed" if password else "Verified")),
			credentials=creds or None,
			extra=public,
		)

	def start_password_reset(self, identifier: str, callback: dict | None = None) -> SignupState:
		body = {"identifier": identifier}
		if callback and callback.get("url") and callback.get("token"):
			body.update({"callback_url": callback["url"], "callback_token": callback["token"]})
		data = self._request("POST", "start_password_reset", guest=True, body=body)
		return SignupState(
			request_key=data.get("token"), status=str(data.get("status") or "Pending"), extra=data
		)

	def get_password_reset_status(self, request_key: str) -> SignupState:
		data = self._request("POST", "get_password_reset_status", guest=True, body={"token": request_key})
		return SignupState(request_key=request_key, status=str(data.get("status") or "Pending"), extra=data)

	def complete_password_reset(self, request_key: str, password: str) -> SignupState:
		data = self._request(
			"POST", "complete_password_reset", guest=True, body={"token": request_key, "password": password}
		)
		return SignupState(
			request_key=request_key, status=str(data.get("status") or "Completed"), extra=data
		)

	# ------------------------------------------------------------------ sign-in and coupons
	def login(self, email: str, password: str) -> dict:
		"""Exchange an e-mail and password for this tenant's credentials.

		Returns the platform's answer unchanged: `{ok, customer, customer_name,
		integration_link, api_base_url, credentials{customer_api_key, customer_api_secret,
		api_key, api_secret}}`. The caller stores `credentials` and never returns them.
		"""
		return self._request(
			"POST", "login_with_password", v1=True, guest=True, body={"email": email, "password": password}
		)

	def validate_coupon(self, code: str, email: str | None = None, mobile_e164: str | None = None) -> dict:
		"""`{ok, valid, code, message, reward_kind?, reward_value?, reason?}`; never redeems."""
		body: dict[str, Any] = {"code": code}
		if email:
			body["email"] = email
		if mobile_e164:
			body["mobile_no"] = _digits(mobile_e164)
		return self._request("POST", "validate_coupon", v1=True, guest=True, body=body)

	def get_referral_coupon(self) -> dict:
		"""`{ok, customer, redemption_count, coupon{...}}` for the configured tenant."""
		return self._request("POST", "get_my_referral_coupon", v1=True)

	# ------------------------------------------------------------------ billing
	def get_wallet(self) -> dict:
		"""`get_wallet_api` (A-03)."""
		return self._request("POST", "get_wallet_api", v1=True, body={"limit": 20})

	def list_plans(self) -> dict:
		"""`list_plans_api` (A-02)."""
		return self._request("POST", "list_plans_api", v1=True, body={})

	def get_payment_methods(self) -> dict:
		return self._request("POST", "get_payment_methods_api", v1=True, body={})

	def renew_subscription(self) -> dict:
		return self._request("POST", "renew_subscription_api", v1=True, body={})

	def change_plan(self, plan_code: str) -> dict:
		return self._request("POST", "change_plan_api", v1=True, body={"plan_code": plan_code})

	def request_topup(self, amount, payment_option=None, reference_no=None, remarks=None, receipt=None, plan_code=None) -> dict:
		body: dict[str, Any] = {"amount": amount, "payment_option": payment_option, "reference_no": reference_no, "remarks": remarks, "plan_code": plan_code}
		if receipt:
			body.update({"receipt_filename": receipt[0], "receipt_mime": receipt[1], "receipt_base64": receipt[2]})
		return self._request("POST", "request_wallet_topup_api", v1=True, body={k: v for k, v in body.items() if v})

	def start_paypal_topup(self, amount, return_url, plan_code=None) -> dict:
		body = {"amount": amount, "return_url": return_url, "plan_code": plan_code}
		return self._request("POST", "start_paypal_topup_api", v1=True, body={k: v for k, v in body.items() if v})

	def confirm_paypal_topup(self, order_id: str) -> dict:
		return self._request("POST", "confirm_paypal_topup_api", v1=True, body={"order_id": order_id})

	def get_account_statement(self, from_date=None, to_date=None) -> dict:
		body = {"from_date": from_date, "to_date": to_date}
		return self._request("POST", "get_account_statement_api", v1=True, body={k: v for k, v in body.items() if v})

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
	# The platform's Message Log takes its own source vocabulary; ours is finer. Unknown → External API.
	PLATFORM_SOURCE_TYPES: dict[str, str] = {
		"Quick Send": "Manual",
		"Form": "SANAD ERPNext",
		"Campaign": "Campaign",
		"Notification": "SANAD ERPNext",
		"Notification Alert": "Scheduled Message",
		"Command Reply": "External API",
		"Simulator": "Simulator",
		"API": "External API",
		# past messages pulled from the gateway (`services.history_import`); never sent, mapped for completeness
		"History": "Provider Webhook",
	}

	def _message_payload(self, message: NormalizedMessage) -> dict[str, Any]:
		"""`NormalizedMessage` → platform keys (only `_PAYLOAD_KEYS` + `client_ref`, `priority`)."""
		payload: dict[str, Any] = {
			"device": message.platform_device,
			"client_ref": message.client_ref,
			"priority": message.priority,
			"recipient_type": message.recipient_type,
			"message_type": message.message_type,
			"source_type": self.PLATFORM_SOURCE_TYPES.get(message.source.type or "", "External API"),
			"source_site": message.source.site,
			"source_doctype": message.source.doctype,
			"source_docname": message.source.docname,
		}
		if message.recipient_type == "Group":
			payload["group_id"] = message.jid
		else:
			payload["recipient_no"] = _digits(message.phone_e164)
		if message.message_type in ("Buttons", "List"):
			payload["message_body"] = message.body or ""
			payload["interactive"] = message.interactive or {}
		elif message.message_type == "Text":
			payload["message_body"] = message.body or ""
			if message.reply_to:
				payload["reply_to_message_id"] = message.reply_to
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
					# as JSON text, which the platform parses back: it files the payload into its
					# Message Log, whose `poll_options` is a text field — a list there failed every
					# queued poll with "Value for Poll Options cannot be a list" (live test 2026-10-01)
					"poll_options": json.dumps(list(message.poll.options), ensure_ascii=False),
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

	def post_status(self, platform_device: str, payload: dict) -> str:
		data = self._request("POST", "post_status_api", body={"device": platform_device, **payload})
		return str(data.get("status_id") or "")

	def delete_status(self, platform_device: str, status_id: str) -> None:
		self._request("POST", "delete_status_api", body={"device": platform_device, "status_id": status_id})

	def get_status_views(self, platform_device: str, status_ids: list[str]) -> dict[str, dict]:
		data = self._request("POST", "get_status_views_api", body={"device": platform_device, "status_ids": list(status_ids)[:100]})
		views = data.get("views")
		return views if isinstance(views, dict) else {}

	def mark_read(self, platform_device: str, chat_jid: str, message_ids: list[str], sender_jid: str | None = None) -> None:
		self._request("POST", "mark_read_api", body={"device": platform_device, "chat_jid": chat_jid,
			"message_ids": list(message_ids)[:50], "sender_jid": sender_jid or ""})

	def send_presence(self, platform_device: str, chat_jid: str, state: str = "composing") -> None:
		self._request("POST", "send_presence_api", body={"device": platform_device, "chat_jid": chat_jid, "state": state})

	def check_numbers(self, platform_device: str, numbers: list[str]) -> list[NumberCheck]:
		data = self._request("POST", "check_numbers_api", body={"device": platform_device,
			"numbers": [str(n).lstrip("+") for n in numbers]})
		out = []
		for row in data.get("results") or []:
			digits = "".join(ch for ch in str(row.get("phone") or "") if ch.isdigit())
			if digits:
				out.append(NumberCheck(phone_e164="+" + digits, on_whatsapp=bool(row.get("on_whatsapp")),
					jid=row.get("jid"), verified_name=row.get("verified_name")))
		return out

	def get_contact_profiles(
		self, platform_device: str, numbers: list[str], known_pictures: dict[str, str] | None = None
	) -> list[ContactProfile]:
		def digits(n):
			return "".join(ch for ch in str(n or "") if ch.isdigit())

		data = self._request("POST", "get_contact_profiles_api", body={
			"device": platform_device,
			"numbers": [digits(n) for n in numbers],
			"known_pictures": {digits(k): v for k, v in (known_pictures or {}).items() if v},
		})
		out = []
		for row in data.get("profiles") or []:
			if not isinstance(row, dict) or not digits(row.get("phone")):
				continue
			picture = row.get("picture") if isinstance(row.get("picture"), dict) else {}
			out.append(ContactProfile(
				phone_e164="+" + digits(row.get("phone")),
				on_whatsapp=bool(row.get("on_whatsapp")),
				jid=row.get("jid"),
				about=row.get("about") or None,
				verified_name=row.get("verified_name") or None,
				is_business=bool(row.get("is_business")),
				picture_state=picture.get("state"),
				picture_id=picture.get("id"),
				picture_url=picture.get("url"),
				business=row.get("business") if isinstance(row.get("business"), dict) else {},
			))
		return out

	def create_group(
		self, platform_device: str, name: str, participants: list[str], description: str | None = None
	) -> GroupCreated:
		body: dict[str, Any] = {"device": platform_device, "name": name,
			"participants": [str(p).lstrip("+") for p in participants]}
		if description:
			body["description"] = description
		data = self._request("POST", "create_group_api", body=body)
		return GroupCreated(
			jid=str(data.get("group_jid") or ""),
			name=str(data.get("name") or name),
			members=[
				GroupMember(phone=str(m.get("phone") or ""), status=str(m.get("status") or "failed"), jid=m.get("jid"))
				for m in data.get("members") or []
				if isinstance(m, dict)
			],
			invite_link=data.get("invite_link"),
		)

	def list_history(
		self, platform_device: str, *, after: int = 0, limit: int = 200, since: int | None = None, total: bool = False
	) -> HistoryPage:
		params: dict[str, Any] = {"device": platform_device, "after": int(after or 0), "limit": int(limit or 200)}
		if since:
			params["since"] = int(since)
		if total:
			params["total"] = 1
		data = self._request("GET", "get_history_messages_api", params=params)
		messages = []
		for row in data.get("messages") or []:
			if not isinstance(row, dict):
				continue
			kind = str(row.get("kind") or row.get("message_type") or "").strip().lower()
			messages.append(
				HistoryMessage(
					kind=kind,
					from_me=bool(row.get("is_from_me")),
					inbound=_parse_inbound(row, None),
					counterpart_phone=_first(row.get("chat_number")),
					original_id=_first(row.get("original_message_id")),
					raw=row,
				)
			)
		return HistoryPage(
			messages=messages,
			next_after=int(data.get("next_after") or after or 0),
			has_more=bool(data.get("has_more")),
			total=data.get("total"),
		)

	def download_media(self, url: str, max_bytes: int | None = None) -> tuple[bytes, str]:
		# Only from the configured platform: the request carries the integration's credentials.
		base = (self.settings.base_url or "").rstrip("/") + "/"
		if not base.strip("/") or not str(url or "").startswith(base):
			raise pex.ValidationError("Media URL is not on the configured platform", code="MEDIA_URL_FOREIGN")
		headers = {k: v for k, v in self._headers().items() if k != "Content-Type"}
		headers["Accept"] = "*/*"
		limit = max_bytes or MAX_MEDIA_BYTES
		try:
			response = self._session.get(
				url, headers=headers, timeout=max(self.settings.timeout, 60), allow_redirects=False, stream=True
			)
		except requests.RequestException as exc:
			raise pex.TransientError(f"Media download failed: {exc.__class__.__name__}", code="MEDIA_DOWNLOAD") from exc
		with response:
			if response.status_code != 200:
				self._unwrap(response)  # raises the typed error
				raise pex.ProviderError(f"Media download answered {response.status_code}", code="MEDIA_DOWNLOAD")
			# read in chunks and stop past the limit: a huge file must not fill a worker's memory
			if int(response.headers.get("Content-Length") or 0) > limit:
				raise pex.ValidationError(f"Media is larger than {limit} bytes", code="MEDIA_TOO_LARGE")
			chunks, total = [], 0
			for chunk in response.iter_content(chunk_size=1024 * 1024):
				total += len(chunk)
				if total > limit:
					raise pex.ValidationError(f"Media is larger than {limit} bytes", code="MEDIA_TOO_LARGE")
				chunks.append(chunk)
		return b"".join(chunks), response.headers.get("Content-Type", "")

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
					# the name saved in the phone's address book first, then what the person calls
					# themselves; the platform sends each under its own key
					name=_first(
						row.get("full_name"),
						row.get("name"),
						row.get("business_name"),
						row.get("push_name"),
						row.get("first_name"),
					),
				)
			)
		return out

	def list_device_groups(self, platform_device: str) -> list[ProviderGroup]:
		data = self._request("GET", "list_device_groups_api", params={"device": platform_device})
		out = []
		for row in data.get("groups") or []:
			# the platform passes the gateway's own keys through (`JID`, `Name`, `Participants`)
			members = _first(row.get("participants"), row.get("Participants")) or []
			out.append(
				ProviderGroup(
					jid=str(_first(row.get("jid"), row.get("JID"), row.get("id")) or ""),
					name=_first(row.get("name"), row.get("Name"), row.get("subject")),
					participants_count=int(
						row.get("participants_count") or (len(members) if isinstance(members, list) else 0)
					),
				)
			)
		return out

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
			# the site's clock, like every other platform time (`fromtimestamp` alone is the OS's)
			event_ts = _site_time(datetime.fromtimestamp(ts, timezone.utc))
		except (ValueError, OverflowError, OSError):
			# "inf", "1e30", a year past 9999: garbage from the sender, not a server fault
			return SignatureCheck(valid=False, fresh=False, reason="bad timestamp")
		fresh = abs(int(time.time()) - ts) <= max_skew
		expected = self.sign(secret, timestamp, raw_body)
		valid = hmac.compare_digest(expected, signature.strip().lower())
		reason = None if valid and fresh else ("stale" if valid else "signature")
		return SignatureCheck(valid=valid, fresh=fresh, event_timestamp=event_ts, reason=reason)

	def webhook_envelope(self, headers: Mapping[str, str]) -> WebhookEnvelope:
		h = _ci_headers(headers)
		return WebhookEnvelope(
			event_id=h.get(HEADER_EVENT_ID.lower()) or None,
			event_name=h.get(HEADER_EVENT.lower()) or None,
			signed=bool(h.get(HEADER_SIGNATURE.lower())),
		)

	def replay_headers(self, event_name: str, event_id: str | None) -> dict[str, str]:
		return {HEADER_EVENT: event_name or "", HEADER_EVENT_ID: event_id or ""}

	def parse_webhook(self, headers: Mapping[str, str], body: dict) -> WebhookEvent:
		"""Platform payload + headers → `WebhookEvent` (pure). Unknown events keep their name."""
		h = _ci_headers(headers)
		event_name = h.get(HEADER_EVENT.lower()) or str(body.get("event") or "")
		if event_name == "message.status":
			event_name = _status_alias(body)
		event_id = h.get(HEADER_EVENT_ID.lower()) or str(body.get("event_id") or "")
		ts_header = h.get(HEADER_TIMESTAMP.lower())
		# the most exact first: the gateway's own event time and the platform's Unix time are
		# absolute; the signing time is when it was delivered; `occurred_at` has no zone at all
		timestamp = (
			_dt(body.get("timestamp"))
			or _dt(body.get("occurred_at_ts"))
			or _dt(ts_header)
			or _dt(body.get("occurred_at"))
		)
		platform_device = body.get("device") if isinstance(body.get("device"), str) else None
		status = body.get("status")
		reason = body.get("held_reason") or body.get("reason") or body.get("error")

		device = None
		if event_name.startswith("connection.") or platform_device:
			device = DeviceState(
				platform_device=platform_device or "",
				device_name=body.get("device_name"),
				# the gateway sends the linked account as a JID (`9677…:12@s.whatsapp.net`): its digits
				phone_e164=_jid_phone(body.get("phone_number") or body.get("jid")),
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
		"""Register the receiver URL on the link, then create the events endpoint (never passes `secret`).

		Registering the URL makes the platform create the link's endpoint subscribed to the
		`connection.*` events only; that endpoint is reused and given the events asked for."""
		self._request("POST", "configure_integration_webhook_api", body={"endpoint_url": endpoint_url})
		for state in self.list_webhook_endpoints():
			if state.url == endpoint_url and state.status != "Revoked":
				if set(state.events) != set(events):
					return self.update_webhook_endpoint(state.endpoint_id, None, list(events), None)
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


def _jid_phone(value) -> str | None:
	"""E.164 from a number or a WhatsApp JID; None when there are no digits (a LID is not a number)."""
	text = str(value or "")
	if not text or text.endswith("@lid"):
		return None
	digits = "".join(ch for ch in text.split("@", 1)[0].split(":", 1)[0] if ch.isdigit())
	return "+" + digits if digits else None


def _status_from_event(event_name: str) -> str:
	return {
		"connection.connected": "Connected",
		"connection.disconnected": "Disconnected",
		"connection.logged_out": "Logged Out",
	}.get(event_name, "Pending QR")


#: Largest received file fetched from the platform (per call `max_bytes` can lower it).
MAX_MEDIA_BYTES = 100 * 1024 * 1024

_INBOUND_TYPE_MAP = {
	# the gateway's `interactive_reply`, and the platform's own word for it
	"interactivereply": "Interactive Reply",
	"interactive reply": "Interactive Reply",
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
	# a reaction names two messages: its own (`reaction_message_id`) and the one reacted to
	# (`message_id`); its sender is `reacted_by`
	is_reaction = body.get("event") == "message.reaction" or bool(body.get("reaction_message_id"))
	sender_jid = _first(
		body.get("reacted_by") if is_reaction else None,
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
	# a sender WhatsApp names by a privacy id (`…@lid`) carries no number in its jid; the platform
	# sends the resolved number beside it as `sender_number`
	sender_mobile = _first(
		body.get("reacted_by_number") if is_reaction else None,
		body.get("sender_number"),
		body.get("sender_mobile_no"),
		body.get("sender_phone"),
		body.get("mobile_no"),
	)
	# the gateway's file of an image / video / audio / document / sticker: the platform keeps it and
	# sends `media.download_url` (its `get_inbound_media_api`, same credentials as every call)
	media = body.get("media") if isinstance(body.get("media"), dict) else {}
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
		body.get("reaction_message_id") if is_reaction else None,
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
			body.get("reacted_by_name") if is_reaction else None,
			body.get("push_name"),
			body.get("pushName"),
			body.get("sender_name"),
			nested.get("pushName"),
			nested.get("push_name"),
		),
		group_name=_first(body.get("group_name"), body.get("chat_name"), nested.get("group_name")) if is_group else None,
		message_type=message_type,
		body=str(text) if text is not None else None,
		caption=_first(body.get("caption"), media.get("caption"), nested.get("caption")),
		media_url=_first(
			media.get("download_url"), body.get("media_url"), body.get("url"), nested.get("url"), nested.get("media_url")
		),
		media_mime_type=_first(
			media.get("mime_type"),
			body.get("media_mime_type"),
			body.get("mime_type"),
			nested.get("mimetype"),
			nested.get("mime_type"),
		),
		media_file_name=_first(media.get("file_name")),
		location=location,
		reaction=str(reaction) if reaction else None,
		reaction_to=_first(
			body.get("message_id") if is_reaction else None,
			body.get("reaction_to"),
			body.get("reacted_message_id"),
			nested.get("reacted_message_id"),
			body.get("quoted_message_id") if message_type == "Reaction" else None,
		),
		quoted_id=_first(
			body.get("quoted_message_id"),
			body.get("quoted_provider_message_id"),
			body.get("reply_to_message_id"),
			nested.get("quoted_id"),
		),
		selected_id=_first(body.get("selected_id")),
		received_at=_dt(body.get("received_at"))
		or _dt(body.get("timestamp"))
		or _dt(nested.get("timestamp"))
		or timestamp,
	)


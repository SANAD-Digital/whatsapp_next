# Module role: map provider exceptions / platform codes / provider text to the canonical
# `WhatsApp Log.error_code` vocabulary (fields.md RC-05, backend-plan §3 `errors.py`, gap G-4).

from __future__ import annotations

import re
from dataclasses import dataclass

from whatsapp_next.providers import exceptions as pex

ERROR_CODES: tuple[str, ...] = (
	"recipient_not_registered",
	"device_disconnected",
	"timeout",
	"platform_rejected",
	"invalid_template",
	"insufficient_balance",
	"invalid_phone",
	"blacklisted",
	"unknown_number_policy",
	"rate_limited",
	"auth",
	"unknown",
)

RETRYABLE: frozenset[str] = frozenset({"device_disconnected", "timeout", "rate_limited"})


@dataclass(frozen=True)
class ErrorClass:
	"""A normalized error: canonical `code` and whether the dispatcher may retry."""

	code: str
	retryable: bool
	message: str = ""


# Platform A-09 codes → canonical code (backend-plan-platform §D).
_PLATFORM_CODE_MAP: dict[str, str] = {
	"QUOTA_EXCEEDED": "insufficient_balance",
	"SUBSCRIPTION_INACTIVE": "insufficient_balance",
	"SUBSCRIPTION_EXPIRED": "insufficient_balance",
	"DEVICE_NOT_CONNECTED": "device_disconnected",
	"DEVICE_NO_TOKEN": "device_disconnected",
	"DEVICE_NOT_FOUND": "device_disconnected",
	"DEVICE_NOT_OWNED": "device_disconnected",
	"RECIPIENT_REQUIRED": "invalid_phone",
	"INVALID_MESSAGE_TYPE": "platform_rejected",
	"FEATURE_NOT_IN_PLAN": "platform_rejected",
	"CLIENT_REF_DUPLICATE": "platform_rejected",
	"RATE_LIMITED": "rate_limited",
	"AUTH_KEY_MISSING": "auth",
	"AUTH_INVALID_KEY": "auth",
	"AUTH_SECRET_REQUIRED": "auth",
	"AUTH_INVALID_SECRET": "auth",
	"LINK_SUSPENDED": "auth",
	"LINK_REVOKED": "auth",
	"LINK_PENDING": "auth",
	"CUSTOMER_SUSPENDED": "auth",
	"PROVIDER_ERROR": "timeout",
	"INTERNAL_ERROR": "timeout",
}

# Text patterns (lower-cased search) → canonical code; order matters.
_TEXT_PATTERNS: tuple[tuple[re.Pattern[str], str], ...] = (
	(
		re.compile(
			r"not (a )?(registered|valid) (whatsapp )?(user|number)|not on whatsapp|recipient.*not.*registered|jid.*not.*found"
		),
		"recipient_not_registered",
	),
	(
		re.compile(
			r"not connected|not logged in|device.*(offline|disconnected|logged out)|no (device )?token|qr authentication"
		),
		"device_disconnected",
	),
	(
		re.compile(r"time ?out|timed out|connection (error|refused|reset)|temporarily unavailable|gateway"),
		"timeout",
	),
	(
		re.compile(
			r"quota|limit reached|insufficient|balance|exhausted|expired subscription|subscription.*(inactive|expired)"
		),
		"insufficient_balance",
	),
	(re.compile(r"template"), "invalid_template"),
	(re.compile(r"invalid (phone|mobile|recipient|number)|recipient.*required"), "invalid_phone"),
	(re.compile(r"rate limit|too many requests"), "rate_limited"),
	(re.compile(r"api key|api secret|unauthori[sz]ed|forbidden|authentication"), "auth"),
	(re.compile(r"reject|not allowed|feature|plan"), "platform_rejected"),
)


def classify(error: BaseException | str | None, *, provider_code: str | None = None) -> ErrorClass:
	"""Classify a provider exception, a platform code or a free-text reason into an ErrorClass."""
	code = None
	message = ""

	if isinstance(error, BaseException):
		message = str(error)
		provider_code = provider_code or getattr(error, "code", None)
		code = _code_from_exception(error)
	elif error:
		message = str(error)

	if code is None and provider_code:
		code = _PLATFORM_CODE_MAP.get(str(provider_code).upper())
	if code is None and message:
		code = _code_from_text(message)
	if code is None:
		code = "unknown"
	return ErrorClass(code=code, retryable=code in RETRYABLE, message=_strip_pii(message))


def _code_from_exception(error: BaseException) -> str | None:
	if isinstance(error, pex.WebhookSignatureError):
		return "auth"
	if isinstance(error, pex.AuthError | pex.PermissionDeniedError):
		return "auth"
	if isinstance(error, pex.DeviceOfflineError):
		return "device_disconnected"
	if isinstance(error, pex.RateLimitError):
		return "rate_limited"
	if isinstance(error, pex.TransientError):
		return "timeout"
	if isinstance(error, pex.QuotaExceededError):
		return "insufficient_balance"
	if isinstance(error, pex.FeatureNotInPlanError):
		return "platform_rejected"
	if isinstance(error, pex.BusinessRejectedError):
		# Text may say more than the generic rejection (e.g. recipient not registered).
		if error.code and error.code.upper() in _PLATFORM_CODE_MAP:
			return _PLATFORM_CODE_MAP[error.code.upper()]
		text_code = _code_from_text(str(error) + " " + (getattr(error, "reason", "") or ""))
		return text_code or "platform_rejected"
	if isinstance(error, pex.NotSupportedError):
		return "platform_rejected"
	if isinstance(error, pex.ValidationError):
		return _code_from_text(str(error)) or "platform_rejected"
	if isinstance(error, pex.NotFoundError):
		return "platform_rejected"
	if isinstance(error, pex.ProviderError):
		if error.code and error.code.upper() in _PLATFORM_CODE_MAP:
			return _PLATFORM_CODE_MAP[error.code.upper()]
		return None
	if isinstance(error, TimeoutError):
		return "timeout"
	return None


def _code_from_text(text: str) -> str | None:
	lower = (text or "").lower()
	if not lower:
		return None
	for pattern, code in _TEXT_PATTERNS:
		if pattern.search(lower):
			return code
	return None


_PHONE_RE = re.compile(r"\+?\d[\d\s\-]{6,}\d")


def _strip_pii(message: str) -> str:
	"""Mask phone-like digit runs so an error text can be stored (security rule: no PII in logs)."""
	if not message:
		return ""
	return _PHONE_RE.sub("<phone>", message)[:500]

# Module role: typed provider errors (backend-plan §2.2). No `requests` exception ever leaves
# providers/; every method wraps into one of these. `details` never carries bodies or phones.

from __future__ import annotations

from typing import Any


class ProviderError(Exception):
	"""Base provider error."""

	retryable = False

	def __init__(
		self,
		message: str = "",
		*,
		code: str | None = None,
		http_status: int | None = None,
		details: dict[str, Any] | None = None,
	):
		super().__init__(message)
		self.message = message
		self.code = code
		self.http_status = http_status
		self.details = details or {}

	def __str__(self) -> str:  # pragma: no cover - trivial
		return self.message or self.__class__.__name__


class AuthError(ProviderError):
	"""401/403 on auth, invalid key, `AUTH_*` codes."""


class PermissionDeniedError(ProviderError):
	"""403 ownership (device / endpoint not ours)."""


class NotFoundError(ProviderError):
	"""404."""


class ValidationError(ProviderError):
	"""400 / 413 / 417 validation."""


class BusinessRejectedError(ProviderError):
	"""HTTP 200 `ok:false` / `rejected:true` — quota, feature, recipient. Carries `reason`."""

	def __init__(
		self, message: str = "", *, reason: str | None = None, platform_message_log: str | None = None, **kw
	):
		super().__init__(message, **kw)
		self.reason = reason or message
		self.platform_message_log = platform_message_log


class QuotaExceededError(BusinessRejectedError):
	"""`QUOTA_EXCEEDED`, 402."""


class FeatureNotInPlanError(BusinessRejectedError):
	"""`FEATURE_NOT_IN_PLAN`."""


class DeviceOfflineError(ProviderError):
	"""409 device not connected / no token. Retryable once the device reconnects."""

	retryable = True

	def __init__(self, message: str = "", *, device_status: str | None = None, **kw):
		super().__init__(message, **kw)
		self.device_status = device_status


class RateLimitError(ProviderError):
	"""429 / `RATE_LIMITED`; `retry_after` seconds when known."""

	retryable = True

	def __init__(self, message: str = "", *, retry_after: int | None = None, **kw):
		super().__init__(message, **kw)
		self.retry_after = retry_after


class TransientError(ProviderError):
	"""Timeouts, connection errors, 5xx."""

	retryable = True


class NotSupportedError(ProviderError):
	"""Capability absent on this provider (meta_cloud, platform endpoints not yet live)."""


class WebhookSignatureError(ProviderError):
	"""Bad HMAC or stale timestamp."""

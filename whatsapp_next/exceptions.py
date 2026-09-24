# Module role: the app's exception hierarchy = API error codes (backend-plan §4.0). Every class
# carries `http_status_code` so Frappe's request handler emits the right status, and JS maps
# `exc_type` to a user message.

from __future__ import annotations

import frappe


class WANextError(frappe.ValidationError):
	"""Base class for every whatsapp_next error. Default HTTP 417 like frappe.ValidationError."""

	http_status_code = 417
	code = "wa_error"


class WAPermissionError(frappe.PermissionError):
	"""Role or document permission missing (403)."""

	http_status_code = 403
	code = "permission"


class WAValidationError(WANextError):
	"""Bad argument, schema violation or state-guard text (417)."""

	code = "validation"


class WANotFoundError(WANextError):
	"""Record or key unknown (404)."""

	http_status_code = 404
	code = "not_found"


class WAStateConflictError(WANextError):
	"""Action not allowed in the current state (409)."""

	http_status_code = 409
	code = "state_conflict"


class WAInvalidPhoneError(WAValidationError):
	"""`services.phone.normalize` returned None (417)."""

	code = "invalid_phone"


class WABlacklistedError(WAValidationError):
	"""Recipient is in the global or command blacklist (417)."""

	code = "blacklisted"


class WAUnknownNumberPolicyError(WAValidationError):
	"""`send_only_to_known_numbers` blocks the recipient (417)."""

	code = "unknown_number_policy"


class WADeviceOfflineError(WAStateConflictError):
	"""Device not Connected (409)."""

	code = "device_offline"


class WAQueuePausedError(WAStateConflictError):
	"""Action requires a running queue (409)."""

	code = "queue_paused"


class WAProviderAuthError(WANextError):
	"""Credentials rejected by the platform (502)."""

	http_status_code = 502
	code = "provider_auth"


class WAProviderUnavailableError(WANextError):
	"""Transient provider failure (503)."""

	http_status_code = 503
	code = "provider_unavailable"


class WAProviderRejectedError(WANextError):
	"""Business rejection by the provider; `reason` and `provider_code` pass through (422)."""

	http_status_code = 422
	code = "provider_rejected"

	def __init__(self, message: str = "", reason: str | None = None, provider_code: str | None = None):
		super().__init__(message)
		self.reason = reason
		self.provider_code = provider_code


class WARateLimitError(WANextError):
	"""Provider or local rate limit (429)."""

	http_status_code = 429
	code = "rate_limit"


class WAFileError(WAValidationError):
	"""Upload not private, not owned, too large or unparsable (417)."""

	code = "file"


class WANotSupportedError(WANextError):
	"""Capability absent for the active provider (422).

	It used to answer 501, which is the honest status — but Frappe's own `request.js` handles 501
	by parsing the body as JSON and calling the error callback with a second argument it never
	receives, so a 501 raises a JS exception inside Desk before the screen can show its message.
	The envelope still carries `code: "not_supported"`, which is what clients actually branch on.
	"""

	http_status_code = 422
	code = "not_supported"

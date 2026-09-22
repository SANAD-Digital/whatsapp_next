# Module role: the `api_endpoint` decorator every whitelisted function in api/ must use
# (backend-plan §4.0, RC-4). It applies `frappe.whitelist`, checks roles, coerces and validates
# typed arguments from the request, rejects unknown arguments, and converts provider exceptions
# into the app's exception hierarchy (HTTP codes). Version-neutral: v1, v2 … all use it.

from __future__ import annotations

import functools
import inspect
import json
import types
import typing
from collections.abc import Callable, Iterable
from datetime import date, datetime

import frappe
from frappe import _
from frappe.utils import cint, flt, get_datetime, getdate

from whatsapp_next.exceptions import (
	WANotSupportedError,
	WAPermissionError,
	WAProviderAuthError,
	WAProviderRejectedError,
	WAProviderUnavailableError,
	WARateLimitError,
	WAValidationError,
)
from whatsapp_next.providers import exceptions as pex

MAX_PAGE_LENGTH = 200

_TRUE = {"1", "true", "yes", "on", "y"}
_FALSE = {"0", "false", "no", "off", "n", ""}


def api_endpoint(
	*,
	roles: Iterable[str] | None = None,
	methods: Iterable[str] = ("POST",),
	allow_guest: bool = False,
	schema: dict[str, dict] | None = None,
) -> Callable:
	"""Decorate a whitelisted API function.

	- `roles`: any of these roles is required (`frappe.only_for`); Administrator always passes.
	  `None` means the function performs its own document-level `frappe.has_permission` check.
	- `methods`: allowed HTTP methods (default POST only).
	- `allow_guest`: only the webhook receiver may set this (tests enforce it).
	- `schema`: optional per-argument rules `{name: {"enum": [...], "max_length": n, "min": x, "max": y}}`
	  applied after type coercion.
	"""

	def decorator(fn: Callable) -> Callable:
		signature = inspect.signature(fn)
		hints = typing.get_type_hints(fn)
		role_tuple = tuple(roles) if roles else ()

		@functools.wraps(fn)
		def wrapper(*args, **kwargs):
			if role_tuple:
				_require_roles(role_tuple)
			kwargs = coerce_arguments(signature, hints, kwargs, schema)
			try:
				return fn(*args, **kwargs)
			except pex.ProviderError as exc:
				raise map_provider_error(exc) from exc

		wrapper.__wa_api_endpoint__ = True  # type: ignore[attr-defined]
		wrapper.__wa_roles__ = role_tuple  # type: ignore[attr-defined]
		return frappe.whitelist(allow_guest=allow_guest, methods=list(methods))(wrapper)

	return decorator


def _require_roles(roles: tuple[str, ...]) -> None:
	user = frappe.session.user
	if user == "Administrator":
		return
	if not set(roles) & set(frappe.get_roles(user)):
		frappe.throw(_("Not permitted"), WAPermissionError)


def coerce_arguments(
	signature: inspect.Signature,
	hints: dict[str, object],
	kwargs: dict,
	schema: dict[str, dict] | None = None,
) -> dict:
	"""Coerce request values (strings) into the annotated Python types; reject unknown names."""
	params = signature.parameters
	accepts_var_kw = any(p.kind is inspect.Parameter.VAR_KEYWORD for p in params.values())
	out: dict = {}
	for name, value in kwargs.items():
		if name in ("cmd", "_"):
			continue
		if name not in params:
			if accepts_var_kw:
				out[name] = value
				continue
			frappe.throw(_("Unknown argument: {0}").format(name), WAValidationError)
		hint = hints.get(name)
		out[name] = coerce_value(name, value, hint)
	for name, param in params.items():
		if param.kind in (inspect.Parameter.VAR_KEYWORD, inspect.Parameter.VAR_POSITIONAL):
			continue
		if name not in out and param.default is inspect.Parameter.empty:
			frappe.throw(_("Missing argument: {0}").format(name), WAValidationError)
	if schema:
		for name, rules in schema.items():
			if name in out and out[name] is not None:
				_apply_rules(name, out[name], rules)
	if "page_length" in out and out["page_length"] is not None:
		out["page_length"] = max(1, min(cint(out["page_length"]), MAX_PAGE_LENGTH))
	return out


def _unwrap_optional(hint):
	origin = typing.get_origin(hint)
	if origin in (typing.Union, types.UnionType):
		args = [a for a in typing.get_args(hint) if a is not type(None)]
		return args[0] if len(args) == 1 else hint
	return hint


def coerce_value(name: str, value, hint):
	"""Coerce one value according to its type hint (`int`, `bool`, `float`, `list`, `dict`, dates)."""
	if value is None or hint is None or hint is inspect.Parameter.empty:
		return value
	hint = _unwrap_optional(hint)
	origin = typing.get_origin(hint) or hint
	try:
		if hint is bool:
			if isinstance(value, bool):
				return value
			s = str(value).strip().lower()
			if s in _TRUE:
				return True
			if s in _FALSE:
				return False
			raise ValueError
		if hint is int:
			if isinstance(value, bool):
				return int(value)
			if isinstance(value, str) and value.strip() == "":
				return None
			return cint(value) if str(value).strip().lstrip("-").isdigit() else _raise()
		if hint is float:
			return flt(value)
		if hint is str:
			return value if isinstance(value, str) else str(value)
		if origin in (list, tuple, set, dict):
			if isinstance(value, str):
				value = json.loads(value) if value.strip() else ([] if origin is not dict else {})
			if origin is dict and not isinstance(value, dict):
				raise ValueError
			if origin in (list, tuple, set) and not isinstance(value, list | tuple | set):
				raise ValueError
			return origin(value) if origin is not dict else value
		if hint is datetime:
			return get_datetime(value)
		if hint is date:
			return getdate(value)
	except (ValueError, TypeError, json.JSONDecodeError):
		frappe.throw(_("Invalid value for {0}").format(name), WAValidationError)
	return value


def _raise():
	raise ValueError


def _apply_rules(name: str, value, rules: dict) -> None:
	if "enum" in rules and value not in rules["enum"]:
		frappe.throw(_("Invalid value for {0}").format(name), WAValidationError)
	if "max_length" in rules and isinstance(value, str) and len(value) > rules["max_length"]:
		frappe.throw(_("{0} is too long").format(name), WAValidationError)
	if "min" in rules and value is not None and value < rules["min"]:
		frappe.throw(_("{0} must be at least {1}").format(name, rules["min"]), WAValidationError)
	if "max" in rules and value is not None and value > rules["max"]:
		frappe.throw(_("{0} must be at most {1}").format(name, rules["max"]), WAValidationError)


def map_provider_error(exc: pex.ProviderError) -> Exception:
	"""Translate a provider exception into the app exception carrying the right HTTP status."""
	message = str(exc) or exc.__class__.__name__
	if isinstance(exc, pex.RateLimitError):
		return WARateLimitError(message)
	if isinstance(exc, pex.AuthError | pex.PermissionDeniedError | pex.WebhookSignatureError):
		return WAProviderAuthError(message)
	if isinstance(exc, pex.TransientError | pex.DeviceOfflineError):
		return WAProviderUnavailableError(message)
	if isinstance(exc, pex.NotSupportedError):
		return WANotSupportedError(message)
	if isinstance(exc, pex.BusinessRejectedError):
		return WAProviderRejectedError(message, reason=exc.reason, provider_code=exc.code)
	if isinstance(exc, pex.ValidationError | pex.NotFoundError):
		return WAValidationError(message)
	return WAProviderUnavailableError(message)


def paginate(page: int | None, page_length: int | None) -> tuple[int, int]:
	"""Return `(start, page_length)` for list endpoints (1-based `page`, capped page length)."""
	page = max(1, cint(page) or 1)
	length = max(1, min(cint(page_length) or 20, MAX_PAGE_LENGTH))
	return (page - 1) * length, length

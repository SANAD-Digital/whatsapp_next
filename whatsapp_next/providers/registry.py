# Module role: resolve the active provider from the `whatsapp_providers` hook and WhatsApp Settings
# (backend-plan §2.4). The only place credentials are read (`get_password`, fields.md R-06) and the
# only way tests inject a FakeProvider.

from __future__ import annotations

import frappe

from whatsapp_next.providers.base import BaseProvider
from whatsapp_next.providers.exceptions import NotSupportedError
from whatsapp_next.providers.schemas import ProviderSettings

CREDENTIAL_FIELDS: tuple[str, ...] = (
	"customer_api_key",
	"customer_api_secret",
	"api_key",
	"api_secret",
	"webhook_secret",
)
_OVERRIDE_KEY = "wa_provider_override"


def provider_classes() -> dict[str, str]:
	"""Registry key → dotted class path, merged across installed apps."""
	merged: dict[str, str] = {}
	hooks = frappe.get_hooks("whatsapp_providers") or {}
	# Frappe merges dict hooks into {key: [path, ...]} across apps; the last app wins.
	for key, paths in hooks.items():
		merged[key] = paths[-1] if isinstance(paths, list | tuple) else paths
	return merged


def list_providers() -> list[dict[str, str]]:
	"""`[{key, display_name}]` for the Settings Select and the onboarding page."""
	rows = []
	for key, path in provider_classes().items():
		try:
			cls = frappe.get_attr(path)
			rows.append({"key": key, "display_name": getattr(cls, "display_name", key)})
		except Exception:
			rows.append({"key": key, "display_name": key})
	return rows


def get_settings_doc():
	"""Cached WhatsApp Settings document (secrets masked; use `credentials()` for plaintext)."""
	return frappe.get_cached_doc("WhatsApp Settings")


def credentials(settings=None) -> dict[str, str]:
	"""Plaintext credentials (`services.secrets.read`) — never logged, never returned by an API.
	A key this site cannot decrypt (a database from another site) counts as missing."""
	from whatsapp_next.services import secrets

	out: dict[str, str] = {}
	for fieldname in CREDENTIAL_FIELDS:
		value = secrets.read(fieldname)
		if value:
			out[fieldname] = value
	return out


# The product's own platform (owner, 2026-10-19): a site in developer mode talks to the development
# platform, any other site to production — unless Settings names another address.
DEV_PLATFORM_BASE_URL = "https://w-platform.dev.sanad.digital"
PROD_PLATFORM_BASE_URL = "https://whatsappnext.sanad.digital"


def platform_base_url(settings=None) -> str:
	"""Where this product's platform lives: the address chosen in Settings (`platform_base_url`)
	when there is one; left empty, the development platform on a site in Frappe's developer mode
	and the production platform on any other. Nothing of this app is read from the site config
	(owner, 2026-10-19)."""
	settings = settings or frappe.get_cached_doc("WhatsApp Settings")
	url = (settings.get("platform_base_url") or "").strip()
	if not url:
		url = DEV_PLATFORM_BASE_URL if frappe.conf.get("developer_mode") else PROD_PLATFORM_BASE_URL
	return url.rstrip("/")


def build_settings(provider_key: str | None = None) -> ProviderSettings:
	"""Assemble `ProviderSettings` from WhatsApp Settings."""
	settings = frappe.get_doc("WhatsApp Settings")
	key = provider_key or settings.get("provider") or "snd_platform"
	return ProviderSettings(
		provider_key=key,
		base_url=platform_base_url(settings),
		timeout=int(settings.get("request_timeout") or 30),
		credentials=credentials(settings),
	)


def get_provider(key: str | None = None) -> BaseProvider:
	"""Return the provider instance for `key` (default: Settings.provider), cached per request."""
	override = getattr(frappe.local, _OVERRIDE_KEY, None)
	if override is not None:
		return override
	settings = build_settings(key)
	cache = _request_cache()
	if settings.provider_key in cache:
		return cache[settings.provider_key]
	path = provider_classes().get(settings.provider_key)
	if not path:
		raise NotSupportedError(
			f"Unknown WhatsApp provider: {settings.provider_key}", code="PROVIDER_UNKNOWN"
		)
	cls = frappe.get_attr(path)
	instance = cls(settings)
	cache[settings.provider_key] = instance
	return instance


def _request_cache() -> dict:
	cache = getattr(frappe.local, "wa_provider_cache", None)
	if cache is None:
		cache = {}
		frappe.local.wa_provider_cache = cache
	return cache


def clear_cache() -> None:
	"""Drop the per-request provider instances (Settings controller calls this on save)."""
	frappe.local.wa_provider_cache = {}


def override_for_tests(instance: BaseProvider) -> None:
	"""Tests inject a FakeProvider; production code paths never call this."""
	setattr(frappe.local, _OVERRIDE_KEY, instance)


def clear_override() -> None:
	"""Remove a test override."""
	if hasattr(frappe.local, _OVERRIDE_KEY):
		delattr(frappe.local, _OVERRIDE_KEY)

# Module role: whitelisted endpoints of the Onboarding Wizard (backend-plan §4.1 `api.onboarding`,
# screen 1). Sign-up / password reset pass through the provider; credentials are written with
# `set_password` and never returned; `complete_setup` flags the site once every step is done.
# Thin wrappers over `services.onboarding`.

from __future__ import annotations

from typing import Any

import frappe

from whatsapp_next.api._common import api_endpoint
from whatsapp_next.api.v1._roles import CONTACT_USER, SYSTEM_MANAGER, VIEWER_UP
from whatsapp_next.services import onboarding


@api_endpoint(roles=VIEWER_UP + CONTACT_USER, methods=("GET", "POST"))
def get_status() -> dict[str, Any]:
	"""`{setup_completed, steps[{key, done, detail}], redirect_enabled}` for any WhatsApp role."""
	return onboarding.status()


@api_endpoint(roles=SYSTEM_MANAGER, schema={"channel": {"enum": ["whatsapp", "sms", "email"]}})
def start_signup(
	plan_code: str, mobile: str, full_name: str, email: str, channel: str = "whatsapp"
) -> dict[str, Any]:
	"""Begin a tenant sign-up on the platform → `{request_key, status, code_ttl}`."""
	state = onboarding.start_signup(plan_code, mobile, full_name, email, channel)
	return {
		"request_key": state.request_key,
		"status": state.status,
		"code_ttl": state.extra.get("code_ttl") if state.extra else None,
		"message": state.message,
	}


@api_endpoint(roles=SYSTEM_MANAGER, methods=("GET", "POST"))
def get_signup_status(request_key: str) -> dict[str, Any]:
	"""Poll a sign-up request → `{status}`."""
	state = onboarding.get_signup_status(request_key)
	return {"status": state.status, "message": state.message}


@api_endpoint(roles=SYSTEM_MANAGER)
def complete_signup(request_key: str, code: str) -> dict[str, Any]:
	"""Finish the sign-up with the verification code; credentials are stored, never returned."""
	return onboarding.complete_signup(request_key, code, user=frappe.session.user)


@api_endpoint(roles=SYSTEM_MANAGER)
def start_password_reset(identifier: str) -> dict[str, Any]:
	"""Begin a password reset for a platform user → `{ok}`."""
	state = onboarding.start_password_reset(identifier)
	return {"ok": True, "status": state.status, "message": state.message}


@api_endpoint(roles=SYSTEM_MANAGER)
def save_credentials(
	platform_base_url: str | None = None,
	customer_api_key: str | None = None,
	api_key: str | None = None,
	api_secret: str | None = None,
) -> dict[str, Any]:
	"""Store the platform URL and credentials (`set_password`); audited `Credentials Changed`."""
	written = onboarding.save_credentials(
		platform_base_url=platform_base_url,
		customer_api_key=customer_api_key,
		api_key=api_key,
		api_secret=api_secret,
		user=frappe.session.user,
	)
	return {"ok": True, "fields_written": written}


@api_endpoint(roles=SYSTEM_MANAGER)
def complete_setup() -> dict[str, Any]:
	"""Flag `setup_completed` (requires connection OK, ≥ 1 Connected device, webhook Active)."""
	return {"setup_completed": onboarding.complete_setup(user=frappe.session.user)}

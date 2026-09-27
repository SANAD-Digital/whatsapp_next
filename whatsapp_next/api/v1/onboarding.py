# Module role: whitelisted endpoints of the Onboarding Wizard (backend-plan §4.1 `api.onboarding`,
# screen 1). Sign-up / sign-in / password reset / coupons pass through the provider; credentials
# are written with `set_password` and never returned; `complete_setup` flags the site once every
# step is done. Thin wrappers over `services.onboarding`.

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


@api_endpoint(roles=SYSTEM_MANAGER, methods=("GET", "POST"))
def get_signup_bootstrap() -> dict[str, Any]:
	"""What the sign-up form needs up front → `{plans[], code_ttl_minutes, device_phone,
	device_ready}`. Countries come from `api.v1.phone.get_countries`, not from here."""
	return onboarding.signup_bootstrap()


@api_endpoint(roles=SYSTEM_MANAGER, schema={"channel": {"enum": ["whatsapp", "sms", "email"]}})
def start_signup(
	plan_code: str,
	mobile: str,
	full_name: str,
	email: str,
	channel: str = "whatsapp",
	coupon_code: str | None = None,
) -> dict[str, Any]:
	"""Begin a tenant sign-up on the platform → `{request_key, status, code_ttl, coupon}`.

	`coupon_code` is optional; the platform validates it here and applies it to the
	subscription the sign-up creates."""
	state = onboarding.start_signup(plan_code, mobile, full_name, email, channel, coupon_code=coupon_code)
	extra = state.extra or {}
	return {
		"request_key": state.request_key,
		"status": state.status,
		"code_ttl": extra.get("code_ttl") or extra.get("code_ttl_minutes"),
		"coupon": extra.get("coupon"),
		"message": state.message,
	}


@api_endpoint(roles=SYSTEM_MANAGER, methods=("GET", "POST"))
def get_signup_status(request_key: str) -> dict[str, Any]:
	"""Poll a sign-up request → `{status}`."""
	state = onboarding.get_signup_status(request_key)
	return {"status": state.status, "message": state.message}


@api_endpoint(roles=SYSTEM_MANAGER)
def verify_code(request_key: str, code: str, purpose: str | None = None) -> dict[str, Any]:
	"""Check a verification code without finishing the sign-up → `{ok, status}`."""
	state = onboarding.verify_code(request_key, code, purpose=purpose)
	return {"ok": state.status in ("Verified", "Completed"), "status": state.status}


@api_endpoint(roles=SYSTEM_MANAGER)
def complete_signup(
	request_key: str, code: str | None = None, password: str | None = None
) -> dict[str, Any]:
	"""Finish the sign-up → `{ok, status, credentials_stored}`.

	`code` verifies the request when it has not been verified yet and `password` sets the
	tenant's platform password. Credentials are stored with `set_password`, never returned."""
	return onboarding.complete_signup(request_key, code, password=password, user=frappe.session.user)


@api_endpoint(roles=SYSTEM_MANAGER)
def login(platform_base_url: str, email: str, password: str) -> dict[str, Any]:
	"""Sign in to the platform and store what it returns → `{ok, customer, customer_name}`.

	The API keys the platform hands back are written with `set_password`; none of them is
	ever part of this answer."""
	return onboarding.login(platform_base_url, email, password, user=frappe.session.user)


@api_endpoint(roles=SYSTEM_MANAGER)
def start_password_reset(identifier: str) -> dict[str, Any]:
	"""Begin a password reset for a platform user → `{ok, status, request_key}`."""
	state = onboarding.start_password_reset(identifier)
	return {"ok": True, "status": state.status, "request_key": state.request_key, "message": state.message}


@api_endpoint(roles=SYSTEM_MANAGER, methods=("GET", "POST"))
def get_password_reset_status(request_key: str) -> dict[str, Any]:
	"""Poll a password-reset request → `{status}`."""
	state = onboarding.get_password_reset_status(request_key)
	return {"status": state.status, "message": state.message}


@api_endpoint(roles=SYSTEM_MANAGER)
def complete_password_reset(request_key: str, password: str) -> dict[str, Any]:
	"""Set the new password of a verified reset request → `{ok, status}`."""
	state = onboarding.complete_password_reset(request_key, password)
	return {"ok": state.status == "Completed", "status": state.status}


@api_endpoint(roles=SYSTEM_MANAGER, methods=("GET", "POST"))
def validate_coupon(code: str, email: str | None = None, mobile: str | None = None) -> dict[str, Any]:
	"""Is a coupon usable and what does it give → `{ok, valid, code, message, reward_value?,
	reason?}`. An unusable coupon is a normal answer, not an error."""
	return onboarding.validate_coupon(code, email=email, mobile=mobile)


@api_endpoint(roles=VIEWER_UP, methods=("GET", "POST"))
def get_referral_coupon() -> dict[str, Any]:
	"""This tenant's own referral coupon → `{ok, customer, redemption_count, coupon{code, ...}}`."""
	return onboarding.referral_coupon()


@api_endpoint(roles=SYSTEM_MANAGER)
def save_credentials(
	platform_base_url: str | None = None,
	customer_api_key: str | None = None,
	api_key: str | None = None,
	api_secret: str | None = None,
	customer_api_secret: str | None = None,
) -> dict[str, Any]:
	"""Store the platform URL and credentials (`set_password`); audited `Credentials Changed`."""
	written = onboarding.save_credentials(
		platform_base_url=platform_base_url,
		customer_api_key=customer_api_key,
		customer_api_secret=customer_api_secret,
		api_key=api_key,
		api_secret=api_secret,
		user=frappe.session.user,
	)
	return {"ok": True, "fields_written": written}


@api_endpoint(roles=SYSTEM_MANAGER)
def complete_setup() -> dict[str, Any]:
	"""Flag `setup_completed` (requires connection OK, ≥ 1 Connected device, webhook Active)."""
	return {"setup_completed": onboarding.complete_setup(user=frappe.session.user)}

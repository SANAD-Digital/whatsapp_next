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
	mobile: str,
	full_name: str,
	email: str | None = None,
	channel: str = "whatsapp",
	coupon_code: str | None = None,
	plan_code: str | None = None,
	company_name: str | None = None,
	business_activity: str | None = None,
) -> dict[str, Any]:
	"""Begin a tenant sign-up on the platform → `{request_key, status, code_ttl, coupon}`.

	`email` is optional: without one the platform gives the account a placeholder address and
	it signs in by mobile number or username. `coupon_code` is optional; the platform validates it here and applies it to the
	subscription the sign-up creates. `plan_code` is the plan the free trial renews to; left
	out (or not one the platform offers) it is the platform's first plan."""
	state = onboarding.start_signup(
		plan_code, mobile, full_name, email, channel, coupon_code=coupon_code,
		company={"name": company_name, "activity": business_activity},
	)
	extra = state.extra or {}
	return {
		"request_key": state.request_key,
		"status": state.status,
		"code_ttl": extra.get("code_ttl") or extra.get("code_ttl_minutes"),
		"coupon": extra.get("coupon"),
		"message": state.message,
		**onboarding.verification_route(extra),
	}


@api_endpoint(roles=SYSTEM_MANAGER, methods=("GET", "POST"))
def get_signup_status(request_key: str) -> dict[str, Any]:
	"""Poll a sign-up request → `{status, expires_in}`: `expires_in` is the seconds left on the code (or,
	once Verified, on finishing with a password), counted on the platform."""
	state = onboarding.get_signup_status(request_key)
	extra = state.extra or {}
	return {"status": state.status, "message": state.message, "expires_in": extra.get("expires_in")}


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
	`email` takes any sign-in the account has: the email, the mobile number or the username.

	The API keys the platform hands back are written with `set_password`; none of them is
	ever part of this answer."""
	return onboarding.login(platform_base_url, email, password, user=frappe.session.user)


@api_endpoint(roles=SYSTEM_MANAGER)
def start_password_reset(identifier: str) -> dict[str, Any]:
	"""Begin a password reset for a platform user → `{ok, status, request_key}`."""
	state = onboarding.start_password_reset(identifier)
	extra = state.extra or {}
	return {
		"ok": True,
		"status": state.status,
		"request_key": state.request_key,
		"message": state.message,
		# how the person proves it is them, as for sign-up: `whatsapp` (the code is shown, and
		# sent FROM the account's number to `platform_phone`) or `email` (typed here)
		**onboarding.verification_route(extra),
		"mobile_hint": extra.get("mobile_hint"),
	}


@api_endpoint(roles=SYSTEM_MANAGER)
def finish_password_reset(request_key: str, password: str, code: str | None = None) -> dict[str, Any]:
	"""Verify the reset (`code` from the email; a WhatsApp reset was confirmed by the reply), set
	the new password and sign this site in with it → the `login` answer `{ok, customer, ...}`."""
	return onboarding.finish_password_reset(request_key, password, code=code, user=frappe.session.user)


@api_endpoint(roles=SYSTEM_MANAGER, methods=("GET", "POST"))
def get_password_reset_status(request_key: str) -> dict[str, Any]:
	"""Poll a password-reset request → `{status}`."""
	state = onboarding.get_password_reset_status(request_key)
	return {"status": state.status, "message": state.message}


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
def sign_out() -> dict[str, Any]:
	"""Unlink the site from its platform account → `{ok, webhook_removed}`. The keys and the
	webhook secret are deleted; devices and messages stay. Audited `Credentials Changed`."""
	return onboarding.sign_out(user=frappe.session.user)


@api_endpoint(roles=SYSTEM_MANAGER, methods=("GET", "POST"))
def get_account_switch() -> dict[str, Any]:
	"""What the previous platform account left after the site was linked to another one →
	`{pending, from, to, at, counts{doctype: n}}` (services.backup; nothing is deleted on a switch)."""
	from whatsapp_next.services import backup

	return backup.pending_switch()


@api_endpoint(roles=SYSTEM_MANAGER, schema={"action": {"enum": ["delete", "keep"]}})
def resolve_account_switch(action: str) -> dict[str, Any]:
	"""A System Manager's decision on what the previous account left: `delete` queues the
	deletion (background, audited `Account Data Deleted`) → `{queued, counts}`; `keep` keeps it
	and stops asking → `{kept}`."""
	from whatsapp_next.services import backup

	if action == "delete":
		return backup.delete_previous_account(user=frappe.session.user)
	backup.keep_previous_account(user=frappe.session.user)
	return {"kept": True}


@api_endpoint(roles=SYSTEM_MANAGER)
def complete_setup() -> dict[str, Any]:
	"""Flag `setup_completed` (requires connection OK, ≥ 1 Connected device, webhook Active)."""
	return {"setup_completed": onboarding.complete_setup(user=frappe.session.user)}

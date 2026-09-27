# Module role: setup state of the product (backend-plan §4.1 `api.onboarding` / `settings.test_connection`,
# 02-doctypes-gap G-01). Connection test (writes `connection_status*`, never raises on provider
# failure), credential storage through `set_password` (audited `Credentials Changed`, never
# returned), provider sign-up / password-reset pass-through, the onboarding step list and the
# `setup_completed` flag. No HTTP outside the provider.

from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Any

import frappe
from frappe import _
from frappe.utils import cint, now_datetime
from frappe.utils.password import set_encrypted_password

from whatsapp_next.exceptions import WAInvalidPhoneError, WAStateConflictError, WAValidationError
from whatsapp_next.providers import exceptions as pex
from whatsapp_next.providers import registry
from whatsapp_next.providers.schemas import SignupState
from whatsapp_next.services import audit, usage_sync, webhook_setup
from whatsapp_next.services.phone import normalize

CREDENTIAL_FIELDS: tuple[str, ...] = ("customer_api_key", "api_key", "api_secret")
STEP_KEYS: tuple[str, ...] = ("credentials", "connection", "device", "webhook")


@dataclass(frozen=True)
class Step:
	key: str
	done: bool
	detail: str | None = None


def _settings():
	return frappe.get_doc("WhatsApp Settings")


def has_secret(settings, fieldname: str) -> bool:
	"""`True` when the Password field holds a value (read through `get_password`, never returned)."""
	try:
		return bool(settings.get_password(fieldname, raise_exception=False))
	except Exception:
		return False


def has_credentials(settings=None) -> bool:
	"""All three platform credentials plus the base URL are present."""
	s = settings or _settings()
	return bool(s.platform_base_url) and all(has_secret(s, f) for f in CREDENTIAL_FIELDS)


def test_connection(user: str | None = None) -> dict[str, Any]:
	"""`health_check` → `connection_status*` fields, audit `Connection Tested`, then refresh the
	subscription cache on success. Never raises on provider failure (the result carries `error`)."""
	started = time.monotonic()
	try:
		health = registry.get_provider().health_check()
		ok, error, plan_code = bool(health.ok), health.error, health.plan_code
		latency = health.latency_ms
	except pex.ProviderError as exc:
		ok, error, plan_code, latency = False, (str(exc) or exc.__class__.__name__), None, None
	except Exception as exc:  # a broken provider must not break the Settings page
		ok, error, plan_code, latency = False, exc.__class__.__name__, None, None
	if latency is None:
		latency = int((time.monotonic() - started) * 1000)
	frappe.db.set_single_value(
		"WhatsApp Settings",
		{
			"connection_status": "OK" if ok else "Failed",
			"last_connection_test_at": now_datetime(),
			"last_connection_latency_ms": cint(latency),
			"last_connection_error": (error or "")[:500] or None,
		},
		update_modified=False,
	)
	frappe.clear_document_cache("WhatsApp Settings", "WhatsApp Settings")
	audit.log("Connection Tested", user=user, details={"what": "provider", "ok": ok, "latency_ms": latency})
	if ok:
		usage_sync.sync_subscription()
	return {"ok": ok, "latency_ms": cint(latency), "plan_code": plan_code, "error": error}


def save_credentials(
	*,
	platform_base_url: str | None = None,
	customer_api_key: str | None = None,
	api_key: str | None = None,
	api_secret: str | None = None,
	user: str | None = None,
) -> list[str]:
	"""Store the platform credentials with `set_password` (values never logged or returned) and
	the base URL (validated by the Settings controller). Returns the fieldnames written."""
	doc = _settings()
	written: list[str] = []
	if platform_base_url is not None:
		doc.platform_base_url = platform_base_url
		written.append("platform_base_url")
	for fieldname, value in (
		("customer_api_key", customer_api_key),
		("api_key", api_key),
		("api_secret", api_secret),
	):
		if value:
			doc.set(fieldname, value)  # Document._save_passwords → set_encrypted_password
			written.append(fieldname)
	if not written:
		frappe.throw(_("Nothing to save"), WAValidationError)
	doc.credentials_updated_at = now_datetime()
	doc.flags.ignore_permissions = True
	doc.save(ignore_permissions=True)
	frappe.clear_document_cache("WhatsApp Settings", "WhatsApp Settings")
	registry.clear_cache()
	audit.log("Credentials Changed", user=user, fields_written=written, details={"what": "platform"})
	return written


def store_signup_credentials(state: SignupState, user: str | None = None) -> bool:
	"""Write the credentials a completed sign-up returned (once) into Settings; `False` when the
	provider returned none (platform G-7: manual entry fallback)."""
	creds = state.credentials or {}
	values = {f: creds.get(f) for f in CREDENTIAL_FIELDS if creds.get(f)}
	if not values:
		return False
	for fieldname, value in values.items():
		set_encrypted_password("WhatsApp Settings", "WhatsApp Settings", value, fieldname)
	frappe.db.set_single_value(
		"WhatsApp Settings",
		"credentials_updated_at",
		now_datetime(),
		update_modified=False,
	)
	frappe.clear_document_cache("WhatsApp Settings", "WhatsApp Settings")
	registry.clear_cache()
	audit.log("Credentials Changed", user=user, fields_written=list(values), details={"what": "signup"})
	return True


def signup_bootstrap() -> dict[str, Any]:
	"""What the sign-up form needs before anything is typed: the plans it may choose.

	`{plans, code_ttl_minutes, device_phone, device_ready}`. Prices and limits
	are the platform's to state, so they come from the provider untouched.

	Countries are deliberately not here: `api.v1.phone.get_countries` already
	serves the calling regions from the same libphonenumber metadata the server
	validates numbers with, and a second list built from the `Country` DocType
	would be a second answer to the same question.
	"""
	data = registry.get_provider().get_signup_bootstrap() or {}
	return {
		"plans": data.get("plans") or [],
		"code_ttl_minutes": cint(data.get("code_ttl_minutes")) or None,
		"device_phone": data.get("device_phone"),
		"device_ready": bool(data.get("device_ready")),
	}


def start_signup(
	plan_code: str,
	mobile: str,
	full_name: str,
	email: str,
	channel: str,
	coupon_code: str | None = None,
) -> SignupState:
	"""Begin a tenant sign-up through the provider (`mobile` normalised to E.164 first).

	A `coupon_code` is validated by the platform at this moment, so a bad code
	is refused while the user is still on the form."""
	e164 = normalize(mobile)
	if not e164:
		frappe.throw(_("Invalid phone number: {0}").format(mobile), WAInvalidPhoneError)
	return registry.get_provider().start_signup(
		plan_code, e164, full_name, email, channel, coupon_code=coupon_code
	)


def get_signup_status(request_key: str) -> SignupState:
	"""Poll a sign-up request."""
	return registry.get_provider().get_signup_status(request_key)


def verify_code(request_key: str, code: str, purpose: str | None = None) -> SignupState:
	"""Check a verification code without finishing the sign-up."""
	return registry.get_provider().verify_signup_code(request_key, code, purpose=purpose)


def complete_signup(
	request_key: str, code: str | None = None, password: str | None = None, user: str | None = None
) -> dict[str, Any]:
	"""Finish the sign-up; credentials (if returned) are stored, never returned.

	`code` verifies the request (skipped when it was verified already) and
	`password` sets the tenant's portal password, which is what makes the
	account real on the platform."""
	state = registry.get_provider().complete_signup(request_key, code or "", password=password)
	stored = store_signup_credentials(state, user=user)
	out = {"ok": state.status == "Completed", "status": state.status, "credentials_stored": stored}
	if stored:
		out.update(link_site(user=user))
	return out


def start_password_reset(identifier: str) -> SignupState:
	"""Begin a password reset for a tenant user."""
	return registry.get_provider().start_password_reset(identifier)


def get_password_reset_status(request_key: str) -> SignupState:
	"""Poll a password-reset request."""
	return registry.get_provider().get_password_reset_status(request_key)


def complete_password_reset(request_key: str, password: str) -> SignupState:
	"""Set the new password of a verified password-reset request."""
	return registry.get_provider().complete_password_reset(request_key, password)


def login(platform_base_url: str, email: str, password: str, user: str | None = None) -> dict[str, Any]:
	"""Sign in against the platform and store the credentials it hands back.

	`platform_base_url` is optional and the sign-in card does not ask for it:
	the address of this product's platform is not something a tenant knows.
	When it is given it is saved first (an operator pointing a site at staging);
	when it is not, `registry.platform_base_url` answers from Settings or from
	the bench's own `whatsapp_platform_base_url`, so a site that has never saved
	Settings can still sign in. What comes back is written with `set_password`
	exactly the way `save_credentials` writes it; only
	`{ok, customer, customer_name}` goes to the caller - a key never reaches the
	browser.
	"""
	# Only write the URL when it actually changes: a sign-in is not a reason to
	# take a write lock on the Settings single, and a repeat sign-in never does.
	wanted = (platform_base_url or "").strip().rstrip("/")
	if wanted and wanted != (frappe.db.get_single_value("WhatsApp Settings", "platform_base_url") or ""):
		save_credentials(platform_base_url=platform_base_url, user=user)
	if not registry.platform_base_url():
		frappe.throw(
			_("This site does not know where the WhatsApp platform is. Set it in WhatsApp Settings, or set `whatsapp_platform_base_url` in the site config."),
			WAValidationError,
		)
	result = registry.get_provider().login(email, password) or {}
	returned = result.get("credentials") or {}
	values = {f: returned.get(f) for f in CREDENTIAL_FIELDS if returned.get(f)}
	if not values:
		frappe.throw(_("The platform returned no credentials for this account"), WAValidationError)
	written = save_credentials(user=user, **values)
	return {
		"ok": True,
		"customer": result.get("customer"),
		"customer_name": result.get("customer_name"),
		"credentials_stored": bool(written),
		**link_site(user=user),
	}


def link_site(user: str | None = None) -> dict[str, Any]:
	"""Everything that follows once the platform handed this site its keys (sign-in or sign-up):
	test the connection, register this site's webhook endpoint (which stores its signing secret),
	and bring the account's existing devices in. Each step is reported, none raises, so a
	half-linked site still signs in and the Settings page offers the step that failed.

	`{connection{ok, error}, webhook{ok, status, error}, devices{ok, adopted, error}}`."""
	# The address is a default (D-103): a linked site keeps the bench's platform address in
	# Settings, so the credentials step reads complete and an operator sees where it points.
	if not frappe.db.get_single_value("WhatsApp Settings", "platform_base_url"):
		frappe.db.set_single_value(
			"WhatsApp Settings", "platform_base_url", registry.platform_base_url(), update_modified=False
		)
		frappe.clear_document_cache("WhatsApp Settings", "WhatsApp Settings")
		registry.clear_cache()
	connection = test_connection(user=user)
	out: dict[str, Any] = {"connection": {"ok": connection["ok"], "error": connection.get("error")}}
	if not connection["ok"]:
		return out
	try:
		endpoint = webhook_setup.ensure_endpoint(user=user, refresh_secret=True)
		out["webhook"] = {"ok": endpoint.status == "Active", "status": endpoint.status}
	except Exception as exc:
		frappe.log_error(title="WhatsApp onboarding: webhook registration failed")
		out["webhook"] = {"ok": False, "status": None, "error": _step_error(exc)}
	from whatsapp_next.services import devices

	try:
		counts = devices.adopt_from_provider(user=user)
		out["devices"] = {"ok": True, "adopted": counts["adopted"]}
	except Exception as exc:
		frappe.log_error(title="WhatsApp onboarding: device import failed")
		out["devices"] = {"ok": False, "adopted": 0, "error": _step_error(exc)}
	return out


def _step_error(exc: Exception) -> str:
	return (str(exc) if isinstance(exc, (pex.ProviderError, frappe.ValidationError)) else "") or exc.__class__.__name__


def validate_coupon(code: str, email: str | None = None, mobile: str | None = None) -> dict[str, Any]:
	"""Ask the platform whether a coupon is usable; an unusable one is an answer, not an error."""
	e164 = normalize(mobile) if mobile else None
	return registry.get_provider().validate_coupon(code, email=email, mobile_e164=e164)


def referral_coupon() -> dict[str, Any]:
	"""This tenant's own referral coupon, for the "share and get a free month" card."""
	return registry.get_provider().get_referral_coupon()


def steps(settings=None) -> list[Step]:
	"""The four onboarding steps with their current state (no provider call)."""
	s = settings or _settings()
	connected = frappe.db.count("WhatsApp Device", {"status": "Connected"})
	return [
		Step(
			"credentials",
			has_credentials(s),
			None if has_credentials(s) else _("Platform URL and API credentials are required"),
		),
		Step("connection", s.connection_status == "OK", s.last_connection_error or s.connection_status),
		Step("device", connected > 0, _("{0} connected device(s)").format(connected)),
		Step("webhook", s.webhook_status == "Active", s.webhook_status or _("Not registered")),
	]


def status() -> dict[str, Any]:
	"""`{setup_completed, setup_completed_at, steps[{key, done, detail}], redirect_enabled}`."""
	s = _settings()
	return {
		"setup_completed": bool(cint(s.setup_completed)),
		"setup_completed_at": s.setup_completed_at,
		"steps": [step.__dict__ for step in steps(s)],
		"redirect_enabled": bool(cint(s.redirect_unregistered_to_wizard)),
		"webhook_url": webhook_setup.receiver_url(),
	}


def complete_setup(user: str | None = None) -> bool:
	"""Flag `setup_completed` once every step is done; otherwise `WAStateConflictError` naming
	the first missing step."""
	s = _settings()
	missing = [step for step in steps(s) if not step.done]
	if missing:
		frappe.throw(
			_("Setup step {0} is not complete: {1}").format(missing[0].key, missing[0].detail or ""),
			WAStateConflictError,
		)
	if not cint(s.setup_completed):
		frappe.db.set_value(
			"WhatsApp Settings",
			"WhatsApp Settings",
			{"setup_completed": 1, "setup_completed_at": now_datetime()},
			update_modified=False,
		)
		frappe.clear_document_cache("WhatsApp Settings", "WhatsApp Settings")
		audit.log("Settings Changed", user=user, fields_written=["setup_completed"])
	return True

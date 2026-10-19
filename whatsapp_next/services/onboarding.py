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

from whatsapp_next.exceptions import WAInvalidPhoneError, WAStateConflictError, WAValidationError
from whatsapp_next.providers import exceptions as pex
from whatsapp_next.providers import registry
from whatsapp_next.providers.schemas import SignupState
from whatsapp_next.services import audit, backup, usage_sync, webhook_setup
from whatsapp_next.services import settings as settings_service
from whatsapp_next.services.phone import normalize

# What sign-in / sign-up hand back and Settings stores; the first three are required to call the
# platform at all, `customer_api_secret` whenever the link requires the secret header (D-129).
CREDENTIAL_FIELDS: tuple[str, ...] = ("customer_api_key", "customer_api_secret", "api_key", "api_secret")
REQUIRED_CREDENTIALS: tuple[str, ...] = ("customer_api_key", "api_key", "api_secret")
STEP_KEYS: tuple[str, ...] = ("credentials", "connection", "device", "webhook")


@dataclass(frozen=True)
class Step:
	key: str
	done: bool
	detail: str | None = None


def _settings():
	return frappe.get_doc("WhatsApp Settings")


def has_secret(settings, fieldname: str) -> bool:
	"""`True` when the Password field holds a value this site can open (`services.secrets.read`;
	the value is never returned). `settings` is accepted for the callers that pass it."""
	from whatsapp_next.services import secrets

	return bool(secrets.read(fieldname))


def has_credentials(settings=None) -> bool:
	"""All three platform credentials are present and the site knows its platform address — the
	effective one (the site's mode decides it, `registry.platform_base_url`): the
	address is a default, never copied into Settings (D-117)."""
	s = settings or _settings()
	return bool(registry.platform_base_url(s)) and all(has_secret(s, f) for f in REQUIRED_CREDENTIALS)


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
	customer_api_secret: str | None = None,
) -> list[str]:
	"""Store the platform credentials with `set_password` (values never logged or returned).
	Returns the fieldnames written. `platform_base_url` is accepted from older callers and ignored:
	the site's mode decides the address (`registry.platform_base_url`)."""
	doc = _settings()
	written: list[str] = []
	for fieldname, value in (
		("customer_api_key", customer_api_key),
		("customer_api_secret", customer_api_secret),
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


# What a sign-out empties besides the keys: the state that described the link to the account. The
# connection test, the webhook endpoint and the plan cache all spoke for the account the site left.
SIGN_OUT_SECRETS: tuple[str, ...] = (*CREDENTIAL_FIELDS, "webhook_secret")
SIGN_OUT_RESET: dict[str, Any] = {
	"connection_status": "Untested",
	"last_connection_test_at": None,
	"last_connection_latency_ms": None,
	"last_connection_error": None,
	"webhook_endpoint": None,
	"webhook_endpoint_url": None,
	"webhook_status": None,
	"webhook_synced_at": None,
	"setup_completed": 0,
	"setup_completed_at": None,
	**{f: None for f in usage_sync.FIELDS},
}


def sign_out(user: str | None = None) -> dict[str, Any]:
	"""Unlink this site from its platform account: the webhook endpoint is removed on the platform
	(best effort — a platform that cannot be reached never keeps the site signed in), then the four
	keys and the webhook secret are deleted and the link's state is reset, so the site reads as
	never registered and the wizard opens on sign-in. Devices, messages, the queue and everything
	the site set up stay: signing out deletes keys, not data. Audited `Credentials Changed`.

	`{ok, webhook_removed}`."""
	from frappe.utils.password import remove_encrypted_password

	s = _settings()
	webhook_removed = False
	if s.webhook_endpoint and has_credentials(s):
		try:
			registry.get_provider().delete_webhook_endpoint(s.webhook_endpoint)
			webhook_removed = True
		except Exception:
			frappe.log_error(title="WhatsApp sign-out: webhook endpoint not removed")
	for fieldname in SIGN_OUT_SECRETS:
		remove_encrypted_password("WhatsApp Settings", "WhatsApp Settings", fieldname)
	meta = frappe.get_meta("WhatsApp Settings")
	values = {f: v for f, v in SIGN_OUT_RESET.items() if meta.has_field(f)}
	# the masked placeholder `store_secret` leaves in the field would read as "a key is stored"
	values.update({f: None for f in SIGN_OUT_SECRETS})
	values["credentials_updated_at"] = now_datetime()
	frappe.db.set_single_value("WhatsApp Settings", values, update_modified=False)
	frappe.clear_document_cache("WhatsApp Settings", "WhatsApp Settings")
	registry.clear_cache()
	audit.log(
		"Credentials Changed",
		user=user,
		fields_written=list(SIGN_OUT_SECRETS),
		details={"what": "sign_out", "webhook_removed": int(webhook_removed)},
	)
	return {"ok": True, "webhook_removed": webhook_removed}


def store_signup_credentials(state: SignupState, user: str | None = None) -> bool:
	"""Write the credentials a completed sign-up returned (once) into Settings; `False` when the
	provider returned none (platform G-7: manual entry fallback)."""
	creds = state.credentials or {}
	values = {f: creds.get(f) for f in CREDENTIAL_FIELDS if creds.get(f)}
	if not values:
		return False
	for fieldname, value in values.items():
		settings_service.store_secret(fieldname, value)
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
		"prefill": signup_prefill(),
	}


# ERPNext's company domain → the sign-up form's activity (its English label, translated on the screen)
DOMAIN_SECTORS = {
	"Manufacturing": "Factories and manufacturing",
	"Retail": "Trade and retail",
	"Distribution": "Trade and retail",
	"Education": "Education and training",
	"Healthcare": "Health and clinics",
	"Agriculture": "Agriculture and nurseries",
	"Non Profit": "Associations and non-profits",
}


def signup_prefill(user: str | None = None) -> dict[str, str]:
	"""What the system already knows for the sign-up form (owner, 2026-10-19): the company's name,
	activity and country from the person's default company (ERPNext, when installed); the person's
	name and email from their user; the WhatsApp number from the company's contact. Only what is
	there; the form fills only the fields still empty, so anything typed wins. The `Administrator`
	account names no real person."""
	user = user or frappe.session.user
	out: dict[str, str] = {}
	company = None
	if frappe.db.exists("DocType", "Company"):
		name = frappe.defaults.get_user_default("Company", user) or frappe.defaults.get_global_default("company")
		if name and frappe.db.exists("Company", name):
			company = frappe.db.get_value("Company", name, ["name", "company_name", "domain", "country"], as_dict=True)
	if company:
		out["org"] = (company.company_name or "").strip()
		out["sector"] = DOMAIN_SECTORS.get(company.domain or "", "")
		# the country the mobile field starts on, as its ISO code (the field's first list has no names)
		out["country"] = (frappe.db.get_value("Country", company.country, "code") or "").upper() if company.country else ""
		out["phone"] = company_contact_mobile(company.name, out["country"] or None) or ""
	if user not in ("Administrator", "Guest"):
		person = frappe.db.get_value("User", user, ["full_name", "email"], as_dict=True) or {}
		out["person"] = (person.get("full_name") or "").strip()
		out["email"] = (person.get("email") or "").strip()
	return {k: v for k, v in out.items() if v}


def company_contact_mobile(company: str, region: str | None = None) -> str | None:
	"""The first valid number (E.164) of the contacts linked to `company`: the primary contact
	first, its primary mobile first, then its other numbers."""
	contacts = frappe.get_all(
		"Dynamic Link",
		filters={"parenttype": "Contact", "link_doctype": "Company", "link_name": company},
		pluck="parent",
	)
	if not contacts:
		return None
	for contact in frappe.get_all(
		"Contact",
		filters={"name": ("in", contacts)},
		fields=["name", "mobile_no", "phone"],
		order_by="is_primary_contact desc, modified desc",
	):
		rows = frappe.get_all(
			"Contact Phone",
			filters={"parenttype": "Contact", "parent": contact.name},
			fields=["phone"],
			order_by="is_primary_mobile_no desc, is_primary_phone desc, idx asc",
		)
		for raw in [contact.mobile_no] + [r.phone for r in rows] + [contact.phone]:
			e164 = normalize(raw, region) if raw else None
			if e164:
				return e164
	return None


def start_signup(
	plan_code: str | None,
	mobile: str,
	full_name: str,
	email: str | None,
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
		signup_plan_code(plan_code), e164, full_name, email, channel, coupon_code=coupon_code
	)


def verification_route(extra: dict[str, Any]) -> dict[str, Any]:
	"""How the platform proves the number, which it — not the form — decides:

	- `whatsapp`: nothing is sent to the user. The platform hands back a code and its own number;
	  the user sends the code **from the registered number** to that number, and the sender is
	  the proof. The code is only useful from that number, so showing it on the page is the flow.
	- `email`: the platform's signup device is not connected and it fell back to e-mail. A sign-up
	  gets a link there (`link_sent`), opened on any device while this page waits; otherwise the
	  code went to the masked address and is typed in here.

	`{channel, code?, platform_phone?, email?, link_sent?}`."""
	channel = str(extra.get("verification_channel") or "").strip().lower()
	if channel == "email" or (not channel and (extra.get("code_sent") or extra.get("link_sent"))):
		return {"channel": "email", "email": extra.get("email"), "link_sent": bool(extra.get("link_sent"))}
	if extra.get("code") and extra.get("device_phone"):
		phone = str(extra["device_phone"]).strip()
		return {
			"channel": "whatsapp",
			"code": str(extra["code"]),
			"platform_phone": phone if phone.startswith("+") else f"+{phone}",
		}
	return {"channel": channel or None}


def signup_plan_code(requested: str | None) -> str:
	"""The plan code to send with a sign-up.

	Every new account starts on the platform's free trial whatever is sent; the code names the
	plan the subscription renews to after it, and the platform refuses the trial's own code
	there ("The selected plan is not available"). The bootstrap lists exactly the codes it
	accepts, cheapest first, so a code not on that list — the page's old "free" default, or
	"free_trial" — becomes the first one."""
	plans = signup_bootstrap().get("plans") or []
	codes = [p.get("plan_code") or p.get("code") for p in plans]
	codes = [c for c in codes if c]
	if requested in codes:
		return requested
	if not codes:
		frappe.throw(_("The platform offers no plan to sign up on. Try again later."), WAValidationError)
	return codes[0]


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
	previous = backup.account_key()
	stored = store_signup_credentials(state, user=user)
	out = {"ok": state.status == "Completed", "status": state.status, "credentials_stored": stored}
	if stored:
		out["account_switched"] = _left_account(previous, user=user)
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


PASSWORD_RESET_PURPOSE = "Password Reset"


def finish_password_reset(
	request_key: str, password: str, code: str | None = None, user: str | None = None
) -> dict[str, Any]:
	"""The whole end of a password recovery, the way subscription platforms do it: verify the
	code (an email reset; a WhatsApp reset is verified by the user's reply), set the new
	password, then sign this site in with it so the person lands on a linked account instead of
	a second form. Returns what `login` returns."""
	if len(password or "") < 8:
		frappe.throw(_("The password must be at least 8 characters."), WAValidationError)
	provider = registry.get_provider()
	if code:
		provider.verify_signup_code(request_key, code.strip(), purpose=PASSWORD_RESET_PURPOSE)
	else:
		status = provider.get_password_reset_status(request_key).status
		if status not in ("Verified", "Completed"):
			frappe.throw(_("The code has not been confirmed yet."), WAValidationError)
	state = provider.complete_password_reset(request_key, password)
	email = (state.extra or {}).get("email")
	if not email:
		frappe.throw(_("The password was changed. Sign in with it."), WAValidationError)
	return login("", email, password, user=user)


def login(platform_base_url: str, email: str, password: str, user: str | None = None) -> dict[str, Any]:
	"""Sign in against the platform and store the credentials it hands back.

	`platform_base_url` is accepted from older callers and ignored: the address of
	this product's platform is not something a tenant knows, the site's mode decides
	it (`registry.platform_base_url`), so a site that has never saved Settings can
	still sign in. What comes back is written with `set_password`
	exactly the way `save_credentials` writes it; only
	`{ok, customer, customer_name}` goes to the caller - a key never reaches the
	browser.
	"""
	try:
		result = registry.get_provider().login(email, password) or {}
	except (pex.AuthError, pex.PermissionDeniedError):
		# A wrong email or password is the person's answer to fix in the card, not a server
		# fault: as an error it went out as HTTP 502, which Frappe's client reports without a
		# body, so the card could only say "Something went wrong".
		return {"ok": False, "message": _("The sign-in details or the password are not right.")}
	if result.get("verification_required"):
		# an account created but never confirmed (owner, 2026-10-20): the platform opened a new
		# confirmation for it, and the screen goes to that step instead of "wrong password"
		signup = result.get("signup") or {}
		return {
			"ok": False,
			"verification_required": True,
			"request_key": signup.get("token"),
			"message": _("This account was created but its number was never confirmed. Confirm it now to finish creating it."),
			**verification_route(signup),
		}
	returned = result.get("credentials") or {}
	values = {f: returned.get(f) for f in CREDENTIAL_FIELDS if returned.get(f)}
	if not values:
		frappe.throw(_("The platform returned no credentials for this account"), WAValidationError)
	previous = backup.account_key()
	written = save_credentials(user=user, **values)
	switched = _left_account(previous, user=user)
	return {
		"ok": True,
		"customer": result.get("customer"),
		"customer_name": result.get("customer_name"),
		"credentials_stored": bool(written),
		"account_switched": switched,
		**link_site(user=user),
	}


def _left_account(previous: str | None, user: str | None = None) -> bool:
	"""After new keys are stored: when they belong to another account than `previous`, that
	account's devices, messages, queue and numbers are deleted (owner, 2026-10-10) — before
	`link_site` brings the new account's devices in. Signing in again to the same account
	changes nothing."""
	current = backup.account_key()
	if not previous or not current or previous == current:
		return False
	backup.purge_account_data(user=user)
	return True


def link_site(user: str | None = None) -> dict[str, Any]:
	"""Everything that follows once the platform handed this site its keys (sign-in or sign-up):
	test the connection, register this site's webhook endpoint (which stores its signing secret),
	and bring the account's existing devices in. Each step is reported, none raises, so a
	half-linked site still signs in and the Settings page offers the step that failed.

	`{connection{ok, error}, webhook{ok, status, error}, devices{ok, adopted, error}}`."""
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
	return (
		str(exc) if isinstance(exc, (pex.ProviderError, frappe.ValidationError)) else ""
	) or exc.__class__.__name__


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
	linked = has_credentials(s)
	return [
		Step(
			"credentials",
			linked,
			None
			if linked
			else _("This site is not linked to a WhatsApp account yet. Create a free account or sign in."),
		),
		# a connection test passed with keys that are gone since says nothing about now
		Step(
			"connection",
			linked and s.connection_status == "OK",
			_connection_detail(s) if linked else _("No account linked"),
		),
		Step("device", connected > 0, _("{0} connected device(s)").format(connected)),
		Step("webhook", s.webhook_status == "Active", _(s.webhook_status) if s.webhook_status else _("Not registered")),
	]


def _connection_detail(s) -> str:
	"""The step's note, in the user's language. The provider's own error (`last_connection_error`,
	English, e.g. "invalid key") stays on Settings under "Last error", where it is read as a detail."""
	if s.connection_status == "OK":
		return _("Connected")
	if s.connection_status == "Failed":
		return _("The last connection test failed. Open Settings to see why and test it again.")
	return _("The connection has not been tested yet.")


def status() -> dict[str, Any]:
	"""`{setup_completed, setup_completed_at, steps[{key, done, detail}], redirect_enabled}`."""
	s = _settings()
	return {
		"setup_completed": bool(cint(s.setup_completed)),
		"setup_completed_at": s.setup_completed_at,
		"steps": [step.__dict__ for step in steps(s)],
		"redirect_enabled": bool(cint(s.redirect_unregistered_to_wizard)),
		"needs_setup": needs_setup(s),
		"can_setup": can_setup(),
		"webhook_url": webhook_setup.receiver_url(),
	}


# who can finish the setup: the wizard's sign-in, sign-up and sign-out are the System Manager's
# (`api/v1/onboarding.py`); anyone else is told to ask them
SETUP_ROLES = ("System Manager",)


def needs_setup(settings=None) -> bool:
	"""The product is not usable yet (owner, 2026-10-19): the redirect is on and the site is not
	signed in to its platform (no credentials — never registered, or signed out since), or the
	wizard was never finished (`setup_completed`)."""
	s = settings or _settings()
	return bool(cint(s.redirect_unregistered_to_wizard)) and (not has_credentials(s) or not cint(s.setup_completed))


def can_setup(user: str | None = None) -> bool:
	"""Whether `user` may run the wizard (a System Manager)."""
	user = user or frappe.session.user
	return user != "Guest" and bool(set(SETUP_ROLES) & set(frappe.get_roles(user)))


def should_redirect_to_wizard(user: str | None = None) -> bool:
	"""`True` when any screen or document of the product sends `user` back to the setup: every
	signed-in Desk user while the product needs setup (`needs_setup`). Whoever cannot run the wizard
	is told so instead (the client reads `can_setup`)."""
	user = user or frappe.session.user
	if user == "Guest":
		return False
	return needs_setup()


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

# Module role: shared helpers for the whatsapp_next test suite (frappe.tests style; no pytest
# plugin). Creates role-scoped test users, minimal documents and provider overrides. Every helper
# is idempotent so tests can call it freely.

from __future__ import annotations

import contextlib
import inspect
import unittest
from collections.abc import Iterator

import frappe

ROLE_USERS: dict[str, str] = {
	"System Manager": "wa-test-sm@example.com",
	"WhatsApp Manager": "wa-test-mgr@example.com",
	"WhatsApp Agent": "wa-test-agt@example.com",
	"WhatsApp Viewer": "wa-test-vwr@example.com",
	"WhatsApp Contact User": "wa-test-cu@example.com",
	"_none": "wa-test-none@example.com",
}


def job_kwargs(call) -> dict:
	"""The keyword arguments a mocked `frappe.enqueue` call hands to the job itself: everything
	`frappe.enqueue` does not take as its own parameter (`event`, `queue`, `job_id`, ...)."""
	from frappe.utils.background_jobs import enqueue

	own = {n for n, p in inspect.signature(enqueue).parameters.items() if p.kind is not p.VAR_KEYWORD}
	return {k: v for k, v in call.kwargs.items() if k not in own}


def ensure_test_user(role: str) -> str:
	"""Return the e-mail of an enabled System User holding exactly `role` (or no product role)."""
	email = ROLE_USERS[role]
	if not frappe.db.exists("User", email):
		user = frappe.get_doc(
			{
				"doctype": "User",
				"email": email,
				"first_name": f"WA Test {role}",
				"user_type": "System User",
				"enabled": 1,
				"send_welcome_email": 0,
			}
		)
		user.flags.ignore_permissions = True
		user.flags.no_welcome_mail = True
		user.insert(ignore_permissions=True)
	user = frappe.get_doc("User", email)
	wanted = {role} if role != "_none" else set()
	current = {r.role for r in user.roles}
	if current != wanted:
		user.set("roles", [])
		for r in sorted(wanted):
			user.append("roles", {"role": r})
		user.save(ignore_permissions=True)
	frappe.clear_cache(user=email)
	return email


@contextlib.contextmanager
def as_user(role: str) -> Iterator[str]:
	"""Run the block as the test user of `role`; restores the previous session user."""
	email = ensure_test_user(role)
	previous = frappe.session.user
	frappe.set_user(email)
	try:
		yield email
	finally:
		frappe.set_user(previous)


def ensure_country(name: str = "Saudi Arabia", code: str = "sa") -> str:
	"""Ensure a Country row exists (fresh test sites may lack geo data)."""
	if not frappe.db.exists("Country", name):
		frappe.get_doc({"doctype": "Country", "country_name": name, "code": code}).insert(
			ignore_permissions=True
		)
	return name


# Settings values a test module changed, as they were before it: put back when the module ends,
# so a suite run leaves the site's configuration as it found it (R-041).
_SETTINGS_BEFORE: dict[str, object] = {}
_RESTORE_REGISTERED: list[bool] = []
_SETTINGS_AT_START: dict[str, object] = {}


def _restore_settings() -> None:
	_RESTORE_REGISTERED.clear()
	if not _SETTINGS_BEFORE:
		return
	settings = frappe.get_single("WhatsApp Settings")
	meta = settings.meta
	for key, value in _SETTINGS_BEFORE.items():
		df = meta.get_field(key)
		# A link whose target a test deleted (its own device, group…) goes back empty: a dangling
		# link would make every later save of Settings fail link validation.
		if value and df and df.fieldtype == "Link" and not frappe.db.exists(df.options, value):
			value = None
		settings.set(key, value)
	_SETTINGS_BEFORE.clear()
	settings.flags.ignore_permissions = True
	settings.flags.ignore_validate = True  # the originals were valid when the module started
	settings.save(ignore_permissions=True)
	frappe.db.commit()


def ensure_settings(**values) -> "frappe.model.document.Document":
	"""Return WhatsApp Settings with `default_country` set and any overrides applied. Every field
	changed here is restored when the test module finishes."""
	settings = frappe.get_single("WhatsApp Settings")
	changed = False
	if not _RESTORE_REGISTERED:
		unittest.addModuleCleanup(_restore_settings)
		_RESTORE_REGISTERED.append(True)
		# the values the module found: a field changed later goes back to these, not to whatever an
		# earlier test of the module had left (it put a deleted test device back, so the site's
		# own default device came back empty)
		_SETTINGS_AT_START.clear()
		_SETTINGS_AT_START.update(settings.as_dict(no_default_fields=True))
	# Tests assume Saudi Arabia as the default region regardless of the site's System Settings.
	country = ensure_country()
	if settings.default_country != country:
		settings.default_country = country
		changed = True
	for key, value in values.items():
		if settings.get(key) != value:
			_SETTINGS_BEFORE.setdefault(key, _SETTINGS_AT_START.get(key, settings.get(key)))
			settings.set(key, value)
			changed = True
	if changed:
		settings.flags.ignore_permissions = True
		settings.save(ignore_permissions=True)
	from whatsapp_next.services.phone import clear_region_cache

	clear_region_cache()
	return settings


_DEVICE_CLEANUP_REGISTERED: list[bool] = []

# What sits on a device and goes with it; configuration that only points at one loses the link.
_DEVICE_ROWS = (
	"WhatsApp Queue Item",
	"WhatsApp Log",
	"WhatsApp Inbound Message",
	"WhatsApp Webhook Event",
	"WhatsApp Campaign",
)
_DEVICE_LINKS = (
	("WhatsApp Number", "last_device"),
	("WhatsApp Number", "synced_device"),
	("WhatsApp Notification", "device"),
	("WhatsApp Notification Alert", "device"),
)


def _drop_test_devices() -> None:
	"""Module cleanup: the fixture devices this suite made, and what sits on them, leave the site.
	They used to stay behind after every run and fill the Devices screen with "Test Device" and
	"Campaign Device" beside the real one (owner, 2026-09-30). Only rows on a test-prefixed
	device are touched (R-041)."""
	_DEVICE_CLEANUP_REGISTERED.clear()
	devices = test_devices()
	if not devices:
		return
	for doctype in _DEVICE_ROWS:
		delete_all(doctype, {"device": ("in", devices)})
	for doctype, fieldname in _DEVICE_LINKS:
		for name in frappe.get_all(doctype, {fieldname: ("in", devices)}, pluck="name"):
			frappe.db.set_value(doctype, name, fieldname, None, update_modified=False)
	for settings_field in ("default_device", "reply_device"):
		if frappe.db.get_single_value("WhatsApp Settings", settings_field) in devices:
			frappe.db.set_single_value("WhatsApp Settings", settings_field, None)
	for name in devices:
		frappe.delete_doc("WhatsApp Device", name, ignore_permissions=True, force=True, ignore_missing=True)
	frappe.db.commit()


def ensure_device(
	device_name: str = "Test Device",
	platform_device: str = "WAD-TEST-0001",
	status: str = "Connected",
	phone: str = "+966500000001",
) -> str:
	"""Insert (once) a WhatsApp Device row bypassing the platform; returns its name. The platform
	id must carry a test prefix, so clean-ups can tell fixture rows from site data (R-041); the
	device and what sits on it are removed when the test module finishes."""
	assert platform_device.startswith(TEST_DEVICE_PREFIXES), (
		f"test device id must start with {TEST_DEVICE_PREFIXES}"
	)
	if not _DEVICE_CLEANUP_REGISTERED:
		unittest.addModuleCleanup(_drop_test_devices)
		_DEVICE_CLEANUP_REGISTERED.append(True)
	name = frappe.db.get_value("WhatsApp Device", {"platform_device": platform_device}, "name")
	if name:
		if frappe.db.get_value("WhatsApp Device", name, "status") != status:
			from whatsapp_next.services.guards import status_writer

			with status_writer():
				frappe.db.set_value("WhatsApp Device", name, "status", status)
		return name
	from whatsapp_next.services.guards import status_writer

	with status_writer():
		doc = frappe.get_doc(
			{
				"doctype": "WhatsApp Device",
				"device_name": device_name,
				"platform_device": platform_device,
				"phone": phone,
				"status": status,
			}
		)
		doc.flags.ignore_permissions = True
		doc.insert(ignore_permissions=True)
	return doc.name


def ensure_contact(first_name: str = "WA Test Contact", phone: str = "+966500000002") -> str:
	"""Insert (once) a Contact with one phone row; returns its name."""
	existing = frappe.db.get_value("Contact", {"first_name": first_name}, "name")
	if existing:
		return existing
	doc = frappe.get_doc(
		{
			"doctype": "Contact",
			"first_name": first_name,
			"phone_nos": [{"phone": phone, "is_primary_mobile_no": 1}],
		}
	)
	doc.insert(ignore_permissions=True)
	return doc.name


# Test fixture devices carry one of these platform ids; seeds and real devices never do (R-041).
TEST_DEVICE_PREFIXES: tuple[str, ...] = ("WAD-TEST-", "WAD-APITEST-")


def test_devices() -> list[str]:
	"""Local names of the test fixture devices."""
	names: list[str] = []
	for prefix in TEST_DEVICE_PREFIXES:
		names += frappe.get_all("WhatsApp Device", {"platform_device": ("like", f"{prefix}%")}, pluck="name")
	return names


def delete_test_rows(doctype: str, filters: dict | None = None) -> None:
	"""Delete `doctype` rows (matching `filters`) that sit on a test fixture device — never the
	site's own data (R-041: whole-table clean-ups emptied a dev site's queue, inbound and
	webhook events). Leftovers of an earlier run are caught too, since the scope is the device,
	not the time the row was made."""
	devices = test_devices()
	if devices:
		delete_all(doctype, {**(filters or {}), "device": ("in", devices)})


def delete_all(doctype: str, filters: dict | None = None) -> None:
	"""Delete rows of `doctype` (test cleanup) ignoring links and permissions."""
	for name in frappe.get_all(doctype, filters=filters or {}, pluck="name"):
		frappe.delete_doc(doctype, name, ignore_permissions=True, force=True, ignore_missing=True)


@contextlib.contextmanager
def fake_provider(instance=None) -> Iterator[object]:
	"""Inject a FakeProvider through the registry for the duration of the block."""
	from whatsapp_next.providers import registry
	from whatsapp_next.tests.fake_provider import FakeProvider

	provider = instance or FakeProvider()
	registry.override_for_tests(provider)
	try:
		yield provider
	finally:
		registry.clear_override()

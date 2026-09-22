# Module role: shared helpers for the whatsapp_next test suite (frappe.tests style; no pytest
# plugin). Creates role-scoped test users, minimal documents and provider overrides. Every helper
# is idempotent so tests can call it freely.

from __future__ import annotations

import contextlib
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


def ensure_settings(**values) -> "frappe.model.document.Document":
	"""Return WhatsApp Settings with `default_country` set and any overrides applied."""
	settings = frappe.get_single("WhatsApp Settings")
	changed = False
	# Tests assume Saudi Arabia as the default region regardless of the site's System Settings.
	country = ensure_country()
	if settings.default_country != country:
		settings.default_country = country
		changed = True
	for key, value in values.items():
		if settings.get(key) != value:
			settings.set(key, value)
			changed = True
	if changed:
		settings.flags.ignore_permissions = True
		settings.save(ignore_permissions=True)
	from whatsapp_next.services.phone import clear_region_cache

	clear_region_cache()
	return settings


def ensure_device(
	device_name: str = "Test Device",
	platform_device: str = "WAD-TEST-0001",
	status: str = "Connected",
	phone: str = "+966500000001",
) -> str:
	"""Insert (once) a WhatsApp Device row bypassing the platform; returns its name."""
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

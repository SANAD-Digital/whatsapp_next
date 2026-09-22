# Module role: install / migrate hooks — idempotent seeding of roles, the disabled command service
# user (D-012, D-029 02-OQ-4), Settings defaults, and composite indexes (fields.md F-11).

from __future__ import annotations

import frappe
from frappe import _

PRODUCT_ROLES: tuple[str, ...] = (
	"WhatsApp Manager",
	"WhatsApp Agent",
	"WhatsApp Viewer",
	"WhatsApp Contact User",
)

COMMAND_SERVICE_USER_LOCALPART = "wa-commands"


def after_install() -> None:
	"""Seed roles, the disabled command service user and Settings defaults; build indexes."""
	ensure_roles()
	ensure_command_service_user()
	ensure_settings_defaults()
	add_indexes()


def after_migrate() -> None:
	"""Re-assert idempotent pieces on every migrate (indexes, roles, service user)."""
	ensure_roles()
	ensure_command_service_user()
	ensure_settings_defaults()
	add_indexes()


def ensure_roles() -> None:
	"""Create the four product roles when missing (fixtures sync runs after `after_install`)."""
	for role in PRODUCT_ROLES:
		if frappe.db.exists("Role", role):
			continue
		frappe.get_doc(
			{
				"doctype": "Role",
				"role_name": role,
				"desk_access": 1,
				"is_custom": 0,
			}
		).insert(ignore_permissions=True)


def command_service_user_email() -> str:
	"""Return the deterministic e-mail of the command service user for this site."""
	site = frappe.local.site or "localhost"
	return f"{COMMAND_SERVICE_USER_LOCALPART}@{site}"


def ensure_command_service_user() -> str:
	"""Seed a *disabled* service user with no roles; the site admin enables and grants roles later.

	D-012: command handlers run as this user, never as Administrator. Returns the user name.
	"""
	email = command_service_user_email()
	if frappe.db.exists("User", email):
		return email
	user = frappe.get_doc(
		{
			"doctype": "User",
			"email": email,
			"first_name": _("WhatsApp Commands"),
			"user_type": "System User",
			"enabled": 0,
			"send_welcome_email": 0,
		}
	)
	user.flags.ignore_permissions = True
	user.flags.no_welcome_mail = True
	user.insert(ignore_permissions=True)
	# Strip any auto-assigned roles: the admin grants exactly what installed functions need.
	frappe.db.delete("Has Role", {"parent": email, "parenttype": "User"})
	return email


def ensure_settings_defaults() -> None:
	"""Fill Settings fields that need a value beyond JSON defaults (default_country, service user)."""
	if not frappe.db.exists("DocType", "WhatsApp Settings"):
		return
	settings = frappe.get_single("WhatsApp Settings")
	changed = False
	if not settings.get("default_country"):
		country = frappe.db.get_single_value("System Settings", "country")
		if country and frappe.db.exists("Country", country):
			settings.default_country = country
			changed = True
	if not settings.get("command_service_user"):
		email = command_service_user_email()
		if frappe.db.exists("User", email):
			settings.command_service_user = email
			changed = True
	if changed:
		settings.flags.ignore_permissions = True
		settings.flags.ignore_validate = True
		settings.save(ignore_permissions=True)


def add_indexes() -> None:
	"""Create the composite indexes that DocType JSON cannot express (idempotent)."""
	from whatsapp_next.patches.v0_1.add_indexes import execute

	execute()

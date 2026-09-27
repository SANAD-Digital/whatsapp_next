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
	warn_contact_open_to_all()
	ensure_desktop_icons()


def has_app_permission() -> bool:
	"""The desktop tile is for people who can use the product: a WhatsApp role or System Manager."""
	if frappe.session.user == "Administrator":
		return True
	roles = set(frappe.get_roles())
	return bool(roles & {*PRODUCT_ROLES, "System Manager"})


def ensure_desktop_icons() -> None:
	"""The app's desktop tile (from `add_to_apps_screen`) and the WhatsApp workspace's tile inside
	it. Frappe creates both only at install time, so a site that installed the app before the hook
	existed gets them here. Idempotent; an icon the admin already has is left alone."""
	if not frappe.db.table_exists("Desktop Icon"):
		return
	try:
		from frappe.desk.doctype.desktop_icon.desktop_icon import get_app_desktop_icon

		app_icon = get_app_desktop_icon("whatsapp_next")
		details = (frappe.get_hooks("add_to_apps_screen", app_name="whatsapp_next") or [None])[0]
		title = frappe.get_hooks("app_title", app_name="whatsapp_next")[0]
		# only this app's tile — Frappe's own install-time pass over every app is not ours to rerun
		if not app_icon and details and not frappe.db.exists("Desktop Icon", title):
			icon = frappe.new_doc("Desktop Icon")
			icon.update(
				{
					"label": title,
					"icon_type": "App",
					"link_type": "External",
					"app": "whatsapp_next",
					"link": details["route"],
					"logo_url": details["logo"],
				}
			)
			icon.insert(ignore_permissions=True, ignore_if_duplicate=True)
			app_icon = icon.name
		for ws in frappe.get_all(
			"Workspace", filters={"app": "whatsapp_next", "public": 1}, fields=["name", "icon"]
		):
			if frappe.db.exists("Desktop Icon", ws.name):
				continue
			icon = frappe.new_doc("Desktop Icon")
			icon.update(
				{
					"label": ws.name,
					"icon_type": "Link",
					"link_type": "Workspace Sidebar",
					"link_to": ws.name,
					"icon": ws.icon,
					"app_name": "whatsapp_next",
					"parent_icon": app_icon,
				}
			)
			icon.insert(ignore_permissions=True, ignore_if_duplicate=True)
	except Exception:
		frappe.log_error(title="WhatsApp Next: desktop icon creation failed")


def after_migrate() -> None:
	"""Re-assert idempotent pieces on every migrate (indexes, roles, service user)."""
	ensure_roles()
	ensure_command_service_user()
	ensure_settings_defaults()
	add_indexes()
	warn_contact_open_to_all()
	ensure_desktop_icons()


def warn_contact_open_to_all() -> None:
	"""R-028 / D-125: say so, never fix it. Removing role All from `Contact` is the site admin's
	step in the Role Permission Manager; the app does not change core permissions."""
	from whatsapp_next.services.permissions import contact_open_to_all

	try:
		rights = contact_open_to_all()
	except Exception:
		return
	if rights:
		print(
			f"whatsapp_next: role All still has {', '.join(rights)} on Contact, so a WhatsApp Contact "
			"User can open Contacts directly. Remove those rights for All in the Role Permission "
			"Manager (/app/permission-manager/Contact)."
		)


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

# Module role: the install / migrate / uninstall hooks — only what Frappe has no folder or handler
# of its own for. Everything else an install needs is a file Frappe syncs by itself:
#
#   DocTypes, Pages, Workspace ............ `whatsapp_next/whatsapp_next/{doctype,page,workspace}/`
#   roles .................................. named in the DocTypes' permissions (Frappe creates a
#                                            role when it syncs a DocType that names it) and
#                                            `fixtures/role.json`
#   composite indexes ...................... `on_doctype_update()` in each DocType's controller
#   the desktop tile ....................... `whatsapp_next/desktop_icon/whatsapp.json`
#   the sidebar ............................ `whatsapp_next/workspace_sidebar/whatsapp.json`
#   number cards, dashboard charts ......... `whatsapp_next/whatsapp_next/{number_card,dashboard_chart}/`
#   the custom field on Contact Phone ...... `whatsapp_next/whatsapp_next/custom/contact_phone.json`
#   standard templates / notifications ..... `fixtures/standard_*.json`
#
# What is left needs code because it depends on the site: the command service user is named after
# the site (D-012), and the Contact warning reads the site's own permissions (D-125).

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
	"""Once, when the app is installed: the disabled command service user, named in Settings."""
	email = ensure_command_service_user()
	if not frappe.db.get_single_value("WhatsApp Settings", "command_service_user"):
		frappe.db.set_single_value("WhatsApp Settings", "command_service_user", email)
	warn_contact_open_to_all()


def after_migrate() -> None:
	"""Every migrate: nothing is created or re-asserted — only the Contact warning is printed."""
	warn_contact_open_to_all()


def before_uninstall() -> None:
	"""Drop what the app keeps outside its own tables: the content fingerprints of the standard
	records (`services/standards.py`). The Custom Field and its column are left in place, as
	Frappe leaves every customization — the data in it is the site's."""
	from whatsapp_next.services.standards import FINGERPRINT_PARENT

	frappe.db.delete("DefaultValue", {"parent": FINGERPRINT_PARENT})


def has_app_permission() -> bool:
	"""`add_to_apps_screen[...]["has_permission"]` — who sees the app on Frappe's apps screen: a
	WhatsApp role or System Manager. Only called while that hook is declared in `hooks.py`."""
	if frappe.session.user == "Administrator":
		return True
	roles = set(frappe.get_roles())
	return bool(roles & {*PRODUCT_ROLES, "System Manager"})


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


def command_service_user_email() -> str:
	"""Return the deterministic e-mail of the command service user for this site."""
	site = frappe.local.site or "localhost"
	return f"{COMMAND_SERVICE_USER_LOCALPART}@{site}"


def ensure_command_service_user() -> str:
	"""Seed a *disabled* service user with no roles; the site admin enables and grants roles later.

	D-012: command handlers run as this user, never as Administrator. Returns the user name. A
	User cannot be a fixture: its name carries the site, and a fixture sync would replace the
	record (and what the admin granted it) on every migrate."""
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

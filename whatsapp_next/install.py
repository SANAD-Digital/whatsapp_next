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


# The WhatsApp sidebar icon with the beta mark (`public/images/whatsapp-beta-icon.svg`).
SIDEBAR_ICON = "/assets/whatsapp_next/images/whatsapp-beta-icon.svg"


def ensure_desktop_icons() -> None:
	"""The app's desktop tile (from `add_to_apps_screen`) and the WhatsApp workspace's tile inside
	it. Frappe creates both only at install time, so a site that installed the app before the hook
	existed gets them here. Idempotent; an icon the admin already has is left alone."""
	if not frappe.db.table_exists("Desktop Icon"):
		return
	try:
		# Frappe 16 has no public helper for this lookup (`get_app_desktop_icon` is gone), so ask directly
		app_icon = frappe.db.get_value("Desktop Icon", {"app": "whatsapp_next", "icon_type": "App"})
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
		# The sidebar header draws the Desktop Icon whose label is the sidebar's title ("WhatsApp"):
		# its `logo_url` when it names an app, else a grey initial. So the workspace tile carries
		# the WhatsApp icon the sidebar has always shown, with the beta mark on it.
		installed = set(frappe.get_installed_apps())
		for ws in frappe.get_all(
			"Workspace", filters={"app": "whatsapp_next", "public": 1}, fields=["name", "icon"]
		):
			logo = SIDEBAR_ICON
			existing = frappe.db.get_value("Desktop Icon", ws.name, ["app", "logo_url"], as_dict=True)
			if existing:
				owner = existing.app
				# ours, or left behind by an app that is no longer on this site (the legacy
				# snd_whatsapp tile shares the label): point it at this app's logo. An icon that
				# belongs to an installed app is not ours to touch.
				if logo and existing.logo_url != logo and (owner == "whatsapp_next" or owner not in installed):
					frappe.db.set_value(
						"Desktop Icon", ws.name, {"app": "whatsapp_next", "logo_url": logo}, update_modified=False
					)
					# every user's cached icons and boot, not only the migrating session's
					frappe.cache.delete_key("desktop_icons")
					frappe.cache.delete_key("bootinfo")
				continue
			icon = frappe.new_doc("Desktop Icon")
			icon.update(
				{
					"label": ws.name,
					"icon_type": "Link",
					"link_type": "Workspace Sidebar",
					"link_to": ws.name,
					"icon": ws.icon,
					"app": "whatsapp_next",
					"logo_url": logo,
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


# Composite (and composite-unique) indexes that DocType JSON cannot express (fields.md F-11,
# RC-02; 02 §3). Single-column indexes live in the JSON (`search_index` / `unique`).
COMPOSITE_INDEXES: tuple[tuple[str, tuple[str, ...]], ...] = (
	("WhatsApp Log", ("device", "creation")),
	("WhatsApp Log", ("reference_doctype", "reference_name")),
	("WhatsApp Log", ("status", "scheduled_at")),
	("WhatsApp Log", ("command", "creation")),
	("WhatsApp Log", ("notification", "creation")),
	("WhatsApp Inbound Message", ("device", "received_at")),
	("WhatsApp Inbound Message", ("command", "received_at")),
	("WhatsApp Queue Item", ("status", "scheduled_at", "priority")),
	("WhatsApp Queue Item", ("device", "status")),
	("WhatsApp Audit Log", ("reference_doctype", "reference_name")),
	("WhatsApp Audit Log", ("user", "creation")),
	("WhatsApp Notification", ("document_type", "event", "enabled")),
	("WhatsApp Notification Alert", ("enabled", "next_run_at")),
	("WhatsApp Webhook Event", ("event_name", "received_at")),
)

# Composite UNIQUE constraints (fields.md OQ-B, decided D-029).
COMPOSITE_UNIQUE: tuple[tuple[str, tuple[str, ...]], ...] = (
	("WhatsApp Inbound Message", ("device", "provider_message_id")),
	# The platform reuses one event id across message.sent/delivered/read (D-029 OQ-P3, D-047).
	("WhatsApp Webhook Event", ("event_name", "event_id")),
)


def add_indexes() -> None:
	"""Create every composite index / unique constraint that is missing (idempotent)."""
	for doctype, fields in COMPOSITE_INDEXES:
		if frappe.db.table_exists(doctype):
			frappe.db.add_index(doctype, list(fields))
	for doctype, fields in COMPOSITE_UNIQUE:
		if frappe.db.table_exists(doctype):
			frappe.db.add_unique(doctype, list(fields))


def expected_indexes() -> list[tuple[str, str]]:
	"""`(doctype, index_name)` pairs the test suite asserts on."""
	out = [(dt, frappe.db.get_index_name(list(fields))) for dt, fields in COMPOSITE_INDEXES]
	out += [(dt, "unique_" + "_".join(fields)) for dt, fields in COMPOSITE_UNIQUE]
	return out

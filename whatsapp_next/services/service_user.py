# Module role: the messaging service user (owner, 2026-10-28) — `WhatsApp Settings.
# command_service_user`, the one user the app sends and receives as: commands run as it, and the
# platform's webhooks are processed as it, so what they write (a received message, a line on a
# document's timeline) carries its name instead of "Guest". Not set: everything stays as Frappe
# does it (the webhook job runs as the request's user).

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager

import frappe
from frappe.utils import cint


def get() -> str | None:
	"""The configured service user when it can act: set, not Administrator, enabled."""
	user = frappe.db.get_single_value("WhatsApp Settings", "command_service_user")
	if not user or user == "Administrator":
		return None
	return user if cint(frappe.db.get_value("User", user, "enabled")) else None


@contextmanager
def acting() -> Iterator[str | None]:
	"""Run the block as the service user (a no-op when none is set); the previous session user,
	session and form_dict are always restored, as `command_router.execute` restores them."""
	user = get()
	if not user or frappe.session.user == user:
		yield user
		return
	previous = frappe.session.user
	saved_sid, saved_data, saved_form = frappe.session.sid, frappe.session.data, frappe.local.form_dict
	frappe.set_user(user)
	try:
		yield user
	finally:
		frappe.set_user(previous)
		frappe.session.sid, frappe.session.data, frappe.local.form_dict = saved_sid, saved_data, saved_form

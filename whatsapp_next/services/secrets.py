# Module role: the one way this app reads a secret stored in a Password field of WhatsApp Settings
# (the platform keys, the webhook secret).
#
# Frappe encrypts Password fields with the site's own `encryption_key`. A database brought over from
# another site (a restore, a copy of production) carries secrets encrypted with that other site's
# key, which this site cannot open. `Document.get_password(raise_exception=False)` still puts
# Frappe's "Encryption key is invalid! Please check site_config.json" in the response before it
# returns None, so every screen that merely asked "is the site signed in?" showed that dialog
# (owner, 2026-10-19). Here a secret that cannot be opened is treated as missing: the site reads as
# signed out, the setup asks for a sign-in, and the sign-in writes the keys again with this site's
# own key — nothing for anyone to fix by hand.

from __future__ import annotations

import frappe
from cryptography.fernet import Fernet, InvalidToken
from frappe.query_builder import Table
from frappe.utils import cstr
from frappe.utils.password import get_encryption_key

SETTINGS = "WhatsApp Settings"


def read(fieldname: str, doctype: str = SETTINGS, name: str | None = None) -> str | None:
	"""The plain value of a Password field, or None when it is empty or cannot be opened on this
	site. Never raises and never leaves a message for the browser. Never log what it returns."""
	auth = Table("__Auth")
	row = (
		frappe.qb.from_(auth)
		.select(auth.password)
		.where(
			(auth.doctype == doctype)
			& (auth.name == (name or doctype))
			& (auth.fieldname == fieldname)
			& (auth.encrypted == 1)
		)
		.limit(1)
	).run()
	if not row or not row[0][0]:
		return None
	try:
		return cstr(Fernet(get_encryption_key().encode()).decrypt(row[0][0].encode())) or None
	except (InvalidToken, ValueError, TypeError):
		# encrypted with another site's key: as good as not set
		return None

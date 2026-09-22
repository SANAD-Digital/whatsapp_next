# Module role: WhatsApp Audit Log controller — append-only trail written by `services/audit.py` under the
# real session user (security.md, 02 §6). Validation only: timestamps, user, and a secret-key guard on
# `details` so no credential ever lands in the log.

from __future__ import annotations

import json
import re
from typing import Any

import frappe
from frappe import _
from frappe.model.document import Document
from frappe.utils import now_datetime

from whatsapp_next.exceptions import WAValidationError

SECRET_KEY_PATTERN = re.compile(r"key|secret|token|password", re.IGNORECASE)


class WhatsAppAuditLog(Document):
	"""One audit row; `in_create` — never edited after insert."""

	def validate(self) -> None:
		"""Fill `timestamp` / `user`, require `summary`, reject secret-looking keys in `details`."""
		self.timestamp = self.timestamp or self.creation or now_datetime()
		self.user = self.user or frappe.session.user
		if not (self.summary or "").strip():
			frappe.throw(_("Summary is required"), WAValidationError)
		offending = find_secret_keys(parse_details(self.details))
		if offending:
			frappe.throw(
				_("Audit details must not contain secret-like keys: {0}").format(
					", ".join(sorted(offending))
				),
				WAValidationError,
			)


def parse_details(value: Any) -> Any:
	"""Return `details` as a Python object (JSON fields may arrive as str or already decoded)."""
	if value is None or value == "":
		return None
	if isinstance(value, str):
		try:
			return json.loads(value)
		except ValueError:
			frappe.throw(_("Details must be valid JSON"), WAValidationError)
	return value


def find_secret_keys(value: Any) -> set[str]:
	"""Collect every dict key (at any depth) matching *key* / *secret* / *token* / *password*."""
	found: set[str] = set()
	if isinstance(value, dict):
		for key, child in value.items():
			if SECRET_KEY_PATTERN.search(str(key)):
				found.add(str(key))
			found |= find_secret_keys(child)
	elif isinstance(value, list):
		for child in value:
			found |= find_secret_keys(child)
	return found

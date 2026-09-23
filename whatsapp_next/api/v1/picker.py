# Module role: API of the ContactPicker component (backend-plan §4.7 `picker.*`, screens spec
# §3.2, sources 1–6). Thin wrappers over services/picker.py: source listing and searches for
# Manager / Agent / Contact User, server-side upload parsing, and preview / commit against a
# target document (WhatsApp Campaign recipients or WhatsApp Contact Group members) gated by
# **write** permission on that document.

from __future__ import annotations

from typing import Any

import frappe
from frappe import _

from whatsapp_next.api._common import api_endpoint
from whatsapp_next.api.v1._roles import AGENT_UP, CONTACT_USER
from whatsapp_next.exceptions import WAPermissionError, WAValidationError
from whatsapp_next.services import picker

PICKER_ROLES = AGENT_UP + CONTACT_USER
TARGETS = tuple(picker.TARGETS)
UPLOAD_KINDS = ("excel", "csv", "vcf")


def _require_write(target_doctype: str, target_name: str) -> None:
	"""Write permission on the target document (`WAPermissionError`), unsupported target →
	`WAValidationError`."""
	if target_doctype not in picker.TARGETS:
		frappe.throw(_("Unsupported picker target {0}").format(target_doctype), WAValidationError)
	if not frappe.db.exists(target_doctype, target_name):
		frappe.throw(_("{0} {1} not found").format(_(target_doctype), target_name), WAValidationError)
	if not frappe.has_permission(target_doctype, "write", doc=target_name):
		frappe.throw(_("Not permitted to change {0}").format(target_name), WAPermissionError)


# ---- sources -----------------------------------------------------------------------------


@api_endpoint(roles=PICKER_ROLES, methods=("GET", "POST"))
def list_sources(target_doctype: str | None = None) -> list[dict[str, Any]]:
	"""`[{key, label, enabled, ...}]` — source 3 lists the enabled Picker Sources, 5 lists `vcf`/`csv`."""
	return picker.list_sources(target_doctype)


@api_endpoint(roles=PICKER_ROLES, methods=("GET", "POST"))
def search_groups(
	txt: str | None = None,
	kind: str | None = None,
	exclude: str | None = None,
	page: int = 1,
	page_length: int = 20,
) -> dict[str, Any]:
	"""Source 1: `{rows[{name, kind, member_count}], total}` of enabled Contact Groups."""
	return picker.search_groups(txt, kind=kind, exclude=exclude, page=page, page_length=page_length)


@api_endpoint(roles=PICKER_ROLES, methods=("GET", "POST"))
def get_group_members(group: str, page: int = 1, page_length: int = 50) -> dict[str, Any]:
	"""Source 1: `{rows, total}` — members of one group as picker rows (read on the group)."""
	return picker.get_group_members(group, page=page, page_length=page_length)


@api_endpoint(roles=PICKER_ROLES, methods=("GET", "POST"))
def search_contacts(
	txt: str | None = None, link_doctype: str | None = None, page: int = 1, page_length: int = 20
) -> dict[str, Any]:
	"""Source 2: `{rows, total}` through the contextual layer (`permissions.search_contacts`)."""
	return picker.search_contacts(txt, link_doctype=link_doctype, page=page, page_length=page_length)


@api_endpoint(roles=PICKER_ROLES, methods=("GET", "POST"))
def list_doctype_rows(
	document_type: str, filters: list | None = None, page: int = 1, page_length: int = 50
) -> dict[str, Any]:
	"""Source 3: `{rows, total}` of an enabled picker DocType (`name`, name field, phone field only).
	`WAValidationError` for a bad filter, `WAPermissionError` for a DocType not enabled."""
	return picker.list_doctype_rows(document_type, filters, page=page, page_length=page_length)


@api_endpoint(roles=PICKER_ROLES, schema={"kind": {"enum": list(UPLOAD_KINDS)}})
def parse_upload(file_url: str, kind: str, mapping: dict | None = None) -> dict[str, Any]:
	"""Sources 4/5: parse a private upload you own → `{rows[], invalid[], columns[], total,
	needs_mapping, error}`; `needs_mapping` asks the client for `mapping = {phone: <col>, name: <col>}`.
	`WAFileError` when public / too large / unreadable."""
	return picker.parse_upload(file_url, kind, mapping).as_dict()


@api_endpoint(roles=PICKER_ROLES)
def parse_manual(text: str | None = None) -> dict[str, Any]:
	"""Source 6: one entry per line (`phone`, `name;phone`, `phone name`) → `{rows[], invalid[], total}`."""
	return picker.parse_manual(text).as_dict()


# ---- targets -----------------------------------------------------------------------------


@api_endpoint(roles=None)
def preview(target_doctype: str, target_name: str, rows: list[dict] | None = None) -> dict[str, Any]:
	"""Classify `rows` against the target child table → `{available[], already_added[],
	invalid[], duplicates_in_selection[], known_count}`. Requires write on the target."""
	_require_write(target_doctype, target_name)
	return picker.preview(target_doctype, target_name, rows or []).as_dict()


@api_endpoint(roles=None, schema={"source_type": {"enum": list(picker.SOURCE_TYPES)}})
def commit_add(
	target_doctype: str,
	target_name: str,
	rows: list[dict],
	source_type: str = "Manual",
	source_ref: str | None = None,
) -> dict[str, Any]:
	"""Append the available rows to the target → `{added, skipped_duplicates, skipped_invalid}`;
	audited. `WAStateConflictError` on a terminal campaign."""
	_require_write(target_doctype, target_name)
	return picker.commit_add(
		target_doctype,
		target_name,
		rows,
		source_type=source_type,
		source_ref=source_ref,
		user=frappe.session.user,
	)


@api_endpoint(roles=None)
def commit_remove(
	target_doctype: str,
	target_name: str,
	phone_e164s: list[str] | None = None,
	filters: dict | None = None,
) -> dict[str, Any]:
	"""Remove rows by key or by `filters{source_type, source_ref}` → `{removed}`; audited.
	Running / Paused campaign rows become `Removed` and their queue rows are deleted-as-state."""
	_require_write(target_doctype, target_name)
	return picker.commit_remove(
		target_doctype, target_name, phone_e164s=phone_e164s, filters=filters, user=frappe.session.user
	)

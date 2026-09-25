# Module role: the status-writer guard (fields.md RC-04, risks R-015). Status fields on the
# system-written DocTypes may only change inside a `status_writer()` block, which the designated
# service module opens. Any other call path (Desk save, client API, ad-hoc script) is rejected.

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager

import frappe
from frappe import _

from whatsapp_next.exceptions import WAStateConflictError

FLAG = "wa_status_writer"


@contextmanager
def status_writer() -> Iterator[None]:
	"""Open a block in which status fields may be written (nested blocks are fine)."""
	previous = getattr(frappe.flags, FLAG, 0) or 0
	setattr(frappe.flags, FLAG, previous + 1)
	try:
		yield
	finally:
		setattr(frappe.flags, FLAG, previous)


def is_status_writer() -> bool:
	"""True while inside a `status_writer()` block."""
	return bool(getattr(frappe.flags, FLAG, 0))


def field_changed(before, doc, fieldname: str) -> bool:
	"""True when `fieldname` differs between the saved document and the one being saved.

	Both sides are cast through the field's own type first: the saved copy carries `datetime`
	objects while a document that arrived from the client carries their strings, and a plain
	`!=` between those is always True. Empty values (None / "") compare equal.
	"""
	return (before.get_value(fieldname) or None) != (doc.get_value(fieldname) or None)


def assert_status_writer(doc, fieldnames: tuple[str, ...] = ("status",)) -> None:
	"""Controller helper: reject a change of any listed field made outside `status_writer()`.

	Inserts set the initial value freely; only updates are guarded.
	"""
	if doc.is_new() or is_status_writer():
		return
	before = doc.get_doc_before_save()
	if before is None:
		return
	for fieldname in fieldnames:
		if field_changed(before, doc, fieldname):
			frappe.throw(
				_("{0} of {1} can only be changed by the system").format(
					_(doc.meta.get_label(fieldname)), _(doc.doctype)
				),
				WAStateConflictError,
			)


def assert_system_writer(doc, allow_flag: str = "wa_system_writer") -> None:
	"""Reject any insert/update of a system-only DocType outside services (flag-gated)."""
	if getattr(frappe.flags, allow_flag, False) or is_status_writer():
		return
	if frappe.flags.in_install or frappe.flags.in_migrate or frappe.flags.in_patch:
		return
	frappe.throw(_("{0} is written only by the system").format(_(doc.doctype)), WAStateConflictError)


@contextmanager
def system_writer() -> Iterator[None]:
	"""Open a block in which system-only DocTypes may be inserted or updated."""
	previous = getattr(frappe.flags, "wa_system_writer", False)
	frappe.flags.wa_system_writer = True
	try:
		yield
	finally:
		frappe.flags.wa_system_writer = previous

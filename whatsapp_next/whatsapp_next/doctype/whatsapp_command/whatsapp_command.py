# Module role: WhatsApp Command controller — a command word bound to a Function (fields.md §14,
# WHATSAPP_NEXT_INTEGRATION §3.2). Validation only: casefolded code / synonyms, cross-command
# uniqueness, the override, input, template and reply names against the function's header, party types
# (within the header's `@party_types`), and the edit lock while Active (D-029 09 OQ-3). Activation and
# "restore defaults" are whitelisted actions in `api/v1/commands.py`.

from __future__ import annotations

import json
from typing import Any

import frappe
from frappe import _
from frappe.model.document import Document

from whatsapp_next.exceptions import WAStateConflictError, WAValidationError
from whatsapp_next.services.guards import field_changed
from whatsapp_next.whatsapp_next.doctype.whatsapp_function.whatsapp_function import check_party_types

UNLOCKED_FIELDS = frozenset({"status", "run_count", "last_run_at", "defaults_restored_at"})


class WhatsAppCommand(Document):
	"""Inbound command word → function execution with per-command overrides."""

	def before_naming(self) -> None:
		"""Normalize `code` before `field:code` naming so the name is the casefolded word."""
		self.normalize_words()

	def validate(self) -> None:
		"""Normalize, check uniqueness, overrides and header names, and enforce the Active edit lock."""
		self.normalize_words()
		self.check_uniqueness()
		self.check_settings_overrides()
		check_party_types(self.get("allowed_party_types"))
		self.check_access_lists()
		self.normalize_disabled_inputs()
		self.check_against_header()
		self.check_edit_lock()

	def on_update(self) -> None:
		"""Invalidate the router's word map (`wa:commands:map`)."""
		from whatsapp_next.services.command_router import clear_map

		clear_map()

	def on_trash(self) -> None:
		"""Invalidate the router's word map."""
		from whatsapp_next.services.command_router import clear_map

		clear_map()

	def normalize_words(self) -> None:
		"""`code` casefolded + stripped; `title` defaults to `code`; synonyms one per line, deduped."""
		self.code = (self.code or "").strip().casefold()
		if not self.code:
			frappe.throw(_("Command Word is required"), WAValidationError)
		self.title = (self.title or "").strip() or self.code
		synonyms: list[str] = []
		for line in (self.synonyms or "").splitlines():
			word = line.strip().casefold()
			if not word or word in synonyms:
				continue
			if word == self.code:
				frappe.throw(_("Synonym {0} equals the command word").format(word), WAValidationError)
			synonyms.append(word)
		self.synonyms = "\n".join(synonyms)

	def synonym_list(self) -> list[str]:
		"""The normalized synonyms as a list."""
		return [s for s in (self.synonyms or "").splitlines() if s]

	def words(self) -> set[str]:
		"""`code` plus synonyms."""
		return {self.code, *self.synonym_list()}

	def check_uniqueness(self) -> None:
		"""No word of this command may equal the `code` or a synonym of any other command."""
		mine = self.words()
		from whatsapp_next.services.command_router import help_tokens

		taken = mine & help_tokens()
		if taken:
			frappe.throw(
				_("Word {0} asks for help and cannot be a command word").format(", ".join(sorted(taken))),
				WAValidationError,
			)
		for other in frappe.get_all("WhatsApp Command", fields=["name", "code", "synonyms"]):
			if other.name == self.name:
				continue
			theirs = {(other.code or "").strip().casefold()}
			theirs |= {s.strip().casefold() for s in (other.synonyms or "").splitlines() if s.strip()}
			clash = mine & theirs
			if clash:
				frappe.throw(
					_("Word {0} is already used by command {1}").format(", ".join(sorted(clash)), other.name),
					WAValidationError,
				)

	def check_access_lists(self) -> None:
		"""Per-type list modes and entries (D-132): every row names an allowed party type, one mode
		per type, each entry holds exactly one contact group or contact, no duplicates."""
		allowed = {r.party_type for r in self.get("allowed_party_types") or []}
		seen_modes: set[str] = set()
		for row in self.get("access_modes") or []:
			if row.party_type not in allowed:
				frappe.throw(
					_("List mode for {0}: that party type is not allowed for this command").format(
						row.party_type
					),
					WAValidationError,
				)
			if row.party_type in seen_modes:
				frappe.throw(
					_("Party type {0} has more than one list mode").format(row.party_type), WAValidationError
				)
			seen_modes.add(row.party_type)
		seen: set[tuple] = set()
		for row in self.get("access_entries") or []:
			if row.party_type not in allowed:
				frappe.throw(
					_("List entry for {0}: that party type is not allowed for this command").format(
						row.party_type
					),
					WAValidationError,
				)
			if bool(row.contact_group) == bool(row.contact):
				frappe.throw(
					_("List entry {0}: set either a contact group or a contact").format(row.idx),
					WAValidationError,
				)
			key = (row.party_type, row.contact_group or "", row.contact or "")
			if key in seen:
				frappe.throw(_("List entry {0} is repeated").format(row.idx), WAValidationError)
			seen.add(key)

	def normalize_disabled_inputs(self) -> None:
		"""`disabled_inputs` and `disabled_replies` one name per line, deduped."""
		for fieldname in ("disabled_inputs", "disabled_replies"):
			keys: list[str] = []
			for line in (self.get(fieldname) or "").splitlines():
				if line.strip() and line.strip() not in keys:
					keys.append(line.strip())
			self.set(fieldname, "\n".join(keys) or None)

	def spec(self) -> dict[str, Any]:
		"""The header spec of the linked function (empty when it is not installed)."""
		from whatsapp_next.services.function_runner import spec_of

		return spec_of(self.function)

	def check_against_header(self) -> None:
		"""Disabled inputs and asked inputs name parameters the sender may give; disabled replies
		name `@reply` keys; template rows name Template parameters, once per language; the allowed
		party types stay within `@party_types`."""
		from whatsapp_next.services import function_header as fh

		spec = self.spec()
		if not spec:
			return
		typed = {p["name"] for p in fh.typed_params(spec)}
		templates = {p["name"] for p in fh.command_params(spec) if p["fieldtype"] == "Template"}
		replies = {r["key"] for r in spec.get("replies") or []}
		asked = [line.partition(":")[0].strip() for line in (self.ask_inputs or "").splitlines() if line.strip()]
		checks = (
			(_("Disabled inputs"), (self.disabled_inputs or "").splitlines(), typed),
			(_("Ask for inputs"), asked, typed),
			(_("Disabled replies"), (self.disabled_replies or "").splitlines(), replies),
		)
		for label, names, allowed in checks:
			unknown = sorted({n.strip() for n in names if n.strip()} - allowed)
			if unknown:
				frappe.throw(
					_("{0}: {1} is not in the header of function {2}").format(label, ", ".join(unknown), self.function),
					WAValidationError,
				)
		seen: set[tuple[str, str]] = set()
		for row in self.get("templates") or []:
			if row.param not in templates:
				frappe.throw(
					_("Message text row {0}: {1} is not a message template of function {2}").format(row.idx, row.param, self.function),
					WAValidationError,
				)
			key = (row.param, row.language or "")
			if key in seen:
				frappe.throw(_("Message text row {0} repeats {1} in the same language").format(row.idx, row.param), WAValidationError)
			seen.add(key)
		for row in self.get("allowed_party_types") or []:
			if not fh.party_type_allowed(spec, row.party_type):
				frappe.throw(
					_("Party type {0} is not one function {1} serves ({2})").format(
						_(row.party_type), self.function, fh.party_types_text(spec)
					),
					WAValidationError,
				)

	def overrides_dict(self) -> dict[str, Any]:
		"""`settings_overrides` parsed as a dict (empty when unset)."""
		value = self.settings_overrides
		if not value:
			return {}
		if isinstance(value, str):
			try:
				value = json.loads(value)
			except ValueError:
				frappe.throw(_("Settings Overrides must be valid JSON"), WAValidationError)
		if not isinstance(value, dict):
			frappe.throw(_("Settings Overrides must be a JSON object"), WAValidationError)
		return value

	def check_settings_overrides(self) -> None:
		"""Every override key must be a parameter of the linked function's header (not the party)."""
		from whatsapp_next.services import function_header as fh

		overrides = self.overrides_dict()
		spec = self.spec()
		if not overrides or not spec:
			return
		keys = {p["name"] for p in fh.command_params(spec)} | {"language"}
		unknown = sorted(set(overrides) - keys)
		if unknown:
			frappe.throw(
				_("Unknown parameters for function {0}: {1}").format(self.function, ", ".join(unknown)),
				WAValidationError,
			)

	def check_edit_lock(self) -> None:
		"""While the saved command is Active only status / counters may change (D-029 09 OQ-3)."""
		if self.is_new():
			return
		before = self.get_doc_before_save()
		if before is None or before.status != "Active":
			return
		changed = self.changed_fields(before)
		if changed:
			frappe.throw(
				_("Command {0} is Active; deactivate it before changing {1}").format(
					self.name, ", ".join(sorted(changed))
				),
				WAStateConflictError,
			)

	def changed_fields(self, before: Document) -> set[str]:
		"""Fieldnames (value and table fields) whose content differs from `before`, ignoring unlocked ones."""
		changed: set[str] = set()
		for df in self.meta.fields:
			if df.fieldname in UNLOCKED_FIELDS or df.fieldtype in frappe.model.display_fieldtypes:
				continue
			if df.fieldtype in frappe.model.table_fields:
				if _rows(before, df.fieldname) != _rows(self, df.fieldname):
					changed.add(df.fieldname)
			elif field_changed(before, self, df.fieldname):
				changed.add(df.fieldname)
		return changed


def _rows(doc: Document, fieldname: str) -> list[tuple]:
	out = []
	for row in doc.get(fieldname) or []:
		fields = [
			df.fieldname for df in row.meta.fields if df.fieldtype not in frappe.model.display_fieldtypes
		]
		out.append(tuple(row.get(f) for f in fields))
	return out

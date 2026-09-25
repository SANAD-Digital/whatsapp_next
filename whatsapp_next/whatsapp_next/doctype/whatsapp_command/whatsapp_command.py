# Module role: WhatsApp Command controller — a command word bound to a Function (fields.md §14).
# Validation only: casefolded code / synonyms, cross-command uniqueness, settings-override keys, party
# types, the edit lock while Active (D-029 09 OQ-3), and the output copy on create. Activation and
# "restore defaults" are whitelisted actions in `api/v1/commands.py`.

from __future__ import annotations

import json
from typing import Any

import frappe
from frappe import _
from frappe.model.document import Document

from whatsapp_next.exceptions import WAStateConflictError, WAValidationError
from whatsapp_next.services.guards import field_changed
from whatsapp_next.whatsapp_next.doctype.whatsapp_function.whatsapp_function import (
	check_party_types,
	check_unique_rows,
)

UNLOCKED_FIELDS = frozenset({"status", "run_count", "last_run_at", "defaults_restored_at"})
OUTPUT_COPY_FIELDS = (
	"output_key",
	"label",
	"output_type",
	"default_template",
	"template",
	"condition",
	"print_format",
	"file_name_template",
	"variables",
	"notes",
)


class WhatsAppCommand(Document):
	"""Inbound command word → function execution with per-command overrides."""

	def before_naming(self) -> None:
		"""Normalize `code` before `field:code` naming so the name is the casefolded word."""
		self.normalize_words()

	def validate(self) -> None:
		"""Normalize, check uniqueness and overrides, enforce the Active edit lock, copy outputs on create."""
		self.normalize_words()
		self.check_uniqueness()
		self.check_settings_overrides()
		check_party_types(self.get("allowed_party_types"))
		check_unique_rows(self.get("outputs"), "output_key", _("Output key"))
		self.check_edit_lock()
		if self.is_new() and not self.get("outputs"):
			self.copy_outputs_from_function()

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
		"""Every override key must be a setting key of the linked Function."""
		overrides = self.overrides_dict()
		if not overrides or not self.function:
			return
		if not frappe.db.table_exists("WhatsApp Function Setting"):
			return
		keys = set(
			frappe.get_all(
				"WhatsApp Function Setting",
				filters={"parent": self.function, "parenttype": "WhatsApp Function"},
				pluck="key",
			)
		)
		unknown = sorted(set(overrides) - keys)
		if unknown:
			frappe.throw(
				_("Unknown setting keys for function {0}: {1}").format(self.function, ", ".join(unknown)),
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

	def copy_outputs_from_function(self) -> None:
		"""Replace `outputs` with the linked Function's rows (used on create and by "restore defaults")."""
		self.set("outputs", [])
		if not self.function or not frappe.db.exists("WhatsApp Function", self.function):
			return
		function = frappe.get_doc("WhatsApp Function", self.function)
		for row in function.get("outputs") or []:
			values = {f: row.get(f) for f in OUTPUT_COPY_FIELDS}
			if not values.get("template"):
				values["template"] = values.get("default_template")
			self.append("outputs", values)


def _rows(doc: Document, fieldname: str) -> list[tuple]:
	out = []
	for row in doc.get(fieldname) or []:
		fields = [
			df.fieldname for df in row.meta.fields if df.fieldtype not in frappe.model.display_fieldtypes
		]
		out.append(tuple(row.get(f) for f in fields))
	return out

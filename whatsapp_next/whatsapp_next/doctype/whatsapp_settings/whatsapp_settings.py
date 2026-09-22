# Module role: controller of the `WhatsApp Settings` Single — validation only (platform URL,
# queue bounds, command service user, provider key, blacklist group, picker sources) and cache
# invalidation on save. No provider calls here; those live in services/ and providers/.

from __future__ import annotations

import json

import frappe
from frappe import _
from frappe.model.document import Document
from frappe.utils import cint

from whatsapp_next.exceptions import WAValidationError
from whatsapp_next.services import phone

SETTINGS_CACHE_KEY = "wa:settings"
REQUEST_TIMEOUT_RANGE = (5, 120)
MESSAGES_PER_MINUTE_RANGE = (5, 60)
MIN_RETRY_BACKOFF_SECONDS = 30


class WhatsAppSettings(Document):
	"""Product-wide configuration: provider, credentials, webhook, queue, commands, policy."""

	def validate(self) -> None:
		"""Run every settings rule; each helper raises `WAValidationError` on its own."""
		self._validate_provider()
		self._validate_platform_base_url()
		self._validate_queue_bounds()
		self._validate_command_service_user()
		self._validate_global_blacklist_group()
		self._validate_picker_sources()

	def on_update(self) -> None:
		"""Forget cached derivations of these settings (default region, settings snapshot)."""
		phone.clear_region_cache()
		frappe.cache.delete_value(SETTINGS_CACHE_KEY)

	def _validate_provider(self) -> None:
		registry = frappe.get_hooks("whatsapp_providers") or {}
		if self.provider and self.provider not in registry:
			frappe.throw(
				_("Provider {0} is not registered in the whatsapp_providers hook").format(self.provider),
				WAValidationError,
			)

	def _validate_platform_base_url(self) -> None:
		url = (self.platform_base_url or "").strip()
		if not url:
			self.platform_base_url = None
			return
		if not url.lower().startswith("https://"):
			frappe.throw(_("Platform Base URL must start with https://"), WAValidationError)
		url = url.rstrip("/")
		if len(url) <= len("https://"):
			frappe.throw(_("Platform Base URL is incomplete"), WAValidationError)
		self.platform_base_url = url

	def _validate_queue_bounds(self) -> None:
		timeout = cint(self.request_timeout)
		low, high = REQUEST_TIMEOUT_RANGE
		if not low <= timeout <= high:
			frappe.throw(
				_("Request Timeout must be between {0} and {1} seconds").format(low, high), WAValidationError
			)
		rate = cint(self.messages_per_minute)
		low, high = MESSAGES_PER_MINUTE_RANGE
		if not low <= rate <= high:
			frappe.throw(
				_("Messages per Minute must be between {0} and {1}").format(low, high), WAValidationError
			)
		plan_rate = cint(self.plan_messages_per_minute)
		if plan_rate and rate > plan_rate:
			frappe.throw(
				_("Messages per Minute cannot exceed the plan rate limit ({0})").format(plan_rate),
				WAValidationError,
			)
		if cint(self.max_attempts) < 1:
			frappe.throw(_("Max Attempts must be at least 1"), WAValidationError)
		if cint(self.retry_backoff_seconds) < MIN_RETRY_BACKOFF_SECONDS:
			frappe.throw(
				_("Retry Backoff must be at least {0} seconds").format(MIN_RETRY_BACKOFF_SECONDS),
				WAValidationError,
			)

	def _validate_command_service_user(self) -> None:
		if not cint(self.enable_commands):
			return
		user = self.command_service_user
		if not user:
			frappe.throw(_("Command Service User is required when commands are enabled"), WAValidationError)
		if user == "Administrator":
			frappe.throw(_("Command Service User cannot be Administrator"), WAValidationError)
		row = frappe.db.get_value("User", user, ["enabled", "user_type"], as_dict=True)
		if not row:
			frappe.throw(_("Command Service User {0} does not exist").format(user), WAValidationError)
		if not cint(row.enabled):
			frappe.throw(_("Command Service User {0} is disabled").format(user), WAValidationError)
		if "System Manager" in frappe.get_roles(user):
			frappe.throw(
				_("Command Service User {0} must not hold the System Manager role").format(user),
				WAValidationError,
			)

	def _validate_global_blacklist_group(self) -> None:
		if not self.global_blacklist_group or not frappe.db.table_exists("WhatsApp Contact Group"):
			return
		kind = frappe.db.get_value("WhatsApp Contact Group", self.global_blacklist_group, "kind")
		if kind != "Blacklist":
			frappe.throw(_("Global Blacklist must be a Contact Group of kind Blacklist"), WAValidationError)

	def _validate_picker_sources(self) -> None:
		seen: set[str] = set()
		for row in self.get("picker_sources") or []:
			if row.document_type in seen:
				frappe.throw(
					_("Row {0}: DocType {1} is listed more than once").format(row.idx, row.document_type),
					WAValidationError,
				)
			seen.add(row.document_type)
			meta = frappe.get_meta(row.document_type)
			if meta.istable or meta.issingle:
				frappe.throw(
					_("Row {0}: {1} must be a regular (non-child, non-single) DocType").format(
						row.idx, row.document_type
					),
					WAValidationError,
				)
			if not row.label:
				row.label = _(meta.name)
			self._validate_picker_filters(row, meta)

	@staticmethod
	def _validate_picker_filters(row, meta) -> None:
		"""`filters_json` (gap G-1) must be a JSON list of `[fieldname, operator, value]` triples on
		fields the DocType has; it is merged into every picker query server-side."""
		if not (row.filters_json or "").strip():
			row.filters_json = None
			return
		from whatsapp_next.services.permissions import validate_filters

		try:
			parsed = json.loads(row.filters_json)
			validate_filters(meta, parsed)
		except (ValueError, TypeError) as exc:
			frappe.throw(
				_("Row {0}: Mandatory Filters must be a JSON list of [field, operator, value]: {1}").format(
					row.idx, exc
				),
				WAValidationError,
			)

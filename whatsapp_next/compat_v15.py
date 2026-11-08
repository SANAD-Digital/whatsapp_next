# Module role: on the version-15 branch only — what Frappe 15 lacks and this app's code names, so
# the code stays the same as on version-16 and later merges stay clean (BRANCHES.md). Loaded from
# `whatsapp_next/__init__.py`.

from __future__ import annotations

import frappe.tests
import frappe.utils.jinja
from frappe.desk import reportview
from frappe.model import optional_fields
from frappe.model.db_query import DatabaseQuery
from frappe.utils.redis_wrapper import RedisWrapper


def _tests_getattr(name: str):
	"""`from frappe.tests import IntegrationTestCase` (16) → `FrappeTestCase` (15), on first use."""
	if name == "IntegrationTestCase":
		from frappe.tests.utils import FrappeTestCase

		return FrappeTestCase
	raise AttributeError(name)


if not hasattr(frappe.tests, "__getattr__"):
	frappe.tests.__getattr__ = _tests_getattr


def _get_jenv():
	"""Frappe 16's `frappe.utils.jinja._get_jenv`: the sandboxed environment with Frappe's filters
	and no globals. Frappe 15 only has `get_jenv`, which adds the globals (and caches per request)."""
	from frappe.utils.jinja import get_jloader, set_filters
	from frappe.utils.safe_exec import UNSAFE_ATTRIBUTES
	from jinja2 import DebugUndefined
	from jinja2.sandbox import SandboxedEnvironment

	unsafe = UNSAFE_ATTRIBUTES - {"format", "format_map"}

	class FrappeSandboxedEnvironment(SandboxedEnvironment):
		def is_safe_attribute(self, obj, attr, *args, **kwargs):
			if attr in unsafe:
				return False
			return super().is_safe_attribute(obj, attr, *args, **kwargs)

	jenv = FrappeSandboxedEnvironment(loader=get_jloader(), undefined=DebugUndefined, cache_size=32)
	set_filters(jenv)
	return jenv


frappe.utils.jinja._get_jenv = _get_jenv


def _aggregate_field(field):
	"""Frappe 16's `{"COUNT": "name", "as": "n"}` → Frappe 15's "count(`name`) as `n`"."""
	if not isinstance(field, dict):
		return field
	alias = field.get("as")
	((func, column),) = ((k, v) for k, v in field.items() if k != "as")
	column = "*" if column == "*" else f"`{column}`"
	return f"{func.lower()}({column})" + (f" as `{alias}`" if alias else "")


_execute = DatabaseQuery.execute


def _execute_with_aggregates(self, fields=None, *args, **kwargs):
	if isinstance(fields, list | tuple) and any(isinstance(f, dict) for f in fields):
		fields = [_aggregate_field(f) for f in fields]
	return _execute(self, fields, *args, **kwargs)


DatabaseQuery.execute = _execute_with_aggregates


_set_value = RedisWrapper.set_value


def _set_value_like_16(self, key, val, user=None, expires_in_sec=None, shared=False):
	"""Frappe 15 skips this request's local copy when a value has an expiry, so a read after it in
	the same request or job returned the old value, or nothing (a session, a throttle, a "once"
	flag). Frappe 16 always keeps the local copy."""
	result = _set_value(self, key, val, user=user, expires_in_sec=expires_in_sec, shared=shared)
	frappe.local.cache[self.make_key(key, user, shared)] = val
	return result


RedisWrapper.set_value = _set_value_like_16


def _set_optional_columns(self):
	"""Frappe 15 drops every asked field whose name merely contains an optional column, so
	`last_seen` and `first_seen` ("_seen") came back missing from every list read, with no error.
	Frappe 16 compares the whole name; so does this."""
	self.fields[:] = [f for f in self.fields if f not in optional_fields or f in self.columns]
	to_remove = []
	for each in self.filters:
		if isinstance(each, str):
			each = [each]
		to_remove.extend(
			each for element in each if element in optional_fields and element not in self.columns
		)
	for each in to_remove:
		if isinstance(self.filters, dict):
			del self.filters[each]
		else:
			self.filters.remove(each)


DatabaseQuery.set_optional_columns = _set_optional_columns


_validate_fields = reportview.validate_fields


def _validate_fields_with_aggregates(data):
	"""The browser's own list reads carry Frappe 16's aggregates too (a list's number card asks
	`frappe.desk.reportview.get_list` for `{"SUM": "member_count", "as": "value"}`): Frappe 15's
	check of the fields stopped on them with `unhashable type: 'dict'`."""
	if isinstance(data.fields, list | tuple):
		data.fields = [_aggregate_field(f) for f in data.fields]
	return _validate_fields(data)


reportview.validate_fields = _validate_fields_with_aggregates

# Tests for the app's whitelisted surface (build order B-27, security.md): the webhook receiver is
# the only guest method, and every whitelisted function of `whatsapp_next.api.v1.*` goes through
# `api_endpoint`. Modules are imported dynamically so late-added ones are covered.

from __future__ import annotations

import importlib
import pkgutil

import frappe
from frappe.tests import IntegrationTestCase

from whatsapp_next.api import v1
from whatsapp_next.webhooks.v1 import receiver

ONLY_GUEST = "whatsapp_next.webhooks.v1.receiver.receive"


def _import_api_modules() -> list[str]:
	names = []
	for info in pkgutil.iter_modules(v1.__path__, prefix=f"{v1.__name__}."):
		importlib.import_module(info.name)
		names.append(info.name)
	return names


def _dotted(fn) -> str:
	return f"{fn.__module__}.{fn.__name__}"


class TestGuestSurface(IntegrationTestCase):
	def test_receiver_is_the_only_guest_method(self):
		_import_api_modules()
		ours = {_dotted(fn) for fn in frappe.whitelisted if fn.__module__.startswith("whatsapp_next.")}
		self.assertIn(ONLY_GUEST, ours)
		guests = {_dotted(fn) for fn in frappe.guest_methods if fn.__module__.startswith("whatsapp_next.")}
		self.assertEqual(guests, {ONLY_GUEST})
		self.assertIn(receiver.receive, frappe.guest_methods)

	def test_every_v1_whitelisted_function_uses_api_endpoint(self):
		modules = _import_api_modules()
		self.assertTrue(any(m.endswith(".contacts") for m in modules))
		offenders = []
		count = 0
		for fn in frappe.whitelisted:
			if not fn.__module__.startswith("whatsapp_next.api.v1."):
				continue
			count += 1
			if not getattr(fn, "__wa_api_endpoint__", False):
				offenders.append(_dotted(fn))
		self.assertEqual(offenders, [])
		self.assertGreater(count, 0)

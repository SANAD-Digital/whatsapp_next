# Tests for api/_common.py: roles, coercion, unknown args, provider error mapping, and the rule
# that no module under api/ uses a bare `@frappe.whitelist` (backend-plan RC-4).

from __future__ import annotations

import os
import re

import frappe
from frappe.tests import IntegrationTestCase

from whatsapp_next import exceptions as wex
from whatsapp_next.api._common import api_endpoint, coerce_value, map_provider_error, paginate
from whatsapp_next.providers import exceptions as pex
from whatsapp_next.tests.conftest_frappe import as_user


@api_endpoint(roles=("WhatsApp Manager",), methods=("POST",), schema={"mode": {"enum": ["a", "b"]}})
def _sample(count: int, flag: bool = False, names: list[str] | None = None, mode: str = "a") -> dict:
	"""Test endpoint."""
	return {"count": count, "flag": flag, "names": names, "mode": mode}


@api_endpoint(roles=None)
def _open(x: int = 1) -> int:
	"""Endpoint without role gate (document-level check inside)."""
	return x


class TestApiCommon(IntegrationTestCase):
	def test_registered_as_whitelisted(self):
		self.assertIn(_sample, frappe.whitelisted)
		self.assertTrue(getattr(_sample, "__wa_api_endpoint__", False))

	def test_role_gate(self):
		with as_user("WhatsApp Viewer"), self.assertRaises(wex.WAPermissionError):
			_sample(count=1)
		with as_user("WhatsApp Manager"):
			self.assertEqual(_sample(count="3", flag="true", names='["a","b"]')["count"], 3)

	def test_coercion(self):
		with as_user("WhatsApp Manager"):
			out = _sample(count="7", flag="0", names="[]", mode="b")
		self.assertEqual(out, {"count": 7, "flag": False, "names": [], "mode": "b"})
		self.assertEqual(coerce_value("x", "12", int), 12)
		self.assertTrue(coerce_value("x", "yes", bool))
		self.assertEqual(coerce_value("x", '{"a":1}', dict), {"a": 1})
		with self.assertRaises(wex.WAValidationError):
			coerce_value("x", "abc", int)

	def test_unknown_missing_and_enum(self):
		with as_user("WhatsApp Manager"):
			with self.assertRaises(wex.WAValidationError):
				_sample(count=1, bogus=2)
			with self.assertRaises(wex.WAValidationError):
				_sample()
			with self.assertRaises(wex.WAValidationError):
				_sample(count=1, mode="zzz")

	def test_provider_error_mapping(self):
		self.assertIsInstance(map_provider_error(pex.RateLimitError("r")), wex.WARateLimitError)
		self.assertIsInstance(map_provider_error(pex.AuthError("a")), wex.WAProviderAuthError)
		self.assertIsInstance(map_provider_error(pex.TransientError("t")), wex.WAProviderUnavailableError)
		self.assertIsInstance(map_provider_error(pex.NotSupportedError("n")), wex.WANotSupportedError)
		mapped = map_provider_error(pex.BusinessRejectedError("b", reason="quota", code="QUOTA_EXCEEDED"))
		self.assertIsInstance(mapped, wex.WAProviderRejectedError)
		self.assertEqual(mapped.provider_code, "QUOTA_EXCEEDED")
		self.assertIsInstance(map_provider_error(pex.ValidationError("v")), wex.WAValidationError)

	def test_paginate(self):
		self.assertEqual(paginate(None, None), (0, 20))
		self.assertEqual(paginate(3, 50), (100, 50))
		self.assertEqual(paginate(1, 999), (0, 200))

	def test_no_bare_whitelist_in_api_package(self):
		root = os.path.join(frappe.get_app_path("whatsapp_next"), "api")
		pattern = re.compile(r"^\s*@frappe\.whitelist", re.MULTILINE)
		offenders = []
		for dirpath, _dirs, files in os.walk(root):
			for name in files:
				if not name.endswith(".py") or name == "_common.py":
					continue
				with open(os.path.join(dirpath, name), encoding="utf-8") as fh:
					if pattern.search(fh.read()):
						offenders.append(os.path.join(dirpath, name))
		self.assertEqual(offenders, [], f"bare @frappe.whitelist found in {offenders}")

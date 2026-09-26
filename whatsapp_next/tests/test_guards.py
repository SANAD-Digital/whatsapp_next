# Tests for services/guards.field_changed — the comparison the edit locks and status guards rely on.

from __future__ import annotations

import datetime

import frappe
from frappe.tests import IntegrationTestCase

from whatsapp_next.services.guards import field_changed


def _campaign(**values):
	return frappe.get_doc({"doctype": "WhatsApp Campaign", **values})


class TestFieldChanged(IntegrationTestCase):
	def test_empty_datetime_is_unchanged(self):
		# Frappe casts an empty Datetime to "now": two empty values must still compare equal.
		self.assertFalse(field_changed(_campaign(), _campaign(), "scheduled_at"))
		self.assertFalse(field_changed(_campaign(scheduled_at=""), _campaign(scheduled_at=None), "scheduled_at"))

	def test_empty_versus_value(self):
		when = datetime.datetime(2030, 1, 1, 10, 0)
		self.assertTrue(field_changed(_campaign(), _campaign(scheduled_at=when), "scheduled_at"))
		self.assertTrue(field_changed(_campaign(scheduled_at=when), _campaign(), "scheduled_at"))

	def test_saved_datetime_equals_client_string(self):
		when = datetime.datetime(2030, 1, 1, 10, 0)
		self.assertFalse(
			field_changed(_campaign(scheduled_at=when), _campaign(scheduled_at="2030-01-01 10:00:00"), "scheduled_at")
		)
		self.assertTrue(
			field_changed(_campaign(scheduled_at=when), _campaign(scheduled_at="2030-01-01 11:00:00"), "scheduled_at")
		)

	def test_plain_fields(self):
		self.assertFalse(field_changed(_campaign(device=None), _campaign(device=""), "device"))
		self.assertTrue(field_changed(_campaign(device="A"), _campaign(device="B"), "device"))

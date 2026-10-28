# Tests for services/service_user.py (owner, 2026-10-28): the messaging service user the site
# sends and receives as — a no-op when none is set, and the caller's session always restored.

from __future__ import annotations

import frappe
from frappe.tests import IntegrationTestCase

from whatsapp_next.services import service_user
from whatsapp_next.tests import function_fixtures as ff
from whatsapp_next.tests.conftest_frappe import ensure_settings


class TestServiceUser(IntegrationTestCase):
	def tearDown(self):
		frappe.set_user("Administrator")

	def test_not_set_leaves_the_user_as_it_is(self):
		ensure_settings(enable_commands=0, command_service_user=None)
		self.assertIsNone(service_user.get())
		frappe.set_user("Guest")
		with service_user.acting() as user:
			self.assertIsNone(user)
			self.assertEqual(frappe.session.user, "Guest")
		self.assertEqual(frappe.session.user, "Guest")

	def test_set_acts_as_it_and_restores_the_caller(self):
		user = ff.ensure_service_user()
		ensure_settings(command_service_user=user)
		frappe.set_user("Guest")
		form = frappe.local.form_dict
		with service_user.acting() as acting:
			self.assertEqual((acting, frappe.session.user), (user, user))
		self.assertEqual(frappe.session.user, "Guest")
		self.assertIs(frappe.local.form_dict, form)

	def test_a_system_manager_is_never_used(self):
		user = ff.ensure_service_user()
		ensure_settings(command_service_user=user)
		frappe.get_doc("User", user).add_roles("System Manager")
		try:
			self.assertIsNone(service_user.get())
		finally:
			frappe.get_doc("User", user).remove_roles("System Manager")

	def test_a_disabled_user_is_not_used(self):
		user = ff.ensure_service_user()
		ensure_settings(command_service_user=user)
		frappe.db.set_value("User", user, "enabled", 0)
		try:
			self.assertIsNone(service_user.get())
		finally:
			frappe.db.set_value("User", user, "enabled", 1)

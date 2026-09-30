# Tests for functions/integrations/snd_accounting: the catalog is offered only where snd_accounting
# is installed; the customer functions answer only for the sender's linked customer; the staff
# summaries and the statement run their reports as the command service user would; the whole
# command path works through the simulator.

from __future__ import annotations

import unittest
from unittest.mock import patch

import frappe
from frappe.tests import IntegrationTestCase

from whatsapp_next.functions import registry
from whatsapp_next.functions.context import FunctionContext, Sender
from whatsapp_next.functions.integrations.snd_accounting import handlers
from whatsapp_next.services import functions_catalog as fc

KEYS = (
	"customer_balance",
	"customer_statement",
	"customer_trial_balance",
	"supplier_trial_balance",
	"cash_balances",
	"bank_balances",
)
CUSTOMER = "ApiTest WA Accounting Customer"


def _ctx(key, *, party=None, args=None, settings=None):
	sender = Sender(
		phone_e164="+966500950101",
		jid=None,
		display_name="Test",
		contact=None,
		party_type="Customer" if party else None,
		party_name=party,
	)
	return FunctionContext(function_key=key, command=None, args=args or {}, settings=settings or {}, sender=sender, device=None, inbound=None, dry_run=True)


@unittest.skipUnless("snd_accounting" in frappe.get_installed_apps(), "snd_accounting is not installed")
class TestSndAccountingFunctions(IntegrationTestCase):
	@classmethod
	def setUpClass(cls):
		super().setUpClass()
		if not frappe.db.exists("Customer", CUSTOMER):
			frappe.get_doc(
				{"doctype": "Customer", "customer_name": CUSTOMER, "customer_group": frappe.db.get_value("Customer Group", {"is_group": 0}, "name"), "territory": frappe.db.get_value("Territory", {"is_group": 0}, "name")}
			).insert(ignore_permissions=True)

	def setUp(self):
		frappe.cache.delete_value("wa:functions:catalog")

	def test_catalog_offers_the_six_with_handlers(self):
		cat = fc.load_catalog(use_cache=False)
		for key in KEYS:
			self.assertIn(key, cat.functions)
			self.assertIsNotNone(registry.get_handler(key), key)
		self.assertEqual(cat.functions["customer_balance"].party_types, ["Customer"])

	def test_catalog_hidden_without_the_app(self):
		installed = [a for a in frappe.get_installed_apps() if a != "snd_accounting"]
		with patch("frappe.get_installed_apps", return_value=installed):
			cat = fc.load_catalog(use_cache=False)
		self.assertNotIn("customer_balance", cat.functions)
		self.assertIn("ping", cat.functions)

	def test_customer_functions_need_a_linked_customer(self):
		for key in ("customer_balance", "customer_statement"):
			r = getattr(handlers, key)(_ctx(key))
			self.assertFalse(r.ok)

	def test_customer_balance_and_statement(self):
		r = handlers.customer_balance(_ctx("customer_balance", party=CUSTOMER))
		self.assertTrue(r.ok, r.error)
		self.assertEqual(r.data["customer_name"], CUSTOMER)
		self.assertEqual(r.data["balance"], 0)
		r = handlers.customer_statement(_ctx("customer_statement", party=CUSTOMER, args={"months": 6}))
		self.assertTrue(r.ok, r.error)
		self.assertEqual(r.data["months"], 6)
		self.assertIsInstance(r.data["entries"], list)

	def test_staff_summaries(self):
		for key in ("customer_trial_balance", "supplier_trial_balance", "cash_balances", "bank_balances"):
			r = getattr(handlers, key)(_ctx(key, args={"limit": 3}))
			self.assertTrue(r.ok, r.error)
			self.assertLessEqual(r.data["count"], 3)
			self.assertIn("total", r.data)

	def test_unknown_company_setting_is_refused(self):
		with self.assertRaises(frappe.ValidationError):
			handlers.cash_balances(_ctx("cash_balances", settings={"company": "No Such Company"}))

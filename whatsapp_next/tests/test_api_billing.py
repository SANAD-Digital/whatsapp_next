# Tests for api/v1/billing.py + services/billing.py (owner, 2026-10-28): paying from this site —
# managers only, the PayPal return address, the transfer's required evidence, the audit rows, and
# a provider that does not bill here.

from __future__ import annotations

import frappe
from frappe.tests import IntegrationTestCase

from whatsapp_next.api.v1 import billing as api
from whatsapp_next.exceptions import WANotSupportedError, WAValidationError
from whatsapp_next.services.billing import RETURN_PATH
from whatsapp_next.tests.conftest_frappe import as_user, fake_provider
from whatsapp_next.tests.fake_provider import FakeProvider


class BillingProvider(FakeProvider):
	"""Answers the billing calls the way the platform does and remembers what it was asked."""

	def __init__(self, *args, **kwargs):
		super().__init__(*args, **kwargs)
		self.asked: list[tuple] = []
		self.wallet_short = False

	def get_wallet(self):
		return {"balance": 4, "currency": "USD", "transactions": [], "renewal": {"renewal_price": 1}}

	def list_plans(self):
		return {"plans": [{"plan_code": "p1", "plan_name": "P1", "monthly_price": 1, "is_current": True}]}

	def get_payment_methods(self):
		return {"paypal": {"enabled": True, "currency": "USD"}, "methods": [{"name": "PM-1", "title": "Bank"}]}

	def renew_subscription(self):
		self.asked.append(("renew",))
		if self.wallet_short:
			return {"ok": True, "done": False, "payment_required": True, "amount": 9, "wallet_balance": 4, "currency": "USD"}
		return {"ok": True, "done": True, "amount": 1, "currency": "USD", "subscription": {"status": "Active"}}

	def change_plan(self, plan_code):
		self.asked.append(("change", plan_code))
		return {"ok": True, "done": True, "amount": 1}

	def request_topup(self, amount, payment_option=None, reference_no=None, remarks=None, receipt=None, plan_code=None):
		self.asked.append(("topup", amount, payment_option, reference_no))
		return {"ok": True, "transaction": "WAWT-1", "status": "Draft", "amount": amount}

	def start_paypal_topup(self, amount, return_url, plan_code=None):
		self.asked.append(("paypal", amount, return_url))
		return {"order_id": "ORDER-1", "approve_url": "https://paypal.example/approve"}

	def confirm_paypal_topup(self, order_id):
		self.asked.append(("confirm", order_id))
		return {"ok": True, "state": "completed", "transaction": {"name": "WAWT-2", "amount": 5}}

	def get_account_statement(self, from_date=None, to_date=None):
		return {"opening": 0, "closing": 4, "rows": [], "from_date": from_date, "to_date": to_date}


class TestApiBilling(IntegrationTestCase):
	def setUp(self):
		frappe.set_user("Administrator")

	def tearDown(self):
		frappe.set_user("Administrator")

	def test_managers_only(self):
		with fake_provider(BillingProvider()), as_user("WhatsApp Agent"):
			with self.assertRaises(frappe.PermissionError):
				api.get_billing()
			with self.assertRaises(frappe.PermissionError):
				api.renew()

	def test_renew_done_is_audited_and_short_wallet_is_an_answer(self):
		provider = BillingProvider()
		with fake_provider(provider), as_user("WhatsApp Manager"):
			result = api.renew()
			self.assertTrue(result["done"])
			provider.wallet_short = True
			short = api.renew()
			self.assertFalse(short["done"])
			self.assertEqual(short["amount"], 9)
		self.assertEqual(provider.asked, [("renew",), ("renew",)])
		self.assertTrue(frappe.db.exists("WhatsApp Audit Log", {"action": "Subscription Renewed"}))

	def test_paypal_comes_back_to_this_site(self):
		provider = BillingProvider()
		with fake_provider(provider), as_user("WhatsApp Manager"):
			started = api.start_paypal(amount=5)
			self.assertEqual(started["approve_url"], "https://paypal.example/approve")
			back = provider.asked[-1][2]
			self.assertEqual(back, frappe.utils.get_url(RETURN_PATH))
			self.assertTrue(back.startswith(frappe.utils.get_url()))
			self.assertEqual(api.confirm_paypal(order_id="ORDER-1")["state"], "completed")
		self.assertTrue(frappe.db.exists("WhatsApp Audit Log", {"action": "Wallet Top-up Paid"}))

	def test_a_transfer_needs_a_method_and_evidence(self):
		provider = BillingProvider()
		with fake_provider(provider), as_user("WhatsApp Manager"):
			with self.assertRaises(WAValidationError):
				api.request_topup(amount=5, payment_option="PM-1")  # no number, no receipt
			with self.assertRaises(WAValidationError):
				api.request_topup(amount=5, payment_option="")
			with self.assertRaises(frappe.ValidationError):
				api.request_topup(amount=0, payment_option="PM-1", reference_no="T-1")
			result = api.request_topup(amount=5, payment_option="PM-1", reference_no="T-1")
		self.assertEqual(result["transaction"], "WAWT-1")
		self.assertEqual(provider.asked, [("topup", 5.0, "PM-1", "T-1")])

	def test_a_provider_that_does_not_bill_here_says_so(self):
		with fake_provider(FakeProvider()), as_user("WhatsApp Manager"):
			with self.assertRaises(WANotSupportedError):
				api.get_billing()

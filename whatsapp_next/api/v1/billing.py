# Module role: whitelisted endpoints of the settings window's plan, wallet and statement sections
# (services.billing). Managers only: these move the account's money. Thin: no business logic.

from __future__ import annotations

from typing import Any

from whatsapp_next.api._common import api_endpoint
from whatsapp_next.api.v1._roles import MANAGER
from whatsapp_next.services import billing


@api_endpoint(roles=MANAGER, methods=("GET", "POST"))
def get_billing() -> dict[str, Any]:
	"""`{wallet, plans, payment}` from the platform."""
	return billing.overview()


@api_endpoint(roles=MANAGER)
def renew() -> dict[str, Any]:
	"""Renew the plan from the wallet now."""
	return billing.renew()


@api_endpoint(roles=MANAGER, schema={"plan_code": {"max_length": 140}})
def change_plan(plan_code: str) -> dict[str, Any]:
	"""Move to another plan now, paid from the wallet."""
	return billing.change_plan(plan_code)


@api_endpoint(
	roles=MANAGER,
	schema={
		"amount": {"min": 0.01, "max": 1000000},
		"payment_option": {"max_length": 140},
		"reference_no": {"max_length": 140},
		"remarks": {"max_length": 500},
		"receipt_file": {"max_length": 500},
		"plan_code": {"max_length": 140},
	},
)
def request_topup(
	amount: float,
	payment_option: str,
	reference_no: str | None = None,
	remarks: str | None = None,
	receipt_file: str | None = None,
	plan_code: str | None = None,
) -> dict[str, Any]:
	"""A top-up paid by transfer, sent for review."""
	return billing.request_topup(amount, payment_option, reference_no, remarks, receipt_file, plan_code)


@api_endpoint(roles=MANAGER, schema={"amount": {"min": 0.01, "max": 1000000}, "plan_code": {"max_length": 140}})
def start_paypal(amount: float, plan_code: str | None = None) -> dict[str, Any]:
	"""Start a PayPal payment → `{order_id, approve_url}`."""
	return billing.start_paypal(amount, plan_code)


@api_endpoint(roles=MANAGER, schema={"order_id": {"max_length": 64}})
def confirm_paypal(order_id: str) -> dict[str, Any]:
	"""Confirm a PayPal payment on the payer's return."""
	return billing.confirm_paypal(order_id)


@api_endpoint(roles=MANAGER, methods=("GET", "POST"))
def statement(from_date: str | None = None, to_date: str | None = None) -> dict[str, Any]:
	"""The account statement for a period."""
	return billing.statement(from_date, to_date)

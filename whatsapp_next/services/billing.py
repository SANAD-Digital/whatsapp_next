# Module role: plan, wallet and payments from this site (owner, 2026-10-28). The customer renews,
# changes plan, tops up (PayPal or a transfer with its receipt) and reads the account statement
# here, through the provider; the platform keeps the money and decides. After anything that moves
# money the plan cache (`usage_sync`) is read again, so every screen shows the new state at once.

from __future__ import annotations

import base64
import mimetypes
import os
from typing import Any

import frappe
from frappe import _
from frappe.utils import flt, get_url

from whatsapp_next.exceptions import WAValidationError
from whatsapp_next.providers import registry
from whatsapp_next.services import audit, usage_sync

#: Where PayPal sends the payer back: Home, which opens the settings window on the wallet and
#: confirms the payment (`public/js/screens/settings.js`, `follow_paypal`). A query, not a hash:
#: PayPal adds its own `token` to the address.
RETURN_PATH = "/app/wa-home?wa_paypal=1"
RECEIPT_TYPES = {"application/pdf", "image/jpeg", "image/png", "image/webp"}
MAX_RECEIPT_BYTES = 5 * 1024 * 1024


def overview() -> dict[str, Any]:
	"""`{wallet, plans, payment}` — everything the wallet and plans sections draw, in one call."""
	provider = registry.get_provider()
	return {
		"wallet": provider.get_wallet(),
		"plans": provider.list_plans().get("plans") or [],
		"payment": provider.get_payment_methods(),
	}


def _record(action: str, summary: str, details: dict[str, Any]) -> None:
	# the platform keeps its own record of the same operation; one missing here must not hide
	# that the money already moved
	try:
		audit.log(action, summary=summary, details=details)
	except Exception:
		frappe.log_error(title=f"WhatsApp audit not recorded: {action}")


def _after_money_moved(result: dict[str, Any]) -> dict[str, Any]:
	usage_sync.sync_subscription()
	return result


def renew() -> dict[str, Any]:
	"""Renew the plan from the wallet now → `{done, subscription, payment_required?, amount?, …}`."""
	result = registry.get_provider().renew_subscription()
	if result.get("done"):
		_record("Subscription Renewed", "Renewed the plan from the wallet", {"amount": result.get("amount"), "currency": result.get("currency")})
	return _after_money_moved(result)


def change_plan(plan_code: str) -> dict[str, Any]:
	"""Move to `plan_code` now, paid from the wallet; the same answer as `renew`."""
	if not plan_code:
		raise WAValidationError(_("Choose a plan."))
	result = registry.get_provider().change_plan(plan_code)
	if result.get("done"):
		_record("Plan Changed", "Changed the plan", {"plan_code": plan_code, "amount": result.get("amount")})
	return _after_money_moved(result)


def _receipt(file_url: str | None) -> tuple[str, str, str] | None:
	"""A receipt this user uploaded (a private File) → `(filename, mime, base64)` for the platform."""
	if not file_url:
		return None
	name = frappe.db.get_value("File", {"file_url": file_url, "owner": frappe.session.user}, "name")
	if not name:
		raise WAValidationError(_("Upload the receipt again."))
	doc = frappe.get_doc("File", name)
	content = doc.get_content()
	mime = mimetypes.guess_type(doc.file_name or "")[0] or ""
	if mime not in RECEIPT_TYPES:
		raise WAValidationError(_("The receipt must be a PDF or an image (JPG, PNG or WebP)."))
	if not content or len(content) > MAX_RECEIPT_BYTES:
		raise WAValidationError(_("The receipt must be smaller than 5 MB."))
	if isinstance(content, str):
		content = content.encode()
	return os.path.basename(doc.file_name), mime, base64.b64encode(content).decode()


def request_topup(
	amount: float,
	payment_option: str,
	reference_no: str | None = None,
	remarks: str | None = None,
	receipt_file: str | None = None,
	plan_code: str | None = None,
) -> dict[str, Any]:
	"""A top-up paid by transfer to one of the offered methods, for the platform to approve."""
	if flt(amount) <= 0:
		raise WAValidationError(_("Enter the amount you paid."))
	if not payment_option:
		raise WAValidationError(_("Choose the payment method you used."))
	if not reference_no and not receipt_file:
		raise WAValidationError(_("Add the transfer number or attach the receipt, so the payment can be matched."))
	result = registry.get_provider().request_topup(
		flt(amount, 2), payment_option=payment_option, reference_no=reference_no, remarks=remarks, receipt=_receipt(receipt_file), plan_code=plan_code
	)
	_record("Wallet Top-up Requested", "Sent a top-up for review", {"amount": flt(amount, 2), "transaction": result.get("transaction")})
	return result


def start_paypal(amount: float, plan_code: str | None = None) -> dict[str, Any]:
	"""Start a PayPal payment → `{order_id, approve_url}`; the page sends the payer to `approve_url`."""
	if flt(amount) <= 0:
		raise WAValidationError(_("Enter the amount to add."))
	return registry.get_provider().start_paypal_topup(flt(amount, 2), get_url(RETURN_PATH), plan_code=plan_code)


def confirm_paypal(order_id: str) -> dict[str, Any]:
	"""Back from PayPal: capture the payment (safe to repeat) → `{state, transaction}`."""
	if not order_id:
		raise WAValidationError(_("This PayPal payment was not found."))
	result = registry.get_provider().confirm_paypal_topup(order_id)
	if result.get("state") == "completed":
		txn = result.get("transaction") or {}
		_record("Wallet Top-up Paid", "Topped up the wallet by PayPal", {"order_id": order_id, "transaction": txn.get("name"), "amount": txn.get("amount")})
	return _after_money_moved(result)


def statement(from_date: str | None = None, to_date: str | None = None) -> dict[str, Any]:
	"""The account statement for a period (inclusive; default this month)."""
	return registry.get_provider().get_account_statement(from_date, to_date)

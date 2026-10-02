# Module role: handlers of the snd_accounting functions — the six accounting answers the legacy
# app sent (`snd_accounting/whatsapp_command/v1`), on this app's contract: the handler reads the
# snd_accounting report and returns data; the command's output templates write the reply and the
# router sends it. The customer is the party linked to the sender's contact — never a name typed
# in the message, never a raw match of the phone against Customer.mobile_no. snd_accounting is
# imported inside each handler, so this module loads on a site without it.

from __future__ import annotations

from typing import Any

import frappe
from frappe import _
from frappe.utils import add_months, cint, flt, fmt_money, formatdate, getdate, nowdate

from whatsapp_next.functions.context import FunctionContext, FunctionResult

MAX_LINES = 30
REPORTS = "snd_accounting.snd_accounting.report"


def _report(name: str):
	"""The `execute` of one snd_accounting report."""
	return frappe.get_attr(f"{REPORTS}.{name}.{name}.execute")


def _company(ctx: FunctionContext) -> str:
	company = (ctx.settings.get("company") or "").strip() or frappe.defaults.get_global_default("company")
	if not company or not frappe.db.exists("Company", company):
		frappe.throw(_("Function is not configured: company"))
	return company


def _fiscal_start(company: str, to_date) -> Any:
	from erpnext.accounts.utils import get_fiscal_year

	return getdate(get_fiscal_year(to_date, company=company, verbose=0)[1])


def _limit(ctx: FunctionContext, default: int) -> int:
	return max(1, min(cint(ctx.args.get("limit") or ctx.settings.get("limit") or default), MAX_LINES))


def _money(value, currency: str | None) -> str:
	return fmt_money(flt(value), currency=currency)


def _customer(ctx: FunctionContext) -> str | None:
	"""The customer linked to the sender's contact, or None."""
	if ctx.sender.party_type == "Customer" and ctx.sender.party_name:
		return ctx.sender.party_name
	return None


def _currency(customer: str, company: str, found: str | None) -> str | None:
	if found:
		return found
	from erpnext.accounts.party import get_party_account_currency

	return get_party_account_currency("Customer", customer, company)


def _ledger_rows(filters) -> list:
	"""snd_accounting's Customer Ledger; where it cannot run on this site's schema (it reads
	columns some sites lack), ERPNext's General Ledger with the same filters — same rows, same
	opening / closing lines."""
	try:
		return _report("customer_ledger")(frappe._dict(filters))[1]
	except frappe.db.OperationalError:
		# MariaDB keeps the transaction after a failed statement: no rollback, which would also
		# undo what the router already wrote for this inbound message
		frappe.log_error(title="WhatsApp functions: Customer Ledger failed, General Ledger used", message=frappe.get_traceback())
		from erpnext.accounts.report.general_ledger.general_ledger import execute

		return execute(frappe._dict(filters, presentation_currency=None))[1]


def _closing_row(rows) -> frappe._dict:
	"""The ledger's closing line: the last line that is not a voucher and carries a balance.

	Its label is translated — "Closing (Opening + Total)" in the language of the reply — so it
	cannot be found by the English word: an Arabic reply matched nothing and told a customer
	who owed 20,000 that their closing balance was 0.00 (live E2E, 2026-10-01)."""
	for row in reversed(rows or []):
		if isinstance(row, dict) and not row.get("voucher_no") and row.get("balance") is not None:
			return frappe._dict(row)
	return frappe._dict()


# ---- the sender's own customer -------------------------------------------------------------


def customer_balance(ctx: FunctionContext) -> FunctionResult:
	"""`#balance [date]` → the sender's customer balance (Customer Trial Balance) as on a date."""
	customer = _customer(ctx)
	if not customer:
		return FunctionResult(error=_("Your number is not linked to a customer account"))
	company = _company(ctx)
	to_date = getdate(ctx.args.get("as_on") or nowdate())
	rows = _report("customer_trial_balance")(
		frappe._dict(company=company, from_date=_fiscal_start(company, to_date), to_date=to_date, party=[customer])
	)[1]
	row = next((r for r in rows if r.get("party") == customer), frappe._dict())
	currency = _currency(customer, company, row.get("currency"))
	balance = flt(row.get("closing"))
	return FunctionResult(
		data={
			"customer": customer,
			"customer_name": frappe.db.get_value("Customer", customer, "customer_name") or customer,
			"balance": balance,
			"balance_formatted": _money(balance, currency),
			"currency": currency,
			"as_on": formatdate(to_date),
		}
	)


def customer_statement(ctx: FunctionContext) -> FunctionResult:
	"""`#statement [months]` → the sender's last ledger entries (Customer Ledger) and closing balance."""
	customer = _customer(ctx)
	if not customer:
		return FunctionResult(error=_("Your number is not linked to a customer account"))
	company = _company(ctx)
	months = max(1, min(cint(ctx.args.get("months") or ctx.settings.get("months") or 3), 24))
	to_date = getdate(nowdate())
	from_date = getdate(add_months(to_date, -months))
	filters = frappe._dict(
		company=company,
		from_date=from_date,
		to_date=to_date,
		party_type="Customer",
		party=[customer],
		group_by="Group by Voucher (Consolidated)",
	)
	rows = _ledger_rows(filters)
	entries = [r for r in rows if r.get("posting_date") and r.get("voucher_no")][-_limit(ctx, 10) :]
	closing = _closing_row(rows)
	currency = _currency(customer, company, closing.get("presentation_currency") or closing.get("account_currency"))
	return FunctionResult(
		data={
			"customer": customer,
			"customer_name": frappe.db.get_value("Customer", customer, "customer_name") or customer,
			"from_date": formatdate(from_date),
			"to_date": formatdate(to_date),
			"months": months,
			"entries": [
				{
					"date": formatdate(r.get("posting_date")),
					"voucher": r.get("voucher_no"),
					"debit": _money(r.get("debit"), currency),
					"credit": _money(r.get("credit"), currency),
					"balance": _money(r.get("balance"), currency),
				}
				for r in entries
			],
			"count": len(entries),
			"closing": flt(closing.get("balance")),
			"closing_formatted": _money(closing.get("balance"), currency),
			"currency": currency,
		}
	)


# ---- summaries for staff (restrict their commands to an allowed group) ---------------------


def _summary(ctx: FunctionContext, report: str, title: str, default_limit: int) -> FunctionResult:
	company = _company(ctx)
	to_date = getdate(nowdate())
	rows = _report(report)(frappe._dict(company=company, from_date=_fiscal_start(company, to_date), to_date=to_date))[1]
	rows = [r for r in rows if r.get("party") or r.get("party_name")]
	total = sum(flt(r.get("closing")) for r in rows)
	currency = next((r.get("currency") for r in rows if r.get("currency")), None) or frappe.get_cached_value(
		"Company", company, "default_currency"
	)
	top = sorted(rows, key=lambda r: abs(flt(r.get("closing"))), reverse=True)[: _limit(ctx, default_limit)]
	return FunctionResult(
		data={
			"title": title,
			"company": company,
			"to_date": formatdate(to_date),
			"rows": [
				{"name": r.get("party_name") or r.get("party"), "amount": _money(r.get("closing"), r.get("currency") or currency)}
				for r in top
			],
			"count": len(top),
			"of": len(rows),
			"total": _money(total, currency),
		}
	)


def customer_trial_balance(ctx: FunctionContext) -> FunctionResult:
	"""The largest customer balances (Customer Trial Balance)."""
	return _summary(ctx, "customer_trial_balance", _("Customer balances"), 10)


def supplier_trial_balance(ctx: FunctionContext) -> FunctionResult:
	"""The largest supplier balances (Supplier Trial Balance)."""
	return _summary(ctx, "supplier_trial_balance", _("Supplier balances"), 10)


def cash_balances(ctx: FunctionContext) -> FunctionResult:
	"""Cash account balances (Cash Trial Balance)."""
	return _summary(ctx, "cash_trial_balance", _("Cash balances"), 20)


def bank_balances(ctx: FunctionContext) -> FunctionResult:
	"""Bank account balances (Bank Trial Balance)."""
	return _summary(ctx, "bank_trial_balance", _("Bank balances"), 20)

# billing

Module `whatsapp_next/api/v1/billing.py`. These endpoints serve the plan, wallet and statement
sections of the settings window (`public/js/screens/settings.js`). They are thin wrappers over
`services/billing.py`, which calls the active provider. The platform keeps the money and decides;
this site only asks. After `renew`, `change_plan` and `confirm_paypal`, the plan cache is read
again (`usage_sync.sync_subscription`), so every screen shows the new state at once.

Every endpoint needs **`MANAGER`** (WhatsApp Manager, System Manager): these move the account's
money.

Conventions are in [README.md](README.md). Provider exceptions are mapped as described in
README §5. A provider that doesn't bill through this site answers every endpoint with
`WANotSupportedError` (422). A platform refusal (`frappe.throw` on the platform) arrives as
`WAValidationError` (417) with the platform's message.

Successful operations are audited: `Subscription Renewed`, `Plan Changed`,
`Wallet Top-up Requested`, `Wallet Top-up Paid`. A failed audit write is logged and never hides
that the money already moved.

### Realtime

None of these endpoints publishes a realtime event.

---

## get_billing

Everything the wallet and plans sections draw, in one call: the wallet, the plans, and the ways
to pay.

- **Path:** `whatsapp_next.api.v1.billing.get_billing`
- **Methods:** GET, POST
- **Roles:** `MANAGER`

No arguments.

**Returns.** `wallet` is the platform's `get_wallet_api` answer (the last 20 transactions and
billing entries), `plans` its active plans, and `payment` its payment methods. The platform's
`ok` key is passed through.

```json
{
  "wallet": {
    "ok": true, "customer": "CUST-0001", "balance": 25.0, "currency": "USD",
    "transactions": [{"name": "WTX-0042", "transaction_type": "Credit", "amount": 50.0, "currency": "USD",
                      "posting_date": "2026-11-01", "payment_method": "PayPal", "reference_no": "8XK…",
                      "status": "Approved", "remarks": "", "…": "…"}],
    "billing_entries": [{"name": "WBE-0007", "plan": "Business", "amount": 25.0, "currency": "USD",
                         "billing_period_start": "2026-11-01", "billing_period_end": "2026-11-30",
                         "status": "Paid", "…": "…"}],
    "renewal": {"messages_remaining": 4200, "wallet_balance": 25.0, "wallet_currency": "USD",
                "renewal_price": 25.0, "renewal_currency": "USD", "renewal_required": false,
                "messages_exhausted": false, "can_renew_from_wallet": true, "auto_renew": true,
                "next_billing_date": "2026-12-01"}
  },
  "plans": [{"plan_code": "BUSINESS", "plan_name": "Business", "description": "…", "monthly_price": 25.0,
             "currency": "USD", "billing_period": "Monthly", "message_limit": 5000,
             "messages_per_minute": 20, "device_limit": 3, "cumulative_messages": false,
             "features": {"allow_groups": true, "…": "…"}, "webhook_events": {"…": "…"},
             "is_current": true, "is_requested_renewal": false, "is_trial": false, "is_featured": false}],
  "payment": {
    "ok": true,
    "paypal": {"enabled": true, "currency": "USD"},
    "methods": [{"name": "PM-0001", "title": "Bank transfer", "method_type": "Bank", "country": "Yemen",
                 "currency": "YER", "bank_name": "…", "account_name": "…", "account_number": "…",
                 "iban": "…", "swift_code": "…", "receiver_name": null, "receiver_phone": null,
                 "receiver_city": null, "receiver_country": null, "paypal_account": null,
                 "instructions": "…"}]
  }
}
```

**Errors:** `WANotSupportedError` (422) when the provider doesn't bill here. Provider errors are
mapped.
**Realtime:** none.

```js
const { wallet, plans, payment } = await sanad.ui.call("billing.get_billing");
```

---

## renew

Renews the current plan now, paid from the wallet. The platform allows it only when a renewal is
due (the messages are used up or the period is over). A wallet that is short is an answer, not an
error: `done` is `false` and the platform has created an unpaid billing entry.

- **Path:** `whatsapp_next.api.v1.billing.renew`
- **Methods:** POST
- **Roles:** `MANAGER`

No arguments.

**Returns.** When it renewed:

```json
{"ok": true, "done": true, "billing_entry": "WBE-0008", "wallet_transaction": "WTX-0043",
 "amount": 25.0, "currency": "USD",
 "subscription": {"name": "SUB-0001", "status": "Active", "plan_code": "BUSINESS", "plan_name": "Business",
                  "start_date": "2026-12-01", "end_date": "2026-12-31", "message_limit": 5000,
                  "messages_remaining": 5000}}
```

When the wallet is short:

```json
{"ok": true, "done": false, "payment_required": true, "billing_entry": "WBE-0008", "amount": 25.0,
 "currency": "USD", "wallet_balance": 10.0,
 "message": "Wallet balance is not enough. A payment request was created.",
 "subscription": {"name": "SUB-0001", "status": "Expired", "…": "…"}}
```

**Errors:** `WAValidationError` (417) when no renewal is due ("Your package still has remaining
messages") or the subscription is waiting for account approval. `WAProviderRejectedError` (422)
when the account has no subscription. Provider errors are mapped.
**Realtime:** none.

```js
const r = await sanad.ui.call("billing.renew", {}, { freeze: true });
if (!r.done) show_topup(r.amount - r.wallet_balance, r.currency);
```

---

## change_plan

Moves the subscription to another plan now, paid from the wallet. The answer has the same shape
as `renew`. Choosing the plan already in force counts as a renewal, which is allowed only when one
is due.

- **Path:** `whatsapp_next.api.v1.billing.change_plan`
- **Methods:** POST
- **Roles:** `MANAGER`

| Argument | Type | Required / default | Meaning |
|---|---|---|---|
| `plan_code` | str | required | The target plan's `plan_code` (from `get_billing().plans`). At most 140 characters. |

**Returns.** The same as `renew`:

```json
{"ok": true, "done": true, "billing_entry": "WBE-0009", "wallet_transaction": "WTX-0044",
 "amount": 60.0, "currency": "USD",
 "subscription": {"name": "SUB-0001", "status": "Active", "plan_code": "PRO", "plan_name": "Pro", "…": "…"}}
```

**Errors:** `WAValidationError` (417) for an empty `plan_code` ("Choose a plan."), a plan the
platform doesn't offer, or the plan already in force when no renewal is due. Provider errors are
mapped.
**Realtime:** none.

```js
const r = await sanad.ui.call("billing.change_plan", { plan_code: "PRO" }, { freeze: true });
```

---

## request_topup

Sends a wallet top-up paid by transfer to the platform for review. The platform creates a
`Draft` wallet credit that its team approves. A receipt is read from a `File` the **calling user**
uploaded and sent to the platform as base64.

- **Path:** `whatsapp_next.api.v1.billing.request_topup`
- **Methods:** POST
- **Roles:** `MANAGER`

| Argument | Type | Required / default | Meaning |
|---|---|---|---|
| `amount` | float | required | The amount paid. 0.01–1,000,000, rounded to 2 places. |
| `payment_option` | str | required | The `name` of one of `get_billing().payment.methods`. At most 140 characters. |
| `reference_no` | str | one of `reference_no` / `receipt_file` | The transfer number. At most 140 characters. |
| `remarks` | str | optional | A note for the reviewer. At most 500 characters. |
| `receipt_file` | str | one of `reference_no` / `receipt_file` | The `file_url` of a `File` owned by the caller: PDF, JPG, PNG or WebP, at most 5 MB. At most 500 characters. |
| `plan_code` | str | optional | A plan to move to once the top-up is approved. At most 140 characters. |

**Returns:**

```json
{"ok": true, "transaction": "WTX-0045", "status": "Draft", "amount": 50.0, "currency": "USD"}
```

**Errors:**

| Exception | HTTP | When |
|---|---|---|
| `WAValidationError` | 417 | `amount` ≤ 0, no `payment_option`, neither `reference_no` nor `receipt_file`, a receipt that isn't the caller's ("Upload the receipt again."), of the wrong type, or over 5 MB, or a payment method the platform doesn't offer for the customer's country |
| Provider errors (mapped, README §5) | 4xx/5xx | The platform refused the request |

**Realtime:** none.

```js
await sanad.ui.call("billing.request_topup", {
  amount: 50, payment_option: "PM-0001", reference_no: "TRX-778812", receipt_file: "/private/files/receipt.pdf",
});
```

---

## start_paypal

Starts a PayPal top-up. The page sends the payer to `approve_url`. PayPal brings them back to
`/app/wa-home?wa_paypal=1` on this site with its own `token` (the order id) and
`paypal=return|cancel`, where the settings window calls `confirm_paypal`.

- **Path:** `whatsapp_next.api.v1.billing.start_paypal`
- **Methods:** POST
- **Roles:** `MANAGER`

| Argument | Type | Required / default | Meaning |
|---|---|---|---|
| `amount` | float | required | The amount to add. 0.01–1,000,000, rounded to 2 places. |
| `plan_code` | str | optional | A plan to move to once the payment is credited. At most 140 characters. |

**Returns:**

```json
{"ok": true, "order_id": "5O190127TN364715T",
 "approve_url": "https://www.paypal.com/checkoutnow?token=5O190127TN364715T"}
```

**Errors:** `WAValidationError` (417) for `amount` ≤ 0, or when the platform refuses the return
address (it must be on this account's own site). `WARateLimitError` (429) above the platform's
10 starts a minute. Provider errors are mapped.
**Realtime:** none.

```js
const { approve_url } = await sanad.ui.call("billing.start_paypal", { amount: 25 });
window.location.href = approve_url;
```

---

## confirm_paypal

Captures a PayPal payment on the payer's return and credits the wallet. It is safe to repeat: the
wallet is credited once, however often it is asked.

- **Path:** `whatsapp_next.api.v1.billing.confirm_paypal`
- **Methods:** POST
- **Roles:** `MANAGER`

| Argument | Type | Required / default | Meaning |
|---|---|---|---|
| `order_id` | str | required | PayPal's `token` from the return address. At most 64 characters. |

**Returns.** On success, `state` is `completed` and `transaction` is the wallet credit:

```json
{"ok": true, "state": "completed",
 "transaction": {"name": "WTX-0046", "amount": 25.0, "currency": "USD",
                 "requested_plan": null, "requested_plan_applied": 0}}
```

The platform answers `pending`, `not_approved` and `failed` with `ok: false`. The provider turns
any `ok: false` answer into an error, so these states reach the caller as
`WAProviderRejectedError` (422), not as a returned `state`.

**Errors:** `WAValidationError` (417) for an empty or unknown order, a payment PayPal couldn't
complete, or an amount that doesn't match the top-up. `WAProviderRejectedError` (422) for the
`pending`, `not_approved` and `failed` states (see above). `WARateLimitError` (429) above the
platform's 20 confirmations a minute.
**Realtime:** none.

```js
const paid = await sanad.ui.call("billing.confirm_paypal", { order_id: token }, { freeze: true });
```

---

## statement

The account statement for a period: the opening balance, every payment and charge with the
balance after it, and the closing balance.

- **Path:** `whatsapp_next.api.v1.billing.statement`
- **Methods:** GET, POST
- **Roles:** `MANAGER`

| Argument | Type | Required / default | Meaning |
|---|---|---|---|
| `from_date` | str | optional | First day, `YYYY-MM-DD`, inclusive. Defaults to the start of the current month. |
| `to_date` | str | optional | Last day, inclusive. Defaults to the end of the current month. |

**Returns.** Each row has `kind` (`top_up`, `payment`, `charge` or `refund`), the invoice it
belongs to when there is one, and `balance` after it.

```json
{"ok": true, "currency": "USD", "from_date": "2026-11-01", "to_date": "2026-11-30",
 "opening": 10.0, "total_in": 50.0, "total_out": 25.0, "closing": 35.0,
 "rows": [{"date": "2026-11-02", "kind": "top_up", "method": "PayPal", "note": "", "reference": "8XK…",
           "document": "WTX-0046", "invoice": "", "plan": "", "period_start": "", "period_end": "",
           "money_in": 50.0, "money_out": 0.0, "balance": 60.0},
          {"date": "2026-11-03", "kind": "charge", "method": "", "note": "", "reference": "",
           "document": "WTX-0047", "invoice": "WBE-0008", "plan": "Business",
           "period_start": "2026-11-03", "period_end": "2026-12-02",
           "money_in": 0.0, "money_out": 25.0, "balance": 35.0}]}
```

**Errors:** `WAValidationError` (417) when `from_date` is after `to_date`. Provider errors are
mapped.
**Realtime:** none.

```js
const st = await sanad.ui.call("billing.statement", { from_date: "2026-10-01", to_date: "2026-10-31" });
```

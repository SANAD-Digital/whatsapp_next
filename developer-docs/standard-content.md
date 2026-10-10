# Standard content: templates, notifications and alerts

The app ships a ready set of WhatsApp Templates, WhatsApp Notifications and WhatsApp Notification
Alerts for a trading company on ERPNext. The texts are in Arabic. They are **fixtures**:

| File (`whatsapp_next/fixtures/`) | DocType | Records |
|---|---|---|
| `standard_1_whatsapp_template.json` | WhatsApp Template | 12 |
| `standard_2_whatsapp_notification.json` | WhatsApp Notification | 10 |
| `standard_3_whatsapp_notification_alert.json` | WhatsApp Notification Alert | 4 |

They are declared in `hooks.py → fixtures`, and Frappe syncs them on `install-app` and on every
`migrate`. The file prefix sets the import order: templates first, because notifications link to
them.

## What a site gets, and what cannot happen

- **Nothing sends by itself.** Every standard notification and alert is created switched off, with
  no device (the default device is used once you enable one) and no phone number. Recipients are
  document fields and roles. `services/standards.py` forces this when it creates a record, whatever
  the file says.
- **Nothing is site-specific.** No company, print format or letter head is named. A notification
  that attaches the document's PDF uses the DocType's default print format. Amounts are written
  with the document's own currency (`doc.get_formatted`), dates in the site's date format, and the
  signature is the document's company.
- **Importing twice creates nothing twice.** Records are keyed by name.
- **Your own records are not touched.** A record you created that happens to carry a standard name
  is left exactly as it is (see "Names" below).

## What a migrate does to a record that already exists

Frappe's fixture sync replaces every fixture record on every migrate. For content that the owner
of a site switches on and adjusts, that would undo his work, so the three controllers hand the
import to `services/standards.py` (through Frappe's own import hooks `prepare_for_import`,
`before_import` and `after_insert`). The rules:

| | On every migrate |
|---|---|
| **Site-owned state** — always kept | Template: `disabled`, `attachment`, `print_format`, `letter_head`, `file_name_template`, `use_count`, `last_used_at`. Notification: `enabled`, `device`, `recipients`, `print_format`, `letter_head`, `send_count`, `last_sent_at`, `last_error`, `last_error_at`. Alert: `enabled`, `device`, `recipients`, `filters_json` (company and the other static report filters), `print_format`, `letter_head`, `send_count`, `last_sent_at`, `next_run_at`, `last_error`. Also `creation`, `owner`, and `modified` when nothing changed. |
| **Shipped content, not edited by the owner** — follows the app | Everything else: the text, the document type, event, condition, days, the report, the schedule, the message type. A new version of the app can correct a text and the site gets it. |
| **Shipped content the owner edited** — the record is his | If the owner changed any content field (the text of a template, a notification's condition or days, an alert's time or message …), the whole record is kept exactly as he left it. No later migrate changes it. |

So the product behaviour is: **edit a standard record freely; your version stays.** The price is
that a record you edited no longer receives corrections from later versions of the app.

How the app knows whether the owner edited a record: when a record is written from the fixture,
a fingerprint of its content fields is stored in `tabDefaultValue` (parent
`__whatsapp_next_standards`, one row per record). A record whose content still matches its
fingerprint has not been edited. A record with no fingerprint is treated as the owner's.

Other cases:

- **Deleted**: a standard record you delete comes back, switched off, on the next migrate. To
  stop using one, leave it disabled.
- **Renamed**: the renamed record is yours (it no longer has a standard name); the standard one
  comes back, switched off, on the next migrate.
- **Back to the shipped version**: `standards.restore(doctype, name)` writes the shipped content
  again and keeps the site-owned state:

  ```bash
  bench --site <site> execute whatsapp_next.services.standards.restore \
    --kwargs '{"doctype": "WhatsApp Template", "name": "إشعار فاتورة مبيعات"}'
  ```

- **What state is each record in**: `bench --site <site> execute
  whatsapp_next.services.standards.overview` prints `{doctype, name, exists, enabled, customised}`
  for all 26. `standards.status(doctype, name)` returns `{standard, customised}` for one record;
  a screen can use it to mark standard records.

## Start using one

1. Connect a device and mark it as the default (Devices), or pick a device on the record.
2. **A notification** (WhatsApp → Notifications): open it, read the preview on one of your
   documents, check the recipients, then enable it.
   - Recipients default to the document's mobile number (`contact_mobile`) and fall back to the
     customer's or supplier's own mobile number. A document with neither is skipped and the reason
     is written on the notification ("no valid number").
   - A notification that sends the PDF uses the default print format of the document. To use
     another one, or a letter head, choose them on the notification.
3. **An alert** (WhatsApp → Notification Alerts): open it and check the **company** in the report
   filters. It is filled with the site's default company when the record is created (on a site
   that had no company yet, the next migrate fills it in). Choose the recipients: a role sends to
   every enabled user of that role who has a mobile number on his user record. Run the preview,
   then enable it.
4. **A template** needs nothing: quick send and bulk send offer it as soon as it exists. `عرض ترويجي` ships disabled because it is a skeleton: write your offer in place of
   the brackets, then enable it.

## The set

### Templates

| Name | For | Use |
|---|---|---|
| `إشعار فاتورة مبيعات` | Sales Invoice | The invoice was issued: number, date, item count, total, due date |
| `إشعار سند قبض` | Payment Entry | Amount received, receipt number, mode of payment, what was paid of each invoice and what is left |
| `شكر على سداد فاتورة` | Sales Invoice | Thanks for paying the invoice in full |
| `تذكير قبل استحقاق فاتورة` | Sales Invoice | The invoice is due on a date; amount left |
| `تذكير بفاتورة متأخرة` | Sales Invoice | The invoice was due some days ago; amount left |
| `تأكيد طلب بيع` | Sales Order | Order confirmed: items, total, delivery date |
| `تذكير بموعد تسليم طلب` | Sales Order | Delivery date reminder |
| `إشعار تسليم بضاعة` | Delivery Note | Goods delivered: items, a request to check quantities |
| `عرض سعر` | Quotation | Quotation: items, total, valid until |
| `أمر شراء للمورد` | Purchase Order | To the supplier: items, total, required date |
| `رسالة ترحيب` | — | A welcome message for a new customer or a first contact; needs no document |
| `عرض ترويجي` | — | Skeleton of an offer / campaign caption. Ships **disabled** |

### Notifications (all ship disabled)

| Name | Document, event | Condition | Sends |
|---|---|---|---|
| `فاتورة مبيعات عند الاعتماد` | Sales Invoice, Submit | not a return | `إشعار فاتورة مبيعات` + the invoice PDF |
| `سند قبض عند الاعتماد` | Payment Entry, Submit | received from a customer | `إشعار سند قبض` + the receipt PDF |
| `شكر عند سداد الفاتورة كاملة` | Sales Invoice, `status` changes | status is Paid, not a return, not POS | `شكر على سداد فاتورة` |
| `تذكير قبل استحقاق الفاتورة` | Sales Invoice, 2 days before `due_date` | amount left, not a return | `تذكير قبل استحقاق فاتورة` |
| `تذكير بعد استحقاق الفاتورة` | Sales Invoice, 3 days after `due_date` | amount left, not a return | `تذكير بفاتورة متأخرة` |
| `تأكيد طلب بيع عند الاعتماد` | Sales Order, Submit | — | `تأكيد طلب بيع` + the order PDF |
| `تذكير قبل تسليم الطلب` | Sales Order, 1 day before `delivery_date` | not completed, closed or on hold; not fully delivered | `تذكير بموعد تسليم طلب` |
| `إشعار تسليم عند الاعتماد` | Delivery Note, Submit | not a return | `إشعار تسليم بضاعة` |
| `عرض سعر عند الاعتماد` | Quotation, Submit | — | `عرض سعر` + the quotation PDF |
| `أمر شراء للمورد عند الاعتماد` | Purchase Order, Submit | — | `أمر شراء للمورد` + the order PDF, to the supplier |

### Alerts (all ship disabled; PDF attached; language Arabic)

| Name | Report | Schedule | To |
|---|---|---|---|
| `أرصدة العملاء المدينة` | Accounts Receivable Summary, as of today | daily 08:00 | role Accounts Manager |
| `أرصدة الموردين الدائنة` | Accounts Payable Summary, as of today | weekly, Sunday 09:00 | role Accounts Manager |
| `ملخص المبيعات اليومي` | Sales Register, today | daily 20:00 | role Sales Manager |
| `حركة الحسابات لليوم السابق` | General Ledger, yesterday, grouped by voucher | daily 08:30 | role Accounts Manager |

A customer statement is the same General Ledger report with a `party` filter. It needs a customer
of the site, so it is not shipped: create an alert of your own for it.

## Names

Names are Arabic, because the names are what the Arabic interface lists, what a link field
searches, and what the PDF of an alert is called when it reaches a manager's phone
(`أرصدة_العملاء_المدينة.pdf`). A name is the record's identity in the fixture: **never rename a
shipped record in the files**. To retire one, remove it from the file and from `hooks.py`; sites
keep their copy as an ordinary record.

No prefix marks the standard records. If a site already has a record with one of these names, it
has no fingerprint, so the sync leaves it alone and the standard record of that name is simply
not installed there.

## Changing or adding standard content (developers)

1. Edit the JSON file by hand. A record carries only content: no `enabled: 1`, no `device`, no
   counters, no phone number, no company (use `"company": "__default_company__"` in an alert's
   `filters_json`; it becomes the site's default company on the site).
2. Add the name to the matching list in `hooks.py → fixtures`.
3. Run `bench --site <site> run-tests --app whatsapp_next --module whatsapp_next.tests.test_standards`.
   It checks that hooks and files agree, that every link exists on a plain ERPNext site, that
   every record passes its controller, renders on a minimal document and ships switched off, and
   that a sync keeps the site's state.
4. Apply on a development site with
   `bench --site <site> execute frappe.utils.fixtures.sync_fixtures --kwargs '{"app": "whatsapp_next"}'`.

**Do not run `bench export-fixtures` for this app on a site in use.** It writes the site's records
into the files, with that site's state (enabled, device, recipients, counters). The test in step 3
fails when that happened.

A template body may use what every message body may use (`services/templates.py`): `doc`,
`recipient`, `today`, `now`, `_`, `frappe.utils`, `frappe.format_value`, and
`doc.get_formatted(fieldname)`. An alert's message also gets `rows`, `columns`, `filters`,
`row_count`. A report's last row is usually a totals row that is a list, not a dict: filter rows
with `selectattr` on a field only real rows have.

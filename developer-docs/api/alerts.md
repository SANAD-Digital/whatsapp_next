# Notification Alerts API (`alerts.*`)

Module: `whatsapp_next/api/v1/alerts.py` — the WhatsApp Notification Alert form (scheduled report /
static-message alerts, D-016) and its editor window (D-139). Thin wrappers over
`whatsapp_next/services/alerts.py` (running an alert), `services/alerts_dates.py` (dynamic filter
tokens) and `services/alerts_editor.py` (the editor's reads, draft preview, test send and writes).

URL form, authentication, the error envelope and the role groups are in [README.md](README.md).
Every endpoint requires the `MANAGER` role group and also answers **403** (`WAPermissionError`)
without it, and **417** (`WAValidationError`) for an unknown, missing or untypeable argument.
Returns are shown as the value of the response's `message` key.

## Concepts

**Alert fields a payload may carry** (`alerts_editor.FIELDS`; anything else is refused):

| Field | Values |
|---|---|
| `alert_name` | Name of the alert (a changed name renames the document on save). |
| `enabled` | 0 / 1 |
| `periodicity` | `Daily`, `Weekly`, `Monthly`, `Quarterly`, `Yearly` |
| `day_of_week`, `day_of_month`, `month_of_year`, `notification_time` (`HH:MM`) | Schedule. |
| `content_type` | `Report` or `Static Message` |
| `report` | A `Report` name. |
| `filters_json` | Static report filters: an object, or a list for a Report Builder report (object / list or its JSON text). |
| `dynamic_filters_json` | `{field: token}`; tokens below. Dynamic values win over static ones. |
| `template` | A `WhatsApp Template` (its body wins over `message`). |
| `message` | Jinja body. |
| `attachment_format` | `None`, `PDF`, `PNG` (PNG needs `wkhtmltoimage`; otherwise PDF is built). |
| `print_format`, `letter_head`, `language`, `device` | Rendering options and sending device. |
| `recipients` | List of `{recipient_type, user, role, phone, report_column}`; `recipient_type` is `User`, `Role`, `Phone` or `Report Column`. |

Plus `name` (the saved alert to change; absent for a new one).

**Recipients.** `User` → the user's `mobile_no` (else `phone`) if enabled; `Role` → every enabled
user of the role; `Phone` → the number; `Report Column` → one recipient per distinct value of that
column (max 200), each receiving only its own rows.

**Message context.** `rows`, `columns`, `report`, `alert` (the alert as a dict), `filters`,
`row_count`, `recipient`, plus the standard globals.

**Dynamic filter tokens** (`alerts_dates.TOKENS`): `today`, `yesterday`, `tomorrow`,
`week_start`, `week_end`, `month_start`, `month_end`, `quarter_start`, `quarter_end`,
`year_start`, `year_end`, `fiscal_year_start`, `fiscal_year_end`, `last_days:N` (start of the last
N days), `days_ago:N`, `days_ahead:N`. Each resolves to `YYYY-MM-DD`; an unknown token is used as a
literal value.

---

## preview

Render a **saved** alert without sending (no outbound rows, counters untouched).

- **Path:** `whatsapp_next.api.v1.alerts.preview`
- **Methods:** POST
- **Roles:** `MANAGER` + read on the alert

| Argument | Type | Required | Meaning |
|---|---|---|---|
| `name` | str | yes | `WhatsApp Notification Alert` name. |

**Returns**

```json
{ "row_count": 14, "message": "Overdue invoices: 14 rows", "recipients_count": 3, "attachment_name": "overdue_invoices.pdf", "error": null }
```

`attachment_name` is the file the first recipient would receive (named, not built, in a preview).
Failures while running the report are returned in `error` (`<ExceptionName>: <message>`), never
raised.

**Errors:** `frappe.PermissionError` (403) — no read on the alert; `frappe.DoesNotExistError`
(404) — unknown alert.

**Realtime:** none.

```js
const r = await sanad.ui.call("alerts.preview", { name: "Overdue invoices" });
```

---

## run_now

Run a saved alert now, in the background.

- **Path:** `whatsapp_next.api.v1.alerts.run_now`
- **Methods:** POST
- **Roles:** `MANAGER` + read on the alert

| Argument | Type | Required | Meaning |
|---|---|---|---|
| `name` | str | yes | Alert name. |

Enqueues `services.alerts.run_alert` on the `long` queue (job id `wa-alert-now-<name>`,
de-duplicated, after commit, 900 s timeout). The job sends one outbound per recipient at priority
3 and updates `send_count`, `last_sent_at`, `next_run_at` and `last_error`.

**Returns**

```json
{ "job_id": null }
```

`job_id` is **always `null`** in practice: the job is enqueued with `enqueue_after_commit=True`,
and Frappe's `enqueue` returns nothing in that mode (the docstring promises the id). Track the run
through the alert's `last_sent_at` / `last_error` or the `WhatsApp Log` rows instead.

**Realtime:** none directly; sends report progress as `wa:message:status`.

```bash
curl -X POST "https://site/api/method/whatsapp_next.api.v1.alerts.run_now" \
  -H "Authorization: token <api_key>:<api_secret>" -d name="Overdue invoices"
```

---

## get_report_columns

Column choices for the `Report Column` recipient type.

- **Path:** `whatsapp_next.api.v1.alerts.get_report_columns`
- **Methods:** GET, POST
- **Roles:** `MANAGER` (the report run applies the caller's own report permissions)

| Argument | Type | Required | Meaning |
|---|---|---|---|
| `report` | str | yes | Report name. |
| `filters` | dict, list or JSON string | optional | Filters to run it with (a list for a Report Builder report). |

**Returns** — `[]` when the report cannot run or the caller may not run it:

```json
[{ "fieldname": "customer", "label": "Customer", "fieldtype": "Link" }]
```

**Realtime:** none.

```js
const cols = await sanad.ui.call("alerts.get_report_columns", { report: "Accounts Receivable", filters: { company: "Sanad" } });
```

---

## get_dynamic_filter_reference

Every dynamic-filter token with today's value (`N` tokens exemplified with 7).

- **Path:** `whatsapp_next.api.v1.alerts.get_dynamic_filter_reference`
- **Methods:** GET, POST
- **Roles:** `MANAGER`

No arguments.

**Returns**

```json
[
  { "name": "today", "example": "2026-09-28" },
  { "name": "last_days:N", "example": "2026-09-21" }
]
```

**Realtime:** none.

```js
const tokens = await sanad.ui.call("alerts.get_dynamic_filter_reference");
```

---

## get_editor

Everything the editor window opens with.

- **Path:** `whatsapp_next.api.v1.alerts.get_editor`
- **Methods:** GET, POST
- **Roles:** `MANAGER` + read on the alert (existing) or create permission (new)

| Argument | Type | Required | Meaning |
|---|---|---|---|
| `name` | str | optional | Alert to open; omit for a new alert. |

**Returns**

```json
{
  "alert": { "name": "Overdue invoices", "alert_name": "Overdue invoices", "enabled": 1, "periodicity": "Daily",
             "day_of_week": "Sunday", "day_of_month": 1, "month_of_year": "January", "notification_time": "08:00",
             "content_type": "Report", "report": "Accounts Receivable", "filters_json": null, "dynamic_filters_json": null,
             "template": null, "message": "{{ report }}: {{ row_count }} rows", "attachment_format": "PDF",
             "print_format": null, "letter_head": null, "language": null, "device": "WAD-0001",
             "recipients": [{ "recipient_type": "Role", "user": null, "role": "Accounts Manager", "phone": null, "report_column": null, "phone_e164": null }] },
  "stats": { "send_count": 30, "last_sent_at": "…", "next_run_at": "…", "last_error": null },
  "recent": [{ "name": "WAL-0000300", "phone_e164": "+966500000002", "display_name": "Sara", "status": "Read", "message_type": "Document", "creation": "…" }],
  "options": { "periodicity": ["Daily", "Weekly", "Monthly", "Quarterly", "Yearly"], "day_of_week": ["…"], "month_of_year": ["…"],
               "content_type": ["Report", "Static Message"], "attachment_format": ["None", "PDF", "PNG"],
               "recipient_type": ["User", "Role", "Phone", "Report Column"] },
  "devices": [{ "name": "WAD-0001", "device_name": "Main", "phone_e164": "+966500000001", "status": "Connected", "is_default": 1 }],
  "templates": [{ "name": "Overdue", "template_name": "Overdue", "category": "Utility" }],
  "tokens": [{ "name": "today", "example": "2026-09-28" }],
  "variables": [{ "code": "{{ row_count }}", "label": "Rows in the report" }],
  "png_available": false,
  "me": { "phone": "+966500000009" },
  "can_write": true,
  "can_delete": true
}
```

For a new alert `alert` holds defaults (`Daily` at `08:00`, `Report`, `PDF`, the default enabled
device, message `{{ report }}: {{ row_count }} rows`), and `stats` / `recent` are empty. `recent`
is the last 5 sends; `templates` the first 200 enabled templates; `me.phone` the caller's own
number (for "send a test to me").

**Errors:** `WANotFoundError` (404) — unknown alert; `frappe.PermissionError` (403) — no read /
create.

**Realtime:** none.

```js
const ed = await sanad.ui.call("alerts.get_editor", { name: "Overdue invoices" });
```

---

## preview_draft

Run the editor's draft — saved or not — without saving or sending.

- **Path:** `whatsapp_next.api.v1.alerts.preview_draft`
- **Methods:** POST
- **Roles:** `MANAGER`

| Argument | Type | Required | Meaning |
|---|---|---|---|
| `payload` | dict | yes | Alert fields (see above); with `name`, applied over the saved alert in memory. |

**Returns**

```json
{
  "problem": null,
  "next_runs": ["2026-09-29 08:00:00", "2026-09-30 08:00:00", "2026-10-01 08:00:00"],
  "row_count": 14,
  "column_count": 6,
  "recipients": [{ "phone_e164": "+966500000002", "source": "Role", "rows": 14 }],
  "recipients_count": 3,
  "message": "Accounts Receivable: 14 rows",
  "attachment": { "file_name": "overdue_invoices.pdf", "mime_type": "application/pdf", "message_type": "Document" },
  "error": null
}
```

- `problem`: the first validation message the alert controller raises for the draft, or `null`.
- `next_runs`: the next three occurrences (empty while the schedule is incomplete).
- A `Report` draft with no `report` returns only `problem`, `next_runs`, `row_count: 0`,
  `recipients: []`, `recipients_count: 0`, `message: null`.
- `recipients` lists at most 50; `attachment` is `null` without a file.

**Errors:** `WAValidationError` (417) — `payload must be an object`, `Unknown payload keys: …`,
`recipients must be a list`; `WANotFoundError` (404) — `payload.name` unknown.

**Realtime:** none.

```js
const p = await sanad.ui.call("alerts.preview_draft", { payload: { alert_name: "Test", content_type: "Static Message", message: "Hello", recipients: [] } });
```

---

## send_test

Send the draft once to one number — what its first recipient would receive. No counters, no
schedule change.

- **Path:** `whatsapp_next.api.v1.alerts.send_test`
- **Methods:** POST
- **Roles:** `MANAGER`

| Argument | Type | Required | Meaning |
|---|---|---|---|
| `payload` | dict | yes | Alert draft (as `preview_draft`). |
| `phone` | str | yes | Test number (any format `phone.normalize` accepts). |

A draft with no recipients is given the test number as a `Phone` recipient before validation.
Audited `Alert Test Sent`.

**Returns**

```json
{ "outbound": "WAL-0000301", "phone_e164": "+966500000009", "error": null }
```

**Errors**

| Exception | HTTP | When |
|---|---|---|
| `WAValidationError` | 417 | `Enter a valid phone number`; the draft breaks a controller rule (its message); the run failed (`The test could not be sent: …`), or the report file could not be built because `wkhtmltopdf` is missing; payload errors as in `preview_draft`. |
| `WANotFoundError` | 404 | `payload.name` unknown. |

**Realtime:** none directly; the queued message reports as `wa:message:status`.

```js
await sanad.ui.call("alerts.send_test", { payload: { name: "Overdue invoices" }, phone: "0500000009" });
```

---

## save_editor

Create or update the alert from the payload; the controller validates everything.

- **Path:** `whatsapp_next.api.v1.alerts.save_editor`
- **Methods:** POST
- **Roles:** `MANAGER` + write (existing) / create (new)

| Argument | Type | Required | Meaning |
|---|---|---|---|
| `payload` | dict | yes | Alert fields; `name` present = update. |

On update, a changed `alert_name` renames the document. `recipients`, when present, replaces the
table.

**Returns**

```json
{ "name": "Overdue invoices", "next_run_at": "2026-09-29 08:00:00" }
```

**Errors:** `WAValidationError` (417) — payload errors, `An alert named … already exists`, or any
controller validation; `WANotFoundError` (404); `frappe.PermissionError` (403).

**Realtime:** none.

```bash
curl -X POST "https://site/api/method/whatsapp_next.api.v1.alerts.save_editor" \
  -H "Authorization: token <api_key>:<api_secret>" -H "Content-Type: application/json" \
  -d '{"payload": {"alert_name": "Daily sales", "periodicity": "Daily", "notification_time": "08:00",
       "content_type": "Report", "report": "Sales Register", "dynamic_filters_json": {"from_date": "yesterday", "to_date": "yesterday"},
       "attachment_format": "PDF", "recipients": [{"recipient_type": "Role", "role": "Sales Manager"}]}}'
```

---

## set_enabled

Switch an alert on or off (`next_run_at` is recomputed by the controller).

- **Path:** `whatsapp_next.api.v1.alerts.set_enabled`
- **Methods:** POST
- **Roles:** `MANAGER` + write on the alert

| Argument | Type | Required | Meaning |
|---|---|---|---|
| `name` | str | yes | Alert name. |
| `enabled` | int | yes | Non-zero = on. |

**Returns**

```json
{ "name": "Overdue invoices", "enabled": 0, "next_run_at": null }
```

**Errors:** `WANotFoundError` (404); `frappe.PermissionError` (403); controller validation (417).

**Realtime:** none.

```js
await sanad.ui.call("alerts.set_enabled", { name: "Overdue invoices", enabled: 0 });
```

---

## delete_alert

Delete an alert (its sent messages stay in the log).

- **Path:** `whatsapp_next.api.v1.alerts.delete_alert`
- **Methods:** POST
- **Roles:** `MANAGER` + delete on the alert

| Argument | Type | Required | Meaning |
|---|---|---|---|
| `name` | str | yes | Alert name. |

**Returns**

```json
{ "deleted": true }
```

**Errors:** `WANotFoundError` (404); `frappe.PermissionError` (403).

**Realtime:** none.

```js
await sanad.ui.call("alerts.delete_alert", { name: "Overdue invoices" });
```

---

## search

The editor's pickers, through `frappe.get_list` (the caller's own permissions; 20 rows).

- **Path:** `whatsapp_next.api.v1.alerts.search`
- **Methods:** GET, POST
- **Roles:** `MANAGER`

| Argument | Type | Required | Meaning |
|---|---|---|---|
| `kind` | str | yes | `report`, `user`, `role`, `print_format`, `letter_head` or `language` (enum-checked). |
| `txt` | str | optional | LIKE filter. |

| `kind` | Source | `description` |
|---|---|---|
| `report` | enabled `Report` by name | `<ref_doctype> · <report_type>` |
| `user` | enabled System Users by full name, email or mobile | mobile number or "No mobile number" |
| `role` | enabled roles with desk access | `null` |
| `print_format`, `letter_head` | enabled records by name | `null` |
| `language` | `Language` by name or `language_name` | `null` |

**Returns**

```json
[{ "value": "Accounts Receivable", "label": "Accounts Receivable", "description": "Sales Invoice · Script Report" }]
```

**Errors:** 417 for a `kind` outside the enum.

**Realtime:** none.

```js
const users = await sanad.ui.call("alerts.search", { kind: "user", txt: "sara" });
```

---

## get_report_info

What the editor needs to draw a report's own filters.

- **Path:** `whatsapp_next.api.v1.alerts.get_report_info`
- **Methods:** GET, POST
- **Roles:** `MANAGER` + read on the Report

| Argument | Type | Required | Meaning |
|---|---|---|---|
| `report` | str | yes | Report name. |

A Script / Query / Custom report brings its filter definitions in its own script (the editor loads
it with Frappe's `get_script`); a Report Builder report is a list of `ref_doctype`, and
`saved_filters` are the filters saved with it.

**Returns**

```json
{ "name": "Overdue list", "report_type": "Report Builder", "ref_doctype": "Sales Invoice", "saved_filters": [["Sales Invoice", "status", "=", "Overdue"]] }
```

**Errors:** `WANotFoundError` (404) — `Report … not found`; `frappe.PermissionError` (403).

**Realtime:** none.

```js
const info = await sanad.ui.call("alerts.get_report_info", { report: "Overdue list" });
```

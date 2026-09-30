# Notifications API (`notifications.*`)

Module: `whatsapp_next/api/v1/notifications.py` — the WhatsApp Notification form (document-event
notifications, D-016): a dry preview against one document, field choices for the editor, and a
manual send. Thin wrappers over `whatsapp_next/services/notifications.py`.

URL form, authentication, the error envelope and the role groups are in [README.md](README.md).
Every endpoint also answers **403** (`WAPermissionError`) for a missing role and **417**
(`WAValidationError`) for an unknown, missing or untypeable argument. Returns are shown as the
value of the response's `message` key.

**Recipient sources.** A notification's recipient rows are one of `Document Field` (a phone field
of the document), `Linked Document Field` (a phone field of a linked record) or `Fixed Number`.
Row conditions are honoured, invalid numbers skipped (the last problem is recorded in the
notification's `last_error`), recipients de-duplicated on `phone_e164`.

---

## preview

Evaluate one notification against one document without sending anything.

- **Path:** `whatsapp_next.api.v1.notifications.preview`
- **Methods:** POST
- **Roles:** `MANAGER` + read on the `WhatsApp Notification`

| Argument | Type | Required | Meaning |
|---|---|---|---|
| `name` | str | yes | `WhatsApp Notification` name. |
| `reference_name` | str | yes | A document of the notification's `document_type`. |

The condition is evaluated for the notification's own `event`; the body (template body, else the
notification's `message`) is rendered as the job would for the first recipient.

**Returns**

```json
{
  "meets_condition": true,
  "message": "Dear Ahmed, invoice ACC-SINV-2026-00001 was submitted.",
  "recipients": [{ "phone_e164": "+966*******02", "source": "Document Field" }],
  "errors": []
}
```

- `recipients[].phone_e164` is **masked** (country code and last two digits kept).
- `errors` holds `template: <render error>` and, when the notification's stored `last_error` starts
  with `condition:` or `row `, that message too.

**Errors**

| Exception | HTTP | When |
|---|---|---|
| `frappe.PermissionError` | 403 | No read on the notification. |
| `WANotFoundError` | 404 | `reference_name` does not exist in the notification's DocType. |

**Realtime:** none.

```js
const r = await sanad.ui.call("notifications.preview", { name: "Invoice submitted", reference_name: "ACC-SINV-2026-00001" });
```

---

## get_document_fields

Field choices for the notification editor's selects.

- **Path:** `whatsapp_next.api.v1.notifications.get_document_fields`
- **Methods:** GET, POST
- **Roles:** `MANAGER`

| Argument | Type | Required | Meaning |
|---|---|---|---|
| `document_type` | str | yes | A DocType name. |

Layout fields (`Section Break`, `Column Break`, `Tab Break`, `HTML`, `Button`, `Fold`, `Heading`)
and tables are skipped. `phone_fields` are `Data` / `Phone` fields whose `options` is `Phone` or
whose fieldname contains `phone`, `mobile`, `whatsapp` or `contact_no`.

**Returns**

```json
{
  "date_fields": [{ "fieldname": "due_date", "label": "Due Date", "fieldtype": "Date", "options": null }],
  "datetime_fields": [],
  "phone_fields": [{ "fieldname": "contact_mobile", "label": "Mobile No", "fieldtype": "Data", "options": null }],
  "link_fields": [{ "fieldname": "customer", "label": "Customer", "fieldtype": "Link", "options": "Customer" }],
  "all_fields": [/* every non-layout field, same row shape */]
}
```

`options` is set only for `Link` / `Dynamic Link` fields.

**Errors:** `WAValidationError` (417) — `DocType … not found`.

**Realtime:** none.

```bash
curl -G "https://site/api/method/whatsapp_next.api.v1.notifications.get_document_fields" \
  -H "Authorization: token <api_key>:<api_secret>" -d document_type="Sales Invoice"
```

---

## send_now

Send a notification for one document now, as event `Manual`.

- **Path:** `whatsapp_next.api.v1.notifications.send_now`
- **Methods:** POST
- **Roles:** `MANAGER` + read on the notification + read on the referenced document

| Argument | Type | Required | Meaning |
|---|---|---|---|
| `name` | str | yes | `WhatsApp Notification` name. |
| `reference_name` | str | yes | Document of the notification's `document_type`. |

Runs `send_for_document` synchronously: re-checks `enabled` and the condition, renders the body,
builds the attachment, resolves recipients, and creates one outbound per recipient, queued at
**priority 3**. When something was sent and the notification has `set_property_after_alert`, that
field of the document is set to `property_value`. Updates `send_count`, `last_sent_at` and
(on failure) `last_error` / `last_error_at` on the notification.

**Returns**

```json
{ "outbounds": ["WAL-0000200"], "sent": 1, "skipped": 0, "error": null }
```

- `sent: 0, skipped: 1, error: null` when the notification is disabled, the document is gone, or
  the condition is false.
- `error` carries the render error / `empty body` / attachment error (then `sent: 0, skipped: 1`),
  or the last per-recipient failure (`<ExceptionName>: <message>`) — per-recipient errors such as a
  blacklisted number are caught and counted in `skipped`, not raised.

**Errors**

| Exception | HTTP | When |
|---|---|---|
| `frappe.PermissionError` | 403 | No read on the notification or on the document. |

**Realtime:** none directly; each queued outbound later reports progress as `wa:message:status`.

```js
const r = await sanad.ui.call("notifications.send_now", { name: "Invoice submitted", reference_name: "ACC-SINV-2026-00001" });
```

---

## The editor window

`sanad.ui.NotificationEditor` (opened by `whatsapp_next.notifications.open(name)`) reads and
writes through the endpoints below — thin wrappers over `services/notifications_editor.py`.
Every one is **Manager** (`MANAGER`) plus the document permission it names. The payload is an
allow-list: the notification's own fields (`notification_name`, `enabled`, `document_type`,
`event`, `date_changed`, `days_in_advance`, `datetime_changed`, `minutes_offset`,
`value_changed`, `method`, `condition_type` (`Python` | `Filters`), `filters` (Frappe's filter list, stored as JSON; each field must exist on the document type), `condition`, `device`, `template`, `message`, `message_type`,
`attach_print`, `print_format`, `letter_head`, `attach_field`, `set_property_after_alert`,
`property_value`), `recipients` rows (`recipient_type`, `receiver_by_document_field`,
`linked_document_field`, `linked_mobile_fieldname`, `phone`, `condition`) and `name` when
editing. Any other key → `WAValidationError`.

| Endpoint | Methods | Arguments | Returns |
|---|---|---|---|
| `get_editor` | GET, POST | `name?` | `{notification, stats, recent[], options{event, message_type, recipient_type, method}, devices[], templates[], fields, me{phone}, can_write, can_delete}` — a new one's defaults without `name` (needs **create**). |
| `get_document_setup` | GET, POST | `document_type` | `{fields, templates}` — the type's field choices (as `get_document_fields`) and the enabled templates it can use: its own first, then those written for no type. |
| `preview_draft` | POST | `payload`, `reference_name?` | `{problem, reference_name, meets_condition, message, attachment, recipients[{phone_e164 (masked), source}], recipients_count, error, no_access?}` on the given record or the latest one. Nothing is saved or sent; the saved notification's error fields are not touched. `no_access` when the reader cannot read the document type. |
| `send_test` | POST | `payload`, `phone`, `reference_name?` | `{outbound, phone_e164}` — the draft rendered for one record, queued once to `phone`; the condition is not required and no counter or property changes. Audited `Test Send`. |
| `save_editor` | POST | `payload` | `{name}` — create (needs **create**) or update (**write**); a changed `notification_name` renames it. The controller validates everything. |
| `delete_notification` | POST | `name` | `{deleted: true}` (needs **delete**); sent messages stay in the log. |
| `search` | GET, POST | `kind` (`document_type` \| `print_format` \| `letter_head`), `txt?`, `document_type?` | `[{value, label, description}]` through `frappe.get_list`. Document types exclude child tables, singles and this app's own. |

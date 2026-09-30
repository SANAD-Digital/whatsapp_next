# settings

Module `whatsapp_next/api/v1/settings.py`. These endpoints serve the Settings screen. They read
and write `WhatsApp Settings` through a per-section allow-list, and they never return a secret: a
Password field only appears as a `has_<field>` boolean. They also wrap the connection test, the
subscription and usage cache, the webhook endpoint on the provider, the audit log, and the
ContactPicker source configuration.

Conventions (auth, errors, envelope) are in [README.md](README.md). Role names below refer to
the groups in README §4.

## Sections

`get_settings` and `save_settings` work on these sections:

| Section | Readable fields | Writable by `save_settings` |
|---|---|---|
| `provider` | `provider`, `platform_base_url`, `request_timeout`, `connection_status`, `last_connection_test_at`, `last_connection_latency_ms`, `last_connection_error` | `provider`, `platform_base_url`, `request_timeout` |
| `credentials` | none. Secrets appear only as `has_customer_api_key`, `has_customer_api_secret`, `has_api_key`, `has_api_secret`. | none. Use `onboarding.save_credentials`. |
| `webhook` | `webhook_endpoint`, `webhook_endpoint_url`, `webhook_status`, `webhook_events`, `webhook_max_retries`, `webhook_synced_at`, `webhook_last_event_at`, plus `has_webhook_secret` | `webhook_max_retries` |
| `queue` | `messages_per_minute`, `max_attempts`, `retry_backoff_seconds`, `queue_paused`, `queue_paused_by`, `queue_paused_at`, `queue_pause_reason` | `max_attempts`, `retry_backoff_seconds`. The rate and pause have their own endpoints in [queue.md](queue.md). |
| `commands` | `enable_commands`, `command_service_user`, `unknown_command_reply`, `send_receipt_reply`, `receipt_reply`, `reply_device` | all of these |
| `policy` | `default_device`, `default_country`, `global_blacklist_group`, `send_only_to_known_numbers`, plus the computed `contact_open_to_all` | the four stored fields |
| `picker` | `picker_sources` (rows of `document_type`, `label`, `phone_source`, `phone_fieldname`, `contact_fieldname`, `name_fieldname`, `filters_json`, `enabled`) | `picker_sources` (replaces the whole table) |
| `retention` | `outbound_retention_days`, `inbound_retention_days`, `queue_retention_days`, `webhook_event_retention_days`, `audit_retention_days`, `numbers_watermark`, `numbers_last_run_at` | the five `*_retention_days` fields |
| `subscription` | `plan_code`, `plan_name`, `subscription_status`, `message_limit`, `messages_used`, `messages_remaining`, `plan_messages_per_minute`, `device_limit`, `wallet_balance`, `wallet_currency`, `subscription_start`, `subscription_end`, `plan_features`, `subscription_synced_at` | none (the provider cache; see `sync_subscription`) |
| `onboarding` | `setup_completed`, `setup_completed_at`, `redirect_unregistered_to_wizard` | `redirect_unregistered_to_wizard` |

`contact_open_to_all` is read-only. It comes from `permissions.contact_open_to_all()` and reports
whether the role `All` can still act on the core `Contact` DocType (R-028, D-125).

---

## get_settings

Returns the non-secret Settings values for one section, or for all sections.

- **Path:** `whatsapp_next.api.v1.settings.get_settings`
- **Methods:** GET, POST
- **Roles:** `MANAGER` (WhatsApp Manager, System Manager)

| Argument | Type | Required / default | Meaning |
|---|---|---|---|
| `section` | str | optional, default: all | One of `provider`, `credentials`, `webhook`, `queue`, `commands`, `policy`, `picker`, `retention`, `subscription`, `onboarding` |

**Returns.** An object keyed by section name, each holding the readable fields listed above.

```json
{
  "queue": {
    "messages_per_minute": 20, "max_attempts": 3, "retry_backoff_seconds": 60,
    "queue_paused": 0, "queue_paused_by": null, "queue_paused_at": null, "queue_pause_reason": null
  }
}
```

**Errors:** `WAValidationError` (417) for a `section` outside the enum. `WAPermissionError` (403).

```bash
curl -s "https://<site>/api/method/whatsapp_next.api.v1.settings.get_settings?section=webhook" \
  -H "Authorization: token <api_key>:<api_secret>"
```

---

## save_settings  *(admin-only)*

Writes some fields of one section. It is audited as `Settings Changed` with `fields_written` and
`details.section`.

- **Path:** `whatsapp_next.api.v1.settings.save_settings`
- **Methods:** POST
- **Roles:** `SYSTEM_MANAGER`

| Argument | Type | Required / default | Meaning |
|---|---|---|---|
| `section` | str | required | One of `provider`, `webhook`, `queue`, `commands`, `policy`, `picker`, `retention`, `onboarding` |
| `values` | dict | required | `{fieldname: value}`. Only the section's writable fields are accepted. `picker_sources` must be a list of rows and replaces the whole table. |

**Returns.** `changed` lists only the fields whose value actually changed. An empty list means
nothing was saved.

```json
{"ok": true, "changed": ["max_attempts"]}
```

**Errors:**

| Exception | HTTP | When |
|---|---|---|
| `WAValidationError` | 417 | `Fields not allowed in section …`, an empty `values` ("Nothing to save"), `picker_sources` that isn't a list, or a Settings controller validation (for example an invalid `platform_base_url` or picker `filters_json`) |
| `WAPermissionError` | 403 | The caller is not a System Manager |

```js
await sanad.ui.call("settings.save_settings", { section: "queue", values: { max_attempts: 5 } });
```

---

## test_connection

Runs a health check on the provider. It records `connection_status` (`OK` / `Failed`),
`last_connection_test_at`, `last_connection_latency_ms`, and `last_connection_error`, and is
audited as `Connection Tested`. On success it also refreshes the subscription cache. It **never
raises** on a provider failure: the failure is returned in `error`.

- **Path:** `whatsapp_next.api.v1.settings.test_connection`
- **Methods:** POST
- **Roles:** `MANAGER`

Arguments: none.

**Returns:**

```json
{"ok": true, "latency_ms": 212, "plan_code": "PRO", "error": null}
```

**Errors:** `WAPermissionError` (403) only.

```bash
curl -s -X POST "https://<site>/api/method/whatsapp_next.api.v1.settings.test_connection" \
  -H "Authorization: token <api_key>:<api_secret>"
```

---

## sync_subscription

Refreshes the plan and usage cache from the provider (`get_account`) now. If the stored
`messages_per_minute` is higher than the plan rate, it is lowered to the plan rate.

- **Path:** `whatsapp_next.api.v1.settings.sync_subscription`
- **Methods:** POST
- **Roles:** `MANAGER`

Arguments: none.

**Returns.** `synced_at` plus the cached subscription fields (the `subscription` section).
`plan_features` is parsed JSON and includes a `webhook_events` key.

```json
{
  "synced_at": "2026-09-28 10:00:00",
  "plan_code": "PRO", "plan_name": "Pro", "subscription_status": "Active",
  "message_limit": 10000, "messages_used": 1234, "messages_remaining": 8766,
  "plan_messages_per_minute": 60, "device_limit": 3,
  "wallet_balance": 0.0, "wallet_currency": null,
  "subscription_start": "2026-09-01", "subscription_end": "2026-10-01",
  "plan_features": {"webhook_events": {}}, "subscription_synced_at": "2026-09-28 10:00:00"
}
```

**Errors:** Provider errors are raised here and mapped: `WAProviderAuthError` (424) for bad keys,
`WAProviderUnavailableError` (503), `WARateLimitError` (429), and so on.

```js
const plan = await sanad.ui.call("settings.sync_subscription");
```

---

## get_usage

Returns the provider's usage rows for a period. Results are cached for 10 minutes per
`(from_date, to_date, group_by)`.

- **Path:** `whatsapp_next.api.v1.settings.get_usage`
- **Methods:** GET, POST
- **Roles:** `VIEWER_UP`

| Argument | Type | Required / default | Meaning |
|---|---|---|---|
| `from_date` | date | required | First day |
| `to_date` | date | required | Last day. It must not be before `from_date`. |
| `group_by` | str | `day` | `day`, `week`, or `month` |

**Returns:**

```json
{
  "rows": [{"key": "2026-09-27", "sent": 120, "failed": 2, "units": 120, "rejected": 0}],
  "from": "2026-09-01", "to": "2026-09-28", "group_by": "day"
}
```

**Errors:**

| Exception | HTTP | When |
|---|---|---|
| `WAValidationError` | 417 | `from_date` is after `to_date`, or a bad `group_by` |
| `WANotSupportedError` | 422 | No usage report came back. This happens when the provider can't report usage, **and also** after any other provider failure, because the service logs the error and returns nothing. |

```bash
curl -s "https://<site>/api/method/whatsapp_next.api.v1.settings.get_usage?from_date=2026-09-01&to_date=2026-09-28&group_by=week" \
  -H "Authorization: token <api_key>:<api_secret>"
```

---

## get_site_usage

Counts the messages this site sent each day, from its own `WhatsApp Log`. Every day of the period
is included, zero-filled. This is always available, unlike `get_usage`.

- **Path:** `whatsapp_next.api.v1.settings.get_site_usage`
- **Methods:** GET, POST
- **Roles:** `VIEWER_UP`

| Argument | Type | Required / default | Meaning |
|---|---|---|---|
| `from_date` | date | required | First day |
| `to_date` | date | required | Last day. The period is at most 92 days (`to_date - from_date < 92`). |

**Returns.** `sent` counts Sent + Delivered + Read. `delivered` counts Delivered + Read. `read`
counts Read. `failed` counts Failed. Days are bucketed by the log row's `creation`.

```json
{
  "rows": [{"key": "2026-09-27", "sent": 40, "delivered": 38, "read": 20, "failed": 1}],
  "from": "2026-09-27", "to": "2026-09-28"
}
```

**Errors:** `WAValidationError` (417) when `from_date > to_date` or the period is too long
("A usage period is at most 92 days").

```js
await sanad.ui.call("settings.get_site_usage", { from_date: "2026-09-01", to_date: "2026-09-28" });
```

---

## setup_webhook  *(admin-only)*

Registers the provider webhook endpoint for this site's receiver
(`/api/method/whatsapp_next.webhooks.v1.receiver.receive`), or re-points an existing one. The
base URL is `whatsapp_webhook_base_url` from the site config, else the site URL. This is
idempotent. If no signing secret is stored, it fetches and stores one with `set_password`. It
mirrors the endpoint state into Settings and is audited as `Webhook Changed` (and
`Credentials Changed` when a secret was fetched).

- **Path:** `whatsapp_next.api.v1.settings.setup_webhook`
- **Methods:** POST
- **Roles:** `SYSTEM_MANAGER`

Arguments: none.

**Returns.** The endpoint summary. `consecutive_failures` is always `0` here. `locked_at` and
`lock_reason` are always `null` from this call.

```json
{
  "endpoint_id": "WEP-0001",
  "endpoint_url": "https://<site>/api/method/whatsapp_next.webhooks.v1.receiver.receive",
  "status": "Active",
  "events": ["message.sent", "message.delivered", "message.read", "message.failed", "message.held",
             "message.received", "message.reaction", "connection.connected", "connection.disconnected",
             "connection.logged_out", "group.updated", "group.participants.updated"],
  "max_retries": 3, "consecutive_failures": 0,
  "locked_at": null, "lock_reason": null,
  "last_event_at": null, "synced_at": "2026-09-28 10:00:00"
}
```

**Errors:** Provider errors (mapped) such as `WAProviderAuthError` (424) and
`WAProviderUnavailableError` (503). `WAPermissionError` (403).

```bash
curl -s -X POST "https://<site>/api/method/whatsapp_next.api.v1.settings.setup_webhook" \
  -H "Authorization: token <api_key>:<api_secret>"
```

---

## set_webhook_status  *(admin-only)*

Enables or disables the provider endpoint. `Active` also unlocks a `Locked` endpoint. Audited as
`Webhook Changed`.

- **Path:** `whatsapp_next.api.v1.settings.set_webhook_status`
- **Methods:** POST
- **Roles:** `SYSTEM_MANAGER`

| Argument | Type | Required / default | Meaning |
|---|---|---|---|
| `status` | str | required | `Active` or `Disabled` |

**Returns:** `{"status": "Disabled"}`

**Errors:** `WAValidationError` (417) for a bad status, or when "No webhook endpoint is
registered yet". Provider errors are mapped.

```js
await sanad.ui.call("settings.set_webhook_status", { status: "Active" });
```

---

## set_webhook_events  *(admin-only)*

Replaces the list of subscribed events on the provider endpoint. Canonical names only. Audited as
`Webhook Changed`.

- **Path:** `whatsapp_next.api.v1.settings.set_webhook_events`
- **Methods:** POST
- **Roles:** `SYSTEM_MANAGER`

| Argument | Type | Required / default | Meaning |
|---|---|---|---|
| `events` | list[str] | required, non-empty | A subset of `message.received`, `message.sent`, `message.delivered`, `message.read`, `message.failed`, `message.held`, `message.reaction`, `connection.connected`, `connection.disconnected`, `connection.logged_out`, `group.updated`, `group.participants.updated`, `test.webhook` |

**Returns:** `{"events": ["message.received", "message.failed"]}`

**Errors:** `WAValidationError` (417) "Unknown webhook events: …" for an unknown name or an empty
list. Provider errors are mapped.

```bash
curl -s -X POST "https://<site>/api/method/whatsapp_next.api.v1.settings.set_webhook_events" \
  -H "Authorization: token <api_key>:<api_secret>" -H "Content-Type: application/json" \
  -d '{"events": ["message.received", "message.delivered", "message.read", "message.failed"]}'
```

---

## rotate_webhook_secret  *(admin-only)*

Fetches the webhook signing secret from the provider again, for use after the secret was rotated
on the platform. It is stored with `set_password`, never returned, and the webhook
signature-failure counter is reset. Audited as `Credentials Changed` and `Webhook Changed`.

- **Path:** `whatsapp_next.api.v1.settings.rotate_webhook_secret`
- **Methods:** POST
- **Roles:** `SYSTEM_MANAGER`

Arguments: none.

**Returns:** `{"rotated_at": "2026-09-28 10:05:00"}`. This is the value of
`credentials_updated_at`.

**Errors:** `WAProviderUnavailableError` (503) "The provider did not return a webhook secret". The
underlying provider error is logged, not raised.

```js
await sanad.ui.call("settings.rotate_webhook_secret");
```

---

## test_webhook

Asks the provider to deliver a `test.webhook` event to this site. Audited as
`Connection Tested`.

- **Path:** `whatsapp_next.api.v1.settings.test_webhook`
- **Methods:** POST
- **Roles:** `MANAGER`

Arguments: none.

**Returns.** `detail` holds the provider's answer, limited to the keys `ok`, `status`,
`http_status`, `http_status_code`, `delivered_at`, and `error`.

```json
{"status": "ok", "http_status_code": 200, "detail": {"ok": true, "http_status_code": 200}}
```

**Errors:** `WAValidationError` (417) "No webhook endpoint is registered yet". Provider errors are
mapped.

```bash
curl -s -X POST "https://<site>/api/method/whatsapp_next.api.v1.settings.test_webhook" \
  -H "Authorization: token <api_key>:<api_secret>"
```

---

## list_webhook_events_available

Returns the events the provider offers, each marked with whether this site subscribes to it.

- **Path:** `whatsapp_next.api.v1.settings.list_webhook_events_available`
- **Methods:** GET, POST
- **Roles:** `MANAGER`

Arguments: none.

**Returns:**

```json
[{"event_name": "message.read", "enabled": true, "disabled_reason": null, "subscribed": true}]
```

**Errors:** Provider errors are mapped.

```js
const events = await sanad.ui.call("settings.list_webhook_events_available");
```

---

## list_audit_log

Returns `WhatsApp Audit Log` rows, newest first (`timestamp desc, name desc`).

- **Path:** `whatsapp_next.api.v1.settings.list_audit_log`
- **Methods:** GET, POST
- **Roles:** `MANAGER`

| Argument | Type | Required / default | Meaning |
|---|---|---|---|
| `filters` | dict | optional | Only the keys `action`, `user`, `from`, `to` (datetimes). `from` + `to` becomes a `between` filter on `timestamp`. |
| `page` | int | 1 | 1-based page |
| `page_length` | int | 20 | Capped at 200 |

**Returns.** Each row has `name`, `action`, `severity`, `summary`, `user`, `job_name`,
`timestamp`, `reference_doctype`, `reference_name`, `target_doctype`, `target_name`,
`fields_written`, `reason`, `count`, `ip_address`, and `details`.

```json
{"rows": [{"name": "…", "action": "Queue Paused", "severity": "Info", "user": "a@x.com",
           "timestamp": "2026-09-28 09:00:00", "count": null, "details": "{\"scope\": \"global\"}"}],
 "total": 57}
```

**Errors:** `WAValidationError` (417) "Unknown filters: …".

```bash
curl -s -G "https://<site>/api/method/whatsapp_next.api.v1.settings.list_audit_log" \
  -H "Authorization: token <api_key>:<api_secret>" \
  --data-urlencode 'filters={"action": "Bulk Send"}' --data-urlencode 'page_length=50'
```

---

## list_picker_sources

Returns the configured `WhatsApp Settings Picker Source` rows, which make up ContactPicker
source 3.

- **Path:** `whatsapp_next.api.v1.settings.list_picker_sources`
- **Methods:** GET, POST
- **Roles:** `AGENT_UP` + `CONTACT_USER`

Arguments: none.

**Returns:**

```json
[{"document_type": "Customer", "label": "Customers", "phone_source": "Field",
  "phone_fieldname": "mobile_no", "contact_fieldname": null, "name_fieldname": "customer_name",
  "filters_json": null, "enabled": 1}]
```

**Errors:** `WAPermissionError` (403).

```js
const sources = await sanad.ui.call("settings.list_picker_sources");
```

---

## get_doctype_fields

Returns the candidate phone, name, and link fields of a regular DocType. The picker-source form
and the notification recipient selects use it. The first entry is always `name`.

- **Path:** `whatsapp_next.api.v1.settings.get_doctype_fields`
- **Methods:** GET, POST
- **Roles:** `MANAGER`

| Argument | Type | Required / default | Meaning |
|---|---|---|---|
| `document_type` | str | required | A regular DocType, not a child table and not a Single |

**Returns.** Fields of type `Data`, `Phone`, `Link`, `Dynamic Link`, and `Small Text`. Labels are
translated.

```json
[{"fieldname": "name", "label": "ID", "fieldtype": "Data", "options": null},
 {"fieldname": "mobile_no", "label": "Mobile No", "fieldtype": "Data", "options": "Phone"}]
```

**Errors:** `WAValidationError` (417) "DocType … not found", or "… must be a regular DocType".

```bash
curl -s "https://<site>/api/method/whatsapp_next.api.v1.settings.get_doctype_fields?document_type=Customer" \
  -H "Authorization: token <api_key>:<api_secret>"
```

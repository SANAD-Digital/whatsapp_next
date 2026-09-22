# Fields — `snd_whatsapp_platform` (branch `whatsapp-next-integration`)

Field-level design for every DocType that `06-doctypes-gap-platform.md` marks *reuse with changes* or
*create new*. Platform repo was read-only; existing fieldnames and `field_order` were taken from the
JSON under `../snd_whatsapp_platform/snd_whatsapp_platform/snd_whatsapp_platform/doctype/<name>/<name>.json`.
Frappe on the bench is 16.28.0 (`JSON` fieldtype and the `ignore_links_on_delete` hook are available).

## Purpose

| Item | Value |
|---|---|
| Rule | Additive only (`platform.md`); the single non-additive change is `Webhook Endpoint.status` (D-018) |
| Secrets | `Password` fieldtype, never logged, never returned except a one-time reveal (`security.md`) — every such field is flagged **PW** below |
| Phone numbers | Every phone column (`recipient_no`, `phone_number`, `mobile_no`, `sender_mobile_no` in payloads) stores normalized E.164 (`+9665…`); normalization happens in code on write, no schema change |
| Column legend | `reqd/unique/ilv/isf` = 1 or `–`; `pl` = permlevel (0 unless stated); *insert after* = fieldname in `field_order` the new field follows |
| Open questions designed for | OQ-1 = count per HTTP attempt, reset on 2xx, cancel `Retrying` logs on lock · OQ-2 = per-link `strict_client_ref` flag, enforced in code · OQ-6 = accept read at permlevel 0 for Support (alternatives noted in §Open questions) |
| Out of scope | Client DocTypes (`plan/fields.md`); data-only changes (D-019 dev tenant plan); retention/history (D-021) |

## Inventory

### 1. WhatsApp Webhook Endpoint (changed — D-018, PG-01, screen 15 webhook section)

Existing order kept: `… status … last_failure_at, last_failure_reason, [new block], wa_admin_sync_section …`. Existing `secret` is already **PW** (F-17 code fix: write via `set_password`, never `db_set`).

| fieldname | label | fieldtype | options | reqd | unique | default | ilv | isf | depends_on | pl | description | serves | insert after |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `status` (**changed**) | Status | Select | `Active\nDisabled\nLocked\nRevoked` | 1 | – | `Active` | 1 | 1 | – | 0 | `Locked` is set by the platform after N consecutive failed delivery attempts; only `Active` receives events. Old value `Failed` renamed by patch | D-018, spec screen 15 states | unchanged position |
| `last_http_status` | Last HTTP Status | Int | – | – | – | – | – | – | – | 0 | HTTP code of the most recent delivery attempt (0 = network/timeout). read_only | screen 15 health, 06 table 2 | `last_failure_reason` |
| `lock_section` | Failure Lock | Section Break | – | – | – | – | – | – | – | 0 | collapsible=1 | – | `last_http_status` |
| `consecutive_failures` | Consecutive Failures | Int | – | – | – | `0` | 1 | – | – | 0 | Incremented per failed HTTP **attempt**, reset to 0 on any 2xx (OQ-1). read_only | PG-01, PF-06 | `lock_section` |
| `lock_after_failures` | Lock After Failures | Int | – | – | – | `5` | – | – | – | 0 | Lock when `consecutive_failures` reaches this value. 0 = use `WhatsApp Platform Settings.webhook_lock_after_failures_default`. Validate 0–100. Settable via `create/update_webhook_endpoint_api` | D-018, A-06 | `consecutive_failures` |
| `lock_cb` | – | Column Break | – | – | – | – | – | – | – | 0 | – | – | `lock_after_failures` |
| `locked_at` | Locked At | Datetime | – | – | – | – | – | – | `eval:doc.status=="Locked" \|\| doc.locked_at` | 0 | read_only; set with the transition, kept after unlock for history until next lock | screen 15 "why/when" | `lock_cb` |
| `lock_reason` | Lock Reason | Small Text | – | – | – | – | – | – | `eval:doc.status=="Locked" \|\| doc.lock_reason` | 0 | read_only; e.g. `5 consecutive failures, last HTTP 503` — never contains payload | screen 15 | `locked_at` |
| `unlocked_at` | Unlocked At | Datetime | – | – | – | – | – | – | `eval:doc.unlocked_at` | 0 | read_only; set by `update_webhook_endpoint_api(status="Active")` or desk; clears `consecutive_failures` | A-06 | `lock_reason` |

Permissions to add (additive rows): `WhatsApp System Manager` read/write/create; `WhatsApp Support User` read.
Patch `rename_failed_webhook_endpoints_to_locked` (post_model_sync): `UPDATE \`tabWhatsApp Webhook Endpoint\` SET status='Locked', lock_reason='Migrated from Failed', locked_at=modified WHERE status='Failed'`; then `UPDATE … SET consecutive_failures=0 WHERE consecutive_failures IS NULL`. A Select option change does not alter the DB column, so the patch is a plain UPDATE; run it after the DocType sync.

### 2. WhatsApp Webhook Event (child, changed — PG-02, D-024, screen 9 held state)

| fieldname | label | fieldtype | options | reqd | unique | default | ilv | isf | depends_on | pl | description | serves | insert after |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `event_name` (**changed**) | Event Name | Select | `message.received\nmessage.sent\nmessage.delivered\nmessage.read\nmessage.failed\nmessage.held\nmessage.reaction\nconnection.connected\nconnection.disconnected\nconnection.logged_out\ngroup.updated\ngroup.participants.updated` | 1 | – | – | 1 | – | – | 0 | `message.held` added after `message.failed`, same order as `SUPPORTED_WEBHOOK_EVENTS`; plan gate stays `webhook_message_failed` (code) | G-06, PG-02 | unchanged |

No patch needed (option addition only).

### 3. WhatsApp Webhook Delivery Log (changed — PG-09, PF-01, PF-07)

| fieldname | label | fieldtype | options | reqd | unique | default | ilv | isf | depends_on | pl | description | serves | insert after |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `device` | Device | Link | `WhatsApp Device` | – | – | – | – | 1 | – | 0 | search_index=1. Sending/receiving device; today only inside `payload` | `list_webhook_delivery_logs_api(device=)`, support filtering | `webhook_endpoint` |
| `dispatched_at` | Dispatched At | Datetime | – | – | – | – | – | – | – | 0 | read_only; set when `frappe.enqueue(deliver_webhook)` is called. Cron skips `Pending` rows with `dispatched_at > now - webhook_redispatch_grace_minutes` | F-20/PR-04, PG-09 | `next_retry_at` |
| `event_id` (**index only**) | Event ID | Data | – | – | – | – | – | 1 | – | 0 | search_index=1; receiver dedupe `(integration_link, event_name, event_id, webhook_endpoint is null)` | PF-01 (`api/__init__.py:1394`) | unchanged |
| `integration_link` (**index only**) | – | Link | – | – | – | – | – | – | – | 0 | search_index=1 | link-scoped lists | unchanged |
| `status` (**index only**) | – | Select | – | – | – | – | – | – | – | 0 | search_index=1; cron scans `Pending`/`Retrying` | F-20 | unchanged |
| `next_retry_at` (**index only**) | – | Datetime | – | – | – | – | – | – | – | 0 | search_index=1 | retry cron | unchanged |

Lock behaviour (OQ-1 designed option): on lock, the endpoint's `Retrying`/`Pending` rows are set `Cancelled` with `error_message = "Endpoint locked"`; no new column. Permissions to add: `WhatsApp System Manager` read, `WhatsApp Support User` read.

### 4. WhatsApp Message Log (changed — PG-03, PG-04, PF-02, PF-03)

| fieldname | label | fieldtype | options | reqd | unique | default | ilv | isf | depends_on | pl | description | serves | insert after |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `device` | Device | Link | `WhatsApp Device` | – | – | – | – | 1 | – | 0 | search_index=1. Device that sent (or would have sent) the message; written by `services/messages.py` on every path incl. `Rejected` | A-04 per-device usage, screen 3/15 counts, delivered/read enrichment | `integration_link` |
| `client_ref` | Client Reference | Data (length 140) | – | – | – | – | – | 1 | – | 0 | search_index=1. Caller's reference; sync path `send_message_api(client_ref=)` and queue path copy `Message Queue.client_ref`. Same length as the queue column so values round-trip | G-08/A-08, D-024 reconcile | `api_request_id` |
| `provider_message_id` (**index only**) | – | Data | – | – | – | – | – | – | – | 0 | search_index=1; receiver correlates `message.delivered/read` by this value (`messages.py:481`) | F-13, PG-03 | unchanged |
| `integration_link` (**index only**) | – | Link | – | – | – | – | – | – | – | 0 | search_index=1 | `list_message_logs_api` | unchanged |
| `recipient_no` (**index only**) | – | Data | – | – | – | – | – | – | – | 0 | search_index=1; **E.164** — index only pays off if `messages.py` normalizes before insert (verify; PFD-05) | conversation lookups, A-04 | unchanged |

Permissions to add: `WhatsApp System Manager` read, `WhatsApp Support User` read (both permlevel 0 — OQ-6). No back-fill of `device` for old rows (D-021).

### 5. WhatsApp Message Queue (changed — indexes only, PF-01)

`client_ref` (Data 140), `batch_id` (Data 64), `device` Link already exist; no new columns. `client_ref` uniqueness per `(integration_link, client_ref)` cannot be expressed in DocType JSON and legacy rows may already contain duplicates, so it is enforced in code for links with `strict_client_ref=1` (OQ-2, table 7).

| fieldname | change | why |
|---|---|---|
| `client_ref` | search_index=1 | `get_message_status_api` filters `(integration_link, client_ref in refs)` (`api/__init__.py:1011`); strict-ref duplicate check |
| `batch_id` | search_index=1 | `cancel_queued_messages_api(batch_id)` (A-11) |
| `message_log` | search_index=1 | delivered/read → queue row lookup (PG-03) |
| `status` | search_index=1 | scheduler scan, `get_queue_status_api` counts |
| `next_attempt_at` | search_index=1 | scheduler scan |
| `integration_link` | search_index=1 | link-scoped filters |

`_notify` for `message.held` adds `device` to the payload — code only (PF-04). Permissions to add: `WhatsApp System Manager` read, `WhatsApp Support User` read.

### 6. WhatsApp Device (changed — PG-08, PF-01, screen 3)

| fieldname | label | fieldtype | options | reqd | unique | default | ilv | isf | depends_on | pl | description | serves | insert after |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `pairing_mode` | Pairing Mode | Select | `QR\nCode` | – | – | `QR` | – | 1 | – | 0 | Which pairing flow the client chose; `Code` requires `phone_number` (validate). Set by `create_device_api(pairing_mode=)` / `update_device_api` | PG-08, F-10, screen 3 60-s refresh loop after reload | `phone_number` |
| `last_status_change_at` | Last Status Change | Datetime | – | – | – | – | – | – | – | 0 | read_only; written whenever `status` changes (webhook, poll, pre-send refresh, send failure) | screen 3 live status, health check | `last_seen` |
| `last_status_reason` | Last Status Reason | Data (length 140) | – | – | – | – | – | – | – | 0 | read_only; source of the change: `wa-admin webhook`, `verify_device_connection_api`, `send failure: not logged in`, `disconnect_device_api`… no payload | screen 3 | `last_status_change_at` |
| `wa_device_id` (**index only**) | – | Data | – | – | – | – | – | – | – | 0 | search_index=1; receiver resolves device per inbound event (`api/__init__.py:1363`) | PF-01 | unchanged |
| `integration_link` (**index only**) | – | Link | – | – | – | – | – | – | – | 0 | search_index=1 | `list_devices_api`, `devices_used` | unchanged |
| `subscription` (**index only**) | – | Link | – | – | – | – | – | – | – | 0 | search_index=1 | device-limit count | unchanged |
| `phone_number` (**no schema change**) | – | Data | – | – | – | – | – | – | – | 0 | must be normalized **E.164** in `validate` and in `update_device_api`; pair-code path sends it to wa-admin | F-10, A-05 | – |

`device_token` stays **PW** (existing). Permissions to add: `WhatsApp System Manager` read/write, `WhatsApp Support User` read.

### 7. WhatsApp Integration Link (changed — PG-07, G-13, PR-03, OQ-2)

Existing **PW** fields: `api_secret`, `webhook_secret` (never returned except the existing one-time/on-demand reveal endpoints — see Findings PFD-03). `api_key` is a `Data` lookup key (`unique=1`).

| fieldname | label | fieldtype | options | reqd | unique | default | ilv | isf | depends_on | pl | description | serves | insert after |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `require_api_secret` | Require API Secret | Check | – | – | – | `0` | – | 1 | – | 0 | When 1, every key-auth call must send `X-SND-API-Secret` matching `api_secret`; failure → 401 with code `AUTH_SECRET_REQUIRED`. New links take `WhatsApp Platform Settings.default_require_api_secret_for_new_links`; whatsapp_next link = 1, legacy links = 0 | R-008, F-01, D-020, PG-07 | `api_secret` |
| `previous_api_key` | Previous API Key | Data (length 140) | – | – | – | – | – | – | – | 0 | hidden=1, read_only=1, search_index=1. Old `api_key` accepted until `previous_api_key_expires_at`; cleared by the auth path after expiry. **Not** `Password` because it must be looked up by value like `api_key` (PFD-02); excluded from every API response and from `Developer Test Tool` | G-13 `rotate_api_key_api` | `wa_api_key_id` |
| `previous_api_key_expires_at` | Previous Key Expires At | Datetime | – | – | – | – | – | – | `eval:doc.previous_api_key` | 0 | read_only; `now + WhatsApp Platform Settings.api_key_rotation_grace_hours` at rotation | G-13 | `previous_api_key` |
| `api_key_rotated_at` | API Key Rotated At | Datetime | – | – | – | – | – | – | `eval:doc.api_key_rotated_at` | 0 | read_only; last rotation timestamp (audit row carries who) | G-13, audit | `previous_api_key_expires_at` |
| `allow_device_fallback` | Allow Device Fallback | Check | – | – | – | `1` | – | – | – | 0 | Link-level default for `send_message_api`: when 0, a down device returns 409 `DEVICE_NOT_CONNECTED` instead of sending from the other connected device. Request param `allow_fallback` (A-07) overrides per call. whatsapp_next link = 0 | PR-03, R-010, F-14 | `allowed_ip` |
| `strict_client_ref` | Strict Client Reference | Check | – | – | – | `0` | – | – | – | 0 | When 1, `enqueue_messages_api` rejects a `client_ref` that already exists for this link in a non-terminal or `Sent` state (`errors[]` code `CLIENT_REF_DUPLICATE`); `send_message_api` with `client_ref` likewise. whatsapp_next link = 1; legacy links stay 0 (OQ-2 designed option) | D-024 reconcile, PR-14 | `allow_device_fallback` |
| `customer` (**index only**) | – | Link | – | – | – | – | – | – | – | 0 | search_index=1 | tenant lookups | unchanged |
| `subscription` (**index only**) | – | Link | – | – | – | – | – | – | – | 0 | search_index=1 | auth path, device re-pointing | unchanged |

Permissions to add: `WhatsApp System Manager` read/write, `WhatsApp Support User` read (existing `permission_query_conditions` for Customer Users untouched). Patch `set_integration_link_flag_defaults`: `require_api_secret=0`, `allow_device_fallback=1`, `strict_client_ref=0` on all existing rows (defaults cover new inserts; keeps DB explicit).

### 8. WhatsApp Usage Ledger (changed — PG-04, A-04, screen 15 usage)

| fieldname | label | fieldtype | options | reqd | unique | default | ilv | isf | depends_on | pl | description | serves | insert after |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `integration_link` | Integration Link | Link | `WhatsApp Integration Link` | – | – | – | – | 1 | – | 0 | search_index=1; copied from the Message Log on `Usage` rows (`messages.py:524`) | per-link usage in `get_usage_api` | `subscription` |
| `device` | Device | Link | `WhatsApp Device` | – | – | – | – | 1 | – | 0 | search_index=1; nullable (Reversal/Adjustment/Monthly Reset rows have none) | per-device usage, screen 3 cards | `integration_link` |
| `subscription` (**index only**) | – | Link | – | – | – | – | – | – | – | 0 | search_index=1 | period totals | unchanged |
| `posting_datetime` (**index only**) | – | Datetime | – | – | – | – | – | – | – | 0 | search_index=1 | `from/to` filters, group by day | unchanged |

Permissions to add: `WhatsApp System Manager` read, `WhatsApp Support User` read, `WhatsApp Billing User` read. Usage/balance/plan exposure (A-01..A-04) needs **no** other schema: `devices_used`, wallet balance and remaining messages stay computed from existing columns (`06` table 1).

### 9. WhatsApp Platform Settings (new Single — PG-05, R-013, D-018, F-20, A-09)

`issingle=1`, module `SND WhatsApp Platform`, `track_changes=1` (settings changes are auditable through Version). Never returned by any key-auth API.

| fieldname | label | fieldtype | options | reqd | unique | default | ilv | isf | depends_on | pl | description | serves |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `webhooks_section` | Outbound Webhooks | Section Break | – | – | – | – | – | – | – | 0 | – | – |
| `webhook_lock_after_failures_default` | Lock After Failures (default) | Int | – | 1 | – | `5` | – | – | – | 0 | Used when an endpoint has `lock_after_failures=0`. Validate 1–100 | D-018, OQ-1 |
| `webhook_redispatch_grace_minutes` | Redispatch Grace (minutes) | Int | – | 1 | – | `10` | – | – | – | 0 | `process_pending_webhooks` ignores `Pending` rows dispatched more recently than this | F-20, PG-09 |
| `webhooks_cb` | – | Column Break | – | – | – | – | – | – | – | 0 | – | – |
| `log_webhook_payloads` | Log Inbound Webhook Payloads (debug) | Check | – | – | – | `0` | – | – | – | 0 | Gates the `frappe.log_error` dump at `api/__init__.py:1324`. When 1 the payload is logged with `message`, `body`, `caption`, `media*`, `text`, `sender_mobile_no` stripped (keys kept). Off in production | R-013, F-21, PG-05 |
| `webhook_payload_log_device` | Only For Device | Link | `WhatsApp Device` | – | – | – | – | – | `log_webhook_payloads` | 0 | Optional narrowing to one device | R-013 |
| `webhook_payload_log_until` | Auto-disable At | Datetime | – | – | – | – | – | – | `log_webhook_payloads` | 0 | Receiver treats the switch as off after this time (safety net against a forgotten debug flag) | R-013 |
| `api_section` | External API | Section Break | – | – | – | – | – | – | – | 0 | – | – |
| `api_error_codes_in_body` | Include Error Codes In Responses | Check | – | – | – | `1` | – | – | – | 0 | Kill switch for the additive `code` key in error bodies | A-09, R-011 |
| `default_require_api_secret_for_new_links` | New Links Require API Secret | Check | – | – | – | `1` | – | – | – | 0 | Default for `Integration Link.require_api_secret` on insert | D-020, PG-07 |
| `api_cb` | – | Column Break | – | – | – | – | – | – | – | 0 | – | – |
| `api_key_rotation_grace_hours` | Key Rotation Grace (hours) | Int | – | 1 | – | `24` | – | – | – | 0 | How long `previous_api_key` stays valid after `rotate_api_key_api`. Validate 0–168 | G-13 |
| `api_rate_limit_per_minute` | Requests Per Minute Per Link | Int | – | – | – | `300` | – | – | – | 0 | `frappe.rate_limit`-style limit keyed by link `api_key`; 0 = off. Applies to key-auth calls only | F-15 |
| `inbound_section` | Inbound Receiver | Section Break | – | – | – | – | – | – | – | 0 | – | – |
| `sender_resolution_cache_ttl_seconds` | Sender Resolution Cache TTL (s) | Int | – | – | – | `3600` | – | – | – | 0 | TTL for the `(device, sender_jid) → mobile` cache that replaces the per-event wa-admin `list_contacts` call; 0 = no cache | PF-05, PR-15 |

Permissions: `System Manager` read/write; `WhatsApp System Manager` read/write; `WhatsApp Support User` read. No Password fields (wa-admin secret stays in `site_config`).

### 10. WhatsApp API Audit Log (new — PG-06, `security.md` "audit every elevated write", D-022)

`autoname=hash`, `in_create=1`, `track_changes=0`, `sort_field=creation DESC`, module `SND WhatsApp Platform`. One row per **mutating** key-auth call (and, via `auth_mode`, the same actions when performed from desk/portal). `details` never contains message bodies or phone numbers; recipients, if needed, appear as counts.

| fieldname | label | fieldtype | options | reqd | unique | default | ilv | isf | depends_on | pl | description | serves |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `who_section` | Actor | Section Break | – | – | – | – | – | – | – | 0 | – | – |
| `customer` | Customer | Link | `WhatsApp Customer` | 1 | – | – | – | 1 | – | 0 | Tenant (index via `integration_link` suffices; Customer is for desk filters) | tenant scoping |
| `integration_link` | Integration Link | Link | `WhatsApp Integration Link` | – | – | – | 1 | 1 | – | 0 | search_index=1; empty only for desk/system actions | link-scoped `list_audit_log_api` (OQ-5) |
| `user` | User | Link | `User` | 1 | – | – | 1 | – | – | 0 | The real Frappe user (token user for key-auth calls) — never `Administrator` as a stand-in | `security.md` condition 3 |
| `auth_mode` | Auth Mode | Select | `API Key\nDesk\nPortal\nSystem` | 1 | – | `API Key` | – | 1 | – | 0 | How the actor authenticated | support triage |
| `who_cb` | – | Column Break | – | – | – | – | – | – | – | 0 | – | – |
| `action` | Action | Select | `device.create\ndevice.update\ndevice.disconnect\ndevice.reconnect\ndevice.delete\nwebhook.create\nwebhook.update\nwebhook.delete\nwebhook.unlock\nwebhook.test\nkey.rotate\nsecret.rotate\nqueue.cancel\nwallet.topup_request\nsettings.update` | 1 | – | – | 1 | 1 | – | 0 | search_index=1. `device.reconnect` (A-05) and `settings.update` (Platform Settings writes) added to the 06 list | PG-06 |
| `outcome` | Outcome | Select | `Success\nRejected\nError` | 1 | – | `Success` | 1 | 1 | – | 0 | `Rejected` = permission/validation/business rule; `Error` = exception | support |
| `error_code` | Error Code | Data (length 60) | – | – | – | – | – | 1 | `eval:doc.outcome!="Success"` | 0 | The A-09 code (`DEVICE_NOT_CONNECTED`, `AUTH_SECRET_REQUIRED`…) | R-011 |
| `target_section` | Target | Section Break | – | – | – | – | – | – | – | 0 | – | – |
| `target_doctype` | Target DocType | Link | `DocType` | – | – | – | 1 | 1 | – | 0 | – | desk filters |
| `target_name` | Target Name | Data (length 140) | – | – | – | – | 1 | – | – | 0 | Plain `Data`, not Dynamic Link: audit rows must outlive deleted targets | PFD-01 |
| `device` | Device | Link | `WhatsApp Device` | – | – | – | – | 1 | – | 0 | search_index=1; nullable | screen 3 history |
| `webhook_endpoint` | Webhook Endpoint | Link | `WhatsApp Webhook Endpoint` | – | – | – | – | 1 | – | 0 | nullable | screen 15 |
| `target_cb` | – | Column Break | – | – | – | – | – | – | – | 0 | – | – |
| `request_id` | Request ID | Data (length 140) | – | – | – | – | – | – | – | 0 | `X-Request-ID` header if sent by the client, else Frappe's request id; lets the client join its own logs | PR-09 tests, support |
| `remote_ip` | Remote IP | Data (length 45) | – | – | – | – | – | – | – | 0 | `frappe.local.request_ip` (IPv6-safe length) | security |
| `api_version` | API Version | Data (length 10) | – | – | – | – | – | – | – | 0 | e.g. `v1`; `platform.md` requires versioned endpoints | docs |
| `details_section` | Details | Section Break | – | – | – | – | – | – | – | 0 | – | – |
| `details` | Details | JSON | – | – | – | – | – | – | – | 0 | Changed field **names** and non-PII values (`status: Active→Disabled`, `events: [...]`, `batch_id`, `count`). No bodies, no phone numbers, no secrets, no keys | `security.md` |

Permissions: `System Manager` read + delete; `WhatsApp System Manager` read; `WhatsApp Support User` read. No write/create rows for anyone (rows are inserted with `ignore_permissions=True` by the service layer). `hooks.default_log_clearing_doctypes["WhatsApp API Audit Log"] = 90`.

### 11. hooks.py additions (schema-adjacent, additive)

| Hook | Value | Why |
|---|---|---|
| `default_log_clearing_doctypes` | add `"WhatsApp API Audit Log": 90` (existing 30-day entries unchanged) | 06 table 3 |
| `ignore_links_on_delete` | `["WhatsApp Message Log", "WhatsApp Message Queue", "WhatsApp Webhook Delivery Log", "WhatsApp Usage Ledger", "WhatsApp API Audit Log"]` | PFD-01: log tables must not pin devices/endpoints against deletion |

### 12. Patches (`patches.txt`, section `[post_model_sync]`)

| Patch | Does |
|---|---|
| `rename_failed_webhook_endpoints_to_locked` | table 1 UPDATEs; idempotent |
| `set_integration_link_flag_defaults` | table 7 UPDATEs for existing rows; idempotent |

No back-fill patches for `device`/`client_ref` on logs (D-021).

## Findings

| # | Finding | Evidence / consequence |
|---|---|---|
| PFD-01 | `delete_device_api` and `delete_webhook_endpoint_api` call `doc.delete(ignore_permissions=True)` with no `ignore_links`. Adding `Link → WhatsApp Device` to `Message Log` (never purged) and `Usage Ledger` would make `delete_local=1` fail with `LinkExistsError` for every device that ever sent. Today the same latent problem exists for `Message Queue.device` and `Delivery Log.webhook_endpoint` within the 30-day window | `api/__init__.py:823,1226`; Frappe 16 `delete_doc.py:395` honours `ignore_links_on_delete` → hook in table 11 keeps Links (desk navigation, filters) without blocking deletes |
| PFD-02 | `previous_api_key` cannot be `Password`: the auth path resolves the link **by key value** (`api_key` is itself `Data unique`). It is hidden, read_only, indexed, cleared after the grace window, never serialized by any API or by `Developer Test Tool` | `security.md` "API keys → Password" is satisfied for secrets (`api_secret`, `webhook_secret`, endpoint `secret`, `device_token`); lookup keys stay `Data` as today |
| PFD-03 | Password fields currently **returned** by APIs: `Integration Link.webhook_secret` (`get_integration_webhook_secret_api`, `configure_integration_webhook_api`, `create_webhook_endpoint_api`), endpoint `secret` (create response), `api_secret` (`create_customer_subscription`, `generate_api_token`). Schema is right; the reveal policy (one-time on create/rotate only) is a backend decision, not a field change | 05 F-17, F-19; every reveal must write an audit row (`secret.rotate` / `key.rotate`) |
| PFD-04 | Changing Select options never touches the MariaDB column (varchar 140), so D-018 is a JSON edit + one UPDATE; no downtime beyond the index builds | table 1 patch |
| PFD-05 | The `recipient_no` index on `Message Log` (and any `recipient_no` filter in `list_message_logs_api`) only works if `messages.py` writes E.164; the branch normalizes `Customer.mobile_no` but the send path was not verified in this pass | backend planner to confirm before relying on the index; same for `Device.phone_number` |
| PFD-06 | `Message Queue.client_ref` already has `in_list_view=1`, length 140; `Message Log.client_ref` mirrors it exactly so `get_message_status_api` and `list_message_logs_api` can join on the same value | table 4 |
| PFD-07 | Composite uniqueness `(integration_link, client_ref)` cannot be declared in DocType JSON, and legacy rows may already violate it; a DB unique index via patch would fail on those rows. Enforcement is therefore per-link, in code, behind `strict_client_ref` | table 7, OQ-2 |
| PFD-08 | Neither new DocType name exists anywhere in the platform tree (`Platform Settings`, `API Audit Log`) | grep |
| PFD-09 | Existing permission rows on `Message Log` give `WhatsApp Customer User` `create+read+select` (no `write/delete`); the new role rows follow the same read-only shape so no portal behaviour changes | `whatsapp_message_log.json:310-323` |

## Gaps

| Gap (from 06) | Closed by (this doc) |
|---|---|
| PG-01 Locked state, counter, threshold | table 1 (`status`, `consecutive_failures`, `lock_after_failures`, `locked_at`, `lock_reason`, `unlocked_at`) + Settings default |
| PG-02 `message.held` unsubscribable | table 2 |
| PG-03 Delivered/read correlation | table 4 `client_ref` + `provider_message_id` index; table 5 `message_log` index |
| PG-04 Per-device usage | table 4 `device`; table 8 `device`, `integration_link` |
| PG-05 Payload dump gate | table 9 `log_webhook_payloads` (+ device narrowing, auto-off) |
| PG-06 Audit trail | table 10 |
| PG-07 Phased secret enforcement | table 7 `require_api_secret`; table 9 default |
| PG-08 Pair-code persistence | table 6 `pairing_mode` |
| PG-09 Double delivery window | table 3 `dispatched_at`; table 9 grace |
| New: link-blocked deletes (PFD-01) | table 11 hook |
| New: key rotation grace, rate limit, sender cache TTL had no home | table 9 |

## Risks

| # | Risk | L / I | Mitigation |
|---|---|---|---|
| PR-11..PR-16 | unchanged from 06 (rename, index build time, counter semantics, client_ref ambiguity, sender lookup, Support PII) | — | as in 06; PR-13 and PR-14 are now designed (OQ-1/OQ-2 options below) |
| PR-17 | `ignore_links_on_delete` also silences the check for **desk** deletes of devices/endpoints by System Managers — a device with logs can be deleted by hand, leaving dangling Links in log tables (harmless for reads; `frappe.get_doc` on the link fails) | Low / Low | Acceptable for log tables; audit row `device.delete` records it. Alternative: soft delete (`status: Deleted`) — non-additive, not proposed |
| PR-18 | 14 new `search_index` flags across 6 tables; `Message Log`/`Delivery Log` on prod may be large, `bench migrate` builds them one `ALTER` each | Med / Med | Off-peak migrate; InnoDB online DDL; rehearse on a prod copy (PR-12) |
| PR-19 | `webhook_payload_log_until` unset + flag on = permanent PII logging | Low / Med | Validate in Settings: when `log_webhook_payloads=1`, `webhook_payload_log_until` is mandatory and ≤ 7 days ahead |
| PR-20 | `strict_client_ref` duplicate check races under concurrent batches for the same ref | Low / Med | Check inside the enqueue transaction with `FOR UPDATE` on the existing row, or accept last-wins and rely on `get_message_status_api` (D-024) |

## Recommendations

| Step | Action | Depends on |
|---|---|---|
| 1 | Land tables 1, 2, 9 together with the `Locked` patch and the lock/unlock code — the client's screen 15 webhook section needs all three | D-018 |
| 2 | Add hook `ignore_links_on_delete` **before** shipping any new Link column on log tables (table 11) | PFD-01 |
| 3 | Tables 3, 4, 5 (indexes + `client_ref`/`device`/`dispatched_at`) with the receiver correlation code and the cron grace | PG-03, PG-09 |
| 4 | Tables 6, 7, 8 with `update_device_api`, `rotate_api_key_api`, `require_api_secret` enforcement, `strict_client_ref` check | D-020, G-13 |
| 5 | Table 10 + `default_log_clearing_doctypes` 90 d; wire every mutating key-auth function through one `audit(action, target, outcome, details)` helper so no path is missed | PG-06 |
| 6 | Role permission rows (PF-08) last; they do not block any client screen | OQ-6 |
| 7 | Set on the whatsapp_next link: `require_api_secret=1`, `allow_device_fallback=0`, `strict_client_ref=1` (data, D-019/D-020) | step 4 |
| 8 | Every new field is documented in `../snd_whatsapp_platform/docs/` (webhook states, `client_ref` semantics, `X-SND-API-Secret`, rotation grace, error codes) as it lands | `platform.md` |

## Open questions

| # | Question | Designed for | Alternative (one line) | Blocking? |
|---|---|---|---|---|
| OQ-1 | Counter semantics and what happens to in-flight logs on lock | Per HTTP **attempt**, reset on any 2xx; on lock cancel the endpoint's `Retrying`/`Pending` rows (`error_message="Endpoint locked"`); client reconciles via `get_message_status_api` | Count per terminal `Failed` log (locks after N×`max_retries` attempts) and keep rows `Pending` for redelivery after unlock — needs no extra field either way | Yes (D-018 code) |
| OQ-2 | `client_ref` uniqueness | Separate `Integration Link.strict_client_ref` flag, enforced in code per `(integration_link, client_ref)` | Piggyback on `require_api_secret=1` (one flag fewer, couples auth to queue semantics) | Yes (D-024) |
| OQ-5 | Tenant-readable audit log | `integration_link` indexed so `list_audit_log_api` is possible; not required for any screen | Desk-only; drop the index | No |
| OQ-6 | Support reads `Message Log.message_body` | Permlevel 0 read for `WhatsApp Support User` (PR-16 accepted) | Permlevel 1 on `message_body`, `media_url`, `poll_*`, `location_*`, `provider_response` + a permlevel-1 row for System Manager only; risk: Customer User portal reads via `get_all` would lose those columns | No |
| OQ-7 (new) | Should desk/portal actions (`auth_mode` = Desk/Portal) also write audit rows, or only key-auth calls? | Both (the column exists; helper decides) | Key-auth only; drop `auth_mode` | No |
| OQ-8 (new) | `previous_api_key` as hidden `Data` (PFD-02) acceptable under `security.md`, or must rotation be immediate (no grace, no column)? | Grace window with hidden Data | No grace: rotation invalidates the old key at once; drop three fields and the Settings hours | No |

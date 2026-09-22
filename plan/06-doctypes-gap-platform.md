# 06 — DocType gap: `snd_whatsapp_platform` (branch `whatsapp-next-integration`)

Schema-level gap between what the platform has today (`05-platform-summary.md` §C) and what
`whatsapp_next` needs per `00-screens-spec.md` (screens 3, 15), `architecture.md` BaseProvider, and
decisions D-013, D-018..D-024. Platform repo read-only for this analysis; paths below are under
`../snd_whatsapp_platform/snd_whatsapp_platform/snd_whatsapp_platform/`.

## Purpose

| Item | Value |
|---|---|
| Scope | Platform DocTypes only (client DocTypes: `02-doctypes-gap.md`) |
| Rule | Additive only (`platform.md`); one approved non-additive change: webhook endpoint states (D-018) |
| Not in scope by decision | Retention / history features for the client (D-021); inbound `Message Log` rows (F-12 stays) |
| Roles that exist on the platform | `System Manager`, `WhatsApp System Manager`, `WhatsApp Support User`, `WhatsApp Billing User`, `WhatsApp Customer User`, `WhatsApp API User` (seeded, unreferenced) |
| Tenant scoping of the external API | By `WhatsApp Integration Link` resolved from `X-SND-API-Key` (code-level filter, not DocType permissions). Every table below says "link-scoped" for that |

## Inventory

### 1. Reuse as is (no schema change; code-only fixes noted in Findings)

| DocType | Used by client via | Why unchanged |
|---|---|---|
| WhatsApp Customer | `get_account_api` (A-01) read | Profile fields exist; status check at auth is code (F-02) |
| WhatsApp Plan | `list_plans_api` (A-02) | Catalogue complete; `message.held` is gated by existing `webhook_message_failed` (mapping in `services/webhooks.py:105`) |
| WhatsApp Plan Snapshot | indirectly | Frozen copy; no client need |
| WhatsApp Subscription | `get_subscription_status`, `get_account_api` | Has limit/used/remaining/period/`device_limit`/`auto_renew`/`next_billing_date`; `devices_used` is computed |
| WhatsApp Wallet Transaction | `get_wallet_api` (A-03) read | Balance computed on read; no cached column wanted (D-021 spirit) |
| WhatsApp Billing Entry | `get_wallet_api` read | — |
| WhatsApp Signup Request | not used by client (Onboarding uses credentials, not signup) | — |
| WhatsApp Campaign, WhatsApp Scheduled Message | not used (client owns campaigns/queue) | — |
| WhatsApp Notification Template / Settings | platform-internal | — |
| Developer Test Tool, Saved API Request, API Test Header | platform-internal | `generate_api_token` exposure (F-19) is a code fix (role check or removal), not schema |

### 2. Reuse with changes (exact new fields / options; all additive except row 1)

| DocType | Change | Fieldname · type · default | Why |
|---|---|---|---|
| **WhatsApp Webhook Endpoint** (D-018, the one non-additive change) | `status` options `Active\nDisabled\nFailed\nRevoked` → `Active\nDisabled\nLocked\nRevoked`; patch renames existing `Failed` rows to `Locked` (none exist in practice: `Failed` was never set by code, F-11) | `status` Select | Spec states Active/Disabled/Locked |
| | Failure counter | `consecutive_failures` Int, default 0, read_only | Lock trigger; reset to 0 on any 2xx |
| | Lock threshold | `lock_after_failures` Int, default 5 (0 = use `WhatsApp Platform Settings.webhook_lock_after_failures_default`) | "N consecutive failures" (D-018); settable via `create/update_webhook_endpoint_api` |
| | Lock audit | `locked_at` Datetime, read_only; `lock_reason` Small Text, read_only; `unlocked_at` Datetime, read_only | Screen 15 shows why/when; `update_webhook_endpoint_api(status="Active")` clears |
| | Health for UI | `last_http_status` Int, read_only | Cheaper than reading Delivery Log |
| | Permissions | add read/write for `WhatsApp System Manager`, read for `WhatsApp Support User` | Today only `System Manager` |
| **WhatsApp Webhook Event** (child) | add option | `event_name` += `message.held` (after `message.failed`) | G-06: subscribing to `message.held` currently fails on insert |
| **WhatsApp Webhook Delivery Log** | dispatch marker | `dispatched_at` Datetime, read_only | F-20/PR-04: `process_pending_webhooks` re-enqueues every `Pending` row; cron must skip rows dispatched < 10 min ago |
| | device column | `device` Link → WhatsApp Device (nullable) | Inbound inbox rows carry `device` only inside `payload`; needed for `list_webhook_delivery_logs_api(device=)` and support filtering |
| | indexes | `search_index` on `event_id`, `integration_link`, `status`, `next_retry_at` | Receiver dedupe `db.exists({integration_link, event_name, event_id, webhook_endpoint is not set})` runs per inbound event on an unindexed table (`api/__init__.py:1394`); cron scans `status` |
| | permissions | add read for `WhatsApp System Manager`, `WhatsApp Support User` | Support cannot see delivery health today |
| **WhatsApp Message Log** | correlation key | `client_ref` Data(140), search_index | G-08/A-08: sync path `send_message_api` has nowhere to keep the caller's ref; `message.sent/failed` from that path carry platform ids only |
| | sending device | `device` Link → WhatsApp Device, search_index | No device on the log today; needed for per-device usage (A-04), `message.delivered/read` enrichment, and screen 3/15 counts |
| | indexes | `search_index` on `provider_message_id`, `integration_link`, `recipient_no` | F-13: `message.delivered/read` must be correlated by `provider_message_id` (set at `services/messages.py:481`); `list_message_logs_api` filters by link |
| | permissions | add read for `WhatsApp System Manager`, `WhatsApp Support User` | — |
| **WhatsApp Message Queue** | indexes | `search_index` on `client_ref`, `batch_id`, `message_log`, `status`, `next_attempt_at`, `integration_link` | `get_message_status_api` filters `(integration_link, client_ref in refs)` (`api/__init__.py:1011`); scheduler scans `(status, next_attempt_at)`; `cancel_queued_messages_api` (A-11) filters `batch_id` |
| | device on held payload | none (field exists) | `_notify` (`services/message_queue.py:368`) must add `row.device` — code |
| | permissions | add read for `WhatsApp System Manager`, `WhatsApp Support User` | — |
| **WhatsApp Device** | indexes | `search_index` on `wa_device_id`, `integration_link`, `subscription` | Receiver resolves device by `wa_device_id` on every inbound event (`api/__init__.py:1363`), unindexed |
| | status audit | `last_status_change_at` Datetime, read_only; `last_status_reason` Data(140), read_only | Screen 3 live status and health check; today only `last_seen` |
| | pairing mode | `pairing_mode` Select `QR\nCode`, default `QR` | Screen 3 must know which flow the user chose so the 60 s refresh loop hits the right endpoint after reload; pair-code requires `phone_number` (F-10) |
| **WhatsApp Integration Link** | phased secret enforcement | `require_api_secret` Check, default 0 | R-008/F-01: enforce `X-SND-API-Secret` per consumer (whatsapp_next = 1 from day one per D-020; legacy links stay 0) |
| | key rotation | `previous_api_key` Data, hidden, search_index; `previous_api_key_expires_at` Datetime | G-13 `rotate_api_key_api` with grace window; auth accepts either key until expiry |
| | fallback policy | `allow_device_fallback` Check, default 1 | PR-03/R-010: link-level default for `send_message_api`; whatsapp_next link = 0; request param (A-07) can still override |
| | index | `search_index` on `customer`, `subscription` | — |
| **WhatsApp Usage Ledger** | device / link | `device` Link → WhatsApp Device; `integration_link` Link → WhatsApp Integration Link | A-04 per-device usage within the current period; both nullable, written by `messages.py` on `Usage` rows |
| | index | `search_index` on `subscription`, `posting_datetime` | Period totals per subscription |
| **WhatsApp Plan / Plan Snapshot / Subscription** | none for `message.held` | — | Gated by `webhook_message_failed` in code; no new flag. D-019 (dev tenant full plan) is data, not schema |

### 3. Create new

| DocType | Module | Naming | Submittable | Child | Links | Volume | Indexes | Purpose |
|---|---|---|---|---|---|---|---|---|
| **WhatsApp Platform Settings** | SND WhatsApp Platform | Single | no | no | `webhook_payload_log_device_filter` (optional Link → WhatsApp Device) | 1 | — | Global switches: `log_webhook_payloads` Check default 0 (R-013/F-21 gate for the `frappe.log_error` dump at `api/__init__.py:1324`; when 1, payload is logged **without** message body/media fields); `webhook_lock_after_failures_default` Int default 5 (D-018); `webhook_redispatch_grace_minutes` Int default 10 (F-20); `api_error_codes_in_body` Check default 1 (A-09 kill switch); `default_require_api_secret_for_new_links` Check default 1 |
| **WhatsApp API Audit Log** | SND WhatsApp Platform | hash | no | no | `customer`, `integration_link`, `device` (nullable), `webhook_endpoint` (nullable), `user` (Link User, the Frappe token user) | one row per **mutating** key-auth call: device create/delete/disconnect/update, endpoint create/update/delete/unlock, key rotation, secret rotation, cancel batch, top-up request; ~10–100/day/tenant | `integration_link`, `action`, `creation` | `security.md` "audit every elevated write" applied to the platform (D-022). Fields: `action` Select (`device.create\ndevice.update\ndevice.disconnect\ndevice.delete\nwebhook.create\nwebhook.update\nwebhook.delete\nwebhook.unlock\nwebhook.test\nkey.rotate\nsecret.rotate\nqueue.cancel\nwallet.topup_request`), `target_doctype` Data, `target_name` Data, `request_id` Data, `remote_ip` Data, `outcome` Select `Success\nRejected\nError`, `details` JSON (**no message bodies, no phone numbers**, keys only). `in_create=1`; `default_log_clearing_doctypes` 90 d |

Permission matrix for the new DocTypes:

| DocType | System Manager | WhatsApp System Manager | WhatsApp Support User | WhatsApp Billing User | WhatsApp Customer User | Key-auth API caller |
|---|---|---|---|---|---|---|
| WhatsApp Platform Settings | r/w | r/w | r | — | — | no access (never returned by API) |
| WhatsApp API Audit Log | r, delete | r | r | — | — | read own link's rows via `list_audit_log_api` (link-scoped, optional) |

Permission rows to add on changed DocTypes (all additive): `WhatsApp System Manager` r/w and `WhatsApp Support User` r on Webhook Endpoint, Delivery Log, Message Log, Message Queue, Device, Integration Link (Integration Link stays under the existing `permission_query_conditions` for Customer Users; `api_secret`/`webhook_secret` remain Password and are never returned).

## Findings

| # | Finding | Evidence |
|---|---|---|
| PF-01 | Every hot-path lookup the receiver and schedulers perform is on an unindexed column (`Device.wa_device_id`, `Delivery Log.event_id`, `Message Queue.client_ref`, `Message Log.provider_message_id`). Only 6 `search_index`/`unique` flags exist in the whole app, none on these | grep of `doctype/**/*.json`; `api/__init__.py:1363,1394,1011` |
| PF-02 | `Message Log` has no `device` and no `client_ref`; `Usage Ledger` has no `device`. Per-device usage (screen 15, BaseProvider "balance/usage read") and sync-path correlation are impossible without the two additive columns | `whatsapp_message_log.json`, `whatsapp_usage_ledger.json` |
| PF-03 | `message.delivered` / `message.read` reach the client as raw wa-admin payloads + device fields; no `message_log`, `client_ref`, `queue_id`. Correlation needs `Message Log.provider_message_id` index (schema) plus a lookup in the receiver (code) | `api/__init__.py:1370-1391`; F-13 |
| PF-04 | `message.held` payload already carries `queue_id`, `client_ref`, `recipient_no`, `reason` but not `device`; the child Select cannot store the event name, so no endpoint can subscribe today | `services/message_queue.py:317,368`; `whatsapp_webhook_event.json:23` |
| PF-05 | `message.received` already carries `sender_mobile_no`, `sender_jid`, `device`, `phone_number`, `event_id` (D-023 enrichment). Sender resolution calls wa-admin `list_contacts` per event when the payload lacks a mobile (`_resolve_wa_admin_sender_mobile`) — a network call inside the receiver, no cache | `api/__init__.py:274-296` |
| PF-06 | Endpoint failure tracking is `last_failure_at/reason` only; nothing counts consecutive failures, so `Locked` (D-018) has no data source until `consecutive_failures` exists | `services/webhooks.py:545-562` |
| PF-07 | Delivery Log has no "dispatched" marker; the `*/5` cron re-enqueues all `Pending` rows regardless of an in-flight `frappe.enqueue` (F-20) | `services/webhooks.py:648-658` |
| PF-08 | Platform-specific roles (`WhatsApp System Manager`, `Support`, `Billing`) have **no DocType permissions** in any JSON; they only gate launchpad functions via `frappe.only_for`. Desk visibility for support is effectively `System Manager`-only | permissions blocks of all 21 JSONs; `page/whatsapp_launchpad.py` |
| PF-09 | Portal `disable_device` = set `status: Logged Out`; there is no "disabled by user" state distinct from "session dropped". The client's device screen cannot tell them apart from `list_devices_api` | `providers/customer_portal.py:774-785` |
| PF-10 | `Delivery Log` and `Message Queue` are in `default_log_clearing_doctypes` (30 d); `Message Log` and `Usage Ledger` are not, so per-period usage reads stay consistent. Consistent with D-021 — no retention change proposed | `hooks.py` |

## Gaps (schema-level, what must be added before the client screens work)

| # | Gap | Screen / contract | Closed by |
|---|---|---|---|
| PG-01 | No `Locked` state, no failure counter, no threshold | 15 webhook section; D-018 | Webhook Endpoint changes (table 2 row 1) |
| PG-02 | `message.held` unsubscribable | 9 Queue held state; D-024 | Webhook Event option |
| PG-03 | Delivered/read not correlatable to client rows | 4 Outbound status; D-024 | Message Log `client_ref` + `provider_message_id` index; Message Queue `message_log` index; receiver code |
| PG-04 | No per-device usage; no device on log/ledger | 15 usage, 3 device cards | Message Log `device`, Usage Ledger `device`/`integration_link` |
| PG-05 | Payload dump cannot be turned off | R-013 | Platform Settings `log_webhook_payloads` |
| PG-06 | No audit trail for elevated API writes | `security.md` | WhatsApp API Audit Log |
| PG-07 | Secret enforcement cannot be phased per consumer | D-020, R-008 | Integration Link `require_api_secret` |
| PG-08 | Pair-code flow not persisted across reloads | 3 Devices | Device `pairing_mode` (+ `update_device_api` for `phone_number`, code) |
| PG-09 | Double delivery window | PR-04 | Delivery Log `dispatched_at` + Settings grace |

## Risks

| # | Risk | L / I | Mitigation |
|---|---|---|---|
| PR-11 | Renaming `Failed` → `Locked` breaks any external consumer that string-matches `Failed` (legacy `snd_whatsapp` reads endpoint status from `list_webhook_endpoints_api`) | Low / Med | Owner-approved (D-018); patch + grep legacy for `"Failed"` on endpoint status before merge; document in `docs/` changelog |
| PR-12 | Adding `search_index` on large existing tables (`Message Log`, `Delivery Log`) locks the table during `bench migrate` on production | Med / Med | Migrate off-peak; MariaDB adds secondary indexes online for InnoDB, but test on a copy of prod data first |
| PR-13 | `consecutive_failures` semantics: counting per attempt locks after 2 events × 3 retries; counting per terminal `Failed` log locks after N events. Client sees a lock during its own deploy window | Med / Med | Count per **attempt**, reset on any 2xx; default 5; endpoint override; unlock via API. Open question OQ-1 |
| PR-14 | `client_ref` uniqueness is not enforced on `Message Queue` (`get_message_status_api` silently dedupes) — D-024 reconcile becomes ambiguous if the client re-enqueues the same ref | Med / High | Open question OQ-2: reject duplicates per `(integration_link, client_ref)` for links with a new flag, or leave and let the client guarantee uniqueness |
| PR-15 | Per-event wa-admin `list_contacts` call in the receiver (PF-05) slows every inbound message and can hit wa-admin rate limits | Med / Med | Code: cache per `(device, sender_jid)` in `frappe.cache` with TTL; backend planner |
| PR-16 | Adding role permissions to existing DocTypes (PF-08) widens desk visibility of PII (message bodies) to Support | Low / Med | Support gets read only; `Message Log.message_body` stays; if unacceptable, permlevel 1 on body/media fields |

## Recommendations

### R-1. Schema changes to make on `whatsapp-next-integration` (all in table 2/3), ordered

| Step | Change | Patch needed |
|---|---|---|
| 1 | Webhook Endpoint: options + 6 fields; Webhook Event: `message.held` | yes: `rename_failed_webhook_endpoints_to_locked` (also sets `consecutive_failures=0`) |
| 2 | Platform Settings Single (5 fields) | no (defaults) |
| 3 | Delivery Log: `dispatched_at`, `device`, 4 indexes | no |
| 4 | Message Log: `client_ref`, `device`, 3 indexes; Message Queue: 6 indexes | no (new rows only; back-fill of `device` optional, skip per D-021) |
| 5 | Device: 3 indexes, `last_status_change_at`, `last_status_reason`, `pairing_mode` | no |
| 6 | Integration Link: `require_api_secret`, `previous_api_key(_expires_at)`, `allow_device_fallback`, 2 indexes | yes: set `require_api_secret=0`, `allow_device_fallback=1` on existing rows (defaults cover inserts; patch keeps DB explicit) |
| 7 | Usage Ledger: `device`, `integration_link`, 2 indexes | no |
| 8 | API Audit Log DocType + `default_log_clearing_doctypes` 90 d | no |
| 9 | Role permission rows (PF-08) on changed DocTypes | no |

### R-2. Findings / risks of `05-platform-summary.md`: schema here vs code-only (backend planner)

| ID | Resolved by schema in this doc | Code-only (backend planner) | Not changed (by decision) |
|---|---|---|---|
| F-01 / PR-02 / R-008 | Link `require_api_secret` | enforce header when flag set; 401 instead of 417 | — |
| F-02 | — | auth checks Customer + Subscription status; 401/403 codes | — |
| F-06 | — | one currency source (plan currency) in `get_wallet_balance_api` | — |
| F-08 / G-03 | Message Log `device`, Usage Ledger `device`/`integration_link` + indexes | `get_usage_api` (current period, group by device/day); `list_message_logs_api` offset/from/to/device | no history beyond current period (D-021) |
| F-09 / PR-07 | — | `devices_used` in `get_account_api`; whether `Logged Out` occupies a slot: OQ-3 | — |
| F-10 / G-04 | Device `pairing_mode` | `update_device_api`, `reconnect_device_api` | — |
| F-11 / G-05 / Q-01 | Webhook Endpoint states + counter (D-018) | `update_webhook_endpoint_api`; lock/unlock logic in `deliver_webhook` | — |
| F-12 / Q-05 | — | — | inbound stays Delivery-Log-only (D-021) |
| F-13 / G-08 / PG-03 | Message Log `client_ref` + indexes | receiver correlates delivered/read → adds `message_log`, `client_ref`, `queue_id`, `device` to payload; sync path stores `client_ref` | Message Log status stays at `Sent` unless the planner chooses to update it (harmless) |
| F-14 / PR-03 / R-010 | Link `allow_device_fallback` | honour flag + `allow_fallback` param | — |
| F-15 | — | `frappe.rate_limit` per link key on authenticated API | — |
| F-16 / G-11 / PR-06 / R-011 | Settings `api_error_codes_in_body` | error-code enum module; `code` in every error body | — |
| F-17 / PR-01 / R-009 | — | store endpoint `secret` via `set_password`; stop re-keying old endpoints on create | — |
| F-19 / PR-10 | API Audit Log | role checks on `create_customer_subscription`, `generate_api_token`, `setup_default_notification_templates` | — |
| F-20 / PR-04 | Delivery Log `dispatched_at` + Settings grace | cron skips recently dispatched rows | — |
| F-21 / R-013 | Settings `log_webhook_payloads` | gate the `log_error`; strip body/media when logging | — |
| F-22 | — | replace raw SQL / private cursor / old cache API | — |
| G-01, G-02, G-09, G-12 | — | `list_plans_api`, `get_wallet_api`, `request_wallet_topup_api`, `cancel_queued_messages_api`, `get_account_api` | — |
| G-06 | Webhook Event `message.held` | `_notify` adds `device` | — |
| G-07 / PR-05 / Q-02 | — | — | data: dev tenant on full plan (D-019) |
| G-10 / F-18 | — | — | client polls `verify_device_connection_api` + `connection.*` webhooks |
| G-13 | Link `previous_api_key(_expires_at)` | `rotate_api_key_api`; auth accepts old key until expiry | — |
| PF-05 / PR-15 | — | cache sender resolution | — |
| PF-08 / PR-16 | permission rows | — | — |

### R-3. Webhook payload contract additions the schema enables (for the API/webhook doc in `docs/`)

| Event | Guaranteed keys after this work (additive to today's payload) |
|---|---|
| `message.received` | `event_id`, `device`, `device_name`, `phone_number`, `sender_jid`, `sender_mobile_no`, `provider_message_id`, `received_at`, `message_type`, plus raw provider fields |
| `message.delivered`, `message.read` | today's keys + `message_log`, `client_ref`, `queue_id` (null when not correlated), `device`, `provider_message_id`, `delivered_at` / `read_at` |
| `message.sent`, `message.failed` (sync path) | today's keys + `client_ref`, `device` |
| `message.held` | today's keys + `device`, `held_reason` (alias of `reason`), `status: "Held"` |

## Open questions

| # | Question | Blocking? |
|---|---|---|
| OQ-1 | `consecutive_failures` counted per HTTP attempt (proposed) or per delivery log that reaches terminal `Failed`? And on lock: cancel the endpoint's `Retrying` logs (proposed, client reconciles via `get_message_status_api`) or keep them `Pending` for redelivery after unlock? | Yes for D-018 implementation |
| OQ-2 | Enforce `client_ref` uniqueness per `(integration_link, client_ref)` on `enqueue_messages_api`? Rejecting duplicates is a behaviour change for legacy (which sends `source_docname` as ref and may resend). Proposal: enforce only when the link has `require_api_secret=1` (i.e. whatsapp_next), or add a separate `strict_client_ref` flag | Yes for D-024 reconcile |
| OQ-3 | Should `Logged Out` devices stop counting toward `device_limit` (F-09)? Changes plan enforcement for all tenants — owner call, not additive | No (client shows counts either way) |
| OQ-4 | Device "disabled by user" vs "Logged Out" (PF-09): add a `disabled` Check (additive) or keep the portal's conflation? Spec screen 3 shows only live status, so proposal: no new field | No |
| OQ-5 | Should the Audit Log be readable by the tenant through a key-auth `list_audit_log_api`, or stay desk-only? | No |
| OQ-6 | Adding read permissions for `WhatsApp Support User` on `Message Log` exposes bodies to support staff (PR-16). Accept, or permlevel-1 the body/media fields? | No |

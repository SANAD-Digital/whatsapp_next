# Backend plan — `snd_whatsapp_platform` (branch `whatsapp-next-integration`)

Additive-only backend plan for the platform, plus the external integration API surface that
`whatsapp_next` and any third party consume. Feeds phase 3 (platform prep) and later phases.
Paths below are relative to `../snd_whatsapp_platform/snd_whatsapp_platform/snd_whatsapp_platform/`
unless prefixed; line numbers are from the working tree read on 2026-09-22.

## Purpose

| Item | Value |
|---|---|
| Inputs | `05-platform-summary.md` (F-xx, G-xx, PR-xx, A-01..A-12, Q-xx), `06-doctypes-gap-platform.md` (PF-xx, PG-xx, OQ-1..6), `fields-platform.md` (tables 1–12, PFD-01..09, OQ-7/8), `decisions.md` D-013, D-018..D-024, `risks.md` R-008..R-014 |
| Binding rules | `platform.md` (additive; one exception D-018; every new endpoint versioned, permission-checked, documented for any-stack developers), `security.md` (secrets, whitelist hygiene, guest receiver, audit), `architecture.md` layering (`api/` thin, logic in `services/`, no raw SQL unless documented) |
| Scope | Code-only fixes from 06 §R-2 + every field in `fields-platform.md` + new endpoints A-01..A-11 + webhook contract + docs + build order with tests |
| Not in scope by decision | Retention/history for the client (D-021); inbound `Message Log` rows (F-12); data migration; dev-tenant plan data (D-019 is data, done in desk) |
| Versioning rule applied | New endpoints live in a new module `api/v1.py` → dotted name `snd_whatsapp_platform.snd_whatsapp_platform.api.v1.<fn>`, reachable at `/api/method/<dotted>` (Frappe also serves `/api/v1/method/<dotted>`, `frappe/api/__init__.py:94-96`). Existing `api.<fn>` names are untouched; `api.v1` re-exports them as aliases so docs present one namespace |
| Error contract rule | Every error body is `{ok:false, error:"<text>", code:"<ENUM>", ...details}` with an explicit HTTP status. `code` is additive (A-09) and gated by `WhatsApp Platform Settings.api_error_codes_in_body` |

## Inventory

### A. Where code lands

| Module | New / changed | Responsibility |
|---|---|---|
| `api/__init__.py` | changed (in place, additive) | Existing 34 endpoints keep names/shapes; fixes below applied inside them; new helpers `_get_api_link` → delegates to `services/api_auth` |
| `api/v1.py` | new | New endpoints (A-01..A-11, rotation, cancel, usage); aliases of existing endpoints; all `@frappe.whitelist(methods=[...])`, no business logic |
| `services/api_auth.py` | new | Header parsing, link resolution incl. `previous_api_key`, customer/link/subscription status, `X-SND-API-Secret` policy, per-link rate limit, `mark_last_used`; raises `ApiError` |
| `services/errors.py` | new | `ErrorCode` enum + HTTP map + `error_response()`; `ApiError(code, http_status, message, **details)`; decorator `api_endpoint()` that converts `ApiError`/`frappe.ValidationError`/`PermissionError` into the error body |
| `services/audit.py` | new | `audit(action, link, target_doctype, target_name, outcome, error_code=None, details=None, device=None, webhook_endpoint=None, auth_mode="API Key")` → inserts `WhatsApp API Audit Log` under the real `frappe.session.user`; PII-free `details` |
| `services/settings.py` | new | Cached read of `WhatsApp Platform Settings` (`frappe.get_cached_doc`), helpers `lock_threshold(endpoint)`, `redispatch_grace()`, `payload_logging_enabled(device)` (honours `webhook_payload_log_until`), `sender_cache_ttl()`, `api_rate_limit()` |
| `services/webhooks.py` | changed | Link-scoped endpoint selection; `dispatched_at`; idempotent `deliver_webhook`; counter/lock/unlock; endpoint-status gate; `set_endpoint_status()`; payload envelope helper; `message.held` support |
| `services/message_queue.py` | changed | `strict_client_ref`; recipient normalization; `device` in `_notify`; `client_ref`/`queue_id` passed to `send_message`; raw SQL → `frappe.qb`; `_claim` without `_cursor`; `cancel_rows()` |
| `services/messages.py` | changed | `client_ref`/`device` on Message Log and on sync-path payloads; ledger `device`/`integration_link`; `allow_fallback` not here (stays in `api`) |
| `services/devices.py` | changed | `set_device_status(device, status, reason)` single writer for `status` + `last_status_change_at` + `last_status_reason`; `normalize_device_phone()`; `devices_used(subscription)` |
| `services/usage.py` | new | `get_usage(link, from, to, group_by, device)` over Usage Ledger + Message Log, bounded to the current period |
| `services/accounts.py` | new | `get_account(link)`, `list_plans(link)`, `get_wallet(link)`, `request_topup(link, ...)` — reuse portal shapes (`providers/customer_portal.py:1346-1430`, `1474-1496`, `1500-1517`) |
| `services/receiver.py` | new | Body of `wa_webhook_receiver` moved out of `api/__init__.py:1305-1455` (the `api` function stays as the guest entry point): auth, rate limit, payload-log gate, device lookup, sender cache, delivered/read correlation, inbox row, dispatch |
| `services/integrations.py` | changed | `authenticate_api_request` kept for callers but delegates to `api_auth`; `mark_last_used` uses `frappe.cache.get/set` |
| `services/subscriptions.py`, `services/wallet.py` | changed | Raw SQL → `frappe.qb`; `increment_usage` without `_cursor.rowcount` |
| `doctype/whatsapp_device/whatsapp_device.py` | changed | `validate`: phone normalization, `pairing_mode=Code` requires phone; all `db_set("status", …)` → `set_device_status` |
| `doctype/whatsapp_webhook_endpoint/whatsapp_webhook_endpoint.py` | changed | validate `lock_after_failures` 0–100, `max_retries` 0–10, `timeout_seconds` 3–30; `on_update` skips wa-admin sync when only lock fields changed |
| `doctype/whatsapp_integration_link/whatsapp_integration_link.py` | changed | `validate`: new links take `require_api_secret` default from Settings; link `webhook_secret` issued at insert (no lazy re-keying, F-17) |
| `doctype/developer_test_tool/developer_test_tool.py`, `services/notifications.py`, `services/signup.py` | changed | Role checks / rate limits (F-19, guest probe) |
| `doctype/whatsapp_platform_settings/`, `doctype/whatsapp_api_audit_log/` | new | As designed in `fields-platform.md` §9–10 |
| `patches/…` | new | §J |
| `hooks.py` | changed | §K |
| `tests/` (package `snd_whatsapp_platform/snd_whatsapp_platform/tests/`) | new | §M |
| `../snd_whatsapp_platform/docs/` | new | §L |

### B. Additive change list (code-only fixes + everything in `fields-platform.md`)

Legend: **BC** = backward-compat note. "Schema" rows point at the field tables in `fields-platform.md`; their code side is here.

| # | Change | File:line today | Before | After | BC |
|---|---|---|---|---|---|
| C-01 | Auth: invalid key → 401, not 417 | `services/integrations.py:335-346`; `api/__init__.py:103-112`, direct calls at `:400`, `:548`, `:578` | `frappe.throw("Invalid API key")` → HTTP 417 with `exc_type` | `api_auth.resolve_link()` returns 401 `AUTH_INVALID_KEY` body; `send_message_api`, `get_subscription_status`, `get_wallet_balance_api` go through the same helper | Only failing calls change status. Legacy reads `payload.error` on any non-2xx (`../snd_whatsapp/.../whatsapp_platform_integration.py:743-759`) → still works |
| C-02 | Auth: customer / link status checked | `integrations.py:336` (only `status == Active` on link) | Suspended/Closed customers and Suspended/Revoked links: key still resolves if link Active; non-Active link = "Invalid API key" | Link `Suspended` → 403 `LINK_SUSPENDED`; `Revoked` → 403 `LINK_REVOKED`; `Pending` → 403 `LINK_PENDING`; Customer `Suspended/Closed` → 403 `CUSTOMER_SUSPENDED` | Stricter only for tenants that are already suspended |
| C-03 | Auth: subscription gate per endpoint, not at auth | `messages.py:42-43` (`validate_subscription` throws 417); `api/__init__.py:974-980` (402 on enqueue) | Read endpoints work when expired; send throws 417; enqueue 402 | Helper `require_active_subscription(link)` → 402 `SUBSCRIPTION_INACTIVE` (or `SUBSCRIPTION_EXPIRED`) on: send, enqueue, device create/qr/pair/reconnect, contacts, groups, webhook create/update. Read/billing endpoints (`get_account_api`, `get_wallet_api`, `list_plans_api`, `request_wallet_topup_api`, `get_subscription_status`) never gated so an expired tenant can renew | `send_message_api` expired: 417 → 402 |
| C-04 | `X-SND-API-Secret` enforcement per link (PG-07, R-008, D-020) | `api/__init__.py:108-112` (`require_secret` never True); `integrations.py:343-344` | Header ignored unless passed; mismatch → 417 | If `link.require_api_secret=1`: missing → 401 `AUTH_SECRET_REQUIRED`; mismatch → 401 `AUTH_INVALID_SECRET`. If 0 and header present: still verified (mismatch 401). Compare via `hmac.compare_digest` on `link.get_password("api_secret")` | Legacy links stay 0 (patch `set_integration_link_flag_defaults`); whatsapp_next link = 1 (data) |
| C-05 | Per-link request rate limit (F-15) | none; pattern at `api/__init__.py:87-100` (Frappe `rate_limit` keys only on `form_dict`, `frappe/rate_limiter.py:142`) | Unlimited | `api_auth._assert_link_rate_limit(link)`: Redis counter `snd-wa-api-rl:{link.name}` per 60 s window, limit `Settings.api_rate_limit_per_minute` (300; 0 = off) → 429 `RATE_LIMITED` + `Retry-After` header. Applied inside `resolve_link()` so every key-auth endpoint is covered; one batch = one request | New 429 only above 300 req/min |
| C-06 | `mark_last_used` old cache API (F-22) | `integrations.py:359,362` | `frappe.cache().get_value/set_value` | `frappe.cache.get_value` / `frappe.cache.set_value(..., expires_in_sec=60)`; called once per authenticated request from `resolve_link()` | none |
| C-07 | Error-code enum in every error body (A-09, G-11, R-011) | all `{"ok": False, "error": …}` literals in `api/__init__.py`; `frappe.throw` in `services/*` | Text only, mixed AR/EN; `frappe.throw` → 417 | `services/errors.py` (§D). Endpoints wrapped by `@api_endpoint`: `ApiError` → mapped status + body; uncaught `frappe.ValidationError` → 400 `VALIDATION_ERROR`; `frappe.PermissionError` → 403 `PERMISSION_DENIED`; other → 500 `INTERNAL_ERROR` (logged, no payload). Business rejections in `send_message` stay HTTP 200 `ok:false, rejected:true` + `code` (D-013) | Bodies gain `code`; HTTP 417 disappears from documented paths. Legacy only reads `error` |
| C-08 | Webhook endpoint states (D-018) — schema table 1 + lock logic | `services/webhooks.py:545-562`, `506-511`; `whatsapp_webhook_endpoint.json:118` | `Failed` never set; no counter | `record_delivery_result()` in `deliver_webhook`: 2xx → `consecutive_failures=0`, `last_http_status`; non-2xx/exception → `+1`, `last_http_status` (0 on exception); when `>= lock_threshold(endpoint)` → `lock_endpoint()` (§G). Writes via `db_set` (no controller `on_update` → no wa-admin re-sync) | Value `Failed` renamed to `Locked` by patch (PR-11); legacy has no string match on endpoint status (grep) |
| C-09 | Lock cancels in-flight logs (OQ-1 designed) | `webhooks.py:648-672` | — | `lock_endpoint()` sets this endpoint's `Pending`/`Retrying` Delivery Logs → `Cancelled`, `error_message="Endpoint locked"`; `enqueue_webhook_event` already skips non-Active endpoints (`:275`) | none (new state) |
| C-10 | `deliver_webhook` idempotent + endpoint gate (F-20 root cause) | `webhooks.py:513-515` | Delivers regardless of log/endpoint status → a double-enqueued job re-POSTs a `Success` row | Return early unless `log.status in (Pending, Retrying)`; if `endpoint.status != Active` and `log.event_name != "test.webhook"` → log `Cancelled` (`"Endpoint not active"`) | Disabled endpoints stop receiving stale deliveries (fix) |
| C-11 | `dispatched_at` cron guard (PG-09) — schema table 3 | `webhooks.py:302-306`, `648-658`, `661-672` | `process_pending_webhooks` re-enqueues every `Pending` row every 5 min | `enqueue_webhook_event` sets `dispatched_at=now` before `frappe.enqueue`; `process_pending_webhooks` filters `Pending` AND (`dispatched_at` is null OR `< now - Settings.webhook_redispatch_grace_minutes`), sets `dispatched_at` on re-enqueue; `retry_failed_webhooks` same guard on `Retrying` rows | none |
| C-12 | Endpoint selection scoped to the link | `webhooks.py:270-276` (filters by `subscription` + `Active`) | A subscription with two links (legacy + whatsapp_next) delivers link A's events to link B's endpoints (signed with B's secret, so they verify) | When `integration_link` is given, filter `{"integration_link": link, "status": "Active"}`; fallback to subscription filter only when `integration_link` is empty | Identical for one-link subscriptions; multi-link tenants stop cross-receiving (tenancy fix) |
| C-13 | Webhook secret handling (F-17, R-009, PFD-03) | `api/__init__.py:1192-1197`, `1210-1211`; `webhooks.py:199`, `577-610`; `whatsapp_integration_link.py:57-63` | Explicit `secret` → `link.db_set("webhook_secret", clear)`; any endpoint create lazily creates the link secret → re-keys older endpoints | (a) Link secret issued in `WhatsAppIntegrationLink.validate` on insert (existing patch `issue_integration_link_webhook_secret` back-filled old rows) → every link always has one → no lazy re-keying anywhere; `get_link_webhook_secret(create=True)` becomes a no-op safety net. (b) `secret` param on create: stored only on the endpoint (`endpoint.secret = value`, Password encrypted on insert), never on the link; documented deprecated. (c) Signing precedence unchanged (`webhooks.py:522`). (d) Response keys `secret` and `webhook_secret` both return the signing secret in use (= link secret); each reveal writes audit `secret.reveal`. (e) `get_integration_webhook_secret_api` unchanged in shape (D-013 relies on it); audited. (f) New `rotate_integration_webhook_secret_api` (v1) = explicit rotation with audit `secret.rotate`; `configure_integration_webhook_api(rotate_secret=1)` kept and audited | `secret` param no longer re-keys the link (fix); response keys unchanged |
| C-14 | `message.held` subscribable (PG-02) — schema table 2 | `whatsapp_webhook_event.json:23`; `message_queue.py:361-382` | Insert fails on the child Select; payload lacks `device` | Option added; `_notify` adds `device`, `held_reason` (alias of `reason`), `status`, envelope keys (§F) | none |
| C-15 | `client_ref` end-to-end (PG-03, A-08, D-024) — schema table 4 | `message_queue.py:142-149` (`_PAYLOAD_KEYS`), `236-264`; `messages.py:465-472`, `484-488`, `499-503`; `api/__init__.py:444-473` | Sync path has no `client_ref`; `message.sent/failed` from `mark_message_*` carry platform ids only | `client_ref` added to `_PAYLOAD_KEYS` and to `send_message_api` kwargs → `create_message_log` stores it (field exists after schema); `_deliver` passes `queue_id` kwarg; `mark_message_sent/failed` payloads add `client_ref`, `device`, `queue_id` (nullable), envelope keys | Additive payload keys |
| C-16 | `strict_client_ref` (OQ-2 designed, PR-14, PR-20) — schema table 7 | `message_queue.py:109-137`; `api/__init__.py:1016-1020` | Duplicates accepted silently; status API dedupes by `modified desc` | In `_queue_one`, when `link.strict_client_ref=1` and `client_ref` non-empty: `SELECT … FOR UPDATE` (via `frappe.qb` `.for_update()`) on `(integration_link, client_ref)` with status in (`Queued`,`Sending`,`Held`,`Sent`) → reject with per-item `code: CLIENT_REF_DUPLICATE`, `queue_id` of the existing row. `Failed`/`Cancelled` refs may be re-used | Legacy links stay 0 |
| C-17 | Recipient normalization on the queue path (PFD-05) | `message_queue.py:110,133` (raw); `messages.py:84-93` (digits, JIDs pass through) | Queue `recipient_no` stored as sent; Message Log stored digits-only (no `+`); `message.held` echoes raw | `services/common.normalize_recipient(value)`: JIDs (`@c.us`, `@s.whatsapp.net`, `@g.us`) unchanged; else strip `+`, spaces, dashes → digits; >15 digits → group. Used in `_queue_one` and `send_message` (same function). Canonical stored form = **digits without `+`** (wa-admin format) | Same digits as today for already-clean input |
| C-18 | Device fallback policy (PR-03, R-010, A-07) — schema table 7 | `api/__init__.py:411-442`, `149-171` | Silent fallback to the single other connected device | `allow_fallback = data.get("allow_fallback", link.allow_device_fallback)`; when falsy → 409 `DEVICE_NOT_CONNECTED` (with `device_status`, `rejected:true`, `message_log`) instead of fallback. `device_fallback:true` still returned when used | Default stays 1 |
| C-19 | Device status single writer + audit fields — schema table 6 | `api/__init__.py:1428-1443`, `854-878`, `827`; `whatsapp_device.py:163-167`, `199-204`, `231-249`, `263`, `293`; `messages.py:399-427`; `customer_portal.py:774-806` | Seven `db_set("status", …)` call sites; no change timestamp/reason | `devices.set_device_status(device, status, reason)` writes `status`, `last_status_change_at`, `last_status_reason` (≤140 chars, no payload), then existing side effects (`notify_status_change`, `after_save` events). All call sites switched | none |
| C-20 | Pairing mode + phone normalization (PG-08, F-10, A-05) — schema table 6 | `api/__init__.py:628-657`; `whatsapp_device.py:26-30`, `188-195`; `wa_admin_provider.py:296-303` | `phone_number` stored raw; pair code fails silently without phone | `validate`: `phone_number = normalize_mobile()`, `is_valid_mobile` when set; `pairing_mode == "Code"` and no phone → `ValidationError`. `create_device_api(pairing_mode=)`; `get_device_pair_code_api` without phone → 400 `PHONE_REQUIRED_FOR_PAIR_CODE` | none |
| C-21 | Device-limit precheck on create (F-09, PR-07) | `api/__init__.py:637-647`; `devices.py:24-28` | Never rejects; wa-admin may; failure returned as HTTP 200 Arabic text | `if not can_add_device(link.subscription)` → 409 `DEVICE_LIMIT_REACHED` `{device_limit, devices_used}` (same rule as portal: `ACTIVE_DEVICE_STATUSES`, OQ-3 untouched); wa-admin failure → 502 `PROVIDER_ERROR` | Clean 4xx/5xx where a 200 error text was returned |
| C-22 | Delivered/read correlation (F-13, PG-03) — schema table 4 indexes | `api/__init__.py:1370-1391`, `1423-1451`; `messages.py:481` | Raw provider payload only; Message Log stops at `Sent` | In receiver, for `message.delivered`/`message.read`/`message.reaction`: look up `Message Log` by `(provider_message_id, integration_link)` (exact, then suffix-after-last-`_` fallback); add `message_log`, `client_ref`, `queue_id`, `device`, `provider_message_id`, `delivered_at`/`read_at` to the payload; update log `delivered_at`/`read_at` and `status` monotonic `Sent→Delivered→Read` (never downgrade) | `list_message_logs_api(status="Sent")` returns fewer rows once delivered (documented) |
| C-23 | Inbox Delivery Log `device` (schema table 3) + `message.received` guaranteed keys | `api/__init__.py:1406-1415` | `device` only inside payload | `delivery_log.device = device.name`; payload adds `provider_message_id`, `received_at`, `message_type` (best-effort from provider `type`/`message_type`, default `Text`), `chat_jid` | additive |
| C-24 | Payload-log gate (R-013, F-21, PG-05) | `api/__init__.py:1324-1334` | Every inbound body → Error Log | `if settings.payload_logging_enabled(device_id)`: log with keys `message`, `body`, `text`, `caption`, `media*`, `sender_mobile_no`, `sender_phone` redacted (`"<redacted>"`); off after `webhook_payload_log_until` | Off by default (behaviour change intended by R-013) |
| C-25 | Receiver rate limit (`security.md`) | `api/__init__.py:1305-1318` | None | `_assert_public_rate_limit("wa-receiver", device_id or query_device, limit=RECEIVER_RATE_LIMIT_PER_MINUTE (1200), seconds=60)` after auth; 429 | Bursts above 1200/min per device only |
| C-26 | Sender-resolution cache (PF-05, PR-15) | `api/__init__.py:289-298` | wa-admin `list_contacts` per inbound message | `frappe.cache.get_value(key)` with `key = f"snd-wa:sender:{device.name}:{sha256(sender_jid)[:16]}"`, TTL `Settings.sender_resolution_cache_ttl_seconds` (3600); negative result cached 300 s; cache invalidated by `sync_device_contacts_api` for that device | none |
| C-27 | Message Log / Usage Ledger `device`, `integration_link` (PG-04) — schema tables 4, 8 | `messages.py:465-472`, `515-526`, `443-452` | Ledger has customer/subscription only | `create_message_log` auto-populates `device` (kwarg present on every path incl. `reject_message_for_unavailable_device:451`); `consume_message_units` sets `ledger.integration_link = doc.integration_link`, `ledger.device = doc.device` | none |
| C-28 | Audit trail (PG-06, D-022) — schema table 10 | none | — | `services/audit.py`; wired into every mutating key-auth call (§E "Audit" column); `Rejected`/`Error` outcomes recorded with `error_code`; desk `Platform Settings` writes → `settings.update` (`auth_mode=Desk`) | none |
| C-29 | Provisioning/secret exposure (F-19, PR-10) | `api/__init__.py:301-333`; `developer_test_tool.py:504-517`; `notifications.py:612-618` | Any logged-in user may provision and read secrets; `_server_messages = e` bug | `frappe.only_for(("System Manager", "WhatsApp System Manager"))` on all three; `create_customer_subscription` returns `api_secret` once (creation reveal) + audit `secret.reveal`; exception path → 500 `{ok:false, error, code: INTERNAL_ERROR}`; `generate_api_token` audited `secret.reveal` | Non-managers lose access (fix) |
| C-30 | Guest probe `check_recent_webhook_event` | `services/signup.py:175-210` | Guest, unlimited, scans any tenant's inbox payloads by `device`+`text` | `@rate_limit(key="device", limit=60, seconds=60)`; `device` must be `WhatsApp Notification Settings.whatsapp_device` or its backup, else `"0"` | Signup polling unchanged |
| C-31 | Raw SQL / private cursor cleanup (F-22) | §I | MariaDB-only backticks, `frappe.db._cursor.rowcount` | `frappe.qb` everywhere listed; row counts via `frappe.db.sql(..., as_dict)` return or `UPDATE … RETURNING`-free pattern (claim = `UPDATE` then `SELECT status`) | none |
| C-32 | `get_subscription_status` gains `ok` and account counters | `api/__init__.py:552-568` | No `ok` key | `ok: true`, `messages_per_minute`, `device_limit`, `devices_used`, `auto_renew`, `next_billing_date` | additive |
| C-33 | Wallet currency source (F-06) | `api/__init__.py:585` | `frappe.conf.currency` or USD | `currency` = plan currency via portal helper `_get_customer_wallet_currency` (moved to `services/accounts.py`) | Value may change from USD to the plan currency for tenants whose conf differs — flagged in Risks |
| C-34 | `hooks.ignore_links_on_delete` (PFD-01) | `hooks.py:232` (commented) | Adding Link columns to log tables would block `delete_device_api(delete_local=1)` and `delete_webhook_endpoint_api` (`api/__init__.py:823`, `1226`) | Hook set **before** any new Link column lands (§M step 2) | none |
| C-35 | `list_*` endpoints: filters and pagination (G-03) | `api/__init__.py:1242-1302` | `limit ≤ 100`, no offset/date/device | Additive params `offset` (≤ 10 000), `from`, `to`, `device`, `client_ref`, `recipient_no` (normalized), `status`, `event_name`, `webhook_endpoint`, `since`; additive response keys (§E) | additive |
| C-36 | Role permission rows (PF-08, OQ-6 designed) | DocType JSONs | Platform roles have no DocType permissions | Rows per `fields-platform.md` tables 1–10 | additive |

### C. Authentication and request pipeline (`services/api_auth.resolve_link`)

| Step | Check | Failure → HTTP / `code` |
|---|---|---|
| 0 | Frappe session/token (`Authorization: token <user_key>:<user_secret>` of a platform User) — enforced by Frappe because no key-auth endpoint is `allow_guest` | 401 Frappe `AuthenticationError` (body `exc_type`), documented as `AUTH_SESSION_REQUIRED` |
| 1 | `X-SND-API-Key` present | 400 `AUTH_KEY_MISSING` |
| 2 | Link by `api_key`, else by `previous_api_key` with `previous_api_key_expires_at > now` (only if rotation lands — OQ-P1) | 401 `AUTH_INVALID_KEY` |
| 3 | Link status `Active` | 403 `LINK_SUSPENDED` / `LINK_REVOKED` / `LINK_PENDING` |
| 4 | Customer status not in (`Suspended`, `Closed`) | 403 `CUSTOMER_SUSPENDED` |
| 5 | Secret policy (C-04) | 401 `AUTH_SECRET_REQUIRED` / `AUTH_INVALID_SECRET` |
| 6 | Rate limit (C-05) | 429 `RATE_LIMITED` (+ `Retry-After`) |
| 7 | `mark_last_used(link)`; `frappe.local.snd_api_link = link` for audit | — |
| per endpoint | `require_active_subscription(link)` where listed in §E | 402 `SUBSCRIPTION_INACTIVE` (status not Active/Trial/Near Expiry) / `SUBSCRIPTION_EXPIRED` (dates) |
| per endpoint | ownership (`_get_owned_device`, `_get_owned_webhook_endpoint`) | 404 `DEVICE_NOT_FOUND` / `WEBHOOK_NOT_FOUND` when the row does not exist; 403 `NOT_OWNER` when it belongs to another link |

### D. Error contract and code enum

Body: `{"ok": false, "error": "<human text>", "code": "<ENUM>", ...}` — extra keys per endpoint (`device`, `device_status`, `message_log`, `rejected`, `max_batch`, `available_events`, `device_limit`, `devices_used`, `retry_after`). Batch endpoints put per-item codes in `errors[].code`.

| Code | HTTP | Raised by |
|---|---|---|
| `AUTH_KEY_MISSING` | 400 | header missing |
| `AUTH_INVALID_KEY` | 401 | unknown / expired key |
| `AUTH_SECRET_REQUIRED`, `AUTH_INVALID_SECRET` | 401 | C-04 |
| `LINK_SUSPENDED`, `LINK_REVOKED`, `LINK_PENDING`, `CUSTOMER_SUSPENDED` | 403 | C-02 |
| `NOT_OWNER` | 403 | device/endpoint of another link |
| `PERMISSION_DENIED` | 403 | `frappe.PermissionError` |
| `FEATURE_NOT_IN_PLAN` | 403 | `features.assert_feature_allowed` (groups, scheduling, …), `WEBHOOKS_NOT_IN_PLAN` for webhooks |
| `SUBSCRIPTION_INACTIVE`, `SUBSCRIPTION_EXPIRED` | 402 | C-03 |
| `QUOTA_EXCEEDED` | 200 (`rejected:true`) on send; 402 on enqueue when the whole subscription has 0 remaining and no auto-renew | `messages.py:44-63`; queue hold |
| `VALIDATION_ERROR` | 400 | any `frappe.ValidationError` not mapped |
| `BATCH_EMPTY` | 400; `BATCH_TOO_LARGE` 413 | enqueue |
| `RECIPIENT_REQUIRED`, `DEVICE_NOT_FOUND`, `DEVICE_NOT_OWNED`, `CLIENT_REF_DUPLICATE`, `INVALID_MESSAGE_TYPE` | per-item (200) | `errors[]` of enqueue |
| `DEVICE_NOT_FOUND` | 404 | |
| `DEVICE_NOT_CONNECTED`, `DEVICE_NO_TOKEN`, `DEVICE_LIMIT_REACHED` | 409 | send/contacts/groups; create |
| `PHONE_REQUIRED_FOR_PAIR_CODE` | 400 | pair code |
| `PROVIDER_ERROR`, `PROVIDER_QR_UNAVAILABLE` | 502 | wa-admin failures (message truncated to 300 chars, no tokens) |
| `WEBHOOK_NOT_FOUND` 404, `WEBHOOK_URL_INVALID` 400, `WEBHOOK_EVENT_NOT_ALLOWED` 400, `WEBHOOK_NO_EVENTS` 400, `WEBHOOK_STATUS_NOT_ALLOWED` 400, `WEBHOOK_REVOKED` 409 | | webhook endpoints |
| `QUEUE_ROW_NOT_CANCELLABLE` | per-item | cancel |
| `WALLET_AMOUNT_INVALID`, `RECEIPT_INVALID` | 400 | top-up |
| `PLAN_NOT_FOUND` | 404 | plans |
| `RATE_LIMITED` | 429 | C-05, C-25 |
| `RECEIVER_UNAUTHORIZED` 401, `RECEIVER_NOT_CONFIGURED` 503 | | receiver |
| `INTERNAL_ERROR` | 500 | unexpected; traceback in Error Log without request body |

### E. External integration API surface

Base: `https://<platform-site>/api/method/`. Auth on every row unless "guest": `Authorization: token k:s` (platform User) + `X-SND-API-Key` (+ `X-SND-API-Secret` when the link requires it). Content-Type `application/json`. Rate limit: 300 req/min/link unless stated. "v1" = new dotted name `…api.v1.<fn>`; "existing" = `…api.<fn>` (also aliased under `api.v1`). "Sub" = requires active subscription (C-03). "Audit" = `WhatsApp API Audit Log.action`.

#### E.1 Account, plan, wallet, usage

| Endpoint | Method | Name | Args | Returns | Errors | Sub | Audit |
|---|---|---|---|---|---|---|---|
| `get_subscription_status` | GET/POST | existing | — | today's keys + C-32 | 401/403 | no | — |
| `get_account_api` (A-01) | GET | v1 | — | `customer{name, customer_name, email, mobile_no, status, customer_type, country}`, `subscription{name, status, plan, plan_code, plan_name, message_limit, messages_used, messages_remaining, messages_per_minute, start_date, end_date, auto_renew, next_billing_date, cumulative_messages, device_limit, devices_used, connected_devices, complimentary}`, `features{allow_*}`, `webhook_events{event_name: bool}`, `link{name, integration_type, site_name, site_url, callback_url, webhooks_enabled, default_webhook_endpoint, require_api_secret, allow_device_fallback, strict_client_ref, last_used_at, webhook_secret_set: bool}` | 401/403 | no | — |
| `list_plans_api` (A-02) | GET | v1 | — | `plans[{plan_code, plan_name, description, monthly_price, currency, billing_period, message_limit, messages_per_minute, device_limit, cumulative_messages, features{}, webhook_events{}, is_current, is_requested_renewal, is_trial}]` (active plans; trial included, flagged) | 401/403 | no | — |
| `get_wallet_balance_api` | GET/POST | existing | — | today's keys; `currency` per C-33 | | no | — |
| `get_wallet_api` (A-03) | GET | v1 | `limit?` (≤100, default 50) | `balance, currency, transactions[]` (portal fields, `customer_portal.py:1360-1380`), `billing_entries[]` (`:1381-1402`), `renewal{}` (`_get_renewal_summary`) | 401/403 | no | — |
| `request_wallet_topup_api` (A-03) | POST | v1 | `amount` (>0), `payment_method?`, `reference_no?`, `remarks?`, `receipt_base64?`, `receipt_filename?`, `receipt_mime?` (≤5 MB; pdf/jpg/png/webp) | `transaction, status: "Draft"` | 400 `WALLET_AMOUNT_INVALID` / `RECEIPT_INVALID` | no | `wallet.topup_request` (details: `amount`, `currency`, `payment_method`) |
| `get_usage_api` (A-04) | GET | v1 | `from?`, `to?` (ISO; clamped to `[subscription.start_date, now]`), `group_by?` ∈ `day\|device\|none` (default `day`), `device?` | `period{start, end}`, `totals{sent, failed, rejected, usage_units}`, `rows[{key, sent, failed, rejected, usage_units}]` (Message Log counts by status + Usage Ledger `qty`, filtered by link; `key` = `YYYY-MM-DD` or device name) | 400 `VALIDATION_ERROR` | no | — |

#### E.2 Devices and pairing (QR + 8-digit code)

| Endpoint | Method | Name | Args | Returns | Errors | Sub | Audit |
|---|---|---|---|---|---|---|---|
| `create_device_api` | POST | existing | `device_name?`, `phone_number?` (E.164 or digits; normalized), `pairing_mode?` ∈ `QR\|Code` (default QR; `Code` needs phone) | today's keys + `pairing_mode`, `phone_number`, `device_limit`, `devices_used` | 409 `DEVICE_LIMIT_REACHED`; 400 `PHONE_REQUIRED_FOR_PAIR_CODE`; 502 `PROVIDER_ERROR` | yes | `device.create` |
| `list_devices_api` | GET | existing | — | today's fields + `pairing_mode`, `last_status_change_at`, `last_status_reason`, `is_default`, `integration_link` | | no | — |
| `get_device_qr_api` | GET | existing | `device` | `qr_code` (base64 or URL), `qr_generated_at`, `qr_expires_at`, `qr_expires_in` (60), + `device`, `status`, `pairing_mode` | 409 `DEVICE_NO_TOKEN`; 502 `PROVIDER_QR_UNAVAILABLE` | yes | — |
| `get_device_pair_code_api` | GET | existing | `device` | `pair_code` (8 chars, wa-admin `PairCode`), `qr_generated_at`, `qr_expires_at`, `qr_expires_in` (60), + `device`, `status`, `phone_number` | 400 `PHONE_REQUIRED_FOR_PAIR_CODE`; 409 `DEVICE_NO_TOKEN`; 502 | yes | — |
| `verify_device_connection_api` | GET | existing | `device` | today's keys + `last_status_change_at`, `last_status_reason`, `pairing_mode` | | no | — |
| `update_device_api` (A-05) | POST | v1 | `device`, `device_name?`, `phone_number?`, `pairing_mode?` | device shape (`customer_portal.py:322-348` minus `plan_name`) + new fields | 400/403/404 | no | `device.update` (details: changed field names) |
| `reconnect_device_api` (A-05) | POST | v1 | `device` | `device.reconnect_to_wa()` then `refresh_connection_status()`; device shape | 409 `DEVICE_NO_TOKEN`; 502 | yes | `device.reconnect` |
| `disconnect_device_api` | POST | existing | `device` | today's | 409/502 | no | `device.disconnect` |
| `delete_device_api` | POST | existing | `device`, `delete_local?` | today's | | no | `device.delete` (details: `delete_local`) |
| `sync_device_contacts_api`, `list_device_contacts_api`, `list_device_groups_api` | POST / GET / GET | existing | as today | as today | 409 `DEVICE_NOT_CONNECTED` / `DEVICE_NO_TOKEN` | yes | — |
| `get_poll_results_api` | POST | existing | as today | as today | | yes | — |

Pairing flow for docs: create (`pairing_mode`) → poll `get_device_qr_api` every ≤60 s **or** call `get_device_pair_code_api` once per 60 s and enter the 8-digit code on the phone → wait for `connection.connected` webhook or poll `verify_device_connection_api` (≥5 s) → `Connected`. Realtime device status is not cross-site (F-18/G-10).

#### E.3 Messages and queue

| Endpoint | Method | Name | Args | Returns | Errors | Sub | Audit |
|---|---|---|---|---|---|---|---|
| `send_message_api` (test send only per D-024) | POST | existing | today's + `client_ref?` (≤140), `allow_fallback?` (default link flag) | today's keys; `message_log`, `provider_message_id`, `device`, `client_ref`; `device_fallback`, `requested_device` when used | 404 `DEVICE_NOT_FOUND`; 403 `NOT_OWNER`; 409 `DEVICE_NOT_CONNECTED`/`DEVICE_NO_TOKEN` (+`message_log`, `rejected`); 402; 200 `ok:false rejected:true code QUOTA_EXCEEDED\|FEATURE_NOT_IN_PLAN` | yes | — (high volume; Message Log is the record) |
| `enqueue_messages_api` (D-024) | POST | existing | `messages[]` (≤200; each: `client_ref` (required when link `strict_client_ref=1`, else optional), `device` (required for whatsapp_next by D-013; platform picks first Connected when omitted), `priority?`, `recipient_type?`, `recipient_no`/`group_id`, `message_type?`, `message_body`, media/location/poll keys, `source_*`), `batch_id?` (≤64) | `ok, batch_id, queued, rejected, accepted[{client_ref, queue_id, status}], errors[{client_ref, error, code}]` | 400 `BATCH_EMPTY`; 413 `BATCH_TOO_LARGE`; 402 `SUBSCRIPTION_*`; per-item codes §D | yes | — |
| `get_message_status_api` | POST | existing | `refs[]` (≤200) | `statuses[{client_ref, queue_id, status, reason, message_log, attempt_count, provider_message_id}]` + `device`, `sent_at`, `message_status` (Message Log status: Sent/Delivered/Read/Failed/Rejected), `delivered_at`, `read_at`; `unknown[]` | 400 | no | — |
| `cancel_queued_messages_api` (A-11) | POST | v1 | `refs[]` (≤200) **or** `batch_id` | `cancelled[{client_ref, queue_id}]`, `skipped[{client_ref, queue_id, status, code: QUEUE_ROW_NOT_CANCELLABLE}]` (only `Queued`/`Held` rows cancel; `Sending`/terminal skipped); cancelled rows get `last_error="Cancelled by client"`, payload blanked; no webhook | 400 | no | `queue.cancel` (details: `batch_id`, `count`) |
| `get_queue_status_api` | GET | existing | `batch_id?` | today's + `held_reason` (from any Held row), `counts` filtered by batch when given | | no | — |
| `list_message_logs_api` | GET/POST | existing | `limit`, `offset?`, `direction?`, `status?`, `from?`, `to?`, `device?`, `client_ref?`, `recipient_no?` | today's 12 fields + `device`, `client_ref`, `sent_at`, `delivered_at`, `read_at`; `has_more` | | no | — |

Throughput: `messages_per_minute` per subscription (plan; default 60), global `RUN_CEILING` 500/min, retries 3 × 5 min, `Held` when quota is exhausted (auto-renew from wallet if enabled), `Cancelled` after 7 days held (`message_queue.py:31-43`).

#### E.4 Webhook endpoints and secret

| Endpoint | Method | Name | Args | Returns | Errors | Sub | Audit |
|---|---|---|---|---|---|---|---|
| `list_available_webhook_events_api` | GET | existing | — | as today (`message.held` now listed, gated by `webhook_message_failed`) | | no | — |
| `list_webhook_endpoints_api` | GET | existing | — | today's + `consecutive_failures`, `lock_after_failures`, `locked_at`, `lock_reason`, `unlocked_at`, `last_http_status`, `last_triggered_at`, `max_retries`, `timeout_seconds` | | no | — |
| `create_webhook_endpoint_api` | POST | existing | `endpoint_url`, `events?`, `endpoint_name?`, `status?` ∈ `Active\|Disabled`, `max_retries?` (0–10), `timeout_seconds?` (3–30), `lock_after_failures?` (0–100), `secret?` (deprecated, C-13) | today's keys + `lock_after_failures` | 400 `WEBHOOK_URL_INVALID` / `WEBHOOK_EVENT_NOT_ALLOWED` / `WEBHOOK_NO_EVENTS` / `WEBHOOK_STATUS_NOT_ALLOWED`; 403 `WEBHOOKS_NOT_IN_PLAN` | yes | `webhook.create` (+ `secret.reveal`) |
| `update_webhook_endpoint_api` (A-06, D-018) | POST | v1 | `webhook_endpoint`, `status?` ∈ `Active\|Disabled`, `endpoint_url?`, `events?` (replaces the set), `endpoint_name?`, `max_retries?`, `timeout_seconds?`, `lock_after_failures?` | endpoint summary (list item shape) + `previous_status` | 404/403; 409 `WEBHOOK_REVOKED`; 400 as create | yes | `webhook.update`; `webhook.unlock` when `Locked→Active` |
| `test_webhook_endpoint_api` | POST | existing | `webhook_endpoint` | today's + `consecutive_failures`, `endpoint_status`; allowed while `Locked`; a 2xx resets the counter | 404/403 | no | `webhook.test` |
| `delete_webhook_endpoint_api` | POST | existing | `webhook_endpoint` | today's | 404/403 | no | `webhook.delete` |
| `list_webhook_delivery_logs_api` | GET/POST | existing | `limit`, `offset?`, `status?`, `event_name?`, `webhook_endpoint?`, `device?`, `since?` | today's + `device`, `attempt_count`, `next_retry_at`, `dispatched_at`, `integration_link`; `has_more` | | no | — |
| `get_integration_webhook_secret_api` | GET | existing | — | `webhook_secret` (the link signing secret; created if missing) | | no | `secret.reveal` |
| `rotate_integration_webhook_secret_api` | POST | v1 | — | `webhook_secret` (new; old stops signing immediately — call `get_*` again on signature failure per D-013) | | no | `secret.rotate` |
| `configure_integration_webhook_api` | POST | existing | today's (`endpoint_url`, `rotate_secret?`) | today's + `webhook_endpoint` (default device-status endpoint name) | 400 `WEBHOOK_URL_INVALID` | no | `webhook.create`/`webhook.update` + `secret.rotate` when rotated |

#### E.5 Credentials

| Endpoint | Method | Name | Args | Returns | Errors | Audit |
|---|---|---|---|---|---|---|
| `rotate_api_key_api` (G-13) | POST | v1 | — | **blocked on OQ-P1** (`api_key` is the wa-admin key, `integrations.py:237`). Designed alternative: `rotate_api_secret_api` → new `api_secret` returned once; old secret valid for `Settings.api_key_rotation_grace_hours` | | `key.rotate` |
| `create_customer_subscription` | POST | existing (managers only after C-29) | as today | as today | 403 `PERMISSION_DENIED` | `secret.reveal` |

#### E.6 Guest endpoints (unchanged unless noted)

| Endpoint | Change |
|---|---|
| `wa_webhook_receiver` | C-22..C-26; auth unchanged (`X-WA-Admin-Secret` or `snd_device`+`snd_sig`); returns `{ok, delivery_log, duplicate?}` as today; 401 `RECEIVER_UNAUTHORIZED`, 503 `RECEIVER_NOT_CONFIGURED`, 429 |
| `signup.check_recent_webhook_event` | C-30 |
| signup / password-reset endpoints | none |

### F. Webhook contract (platform → client)

| Aspect | Contract |
|---|---|
| Transport | `POST <endpoint_url>` (https, public host), body = JSON object, `Content-Type: application/json`, no redirects, timeout `timeout_seconds` (10) |
| Headers | `X-SND-Event` (event name), `X-SND-Event-ID`, `X-SND-Timestamp` (unix seconds), `X-SND-Signature` (hex), + new additive `X-SND-Delivery` (Delivery Log name) and `X-SND-Attempt` (1-based) |
| Signature | `hex(HMAC-SHA256(secret, f"{X-SND-Timestamp}.{raw_body}"))`; secret = link secret from `get_integration_webhook_secret_api` (endpoint `secret` only for pre-secret links, `webhooks.py:522`). Verify with constant-time compare; reject if `abs(now - timestamp) > 300 s` (replay guard, client-side rule) |
| Idempotency | Client dedupes on `(X-SND-Event, X-SND-Event-ID)` — the same `event_id` (provider message id) is reused across `message.sent`/`delivered`/`read` for one message, so the pair is the key. Platform dedupes per `(webhook_endpoint, event_name, event_id)` before creating a delivery (`webhooks.py:282-290`) and inbox rows per `(integration_link, event_name, event_id)` (`api/__init__.py:1394-1404`) |
| Retry | Attempt 1 immediately (`frappe.enqueue`, queue `short`); on non-2xx/timeout: `Retrying` with `next_retry_at = +5 min` while `attempt_count < max_retries` (3) → up to 3 attempts, fixed 5-minute spacing; terminal `Failed` afterwards. Cron `*/5` picks `Retrying` due rows and `Pending` rows not dispatched within the grace window (C-11). Respond 2xx within `timeout_seconds`; body ignored (stored, 5 000 chars) |
| Lock | Each failed attempt increments `consecutive_failures`; any 2xx resets it. At `lock_after_failures` (5, or Settings default when 0) the endpoint becomes `Locked`: its `Pending`/`Retrying` deliveries are `Cancelled` (`error_message="Endpoint locked"`), no new deliveries are created. `test_webhook_endpoint_api` is allowed while Locked; a 2xx resets the counter. Unlock = `update_webhook_endpoint_api(status="Active")`. Reconcile after unlock: `get_message_status_api` (outbound) and `list_webhook_delivery_logs_api(status="Cancelled", since=locked_at)`; inbound events created during the lock are **not replayed** (see OQ-P2) |
| Plan gating | `connection.*` always; other events need `allow_webhooks` + the matching `webhook_*` flag; `message.held` rides on `webhook_message_failed` (`webhooks.py:105`) |
| Delivery record | `list_webhook_delivery_logs_api`; rows purged after 30 days (`hooks.py:283`); client persists what it needs (D-021) |

Events and guaranteed keys (all additive to today's payloads; `∅` = may be null). Envelope keys on **every** event: `event`, `event_id`, `integration_link`, `subscription`, `device`∅, `device_name`∅, `phone_number`∅ (the device's number), `occurred_at` (ISO, server time).

| Event | Source | Guaranteed keys beyond the envelope |
|---|---|---|
| `message.received` | receiver (`api/__init__.py:1376-1391`, C-23) | `status` (device), `wa_device_id`, `sender_jid`, `sender_mobile_no`∅ (digits), `provider_message_id`, `received_at`, `message_type`, `chat_jid`∅, `signup_verification`∅, plus raw provider fields (`message`/`text`/`body`, media keys) |
| `message.sent` | sync path (`messages.py:484-488`, C-15) and queue path (`message_queue.py:281`, `361-382`) | `message_log`, `provider_message_id`∅, `client_ref`∅, `queue_id`∅, `status: "Sent"`; queue path adds `source_site`, `source_doctype`, `source_docname`, `recipient_no`, `attempt_count` |
| `message.failed` | sync (`messages.py:499-503`), queue terminal (`message_queue.py:295`), held expiry (`:356`, `status: "Cancelled"`) | `message_log`∅, `reason`, `client_ref`∅, `queue_id`∅, `status` ∈ `Failed\|Cancelled` |
| `message.held` | `hold_subscription` (`message_queue.py:317`, C-14) | `queue_id`, `client_ref`, `message_log`∅, `recipient_no`, `attempt_count`, `reason`, `held_reason`, `status: "Held"` |
| `message.delivered`, `message.read` | receiver + C-22 | provider fields + `provider_message_id`, `message_log`∅, `client_ref`∅, `queue_id`∅, `delivered_at` / `read_at` |
| `message.reaction` | receiver | provider fields + `provider_message_id`∅, `message_log`∅, `client_ref`∅, `sender_jid`∅ |
| `connection.connected`, `connection.disconnected`, `connection.logged_out` | receiver, `verify_device_connection_api`, `Device.after_save` | `status` (`Connected`/`Logged Out`), `wa_device_id`, `last_status_reason`∅ |
| `group.updated`, `group.participants.updated` | receiver | provider fields + `wa_device_id` |
| `test.webhook` | `test_webhook_endpoint_api` | `created_at`, `data.message`; `event_id: "evt_test"` |

### G. Webhook endpoint state machine (D-018; states `Active / Disabled / Locked / Revoked`)

| From → To | Trigger | Side effects |
|---|---|---|
| `Active → Locked` | `consecutive_failures >= threshold` in `record_delivery_result` | `locked_at=now`, `lock_reason="<n> consecutive failures, last HTTP <code>"`, cancel `Pending`/`Retrying` logs of the endpoint, `db_set` (no wa-admin sync), platform notification to the customer (existing `services/notifications` channel; OQ-P4) |
| `Locked → Active` | `update_webhook_endpoint_api(status="Active")` or desk | `unlocked_at=now`, `consecutive_failures=0`, audit `webhook.unlock` |
| `Locked → Disabled` | API/desk | `consecutive_failures=0`, `unlocked_at=now` |
| `Active → Disabled`, `Disabled → Active` | API/desk | audit `webhook.update` (details `status: A→B`); `on_update` wa-admin re-sync runs only for `Active` (`whatsapp_webhook_endpoint.py:62-64`) |
| `Disabled → Locked` | never | counter does not run for non-Active endpoints (no deliveries) |
| `* → Revoked` | desk / `revoke_link` cascade (new: revoking a link revokes its endpoints) | terminal for the API: `update_webhook_endpoint_api` → 409 `WEBHOOK_REVOKED`; delete still allowed |
| `Revoked → *` | desk only | — |
| Client-settable values | `Active`, `Disabled` only (`WEBHOOK_STATUS_NOT_ALLOWED` otherwise) | |
| Deliveries created only for | `Active` (`webhooks.py:275`) | `deliver_webhook` gate (C-10) |

### H. Queue, scheduler and job changes

| Hook / job | Today (`hooks.py:9-25`) | Change |
|---|---|---|
| `cron * * * * *` `message_queue.process_message_queue` | raw SQL scans | Same schedule; `frappe.qb`; `_claim` via `UPDATE … WHERE status='Queued'` then re-read status (no `_cursor`); `_deliver` passes `client_ref`, `queue_id` |
| `cron */5` `webhooks.process_pending_webhooks` | re-enqueues all `Pending` | Grace filter on `dispatched_at` (C-11), batch cap 500 rows/run, sets `dispatched_at` |
| `cron */5` `webhooks.retry_failed_webhooks` | enqueues due `Retrying` | Same + grace guard + skips endpoints not `Active` (logs → `Cancelled`) |
| `daily` (new) `api_auth.expire_previous_api_keys` | — | Only if OQ-P1 chooses rotation with grace: clears expired `previous_api_key*` |
| `daily` (new) `settings.auto_disable_payload_logging` | — | Sets `log_webhook_payloads=0` once `webhook_payload_log_until` has passed (receiver already treats it as off; this keeps the desk honest) |
| `after_commit` realtime | `publish_device_status_update` to portal users | unchanged (G-10 accepted) |
| Queues | `short` for webhook delivery and queue sends | unchanged; new `cancel_rows()` runs in-request (≤200 rows) |
| `default_log_clearing_doctypes` | Queue 30 d, Delivery Log 30 d | + `WhatsApp API Audit Log` 90 |

### I. Raw-SQL / portability cleanup (F-22)

| Site | Today | After |
|---|---|---|
| `api/__init__.py:1047-1056` queue counts | backtick SQL | `frappe.qb.from_(Queue).select(Queue.status, Count("*")).where(...).groupby(Queue.status)` |
| `message_queue.py:163-173`, `188-199`, `222-233`, `301-315`, `327-338`, `344-347` | backtick SQL, `_cursor.rowcount` | `frappe.qb` selects/updates; `_claim`: `frappe.qb.update(Queue).set(status='Sending').where(name==n & status=='Queued').run()` then `frappe.db.get_value(Queue, n, "status") == "Sending"` (row locked by the update inside the same transaction); `release_subscription` counts rows via a prior `select` |
| `subscriptions.py:83-100` `increment_usage` | `_cursor.rowcount` after conditional `UPDATE` | `frappe.qb.update(...).where(messages_used + units <= limit)`, then compare `messages_used` before/after (`SELECT … FOR UPDATE` on the row first) |
| `wallet.py:8-15` | `quote_table` SQL | `frappe.qb` with `Sum` + `Case` |
| `integrations.py:359,362` | `frappe.cache()` | `frappe.cache.*` |
| `api/__init__.py:333` | `_server_messages = e` | removed (C-29) |
| `services/db.py` named locks | `get_lock`/advisory | kept (documented exception: no `frappe.qb` equivalent) |
| Reports `report/*` | raw SQL | out of scope (desk only); documented exception |

### J. Patches (`patches.txt`, `[post_model_sync]`, in this order)

| # | Patch | Does | Idempotent |
|---|---|---|---|
| P-1 | `rename_failed_webhook_endpoints_to_locked` | `status='Failed'` → `Locked`, `lock_reason='Migrated from Failed'`, `locked_at=modified`; `consecutive_failures=0` where NULL (`fields-platform.md` table 1) | yes |
| P-2 | `set_integration_link_flag_defaults` | `require_api_secret=0`, `allow_device_fallback=1`, `strict_client_ref=0` where NULL (table 7) | yes |
| P-3 | `ensure_integration_link_webhook_secrets` | For links still without a decrypted `webhook_secret` (`get_link_webhook_secret(link)` empty) call `_store_link_webhook_secret` — closes C-13(a) for rows the earlier patch missed | yes |
| P-4 | `seed_platform_settings` | Insert the Single with JSON defaults (Frappe does this on first `get_single`; patch makes `bench migrate` deterministic and validates `webhook_payload_log_until` rule) | yes |
| P-5 | `add_platform_role_permissions` | No-op placeholder if permissions ship in JSON (preferred); exists only if JSON rows must be applied via `frappe.permissions.add_permission` for custom roles | yes |
| Data (not a patch) | whatsapp_next link: `require_api_secret=1`, `allow_device_fallback=0`, `strict_client_ref=1`; dev tenant plan flags (D-019) | desk / `bench console` | — |

Existing 12 patches untouched. `bench migrate` order: DocType sync (index builds, PR-12/PR-18) → patches.

### K. `hooks.py` changes (all additive)

| Hook | Value |
|---|---|
| `ignore_links_on_delete` | `["WhatsApp Message Log", "WhatsApp Message Queue", "WhatsApp Webhook Delivery Log", "WhatsApp Usage Ledger", "WhatsApp API Audit Log"]` (Frappe honours it at `frappe/model/delete_doc.py:313,395,444`) |
| `default_log_clearing_doctypes` | + `"WhatsApp API Audit Log": 90` |
| `scheduler_events.daily` | + `api_auth.expire_previous_api_keys` (conditional on OQ-P1), + `settings.auto_disable_payload_logging` |
| `doc_events` | + `"WhatsApp Platform Settings": {"on_update": "services.audit.on_settings_update"}` |
| Nothing else | no `override_whitelisted_methods`, no `auth_hooks` |

### L. Docs plan — `../snd_whatsapp_platform/docs/`

Audience: an external developer on any stack. Every endpoint page shows request/response in **curl, Python (`requests`), JavaScript (`fetch`)**. Written as each endpoint lands (`platform.md`).

| Page | Content |
|---|---|
| `README.md` | Index, support contact, versioning policy, changelog link |
| `quickstart.md` | 10 minutes: get credentials (portal → API keys + link key), `get_account_api`, create device, pair (QR or code), send one message via `enqueue_messages_api`, receive `message.sent` webhook, check `get_message_status_api` |
| `authentication.md` | Two credentials (`Authorization: token`, `X-SND-API-Key`), `X-SND-API-Secret` policy per link, how to obtain each, rotation (webhook secret; key/secret per OQ-P1), 401/403 table |
| `base-url-and-versioning.md` | `/api/method/<dotted>` and `/api/v1/method/<dotted>`; `api.v1.*` namespace; deprecation policy (never remove; additive only) |
| `endpoints/account.md` | `get_account_api`, `get_subscription_status`, `list_plans_api`, `get_wallet_api`, `get_wallet_balance_api`, `request_wallet_topup_api`, `get_usage_api` |
| `endpoints/devices.md` | Device lifecycle + **pairing guide** (QR loop 60 s, 8-digit code flow, `pairing_mode`, phone format), status meanings, limits |
| `endpoints/messages.md` | `enqueue_messages_api` (batch, `client_ref`, `strict_client_ref`, `Held`), `get_message_status_api` (reconcile loop), `cancel_queued_messages_api`, `send_message_api` (test send; fallback), `get_queue_status_api`, `list_message_logs_api`, message types and media rules |
| `endpoints/webhooks.md` | Endpoint CRUD, states diagram (§G), `lock_after_failures`, testing, delivery logs |
| `webhooks/contract.md` | §F transport/headers/signature/retry/idempotency/lock; **signature verification samples** in Python, Node.js, PHP; timestamp tolerance |
| `webhooks/events.md` | Per-event JSON schema (§F table) with examples captured from the dev tenant |
| `errors.md` | §D table + HTTP mapping + "business rejection vs error" (`rejected:true`) |
| `rate-limits.md` | 300 req/min/link, batch caps, `messages_per_minute`, global ceiling, wa-admin per-key hourly cap, 429 handling with `Retry-After` |
| `sandbox.md` | Dev tenant on `w-platform.dev.sanad.digital`, `source_type=Simulator`, mock provider when no device is connected (`providers/mock_provider.py`), simulating inbound with the Developer Test Tool (`X-WA-Admin-Secret`), payload-log debug switch |
| `changelog.md` | D-018 rename `Failed→Locked`; new fields/keys; deprecations (`secret` param) |
| `openapi.yaml` | Machine-readable surface for the `v1` namespace (generated by hand in phase 3, kept in sync per endpoint) |

### M. Build order (numbered; each step ships with tests under `snd_whatsapp_platform/snd_whatsapp_platform/tests/`)

Test harness: `frappe.tests.IntegrationTestCase` (Frappe 16) + HTTP-level calls through `frappe.tests.utils.FrappeAPITestCase`-style client (verify exact class on 16.28 in step 1); `unittest.mock.patch` on `providers.wa_admin_provider.*` (no network); shared `tests/fixtures.py` builds Customer → Plan → Subscription → Link → Device → Endpoint. Run: `bench --site w-platform.dev.sanad.digital run-tests --app snd_whatsapp_platform`.

| # | Step | Depends on | Tests (file → cases) |
|---|---|---|---|
| 1 | Foundations: `services/errors.py`, `services/api_auth.py`, `services/settings.py`, `services/audit.py`, `WhatsApp Platform Settings`, `WhatsApp API Audit Log`, `hooks` (`ignore_links_on_delete`, log clearing), `api/v1.py` skeleton with aliases; `_get_api_link` → `resolve_link`; C-01, C-02, C-05, C-06, C-07, C-29, C-30 | — | `test_api_auth.py`: missing header 400; invalid key 401; suspended link/customer 403; secret required/invalid 401 (flag on) vs accepted (flag off); rate limit 429 + header; alias whitelisting (`api.v1.get_subscription_status` resolves). `test_audit.py`: row per mutating call, real user, no PII in `details`. `test_settings.py`: `webhook_payload_log_until` validation (PR-19). `test_provisioning_roles.py`: non-manager 403 on `create_customer_subscription`, `generate_api_token`, `setup_default_notification_templates`; guest probe scoped + limited |
| 2 | Schema batch A (D-018): Webhook Endpoint fields + `Locked`, Webhook Event `message.held`, Delivery Log `device`/`dispatched_at`/indexes; P-1; C-08..C-12, C-14 | 1 | `test_webhook_lock.py`: counter per attempt, reset on 2xx, lock at threshold (endpoint override vs Settings default), in-flight logs cancelled, test allowed while Locked, unlock resets, Disabled endpoint receives nothing, Revoked → 409. `test_webhook_dispatch.py`: `deliver_webhook` idempotent on Success/Cancelled rows; grace window skips recently dispatched; link-scoped endpoint selection (two links, one subscription); `message.held` subscribable and payload has `device` |
| 3 | `update_webhook_endpoint_api`, `list_webhook_endpoints_api` additive fields, `create_webhook_endpoint_api` changes (C-13 b–d), `rotate_integration_webhook_secret_api`, link secret at insert (C-13 a), P-3 | 2 | `test_webhook_api.py`: update status/url/events/threshold; validation codes; secret never stored in clear on the link; create no longer re-keys; rotate audited; signature header verifies with link secret |
| 4 | Schema batch B: Message Log `client_ref`/`device`/indexes; Message Queue indexes; Usage Ledger `device`/`integration_link`; C-15, C-16, C-17, C-27; P-2 (flags) | 1 (hook first) | `test_queue_client_ref.py`: `client_ref` on sync path payloads; `strict_client_ref` duplicate rejected with existing `queue_id`, allowed after `Failed`; recipient normalization (`+966…`, spaces, JIDs, >15 digits → group); ledger carries device/link |
| 5 | Receiver refactor (`services/receiver.py`): C-22..C-26 | 2, 4 | `test_receiver.py`: auth paths; rate limit; payload log off by default and redacted when on; device found by `wa_device_id` (index); inbox row has `device`; delivered/read correlate (`exact` and suffix fallback) and update log status monotonic; sender cache hit avoids `list_contacts`; unsupported event stored, not dispatched |
| 6 | Schema batch C: Device `pairing_mode`/status audit/indexes; `services/devices.set_device_status`; C-19, C-20, C-21; `update_device_api`, `reconnect_device_api`, additive device responses | 1 | `test_devices_api.py`: create with `pairing_mode=Code` requires phone; phone normalized; limit precheck 409; QR/pair responses carry TTL fields; status change writes `last_status_*` from every writer; update/reconnect audited; `delete_local` succeeds with logs present (hook) |
| 7 | Account/plan/wallet/usage: `services/accounts.py`, `services/usage.py`, `get_account_api`, `list_plans_api`, `get_wallet_api`, `request_wallet_topup_api`, `get_usage_api`, C-32, C-33, C-35 | 4 | `test_account_usage_wallet.py`: shapes; `devices_used`; usage grouped by day/device bounded to period; top-up creates Draft credit with receipt validation; expired subscription can still read/renew (C-03 gate matrix) |
| 8 | Messages/queue endpoints: `send_message_api` (`client_ref`, `allow_fallback`, codes), `enqueue_messages_api` per-item codes, `get_message_status_api` additive keys, `cancel_queued_messages_api`, `get_queue_status_api` qb, C-18, C-31 | 4 | `test_messages_api.py`: fallback off → 409 `DEVICE_NOT_CONNECTED`; business rejection stays 200 `rejected:true` + code; cancel matrix (Queued/Held/Sending/terminal); queue counts by batch; `_claim` exclusivity under two runs |
| 9 | Role permission rows (C-36) + P-5 | 1 | `test_permissions.py`: `WhatsApp Support User` read-only on listed DocTypes; Customer User unchanged (`permission_query_conditions`) |
| 10 | Credentials rotation (blocked on OQ-P1) | 1 | `test_credentials.py` |
| 11 | Docs (§L) written per step; `changelog.md`; `openapi.yaml` | all | Doc examples executed against the dev tenant once (manual checklist in `docs/sandbox.md`) |
| 12 | Merge path: `whatsapp-next-integration` → `feat/link-webhook-secret` → `main` before production (R-014); rehearse `bench migrate` on a prod copy (PR-12/PR-18) | all | `test_patches.py`: P-1..P-3 idempotent on a fixture DB |

## Findings

| # | Finding | Evidence | Consequence for the plan |
|---|---|---|---|
| PB-01 | `Integration Link.api_key` **is** the wa-admin API key (issued by `admin_create_api_key`, copied onto the link); `wa_api_key_id` is its id; devices are created under it | `services/integrations.py:138-162`, `231-242`; `whatsapp_device.py:104-121` | `rotate_api_key_api` (G-13, PFD-02) cannot be a local operation: a new key means a new wa-admin key and split device slots. Raised as OQ-P1; step 10 blocked |
| PB-02 | Endpoint selection is by subscription, not link | `services/webhooks.py:270-276` | Two links on one subscription cross-deliver; C-12 fixes it (tenancy) |
| PB-03 | `deliver_webhook` has no status or endpoint gate; a duplicate job re-POSTs a delivered row; Disabled endpoints still receive stale deliveries from the cron | `services/webhooks.py:513-562`, `648-658` | C-10 is the real F-20 fix; `dispatched_at` (C-11) reduces load |
| PB-04 | Queue path emits `message.sent` twice per message: once from `mark_message_sent` (event_id = provider id, no `client_ref`) and once from `_notify` (hashed event_id, with `client_ref`) | `services/messages.py:484-488`; `services/message_queue.py:281` | After C-15 both carry `client_ref`; the client must dedupe on `(client_ref, status)` as well. Merging them is a behaviour change → OQ-P3 |
| PB-05 | PFD-05 verified: `recipient_no` is stored as **digits without `+`** on the send path; JIDs pass through; the queue stores the raw string; `Device.phone_number` is not normalized | `services/messages.py:84-93`; `services/message_queue.py:110,133`; `whatsapp_device.py:26-30` | Canonical platform form = digits (wa-admin format), not `+E.164`. `fields-platform.md` §Purpose "stores normalized E.164 (`+9665…`)" must read "E.164 digits without `+`"; client sends digits |
| PB-06 | Same provider `message_id` is the `event_id` for `sent`, `delivered`, `read` | `api/__init__.py:216-232`; `services/webhooks.py:242-252` | Client idempotency key must be `(event, event_id)`; documented in §F |
| PB-07 | Legacy consumer tolerates status-code changes: it reads `payload.error` on any non-2xx and never inspects `exc_type`/417 | `../snd_whatsapp/.../whatsapp_platform_integration.py:743-759` | C-01/C-03/C-07 are safe for legacy |
| PB-08 | `Frappe.rate_limit` keys only on `form_dict`, so a header-keyed per-link limit needs the app's own counter (pattern already present) | `frappe/rate_limiter.py:104-170`; `api/__init__.py:87-100` | C-05 design |
| PB-09 | `send_message_api` authenticates twice (endpoint + `send_message(api_key=…)`), and three endpoints bypass `_get_api_link` | `api/__init__.py:400,548,578`; `services/messages.py:30-35` | All routed through `resolve_link`; `send_message` receives `integration_link` + `is_api_request=True` |
| PB-10 | `test_webhook_endpoint` reuses `event_id="evt_test"` for every test → the endpoint-level dedupe does not apply (it inserts directly), fine; but the client will see repeated `evt_test` ids | `api/__init__.py:589-611` | Docs: never dedupe `test.webhook` on `event_id` alone |
| PB-11 | Receiver stores every inbound event as a `Success` inbox row even when unsupported, and `handle_signup_verification_message` runs before plan gating | `api/__init__.py:1371-1375`, `1406-1425` | Kept (signup depends on it); inbox rows purged at 30 d |
| PB-12 | Frappe 16 on the bench maps `RateLimitExceededError` → 429, `AuthenticationError` → 401, `PermissionError` → 403, `ValidationError` → 417 | `frappe/exceptions.py:24-45,138-139` | Explicit `http_status_code` on returned dict bodies (existing pattern) avoids 417 |
| PB-13 | `WhatsApp API User` role is seeded and unreferenced | `install.py:107-117` | Candidate for binding the platform token user to key-auth (OQ-P5) |

## Gaps

| # | Gap | Closed by |
|---|---|---|
| G-01..G-13 (05) | plan catalogue, wallet, usage, device update/reconnect, endpoint update, `message.held`, `client_ref` sync path, queue cancel, error codes, account read, auth statuses | §E rows + C-xx as mapped in 06 §R-2; G-07 by data (D-019); G-10 stays (poll + `connection.*`) |
| PG-01..PG-09 (06) | lock state, held, correlation, per-device usage, payload gate, audit, secret policy, pairing mode, double dispatch | C-08..C-11, C-14, C-22, C-27, C-24, C-28, C-04, C-20 |
| New | Link-scoped endpoint delivery (PB-02) | C-12 |
| New | Idempotent delivery job (PB-03) | C-10 |
| New | Guest probe exposure (C-30) | C-30 |
| Open | Key rotation semantics (PB-01) | OQ-P1 |
| Open | Inbound replay after unlock | OQ-P2 |

## Risks

| # | Risk | L / I | Mitigation |
|---|---|---|---|
| RB-01 | Status-code changes (417→401/402/403/409) surprise an unknown third-party consumer | Low / Med | Legacy verified tolerant (PB-07); `changelog.md`; `api_error_codes_in_body` only gates `code`, not statuses — keep a one-release note in docs |
| RB-02 | C-12 link scoping silently stops events for a tenant that relied on cross-link delivery | Low / Med | Grep dev/prod for subscriptions with >1 Active link before deploy; announce in changelog |
| RB-03 | Delivered/read correlation depends on wa-admin's `message_id` format matching what `send` returned | Med / Med | Suffix fallback (C-22); verify with the payload-log switch on the dev tenant before step 5 closes; unknown ids still deliver the raw event |
| RB-04 | Double `message.sent` (PB-04) confuses status tables on the client | Med / Low | Client dedupes on `(client_ref, status)`; OQ-P3 |
| RB-05 | `strict_client_ref` `FOR UPDATE` under concurrent batches (PR-20) | Low / Med | Lock inside `_queue_one`'s transaction; test in step 4 |
| RB-06 | Index builds on large `Message Log`/`Delivery Log` tables during `bench migrate` (PR-12/PR-18) | Med / Med | Off-peak; rehearse on a copy; steps 2 and 4 are separate deploys |
| RB-07 | C-33 changes `currency` for tenants whose `frappe.conf.currency` differs from the plan currency | Low / Low | Announce; `get_wallet_api` is the authoritative shape |
| RB-08 | `deliver_webhook` gate (C-10) cancels deliveries queued for endpoints a desk user set `Disabled` expecting later delivery | Low / Low | Documented semantics: Disabled = drop |
| RB-09 | Payload-log switch left on by a developer | Low / Med | `webhook_payload_log_until` mandatory ≤ 7 days (PR-19), daily auto-off job |
| RB-10 | Alias whitelisting under `api.v1` might be rejected by a future Frappe check on the function's module | Low / Low | Test in step 1; fallback = thin wrappers instead of imports |

## Recommendations

| # | Recommendation | Why |
|---|---|---|
| RC-1 | Ship steps 1–3 as the first platform deploy (auth fixes, error codes, lock state, `update_webhook_endpoint_api`) — this unblocks whatsapp_next screens 1, 15 and the provider adapter's error layer | D-018, D-020, R-011 |
| RC-2 | Land `ignore_links_on_delete` (step 1) strictly before step 4 | PFD-01 |
| RC-3 | Treat digits-without-`+` as the platform's canonical phone form and have the client's E.164 service strip `+` at the provider boundary | PB-05 |
| RC-4 | Client idempotency = `(event, event_id)` for provider-forwarded events plus `(client_ref, status)` for queue events | PB-04, PB-06 |
| RC-5 | Turn the payload-log switch on for one device on the dev tenant during step 5 only, then off | R-013, RB-03 |
| RC-6 | Keep `send_message_api` for the test send only (D-024); the docs quickstart uses `enqueue_messages_api` | D-024 |
| RC-7 | Write `docs/webhooks/contract.md` and `docs/errors.md` before the client's phase that builds the provider adapter, so both sides code against the same text | `platform.md` |
| RC-8 | Every reveal of a secret (`get_integration_webhook_secret_api`, create response, `generate_api_token`, provisioning) writes an audit row; add `secret.reveal` to the `action` Select | PFD-03, `security.md` |

## Open questions

| # | Question | Designed / recommended | Alternative | Blocking? |
|---|---|---|---|---|
| OQ-P1 | Key rotation (G-13, PFD-02, OQ-8): `api_key` is the wa-admin key (PB-01). Rotate the **secret** instead (local, with grace via `previous_api_secret` Password + expiry, replacing `previous_api_key` Data) and keep `api_key` as a public identifier under `require_api_secret=1`? | Rotate `api_secret`; drop `previous_api_key*` fields; keep `api_key_rotation_grace_hours` for the secret | Rotate `api_key` by creating a new wa-admin key, re-point `wa_api_key_id`, delete the old key after grace (needs wa-admin semantics for devices under a deleted key) | Yes for step 10 only |
| OQ-P2 | Inbound events created while an endpoint is Locked are never delivered (deliveries are created only for Active endpoints). Add `update_webhook_endpoint_api(status="Active", replay_missed=1)` that re-creates deliveries from inbox rows between `locked_at` and now (≤500, within 30-day retention)? | Add it (additive, bounded) | Client accepts loss and polls `list_message_logs_api`/provider contacts (D-021 spirit) | No (screen 15 works either way) |
| OQ-P3 | Merge the duplicate queue-path `message.sent`/`message.failed` (PB-04) into one event carrying all keys (one fewer webhook per message)? | Keep both, identical keys (no behaviour change) | Suppress the sync-path event when `queue_id` is present | No |
| OQ-P4 | Notify the customer on lock (email/WhatsApp via `services/notifications`) and add `webhook.locked` to the platform notification templates? | Yes, reuse `WhatsApp Notification Template` event types | Desk-only visibility | No |
| OQ-P5 | Bind the Frappe token user to the link (`customer_user` / customer `portal_user`) or require role `WhatsApp API User` for key-auth calls? | Audit-only in step 1 (`details.user_matches_link`), enforce in a later release | Enforce now (403 `AUTH_USER_MISMATCH`) — may break existing tokens | No |
| OQ-P6 | Receiver rate limit as a Settings field (`receiver_rate_limit_per_minute`) instead of a code constant (1200)? | Constant now; field later if tuning is needed | Field in `WhatsApp Platform Settings` (additive) | No |
| OQ-P7 | `fields-platform.md` phone wording: "E.164 (`+9665…`)" vs platform reality (digits without `+`, PB-05) — update the field doc? | Update the doc to "E.164 digits without `+`" | Store `+` on the platform (would change wa-admin payloads and every existing row) | No |

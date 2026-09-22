# 05 — Platform summary: `snd_whatsapp_platform`

Phase 1 analysis of the subscription platform the new client app (`whatsapp_next`) will consume.
Read-only analysis of the working tree; git was not run. Companion to `01-legacy-summary`.

## Purpose

| Item | Value |
|---|---|
| Real folder | `/home/snd/frappe-bench/apps/snd_whatsapp_platform` (no `paltform` misspelling anywhere) |
| Python package | `snd_whatsapp_platform/snd_whatsapp_platform/` (module `snd_whatsapp_platform`, one Frappe module) |
| Branch (from `.git/HEAD`) | `feat/link-webhook-secret` (confirms R-002) |
| Site | `w-platform.dev.sanad.digital` |
| Role in the system | Multi-tenant SaaS control plane: tenants, plans, subscriptions, wallet/billing, devices, message send/queue, outbound webhooks. Delegates all WhatsApp I/O to **wa-admin** (`https://wa-admin.sanad.digital/api`, client in `gaide_whatsapp_api.py`) |
| Consumers today | Legacy `snd_whatsapp` (via `X-SND-API-Key` API), the platform's own Vue portal (`/whatsapp`), Frappe desk |
| Constraint for this project | Platform changes must be **additive only** |

## Inventory

### A. Packages and entry points

| Path (under `snd_whatsapp_platform/snd_whatsapp_platform/`) | Contents |
|---|---|
| `api/__init__.py` (1456 lines) | Entire external API: 34 whitelisted functions (see D/E) plus `wa_webhook_receiver` |
| `services/` (20 modules) | `integrations` (auth, wa-admin API keys), `messages` (send path), `message_queue` (batch queue), `subscriptions`, `billing`, `wallet`, `plans`, `features`, `devices`, `webhooks` (outbound + wa-admin registration + secrets), `signup`, `customer_registration`, `customer_users`, `notifications`, `scheduled_messages`, `campaigns`, `redirect`, `common`, `db` |
| `providers/` | `wa_admin_provider.py` (thin wrapper over `WaAdminSanadClient`), `mock_provider.py` (used when no connected device), `customer_portal.py` (session-auth portal API, 30 whitelisted methods) |
| `doctype/` | 21 DocTypes (table C) |
| `page/whatsapp_launchpad`, `workspace/whatsapp_platform`, `workspace_sidebar/`, `desktop_icon/` | Desk UX |
| `report/` | `whatsapp_customers_last_message`, `whatsapp_customer_detail` (script reports) |
| `www/` | `whatsapp.py` (SPA shell), `whatsapp_signup.py`, `whatsapp_password_reset.py`, `auth_context.py` (en/ar, RTL) |
| `frontend/` (repo root) | Vue 3 + frappe-ui SPA; routes `/whatsapp`, `/devices`, `/devices/:id`, `/billing`, `/billing/upgrade`, `/integration`, `/settings`; all calls go to `providers.customer_portal.*` |
| `patches/` (12 patches, all present) | incl. `issue_integration_link_webhook_secret`, `set_plan_messages_per_minute`, `normalize_whatsapp_device_statuses` |
| `plan.md` (Arabic design doc) | Original blueprint; still lists device statuses `Disconnected`/`Blocked` that the code has since removed |
| Tests | Only `test_whatsapp_signup_request.py` has real tests (8). All other `test_*.py` are empty stubs. No API tests |

### B. Hooks (`hooks.py`)

| Hook | Value | Note |
|---|---|---|
| `scheduler_events.daily` | `billing.process_auto_renewals`, `subscriptions.mark_expired_subscriptions`, `subscriptions.send_expiry_alerts` | |
| `scheduler_events.cron "* * * * *"` | `message_queue.process_message_queue` | every minute |
| `scheduler_events.cron "*/5 * * * *"` | `scheduled_messages.process_scheduled_messages`, `webhooks.process_pending_webhooks`, `webhooks.retry_failed_webhooks` | |
| `before_request` | `redirect.redirect_customer` | `WhatsApp Customer User` hitting `/app` or `/desk` is 302'd to `/whatsapp` |
| `doc_events` | `User.validate_reset_password -> notifications.on_user_password_reset` | |
| `permission_query_conditions` / `has_permission` | `WhatsApp Integration Link` only | customer users see only their own links (read/select) |
| `role_home_page` | `WhatsApp Customer User -> whatsapp` | |
| `website_route_rules` | `/signup`, `/whatsapp/signup`, `/reset-password`, `/forgot*`, `/whatsapp/<path>` | |
| `app_include_js` / `web_include_js` | launchpad cache, auth redirect | |
| `after_install` | seeds 5 plans, 5 roles, notification templates/settings | |
| `default_log_clearing_doctypes` | `WhatsApp Message Queue` 30d, `WhatsApp Webhook Delivery Log` 30d | Delivery Log doubles as the inbound event store (see F-12) |
| Not used | `override_whitelisted_methods`, `auth_hooks`, `api_version`, `fixtures` | |

Roles created: `WhatsApp System Manager`, `WhatsApp Support User`, `WhatsApp Billing User`, `WhatsApp Customer User`, `WhatsApp API User` (last one unreferenced in code).

### C. DocTypes

| DocType | Naming | Key fields | Status enum | Controller behaviour |
|---|---|---|---|---|
| WhatsApp Customer | series | customer_name, mobile_no (unique, normalised), email, portal_user, customer_type (`API Only / SANAD SaaS Customer / ERPNext Customer / Internal / Trial`), country, wa_api_key(_id), sanad_* | `Active / Trial / Suspended / Closed` | after_insert/on_update ensure portal user; `create_portal_user` whitelisted. **Customer status is never checked by the API auth** |
| WhatsApp Plan | `field:plan_code` | plan_name, monthly_price, currency, billing_period, message_limit, messages_per_minute, cumulative_messages, device_limit, is_active/is_featured/sort_order, 7 `allow_*` feature flags, 11 `webhook_*` event flags | — | validates code/limits/webhook flags |
| WhatsApp Plan Snapshot | series | source_plan, snapshot_reason (`New Subscription / Plan Upgrade / Plan Renewal / Manual`), frozen copy of all plan limits/flags | — | created by `plans.create_plan_snapshot` |
| WhatsApp Subscription | series | customer, plan, requested_renewal_plan, plan_snapshot, start/end_date, billing_period, message_limit, messages_per_minute, cumulative_messages, device_limit, messages_used, messages_remaining, auto_renew, complimentary_subscription, expiry_notification_days, last_renewal_date, next_billing_date, linked_saas_site, all feature + webhook flags (copied from snapshot) | `Trial / Active / Near Expiry / Expired / Suspended / Cancelled` | validate dates/usage, one active per customer (`validate_active_limit`), copies snapshot fields, syncs wa-admin API key limits on update |
| WhatsApp Integration Link | series | customer, subscription, integration_type (`SANAD SaaS Site / External ERPNext / API Only`), site_name/site_url/api_base_url/callback_url, **api_key** (Data), **api_secret** (Password), wa_api_key_id, allowed_ip (unused), match_method/confidence, webhooks_enabled, default_webhook_endpoint, **webhook_secret** (Password, new on this branch), customer_user, generate_user_keys, last_used_at | `Pending / Active / Revoked / Suspended` | validate creates wa-admin API key + local secret; changing subscription re-points its devices |
| WhatsApp Device | series | device_name, phone_number, customer, subscription, integration_link, qr_code, qr_generated_at, **pair_code**, last_seen, wa_device_id, device_token (Password), wa_api_key_ref, wa_webhook_id/url/registered_at/error, is_default, device_uid | `Pending QR / Connected / Logged Out` | after_insert creates on wa-admin + registers platform webhook; device limit enforced only when status flips to Connected; whitelisted doc methods `get_qr_code`, `get_pair_code`, `refresh_connection_status`, `disconnect_from_wa`, `reconnect_to_wa`, `get_sync_status`, `register_platform_webhook` |
| WhatsApp Message Log | hash | customer, subscription, integration_link, source_type (`SANAD ERPNext / External API / Campaign / Manual / Simulator / Scheduled Message / Provider Webhook`), source_site/doctype/docname, api_request_id, direction (`Outgoing / Incoming`), message_type (14 values), recipient_type, recipient_no, group_id, body, media_*, location_*, poll_*, failure_reason, counted_as_usage, usage_units, sent/delivered/read/received_at, provider_message_id, provider_response | `Queued / Sent / Failed / Rejected / Delivered / Read / Received` | no controller logic; **`Delivered/Read/Received/Incoming` are never written by any code path** |
| WhatsApp Message Queue | hash | customer, subscription, integration_link, device, priority, batch_id, client_ref, source_*, message_type, recipient_no, payload (JSON), attempt_count, next_attempt_at, message_log, held_reason, last_error, queued_at, sent_at | `Queued / Sending / Sent / Failed / Held / Cancelled` | payload blanked after terminal state |
| WhatsApp Usage Ledger | hash | customer, subscription, posting_datetime, entry_type (`Usage / Reversal / Adjustment / Monthly Reset`), qty, message_log, remarks | — | only `Usage` rows are ever written |
| WhatsApp Wallet Transaction | series | customer, transaction_type (`Credit / Debit / Refund / Adjustment`), amount, currency, posting_date, payment_method, reference_no/attachment, related_subscription/billing_entry, approved_by/at | `"" / Draft / Approved / Cancelled` | balance counts only `Approved` |
| WhatsApp Billing Entry | series | customer, subscription, plan, billing_period_start/end, amount, currency, due_date, wallet_transaction, payment_method, reference_*, renewal_processed | `Draft / Unpaid / Paid / Cancelled / Failed` | on_update hooks renewal when marked Paid |
| WhatsApp Webhook Endpoint | series | customer, subscription, integration_link, endpoint_name, endpoint_url, secret (Password), events (child), max_retries (3), timeout_seconds (10), last_triggered/success/failure_at, last_failure_reason, registered_on_wa_admin, wa_admin_registered_at, wa_admin_error | `Active / Disabled / Failed / Revoked` | validates https/public URL, plan feature, >=1 event; re-registers wa-admin webhooks on status/events change |
| WhatsApp Webhook Event (child) | — | event_name (Select, **11 options, no `message.held`**), enabled | — | |
| WhatsApp Webhook Delivery Log | hash | customer, subscription, integration_link, webhook_endpoint (nullable), event_name, event_id, payload, attempt_count, next_retry_at, http_status_code, response_body, error_message, created_at, delivered_at | `Pending / Success / Failed / Retrying / Cancelled` | rows with empty `webhook_endpoint` are the inbound wa-admin event inbox |
| WhatsApp Signup Request | hash | request_key, purpose (`Signup / Password Reset`), verification_channel (`WhatsApp / Email`), code hash, expected_sender_id, plan, resulting customer/subscription/link | `Pending Verification / Verified / Completed / Expired / Failed` | |
| WhatsApp Campaign | series | customer, subscription, scheduled_at, counts, message_body | `Draft / Scheduled / Running / Completed / Cancelled / Failed` | feature-gated; `services.campaigns` is a stub |
| WhatsApp Scheduled Message | series | customer, subscription, integration_link, related_campaign, scheduled_at, recipient, body, media_url, message_log, error | `Pending / Sent / Failed / Cancelled` | feature-gated; processed every 5 min |
| WhatsApp Notification Template | `field:template_key` | event_type (9 platform events), channels, subject/body, whatsapp_subject/body | — | |
| WhatsApp Notification Settings | Single | channel (`Email / WhatsApp / Both`), whatsapp_device (+backup), fallback email, outgoing account | — | platform's own notification sender |
| Developer Test Tool | Single | API console (endpoint, method, api_key/secret, headers, body, saved requests) | — | whitelisted `generate_api_token` returns any link's `api_secret` to any desk user |
| Saved API Request, API Test Header | child tables | | | |

### D. External API (`snd_whatsapp_platform.snd_whatsapp_platform.api.*`) — key-authenticated

All rows: `@frappe.whitelist()` (Frappe session **required**) + header `X-SND-API-Key` resolved to an **Active** Integration Link. Ownership of device/endpoint checked against that link. Responses are `{ok: bool, ...}`. HTTP codes set explicitly; `frappe.throw` yields 417.

| Method | HTTP verb | Inputs | Returns | Explicit codes | Used by legacy client |
|---|---|---|---|---|---|
| `get_subscription_status` | GET/POST | — | status, plan(_code), messages_used/limit/remaining, start/end_date, features{allow_*} | 400 | yes |
| `get_wallet_balance_api` | GET/POST | — | balance, currency (`frappe.conf.currency` or USD) | 400 | yes |
| `create_device_api` | POST | device_name?, phone_number? | device, qr_code (usually empty), wa_device_id, status | 400; wa-admin failure -> `{ok:false}` with Arabic error, HTTP 200 | yes |
| `list_devices_api` | GET | — | devices[name, device_name, phone_number, status, wa_device_id, wa_webhook_*, last_seen, creation, modified] | 400 | yes |
| `get_device_qr_api` | GET | device (query) | qr_code, qr_generated_at, qr_expires_at, qr_expires_in (60) | 400/403; throws if no token | yes |
| `get_device_pair_code_api` | GET | device (query) | pair_code, qr_generated_at, qr_expires_at, qr_expires_in (60) | 400/403; throws if no token or no phone | yes |
| `verify_device_connection_api` | GET | device | device, status (normalised), provider raw | 400/403 | yes |
| `disconnect_device_api` | POST | device | provider result; device -> Logged Out | 400/403 | yes |
| `delete_device_api` | POST | device, delete_local? | deleted, wa_admin result; without `delete_local` -> Logged Out only | 400/403 | yes |
| `sync_device_contacts_api` | POST | device, phones (list/csv) | provider contacts | 400/403/409 | no |
| `list_device_contacts_api` | GET | device | contacts[] | 400/403/409 | yes |
| `list_device_groups_api` | GET | device | groups[] | 400/403/409 | yes |
| `send_message_api` | POST | device (required), recipient_type, recipient_no/group_id, message_type, message_body, caption, media_url/media_base64/filename/mime, view_once, location_*, poll_*, source_* | ok, message_log, provider_message_id; may add `device_fallback`, `requested_device` | 400/403/404/409; quota/feature rejections return **200** with `ok:false, rejected:true, message_log` | yes |
| `enqueue_messages_api` | POST | messages[] (<=200; each: client_ref, device?, priority?, recipient..., same payload keys), batch_id? | queued, rejected, accepted[{client_ref, queue_id, status}], errors[] | 400/402/413 | yes |
| `get_message_status_api` | POST | refs[] (<=200) | statuses[{client_ref, queue_id, status, reason, message_log, attempt_count, provider_message_id}], unknown[] | 400 | yes |
| `get_queue_status_api` | GET | — | counts{status: n}, messages_per_minute, messages_remaining | 400 | no |
| `get_poll_results_api` | POST | device, poll_ids[] (<=100) | results[{poll_id, ok, result/error}] | 400/403/409 | yes |
| `list_message_logs_api` | GET/POST | limit (<=100), direction?, status? | logs[] (12 fields) | 400 | yes |
| `list_webhook_endpoints_api` | GET | — | webhooks[] with events[] | 400 | yes |
| `list_available_webhook_events_api` | GET | — | allow_webhooks, allowed_events[], events[{event_name,label,enabled,disabled_reason}] | 400 | yes |
| `create_webhook_endpoint_api` | POST | endpoint_url, events?, endpoint_name?, secret?, status?, max_retries?, timeout_seconds? | webhook_endpoint, events, status, secret, **webhook_secret**, registered_on_wa_admin | 400 | yes |
| `delete_webhook_endpoint_api` | POST | webhook_endpoint | deleted | 400/403 | yes |
| `test_webhook_endpoint_api` | POST | webhook_endpoint | status, http_status_code, response_body | 400/403 | yes |
| `configure_integration_webhook_api` | POST | endpoint_url (or api_base_url/callback_url), rotate_secret? | endpoint_url, **webhook_secret**, configured_devices[] | 400 | yes |
| `get_integration_webhook_secret_api` | GET | — | **webhook_secret** (created on demand) | 400 | yes |
| `list_webhook_delivery_logs_api` | GET/POST | limit (<=100) | logs[] | 400 | no |
| `create_customer_subscription` | POST (any logged-in user) | plan_code, mobile_no, full_name, email, integration_type, ... | customer, subscription, integration_link, **api_key, api_secret**, portal_user | 500 on error (bug: assigns exception object to `_server_messages`) | provisioning only |

### E. Guest / public endpoints

| Method | Rate limit (Frappe `rate_limit` + custom IP+identity key) | Purpose |
|---|---|---|
| `get_signup_bootstrap` | 60/h per IP | active plans (excluding `free_trial`) + notification device status + code TTL (10 min) |
| `start_signup` | 5/h per mobile_no, +5/h per IP+mobile | creates Signup Request; code by WhatsApp (self-message to platform's device) or email fallback |
| `get_signup_status` / `get_password_reset_status` | 180/h per token | polling |
| `verify_email_code`, `complete_signup`, `complete_password_reset` | 10/h per token | |
| `start_password_reset` | 5/h per identifier | |
| `signup.check_recent_webhook_event` | none | guest probe over Delivery Log payloads (device+text match) |
| `wa_webhook_receiver` | none | inbound from wa-admin; auth = header `X-WA-Admin-Secret == conf.wa_admin_secret` **or** query `snd_device` + `snd_sig` (HMAC-SHA256 of device name with same secret); 401/503 |

### F. Portal (session) API — `providers.customer_portal` (platform site only)

`get_dashboard`, `get_devices`, `get_device_create_options`, `get_device_detail`, `create_device`, `update_device`, `get_device_qr`, `get_device_pair_code`, `refresh_device`, `reconnect_device`, `disconnect_device`, `disable_device`, `enable_device`, `delete_device`, `send_test_message`, `get_subscription`, `renew_current_subscription_from_wallet`, `get_logs`, `get_settings`, `update_settings`, `update_auto_renew`, `update_expiry_notification_days`, `save_integration_link`, `get_customer_user_api_keys`, `get_wallet` (balance + 50 transactions + 50 billing entries), `request_subscription_renewal_payment`, `request_wallet_topup`, `get_available_plans`, `upgrade_subscription_plan`, `set_portal_language`, `notify_portal_logout`. Auth = `WhatsApp Customer User` whose email/portal_user matches a Customer. Realtime: `frappe.publish_realtime("snd_whatsapp_device_status", user=portal_user)`.

### G. Outbound webhook contract (platform -> client)

| Aspect | Working-tree behaviour |
|---|---|
| Transport | `POST endpoint_url`, body = raw JSON of `Delivery Log.payload`, `allow_redirects=False`, timeout `endpoint.timeout_seconds` (10) |
| Headers | `X-SND-Event`, `X-SND-Event-ID`, `X-SND-Timestamp` (unix s), `X-SND-Signature` = hex `HMAC-SHA256(secret, f"{timestamp}.{raw_body}")`, `Content-Type: application/json` |
| Secret precedence | link `webhook_secret` (if present) **else** endpoint `secret`. Link secret is created lazily by `get_integration_webhook_secret_api`, `configure_integration_webhook_api`, or **any** `create_webhook_endpoint_api` call; stored via `set_encrypted_password` with a masked column |
| URL policy | https only, hostname must resolve to a public IP (DNS resolved on every delivery), no credentials, not localhost |
| Retry | `_schedule_retry`: +1 attempt, `Retrying` with `next_retry_at = +5 min` while `attempt_count < max_retries` (3); cron `*/5` redelivers `Retrying` and re-enqueues **all `Pending`** |
| Dedupe | `(webhook_endpoint, event_name, event_id)`; event_id = explicit id in payload or sha256[:16] of a canonical subset |
| Event catalogue (`SUPPORTED_WEBHOOK_EVENTS`) | `message.received`, `message.sent`, `message.delivered`, `message.read`, `message.failed`, `message.held`, `message.reaction`, `connection.connected`, `connection.disconnected`, `connection.logged_out`, `group.updated`, `group.participants.updated` |
| Plan gating | connection.* always allowed; every other event needs `subscription.allow_webhooks` **and** the matching `webhook_*` flag. Seeded plans: Starter/Growth none; Business sent/delivered/read/failed only (**no `message.received`**); Enterprise all |
| Payload shapes | `message.sent` from send path: `{message_log, provider_message_id}` only; queue path adds `{queue_id, client_ref, message_log, source_*, recipient_no, attempt_count, status}`; `message.failed` `{message_log, reason}` (+queue fields); `message.held` queue fields + reason; connection.* `{device, device_name, phone_number, status, wa_device_id}`; provider-forwarded events (received/delivered/read/reaction/group.*) = wa-admin payload enriched with `event, device, device_name, phone_number, status, wa_device_id, integration_link, subscription, event_id, sender_jid?, sender_mobile_no?` |

### H. wa-admin dependency (`site_config` keys)

| Key | Use |
|---|---|
| `wa_admin_api_url` | default `https://wa-admin.sanad.digital/api` |
| `wa_admin_secret` | admin endpoints (api-key CRUD, device admin), inbound receiver auth, signing of `snd_sig` |
| `currency` | wallet currency reported by `get_wallet_balance_api` |
| `encryption_key` | signup code hashing |

Per-link wa-admin API key payload: `max_devices = device_limit (+ "Blocked" slots, always 0 now)`, `max_messages = message_limit`, `rate_limit_per_hour = message_limit`.

## Findings

| # | Area | Finding | Evidence |
|---|---|---|---|
| F-01 | Auth model | External callers need **two credentials**: a Frappe user token on the platform site (`Authorization: token key:secret`, because no API endpoint is `allow_guest`) plus `X-SND-API-Key` = Integration Link `api_key`. The link's `api_secret` / `X-SND-API-Secret` is **never enforced** in the working tree (`require_secret` is never passed `True`; `send_message` passes `api_secret=None`). Legacy client stores three values (`customer_api_key`, `api_key`, `api_secret`) and only sends `X-SND-API-Secret` in an unused `api_key_secret` mode | `api/__init__.py:103-112`, `services/integrations.py:335-346`, legacy `whatsapp_platform_integration.py:715-726` |
| F-02 | Auth model | `authenticate_api_request` checks only link `status == Active`. Customer status (`Suspended/Closed`) and subscription status are **not** checked at auth time; subscription is checked only inside `send_message` / `enqueue_messages_api`. Invalid key -> `frappe.throw` -> HTTP **417**, not 401 | `integrations.py:336-344` |
| F-03 | Tenancy | Tenant = `WhatsApp Customer` -> N `WhatsApp Subscription` (one "active" = first of Active/Trial/Near Expiry) -> N `WhatsApp Integration Link` (one per client site / API consumer, pinned to one subscription) -> N `WhatsApp Device` -> N `WhatsApp Webhook Endpoint`. **All API scoping is by Integration Link**, so the new client is a tenant-slice = one link | DocType links; `_get_owned_device`, `_get_owned_webhook_endpoint` |
| F-04 | Plans | Plan = code + price + `message_limit` (per period) + `messages_per_minute` + `device_limit` + 7 feature flags + 11 webhook flags + `cumulative_messages` (carry-over). Plans are **snapshotted** into `WhatsApp Plan Snapshot` and copied onto the subscription; the subscription is the source of truth at runtime, not the plan. Signup always starts on `free_trial` (14 days) with `requested_renewal_plan` = chosen plan | `services/plans.py`, `subscriptions.py:5-16,144-176`, `customer_registration.py:55-62` |
| F-05 | Message balance | Denormalised counters on the subscription: `message_limit`, `messages_used`, `messages_remaining`; decremented atomically (`UPDATE ... WHERE messages_used + n <= limit`) **after** provider success; one `Usage Ledger` row per sent message. Failed/Rejected messages are not counted. Renewal resets `messages_used=0` and sets `start_date=today`, `end_date=+1 month` (period is **re-anchored** on renewal, not aligned to the original cycle); remaining messages carry over only if `cumulative_messages` | `messages.py:111-113,515-526`, `subscriptions.py:79-104,155-176` |
| F-06 | Wallet balance | Separate money ledger: balance = sum(Approved Credit+Refund) - sum(Approved Debit) of `WhatsApp Wallet Transaction`; computed on read, no cached balance. Wallet is spent **only** on plan renewal (`renew_from_wallet` -> Billing Entry Paid + Debit). Top-ups are requests (Draft, receipt upload) approved by staff in desk. Currency: API reports `frappe.conf.currency`/USD; portal reports plan currency | `wallet.py`, `billing.py:62-123`, `customer_portal.request_wallet_topup` |
| F-07 | Balance interplay | Message exhaustion triggers an **inline wallet renewal** if `auto_renew` (sync path: inside `send_message`; queue path: `hold_subscription` parks all Queued rows as `Held`, `release_subscription` on renewal, `Cancelled` after 7 days). Daily `process_auto_renewals` renews at `end_date` if wallet covers price, else creates an `Unpaid` Billing Entry and sets status `Expired` | `subscriptions.py:56-76`, `message_queue.py:184-214,299-358`, `billing.py:126-160` |
| F-08 | Usage metering | Real usage history is in `WhatsApp Usage Ledger` + `WhatsApp Message Log` but **neither is exposed to API-key callers** beyond `list_message_logs_api` (max 100, no date filter, no pagination). No "usage by day/device" endpoint. `get_queue_status_api` gives queue counts + `messages_per_minute` + `messages_remaining` | API inventory |
| F-09 | Device lifecycle | States: `Pending QR` -> `Connected` -> `Logged Out` (patch collapsed `Disconnected`/`Blocked`). Creation is synchronous with wa-admin (`create_on_wa_admin` -> `device_token`, `wa_device_id`) then platform webhook registration on the device. Status is updated by (a) wa-admin webhook (`connection.*` normalised from free-text statuses), (b) `verify_device_connection_api` poll, (c) pre-send refresh, (d) send failures with "not logged in" markers -> `Pending QR`. **Device limit counts all three statuses** (Logged Out devices occupy a slot) and is enforced only when a device becomes `Connected`, so `create_device_api` never rejects on limit; wa-admin `max_devices` may reject instead (then the platform deletes stale wa-admin devices and retries) | `whatsapp_device.py`, `devices.py:3`, `api/__init__.py:835-887,1423-1446` |
| F-10 | Pairing | Both modes exist and are exposed to the API: **QR** (`get_device_qr_api` -> base64/URL in `qr_code`, TTL **60 s**, `qr_expires_at`) and **pair code** (`get_device_pair_code_api` -> wa-admin `PairCode`, requires `device.phone_number` set at create time; stored in `pair_code`; the same 60 s TTL fields are reused). No endpoint updates `phone_number` for an existing device via API (portal `update_device` only). On "invalid client" errors both paths recreate the device on wa-admin transparently (new token). Neither path pushes the moment of connection to the client except via the `connection.connected` webhook or polling `verify_device_connection_api` | `whatsapp_device.py:152-223`, `wa_admin_provider.py:286-303` |
| F-11 | Webhook endpoint states | Enum is `Active / Disabled / Failed / Revoked`. Only `Active` receives events. `Failed` and `Revoked` are **never set by code**; `Disabled` only manually in desk. There is **no API to update an endpoint** (status, URL, events) — only create/delete/test. There is **no "Locked" state** anywhere; the closest concepts are (a) delivery log `Retrying`->`Failed` after `max_retries`, (b) Integration Link `Suspended/Revoked` (kills all API access), (c) the wa-admin registration DB lock. The spec's `locked` state must therefore be a client-side derivation or an additive platform field | `whatsapp_webhook_endpoint.json`, `webhooks.py:266-306,506-562` |
| F-12 | Inbound messages | `wa_webhook_receiver` does **not** create `WhatsApp Message Log` rows (direction `Incoming` is unused). Every inbound provider event is stored once as a `Delivery Log` row with `webhook_endpoint` empty (dedupe by `event_id`), then forwarded only if the plan allows the event. Delivery Logs are purged after 30 days. So the only durable record of an inbound message is on the client, and only Enterprise (or a custom plan with `webhook_message_received`) receives it | `api/__init__.py:1305-1455`, `hooks.py:281-284`, `install.py` |
| F-13 | Message status | `Message Log.status` stops at `Sent`; `delivered/read` events are forwarded raw and never correlated back to the log (no `provider_message_id` lookup). The client must do the correlation (`provider_message_id` is returned by `send_message_api` and in `get_message_status_api`) | `messages.py:475-488`, receiver |
| F-14 | Send semantics | `send_message_api` silently **falls back to the single other connected device** when the requested one is down (`device_fallback: true`) for non-group sends. For a multi-number tenant this sends from the wrong number. Queue path (`enqueue_batch`) has no fallback; when `device` is omitted the platform picks the first Connected device of the subscription | `api/__init__.py:409-442`, `messages.py:143-148` |
| F-15 | Rate limits | No per-key request rate limit on authenticated API. Throughput limit = `messages_per_minute` per subscription (default 60, from plan or `DEFAULT_RATE`), enforced only by the queue scheduler (`RUN_CEILING` 500/min across all tenants). Payload caps: batch 200, status refs 200, poll ids 100, list limit 100. wa-admin also enforces `rate_limit_per_hour = message_limit` per API key. Public endpoints use Frappe `rate_limit` (table E) | `message_queue.py:23-43,63-72`, `api/__init__.py:87-100` |
| F-16 | Error codes | No error code enum. Contract is HTTP status + `{ok:false, error:"<text>"}` with text mixed Arabic/English. Explicit statuses used: 400 (missing header/param), 401 (receiver), 402 (subscription invalid on enqueue), 403 (ownership), 404 (device, send only), 409 (device not connected / no token), 413 (batch too large), 500 (provisioning), 503 (receiver misconfigured). Anything raised with `frappe.throw` (invalid key, feature not in plan, quota exceeded, device limit, https validation) comes back as **417** with `exc_type`/`_server_messages`. Business rejections inside `send_message` are **HTTP 200** with `rejected:true` and a `Rejected` Message Log | `api/__init__.py`, `messages.py:529-534` |
| F-17 | R-002 (secret linking, in flux) | Working tree: (1) new Password field `Integration Link.webhook_secret`; (2) `get_link_webhook_secret(create)` / `rotate_link_webhook_secret` store via `set_encrypted_password` and mask the column; (3) `deliver_webhook` prefers the link secret; (4) `create_webhook_endpoint_api` with explicit `secret` writes it with `db_set` **in clear text** (inconsistent with (2); healed lazily on next read); (5) any endpoint creation now forces a link secret into existence, which **changes the signing key of pre-existing endpoints** of that link; (6) patch `issue_integration_link_webhook_secret` exists. Legacy client already calls `configure_integration_webhook_api` and `get_integration_webhook_secret_api` and verifies `X-SND-Signature` over `"<timestamp>.<raw>"`, so client and platform tree agree. Parts most likely to move: the `secret` parameter semantics of `create_webhook_endpoint_api`, whether `rotate_secret` stays on `configure_integration_webhook_api`, and whether per-endpoint `secret` is dropped | `webhooks.py:513-645`, `api/__init__.py:1070-1213` |
| F-18 | Realtime | Device status realtime (`snd_whatsapp_device_status`) is published to the platform portal user only; cross-site clients get nothing in real time except webhooks | `webhooks.py:384-417` |
| F-19 | Provisioning | `create_customer_subscription` is callable by **any logged-in user** (no role check) and returns `api_secret` in clear. `developer_test_tool.generate_api_token` returns any link's secret to any desk user. `setup_default_notification_templates` has no role check | cited lines above |
| F-20 | Duplicates | `process_pending_webhooks` re-enqueues every `Pending` log every 5 min while the immediate `frappe.enqueue` may still be in flight -> possible double POST of the same event (same `X-SND-Event-ID`); clients must be idempotent on `event_id` | `webhooks.py:302-306,648-658` |
| F-21 | Observability | Every inbound provider webhook body is written to **Error Log** (`frappe.log_error(title="WhatsApp Platform Webhook Payload")`) — PII and log growth | `api/__init__.py:1324-1334` |
| F-22 | Portability | MariaDB-only raw SQL with backticks in `message_queue.py` and `get_queue_status_api` despite a `db.quote_table` helper; use of private `frappe.db._cursor.rowcount`; `frappe.cache().get_value` (old API) next to `frappe.cache.make_key`; `frappe.response._server_messages = e` bug. Nothing blocks Frappe 16 today but these are the first things to break | cited modules |
| F-23 | Legacy coverage | Legacy already consumes 23 of the 27 key-auth endpoints (table D). Unused: `sync_device_contacts_api`, `get_queue_status_api`, `list_webhook_delivery_logs_api`, `create_customer_subscription` | grep of `../snd_whatsapp` |

## Gaps (what the new client cannot get from the platform today)

| # | Gap | Impact on spec screen |
|---|---|---|
| G-01 | No plan catalogue for key-auth callers (only guest `get_signup_bootstrap` which excludes the trial plan, or portal session) | Screen 15 (Subscription) cannot show upgrade options |
| G-02 | No wallet transactions / billing entries / top-up request via API (portal only) | Screen 15 wallet section read-only balance at best |
| G-03 | No usage history endpoint (Usage Ledger, per-day/per-device counts); `list_message_logs_api` capped at 100, no date range, no offset | Screen 15 usage, Screen 2 dashboard charts |
| G-04 | No device rename / phone update / enable-disable via API; no `reconnect` via API | Screen 3 Devices (pair-by-code needs `phone_number` at creation) |
| G-05 | No webhook endpoint update (status/URL/events) and no per-endpoint delivery health beyond `last_failure_*` | Webhook states UI |
| G-06 | `message.held` cannot be subscribed (child Select lacks the option -> insert fails); held notifications never reach clients | Screen 9 Queue "paused by plan" state |
| G-07 | `message.received` only on Enterprise-class plans; Business plan sends nothing inbound | Screens 5 (Inbound), 13 (WhatsApp Numbers), conversation drawer |
| G-08 | No `client_ref` on `message.sent`/`message.failed` from the **sync** send path; only the queue path adds it | Outbound correlation |
| G-09 | No queue control for callers (pause/resume/cancel a queued row or batch) | Screen 9 pause/resume must be client-side only |
| G-10 | Realtime device status not available cross-site | Screen 3 "live status" = poll `verify_device_connection_api` or rely on `connection.*` webhooks |
| G-11 | No error code enum, no i18n-neutral error identifiers | Client error mapping/translation |
| G-12 | No API to read the tenant profile (customer name/email/mobile/status) or the integration link itself (`callback_url`, `webhooks_enabled`) | Screen 15 settings header |
| G-13 | No subscription/customer suspension check at auth; no key rotation endpoint for `X-SND-API-Key` | Security posture |

## Risks

| # | Risk | Likelihood / impact | Mitigation in `whatsapp_next` plan |
|---|---|---|---|
| PR-01 | R-002: webhook secret contract changes again (parameter `secret`, `rotate_secret`, precedence) before the client ships | Med / High | Client stores the secret from `get_integration_webhook_secret_api` only; verifies `X-SND-Timestamp.body`; re-fetch on signature failure; never passes `secret` to `create_webhook_endpoint_api` |
| PR-02 | Two-credential auth (Frappe token + link key) is undocumented; a client design assuming one key will fail with 403 `PermissionError` | High / High | Settings must hold three values; onboarding wizard must obtain the Frappe user token (portal `get_customer_user_api_keys` or manual) |
| PR-03 | Device fallback sends from the wrong number for multi-device tenants | Med / High | Always pass `device`; treat `device_fallback:true` as a warning surfaced in Outbound; request additive `allow_fallback=0` flag |
| PR-04 | Duplicate webhook deliveries (F-20) and 30-day purge of the inbound store (F-12) | High / Med | Idempotency on `X-SND-Event-ID`; client persists all inbound immediately |
| PR-05 | Inbound depends on plan flags; dev/test tenants on Business plan see no inbound | High / High | Confirm plan for the dev tenant; ask for `webhook_message_received` on test plan |
| PR-06 | Quota/feature rejections arrive as HTTP 200 `rejected:true` or 417 with Arabic text | High / Med | Client error layer must inspect `ok`, `rejected`, `exc_type`, `_server_messages` |
| PR-07 | Device slot exhaustion by `Logged Out` devices; `create_device_api` never returns 4xx on limit but wa-admin may | Med / Med | Client shows `device_limit`/`device_used` from `get_subscription_status` (limit only) — request additive `devices_used` |
| PR-08 | Renewal re-anchors the period and resets `messages_used`; client-side usage charts must key on `start_date` | Med / Low | Store `start_date`/`end_date` snapshots with usage |
| PR-09 | Platform has effectively no automated tests; additive changes are unverified by CI | High / Med | Every additive endpoint we request ships with a test |
| PR-10 | Secrets exposure paths (F-19) on the platform | Med / High | Out of scope for client; flag to platform owner |

## Recommendations

### R-A. Consume as-is (no platform change)

| Spec screen | Platform capability | Endpoint(s) |
|---|---|---|
| 1 Onboarding | credentials check | `get_subscription_status` (validates link key + Frappe token in one call) |
| 2 Home / Dashboard | plan status, balances, device summary, queue health | `get_subscription_status`, `get_wallet_balance_api`, `list_devices_api`, `get_queue_status_api` |
| 3 Devices | create, list, QR, 8-digit code, verify, disconnect, delete | `create_device_api` (send `phone_number` when the user wants pair-code), `get_device_qr_api` (60 s refresh loop), `get_device_pair_code_api`, `verify_device_connection_api` (poll while `Pending QR`), `disconnect_device_api`, `delete_device_api` (+ `connection.*` webhooks for live status) |
| 4 Outbound | send and status | `enqueue_messages_api` (preferred, carries `client_ref`), `send_message_api` (quick send / simulator), `get_message_status_api`, `list_message_logs_api` |
| 5 Inbound / 13 Numbers / drawer | inbound events | webhook `message.received` (+ `message.delivered/read/reaction`) into client DocTypes; `list_device_contacts_api`, `list_device_groups_api`, `sync_device_contacts_api` for the ContactPicker |
| 9 Queue | remote queue counts | `get_queue_status_api`; local queue is the client's own (platform has no pause/resume) |
| 11 Simulator | | `send_message_api` with `source_type=Simulator` |
| 15 Subscription & Settings | plan, balances, webhook config | `get_subscription_status`, `get_wallet_balance_api`, `configure_integration_webhook_api` (once, at setup), `get_integration_webhook_secret_api`, `list_webhook_endpoints_api`, `list_available_webhook_events_api`, `create/test/delete_webhook_endpoint_api`, `list_webhook_delivery_logs_api` |
| Campaigns / polls | | `get_poll_results_api` |

Client-side rules derived from this analysis: verify `X-SND-Signature` as `HMAC-SHA256(secret, timestamp + "." + raw_body)`; dedupe on `X-SND-Event-ID`; always send `device`; treat `ok:false` + `rejected:true` as a business rejection; treat HTTP 417 with `exc_type` as a validation error; map `device_status` from 409 responses back onto the local device row.

### R-B. Additive platform changes to request (all new endpoints/fields; nothing existing changes)

| # | Additive change | Why | Screen |
|---|---|---|---|
| A-01 | `get_account_api`: customer name/email/mobile/status, subscription summary (limit, used, remaining, start/end, `messages_per_minute`, `device_limit`, `devices_used`, `auto_renew`, `next_billing_date`), link fields (`callback_url`, `webhooks_enabled`, `last_used_at`) | G-12, PR-07 | 2, 15 |
| A-02 | `list_plans_api` (key-auth) returning the same shape as `get_signup_bootstrap.plans` plus `is_current`, `is_requested_renewal` | G-01 | 15 |
| A-03 | `get_wallet_api`: balance, currency, transactions[], billing_entries[] (portal `get_wallet` shape); `request_wallet_topup_api` | G-02 | 15 |
| A-04 | `get_usage_api(from, to, group_by=day|device)` over Usage Ledger / Message Log; add `offset`, `from`, `to`, `device` filters to `list_message_logs_api` | G-03 | 2, 15 |
| A-05 | `update_device_api(device, device_name?, phone_number?)`, `reconnect_device_api` | G-04 (pair code needs a phone after creation) | 3 |
| A-06 | `update_webhook_endpoint_api(webhook_endpoint, status?, endpoint_url?, events?)`; add `message.held` to the `WhatsApp Webhook Event` Select options | G-05, G-06 | 15, 9 |
| A-07 | Optional `allow_fallback` (default 1 to stay compatible) on `send_message_api` | PR-03 | 4 |
| A-08 | Include `client_ref`/`source_docname` in `message.sent`/`message.failed` payloads from the sync path when supplied | G-08 | 4 |
| A-09 | Optional `code` field in every error body (e.g. `AUTH_INVALID_KEY`, `DEVICE_NOT_CONNECTED`, `QUOTA_EXCEEDED`, `FEATURE_NOT_IN_PLAN`, `DEVICE_LIMIT`) alongside existing `error` text | G-11 | all |
| A-10 | Webhook health: expose `consecutive_failures` and set endpoint status `Failed` after N; this is the natural home for the spec's **locked** state (`Active` / `Disabled` / `Failed`=locked) | F-11 | 15 |
| A-11 | `cancel_queued_messages_api(refs|batch_id)` | G-09 | 9 |
| A-12 | Dev tenant: enable `webhook_message_received` (+delivered/read) on the test subscription | PR-05 | 5, 13 |

## Open questions

| # | Question | Blocking? |
|---|---|---|
| Q-01 | The spec says webhook states are `active / disabled / locked`; the platform has `Active / Disabled / Failed / Revoked` and never sets `Failed`. Is `locked` = platform `Failed` (after retries), = link `Suspended`, or a client-only state? Decides A-10 | Yes for Screen 15 design |
| Q-02 | Which plan is the dev tenant on `w-platform.dev.sanad.digital`? Without `webhook_message_received` the Inbound/Numbers screens cannot be exercised | Yes for Phase 2 testing |
| Q-03 | Is the `X-SND-API-Secret` header meant to be enforced later (`require_secret=True`)? If yes the client must store and send it from day one | No (store it anyway) |
| Q-04 | Will the per-endpoint `secret` parameter of `create_webhook_endpoint_api` survive the `feat/link-webhook-secret` branch, or does the link secret become the only one? | No (client avoids the parameter) |
| Q-05 | Is the platform expected to become the system of record for inbound messages (Message Log `Incoming`), or is the client the only store? Affects retention design and G-07 | No |
| Q-06 | Should the client keep the legacy three-credential settings shape (`customer_api_key`, `api_key`, `api_secret`) for migration parity? | No |

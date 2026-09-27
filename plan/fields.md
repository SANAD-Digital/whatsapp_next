# Fields — `whatsapp_next` DocTypes

Phase 2 · 2026-09-22 · inputs: `plan/02-doctypes-gap.md` (§3 summary, §4 sketches, §5 queue, OQ-1..9),
`plan/00-conventions.md` §Naming, `plan/00-screens-spec.md` §3–§6, `plan/decisions.md` D-010..D-024,
`plan/05-platform-summary.md` §C/§D/§G, `plan/01-snd-whatsapp-summary.md` §DocTypes, legacy JSONs under
`../snd_whatsapp/snd_whatsapp/snd_whatsapp/doctype/` (option strings only), prototype `docs/screen/Hub Screen - *.html`
(`columns = [...]` per screen) and `docs/shared/hub-data.global.js`.

## Purpose

One row per field for all 24 DocTypes (13 parents + 11 children), so the build phase creates JSON without
re-deriving anything. Column keys: **reqd** required · **uniq** unique · **list** `in_list_view` ·
**filter** `in_standard_filter` · **pl** `permlevel` (blank = 0) · **serves** = prototype column/label (screen: «Arabic label») or spec section.
Select options are listed in order, separated by ` / ` (stored newline-separated in JSON). `✓` = 1, blank = 0.
Layout fields (Section/Column/Tab Break) are not enumerated; tabs are named in each table's note.
**Encrypted** = fieldtype `Password` (D-013/D-014/D-020) — see the Encrypted-fields table at the end.
Phone fields always come as a pair: `phone` (raw, as entered/received) + `phone_e164` (normalized by `services/phone.py`, the only value ever compared or indexed; for groups/LIDs it carries the JID untouched — gap F-05).

Conventions applied to every parent DocType: module `WhatsApp Next`; `is_submittable 0`; `sort_field creation`,
`sort_order DESC`; `title_field` as noted; `show_title_field_in_link 1` where naming is `hash`; `allow_rename 1` on
`field:` naming (gap R-06); `ignore_user_permissions 0` on every `device` Link (gap F-08).
Composite indexes are not expressible in DocType JSON: create them in `patches/…/add_indexes.py` via
`frappe.db.add_index`; single-column `search_index`/`unique` go in JSON.

---

## Inventory

### 1. `WhatsApp Settings` — Single · `track_changes 1`

Tabs: Provider · Credentials · Webhook · Queue · Commands · Policy · Picker · Retention · Subscription · Onboarding.
Permission: SM `R W` at permlevel 0 **and** 1; MGR `R` at permlevel 0 only → MGR never reads a secret (D-014).
System-written fields (`read_only 1`) are set by services with `ignore_permissions` + audit row (gap §6).

| fieldname | label | type | options | reqd | uniq | default | list | filter | depends_on | pl | description | serves |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| provider | Provider | Select | SND Platform | ✓ | | SND Platform | | | | | Options extended at form load from `whatsapp_providers` hook registry; validate stored value exists in registry | Settings: «الربط بالمنصة» |
| platform_base_url | Platform Base URL | Data | | ✓ | | | | | | | https only; no trailing slash; validated on save | Settings: «الربط بالمنصة» |
| request_timeout | Request Timeout (s) | Int | | | | 30 | | | | | 5–120 | — |
| customer_api_key | Customer API Key | **Password** | | | | | | | | 1 | → `X-SND-API-Key` (D-020). Encrypted | Settings: «بيانات الاعتماد» |
| api_key | API Key | **Password** | | | | | | | | 1 | Link api_key → `Authorization: token k:s` (D-020). Encrypted | Settings: «بيانات الاعتماد» |
| api_secret | API Secret | **Password** | | | | | | | | 1 | Link api_secret; also `X-SND-API-Secret` (D-020). Encrypted | Settings: «بيانات الاعتماد» |
| webhook_secret | Webhook Secret | **Password** | | | | | | | | 1 | read_only; fetched via `get_integration_webhook_secret_api` (D-013), never typed. Encrypted | Settings: «الويب هوك» |
| credentials_updated_at | Credentials Updated At | Datetime | | | | | | | | 1 | read_only; set on any credential change + Audit `Credentials Changed` | Settings: «تدوير المفاتيح» |
| connection_status | Connection Status | Select | Untested / OK / Failed | | | Untested | | | | | read_only; result of "test connection" (`get_subscription_status`) | Settings: «اختبار الاتصال» |
| last_connection_test_at | Last Connection Test | Datetime | | | | | | | | | read_only | Settings: «آخر فحص» |
| last_connection_latency_ms | Latency (ms) | Int | | | | | | | | | read_only | Settings: «زمن الاستجابة 318ms» |
| last_connection_error | Last Connection Error | Small Text | | | | | | | | | read_only; no secrets in text | Settings alert card |
| webhook_endpoint | Webhook Endpoint (platform) | Data | | | | | | | | | read_only; platform `WhatsApp Webhook Endpoint` docname | §D create_webhook_endpoint_api |
| webhook_endpoint_url | Webhook Endpoint URL | Data | | | | | | | | | read_only; `https://<site>/api/method/whatsapp_next.api.webhook.receive` | Settings: «رابط الاستقبال» |
| webhook_status | Webhook Status | Select | / Active / Disabled / Locked / Revoked | | | | | | | | read_only; mirror of platform state (D-018); refreshed by `list_webhook_endpoints_api` | Settings: «الويب هوك مفعّل/غير مفعّل» |
| webhook_events | Subscribed Events | JSON | | | | | | | | | List of platform event names accepted on the endpoint; written by save → `update_webhook_endpoint_api` | Settings: «الأحداث المُستقبَلة» |
| webhook_max_retries | Webhook Retries | Select | 1 / 3 / 5 | | | 3 | | | | | Sent to platform endpoint `max_retries` | Settings: «سياسة إعادة المحاولة» |
| webhook_synced_at | Webhook Synced At | Datetime | | | | | | | | | read_only | — |
| webhook_last_event_at | Last Webhook Event At | Datetime | | | | | | | | | read_only; set by receiver on every valid event | Settings: «آخر المحاولات» |
| messages_per_minute | Messages per Minute | Int | | ✓ | | 20 | | | | | 5–60 and ≤ `plan_messages_per_minute` (gap G-03) | Queue: rate slider |
| max_attempts | Max Attempts | Int | | ✓ | | 3 | | | | | Copied to Queue Item at create | §5.1 |
| retry_backoff_seconds | Retry Backoff (s) | Int | | ✓ | | 300 | | | | | Base for exponential backoff on transient errors | §5.1 |
| queue_paused | Queue Paused | Check | | | | 0 | | | | | read_only; global dispatcher gate (gap F-01); write via `api.queue.pause_queue` (MGR) | Queue: banner «موقوف» |
| queue_paused_by | Paused By | Link | User | | | | | | eval:doc.queue_paused | | read_only | Queue: «أوقف عبدالله الفهد الطابور» |
| queue_paused_at | Paused At | Datetime | | | | | | | eval:doc.queue_paused | | read_only | Queue: «pausedSince» |
| queue_pause_reason | Pause Reason | Small Text | | | | | | | eval:doc.queue_paused | | read_only; also copied to Audit `Queue Paused` | Queue: «سبب الإيقاف» |
| enable_commands | Enable Commands | Check | | | | 0 | | | | | | Commands screen |
| command_service_user | Command Service User | Link | User | | | | | | eval:doc.enable_commands | | reqd when enabled; validate: enabled user, not Administrator, no System Manager role (D-012, OQ-4) | §5.5 |
| unknown_command_reply | Unknown Command Reply | Small Text | | | | | | | eval:doc.enable_commands | | Jinja; empty = no reply | Inbound: «بلا مطابقة» |
| send_receipt_reply | Send Receipt Reply | Check | | | | 0 | | | eval:doc.enable_commands | | Acknowledge a matched command before executing | legacy `enable_receipt_reply` |
| receipt_reply | Receipt Reply Text | Small Text | | | | | | | eval:doc.send_receipt_reply | | | legacy `receipt_reply` |
| reply_device | Reply Device | Link | WhatsApp Device | | | | | | eval:doc.enable_commands | | Empty = reply from the device that received the inbound | legacy `reply_device` |
| default_device | Default Device | Link | WhatsApp Device | | | | | | | | Used by Quick Send / Notification when none set | §3.4 |
| default_country | Default Country | Link | Country | ✓ | | | | | | | E.164 default region for national numbers (§6.2, legacy R-F) | §6.2 |
| global_blacklist_group | Global Blacklist | Link | WhatsApp Contact Group | | | | | | | | set_query `kind = Blacklist`; members never receive anything (gap F-04) | Contact Groups: «قائمة سوداء» |
| send_only_to_known_numbers | Send Only to Known Numbers | Check | | | | 0 | | | | | Blocks non-campaign sends to numbers with `inbound_count = 0` and `conversation_confirmed = 0` (gap G-07) | Contacts: «محادثة قائمة» |
| picker_sources | Picker DocType Sources | Table | WhatsApp Settings Picker Source | | | | | | | | Whitelist for ContactPicker source 3 | §3.2 |
| outbound_retention_days | Outbound Retention (days) | Int | | | | 365 | | | | | 0 = never purge | gap R-03 |
| inbound_retention_days | Inbound Retention (days) | Int | | | | 365 | | | | | 0 = never purge | gap R-03 |
| queue_retention_days | Queue Retention (days) | Int | | | | 7 | | | | | Terminal Queue Items purged after N days (OQ-8) | §5.1 |
| webhook_event_retention_days | Webhook Event Retention (days) | Int | | | | 30 | | | | | Payload is PII | gap R-03 |
| audit_retention_days | Audit Retention (days) | Int | | | | 365 | | | | | | Settings: «سجل التدقيق» |
| plan_code | Plan Code | Data | | | | | | | | | read_only; cache from `get_subscription_status` | Home / Settings |
| plan_name | Plan | Data | | | | | | | | | read_only | Billing: «الأعمال 6K» |
| subscription_status | Subscription Status | Data | | | | | | | | | read_only; platform enum (Trial/Active/Near Expiry/Expired/Suspended/Cancelled) stored as text | Billing |
| message_limit | Message Limit | Int | | | | | | | | | read_only | Queue: «يُخصم من الباقة» |
| messages_used | Messages Used | Int | | | | | | | | | read_only | Home usage |
| messages_remaining | Messages Remaining | Int | | | | | | | | | read_only | Queue: «رصيد بعدها» |
| plan_messages_per_minute | Plan Rate Limit | Int | | | | | | | | | read_only; upper bound for `messages_per_minute` | Queue slider |
| device_limit | Device Limit | Int | | | | | | | | | read_only | Devices |
| wallet_balance | Wallet Balance | Currency | | | | | | | | | read_only; `get_wallet_balance_api` | Billing: «المحفظة» |
| wallet_currency | Wallet Currency | Link | Currency | | | | | | | | read_only | Billing |
| subscription_start | Subscription Start | Date | | | | | | | | | read_only | Billing |
| subscription_end | Subscription End | Date | | | | | | | | | read_only | Billing: «renewAt» |
| plan_features | Plan Features | JSON | | | | | | | | | read_only; `features{allow_*}` snapshot gates Campaign/Commands UI | §5.7 |
| subscription_synced_at | Subscription Synced At | Datetime | | | | | | | | | read_only | Billing |
| numbers_watermark | Numbers Watermark | Datetime | | | | | | | | | read_only; last `creation` processed by the nightly distinct job | §5.2 |
| numbers_last_run_at | Numbers Job Last Run | Datetime | | | | | | | | | read_only | §5.2 |
| setup_completed | Setup Completed | Check | | | | 0 | | | | | read_only; set when credentials OK + ≥1 device Connected + webhook Active | Settings: «خطوات التهيئة» |
| setup_completed_at | Setup Completed At | Datetime | | | | | | | | | read_only | Onboarding |
| redirect_unregistered_to_wizard | Redirect to Wizard when not set up | Check | | | | 0 | | | | | Spec screen 1 "enable last" | Onboarding |

Indexes: none (Single). Note: `webhook_max_retries` is a Select of numeric strings so the prototype's three-option control maps 1:1; cast on send.

### 2. `WhatsApp Settings Picker Source` — child of Settings

| fieldname | label | type | options | reqd | uniq | default | list | filter | depends_on | pl | description | serves |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| document_type | DocType | Link | DocType | ✓ | | | ✓ | | | | Validate unique within table; must be non-child, non-single | §3.2 source 3 |
| label | Label | Data | | | | | ✓ | | | | Shown in picker; default = DocType label | §3.2 |
| phone_source | Phone Source | Select | Field / Linked Contact | ✓ | | Field | ✓ | | | | `Linked Contact` reads Contact Phone through the DocType's `contact`-like Link | §3.2 |
| phone_fieldname | Phone Fieldname | Data | | | | | ✓ | | eval:doc.phone_source=="Field" | | Fieldname on `document_type` holding the phone | §3.2 |
| contact_fieldname | Contact Link Fieldname | Data | | | | | | | eval:doc.phone_source=="Linked Contact" | | Link-to-Contact fieldname on `document_type` | §3.2 |
| name_fieldname | Display Name Fieldname | Data | | | | | ✓ | | | | Empty = `title_field` of the DocType | §3.2 Selected tab |
| enabled | Enabled | Check | | | | 1 | ✓ | | | | | §3.2 |

### 3. `WhatsApp Device` — `autoname WA-DEV-.###` · `title_field device_name` · `track_changes 1`

Create/delete only through `api.devices.*` (platform call first, gap §6). Tabs: Device · Connection · Diagnostics.

| fieldname | label | type | options | reqd | uniq | default | list | filter | depends_on | pl | description | serves |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| device_name | Device Name | Data | | ✓ | | | ✓ | | | | Sent to `create_device_api` | Devices: «اسم الجهاز» |
| phone | Phone | Data | | | | | | | | | Raw `phone_number` from platform / pairing form | Devices: «الرقم» |
| phone_e164 | Phone (E.164) | Data | | | | | ✓ | | | | read_only; normalized; `search_index` | Devices: «الرقم المقروء» |
| platform_device | Platform Device | Data | | ✓ | ✓ | | | | | | read_only; platform `WhatsApp Device` docname passed as `device` on every call (D-013) | §D |
| wa_device_id | WA Device ID | Data | | | | | | | | | read_only; wa-admin id from platform | §D list_devices_api |
| status | Status | Select | Pending QR / Connected / Disconnected / Logged Out | ✓ | | Pending QR | ✓ | ✓ | | | read_only; written only by `services/devices.py` from `connection.*` events / `verify_device_connection_api` | Devices: status badge |
| is_default | Default Device | Check | | | | 0 | ✓ | | | | Exactly one; validate | Devices |
| disabled | Disabled | Check | | | | 0 | | ✓ | | | Local switch: dispatcher skips device, queue holds | Devices: «فصل» |
| last_seen | Last Seen | Datetime | | | | | ✓ | | | | read_only; from `list_devices_api.last_seen` (OQ-7) | Devices: «آخر ظهور / انقطع منذ» |
| connected_at | Connected At | Datetime | | | | | | | | | read_only | Devices |
| disconnected_at | Disconnected At | Datetime | | | | | | | | | read_only | Devices: «غير متصل منذ» |
| logged_out_at | Logged Out At | Datetime | | | | | | | | | read_only | Devices |
| webhook_registered | Webhook Registered | Check | | | | 0 | | | | | read_only; from `wa_webhook_*` on `list_devices_api` | Settings setup step 4 |
| webhook_registered_at | Webhook Registered At | Datetime | | | | | | | | | read_only | — |
| last_error | Last Error | Small Text | | | | | | | | | read_only; no tokens/PII | Devices alert |
| last_status_event_at | Last Status Event At | Datetime | | | | | | | | | read_only; last `connection.*` webhook | Devices |
| notes | Notes | Small Text | | | | | | | | | User notes | Devices |

**Not stored** (D-014, gap F7): device token, QR payload, pair code — served from a 60 s `frappe.cache` entry keyed by `platform_device`.
Status machine: `Pending QR → Connected` (connection.connected / verify) · `Connected → Disconnected` (connection.disconnected) · `Disconnected → Connected` (reconnect) · `Connected|Disconnected → Logged Out` (connection.logged_out, `disconnect_device_api`) · `Logged Out → Pending QR` (re-pair). `delete_device_api` → row deleted (Audit `Device Deleted`).
Prototype card stats «أُرسل (30ي) / فشل / نسبة الفشل / الصادر / الوارد» are computed by the read layer from Outbound/Inbound via index `(device, creation)`; not stored.
Indexes: `platform_device` (unique), `phone_e164`, `status`.

### 4. `WhatsApp Log` — `autoname hash` · `title_field display_name` · `track_changes 0`

No role holds C/W/D (gap §6). `status` written only by `services/dispatch.py` (queue transitions + webhooks + reconcile).
Tabs: Message · Delivery · Source · Provider.

| fieldname | label | type | options | reqd | uniq | default | list | filter | depends_on | pl | description | serves |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| device | Device | Link | WhatsApp Device | ✓ | | | ✓ | ✓ | | | Device requested (gap F-08) | Outbound: «الجهاز» |
| recipient_type | Recipient Type | Select | Individual / Group | ✓ | | Individual | | ✓ | | | | §D send_message_api |
| phone | Phone | Data | | | | | | | eval:doc.recipient_type=="Individual" | | Raw as given by the caller | Outbound: «الجهة» sub |
| phone_e164 | Phone (E.164) | Data | | | | | ✓ | | | | Normalized on insert (§6.2); reqd for Individual; `search_index`; the drawer joins WhatsApp Number on it (gap F-09) | Outbound: «الجهة» · §5.2 |
| jid | JID | Data | | | | | | | eval:doc.recipient_type=="Group" | | Group `@g.us` / LID; reqd for Group | Numbers: group rows |
| display_name | Display Name | Data | | | | | ✓ | | | | Contact name or WhatsApp push name at send time | Outbound: «الجهة» |
| contact | Contact | Link | Contact | | | | | ✓ | | | Resolved at insert via `Contact Phone.wa_phone_e164` (OQ-5) | Outbound: «الجهة» |
| message_type | Message Type | Select | Text / Document / Image / Video / Audio / Sticker / Location / Poll | ✓ | | Text | ✓ | ✓ | | | Platform `message_type` vocabulary; `Template` is a source (`template` Link), not a type — see Findings F-04 | Outbound: «نوع الرسالة» |
| body | Body | Text | | | | | | | | | Final rendered text (Jinja already applied); PII → retention | Outbound: «النص» |
| caption | Caption | Small Text | | | | | | | eval:["Document","Image","Video"].includes(doc.message_type) | | | §D |
| attachment | Attachment | Attach | | | | | | | eval:["Document","Image","Video","Audio","Sticker"].includes(doc.message_type) | | Private file | Outbound: «مستند/صورة» |
| file_name | File Name | Data | | | | | | | | | Name sent to platform | §D filename |
| mime_type | MIME Type | Data | | | | | | | | | | §D mime |
| view_once | View Once | Check | | | | 0 | | | | | | §D view_once |
| print_format | Print Format | Link | Print Format | | | | | | eval:doc.message_type=="Document" | | | Outbound: «قالب الطباعة» |
| letter_head | Letter Head | Link | Letter Head | | | | | | eval:doc.message_type=="Document" | | | — |
| language | Language | Link | Language | | | | | | | | PDF render language | legacy `language` |
| location_latitude | Latitude | Float | | | | | | | eval:doc.message_type=="Location" | | | §D location_* |
| location_longitude | Longitude | Float | | | | | | | eval:doc.message_type=="Location" | | | §D |
| location_name | Location Name | Data | | | | | | | eval:doc.message_type=="Location" | | | §D |
| location_address | Location Address | Small Text | | | | | | | eval:doc.message_type=="Location" | | | §D |
| poll_question | Poll Question | Data | | | | | | | eval:doc.message_type=="Poll" | | | §D poll_* |
| poll_options | Poll Options | JSON | | | | | | | eval:doc.message_type=="Poll" | | List of strings | §D |
| poll_allow_multiple | Allow Multiple Answers | Check | | | | 0 | | | eval:doc.message_type=="Poll" | | | §D |
| poll_id | Poll ID | Data | | | | | | | eval:doc.message_type=="Poll" | | read_only; provider id for `get_poll_results_api` | §D |
| status | Status | Select | Unsent / Queued / Sending / Sent / Delivered / Read / Failed / Cancelled / Held | ✓ | | Unsent | ✓ | ✓ | | | read_only; see machine below; `Held` per D-024 | Outbound: «الحالة» |
| scheduled_at | Scheduled At | Datetime | | | | | | ✓ | | | Empty = ASAP | Outbound: «تاريخ ووقت الجدولة» |
| queued_at | Queued At | Datetime | | | | | | | | | read_only | Queue: «أُنشئت» |
| sent_at | Sent At | Datetime | | | | | | | | | read_only; `message.sent` | Outbound: «التاريخ والوقت» |
| delivered_at | Delivered At | Datetime | | | | | | | | | read_only; `message.delivered` | Outbound detail |
| read_at | Read At | Datetime | | | | | | | | | read_only; `message.read` | Outbound detail |
| failed_at | Failed At | Datetime | | | | | | | | | read_only | Outbound detail |
| cancelled_at | Cancelled At | Datetime | | | | | | | | | read_only | Queue cancel |
| held_at | Held At | Datetime | | | | | | | | | read_only; `message.held` | D-024 |
| held_reason | Held Reason | Small Text | | | | | | | eval:doc.status=="Held" | | read_only; platform `reason` on held; cleared on resume | D-024 |
| error_code | Error Code | Data | | | | | | ✓ | | | read_only; normalized code: `recipient_not_registered` / `device_disconnected` / `timeout` / `platform_rejected` / `invalid_template` / `insufficient_balance` / `unknown`; mapped in `services/errors.py` | Outbound: «الخطأ» |
| error_message | Error Message | Small Text | | | | | | | | | read_only; provider text with numbers masked (security rule) | Outbound detail «raw» |
| attempts | Attempts | Int | | | | 0 | | | | | read_only; dispatcher attempts | Outbound detail |
| source_type | Source | Select | Quick Send / Form / Campaign / Notification / Notification Alert / Command Reply / Simulator / API | ✓ | | | | ✓ | | | Who created the row | Outbound: «مرسل بالنيابة» (Simulator) |
| reference_doctype | Reference DocType | Link | DocType | | | | ✓ | ✓ | | | Business document that triggered the message | Outbound: «نوع المستند» |
| reference_name | Reference Name | Dynamic Link | reference_doctype | | | | ✓ | | eval:doc.reference_doctype | | `amount` is read from the document in the read layer, not stored (gap F-07) | Outbound: «رقم المستند» / «المبلغ» |
| campaign | Campaign | Link | WhatsApp Campaign | | | | | ✓ | eval:doc.source_type=="Campaign" | | | Campaigns counters |
| campaign_recipient | Campaign Recipient Row | Data | | | | | | | eval:doc.campaign | | child row `name` | Campaign recipient status |
| campaign_message_idx | Campaign Message # | Int | | | | | | | eval:doc.campaign | | Which of the campaign's messages this is | §5.4 multi-message |
| template | Template | Link | WhatsApp Template | | | | | ✓ | | | | Outbound detail «النموذج» |
| notification | Notification | Link | WhatsApp Notification | | | | | | eval:doc.source_type=="Notification" | | | Notification Templates: «الاستخدام (30ي)» |
| notification_alert | Notification Alert | Link | WhatsApp Notification Alert | | | | | | eval:doc.source_type=="Notification Alert" | | | D-016 |
| command | Command | Link | WhatsApp Command | | | | | ✓ | eval:doc.source_type=="Command Reply" | | | Outbound: «الأمر المرسل» |
| trigger_inbound | Trigger Inbound | Link | WhatsApp Inbound Message | | | | | | eval:doc.source_type=="Command Reply" | | Reply-to; `received_at` read through the link | Outbound: «معرّف الرسالة الوارد» / «تاريخ ووقت الوارد» / «الوقت المستغرق» |
| queue_item | Queue Item | Link | WhatsApp Queue Item | | | | | | | | read_only; 1:1 back-link | §5.1 |
| provider | Provider | Data | | | | | | | | | read_only; provider key at send time | — |
| provider_message_id | Provider Message ID | Data | | | | | | | | | read_only; `search_index`; key for `message.delivered/read` | §G |
| platform_queue_id | Platform Queue ID | Data | | | | | | | | | read_only; from `enqueue_messages_api.accepted[].queue_id` | D-024 |
| platform_message_log | Platform Message Log | Data | | | | | | | | | read_only | §D |
| requested_device | Requested Device | Link | WhatsApp Device | | | | | | eval:doc.device_fallback | | read_only; original device when platform fell back | §D `requested_device` |
| device_fallback | Device Fallback | Check | | | | 0 | | | | | read_only; platform sent from another device (PR-03) | §D |
| is_test | Test Send | Check | | | | 0 | | ✓ | | | Sent via `send_message_api` from the Simulator sandbox (D-024) | Simulator: «sandbox» |
| is_simulated | Simulated | Check | | | | 0 | | ✓ | | | No real send; Simulator "on behalf" row (gap F-06) | Outbound: «مرسل بالنيابة» |

Status machine (single writer `services/dispatch.py`): `Unsent →(queue item created) Queued →(claimed) Sending →(batch accepted) Sent →(webhook) Delivered → Read`; `Queued|Sending →(accepted with status held / message.held) Held →(platform resume) Queued|Sent` or `Held → Failed`; `Queued|Sending →(dead letter / message.failed) Failed`; `Unsent|Queued|Held →(queue delete) Cancelled`. Terminal: `Read`, `Failed`, `Cancelled`. Forward-only: a later webhook never regresses `Read`→`Delivered`.
Indexes (JSON): `phone_e164`, `status`, `provider_message_id`, `campaign`, `command`, `template`, `notification` (Links are indexed by Frappe). Composite (patch): `(device, creation)`, `(reference_doctype, reference_name)`, `(status, scheduled_at)`, `(command, creation)`, `(notification, creation)`. `creation` is indexed by the framework.
Retention: purge by `creation < now - outbound_retention_days`; purge Queue Item / Webhook Event rows first (Link order) or delete with `ignore_links`.

### 5. `WhatsApp Inbound Message` — `autoname hash` · `title_field display_name` · `track_changes 0`

No role holds C/W/D. Written by `services/inbound.py` from `message.received` / `message.reaction`; `command_*` written by `services/commands.py`.

| fieldname | label | type | options | reqd | uniq | default | list | filter | depends_on | pl | description | serves |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| device | Device | Link | WhatsApp Device | ✓ | | | ✓ | ✓ | | | Receiving device; resolved from `platform_device`, never created (gap F6/R-G) | Inbound: «الجهاز» |
| phone | Phone | Data | | | | | | | | | Raw `sender_mobile_no` from payload | Inbound: «المُرسِل» sub |
| phone_e164 | Phone (E.164) | Data | | | | | ✓ | | | | Normalized; `search_index`; empty for LID-only senders (then `sender_jid` is the key) | §5.2 · §6.2 |
| jid | From JID | Data | | | | | | | | | `from_jid` | legacy received log |
| chat_jid | Chat JID | Data | | | | | | | | | Group or 1:1 chat | legacy |
| sender_jid | Sender JID | Data | | | | | | | | | Participant in group / `@lid` | D-023 enrichment |
| is_group | Group Message | Check | | | | 0 | | ✓ | | | | Numbers: «مجموعة واتساب» |
| display_name | Display Name | Data | | | | | ✓ | | | | Push name / Contact name | Inbound: «المُرسِل» |
| contact | Contact | Link | Contact | | | | | ✓ | | | Auto-linked on insert (OQ-5) | Inbound: «ربط الجهة» |
| message_type | Message Type | Select | Text / Document / Image / Video / Audio / Sticker / Location / Poll / Reaction / Contact / Other | ✓ | | Text | | ✓ | | | Provider type mapped; unknown → Other | Inbound |
| body | Body | Text | | | | | ✓ | | | | Text / caption; PII → retention | Inbound: «النص الوارد» |
| caption | Caption | Small Text | | | | | | | | | | — |
| media_url | Media URL | Data | | | | | | | | | Provider URL (expires); not downloaded by default | legacy `media_url` |
| media_mime_type | Media MIME | Data | | | | | | | | | | — |
| attachment | Attachment | Attach | | | | | | | | | Filled only if media download is enabled for the message type | — |
| location_latitude | Latitude | Float | | | | | | | eval:doc.message_type=="Location" | | | — |
| location_longitude | Longitude | Float | | | | | | | eval:doc.message_type=="Location" | | | — |
| location_name | Location Name | Data | | | | | | | eval:doc.message_type=="Location" | | | — |
| reaction | Reaction | Data | | | | | | | eval:doc.message_type=="Reaction" | | Emoji | legacy reaction log |
| reaction_to_provider_message_id | Reacted To | Data | | | | | | | eval:doc.message_type=="Reaction" | | Outbound `provider_message_id` reacted to | legacy |
| quoted_provider_message_id | Quoted Message ID | Data | | | | | | | | | Reply-to context | — |
| provider_message_id | Provider Message ID | Data | | ✓ | ✓ | | | | | | Dedupe key (OQ-B: single-column unique per gap; alternative composite `(device, provider_message_id)`) | Inbound: «معرّف الرسالة» |
| received_at | Received At | Datetime | | ✓ | | | ✓ | | | | Provider timestamp if present else webhook `received_at`; `search_index` | Inbound: «الوقت» |
| webhook_event | Webhook Event | Link | WhatsApp Webhook Event | | | | | | | | Raw payload lives there | gap §2 |
| command_status | Command Status | Select | None / Matched / Executed / Failed / Not Matched / Blocked | ✓ | | None | ✓ | ✓ | | | read_only; see machine | Inbound: «الأمر المطابق» |
| command | Command | Link | WhatsApp Command | | | | | ✓ | eval:doc.command_status!="None" | | | Inbound: «الأمر المطابق» |
| command_text | Matched Text | Data | | | | | | | eval:doc.command | | Code or synonym that matched | Inbound detail |
| command_args | Command Arguments | JSON | | | | | | | eval:doc.command | | Parsed `#tokens` (Function inputs) | Functions: inputs |
| command_error | Command Error | Small Text | | | | | | | eval:doc.command_status=="Failed" | | No PII | Inbound detail |
| block_reason | Block Reason | Select | / Blacklist / Not Allowed / Party Type / Not Linked / Commands Disabled / Function Inactive | | | | | ✓ | eval:doc.command_status=="Blocked" | | | Commands: «يشترط ربط الجهة» |
| reply_outbound | Reply Outbound | Link | WhatsApp Log | | | | | | | | First reply produced (command or receipt) | Inbound: «الردّ المُرسَل» / «فارق الرد» |
| replied_at | Replied At | Datetime | | | | | | | | | read_only | Inbound detail |
| is_simulated | Simulated | Check | | | | 0 | | ✓ | | | Simulator "message on behalf" (gap F-06) | Simulator |

Command status machine: insert → `None` (commands disabled, non-text, group without mention, or reaction) · `Not Matched` (text, no code/synonym match; `unknown_command_reply` sent) · `Blocked` (matched but blacklist / party type / `requires_linked_contact` / function inactive; `block_reason` set) · `Matched` → `Executed` (handler ok; `reply_outbound` set) | `Failed` (handler raised; `command_error` set). Terminal: all but `Matched`.
Indexes (JSON): `phone_e164`, `provider_message_id` (unique), `received_at`, `command_status`. Composite (patch): `(device, received_at)`, `(command, received_at)`.

### 6. `WhatsApp Queue Item` — `autoname hash` · `title_field display_name` · `track_changes 0`

No role holds C/W/D. Pause / resume / delete are whitelisted actions (MGR + audit). Separate table per gap §5 (OQ-1 recommendation; alternative "same row" rejected).

| fieldname | label | type | options | reqd | uniq | default | list | filter | depends_on | pl | description | serves |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| outbound_message | Outbound Message | Link | WhatsApp Log | ✓ | ✓ | | | | | | 1:1 | §5.1 |
| client_ref | Client Ref | Data | | ✓ | | | | | | | = `outbound_message` name; sent to platform (D-024, RC-05) | D-024 |
| device | Device | Link | WhatsApp Device | ✓ | | | ✓ | ✓ | | | Denormalized for claim query + User Permissions | Queue: «الجهاز» |
| phone_e164 | Phone (E.164) | Data | | | | | | | | | Denormalized | Queue: «الجهة» sub |
| display_name | Display Name | Data | | | | | ✓ | | | | Denormalized | Queue: «الجهة» |
| campaign | Campaign | Link | WhatsApp Campaign | | | | | ✓ | | | | Queue → campaign pause |
| priority | Priority | Int | | ✓ | | 5 | | | | | 1 = highest; Quick Send/Command Reply 1, Notification 3, Campaign 5 | §5.1 ordering |
| scheduled_at | Scheduled At | Datetime | | ✓ | | | ✓ | | | | Earliest dispatch time | Queue: «الإرسال المتوقّع» base |
| status | Status | Select | Queued / Sending / Paused / Deleted / Completed / Dead Letter | ✓ | | Queued | ✓ | ✓ | | | See machine | Queue: «الحالة» |
| attempts | Attempts | Int | | | | 0 | | | | | | Queue detail |
| max_attempts | Max Attempts | Int | | ✓ | | | | | | | Copied from Settings at create | §5.1 |
| next_attempt_at | Next Attempt At | Datetime | | | | | | | | | `search_index`; set on transient failure | §5.1 |
| last_error_code | Last Error Code | Data | | | | | | ✓ | | | Normalized code | Queue detail |
| last_error | Last Error | Small Text | | | | | | | | | No PII | Queue detail |
| job_id | RQ Job ID | Data | | | | | | | | | Job that claimed the row | ops |
| claimed_at | Claimed At | Datetime | | | | | | | | | `SELECT … FOR UPDATE SKIP LOCKED` claim time; stale claims (> 10 min) re-queued by reconcile | §5.1 |
| batch_id | Batch ID | Data | | | | | | | | | `search_index`; platform batch (RC-05) | D-024 |
| platform_queue_id | Platform Queue ID | Data | | | | | | | | | From `accepted[].queue_id` | D-024 |
| paused_by | Paused By | Link | User | | | | | | eval:doc.status=="Paused" | | | Campaigns pause |
| paused_at | Paused At | Datetime | | | | | | | eval:doc.status=="Paused" | | | — |
| pause_reason | Pause Reason | Small Text | | | | | | | eval:doc.status=="Paused" | | | Audit |
| deleted_by | Deleted By | Link | User | | | | | | eval:doc.status=="Deleted" | | | Queue: «أُلغيت 41 رسالة يدوياً» |
| deleted_at | Deleted At | Datetime | | | | | | | eval:doc.status=="Deleted" | | | — |
| delete_reason | Delete Reason | Small Text | | | | | | | eval:doc.status=="Deleted" | | | Audit `Queue Items Deleted` |
| dead_letter_reason | Dead Letter Reason | Small Text | | | | | | | eval:doc.status=="Dead Letter" | | | ops |
| completed_at | Completed At | Datetime | | | | | | | eval:doc.status=="Completed" | | Platform accepted the ref | OQ-8 |

Status machine: `Queued ↔ Paused` (campaign/bulk pause; global pause is the Settings gate, rows stay `Queued`) · `Queued →(claim) Sending →(accepted) Completed` | `→(transient error, attempts < max_attempts) Queued` with `next_attempt_at` | `→(attempts ≥ max or hard reject) Dead Letter` · `Queued|Paused →(user) Deleted` (`Sending` cannot be deleted; wait for claim to end). Terminal: `Completed`, `Deleted`, `Dead Letter`; purged after `queue_retention_days` (OQ-8: 7 days).
Outbound mapping: `Queued→Queued`, `Sending→Sending`, `Paused→(unchanged)`, `Deleted→Cancelled`, `Dead Letter→Failed`, `Completed→Sent` or `Held` (from `accepted[].status`).
Queue position and ETA («#», «الإرسال المتوقّع») are computed in `api.queue.list_queue` from rank over `(priority, scheduled_at, creation)` ÷ `messages_per_minute`; not stored.
Indexes (JSON): `outbound_message` (unique), `next_attempt_at`, `batch_id`, `campaign`. Composite (patch): `(status, scheduled_at, priority)`, `(device, status)`.

### 7. `WhatsApp Campaign` — `autoname WA-CAMP-.YYYY.-.#####` · `title_field campaign_name` · `track_changes 1`

Start / pause / resume / cancel = whitelisted doc actions (MGR) + Audit. Tabs: Campaign · Messages · Recipients · Progress · Log.

| fieldname | label | type | options | reqd | uniq | default | list | filter | depends_on | pl | description | serves |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| campaign_name | Campaign Name | Data | | ✓ | | | ✓ | | | | | Campaigns: «الحملة» |
| description | Description | Small Text | | | | | | | | | | Campaigns: «الحملة» sub |
| status | Status | Select | Draft / Scheduled / Queued / Running / Paused / Completed / Partially Failed / Cancelled | ✓ | | Draft | ✓ | ✓ | | | read_only; written by `services/campaign_runner.py` | Campaigns: «الحالة» / «التقدّم» bar |
| device | Device | Link | WhatsApp Device | ✓ | | | ✓ | ✓ | | | | Campaigns: «الجهاز» |
| scheduled_at | Scheduled At | Datetime | | | | | ✓ | ✓ | | | Empty = manual start («نوع البدء» = Immediate; set = Scheduled) | Campaigns: «موعد الجدولة» / «نوع البدء» |
| messages_per_minute | Messages per Minute | Int | | | | | | | | | Default from Settings; validate ≤ Settings value | Campaigns: «المدة التقديرية» |
| started_at | Started At | Datetime | | | | | | | | | read_only | Campaigns: «البداية» |
| ended_at | Ended At | Datetime | | | | | | | | | read_only; Completed/Partially Failed/Cancelled | Campaigns: «المدة الفعلية» |
| last_batch_started_at | Last Batch Started At | Datetime | | | | | | | | | read_only | runner |
| started_by | Started By | Link | User | | | | | | | | read_only | Audit |
| paused_at | Paused At | Datetime | | | | | | | eval:doc.status=="Paused" | | read_only | Campaigns |
| paused_by | Paused By | Link | User | | | | | | eval:doc.status=="Paused" | | read_only | Audit |
| pause_reason | Pause Reason | Small Text | | | | | | | eval:doc.status=="Paused" | | | Audit |
| cancelled_at | Cancelled At | Datetime | | | | | | | eval:doc.status=="Cancelled" | | read_only | Campaigns |
| cancelled_by | Cancelled By | Link | User | | | | | | eval:doc.status=="Cancelled" | | read_only | Audit |
| cancel_reason | Cancel Reason | Small Text | | | | | | | eval:doc.status=="Cancelled" | | | Audit |
| total_recipients | Total Recipients | Int | | | | 0 | ✓ | | | | read_only; live rows not `Removed` | Campaigns: «المستلمون» |
| initial_recipients | Recipients at Start | Int | | | | 0 | | | | | read_only; snapshot at start | Campaigns: «المستلمون في البداية» / «نسبة التعديل» |
| added_count | Added after Start | Int | | | | 0 | | | | | read_only | Campaigns: «تعديل بعد الاعتماد» |
| removed_count | Removed after Start | Int | | | | 0 | | | | | read_only | Campaigns: «تعديل بعد الاعتماد» |
| pause_count | Pause Count | Int | | | | 0 | | | | | read_only | Campaigns: «تعديل بعد الاعتماد» |
| queued_count | Queued | Int | | | | 0 | | | | | read_only; counters = Outbound rows by `campaign` + status, refreshed by runner | Campaigns: «التقدّم» |
| sent_count | Sent | Int | | | | 0 | ✓ | | | | read_only (Sent+Delivered+Read) | Campaigns: «مُرسل» / «نسبة النجاح» |
| delivered_count | Delivered | Int | | | | 0 | | | | | read_only | Campaigns |
| read_count | Read | Int | | | | 0 | ✓ | | | | read_only | Campaigns: «مقروء» / «نسبة المقروء» |
| failed_count | Failed | Int | | | | 0 | ✓ | | | | read_only | Campaigns: «فشل» / «نسبة الفشل» |
| cancelled_count | Cancelled | Int | | | | 0 | | | | | read_only | Campaigns |
| first_message_at | First Message At | Datetime | | | | | | | | | read_only | Campaigns: «أول رسالة صادرة» |
| last_message_at | Last Message At | Datetime | | | | | | | | | read_only | Campaigns: «آخر رسالة صادرة» |
| messages | Messages | Table | WhatsApp Campaign Message | ✓ | | | | | | | ≥ 1 row | §5.4 |
| recipients | Recipients | Table | WhatsApp Campaign Recipient | | | | | | | | Rendered through a paginated component (gap R-01) | §5.4 · §3.2 |

Status machine: `Draft →(schedule) Scheduled` | `→(start now) Queued` · `Scheduled →(scheduler at scheduled_at) Queued` | `→(unschedule) Draft` | `→ Cancelled` · `Queued →(first item claimed) Running` · `Running ↔ Paused` (row-level Queue Item pause) · `Running →(all Outbound terminal, failed_count = 0) Completed` | `→(failed_count > 0) Partially Failed` · `Queued|Running|Paused → Cancelled` (open Queue Items → Deleted). Terminal: `Completed`, `Partially Failed`, `Cancelled`. Editing messages/recipients allowed in `Draft`/`Scheduled`; recipients may be added/removed in `Running`/`Paused` (counters + Audit `Campaign Recipients Changed`, gap G-04).
Derived, not stored: okRate/readRate/failRate/estDur/actDur/durDiff. Indexes: `status`, `scheduled_at`, `device`.

### 8. `WhatsApp Campaign Message` — child of Campaign

| fieldname | label | type | options | reqd | uniq | default | list | filter | depends_on | pl | description | serves |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| message_type | Message Type | Select | Text / Document / Image / Video / Audio / Sticker / Location / Poll | ✓ | | Text | ✓ | | | | Same vocabulary as Outbound | §5.4 |
| template | Template | Link | WhatsApp Template | | | | ✓ | | | | Choosing copies `body`/`attachment`/`print_format` into the row; later template edits do not propagate | Message Templates |
| body | Body | Text | | | | | ✓ | | eval:doc.message_type!="Location" | | Jinja; context = recipient row (`display_name`, `phone`, `contact` doc) | §5.4 |
| caption | Caption | Small Text | | | | | | | eval:["Document","Image","Video"].includes(doc.message_type) | | | — |
| attachment | Attachment | Attach | | | | | | | eval:["Document","Image","Video","Audio","Sticker"].includes(doc.message_type) | | Same file for every recipient | — |
| print_format | Print Format | Link | Print Format | | | | | | eval:doc.message_type=="Document" | | Per-recipient PDF; requires `contact` + `source_doctype/source_name` on the recipient row | — |
| file_name_template | File Name Template | Data | | | | | | | eval:doc.message_type=="Document" | | Jinja | — |
| poll_question | Poll Question | Data | | | | | | | eval:doc.message_type=="Poll" | | | legacy poll_* |
| poll_options | Poll Options | JSON | | | | | | | eval:doc.message_type=="Poll" | | | legacy |
| poll_allow_multiple | Allow Multiple Answers | Check | | | | 0 | | | eval:doc.message_type=="Poll" | | | legacy |
| delay_seconds | Delay after Previous (s) | Int | | | | 0 | ✓ | | | | Gap between consecutive messages to the same recipient | §5.4 |

### 9. `WhatsApp Campaign Recipient` — child of Campaign

Bulk-inserted by the ContactPicker via `frappe.db.bulk_insert` (gap F9/R-01). Uniqueness of `phone_e164` per parent enforced in the picker service, not by DB.

| fieldname | label | type | options | reqd | uniq | default | list | filter | depends_on | pl | description | serves |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| recipient_type | Recipient Type | Select | Individual / Group | ✓ | | Individual | | | | | Group rows come from picker source "device groups" (OQ-D) | — |
| phone | Phone | Data | | | | | ✓ | | | | Raw as imported | §3.2 |
| phone_e164 | Phone (E.164) | Data | | | | | ✓ | | | | reqd for Individual; `search_index`; duplicate flag key | §3.2 Selected tab |
| jid | JID | Data | | | | | | | eval:doc.recipient_type=="Group" | | | — |
| display_name | Display Name | Data | | | | | ✓ | | | | | §3.2 |
| contact | Contact | Link | Contact | | | | ✓ | | | | | §3.2 source 2 |
| source_type | Source | Select | Contact Group / Contact / DocType / Excel / vCard / Manual | ✓ | | | ✓ | | | | Picker source used | §3.2 |
| contact_group | Contact Group | Link | WhatsApp Contact Group | | | | | | eval:doc.source_type=="Contact Group" | | | §3.2 source 1 |
| source_doctype | Source DocType | Link | DocType | | | | | | eval:doc.source_type=="DocType" | | | §3.2 source 3 |
| source_name | Source Document | Dynamic Link | source_doctype | | | | | | eval:doc.source_type=="DocType" | | Print-format context for Document messages | §3.2 source 3 |
| status | Status | Select | Pending / Queued / Sent / Delivered / Read / Failed / Cancelled / Removed | ✓ | | Pending | ✓ | | | | read_only; aggregate of this recipient's Outbound rows (worst-of when multi-message) | Campaigns progress |
| outbound_message | Last Outbound | Link | WhatsApp Log | | | | | | | | read_only; last Outbound created for the row; all rows found via `Outbound.campaign_recipient` | — |
| error_code | Error Code | Data | | | | | | | eval:doc.status=="Failed" | | read_only | Campaign failures |
| added_by | Added By | Link | User | | | | | | | | read_only | gap G-04 |
| added_at | Added At | Datetime | | | | | | | | | read_only | gap G-04 |
| removed_by | Removed By | Link | User | | | | | | eval:doc.status=="Removed" | | read_only | gap G-04 |
| removed_at | Removed At | Datetime | | | | | | | eval:doc.status=="Removed" | | read_only | gap G-04 |

Indexes: `phone_e164` (search_index), `status`, `parent` (framework).

### 10. `WhatsApp Template` — `autoname field:template_name` · `track_changes 1`

Pattern of core `Email Template` (gap §2). Read by AGT for Quick Send.

| fieldname | label | type | options | reqd | uniq | default | list | filter | depends_on | pl | description | serves |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| template_name | Template Name | Data | | ✓ | ✓ | | ✓ | | | | | Message Templates: «النموذج» |
| category | Category | Data | | | | | ✓ | ✓ | | | Free text with existing-value suggestions (prototype: مستحقات/مالية/مبيعات/عام) | Message Templates: «التصنيف» |
| message_type | Message Type | Select | Text / Document / Image | ✓ | | Text | | ✓ | | | | Outbound: «نوع الرسالة» |
| body | Body | Code | Jinja | ✓ | | | | | | | Plain text Jinja; validated by compiling on save; errors logged never thrown at send (F2) | Message Templates: «بداية النص» / editor |
| attachment | Attachment | Attach | | | | | | | eval:doc.message_type=="Image" | | | — |
| print_format | Print Format | Link | Print Format | | | | | | eval:doc.message_type=="Document" | | | — |
| letter_head | Letter Head | Link | Letter Head | | | | | | eval:doc.message_type=="Document" | | | — |
| file_name_template | File Name Template | Data | | | | | | | eval:doc.message_type=="Document" | | Jinja | — |
| reference_doctype | Reference DocType | Link | DocType | | | | | ✓ | | | Variable hints (`doc.*`) and sample record for preview | Message Templates editor «vars» |
| language | Language | Link | Language | | | | | | | | | — |
| description | Description | Small Text | | | | | | | | | | — |
| sample_context | Sample Context | JSON | | | | | | | | | Values for editor preview | Message Templates editor «sample» |
| disabled | Disabled | Check | | | | 0 | | ✓ | | | | Message Templates |
| use_count | Uses | Int | | | | 0 | ✓ | | | | read_only; incremented by dispatcher | Message Templates: «الاستخدام» |
| last_used_at | Last Used At | Datetime | | | | | | | | | read_only | Message Templates |
| preview_html | Preview | HTML | | | | | | | | | display only: the TemplateEditor mounts here (D-122) | Message Templates editor, Preview tab |

Tabs (D-122): **Template** (name, category, description, type, disabled, body, usage) · **Attachment** (`depends_on` Document / Image) · **Preview** (reference DocType, language, sample context, `preview_html`).

Indexes: `disabled`, `category`. `modified` serves «آخر تحديث».

### 11. `WhatsApp Number` — `autoname field:phone_e164` · `title_field display_name` · `track_changes 0`

No role holds C/W/D, SM included (spec §5.2). Written by `services/numbers.py` (incremental after message insert + nightly reconcile) and by `api.numbers.link_or_convert` (§4 layer).

| fieldname | label | type | options | reqd | uniq | default | list | filter | depends_on | pl | description | serves |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| link_status | Link Status | Select | Linked / Not Linked | ✓ | | Not Linked | ✓ | ✓ | | | **First list column**, colour indicator (RC-03); = `contact` set | WhatsApp Contacts: «حالة التسجيل» |
| phone_e164 | Number | Data | | ✓ | ✓ | | ✓ | | | | E.164 for individuals; JID for Group/LID (gap F-05) | WhatsApp Contacts: «الرقم» |
| phone | Phone (raw) | Data | | | | | | | | | Last raw form seen | — |
| jid | JID | Data | | | | | | | | | | — |
| number_type | Number Type | Select | Individual / Group / LID | ✓ | | Individual | | ✓ | | | | WhatsApp Contacts: «مجموعة واتساب» |
| display_name | WhatsApp Name | Data | | | | | ✓ | | | | Push name from inbound; Contact name when linked | WhatsApp Contacts: «الاسم في الواتساب» |
| contact | Contact | Link | Contact | | | | ✓ | ✓ | | | Set only by link/convert action | WhatsApp Contacts: «جهة الاتصال في النظام» |
| linked_by | Linked By | Link | User | | | | | | eval:doc.contact | | read_only | Audit `Number Linked/Converted` |
| linked_at | Linked At | Datetime | | | | | | | eval:doc.contact | | read_only | — |
| first_seen | First Seen | Datetime | | | | | | | | | read_only | §5.2 |
| last_seen | Last Seen | Datetime | | | | | ✓ | | | | read_only; `search_index` | WhatsApp Contacts: «آخر رسالة» / «منذ» |
| last_direction | Last Direction | Select | Outbound / Inbound | | | | | ✓ | | | read_only | §5.2 |
| last_device | Last Device | Link | WhatsApp Device | | | | | ✓ | | | read_only | §5.2 · gap F-08 |
| outbound_count | Outbound | Int | | | | 0 | ✓ | | | | read_only | Contacts: «رسائل مرسلة» |
| inbound_count | Inbound | Int | | | | 0 | ✓ | | | | read_only | Contacts: «رسائل واردة» |
| conversation_confirmed | Conversation Confirmed | Check | | | | 0 | | ✓ | | | Manual override for `send_only_to_known_numbers` (gap G-07) | Contacts: «مؤكد يدوياً» |
| conversation_confirmed_by | Confirmed By | Link | User | | | | | | eval:doc.conversation_confirmed | | read_only | Contacts: chatLog «by» |
| conversation_confirmed_at | Confirmed At | Datetime | | | | | | | eval:doc.conversation_confirmed | | read_only | — |
| conversation_note | Confirmation Note | Small Text | | | | | | | eval:doc.conversation_confirmed | | | Contacts: chatLog «note» |

Indexes: `phone_e164` (unique = name), `contact`, `link_status`, `last_seen`, `number_type`.

### 12. `WhatsApp Contact Group` — `autoname field:group_name` · `track_changes 1`

CU role has C/R/W on all groups (OQ-6 default: all groups).

| fieldname | label | type | options | reqd | uniq | default | list | filter | depends_on | pl | description | serves |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| group_name | Group Name | Data | | ✓ | ✓ | | ✓ | | | | | Contact Groups: «المجموعة» |
| kind | Kind | Select | Marketing / Mailing List / Professional / Blacklist / Other | ✓ | | Other | ✓ | ✓ | | | `Blacklist` members are blocked from commands and campaigns (gap F-04) | Contact Groups: «النوع» |
| description | Description | Small Text | | | | | | | | | | Contact Groups: «المجموعة» sub / «ملاحظة» |
| source | Source | Select | Manual / Import / Picker | ✓ | | Manual | ✓ | ✓ | | | Last bulk source used | Contact Groups: «المصدر» |
| member_count | Members | Int | | | | 0 | ✓ | | | | read_only; maintained on member insert/delete | Contact Groups: «عدد الجهات» |
| members_changed_at | Members Changed At | Datetime | | | | | | | | | read_only | Contact Groups: «آخر تحديث» |
| disabled | Disabled | Check | | | | 0 | | ✓ | | | Disabled groups are not offered in the picker | — |
| members | Members | Table | WhatsApp Contact Group Member | | | | | | | | Paginated component (gap R-01) | §3.2 |

Tabs (D-122): **Group** · **Members** (`members_section` became the Members Tab Break).

Indexes: `kind`, `disabled`.

### 13. `WhatsApp Contact Group Member` — child of Contact Group

| fieldname | label | type | options | reqd | uniq | default | list | filter | depends_on | pl | description | serves |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| phone | Phone | Data | | | | | ✓ | | | | Raw | §3.2 |
| phone_e164 | Phone (E.164) | Data | | ✓ | | | ✓ | | | | `search_index`; unique per parent enforced in service | §3.2 duplicate flag |
| display_name | Display Name | Data | | | | | ✓ | | | | | Contact Groups: members list |
| contact | Contact | Link | Contact | | | | ✓ | | | | | Contact Groups: members badge |
| source_type | Source | Select | Contact Group / Contact / DocType / Excel / vCard / Manual | ✓ | | Manual | | | | | | §3.2 |
| source_doctype | Source DocType | Link | DocType | | | | | | eval:doc.source_type=="DocType" | | | §3.2 source 3 |
| source_name | Source Document | Dynamic Link | source_doctype | | | | | | eval:doc.source_type=="DocType" | | | §3.2 |
| added_by | Added By | Link | User | | | | | | | | read_only | §4 audit |
| added_on | Added On | Datetime | | | | | | | | | read_only | — |
| note | Note | Small Text | | | | | | | | | e.g. blacklist reason | Contact Groups: «حجب يدوي» |

Indexes: `phone_e164` (search_index), `contact`.

### 14. `WhatsApp Command` — `autoname field:code` · `title_field title` · `track_changes 1`

`validate` blocks any field change while `status = Active` except via the status action (§5.5). Create/edit in a modal (UI only).

| fieldname | label | type | options | reqd | uniq | default | list | filter | depends_on | pl | description | serves |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| code | Command Word | Data | | ✓ | ✓ | | ✓ | | | | Casefolded + trimmed on save; validated unique against every other command's `code` and `synonyms` | Commands: «الأمر» |
| title | Title | Data | | | | | | | | | Human label; default = code | Commands modal |
| function | Function | Link | WhatsApp Function | ✓ | | | ✓ | ✓ | | | set_query `status = Active` on create; warns in list when function inactive | Commands: «الدالة المنفَّذة» |
| status | Status | Select | Active / Inactive | ✓ | | Inactive | ✓ | ✓ | | | Machine: `Inactive ↔ Active` via action only | Commands: «الحالة» |
| synonyms | Synonyms | Small Text | | | | | ✓ | | | | One per line; casefolded; validated unique across commands | Commands: «المرادفات» |
| requires_linked_contact | Requires Linked Contact | Check | | | | 1 | | ✓ | | | Sender's `phone_e164` must resolve to a Contact with a party of an allowed type | Commands: «يشترط ربط الجهة» |
| allowed_party_types | Allowed Party Types | Table MultiSelect | WhatsApp Command Party Type | | | | | | | | Empty = all (see Findings F-01) | Commands: «الجهات المسموح لها» |
| allowed_group | Allowed Group | Link | WhatsApp Contact Group | | | | | | | | Whitelist; empty = everyone not blocked | legacy whitelist child |
| blocked_group | Blocked Group | Link | WhatsApp Contact Group | | | | | | | | In addition to `Settings.global_blacklist_group` | legacy blacklist child |
| reply_device | Reply Device | Link | WhatsApp Device | | | | | | | | Overrides Settings; empty = receiving device | legacy |
| settings_overrides | Settings Overrides | JSON | | | | | | | | | `{key: value}`; keys validated against `function.settings` | Functions: settings |
| outputs | Outputs | Table | WhatsApp Function Output | | | | | | | | Copied from Function on create; "restore defaults" re-copies (§5.5) | Functions: options |
| description | Description | Small Text | | | | | | | | | | Commands modal |
| run_count | Runs | Int | | | | 0 | | | | | read_only; 30-day figure derived from Inbound `(command, received_at)` | Commands: «التنفيذات (30ي)» |
| last_run_at | Last Run At | Datetime | | | | | | | | | read_only | Commands |
| defaults_restored_at | Defaults Restored At | Datetime | | | | | | | | | read_only; Audit `Command Defaults Restored` | §5.5 |

Indexes: `status`, `function`.

### 15. `WhatsApp Command Party Type` — child (Table MultiSelect) of Command; reused by Function `party_types`

| fieldname | label | type | options | reqd | uniq | default | list | filter | depends_on | pl | description | serves |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| party_type | Party Type | Link | DocType | ✓ | | | ✓ | | | | Table MultiSelect requires a Link (Findings F-01); `set_query` restricts to `Customer`, `Supplier`, `Employee`, `Sales Person`, `User`; validated server-side | Commands: «الجهات المسموح لها» |

### 16. `WhatsApp Function` — `autoname field:function_key` · `title_field function_name` · `track_changes 1`

No Desk create/delete; install/update/remove via `api.functions.*` from the Functions Center page (catalog JSON per app version, gap G-05).

| fieldname | label | type | options | reqd | uniq | default | list | filter | depends_on | pl | description | serves |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| function_key | Function Key | Data | | ✓ | ✓ | | | | | | Registry key; handler resolved from `whatsapp_next/functions/registry.py` (D-012) | §5.6 |
| function_name | Function Name | Data | | ✓ | | | ✓ | | | | | Functions: «الدالة» |
| category | Category | Data | | | | | ✓ | ✓ | | | From catalog | Functions: «المجموعة» |
| description | What It Does | Small Text | | | | | | | | | | Functions: «ماذا تفعل» |
| when_to_use | When To Use | Small Text | | | | | | | | | | Functions: «whenToUse» |
| party_types | Party Types | Table MultiSelect | WhatsApp Command Party Type | | | | | | | | From manifest; default for new Commands | Functions: «نوع الجهة» |
| status | Status | Select | Active / Inactive | ✓ | | Active | ✓ | ✓ | | | `Inactive` → linked commands match but do not execute (`block_reason = Function Inactive`) | Functions: «الحالة» |
| installed_version | Installed Version | Data | | ✓ | | | ✓ | | | | read_only | Functions: «الإصدار» |
| installed_at | Installed At | Datetime | | | | | | | | | read_only | Functions changelog «الحالي» |
| installed_by | Installed By | Link | User | | | | | | | | read_only | Audit `Function Installed` |
| latest_version | Latest Version | Data | | | | | | | | | read_only; from catalog check | Functions: «أحدث إصدار» |
| latest_version_date | Latest Version Date | Date | | | | | | | | | read_only | Functions changelog |
| update_available | Update Available | Check | | | | 0 | ✓ | ✓ | | | read_only; `latest_version != installed_version`; stored so the list can filter | Functions: «التحديث» |
| catalog_source | Catalog Source | Data | | | | | | | | | read_only; `catalog/vN/catalog.json` path + app version | gap G-05 |
| catalog_checked_at | Catalog Checked At | Datetime | | | | | | | | | read_only | Functions Center |
| manifest | Manifest | JSON | | | | | | | | | read_only; snapshot: inputs, outputs tokens, example, suggested_commands, changelog | Functions detail / diff-before-update |
| checksum | Checksum | Data | | | | | | | | | read_only; sha256 of manifest for diff | §5.6 |
| handler_registered | Handler Registered | Check | | | | 0 | | | | | read_only; computed in `validate`: key exists in code registry | D-012 |
| settings | Settings | Table | WhatsApp Function Setting | | | | | | | | Installed defaults; values editable | Functions: settings |
| outputs | Outputs | Table | WhatsApp Function Output | | | | | | | | Defaults copied to Commands | Functions: options |
| call_count | Calls | Int | | | | 0 | | | | | read_only; 30-day figure derived from Inbound | Functions: «الاستدعاءات (30ي)» |
| last_called_at | Last Called At | Datetime | | | | | | | | | read_only | Functions |
| avg_ms | Avg Duration (ms) | Int | | | | 0 | ✓ | | | | read_only; rolling average | Functions: «متوسط التنفيذ» |
| error_count | Errors | Int | | | | 0 | | | | | read_only | ops |
| last_error | Last Error | Small Text | | | | | | | | | read_only; no PII | ops |

Status machine: `Active ↔ Inactive` (action); removal deletes row after Commands referencing it are set `Inactive` (validated). `cmds` column («أوامر مرتبطة») derived by count of Commands by `function`.
Indexes: `status`, `category`, `update_available`.

### 17. `WhatsApp Function Setting` — child of Function

| fieldname | label | type | options | reqd | uniq | default | list | filter | depends_on | pl | description | serves |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| key | Key | Data | | ✓ | | | ✓ | | | | read_only after install; unique per parent | Functions: settings `key` |
| label | Label | Data | | ✓ | | | ✓ | | | | | Functions: settings `label` |
| fieldtype | Type | Select | Check / Int / Data / Select | ✓ | | Data | ✓ | | | | read_only after install | Functions: settings `typeLabel` |
| choices | Choices | Small Text | | | | | | | eval:doc.fieldtype=="Select" | | One per line | Functions: settings `choices` |
| default_value | Default | Data | | | | | ✓ | | | | read_only; from manifest | Functions: settings `defaultValue` |
| value | Value | Data | | | | | ✓ | | | | Effective value; validated by `fieldtype`/`choices` | Functions: settings |
| notes | Notes | Small Text | | | | | | | | | | Functions: settings `notes` |

### 18. `WhatsApp Function Output` — child of Function **and** Command (same child DocType in two parents)

| fieldname | label | type | options | reqd | uniq | default | list | filter | depends_on | pl | description | serves |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| output_key | Output Key | Data | | ✓ | | | ✓ | | | | read_only; unique per parent | Functions: options `name` |
| label | Label | Data | | ✓ | | | ✓ | | | | | Functions: options |
| output_type | Type | Select | Text / Document | ✓ | | Text | ✓ | | | | | Functions: options `type` |
| default_template | Default Template | Text | | | | | | | | | read_only; from manifest; source for "restore defaults" | Functions: options `defaultValue` |
| template | Template | Text | | | | | ✓ | | | | Jinja over `data.*` (Text) or Print Format name (Document) | Functions: options editor |
| condition | Condition | Code | Python | | | | | | | | Expression over `data`; empty = always | Functions: options `notes` |
| print_format | Print Format | Link | Print Format | | | | | | eval:doc.output_type=="Document" | | | Functions: «مستند كشف الحساب» |
| file_name_template | File Name Template | Data | | | | | | | eval:doc.output_type=="Document" | | Jinja | Functions: options `fileName` |
| variables | Available Variables | Small Text | | | | | | | | | read_only; tokens from manifest | Functions: options `fields` |
| notes | Notes | Small Text | | | | | | | | | | Functions: options `notes` |

### 19. `WhatsApp Audit Log` — `autoname hash` · `title_field summary` · `track_changes 0`

No role holds C/W/D; inserted by `services/audit.py` under the real session user (§4.3, gap R-04).

| fieldname | label | type | options | reqd | uniq | default | list | filter | depends_on | pl | description | serves |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| action | Action | Select | Device Created / Device Connected / Device Disconnected / Device Deleted / Credentials Changed / Settings Changed / Webhook Changed / Queue Paused / Queue Resumed / Queue Rate Changed / Queue Items Deleted / Campaign Started / Campaign Paused / Campaign Resumed / Campaign Cancelled / Campaign Recipients Changed / Bulk Send / Test Send / Elevated Contact Read / Elevated Contact Write / Number Linked / Number Converted / Conversation Confirmed / Function Installed / Function Updated / Function Removed / Command Changed / Command Defaults Restored / Retention Purge | ✓ | | | ✓ | ✓ | | | | Settings: «سجل التدقيق» |
| severity | Severity | Select | Info / Action / Warning / Danger | ✓ | | Action | ✓ | ✓ | | | Prototype tone | Settings audit: «النوع» |
| summary | Summary | Data | | ✓ | | | ✓ | | | | Template key + args rendered at read time via `__()`; no PII (phones masked) | Settings audit: «الحدث» |
| user | User | Link | User | ✓ | | | ✓ | ✓ | | | `frappe.session.user`; scheduler = `Administrator` with `job_name` set | Queue: «أوقف عبدالله الفهد» |
| job_name | Job Name | Data | | | | | | | | | Scheduler/RQ job when system-initiated | gap R-04 |
| timestamp | Timestamp | Datetime | | ✓ | | | ✓ | | | | = creation; explicit for reports | Settings audit: «الوقت» / «قبل» |
| reference_doctype | Reference DocType | Link | DocType | | | | | ✓ | | | Acted-on record | — |
| reference_name | Reference Name | Dynamic Link | reference_doctype | | | | | | eval:doc.reference_doctype | | | — |
| target_doctype | Target DocType | Link | DocType | | | | | | | | Secondary record (e.g. Contact created from Number) | §4 |
| target_name | Target Name | Dynamic Link | target_doctype | | | | | | eval:doc.target_doctype | | | §4 |
| fields_written | Fields Written | Small Text | | | | | | | | | Fieldnames only, never values (§4 condition 3) | §4 |
| reason | Reason | Small Text | | | | | | | | | User-entered reason (pause/cancel/delete) | Queue: «سبب الإيقاف (يظهر في سجل التدقيق)» |
| count | Count | Int | | | | | | | | | Rows affected for bulk actions | Queue: «أُلغيت 41 رسالة» |
| ip_address | IP Address | Data | | | | | | | | | `frappe.local.request_ip` | security rule |
| details | Details | JSON | | | | | | | | | Structured, no PII (ids, counts, old/new for non-secret settings) | — |

Indexes (JSON): `action`, `user`, `timestamp`. Composite (patch): `(reference_doctype, reference_name)`, `(user, creation)`.

### 20. `WhatsApp Notification` — `autoname field:notification_name` · `track_changes 1`

Core `Notification` pattern + legacy `WhatsApp Notification` (D-016). Fires from `doc_events["*"]` limited to `validate/on_update/on_submit/on_cancel/after_insert/on_change` with per-DocType cache (RC-04); every send is a queued Outbound (D-010). UI: second list under Templates (F-02). Tabs: Trigger · Message · Recipients · Property · Stats.

| fieldname | label | type | options | reqd | uniq | default | list | filter | depends_on | pl | description | serves |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| notification_name | Name | Data | | ✓ | ✓ | | ✓ | | | | | Notification Templates: «النموذج» |
| enabled | Enabled | Check | | | | 1 | ✓ | ✓ | | | | Notification Templates: «الحالة» |
| document_type | Document Type | Link | DocType | ✓ | | | ✓ | ✓ | | | | Notification Templates: «نوع المستند» |
| event | Send Alert On | Select | New / Save / Submit / Cancel / Days Before / Days After / Minutes Before / Minutes After / Value Change / Method | ✓ | | | | ✓ | | | Prototype conditions map: «عند كل مستند» = Save, «عند الاعتماد» = Submit, «عند التأخر» = Days After + `date_changed`, «عند تجاوز مبلغ» = Submit + `condition` | Notification Templates: «شرط الإرسال» |
| date_changed | Reference Date | Select | | | | | | | eval:["Days Before","Days After"].includes(doc.event) | | Options set by JS from Date fields of `document_type` | legacy |
| days_in_advance | Days Before or After | Int | | | | 0 | | | eval:["Days Before","Days After"].includes(doc.event) | | | legacy |
| datetime_changed | Reference Datetime | Select | | | | | | | eval:["Minutes Before","Minutes After"].includes(doc.event) | | | legacy |
| minutes_offset | Minutes Before or After | Int | | | | 0 | | | eval:["Minutes Before","Minutes After"].includes(doc.event) | | | legacy |
| value_changed | Value Changed | Select | | | | | | | eval:doc.event=="Value Change" | | Fieldname | legacy |
| method | Method | Data | | | | | | | eval:doc.event=="Method" | | Doc event name (e.g. `on_update_after_submit`), **not** a dotted path | legacy (D-012) |
| condition | Condition | Code | Python | | | | | | | | Expression over `doc`; safe_eval | legacy |
| device | Device | Link | WhatsApp Device | | | | ✓ | ✓ | | | Empty = `Settings.default_device` | Notification Templates: «جهاز الإرسال» |
| template | Template | Link | WhatsApp Template | | | | | ✓ | | | Preferred body source (OQ-9) | Notification Templates |
| message | Message | Code | Jinja | | | | | | eval:!doc.template | | Inline fallback when no template (OQ-9); reqd if template empty | Notification Templates: «نص الرسالة» |
| message_type | Message Type | Select | Text / Document / Image | ✓ | | Text | | | | | | — |
| attach_print | Attach Print | Check | | | | 0 | | | eval:doc.message_type=="Document" | | | legacy |
| print_format | Print Format | Link | Print Format | | | | | | eval:doc.attach_print | | | legacy |
| letter_head | Letter Head | Link | Letter Head | | | | | | eval:doc.attach_print | | | legacy |
| attach_field | Attach from Field | Data | | | | | | | eval:doc.message_type!="Text" | | Attach fieldname on the document | legacy `from_attach_field` |
| set_property_after_alert | Set Property After Alert | Select | | | | | | | | | Fieldname on `document_type` | legacy |
| property_value | Value To Be Set | Data | | | | | | | eval:doc.set_property_after_alert | | | legacy |
| recipients | Recipients | Table | WhatsApp Notification Recipient | ✓ | | | | | | | ≥ 1 row | legacy |
| variables_count | Variables | Int | | | | 0 | ✓ | | | | read_only; counted from body on save | Notification Templates: «المتغيرات» |
| send_count | Sends | Int | | | | 0 | | | | | read_only; 30-day figure from Outbound `(notification, creation)` | Notification Templates: «الاستخدام (30ي)» |
| last_sent_at | Last Sent At | Datetime | | | | | | | | | read_only | — |
| last_error | Last Error | Small Text | | | | | | | | | read_only; render/recipient errors logged, never thrown (F2) | — |
| last_error_at | Last Error At | Datetime | | | | | | | | | read_only | — |

Indexes (JSON): `document_type`, `enabled`. Composite (patch): `(document_type, event, enabled)`.

### 21. `WhatsApp Notification Recipient` — child of Notification

One row = one recipient rule. Fixed numbers use the standard `phone`/`phone_e164` pair (one number per row) instead of the sketched `cc_numbers` blob (Findings F-05).

| fieldname | label | type | options | reqd | uniq | default | list | filter | depends_on | pl | description | serves |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| recipient_type | Recipient Type | Select | Document Field / Linked Document Field / Fixed Number | ✓ | | Document Field | ✓ | | | | | legacy |
| receiver_by_document_field | Document Field | Select | | | | | ✓ | | eval:doc.recipient_type=="Document Field" | | Phone or Link-to-Contact field on the parent's `document_type` (options by JS) | legacy |
| linked_document_field | Linked Document Field | Select | | | | | ✓ | | eval:doc.recipient_type=="Linked Document Field" | | Link field on the document | legacy |
| linked_mobile_fieldname | Mobile Fieldname on Linked Doc | Data | | | | | ✓ | | eval:doc.recipient_type=="Linked Document Field" | | | legacy |
| phone | Phone | Data | | | | | ✓ | | eval:doc.recipient_type=="Fixed Number" | | Raw | legacy `cc` |
| phone_e164 | Phone (E.164) | Data | | | | | | | eval:doc.recipient_type=="Fixed Number" | | read_only; normalized on save | §6.2 |
| condition | Condition | Code | Python | | | | | | | | Row-level condition over `doc` | legacy |

### 22. `WhatsApp Notification Alert` — `autoname field:alert_name` · `track_changes 1`

Report digests on a schedule (D-016). Scheduler job `services/alerts.run_due_alerts` every 15 min (F11) selects `enabled = 1 and next_run_at <= now`. UI: same list pattern as Notification under Templates (OQ-3 default; alternative: section on Settings).

| fieldname | label | type | options | reqd | uniq | default | list | filter | depends_on | pl | description | serves |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| alert_name | Name | Data | | ✓ | ✓ | | ✓ | | | | | D-016 |
| enabled | Enabled | Check | | | | 1 | ✓ | ✓ | | | | D-016 |
| periodicity | Periodicity | Select | Daily / Weekly / Monthly / Quarterly / Yearly | ✓ | | Daily | ✓ | ✓ | | | Legacy had no Quarterly | legacy |
| day_of_week | Day of Week | Select | Monday / Tuesday / Wednesday / Thursday / Friday / Saturday / Sunday | | | | | | eval:doc.periodicity=="Weekly" | | | — |
| day_of_month | Day of Month | Int | | | | 1 | | | eval:["Monthly","Quarterly","Yearly"].includes(doc.periodicity) | | 1–28 | — |
| month_of_year | Month | Select | January / February / March / April / May / June / July / August / September / October / November / December | | | | | | eval:doc.periodicity=="Yearly" | | | — |
| notification_time | Time | Time | | ✓ | | | ✓ | | | | Site timezone | legacy |
| content_type | Content | Select | Report / Static Message | ✓ | | Report | | ✓ | | | | legacy `chart_type` |
| report | Report | Link | Report | | | | ✓ | ✓ | eval:doc.content_type=="Report" | | reqd when Report | legacy `report_name` |
| filters_json | Filters | Code | JSON | | | | | | eval:doc.content_type=="Report" | | | legacy |
| dynamic_filters_json | Dynamic Filters | Code | JSON | | | | | | eval:doc.content_type=="Report" | | Jinja-evaluated dates | legacy |
| template | Template | Link | WhatsApp Template | | | | | | | | Body source; context = `rows`, `columns`, `report`, `alert` | D-016 |
| message | Message | Code | Jinja | | | | | | eval:!doc.template | | Inline fallback; reqd if template empty | legacy `message` |
| attachment_format | Attachment | Select | None / PDF / PNG | ✓ | | PDF | | | eval:doc.content_type=="Report" | | PNG needs wkhtmltoimage on the bench (OQ-E) | legacy print |
| print_format | Print Format | Link | Print Format | | | | | | eval:doc.attachment_format!="None" | | | legacy |
| letter_head | Letter Head | Link | Letter Head | | | | | | eval:doc.attachment_format!="None" | | | legacy |
| language | Language | Link | Language | | | | | | | | Render language | — |
| device | Device | Link | WhatsApp Device | | | | ✓ | ✓ | | | Empty = default device | legacy `whatsapp_device` |
| recipients | Recipients | Table | WhatsApp Notification Alert Recipient | ✓ | | | | | | | ≥ 1 row | legacy |
| send_count | Sends | Int | | | | 0 | | | | | read_only | — |
| last_sent_at | Last Sent At | Datetime | | | | | | | | | read_only | legacy `last_notification_date` |
| next_run_at | Next Run At | Datetime | | | | | | | | | read_only; `search_index`; recomputed on save and after each run | F11 |
| last_error | Last Error | Small Text | | | | | | | | | read_only | — |

Indexes (JSON): `enabled`, `next_run_at`. Composite (patch): `(enabled, next_run_at)`.

### 23. `WhatsApp Notification Alert Recipient` — child of Alert (three legacy children folded into one)

| fieldname | label | type | options | reqd | uniq | default | list | filter | depends_on | pl | description | serves |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| recipient_type | Recipient Type | Select | User / Role / Phone / Report Column | ✓ | | User | ✓ | | | | | legacy `Users / Roles / CC / Report Column` |
| user | User | Link | User | | | | ✓ | | eval:doc.recipient_type=="User" | | Phone = `User.mobile_no` normalized at send; skipped with logged error when empty | legacy |
| role | Role | Link | Role | | | | ✓ | | eval:doc.recipient_type=="Role" | | Expands to enabled users of the role | legacy |
| phone | Phone | Data | | | | | ✓ | | eval:doc.recipient_type=="Phone" | | Raw | legacy `CC` |
| phone_e164 | Phone (E.164) | Data | | | | | | | eval:doc.recipient_type=="Phone" | | read_only; normalized on save | §6.2 |
| report_column | Report Column | Data | | | | | ✓ | | eval:doc.recipient_type=="Report Column" | | Column fieldname holding a phone; one message per distinct value, rows filtered to that value | legacy |

### 24. `WhatsApp Webhook Event` — `autoname hash` · `title_field event_name` · `track_changes 0`

No export (payload is PII); SM/MGR read only. Inserted by `api.webhook.receive` after signature + freshness checks (D-013).

| fieldname | label | type | options | reqd | uniq | default | list | filter | depends_on | pl | description | serves |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| event_id | Event ID | Data | | ✓ | ✓ | | ✓ | | | | `X-SND-Event-ID`; dedupe key | D-013 |
| event_name | Event | Data | | ✓ | | | ✓ | ✓ | | | `X-SND-Event`; **Data not Select** so unknown/future events are storable as `Ignored`; known values = platform `SUPPORTED_WEBHOOK_EVENTS` (12); `search_index` | Settings: «آخر المحاولات» |
| received_at | Received At | Datetime | | ✓ | | | ✓ | | | | `search_index` | Settings webhook panel |
| event_timestamp | Event Timestamp | Datetime | | | | | | | | | From `X-SND-Timestamp` | D-013 |
| signature_valid | Signature Valid | Check | | | | 0 | | ✓ | | | Invalid → row still stored with `Ignored` for forensics, payload blanked | D-013 |
| timestamp_fresh | Timestamp Fresh | Check | | | | 0 | | ✓ | | | Within ±5 min | D-013 |
| device | Device | Link | WhatsApp Device | | | | | ✓ | | | Resolved from `platform_device`; unknown → `Ignored` (F6) | gap F6 |
| platform_device | Platform Device | Data | | | | | | | | | Raw `device` from payload | §G |
| client_ref | Client Ref | Data | | | | | | | | | `search_index`; `message.*` queue-path payloads | D-024 |
| provider_message_id | Provider Message ID | Data | | | | | | | | | For delivered/read/reaction routing | §G |
| payload | Payload | JSON | | | | | | | | | Raw body; PII → purged after `webhook_event_retention_days`, blanked after processing for terminal `message.*` events | gap R-03 |
| status | Status | Select | Received / Processed / Ignored / Failed | ✓ | | Received | ✓ | ✓ | | | See machine; `Duplicate` replaced by `duplicate_count` (Findings F-03) | ops |
| duplicate_count | Duplicate Deliveries | Int | | | | 0 | | | | | Incremented when the same `event_id` arrives again (200 returned, no reprocessing) | D-013 dedupe |
| error | Error | Small Text | | | | | | | eval:doc.status=="Failed" | | No PII | ops |
| processed_at | Processed At | Datetime | | | | | | | | | | ops |
| processing_ms | Processing (ms) | Int | | | | | | | | | | ops |
| inbound_message | Inbound Message | Link | WhatsApp Inbound Message | | | | | | | | Created from `message.received`/`reaction` | Inbound |
| outbound_message | Outbound Message | Link | WhatsApp Log | | | | | | | | Resolved via `client_ref` / `provider_message_id` | Outbound status |

Status machine: `Received →(job) Processed` | `Ignored` (unknown event, unknown device, invalid signature, stale timestamp, plan-disallowed) | `Failed` (exception; reprocess job retries `Failed` up to 3×, then stays `Failed` + Error Log). Terminal: `Processed`, `Ignored`.
Indexes (JSON): `event_id` (unique), `event_name`, `received_at`, `status`, `client_ref`. Composite (patch): `(event_name, received_at)`.

---

### Encrypted fields (fieldtype `Password`, never in list view, never exported, never in Audit `details`)

| DocType | fieldname | permlevel | Written by | Read by |
|---|---|---|---|---|
| WhatsApp Settings | customer_api_key | 1 | SM via form | `providers/snd_platform.py` (`get_password`) |
| WhatsApp Settings | api_key | 1 | SM via form | same |
| WhatsApp Settings | api_secret | 1 | SM via form | same |
| WhatsApp Settings | webhook_secret | 1 | `services/webhook_setup.py` from `get_integration_webhook_secret_api` (D-013) | `api.webhook.receive` HMAC check |

No other DocType stores a secret. Device token / QR / pair code are cache-only (D-014).

### Phone field pairs (all normalized by `services/phone.py` on `validate`/insert)

| DocType | pair | e164 indexed |
|---|---|---|
| WhatsApp Device | phone / phone_e164 | ✓ |
| WhatsApp Log | phone / phone_e164 (+ `jid`) | ✓ |
| WhatsApp Inbound Message | phone / phone_e164 (+ `jid`, `sender_jid`) | ✓ |
| WhatsApp Queue Item | phone_e164 only (denormalized copy) | — |
| WhatsApp Campaign Recipient | phone / phone_e164 (+ `jid`) | ✓ (child) |
| WhatsApp Number | phone / phone_e164 (name) | ✓ unique |
| WhatsApp Contact Group Member | phone / phone_e164 | ✓ (child) |
| WhatsApp Notification Recipient | phone / phone_e164 | — |
| WhatsApp Notification Alert Recipient | phone / phone_e164 | — |
| Contact Phone (core, custom field OQ-5) | `wa_phone_e164` | ✓ |

---

## Findings

| # | Finding | Consequence |
|---|---|---|
| F-01 | Frappe `Table MultiSelect` requires the child to expose exactly one **Link** field; the sketch's `party_type` Select cannot work | `WhatsApp Command Party Type.party_type` = Link → `DocType` with `set_query` + server validation to the five allowed names; the same child serves `Function.party_types` |
| F-02 | Prototype Campaigns list has 8 columns with no home in the sketch («المستلمون في البداية», «تعديل بعد الاعتماد», «نسبة التعديل», «أول/آخر رسالة صادرة», «نوع البدء», durations) | Added `initial_recipients`, `added_count`, `removed_count`, `pause_count`, `first_message_at`, `last_message_at`; start kind and durations derived |
| F-03 | Sketch has both `event_id` **unique** and a `Duplicate` status on Webhook Event — a duplicate row can never be inserted | Dropped `Duplicate`; added `duplicate_count` on the original row; receiver answers 200 without reprocessing. Alternative: drop the unique constraint and keep the status |
| F-04 | `Template` as an Outbound `message_type` has no platform counterpart; the template is already a Link | Removed from options; `message_type` mirrors the platform send vocabulary (8 values) |
| F-05 | Sketch `cc_numbers` (Small Text blob) on Notification Recipient breaks the `phone`/`phone_e164` convention and cannot be normalized per number | One fixed number per row (`recipient_type = Fixed Number`) with the standard pair |
| F-06 | `held_reason` sketched on Queue Item, but a hold is reported after hand-over (Queue Item already `Completed`) | `held_at`/`held_reason` live on Outbound; Queue Item keeps no `Held` state |
| F-07 | Webhook `event_name` as a Select would reject unknown/future platform events at insert | Data + index; unknown events stored as `Ignored` |
| F-08 | Prototype 30-day counters (Commands «التنفيذات (30ي)», Functions «الاستدعاءات (30ي)», Notification «الاستخدام (30ي)», Devices «أُرسل (30ي)») are windowed | Store lifetime counters only; windows come from indexed `(command, received_at)`, `(notification, creation)`, `(device, creation)` |
| F-09 | Settings credentials at `permlevel 1` is the concrete mechanism for "SM writes, MGR reads settings but never secrets" | MGR gets no permlevel-1 row; forms hide the fields for MGR automatically |
| F-10 | Prototype Contacts screen has a per-contact «معطّل/مفعّل» switch with a reason log | No field: served by membership in a `Blacklist` group + `note` (gap §8 rejected `wa_opt_out`); the switch on the Contacts page adds/removes the member row |
| F-11 | Composite indexes the gap requires are not expressible in DocType JSON | One patch `add_indexes.py` (idempotent `frappe.db.add_index`) listed per table above; must run in `after_migrate` too for fresh installs |
| F-12 | `WhatsApp Function Output` is a child of two parents (Function, Command) | Allowed by Frappe (`parenttype` discriminates); "restore defaults" = delete Command rows, copy Function rows |

## Gaps

| # | Prototype element | Backing | Status |
|---|---|---|---|
| G-01 | Outbound/Queue «المبلغ» | Read layer joins `reference_doctype/name` → `grand_total`-like field via a per-DocType map | Not stored (gap F-07) |
| G-02 | Devices «battery» | None | Dropped (OQ-7) |
| G-03 | Queue «#» position, «الإرسال المتوقّع» ETA | Computed in `api.queue.list_queue` | Not stored |
| G-04 | Functions «أوامر مرتبطة», Commands «الدالة موقوفة» warning | Count / join on `Command.function` | Not stored |
| G-05 | Settings audit «قبل» (ago) | `timestamp` | Derived |
| G-06 | Contact «الحسابات المرتبطة» / party type on Inbound detail | Core `Contact` → `Dynamic Link` rows, read through §4 layer | Not stored |
| G-07 | Campaign Recipient rows for **group JIDs** | `recipient_type = Group` + `jid` reserved | Needs OQ-D |

## Risks

| # | Risk | Mitigation |
|---|---|---|
| R-01 | Outbound carries 7 single + 5 composite indexes at 1M rows → slower bulk inserts (F9) | Keep `bulk_insert` batches ≤ 500; drop `(status, scheduled_at)` if the Queue Item index proves sufficient |
| R-02 | Retention purge on Outbound hits Link references from Queue Item, Inbound `reply_outbound`, Webhook Event, Campaign Recipient | Purge order: Webhook Event → Queue Item → Outbound; Inbound/Recipient links use `ignore_links` on delete; nightly job in `long` queue |
| R-03 | `WhatsApp Number.name` = E.164 or JID; `field:` naming with `+` and `@` produces URL-encoded names | Acceptable (Frappe encodes); `title_field display_name`; never rename |
| R-04 | Two counters sets (Campaign counters vs Outbound truth; Group `member_count` vs rows) can drift | Runner recomputes on every batch end; nightly reconcile asserts equality and logs drift |
| R-05 | `Contact Phone.wa_phone_e164` (OQ-5) requires a `Contact.validate` hook on a core DocType | Fixture custom field + `doc_events["Contact"]["validate"]`; backfill patch runs once |
| R-06 | Password fields on a Single with `permlevel 1`: `frappe.get_single` returns masked values to MGR; services must call `get_password` explicitly | One accessor in `providers/snd_platform.py`; test that MGR session never receives plaintext |

## Recommendations

| # | Recommendation |
|---|---|
| RC-01 | Generate all 24 JSONs from this file in the build order of gap RC-01; add `test_fields.py` asserting every fieldname/type/option here exists in the installed meta |
| RC-02 | One `patches/v0_1/add_indexes.py` for the composite indexes listed per table; also invoked from `after_migrate` |
| RC-03 | List views: Outbound/Inbound/Queue/Number/Campaign via `public/js/listview/` with the columns marked `list` here; `display_name` as title everywhere naming is `hash` |
| RC-04 | Status writers: `services/dispatch.py` (Outbound + Queue Item), `services/devices.py` (Device), `services/campaign_runner.py` (Campaign + Recipient), `services/commands.py` (Inbound `command_*`), `services/webhook.py` (Webhook Event); `validate` on each DocType rejects a status change from any other call path via `frappe.flags.wa_status_writer` |
| RC-05 | Keep the prototype error codes as the canonical `error_code` vocabulary and add `unknown`; map provider strings in one place (`services/errors.py`) |

## Open questions

| # | Question | Blocks | Proposed default |
|---|---|---|---|
| OQ-A | Outbound `message_type` = 8 values here; platform `send_message_api` accepts 14. Extend to the platform list or keep the 8 the product sends? | Outbound JSON | Keep 8; add on demand |
| OQ-B | Inbound `provider_message_id` unique alone (gap) or composite `(device, provider_message_id)`? Two devices in the same group chat receive the same id | Inbound JSON | Composite via patch; drop single-column unique |
| OQ-C | Audit `summary` stored as a translatable key + args (rendered on read) vs stored Arabic text? | Audit list | Key + args in `details.summary_args`; `summary` holds the English key |
| OQ-D | Are WhatsApp **group** recipients in Campaigns in scope (recipient_type Group)? | Campaign Recipient, ContactPicker | Reserve fields; picker source "device groups" deferred |
| OQ-E | Notification Alert `PNG` attachment needs `wkhtmltoimage`; keep or ship `None / PDF` only? | Alert JSON | Keep option; validate binary presence on save |

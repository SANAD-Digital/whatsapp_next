# 02 — DocTypes gap: `whatsapp_next`

Phase 2 · 2026-09-22 · inputs: `plan/00-screens-spec.md` (binding), `plan/00-conventions.md` §Naming,
`plan/decisions.md` D-010..D-024, `plan/01-snd-whatsapp-summary.md`, `plan/05-platform-summary.md`,
`.claude/rules/{architecture,security}.md`, prototype `docs/shared/hub-data.global.js` + `docs/screen/*`.

## Purpose

Inventory of DocTypes the product needs versus what exists. `whatsapp_next/whatsapp_next/doctype/` is
**empty** (verified by glob). Therefore:

- **Reuse as is** = core Frappe/ERPNext DocTypes linked to or read from, untouched.
- **Reuse with changes** = a *design* carried over (core pattern, or a legacy `snd_whatsapp` DocType
  whose shape is ported). Nothing legacy is reused physically — D-017 (no migration, naming free) and
  D-015 (debt fixed, not ported).
- **Create new** = every DocType created in module `WhatsApp Next`.

Permission legend: `R` read · `C` create · `W` write · `D` delete · `E` export · `P` print · `—` none.
Roles: **SM** System Manager · **MGR** WhatsApp Manager · **AGT** WhatsApp Agent · **VWR** WhatsApp Viewer ·
**CU** WhatsApp Contact User. "System" = written only by services with `ignore_permissions` after an
explicit role check, always under the real session user (spec §4.3).

---

## Inventory

### 1. Reuse as is (core, untouched)

| DocType | Used by | How |
|---|---|---|
| `Contact`, `Contact Phone` | Numbers link/convert (§5.2), Contacts page (12), ContactPicker source 2, Campaign/Group members | Link target; written **only** through the contextual layer (§4) |
| `Customer`, `Supplier`, `Employee`, `Sales Person` | Contacts page party link; Command `allowed party types`; Function inputs | Link targets; never written |
| `DocType` | Settings picker whitelist; Notification `document_type` | Link target |
| `User`, `Role`, `User Permission` | Roles; per-device isolation (security rule) | `device` Link on every transactional DocType keeps User Permission scoping possible |
| `Report`, `Print Format`, `Letter Head` | Notification Alert (report digest), document messages | Link targets |
| `File` | Attachments on Outbound / Campaign Message / Template | Standard attach; private by default |
| `Error Log` | Failures without payloads (security rule: no PII) | Standard |
| `Scheduled Job Type`, `RQ Job` | Scheduler + job tracking | Standard |
| `Number Card`, `Dashboard Chart`, `Workspace`, `Page` | Home (2), Custom Pages | Fixtures |
| `Country` | E.164 default region (fix R-F) | Link on Settings |
| `Version` | `track_changes` on config DocTypes | Standard |

### 2. Reuse with changes (design carried over, physically new)

| Source design | Becomes | What changes (D-015) |
|---|---|---|
| core `Email Template` (pattern) | `WhatsApp Template` | Plain-text Jinja `body` instead of HTML `response`; `message_type`; document/print-format variant; usage counters |
| core `Notification` (pattern) + legacy `WhatsApp Notification` (+Recipient) | `WhatsApp Notification` (+`WhatsApp Notification Recipient`) | Body via `WhatsApp Template` link (F13); no `send_now`, no inline send, no `commit` (D-010/D-016); template errors logged not thrown (F2); per-DocType cache of active notifications so `doc_events["*"]` is cheap |
| legacy `WhatsApp Notification Alert` (+Role/User/Recipient) | `WhatsApp Notification Alert` (+ one child `WhatsApp Notification Alert Recipient`) | Three children folded into one polymorphic recipient row; scheduler job registered (F11); sends via queue |
| legacy `WhatsApp Log` | `WhatsApp Log` (name kept, D-027) | Outbound only (F4); `hash` naming; no `cc`/`priority`/`send_now`/`re_create_pdf`; `phone_e164`; `client_ref`; `Held` status (D-024); provider fields; `is_test` / `is_simulated`; status write only from `services/dispatch.py` |
| legacy `WhatsApp Webhook Message Received Log` | `WhatsApp Inbound Message` | First-class message table read by the drawer; command routing fields; no `raw_data` (raw lives in Webhook Event) |
| legacy 5× webhook logs (Received/Status/Connection/Group/Reaction) | `WhatsApp Webhook Event` | One table, unique `event_id` (X-SND-Event-ID), timestamp freshness recorded, never creates devices (F6/R-G) |
| legacy `WhatsApp Device` | `WhatsApp Device` | No token/QR/pair-code persisted (F7, D-014); statuses aligned to platform; `phone_e164` |
| legacy `WhatsApp Platform Settings` | `WhatsApp Settings` (Single) | Three Password credentials (D-013/D-020); SM-only write (D-014); adds queue, retention, picker whitelist, command policy, subscription cache, numbers watermark; whitelist/blacklist children replaced by Contact Group links |
| legacy `WhatsApp Campaign` (+Recipient) | `WhatsApp Campaign` (+`Message`, +`Recipient`) | Multiple messages (§5.4); `Paused` state; recipients carry `phone_e164` + picker source; bulk inserts (F9); no `audience_source` |
| legacy `WhatsApp Command` (+API, whitelist/blacklist children) | `WhatsApp Command` (+`WhatsApp Command Party Type`) | Points to a `WhatsApp Function` by key, never a dotted path (D-012, F5); edit blocked while active (§5.5); lists become Contact Group links |
| legacy `WhatsApp API` + `apis.json` registry | `WhatsApp Function` (+`Setting`, +`Output`) | Installed-function record with versions and manifest snapshot (§5.6); handler resolved from a code registry by `function_key` |
| legacy claim/dispatch/reconcile fields on Log | `WhatsApp Queue Item` | Dispatch state split out of the message row (see Findings F-01) |
| legacy `WhatsApp Platform Contact` / `Group` cache | **dropped** | Replaced by `WhatsApp Number` (materialized) + live `list_device_contacts_api` in the picker |
| legacy `Sanad WhatsApp Integration`, 3 admin pages, workspace cards | **dropped** | Spec screens 2 and 15 |

### 3. Create new — summary

All: module `WhatsApp Next`, `is_submittable = 0`. `track_changes = 1` only where marked. Volume = a
mid-size tenant per year unless stated.

| # | DocType | Child of | Naming (`autoname`) | Key links | Expected volume | Indexes (beyond `name`) | track_changes |
|---|---|---|---|---|---|---|---|
| 1 | `WhatsApp Settings` | Single | — | `default_device`→Device, `command_service_user`→User, `global_blacklist_group`→Contact Group, `default_country`→Country | 1 | — | yes |
| 2 | `WhatsApp Settings Picker Source` | Settings (child) | — | `document_type`→DocType | ≤ 20 rows | — | — |
| 3 | `WhatsApp Device` | — | `WA-DEV-.###` | — | < 10 | `platform_device` (unique), `phone_e164`, `status` | yes |
| 4 | `WhatsApp Log` | — | `hash` (name doubles as `client_ref`) | `device`, `contact`→Contact, `campaign`, `template`, `notification`, `command`, `trigger_inbound`→Inbound, `queue_item`→Queue Item, `reference_doctype/name` (Dynamic Link) | 50k – 1M | `phone_e164`, `status`, `(device, creation)`, `campaign`, `provider_message_id`, `(reference_doctype, reference_name)`, `creation` | no |
| 5 | `WhatsApp Inbound Message` | — | `hash` | `device`, `contact`→Contact, `command`, `reply_outbound`→Outbound, `webhook_event` | 20–40 % of outbound | `phone_e164`, `provider_message_id` (unique), `(device, received_at)`, `received_at`, `command_status` | no |
| 6 | `WhatsApp Queue Item` | — | `hash` | `outbound_message`→Outbound (unique), `device`, `campaign` | = outbound, transient (purged after `queue_retention_days`) | `outbound_message` (unique), `(status, scheduled_at, priority)`, `next_attempt_at`, `campaign`, `batch_id` | no |
| 7 | `WhatsApp Campaign` | — | `WA-CAMP-.YYYY.-.#####` | `device`, `owner` | 10s – 100s | `status`, `scheduled_at` | yes |
| 8 | `WhatsApp Campaign Message` | Campaign (child) | — | `template`→Template | 1–5 per campaign | — | — |
| 9 | `WhatsApp Campaign Recipient` | Campaign (child) | — | `contact`→Contact, `outbound_message`→Outbound | up to 10k per campaign | `phone_e164` (search_index), `status` | — |
| 10 | `WhatsApp Template` | — | `field:template_name` | `print_format`, `letter_head`, `reference_doctype`→DocType | 10s | `disabled` | yes |
| 11 | `WhatsApp Number` | — | `field:phone_e164` (or JID for groups/LIDs) | `contact`→Contact, `last_device`→Device | 5k – 50k distinct | `contact`, `link_status`, `last_seen`, `number_type` | no |
| 12 | `WhatsApp Contact Group` | — | `field:group_name` | — | 10s | `kind` | yes |
| 13 | `WhatsApp Contact Group Member` | Contact Group (child) | — | `contact`→Contact | ≤ 10k per group | `phone_e164` (search_index) | — |
| 14 | `WhatsApp Command` | — | `field:code` (casefolded, unique) | `function`→Function, `allowed_group`/`blocked_group`→Contact Group, `reply_device`→Device | 10s | `status`, `function` | yes |
| 15 | `WhatsApp Command Party Type` | Command (child, Table MultiSelect) | — | — | ≤ 6 per command | — | — |
| 16 | `WhatsApp Function` | — | `field:function_key` | — | 10s | `status`, `category` | yes |
| 17 | `WhatsApp Function Setting` | Function (child) | — | — | ≤ 10 per function | — | — |
| 18 | `WhatsApp Function Output` | Function (child) | — | `print_format` | ≤ 5 per function | — | — |
| 19 | `WhatsApp Audit Log` | — | `hash` | `user`→User, `reference_doctype/name` (Dynamic Link), `target_doctype/name` (Dynamic Link) | 10k – 100k | `(reference_doctype, reference_name)`, `(user, creation)`, `action`, `creation` | no |
| 20 | `WhatsApp Notification` | — | `field:notification_name` | `document_type`→DocType, `template`→Template, `device`, `print_format` | 10s | `(document_type, event, enabled)` | yes |
| 21 | `WhatsApp Notification Recipient` | Notification (child) | — | — | ≤ 5 per notification | — | — |
| 22 | `WhatsApp Notification Alert` | — | `field:alert_name` | `report`→Report, `template`→Template, `device`, `print_format`, `letter_head` | 10s | `(enabled, next_run_at)` | yes |
| 23 | `WhatsApp Notification Alert Recipient` | Alert (child) | — | `user`→User, `role`→Role | ≤ 20 per alert | — | — |
| 24 | `WhatsApp Webhook Event` | — | `hash` | `device`, `inbound_message`, `outbound_message` | ≈ 3 × outbound + inbound; purged after `webhook_event_retention_days` (default 30) | `event_id` (unique), `(event_name, received_at)`, `status`, `received_at` | no |

Naming rationale: `hash` for every high-volume/system-written table — `naming_series` serialises on
the `tabSeries` row and would throttle campaign bulk inserts (F9). `field:` naming where the user-facing
key is the identity (template, group, command, function key, E.164 number).

### 4. Create new — field sketches (only what the next phase needs to fix the shape)

| DocType | Fields (fieldtype) — `status` options in **bold** |
|---|---|
| `WhatsApp Settings` | **Provider**: `provider` (Select from `whatsapp_providers` hook, default `snd_platform`), `platform_base_url`, `request_timeout`. **Credentials (Password, SM-only)**: `customer_api_key`, `api_key`, `api_secret`, `webhook_secret` (D-013/D-020). **Webhook**: `webhook_endpoint` (platform docname), `webhook_endpoint_url`, `webhook_status` (**Active/Disabled/Locked/Revoked**, mirror of D-018), `webhook_synced_at`, `webhook_last_event_at`. **Queue**: `messages_per_minute` (5–60), `max_attempts`, `retry_backoff_seconds`, `queue_paused` (Check, system), `queue_paused_by`, `queue_paused_at`, `queue_pause_reason`. **Commands**: `enable_commands`, `command_service_user` (Link User, D-012), `unknown_command_reply`, `send_receipt_reply`, `receipt_reply`, `reply_device`. **Policy**: `default_country` (E.164 region), `global_blacklist_group`, `send_only_to_known_numbers` (Check — prototype "no inbound" policy). **Picker**: `picker_sources` (Table → #2). **Retention (days)**: `outbound_retention_days`, `inbound_retention_days`, `queue_retention_days`, `webhook_event_retention_days`, `audit_retention_days`. **System-written cache**: `numbers_watermark` (Datetime, §5.2), `plan_name`, `message_limit`, `messages_used`, `messages_remaining`, `wallet_balance`, `wallet_currency`, `subscription_start`, `subscription_end`, `subscription_synced_at`. **Onboarding**: `setup_completed`, `redirect_unregistered_to_wizard` (Check, default 0 — spec #1 "enable last") |
| `WhatsApp Settings Picker Source` | `document_type` (Link DocType), `label`, `phone_fieldname`, `name_fieldname`, `enabled` |
| `WhatsApp Device` | `device_name`, `phone`, `phone_e164`, `platform_device` (Data, unique), `wa_device_id`, `status` (**Pending QR/Connected/Disconnected/Logged Out**), `is_default`, `disabled`, `last_seen`, `connected_at`, `disconnected_at`, `webhook_registered` (Check), `last_error` (Small Text). **Not stored**: token, QR payload, pair code (served to the page from a 60 s cache) |
| `WhatsApp Log` | `device`, `phone`, `phone_e164`, `jid`, `recipient_type` (**Individual/Group**), `display_name`, `contact`, `message_type` (**Text/Document/Image/Video/Audio/Sticker/Location/Poll/Template**), `body` (Text), `caption`, `attachment` (Attach), `file_name`, `print_format`, `letter_head`, `language`, `location_*`, `poll_question`, `poll_options` (JSON), `poll_id`, `status` (**Unsent/Queued/Sending/Sent/Delivered/Read/Failed/Cancelled/Held**), `scheduled_at`, `queued_at`, `sent_at`, `delivered_at`, `read_at`, `failed_at`, `error_code` (Data — prototype codes `recipient_not_registered`, `device_disconnected`, `timeout`, `platform_rejected`, `invalid_template`, `insufficient_balance`), `error_message` (Small Text, no PII), `attempts`, `source_type` (**Quick Send/Form/Campaign/Notification/Notification Alert/Command Reply/Simulator/API**), `reference_doctype`+`reference_name`, `campaign`, `campaign_recipient` (row name), `template`, `notification`, `command`, `trigger_inbound`, `queue_item`, `provider`, `provider_message_id`, `platform_queue_id`, `platform_message_log`, `device_fallback` (Check, PR-03), `is_test`, `is_simulated` |
| `WhatsApp Inbound Message` | `device`, `phone`, `phone_e164`, `jid`, `chat_jid`, `sender_jid`, `is_group`, `display_name`, `contact`, `message_type`, `body`, `caption`, `media_url`, `attachment`, `location_*`, `reaction`, `quoted_provider_message_id`, `provider_message_id`, `received_at`, `webhook_event`, `command_status` (**None/Matched/Executed/Failed/Not Matched/Blocked**), `command`, `command_text`, `reply_outbound`, `is_simulated` |
| `WhatsApp Queue Item` | `outbound_message`, `device`, `phone_e164`, `campaign`, `priority` (Int), `scheduled_at`, `status` (**Queued/Sending/Paused/Deleted/Completed/Dead Letter**), `attempts`, `max_attempts`, `next_attempt_at`, `last_error`, `job_id`, `claimed_at`, `batch_id`, `client_ref` (= outbound name), `platform_queue_id`, `held_reason`, `paused_by`, `paused_at`, `pause_reason`, `deleted_by`, `deleted_at`, `delete_reason`, `dead_letter_reason`, `completed_at` |
| `WhatsApp Campaign` | `campaign_name`, `status` (**Draft/Scheduled/Queued/Running/Paused/Completed/Partially Failed/Cancelled**), `device`, `scheduled_at`, `messages_per_minute`, `started_at`, `ended_at`, `total_recipients`, `queued_count`, `sent_count`, `delivered_count`, `read_count`, `failed_count`, `cancelled_count`, `messages` (Table → #8), `recipients` (Table → #9), `last_batch_started_at` |
| `WhatsApp Campaign Message` | `message_type`, `template`, `body`, `attachment`, `print_format`, `caption`, `delay_seconds` |
| `WhatsApp Campaign Recipient` | `phone`, `phone_e164`, `display_name`, `contact`, `source_type` (**Contact Group/Contact/DocType/Excel/vCard/Manual**), `source_doctype`, `source_name`, `status` (**Pending/Queued/Sent/Delivered/Read/Failed/Cancelled/Removed**), `outbound_message`, `error_code` |
| `WhatsApp Template` | `template_name`, `category`, `message_type` (**Text/Document/Image**), `body` (Code, Jinja), `attachment`, `print_format`, `letter_head`, `file_name_template`, `reference_doctype` (variable hints), `language`, `disabled`, `use_count` (system), `last_used_at` (system) |
| `WhatsApp Number` | `phone_e164` (unique), `jid`, `number_type` (**Individual/Group/LID**), `display_name`, `first_seen`, `last_seen`, `outbound_count`, `inbound_count`, `last_direction` (**Outbound/Inbound**), `last_device`, `contact`, `link_status` (**Linked/Not Linked**, first list column, colour indicator), `conversation_confirmed` (Check, manual override for the "known number" policy) |
| `WhatsApp Contact Group` | `group_name`, `kind` (**Marketing/Mailing List/Professional/Blacklist/Other**), `description`, `source` (**Manual/Import/Picker**), `member_count` (system), `disabled`, `members` (Table → #13) |
| `WhatsApp Contact Group Member` | `phone`, `phone_e164`, `display_name`, `contact`, `source_type`, `source_doctype`, `source_name`, `added_on` |
| `WhatsApp Command` | `code`, `title`, `function`, `status` (**Active/Inactive**), `synonyms` (Small Text, one per line, validated unique across commands), `requires_linked_contact` (Check), `allowed_party_types` (Table MultiSelect → #15), `allowed_group`, `blocked_group`, `reply_device`, `settings_overrides` (JSON, keys limited to the Function's settings), `outputs` (Table → same shape as #18, copied from Function; "restore defaults" re-copies), `run_count`, `last_run_at` |
| `WhatsApp Command Party Type` | `party_type` (**Customer/Supplier/Employee/Sales Person/User**) |
| `WhatsApp Function` | `function_key`, `function_name`, `category`, `description`, `when_to_use`, `party_types`, `status` (**Active/Inactive**), `installed_version`, `installed_at`, `latest_version` (cache), `latest_version_date`, `catalog_source`, `manifest` (JSON snapshot: inputs, outputs, example, suggested_commands, changelog), `checksum`, `settings` (Table → #17), `outputs` (Table → #18), `call_count`, `last_called_at`, `avg_ms` |
| `WhatsApp Function Setting` | `key`, `label`, `fieldtype` (**Check/Int/Data/Select**), `choices`, `default_value`, `value`, `notes` |
| `WhatsApp Function Output` | `output_key`, `label`, `output_type` (**Text/Document**), `default_template`, `template` (Jinja), `condition`, `print_format`, `file_name_template` |
| `WhatsApp Audit Log` | `action` (**Device Created/Connected/Disconnected/Deleted · Credentials Changed · Settings Changed · Queue Paused/Resumed · Queue Items Deleted · Campaign Started/Paused/Resumed/Cancelled · Bulk Send · Elevated Contact Read/Write · Number Linked/Converted · Function Installed/Updated/Removed · Command Changed/Defaults Restored · Retention Purge**), `user`, `timestamp`, `reference_doctype`+`reference_name`, `target_doctype`+`target_name`, `fields_written` (Small Text — fieldnames only, no values), `reason`, `count` (Int, for bulk), `ip_address`, `details` (JSON, no PII) |
| `WhatsApp Notification` | `notification_name`, `enabled`, `document_type`, `event` (**New/Save/Submit/Cancel/Days Before/Days After/Minutes Before/Minutes After/Value Change/Method**), `date_changed`, `days_in_advance`, `minutes_offset`, `value_changed`, `method`, `condition` (Code), `device`, `template` (Link, body source), `message` (fallback Jinja when no template), `message_type`, `attach_print`, `print_format`, `letter_head`, `set_property_after_alert`, `property_value`, `recipients` (Table → #21), `send_count`, `last_sent_at` |
| `WhatsApp Notification Recipient` | `receiver_by_document_field`, `linked_document_field`, `linked_mobile_fieldname`, `cc_numbers` (Small Text), `condition` |
| `WhatsApp Notification Alert` | `alert_name`, `enabled`, `periodicity` (**Daily/Weekly/Monthly/Quarterly/Yearly**), `day_of_week`, `day_of_month`, `notification_time`, `content_type` (**Report/Static Message**), `report`, `filters_json`, `dynamic_filters_json`, `template`, `message`, `attachment_format` (**None/PDF/PNG**), `print_format`, `letter_head`, `device`, `recipients` (Table → #23), `last_sent_at`, `next_run_at` |
| `WhatsApp Notification Alert Recipient` | `recipient_type` (**User/Role/Phone/Report Column**), `user`, `role`, `phone`, `phone_e164`, `report_column` |
| `WhatsApp Webhook Event` | `event_id` (unique), `event_name`, `received_at`, `event_timestamp` (from `X-SND-Timestamp`), `signature_valid` (Check), `timestamp_fresh` (Check), `device`, `platform_device`, `payload` (JSON, PII → retention), `status` (**Received/Processed/Ignored/Duplicate/Failed**), `error`, `processed_at`, `inbound_message`, `outbound_message` |

### 5. Queue Item ↔ Outbound Message — recommendation

**Recommendation: separate table, 1:1, Queue Item is the dispatcher's row; Outbound is the message
of record.** This follows spec §5.1 ("a real DocType driven by status") and the architecture rule
("dead-letter state on the Queue DocType").

| Aspect | Separate `WhatsApp Queue Item` (recommended) | Same row: Outbound + status filter (alternative, OQ-1) |
|---|---|---|
| Dispatcher hot path | Small table (only live rows), narrow index `(status, scheduled_at, priority)`, `SELECT … FOR UPDATE SKIP LOCKED` claim on few rows | Claim scans a table that grows to millions; every index carries history |
| Retention | Queue rows purged after N days without touching history | Cannot purge without losing history |
| "Deleted is a state" | `Deleted` on the queue row; Outbound gets `Cancelled` — history stays clean | One status field must serve both queue and delivery vocabularies |
| Pause / resume / dead-letter | Native fields (`paused_by`, `pause_reason`, `dead_letter_reason`) | Would pollute the message record |
| Cost | Two status fields to keep coherent | None |
| Mitigation | **Only** `services/dispatch.py` writes either status; Outbound `status` is derived from Queue Item transitions + webhooks; nightly reconcile job asserts coherence | — |

Lifecycle: Outbound `Unsent` → Queue Item created (`Queued`, `scheduled_at`) → `Sending` (claimed,
batch `enqueue_messages_api`) → `Completed` on platform accept (Outbound `Sent`… via webhooks) ·
`Paused` ↔ `Queued` · `Deleted` (Outbound `Cancelled`) · `Dead Letter` after `max_attempts` (Outbound
`Failed`). Global pause (prototype: "paused by X since T, reason") = `WhatsApp Settings.queue_paused*`
gate checked by the dispatcher; row-level `Paused` = campaign or bulk pause.

### 6. Permission matrix

| DocType | SM | MGR | AGT | VWR | CU | Notes |
|---|---|---|---|---|---|---|
| `WhatsApp Settings` | R W | R | — | — | — | D-014. System-written fields (`queue_paused*`, cache, watermark) via services with role check + audit |
| `WhatsApp Device` | C R W D E | C R W D E | R | R | — | Create/delete only through Devices page API (platform call first) |
| `WhatsApp Log` | R E P | R E P | R | R | — | **No C/W/D for any role** (spec: create not allowed; system-written). Retention job purges with `ignore_permissions` |
| `WhatsApp Inbound Message` | R E P | R E P | R | R | — | Same as Outbound |
| `WhatsApp Queue Item` | R E | R E | R | R | — | **No C/W/D for any role.** Pause/resume/delete = whitelisted actions requiring MGR + audit |
| `WhatsApp Campaign` (+children) | C R W D E | C R W D E | R | R | — | Start/pause/cancel = doc actions requiring MGR |
| `WhatsApp Template` | C R W D E | C R W D E | R | R | — | Quick Send by AGT reads templates |
| `WhatsApp Number` | R E | R E | R E | R | R | **No C/W/D for any role, SM included** (spec §5.2). Link/convert = one whitelisted function (checks `Contact` create for MGR/AGT, or CU via §4) |
| `WhatsApp Contact Group` (+Member) | C R W D E | C R W D E | C R W | R | C R W | CU manages groups from the Contacts page; write scope via §4 (owner or all — OQ-6) |
| `WhatsApp Command` (+child) | C R W D E | C R W D E | R | R | — | Modal-only create is UI; validate blocks edit while `Active` |
| `WhatsApp Function` (+children) | R W | R W | R | R | — | **No create/delete via Desk**; install/remove through Functions Center API (MGR) + audit |
| `WhatsApp Audit Log` | R E | R E | — | — | — | **No C/W/D for any role**; `services/audit.py` inserts under the real user |
| `WhatsApp Notification` (+child) | C R W D E | C R W D E | R | R | — | |
| `WhatsApp Notification Alert` (+child) | C R W D E | C R W D E | R | R | — | |
| `WhatsApp Webhook Event` | R | R | — | — | — | Payload is PII; no export; system-written |

`Administrator` bypasses all of this by design; document it, do not fight it. Every DocType with a
`device` field keeps `ignore_user_permissions = 0` so per-device isolation can be switched on with
User Permissions without schema change.

### 7. Roles

| Role | Purpose | Desk access | Fixture |
|---|---|---|---|
| `WhatsApp Manager` | Owns the product: settings (read), devices, campaigns, queue actions, templates, commands, functions | `desk_access = 1` | `fixtures/role.json` |
| `WhatsApp Agent` | Sends: Quick Send, Simulator, reads monitoring lists, manages groups | 1 | idem |
| `WhatsApp Viewer` | Read-only monitoring (Outbound/Inbound/Queue/Campaigns/Numbers) | 1 | idem |
| `WhatsApp Contact User` | Contextual role (§4): **zero rows on `Contact`**; Contacts page + Numbers link/convert + ContactPicker source 3 through scoped whitelisted functions | 1 | idem |
| *(no new role)* Command service user | D-012: a `User` record referenced by `Settings.command_service_user`; the site admin grants it the read roles the installed functions need. Handlers run under `frappe.set_user(service_user)`; never Administrator | — | seeded disabled by `after_install` (OQ-4) |

### 8. Custom fields on core DocTypes

None required for the spec. One candidate, deferred to OQ-5:

| Field | On | Type | Why | Fixture |
|---|---|---|---|---|
| `wa_phone_e164` | `Contact Phone` (child) | Data, hidden, indexed | Auto-linking inbound numbers to existing Contacts and picker source 2 duplicate flags need an **indexed normalized** phone; without it every match is a full scan + normalize in Python. Maintained by a `Contact` `validate` hook | `fixtures/custom_field.json` |

Rejected: `wa_opt_out` on `Contact` (covered by Contact Group kind `Blacklist` + `Settings.global_blacklist_group`).

---

## Findings

| # | Finding | Evidence | Consequence |
|---|---|---|---|
| F-01 | The prototype's Queue is a **filtered view of outbound rows** (`messages.filter(direction out && status in queued/unsent)`) with a **global** pause (`pausedBy`, `pausedSince`, `reason`), a rate slider, and per-row/bulk **cancel** that flips the message to `cancelled` | `Hub Screen - Queue.dc.html:108-117`, `hub-data.global.js:713` | Global pause lives on Settings (system-written), not on rows; row `Paused` is for campaign/bulk pause; "Deleted" maps to Outbound `Cancelled`. Spec's separate DocType kept (§5 above) |
| F-02 | The prototype has a **"Notification Templates" screen** (doc type + send condition + device + body + status) and a separate "Message Templates" screen | `docs/screen/Hub Screen - Notification Templates.dc.html:123-167`, `hub-data.global.js:54,246` | D-016 placement resolved for `WhatsApp Notification`: Frappe list + form under Templates (10) as a second list. `WhatsApp Notification Alert` has **no prototype screen** (OQ-3) |
| F-03 | Functions carry per-install **settings with defaults**, **message outputs** (text/document templates with conditions), inputs/outputs tokens, example, suggested commands and a **changelog**; Commands carry `synonyms`, `allowedTypes`, `requiresLink`, and inherit outputs ("restore defaults") | `hub-data.global.js:252-341, 607-624` | Function needs two children (Setting, Output) + a manifest JSON; Command copies Output rows and holds `settings_overrides` |
| F-04 | Prototype Contact Groups include a **`Blacklist` kind** ("blocked from all commands and campaigns") | `hub-data.global.js:51` | Legacy whitelist/blacklist child tables collapse into Contact Group links on Settings and Command |
| F-05 | WhatsApp Numbers in the prototype include **group JIDs** (`…@g.us`) and platform `sender_jid` may be `@lid` | `hub-data.global.js:725`, D-023 | `WhatsApp Number.name` = E.164 for individuals, JID for groups/LIDs; `number_type` field; E.164 service must pass JIDs through untouched |
| F-06 | Simulator records "message on behalf" in Inbound **and** Outbound without a real send; sandbox sends are flagged | `Hub Screen - WhatsApp Simulator.dc.html:174`, `hub-data.global.js:678` | `is_simulated` on both message tables; `is_test` on Outbound (real send via `send_message_api`, D-024) |
| F-07 | Outbound rows are linked to their **trigger**: inbound message (reply), command, campaign, template, reference document (type/no/amount) | `hub-data.global.js:647-701` | Links on Outbound as listed; `amount` is **not** stored (read from the reference doc in the read layer) |
| F-08 | Every message row must carry `device` to allow per-device User Permission isolation (security rule) | `security.md` baseline | `device` Link on Outbound/Inbound/Queue/Campaign/Number(last_device) |
| F-09 | `WhatsApp Number` cannot be a Link target from messages: the row is created **asynchronously** after the message insert (§5.2) | spec §5.2 | Messages store `phone_e164` (indexed Data); the drawer joins on it in the read layer |
| F-10 | Naming series would serialise campaign bulk inserts | Frappe `tabSeries` update per insert; legacy F9 | `hash` for high-volume tables; `client_ref` = Outbound `name` |
| F-11 | D-011 wording "unified log with direction" vs spec §5.3 "two separate DocTypes" | `decisions.md:17`, spec §5.3 | Read as: unification happens in the read layer (§6.1), which emits `direction`. Confirm (OQ-2) |

## Gaps

| # | Gap (spec item without an obvious home) | Proposed home |
|---|---|---|
| G-01 | Onboarding Wizard (1) sign-up / sign-in / forgot password | No DocType: platform guest signup endpoints + `WhatsApp Settings` credentials; `setup_completed` flag |
| G-02 | Subscription / usage / wallet on Screen 15 and Home | Cache fields on Settings written by the usage-sync scheduler; no ledger table client-side (platform A-01/A-03/A-04 pending) |
| G-03 | Queue rate slider (prototype) | `Settings.messages_per_minute`, bounded by platform plan `messages_per_minute` |
| G-04 | Campaign change log (pause, recipients removed/added, body edited, device changed, rescheduled) | `track_changes` on Campaign + Audit Log actions; no extra table |
| G-05 | Function catalog (storefront) | JSON file per app version (`whatsapp_next/functions/catalog/vN/catalog.json`), no DocType; `WhatsApp Function` holds installed state only |
| G-06 | Device `battery` shown in prototype | Not provided by platform webhooks today; field omitted (OQ-7) |
| G-07 | "Known number" send policy (prototype `noInbound`/`chatManual`) | `Settings.send_only_to_known_numbers` + `WhatsApp Number.conversation_confirmed` |

## Risks

| # | Risk | Mitigation |
|---|---|---|
| R-01 | Child-table recipients/members at 10k rows make the Desk form slow (spec §5.4 mandates a child table) | Render recipients through a paginated component (spec allows it); bulk-insert rows via `frappe.db.bulk_insert`; list-view counters instead of loading the child on form open |
| R-02 | Two status fields (Queue Item, Outbound) drift | Single writer (`services/dispatch.py`), reconcile job, test asserting every transition |
| R-03 | Webhook `payload` JSON and message bodies are PII in three tables | Retention job per table with Settings days; `Webhook Event` no export; Error Log never receives payloads |
| R-04 | `Administrator` and `ignore_permissions` writes on "system-only" tables lose attribution | `services/audit.py` records `frappe.session.user` for every elevated write; system jobs record the job name as `user` context in `details` |
| R-05 | `hash` names are opaque in lists | List views show `phone_e164`/`display_name`/`campaign_name` as title fields (`title_field`, `show_title_field_in_link`) |
| R-06 | Arabic `field:` names for Template/Group/Command produce long URL-encoded names | Acceptable (Frappe supports it); `title_field` set; renaming allowed (`allow_rename = 1`) |

## Recommendations

| # | Recommendation |
|---|---|
| RC-01 | Build DocTypes in this order: Settings + Picker Source → Device → Template → Outbound → Inbound → Webhook Event → Queue Item → Number → Audit Log → Contact Group (+Member) → Campaign (+2 children) → Function (+2) → Command (+1) → Notification (+1) → Notification Alert (+1). Each with a `test_<doctype>.py` covering permissions per role |
| RC-02 | Enforce "system-only" with **no roles holding C/W/D** rather than `read_only` flags; services write with `ignore_permissions=True` after an explicit role check and an audit row |
| RC-03 | `WhatsApp Number` list view: `link_status` first column with indicator, then `display_name`, `phone_e164`, counters, `last_seen`; `WhatsApp Queue Item` list view: position, contact, status, device, ETA — both via `public/js/listview/` |
| RC-04 | Register `doc_events["*"]` for Notification only for `validate/on_update/on_submit/on_cancel/after_insert/on_change`; cache active notifications per DocType in `frappe.cache` invalidated on Notification save |
| RC-05 | Keep the platform `client_ref` = Outbound `name`; store `batch_id` on Queue Item; reconcile job keys on both |

## Open questions

| # | Question | Blocks | Proposed default |
|---|---|---|---|
| OQ-1 | Confirm **separate `WhatsApp Queue Item`** (recommended) over "same row: Outbound with status + list filter". Evidence for OD-1 (Virtual DocType filtering) is still due at Gate 1 but does not change this recommendation | Queue (9), dispatch design | Separate table |
| OQ-2 | D-011 "unified log with direction": confirm it means unification in the read layer, not one physical table | Outbound/Inbound schemas | Read layer |
| OQ-3 | `WhatsApp Notification Alert` UI placement — no prototype screen. Same list pattern as Notification Templates under Templates (10), or a section on Settings (15)? | Phase 2 UI plan | Second list under Templates |
| OQ-4 | Command service user (D-012): seed a disabled `wa-commands@<site>` user on install, or leave creation to the owner? Which roles may it hold by default? | Commands (8) | Seed disabled; roles empty; Settings validation refuses Administrator/System Manager users |
| OQ-5 | Add `Contact Phone.wa_phone_e164` custom field (indexed) for auto-linking inbound numbers to Contacts? Alternative: link only manually via the Numbers action | Numbers (13), picker source 2 | Add it (only custom field) |
| OQ-6 | `WhatsApp Contact User` on Contact Groups: full CRUD on all groups, or only groups they own? | §4 layer | All groups (groups are product data, not core data) |
| OQ-7 | Device `battery`/`last_seen` from the platform: request an additive field on `connection.*` webhooks or drop from the Devices screen? | Devices (3) | Drop `battery`; keep `last_seen` from `list_devices_api` |
| OQ-8 | Queue Item terminal state name for successful handover — `Completed` (proposed) — and whether rows are kept `queue_retention_days` (proposed 7) or removed immediately after handover | Queue (9) | `Completed`, 7 days |
| OQ-9 | Notification body location: `template` Link mandatory (F13 fix) vs inline `message` (prototype edits body inline)? | Notification Templates screen | Both: Link preferred, inline fallback |

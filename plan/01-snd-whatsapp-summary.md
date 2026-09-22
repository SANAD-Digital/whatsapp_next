# 01 — Legacy app summary: `snd_whatsapp`

Source: `/home/snd/frappe-bench/apps/snd_whatsapp` (branch `redesgin-integration-ui`, working tree has ~29 uncommitted changes — see R-001 markers below). Static read only; nothing executed.

## Purpose

ERPNext-side client for the SANAD WhatsApp platform (`snd_whatsapp_platform`). It (1) creates outgoing messages as `WhatsApp Log` rows from document events, forms, a chat page, a manual page, campaigns and an inbound "command" engine; (2) hands batches to the platform over HTTP and tracks delivery via signed webhooks plus a reconcile job; (3) stores inbound events in five webhook-log DocTypes; (4) manages devices/credentials through a settings Single and three overlapping admin pages.

## Inventory

### Modules / packages

| Path (under `snd_whatsapp/`) | Role |
|---|---|
| `hooks.py` | doc_events, 5 scheduler jobs, 2 global JS includes, log-clearing defaults |
| `snd_whatsapp/api/whatsapp_webhook.py` | Guest webhook receiver, signature check, event routing, status updates, device sync |
| `snd_whatsapp/api/webhook_logs.py` | Builds and dedupes the 5 webhook log DocTypes |
| `snd_whatsapp/api/form_whatsapp.py` | "Send WhatsApp" from any form (`send_from_form`) |
| `snd_whatsapp/doctype/whatsapp_log/` | Queue row + claim/flush/send/reconcile pipeline (1,370 lines) |
| `snd_whatsapp/doctype/whatsapp_notification/` | Fork of core `Notification` for doc-event WhatsApp templates |
| `snd_whatsapp/doctype/whatsapp_notification_alert/` | Report-digest scheduler (1,550 lines, own PDF builder) |
| `snd_whatsapp/doctype/whatsapp_campaign/` | Bulk send: recipient sources, rate limit, poll results |
| `snd_whatsapp/doctype/whatsapp_command/`, `whatsapp_api/` | Inbound command engine + executable "API" definitions |
| `snd_whatsapp/doctype/whatsapp_device/` | Device doc + platform create/QR/pair-code/groups |
| `snd_whatsapp/doctype/whatsapp_platform_settings/` | Single: URL, credentials, webhook secret, command-engine switches |
| `snd_whatsapp/doctype/whatsapp_platform_contact|group/` | Cached device directory (contacts/groups) |
| `snd_whatsapp/doctype/whatsapp_webhook_*_log/` (5) | Received / Status / Connection / Group / Reaction logs |
| `snd_whatsapp/page/whatsapp_platform_integration/` | The HTTP layer (`_call_platform_method`) + admin console backend (1,210 lines) |
| `snd_whatsapp/page/whatsapp_integration/`, `page/new_desgin/` | Two more UIs over the same backend (2,200+ / 1,800+ lines JS) |
| `snd_whatsapp/page/whatsapp_chat/`, `manual_whatsapp_message/`, `whatsapp_commands/`, `whatsapp_apis/` | Chat, manual compose, command console, function library |
| `snd_whatsapp/utils/{permissions,error_handler,files}.py` | Role guards, error shaping (Arabic strings hardcoded), File bytes helper |
| `snd_pdf.py` | WeasyPrint print-format renderer (`get_print_html`, `download_pdf`) |
| `platform_api_examples.py` | Legacy `/api/v1` `PlatformApiClient` (device-token direct API) — only the chat page uses it |
| `snd_whatsapp/whatsapp_campaign.py|.js` (module root) | Stray duplicate of the campaign controller; unreferenced |
| `patches/v1_0/` | rename DocTypes (case), backfill `recipient_source_type`, fetch webhook secret |

### DocTypes and key fields

| DocType | Naming | Key fields | Perms (roles) |
|---|---|---|---|
| WhatsApp Log | hash | `reference_type/name` (Dynamic Link), `whatsapp_notification`, `mobile_no`, `cc`, `direction` (Outgoing/Incoming), `external_message_id`, `platform_queue_id`, `client_id`→Device, `message`, `whatsapp_message_type` (Text/Document/Image/Video/Audio/Sticker/Location/Poll/Authentication), `status` (Send/Not Send/Queued/Sending/Error/Received/Delivered/Read), `priority`, `send_now`, `file_url`, `print_format`, `letter_head`, `no_letter_head`, `language`, `re_create_pdf`, `save_generated_attachment_to_document`, `generated_attachment_is_private`, `error_message`, location_*, poll_*, `is_whatsapp_command`, `data`, `create_pdf_from_data` | SM read/export/print; WhatsApp Manager read/export. **No create/write for anyone** (system-written) |
| WhatsApp Device | `WTDS.#####` | `client_name`, `sanad_selected_device_id` (platform docname), `sanad_access_token` (Small Text, hidden), `sanad_token_expires_at`, `status`, `connection_status` (Connected/Disconnected), `qr_code_data` (Text), `pair_code` (Data, in list view), `default`, `authenticated_on`, `last_message_received_on` | SM, WhatsApp Manager, WhatsApp Connecter, WhatsApp Group Viewer, WhatsApp Sender |
| WhatsApp Platform Settings | Single | `platform_base_url`, `api_prefix`, `request_timeout`, `customer_api_key` (Data), `api_key` (Data), `api_secret` (Password), `webhook_endpoint`, `webhook_endpoint_url`, `webhook_secret` (Password), `webhook_synced_at`; command tab: `enable_whatsapp_command`, `enable_receipt_reply`, `receipt_reply`, `not_find_whatsapp_command_reply`, `reply_device`, `whitelist_contact`/`blacklist_contact` tables | SM crw; **WhatsApp Manager rw** |
| WhatsApp Notification (+ Recipient child) | subject | `document_type`, `event` (New/Save/Submit/Cancel/Days Before/After/Minutes Before/After/Value Change/Method/Custom), `condition`/`filters`, `message` (Jinja), `whatsapp_message_type`, `attach_print`/`print_format`/`attach_files`, `send_now`, `set_property_after_alert`, recipients: `receiver_by_document_field`, `linked_document_field`+`linked_mobile_fieldname`, `cc`, `condition` | SM, WhatsApp Manager |
| WhatsApp Notification Alert (+ Role/User/Recipient children) | — | `periodicity`, `notification_time`, `chart_type` (Report/Static Message), `report_name`, `filters_json`, `dynamic_filters_json`, `recipient` (Users/Roles/CC/Report Column), `print_format`, `letter_head`, `whatsapp_device`, `last_notification_date` | SM, WhatsApp Manager |
| WhatsApp Campaign (+ Recipient child) | naming_series | `device`, `status` (Draft/Scheduled/Queued/Running/Completed/Partially Failed/Failed/Cancelled), `recipient_source_type` (Manual Numbers/Import File/Recipient DocType/Device Contacts/Device Groups), `manual_numbers`, `recipient_import_file`, `document_type`+`condition_type`+`condition`/`filters`+`recipient_rules`, `message_type`, `message`, `attachment`, poll_*, `messages_per_minute` (1–60), `scheduled_at`, counters, `last_batch_started_at`; recipient row: `recipient`, `recipient_type`, `recipient_name`, `source_doctype/name`, `status`, `whatsapp_log`, `poll_id`, `poll_selected_options`, `poll_result` | SM, WhatsApp Manager |
| WhatsApp Command (+ Command API, Whitelist/Blacklist Contact children) | title | `code` (unique, casefolded), `disabled`, `whatsapp_command_apis`, contact lists (`contact`→Contact, `mobile_id`) | **SM only** |
| WhatsApp API | — | `subject`, `method` (dotted path, executed), `filters` (JSON/Jinja), `reply_type` (Text/Document), `reply_template`, `receipt_reply`, `print_format`, `letter_head`, `registry_key`, `installed_version` | **SM only** |
| WhatsApp Platform Contact / Group | — | `device`, `contact_name`/`group_name`, `phone`/`group_id`, `jid`, `participants_count`, `raw_data` | **SM only** (pages bypass with role checks + raw SQL) |
| WhatsApp Webhook Message Received Log | `WWMRL-.YYYY.-.#####` | `event_id` (dedupe), `event_type`, `received_at`, `platform_device`, `device`→Device, `message_id`, `message_type`, `from_jid`, `sender_jid`, `sender_number`, `chat_jid`, `participant_jid`, `message_body`, `media_url`, `whatsapp_log`, `raw_data`, `is_whatsapp_command`, `command_status` | SM, WhatsApp Manager |
| Status / Connection / Group / Reaction Log | — | same base (`event_id`, `event_type`, `received_at`, `platform_device`, `device`, `raw_data`) + `status`/`connection_status`/`group_jid`/`reaction` | SM, WhatsApp Manager |

### Whitelisted APIs

| Module | Function (signature) | Guard | Purpose / callers |
|---|---|---|---|
| api.whatsapp_webhook | `receive()` | `allow_guest`, `rate_limit(600/60s POST)`, HMAC | Platform webhooks. Caller: platform |
| api.form_whatsapp | `send_from_form(doctype, name, mobile_no, message, whatsapp_device, cc, bcc, attachments, send_me_a_copy, send_read_receipt, print_format, print_language, letter_head, no_letter_head)` | role WhatsApp Sender + doc read (+print) | `form_whatsapp_timeline.js` dialog on every form |
| doctype.whatsapp_log | `WhatsAppLog.send_notification_now()` (doc method) | WhatsApp Sender | Log form "Send Notification" button; sends inline |
| doctype.whatsapp_notification | `preview_meets_condition/preview_message/preview_subject(preview_document)`, `get_documents_for_today(notification)` | doc read | Notification form |
| doctype.whatsapp_notification_alert | `get_dynamic_filter_reference()`, `get_report_recipient_field_options(report_name, …)`, `process_dynamic_filters(dynamic_filters)`, `get_users(roles, except_users, users)`, `get_now_time()`, doc methods `fetch_data_and_show_message/fetch_data_and_send_message(report_name, …)` | mixed (`require_*` used inside) | Alert form buttons |
| doctype.whatsapp_device | `create_platform_device_for_doc(docname)`, `get_qr_via_server(instance_id, docname)`, `get_pair_code_via_server(…)`, `get_groups_via_server(…)`, doc `create_on_platform()` | Connecter / Group Viewer (+Manager) | Device form buttons |
| doctype.whatsapp_campaign | `resolve_campaign_recipients`, `load_manual_recipients`, `import_recipient_file`, `load_cached_recipients(campaign_name, recipient_type)`, `queue_campaign(campaign_name, send_now)`, `cancel_campaign`, `refresh_campaign_status`, `get_campaign_poll_results(campaign_name, refresh_results)` | `check_permission("write"/"read")` | Campaign form |
| page.whatsapp_platform_integration | `get_page_data`, `get_dashboard`, `get_device_statuses`, `save_settings(...)`, `create_device`, `request_device_qr`, `request_device_pair_code`, `get_device_directory_page(kind, device, search, page, page_length)`, `list_device_contacts`, `list_device_groups`, `verify_device_connection`, `disconnect_device`, `delete_device(device, delete_local)`, `send_test_message`, `create_webhook_endpoint`, `sync_webhook_secret(endpoint_url, rotate)`, `delete_webhook_event_endpoint`, `test_webhook_endpoint`, `delete_webhook_endpoint` | WhatsApp Manager; SM for `save_settings`, webhook create/delete/sync | 3 admin pages + Settings form button |
| page.whatsapp_chat | `get_bootstrap(client_id)`, `get_messages(chat_id, limit, client_id, chat_jid)`, `send_message(chat_id, message, client_id, file_url, whatsapp_message_type)`, `resend_message(log_name)` | Log read / WhatsApp Sender | Chat page |
| page.manual_whatsapp_message | `get_compose_context()`, `search_recipients(query, device, limit, kinds)`, `get_contact_mobile(contact)`, `send_manual_message(**kwargs)` | WhatsApp Sender (+ `get_list` perms) | Manual page |
| page.whatsapp_apis | `get_library`, `install_api(key, version)`, `update_api`, `rollback_api`, `uninstall_api`, `detach_api(name)`, `save_api(payload)`, `delete_api(name)`, `get_version(key, version)` | WhatsApp Manager | Function library page |
| page.whatsapp_commands | `get_console`, `save_settings(payload)`, `save_command(payload)`, `toggle_command(name, disabled)`, `delete_command(name)`, `save_api(payload)`, `delete_api(name)`, `test_command(text, sender, device)` | WhatsApp Manager | Commands console |
| snd_pdf | `download_pdf(doctype, name, print_format, letterhead, no_letterhead)` | doc print | not wired to UI in this app |

### Pages and client scripts

| Route | Title | Backend | Notes |
|---|---|---|---|
| `whatsapp-platform-integration` | WhatsApp Platform Integration | own module | Primary admin console (settings, devices, directory, webhooks, test send) |
| `whatsapp-integration` | WhatsApp Integration | reuses above | Older duplicate UI |
| `new-desgin` | WhatsApp Console | reuses above | Redesign prototype (matches branch name) — R-001 |
| `manual-whatsapp-message` | Manual WhatsApp Message | own | Compose to Contact / WA contact / group / typed number |
| `whatsapp-chat` | Whatsapp Chat | own | Sidebar from Log scan + Contact + (dead) direct API |
| `whatsapp-commands` | WhatsApp Commands | own | Engine switch, commands, APIs, dry run |
| `whatsapp-apis` | WhatsApp API Library | own | Catalogue from `<app>/whatsapp_command/vN/apis.json` |
| `public/js/form_whatsapp_timeline.js` | — | `send_from_form` | Injects "Send WhatsApp" dialog into every desk form for WhatsApp Sender |
| `public/js/snd_whatsapp_errors.js` | — | — | Client error shaping |
| Workspace `WhatsApp` | — | — | Links: platform page, manual page, Notification, Alert, Device, Settings, Log + 4 status shortcuts; 6 number cards on Log status |

### Hooks

| Hook | Value |
|---|---|
| `app_include_js` | errors JS, form timeline JS (global) |
| `doc_events["*"]` | 15 events (incl. `autoname`, `before_naming`, `before_validate`, `onload`) → `run_whatsapp_notifications` |
| `doc_events["WhatsApp Webhook Message Received Log"].after_insert` | `handle_received_message` (command dispatcher) |
| `default_log_clearing_doctypes` | 5 webhook logs (30/90 days); WhatsApp Log deliberately excluded |

### Scheduled jobs

| Cadence | Job | Effect |
|---|---|---|
| daily | `whatsapp_notification.trigger_daily_alerts` | Days Before/After notifications |
| `0/5 * * * *` | `whatsapp_notification.trigger_offset_alerts` | Minutes Before/After notifications |
| `* * * * *` | `whatsapp_campaign.process_campaigns` | Promote Scheduled→Queued; re-enqueue every Queued/Running campaign (dedup job id); `refresh_campaign_status` each |
| `*/10 * * * *` | `whatsapp_log.send_message` | Requeue stuck `Sending` (>30 min, no queue id); pick **10** rows `Queued/Not Send`, `priority<2`, non-campaign; claim; enqueue `send` |
| `*/5 * * * *` | `whatsapp_log.reconcile_platform_queue` | `Sending` + `platform_queue_id` older than 10 min (≤200) → `get_message_status_api` |
| — (not scheduled) | `whatsapp_notification_alert.scheduled_notification` | Report-digest sender exists but is **not in `scheduler_events`** |

### Provider / HTTP calls

Single transport: `whatsapp_platform_integration._call_platform_method(endpoint, method, params, body, auth_mode)` → synchronous `requests.request`, timeout from Settings (default 30 s). Headers: `X-SND-API-Key` (customer key), `Authorization: token api_key:api_secret`, optional `X-SND-API-Secret`. Response unwrapped from Frappe `message`.

| Platform endpoint (`snd_whatsapp_platform.snd_whatsapp_platform.api.*`) | Called from |
|---|---|
| `enqueue_messages_api` (batch, `client_ref`=log name) | `send_whatsapp_via_platform` |
| `send_message_api` | `send_test_message`, text-only fallback (unused path) |
| `get_message_status_api` (`refs`) | `reconcile_platform_queue` |
| `list_devices_api` | every send batch (`_resolve_platform_device`), dashboards, device resolution |
| `create_device_api`, `get_device_qr_api`, `get_device_pair_code_api`, `verify_device_connection_api`, `disconnect_device_api`, `delete_device_api` | device page/form |
| `list_device_contacts_api`, `list_device_groups_api` (`auth_mode=api_key_secret`) | directory sync (delete+reinsert cache) |
| `get_poll_results_api` | campaign poll results |
| `get_subscription_status`, `get_wallet_balance_api`, `list_message_logs_api` | `get_dashboard` |
| `configure_integration_webhook_api`, `get_integration_webhook_secret_api`, `list_webhook_endpoints_api`, `create/delete/test_webhook_endpoint_api`, `list_available_webhook_events_api` | webhook setup, patch |
| Legacy `/api/v1` direct API (`PlatformApiClient`: list_contacts, list_groups, get_device_chat_messages, regenerate_device_token) | `whatsapp_chat` only; requires the non-existent `Sanad WhatsApp Integration` DocType → always returns `None` |

### Data flow — send → queue → status

| Step | Where | Detail |
|---|---|---|
| 1. Create | `add_notification_log(...)` (not whitelisted) or direct `frappe.get_doc(...).insert` (chat, campaign) | Row status `Not Send` (`Queued` for chat/campaign), `priority=0`, comment added on reference doc |
| 2a. Inline send (`send_now=1`) | `WhatsAppLog.after_insert` → `claim_log_for_sending` → `send([row])` | Runs inside the caller's HTTP request/transaction (form, chat, manual, command reply, Notification with send_now) |
| 2b. Deferred | `send_message` job every 10 min | 10 rows → `claim_and_load` (UPDATE … WHERE status IN pending; `_cursor.rowcount==1` wins) → `frappe.enqueue(send, queue="short", at_front=True)` |
| 2c. Campaign | `execute_campaign` → `_create_log` per recipient → `dispatch_campaign_batch` (≤`messages_per_minute`, filelock) | Excluded from the 10-min flush |
| 3. Prepare | `send()` | Attachment: existing File (base64) / re-render PDF via WeasyPrint `get_print_html` / PDF from `data`; single-page PDF → PNG via PyMuPDF; number normalisation (`00967`, leading `0` strip); `@g.us` if >15 digits else `@c.us`; invalid → `Not Send`, priority+1 |
| 4. Dispatch | `send_whatsapp_via_platform` | `list_devices_api` once per batch, must find a **Connected** device; one `enqueue_messages_api` call with all messages; `accepted` → status stays `Sending` + `platform_queue_id`; `errors`/unmentioned → `Not Send` priority+1; `frappe.db.commit()` |
| 5. Status | webhook `message.sent/delivered/read/failed/held/status` → `_update_message_status` | Match by `client_ref`/`source_docname` (log name) or `external_message_id`; `Send`/`Delivered`/`Read`; `failed` → `Not Send` priority+1 (auto-retry); `held` → error text only; Status Log written |
| 6. Fallback | `reconcile_platform_queue` | Same `_update_message_status` path; `unknown` refs → `Not Send` |
| Retry ceiling | `priority < 2` | After 2 failures a row is silently never retried (campaign marks recipient Failed; plain logs stay `Not Send` forever) |
| Manual | Log "Send Notification" button / chat `resend_message` | Claim with wider status set; dispatch-key in cache prevents double send |

### Data flow — receive

| Step | Detail |
|---|---|
| 1 | `POST /api/method/snd_whatsapp.snd_whatsapp.api.whatsapp_webhook.receive` as Guest; body raw; secret = Settings `webhook_secret` (decrypted) else `site_config.sanad_whatsapp_webhook_secret`; HMAC-SHA256 of body (or `"<X-SND-Timestamp>.<body>"`), header `X-SND-Signature`/`X-Webhook-Signature` |
| 2 | Event from header `X-SND-Event` or payload keys; payload shape guessed across `data/payload/message` |
| 3 | Status events → step 5 above. Connection events → `_update_device_connection`: resolves Device by `sanad_selected_device_id`/name/`client_name`, **creates a WhatsApp Device if none matches**, publishes realtime `sanad_whatsapp_connection_status` (room `all` + global) |
| 4 | Message events: `from_me` ignored; needs device id + chat target; `record_webhook_event` → Received Log (dedupe on `event_id`; `raw_data` keeps the full payload) |
| 5 | `after_insert` → `handle_received_message`: engine enabled, text type, first word = enabled `WhatsApp Command.code` (or "not found" reply configured) → mark row, `enqueue(process_received_message, at_front=True)` |
| 6 | `process_received_message`: `frappe.set_user("Administrator")`; global then per-command black/whitelist (empty whitelist = allow all; match on last 9 digits); `*` → help; `shlex` args → typed filters; receipt reply; per API: render `filters` (Jinja) → `frappe.get_attr(method)(**filters)` → reply text or PDF via `add_notification_log(send_now=True)` |
| Not done | Inbound messages are never written to `WhatsApp Log` (`direction=Incoming` is never set); no Contact/Customer resolution on inbound; no `last_message_received_on` update |

## Findings

| # | Area | Finding | Evidence |
|---|---|---|---|
| F1 | Request path | Sending is synchronous inside the web request and the caller's DB transaction: `after_insert` → `send()` renders PDFs (WeasyPrint), calls `list_devices_api` and `enqueue_messages_api`, and **calls `frappe.db.commit()`** (`_mark_log_failed`, `send_whatsapp_via_platform`, `_delete_generated_attachments`). A `send_now` Notification on `on_submit` commits the business document mid-hook. | `whatsapp_log.py:159-168, 449, 693-698, 1160-1202, 721` |
| F2 | Reliability | `evaluate_alert` re-raises any template/eval error as `frappe.throw` — a broken WhatsApp Notification blocks saving/submitting the underlying ERPNext document. | `whatsapp_notification.py:839-849` |
| F3 | Throughput | Deferred queue drains **10 rows per 10 minutes** (60/hour); campaign path is separate (≤60/min). Rows with `priority>=2` are abandoned silently. | `whatsapp_log.py:384-414`, `_execute_campaign` |
| F4 | Inbound model | Inbound messages live only in `WhatsApp Webhook Message Received Log`; the chat page reads `WhatsApp Log` (outgoing) plus a dead direct-API path, so conversations never show inbound traffic. `direction` field is vestigial. | `whatsapp_chat.py:749-825`, `webhook_logs.py:131-145` |
| F5 | Security | Command engine executes an arbitrary dotted path from `WhatsApp API.method` **as Administrator**, triggered by inbound WhatsApp text, with arguments parsed from that text. A WhatsApp Manager can define the method via the console (`save_api`) even though the DocType is SM-only. Empty whitelist = anyone. | `whatsapp_command.py:127, 266`, `whatsapp_commands.py:342-369`, `whatsapp_api.py:19` |
| F6 | Security | Webhook: `X-SND-Timestamp` is signed but never checked for freshness → replay of an old `message.failed` flips a delivered row to `Not Send` and triggers a resend. Any signed payload with an unknown device id **auto-creates a WhatsApp Device**. | `whatsapp_webhook.py:121-132, 411-417, 499-513` |
| F7 | Secrets | Plain fields: Settings `customer_api_key`, `api_key` (Data); Device `sanad_access_token` (Small Text), `qr_code_data` (Text), `pair_code` (Data, `in_list_view`, readable by Sender/Group Viewer). Only `api_secret`/`webhook_secret` are Password. WhatsApp Manager has **write** on the Settings form, bypassing the SM-only guard on `save_settings` (can redirect `platform_base_url`). | DocType JSONs; `whatsapp_platform_integration.py:877-906` |
| F8 | Permissions | Roles: System Manager, WhatsApp Manager, WhatsApp Sender, WhatsApp Connecter, WhatsApp Group Viewer. Every endpoint re-implements its own guard (`utils/permissions.py`); Log/Contact/Group DocTypes are read via raw SQL + role checks because DocType perms are SM-only. No per-device or per-user scoping anywhere (any reader sees all chats). | `permissions.py`, `_stored_directory_page`, `whatsapp_chat._require_permission` |
| F9 | N+1 / heavy loops | `_execute_campaign`: per recipient render + insert + 2 `db_set`; `_resolve_campaign_recipients`: `get_doc` per candidate × rules; `_candidate_document_names` loads every doc for Python conditions; `dispatch_campaign_batch`: `get_doc` per log; `process_campaigns` runs 3 UPDATE-JOINs + count per active campaign **every minute**; `_replace_device_contacts` delete-all + insert-one-by-one under filelock inside the request; `_commands_payload`: 2 queries per command; webhook resolves device up to 3×3 `get_value` **twice** per event; chat `get_messages` scans latest 1,200 logs in Python per call. | `whatsapp_campaign.py:325-341, 386-436, 926-988, 991-1012, 1391-1427`; `whatsapp_platform_integration.py:466-505`; `whatsapp_commands.py:86-117`; `webhook_logs.py:305-322`; `whatsapp_chat.py:761` |
| F10 | Duplication | Phone normalisation ×4 with divergent rules (`whatsapp_log`, `whatsapp_chat`, `manual_whatsapp_message`, `campaign.normalize_recipient`; group = >15 digits vs 18 digits); device resolution ×5; payload key-guessing helpers ×5; status vocab mismatch (`Send` vs `Sent`); poll-option parsing ×3; recipient-rule evaluation duplicated between Notification and Campaign; three admin UIs; stray root `whatsapp_campaign.py/.js`; Yemen-specific `00967` rule hardcoded. | see modules table |
| F11 | Dead / broken | `Sanad WhatsApp Integration` DocType and `platform_api_examples.PlatformApiClient` path are dead (import/DocType missing, swallowed by try/except; webhook logs an Error on every `connection.connected`). `test_command` patches non-existent `engine._tag_log` → dry-run always raises. `scheduled_notification` (Notification Alert) not in scheduler. `download_pdf` unused. `frappe.db._cursor.rowcount` (private attr) used for claim detection. | `whatsapp_chat.py:18, 339-436`; `whatsapp_webhook.py:341-358`; `whatsapp_commands.py:489`; `whatsapp_log.py:93` |
| F12 | Contact / ERPNext linking | Outgoing: recipient resolved at send time from Phone/Mobile fields or a Link's mobile field (Notification, Campaign rules) or Contact search (manual/chat). No persistent link Log↔Contact/Customer; inbound has `sender_number` only. No materialised number table; `WhatsApp Platform Contact/Group` is a per-device cache replaced wholesale on each sync. | `whatsapp_notification.py:519-601`, `manual_whatsapp_message.py:86-218` |
| F13 | Templates | No template DocType: `WhatsApp Notification.message` is inline Jinja per event; `WhatsApp API.reply_template` and Notification Alert HTML are separate template mechanisms. | — |
| F14 | Dependencies | `pyproject.toml` declares only `PyMuPDF`; WeasyPrint is imported (`snd_pdf.py`) but undeclared. Ruff ignores many rules. | `pyproject.toml` |
| F15 | Tests | Meaningful tests only for Campaign (16), Command (18), Log (3); other test files are stubs. | `test_*.py` |
| F16 | Good parts worth keeping | Claim-before-send (atomic UPDATE), dispatch-key cache, stuck-row requeue, batch handover with `client_ref`, reconcile fallback, event-id dedupe with payload hash, HMAC guard that refuses "no secret", masked settings payload, `handle_whitelisted_error` pattern, versioned `apis.json` registry, campaign rate limiting + filelock, `as_bytes` File helper, single-page-PDF→PNG. | `whatsapp_log.py`, `webhook_logs.py`, `whatsapp_apis.py` |

### R-001 markers (likely uncommitted / in-progress; do not rely on)

| Marker | Why it looks unreleased |
|---|---|
| `page/new_desgin` ("WhatsApp Console") | Name matches branch typo; third UI over same backend |
| `patches.txt` duplicate `fetch_platform_webhook_secret #2026-08-23` | Re-run marker dated last month |
| Campaign `recipient_source_type`, `manual_numbers`, `recipient_import_file` + `set_campaign_recipient_source_type` patch | Backfill patch present; `audience_source` still coexists |
| `message.held`, `platform_queue_id`, `reconcile_platform_queue`, `enqueue_messages_api`, `get_message_status_api` | Comments reference a just-changed platform contract; job added to hooks |
| Received Log `sender_number`, `@lid` handling | New field guarded with `has_field` elsewhere |
| `whatsapp_commands.test_command` → `_tag_log` | Half-finished refactor |
| `hooks.default_log_clearing_doctypes` | New retention block with explanatory comment |
| `meta.has_field(...)` guards on `direction`, `save_generated_attachment_to_document`, etc. | Schema drift tolerated across sites |

## Gaps (vs. `plan/00-screens-spec.md`)

| Spec item | Legacy coverage |
|---|---|
| §5.1 Queue (pause/resume, "deleted" as state) | Status machine exists; no pause/resume; no soft-delete state |
| §5.2 WhatsApp Numbers (materialised) | None; only per-device contact cache + on-the-fly normalisation |
| §5.3 Outbound / Inbound as two DocTypes | Already two (`WhatsApp Log`, `Received Log`) but not unified for reading |
| §5.4 Campaigns "multiple messages" | Single message/poll per campaign |
| §5.5 Commands "edit only after stopping", restore defaults | Not present; `rollback_api` is the nearest |
| §5.6 Functions Center catalogue from JSON | Present (`apis.json` per app/version) |
| §5.7 Subscription/Usage/Settings | `get_dashboard` returns subscription, wallet, message logs; no usage aggregation |
| §6.1 Unified message read layer | Chat page merge is outgoing-only; inbound missing |
| §6.2 E.164 normalisation | Four divergent Yemen-centric normalisers |
| §3.2 ContactPicker | `search_recipients` (Contact + WA contact + groups + typed number) is the closest backend |
| §4 Contextual permission layer | None; global role gates only |
| Templates (10), Contacts (12), Contact Groups (14), Onboarding (1), Simulator (11) | None / partial (`test_command` broken, `send_test_message` exists) |
| Notification (doc-event) and Notification Alert (report digest) | Exist in legacy; **no screen in the spec** |

## Risks

| # | Risk | Impact |
|---|---|---|
| R-A | Porting F1 pattern (inline send + commits in `after_insert`) | Data integrity of ERPNext documents; slow forms |
| R-B | Porting F5 (Administrator execution of configurable code from inbound text) | Remote code execution surface for anyone who can message the number |
| R-C | Platform contract in flux (F-markers: held/queue id/status API) | Queue design built on unreleased platform behaviour |
| R-D | Frappe 16: `frappe.db._cursor.rowcount`, `frappe.client_cache`, `get_lazy_doc`, `filelock`, `rate_limit` | Claim logic may silently break; verify on 16.28 |
| R-E | Python 3.14 + WeasyPrint/PyMuPDF wheels | PDF attachments |
| R-F | Yemen-specific normalisation baked in | Wrong numbers for other markets |
| R-G | Webhook replay / device auto-create | Duplicate sends, junk devices |
| R-H | 60 msg/hour deferred throughput | Perceived "stuck" messages |

## Recommendations (mapping to spec screens; no spec re-decisions)

| Legacy piece | Take / rebuild / drop | Target |
|---|---|---|
| Claim/dispatch/requeue/reconcile core (`whatsapp_log.py`) | **Take the algorithm**, rebuild as a background-only pipeline: `insert` never sends; every send goes through a job; no `db.commit()` in request path; replace `_cursor.rowcount` with `frappe.db.sql(... )` + `SELECT ... FOR UPDATE` or `frappe.qb` returning affected rows | Queue (9), Outbound (4) |
| Webhook receiver + `webhook_logs` | Take HMAC + dedupe; add timestamp freshness window; never create devices from webhooks; resolve device once; write inbound to Inbound DocType and update the WhatsApp Number row | Inbound (5), Devices (3), WhatsApp Numbers (13) |
| `_call_platform_method` + endpoint list | Take as the single `PlatformClient`; drop `platform_api_examples.py` and all `Sanad WhatsApp Integration` references | Settings (15), Devices (3) |
| Device QR + pair code + realtime `sanad_whatsapp_connection_status` | Take both pairing modes | Devices (3) |
| Campaign controller | Take recipient sources, rate limit, filelock, poll results; replace per-row loops with bulk inserts; support multiple messages per spec; drop `audience_source` | Campaigns (6) |
| `search_recipients` + Platform Contact/Group cache | Fold into ContactPicker backend; cache becomes WhatsApp Numbers + Contact Groups | ContactPicker (§3.2), Contacts (12), Contact Groups (14) |
| Four normalisers | Replace with one E.164 service (§6.2) used by every entry point | cross-cutting |
| `apis.json` registry + `whatsapp_apis.py` | Take the manifest format and state machine | Functions Center (7) |
| Command engine | Take parsing/whitelist/help; run as a dedicated service user with an allow-list of callable handlers (from the registry only), never `frappe.get_attr` on free text; fix dry-run | Commands (8), Simulator (11) |
| `send_from_form` + timeline JS | Take as Quick send (§3.4) via the queue | cross-cutting |
| `WhatsApp Notification` / `Notification Alert` | Decide at Gate 1 (open question); if kept, message bodies move to Templates (10) and sends go through the queue with `send_now` removed | Templates (10) |
| Three admin pages, workspace, number cards | Drop; Home (2) + Settings (15) per spec | — |
| Roles | Keep the five role names only if conventions allow; implement §4 contextual layer instead of raw-SQL + role gates | §4 |
| Secrets | All keys/tokens as Password fields; QR/pair code never persisted | Settings (15), Devices (3) |
| `snd_pdf.py` | Take WeasyPrint renderer only if PDF attachments are in scope; declare dependency | Outbound (4) |

## Open questions

| # | Question | Blocks |
|---|---|---|
| Q1 | Which platform contract is live on `w-platform.dev`: `enqueue_messages_api` + `client_ref` + `message.held` + `get_message_status_api`, or per-message `send_message_api`? | Queue design |
| Q2 | Which webhook events does the platform actually emit (delivered/read/reaction/group)? Legacy accepts ~20 aliases. | Inbound / status model |
| Q3 | Is the `/api/v1` device-token direct API (chat history, contacts) still offered? If not, inbound history must be built from Received Log only. | Unified read layer §6.1 |
| Q4 | Are `WhatsApp Notification` (doc-event) and `Notification Alert` (report digest) in scope for `whatsapp_next`? No spec screen covers them. | Templates (10) scope |
| Q5 | Acceptable execution identity for command handlers (service user vs Administrator)? | Commands (8) |
| Q6 | Must legacy data (WhatsApp Log, Received Log, Campaigns) migrate into `whatsapp_next` DocTypes, or start clean? | Data model naming |

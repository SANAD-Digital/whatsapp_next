# 11 — Traceability report (phase 8: planned vs delivered)

Phase 8 · 2026-09-27 · auditor: traceability-auditor · inputs: every file under `plan/` (binding `00-screens-spec.md`;
`02`, `fields`, `backend-plan`, `09`, `10` phases 3–7, `risks`, `decisions` D-001..D-123, `14-gate-2`), `.claude/rules/*`,
the app tree `whatsapp_next/` and the platform branch `whatsapp-next-integration`. Paths below are relative to the app repo
root; `platform:` prefixes `../snd_whatsapp_platform/snd_whatsapp_platform/snd_whatsapp_platform/`.

## Purpose

| Item | Value |
|---|---|
| Question | For every plan item: **planned · delivered · deviated · missing**, with file evidence; every deviation cites a `decisions.md` entry or is flagged **silent** |
| Then | Security review against `security.md`; architecture against `architecture.md`; Frappe standards (naming, permissions JSON, translations, `frappe.qb`) |
| Method | Grep/Glob inventory of the tree, targeted reads of the phase-7 code named by the orchestrator, permission JSON greps, endpoint-decorator census (139 `@api_endpoint` across 18 `api/v1` modules), test-module census (48 modules + 14 per-DocType tests) |
| Legacy app check | `git -C ../snd_whatsapp status --porcelain` **could not run: `/home/user/snd_whatsapp` does not exist in this environment** — not present, untouched by construction. Not a finding. |
| Environment caveats confirmed | `wkhtmltopdf` absent (5 PDF tests fail, `14-gate-2.md` §3); R-041 whole-table test clean-ups (phase 9); phases 9–10 not started |
| Classification legend | **D** delivered · **Dv** deviated (cited decision in brackets, or **silent**) · **P** planned / deferred by plan · **M** missing (planned, not built, no decision) |

## Inventory

### A. Spec §1 — UI platform consequences (mandatory)

| Spec item | Status | Evidence |
|---|---|---|
| Built on Frappe Desk, not a Vue SPA | D | 7 Desk pages `whatsapp_next/whatsapp_next/page/wa_*`; kit `public/js/ui/*` on `sanad.ui`; `hooks.py:116` one bundle |
| Custom Pages styled with Espresso tokens (`--surface-*`, `--ink-*`, `--outline-*`) | **Dv (D-100)** | `public/scss/_tokens.scss:1-30` defines the prototype's `--wa-*` palette and re-points Espresso variables on product surfaces; `.claude/rules/ui.md` was updated, **spec §1 bullet 1, `09` §6 and `00-conventions.md` §JS style were not** (spec is owner-edited only) |
| Never mix the two UI worlds | D | No Vue / frappe-ui import anywhere under `public/`; `tests/test_kit_portability.py` |
| Every custom Page takes all data from an independently callable API layer; no data assembly in page JS | **Dv (silent, partly acknowledged)** | `page/wa_home/wa_home.js:386,415,420` reads `WhatsApp Campaign`, `WhatsApp Log`, `WhatsApp Inbound Message` with `frappe.db.get_list` and buckets series client-side (`10-build-order.md` phase-6 open item "`home.get_series`" never closed); `page/wa_settings/wa_settings.js:477` `frappe.db.count`; `page/wa_functions_center/wa_functions_center.js:916` `frappe.client.get_list` for stats. `page/wa_devices/wa_devices.js:989-1019` counts are **planned** (09 G-11) |

### B. Spec §2 — screen inventory

| # | Screen | Status | Evidence | Deviations / notes |
|---|---|---|---|---|
| 1 | Onboarding Wizard | D | `page/wa_onboarding/wa_onboarding.js`, `api/v1/onboarding.py` (14 endpoints, SM-only writes), `services/onboarding.py` | Three panels not a stepper of five (D-102); site linking done by `login`/`complete_signup` → `link_site` (D-117/D-118); **Home → wizard redirect not enabled** — planned last (spec, phase 10); `redirect_unregistered_to_wizard` field exists (`whatsapp_settings.json:613`) |
| 2 | Home / Dashboard | D | `page/wa_home/`, `api/v1/home.py` (`get_dashboard`), Number Card / Dashboard Chart / Custom HTML Block fixtures (`fixtures/*.json`, D-058) | Data assembly in page JS (A above); `home.get_series` missing |
| 3 | Devices | D | `page/wa_devices/`, `api/v1/devices.py` (10), `services/devices.py` (`start_pairing` QR + code, cache-only payload, `wa:pairing:status` :265), insert guard `doctype/whatsapp_device/whatsapp_device.py:19` (D-112) | Hybrid with native list/form as fallback (09 §1A row 3) |
| 4 | Outbound | D | `doctype/whatsapp_log/*.json` (no C/W/D for any role — verified), `public/js/listview/whatsapp_log_list.js`, `form/whatsapp_log.js`, Drawer `ui/Drawer` | Filters source/campaign/command/on-behalf added after Gate 2 (D-122) |
| 5 | Inbound | D | `doctype/whatsapp_inbound_message/`, `listview/whatsapp_inbound_message_list.js`, `form/whatsapp_inbound_message.js` | matched/unmatched as filter not tab rail — Dv (D-116); synonym on stopped command only (D-114) |
| 6 | Campaigns | D | `doctype/whatsapp_campaign{,_message,_recipient}/`, `public/js/screens/campaign/*` (builder), `screens/campaigns.js`, `api/v1/campaigns.py` (20), `services/campaign_runner.py` | Stats card → three strips, not a modal — Dv (D-089, D-091); builder/stepper inside the form although 09 F-07 said "wizard not built" — Dv (D-098, D-105, owner-driven) |
| 7 | Functions Center | D | `page/wa_functions_center/`, `functions/catalog/v1/catalog.json` (2 functions), `services/functions_catalog.py`, `api/v1/functions.py` (10 incl. `preview_install`, `get_manifest`) | Rebuilt on kit Drawer/OverlayPanel (D-099) |
| 8 | Commands | D | `listview/whatsapp_command_list.js` (MetaDialog), `api/v1/commands.py` (7), `doctype/whatsapp_command/whatsapp_command.py` (`validate` lock, `on_trash` :61 = 09 G-05) | Verbs moved into View / form (D-107); native form fallback with redirect (D-029 OQ-12) |
| 9 | Queue | D | `doctype/whatsapp_queue_item/` (no C/W/D), `api/v1/queue.py` (11: pause/resume/delete_items/set_rate/get_throughput…), `services/dispatch.py` delete-as-state | Operations console (D-087/D-088); per-row ETA in `list_queue` (`queue.py:98-101`, 09 OQ-2a) |
| 10 | Templates (+10b Notifications, +10c Alerts) | D | `doctype/whatsapp_template/` (`preview_html`, tabs — D-122), `whatsapp_notification/`, `whatsapp_notification_alert/`, `ui/TemplateEditor`, form scripts (D-108) | Placement per D-028(a) |
| 11 | Simulator | D | `page/wa_simulator/`, `api/v1/simulator.py` (4), `services/simulator.py` (dry-run default, D-029 OQ-8) | Attachments toolbar deferred (09 G-04: `send_test(device, phone, body)` still body-only); device directory not built (spec §3.2 #5) |
| 12 | Contacts (system) | D | `page/wa_contacts/` (roles CU/AGT/MGR/SM), `api/v1/contacts.py` (11, all `permissions.require`), `services/permissions.py` | `DataList` page mode instead of `frappe.DataTable` (D-096 additive); `get_stats` (D-097) |
| 13 | WhatsApp Numbers | D | `doctype/whatsapp_number/` (no C/W/D for any role incl. SM — verified), `services/numbers_materializer.py` (nightly `30 2 * * *` + `on_message_insert`, `hooks.py:65-70,98`), `api/v1/numbers.py` (7), `ui/ConversationDrawer` | `link_status` first column → prototype order — Dv (D-113); link/convert dialog still page-local, not `MetaDialog` as D-060 promised for phase 7 — Dv (silent, cosmetic) |
| 14 | Contact Groups | D | `doctype/whatsapp_contact_group{,_member}/`, `listview/whatsapp_contact_group_list.js` (kind tabs, State, Import CSV), `form/whatsapp_contact_group.js` | D-122 |
| 15 | Subscription, Usage & Settings | D | `page/wa_settings/`, `api/v1/settings.py` (14; `get_settings` returns `has_<secret>` booleans only :136-148; `save_settings` SM + section allow-list :151-183) | Billing actions hidden (D-029 OQ-6); Roles section / support ticket not built (OQ-7); site-linking block removed (D-118) |
| — | Standalone Conversations screen | P (deliberately not built) | Conversation drawer covers it | spec §2, D-007 |

### C. Spec §3–§7

| Spec § | Item | Status | Evidence |
|---|---|---|---|
| 3.1 | Drawer, meta-driven; conversation variant on the read layer | D | `ui/Drawer`, `ui/ConversationDrawer` → `messages.get_conversation` → `services/read_layer.conversation` |
| 3.2 | ContactPicker: 6 sources, one operation one source, add + remove, Selected tab with red duplicates on E.164, confirm with exact count | D | `ui/ContactPicker/sources/{groups,contacts,doctype,excel,phonebook,manual,current}.js`, `selected.js`; `api/v1/picker.py` (10); `services/picker.py`; Frappe `FilterGroup` reused in `sources/doctype.js` |
| 3.3 | List stats card; Campaigns "sending now" click → modal | Dv (D-089/D-091) | `ui/ListStatsCard` exists; Campaigns draws strips instead of a modal |
| 3.4 | QuickSend dialog with "Open in Simulator", pre-filled from context | D | `ui/QuickSend/index.js` (`wa-simulator` link), `api/v1/quick_send.py` (3) |
| 4 | Contextual role with zero Contact rows; scoped elevation; query-level filtering; audit under real user | D (site caveat R-028) | `services/permissions.py` (`can_elevate` :94, `require` :104, declared sets, EXISTS filters, `Elevated Contact Read/Write` :113-118, inserts `ignore_permissions=True` under `frappe.session.user`, no `frappe.set_user`) |
| 5.1 | Queue real DocType, status-driven, delete = state | D | `dispatch.delete_items`, statuses incl. `Completed`/`Dead Letter` (D-029 02 OQ-8) |
| 5.2 | Numbers materialized; watermark; incremental upsert; read-only by permission; one link/convert function checking Contact create | D | `numbers_materializer.nightly_reconcile` / `on_message_insert`; `numbers.convert_number` → `permissions.require("create")` (`api/v1/numbers.py:95`) |
| 5.3 | Two DocTypes | D | `whatsapp_log`, `whatsapp_inbound_message` |
| 5.4 | Campaign messages child table; recipients child table fed by picker | D | `whatsapp_campaign_message`, `whatsapp_campaign_recipient`, `picker.commit_add` |
| 5.5 | Commands: edit blocked while Active; restore defaults; modal create/edit | D | `api/v1/commands.py:152,216` `_require_inactive`; `restore_defaults` :211 |
| 5.6 | Functions DocType + Center page; catalog JSON; preview before install/update; versions | D | `functions_catalog.diff/install/update/remove`, manifest snapshot + sha256 (D-048) |
| 5.7 | Settings page over the Single, no new storage | D | `api/v1/settings.py` `SECTIONS`; storage = `WhatsApp Settings` only |
| 6.1 | One UNION in the read layer | D | `services/read_layer.py:295` (`query * b`), `tests/test_read_layer.py:232` asserts exactly one `UNION ALL`; no other union in the tree |
| 6.2 | E.164 on write into both tables and every comparison | D | `services/phone.py`; `hooks.py:54` Contact validate; `Contact Phone.wa_phone_e164` fixture + `patches/v0_1/backfill_contact_phone_e164.py` |
| 7.1 | OD-1 Virtual DocType evidence | D | D-026 / D-029 |
| 7.2 | OD-2 post-build review (Wizard as modal? Home on Insights?) | P | phase 10 (`10-build-order.md:158`) |

### D. `02-doctypes-gap.md`

| Item | Status | Evidence / deviation |
|---|---|---|
| 24 DocTypes (§3) | D | 24 folders under `whatsapp_next/whatsapp_next/doctype/`; JSON ↔ plan asserted by `tests/test_fields_group_a.py`, `test_fields_group_b.py` |
| Naming (`hash` for high-volume, `field:` for user keys, `WA-DEV-.###`, `WA-CAMP-…`) | D | per-DocType JSON (trusted to the field tests) |
| `WhatsApp Webhook Event.event_id` unique (§2, §3 row 24) | Dv (D-047) | composite unique `(event_name, event_id)` in `patches/v0_1/add_indexes.py` |
| Inbound `provider_message_id` unique (§3 row 5) | Dv (D-029 OQ-B, D-035) | composite `(device, provider_message_id)` |
| Permission matrix §6 — system-only tables have **no C/W/D for any role** | D | grep of `create/write/delete: 1` across Number, Log, Inbound, Queue Item, Audit Log, Webhook Event JSON → 0 hits; `WhatsApp Function` R/W only; Settings SM R/W (permlevel 0 + 1), MGR read (`whatsapp_settings.json:627-639`) |
| Roles §7 (4 product roles as fixtures; command service user seeded disabled, Administrator/SM refused) | D | `fixtures/role.json`; `install.py:16-96` `ensure_command_service_user`; enabled on the dev site only (D-123, `scripts/seed_demo_functions.py:109`) |
| Custom field §8 `Contact Phone.wa_phone_e164` | D (D-028b) | `fixtures/custom_field.json`, `hooks.py:54`, backfill patch |
| Gaps G-01 onboarding, G-02 subscription cache, G-03 rate slider, G-05 catalog JSON, G-07 known-number policy | D | `services/onboarding.py`; `services/usage_sync.py`; `queue.set_rate`; `functions/catalog/v1/`; `send_only_to_known_numbers` (`dispatch.py:212`) + `conversation_confirmed` |
| G-04 campaign change log via `track_changes` + audit | D | `audit.log("Campaign …")` in `campaign_runner`; per-field trace not repeated here |
| G-06 device `battery` | P (dropped, D-029 OQ-7) | — |
| RC-01 build order, RC-02 no-roles enforcement, RC-04 six doc events, RC-05 `client_ref` = outbound name | D | `hooks.py:57-64`; D-046 |
| RC-03 Numbers list `link_status` first | Dv (D-113) | prototype column order kept |
| Risks R-01..R-06 | mitigations built (`PagedChildTable`, single writer + `services/guards.py`, retention, real-user audit, title fields) | R-06 `allow_rename` not verified |
| OQ-1..OQ-9 | resolved | D-027, D-028, D-029 |

### E. `fields.md`

| Item | Status | Evidence / deviation |
|---|---|---|
| Field-level shape of the 24 DocTypes | D (test-asserted) | `tests/test_fields_group_a.py`, `test_fields_group_b.py` (RC-01) |
| `provider` Select labels | Dv (D-033) | stores registry keys `snd_platform\nmeta_cloud` (`whatsapp_settings.json:98-103`) |
| `platform_base_url` `reqd` | Dv (D-034, D-103) | optional; default from site config `whatsapp_platform_base_url` |
| Additive fields not in `fields.md` | Dv (cited) | `Picker Source.filters_json` (D-044), `Campaign.exclude_unknown_numbers` (D-029 09 OQ-1; `whatsapp_campaign.json:111`, `campaign_runner.py:362`), `Template.preview_html` (D-122), Settings `webhook_events`/`connection_status*` etc. (B-17/B-18) |
| Encrypted fields table (4 Password fields, permlevel 1, read via `get_password`) | D | `whatsapp_settings.json` (4 × `"fieldtype": "Password"`, 5 × `permlevel: 1`); `services/onboarding.has_secret`; receiver `_secret()` |
| Receiver URL description `api.webhook.receive` (F-02 of backend) | D (corrected) | `webhook_setup.RECEIVER_METHOD = whatsapp_next.webhooks.v1.receiver.receive`; `test_fields_group_a` checks it |
| F-01 Party Type child as Link→DocType; F-03 `duplicate_count`; F-04 8 message types; F-05 one fixed number per row; F-06 `held_*` on Outbound; F-07 `event_name` Data; F-11 index patch also in `after_migrate`; F-12 shared Output child | D | `idempotency._bump_duplicate`; `dispatch.py:647-648` `held_at/held_reason`; `install.after_migrate`; `whatsapp_function_output` used by Command `outputs` |
| Gaps G-01 amount from reference, G-03 position/ETA computed, G-04 linked-command counts | D | `read_layer.reference_amount`, `queue.list_queue`, `functions.get_catalog.commands_count` |
| G-07 group recipients | P (reserved, OQ-D) | — |
| RC-04 status writers per module | D | `services/guards.status_writer` (D-038); Inbound `command_status` written by `command_router` (not a `services/commands.py`) — naming Dv, harmless |
| RC-05 error-code vocabulary + `unknown` in one place | D | `services/errors.py:19-20,50` (incl. backend G-4 codes and `CLIENT_REF_DUPLICATE`) |
| OQ-A..E | resolved | D-029 |

### F. `backend-plan.md`

| § | Item | Status | Evidence / deviation |
|---|---|---|---|
| 1 | Module tree | D | all listed packages exist; extras: `services/guards.py`, `services/onboarding.py`, `api/v1/phone.py` (D-101), `api/v1/_roles.py`, `_bulk.py` (D-055) |
| 2.1–2.4 | Schemas, exceptions, `BaseProvider`, registry, contract test | D | `providers/schemas.py`, `exceptions.py`, `base.py`, `registry.py`; `tests/test_providers_base.py`, `test_registry.py`, `test_snd_platform.py`; contract widened by D-102 (signup bootstrap, login, coupons) |
| 2.5 | `snd_platform` method → endpoint map | D | `providers/snd_platform.py` (`_request` :184; headers D-020 :174-176; `configure_webhook` :946-976 now updates the auto-created endpoint's events — D-120; `PLATFORM_SOURCE_TYPES` :646-655 — D-121) |
| 2.6 | `meta_cloud` skeleton | D | `providers/meta_cloud.py` |
| 3 | 24 service modules | D | all present; `read_layer` uses qb `.run()` — F-03/RC-1 "single `frappe.db.sql`" **superseded by D-043** (no `frappe.db.sql` anywhere: grep = 0) |
| 4.0 | `api_endpoint` decorator; error-code table; `page_length ≤ 200` | D | `api/_common.py` (roles, coercion, unknown-arg rejection, provider-error mapping, cap :113); `WANotSupportedError` 501 → 422 (D-097) |
| 4.1–4.10 | API surface | D (+ additive) | 139 endpoints / 18 modules: settings 14, onboarding 14, home 1, devices 10, quick_send 3, messages 6, simulator 4, queue 11, campaigns 20, picker 10, contacts 11, numbers 7, templates 3, notifications 3, alerts 4, functions 10, commands 7, phone 1; `names[]` bulk variants (09 G-01) via `_bulk.run_bulk` |
| 4.11 | Receiver: guest, HMAC, freshness, idempotency, rate limit; never creates a device / logs payload | D, one Dv | `webhooks/v1/receiver.py` (per-IP 600/min :22,38-45; secret 503 once-per-10-min :67-72; `store_ignored` blanked payload :78-85; unknown device → `Ignored` :100-106; job enqueue :134-142). **Site-wide 3 000/min counter not built — silent** |
| 5.1 | Queue lifecycle, single writer, backoff, dead letter, forward-only status | D (D-046) | `services/dispatch.py` |
| 5.2 | Jobs & scheduler entries | D, one Dv | `hooks.py:85-110` matches the table except `campaign_runner.refresh_counters` cron `*/5` for Running campaigns (counters refreshed at batch end + reconcile finalisation) — silent, minor |
| 6 | Realtime events (3 + 4 proposed) | D (D-029 OQ-10) | `devices.py:155`, `dispatch.py:832,1108`, `campaign_runner.py:111`, `inbound.py:209`, `devices.py:265`, `picker.py:434` |
| 7 | Webhook flow, handlers, inbound → command routing | D | `webhooks/handlers.py`, `services/inbound.py`, `services/command_router.py` (`set_user` in try/finally :326-337; refuses live routing in a request, D-048) |
| 8 | Reconcile | D | `services/reconcile.py` (stale claims :203, drift :242) |
| 9 | Contextual layer table; "blocked paths (tests assert)" | D / Dv (R-028) | tests patch `has_permission` instead of relying on the site matrix (`tests/test_permissions.py`) |
| 10 | Numbers materializer + idempotency proof | D | `tests/test_numbers_materializer.py` |
| 11 | Notification / Alert port | D (D-049) | `services/notifications.py`, `alerts.py`, `alerts_dates.py`, `report_render.py`; R-040 open |
| 12 | Retention | D | `services/retention.py` (commit per batch :85,133 — documented in §12) |
| 13 | Hooks summary | D, Dv (D-058, D-061) | Workspace is a module document `whatsapp_next/whatsapp_next/workspace/whatsapp/whatsapp.json` + `workspace_sidebar/whatsapp.json`, not a fixture; `ignore_links_on_delete` extended to Log / Inbound / Number |
| 14 | Porting map (legacy → new) | D (functional, D-015) | not re-traced row by row; legacy tree absent here |
| 15 | B-1..B-29 | D | all ticked in `10-build-order.md`; B-27 `tests/test_guest_surface.py:32-38` asserts the receiver is the only guest method |
| F-01..F-16 | Findings | applied | F-16: `errors.py:50` maps `CLIENT_REF_DUPLICATE` → `platform_rejected` (treated as rejection, not "accepted earlier" as F-16/R-1 proposed — Dv, silent, low: `strict_client_ref` is not yet set on the real link, R-030) |
| G-1..G-10 | Gaps | D | G-1 `filters_json` (D-044); G-2 audit actions (`audit.py:28-29`); G-4 codes; G-5 `pyproject.toml:13-14`; G-7 credentials from `login`/`complete_signup` (D-118, D-121); G-8 `Queue Items Retried` (`dispatch.py:1021`); G-9 (D-049) |
| R-1..R-11 | Risks | mitigations present | R-8 two-worker claim test not verified here |
| RC-1..RC-6 | Recommendations | D except RC-3 | **RC-3 platform link flags not set on `w-platform.dev`** (R-030, `10-build-order.md:28`) |
| OQ-1..OQ-8 | resolved | D-029 | — |

### G. `09-ui-strategy-matrix.md`

| Item | Status | Evidence / deviation |
|---|---|---|
| Rows 1–15 (§1A–1C) | D | see B above; row-level deviations: 4 (D-122), 5 (D-116), 6 (D-089/D-098/D-105), 7 (D-099), 8 (D-107), 9 (D-087/D-088), 12 (D-096/D-097), 13 (D-113), 14 (D-122), 15 (D-118) |
| §3 kit: 15 listed + 5 candidates (OQ-9) | D | 20 planned components present; 8 additive (`DataList`, `PageHeader`, `DateFilter`, `Render`, `Collection`, `Cards`, `MessageComposer`, `OverlayPanel` — D-064, D-074, D-083, D-085, D-104, D-098, D-099); every folder has `README.md` (`tests/test_kit_portability.py`) |
| §4 ContactPicker sub-system | D | `ui/ContactPicker/*` |
| §5 Workspace: fixture, 4 shortcuts, 6 cards, Number Cards, sidebar order, page roles | D / Dv (D-058, D-110) | module document instead of fixture; Number Cards not repeated (dashboard block); page JSON roles match §1C (`page/*/*.json`) |
| §6 palette → Espresso mapping | Dv (D-100) | superseded by the prototype palette |
| F-07 "campaign wizard not built" | Dv (D-105) | builder built inside the form |
| G-01 bulk variants, G-02 `exclude_unknown_numbers`, G-05 `on_trash`, G-08 contacts summary, G-10 kit, G-11 client counts, G-12 fixtures, G-13 no Desk New | D | `_bulk.py`; `whatsapp_command.py:61`; `contacts.get_stats`; `wa_devices.js:989-1019`; `fixtures/number_card.json`, `dashboard_chart.json`; D-112 |
| G-03 bulk send via Campaign draft | D | `listview/whatsapp_contact_group_list.js`, `form/whatsapp_contact_group.js` create a `WhatsApp Campaign`; Contacts page routes selection to the simulator (`wa_contacts.js:925`) |
| G-04 simulator attachments | P (deferred; toolbar hidden) | `simulator.send_test(device, phone, body)` |
| G-06 `numbers.get_conversation_log` | **M** (interim only) | `contacts.get_activity` covers the Contact side; no number-level CU-readable log |
| G-07 `messages.get_inbound_summary` | **M** (interim counts) | not in `api/v1/messages.py` |
| G-09 queue drawer via linked outbound | D | `list_queue` rows + `messages.get_outbound` |
| R-09 Dashboard Chart / Number Card read grants for VWR | not verified | `fixtures/role.json` carries no custom perms; Home works through `DashboardBlock` calling the widget methods (D-058) — confirm on a VWR-only user in phase 9 |
| OQ-1..14 | resolved | D-029 |

### H. `10-build-order.md` — items not fully ticked

| Item | Status | Note |
|---|---|---|
| Prerequisite "Design phases 5–7 … design quality gate per `ui.md`" | partially D | `plan/13-design-gate-phase-5.md` only; no gate record for phases 6–7 in page folders or a plan file (D-104 mentions one critique); `ui.md` requires it before ticking |
| 3.P "Set on the whatsapp_next dev link: `require_api_secret=1`, `allow_device_fallback=0`, `strict_client_ref=1`" | **open** | R-030; end-to-end verified only on `platform.localhost` (D-121) |
| Phase 7 "Owner's go to start phase 8" | assumed given | this report exists |
| Phase 8 `git status` capture | N/A | legacy app not present in this environment |
| Phases 9–10 | P | not started |

### I. Gate 2 build (D-117..D-123) — verified against code

| Decision | Status | Evidence |
|---|---|---|
| D-118 `link_site` after login / signup; `ensure_endpoint(refresh_secret=True)`; `adopt_from_provider`; `_parked_site_setup.js` deleted | D | `services/onboarding.py:268-293`, `:207`, `:264`; `services/webhook_setup.py:133-179`; `services/devices.py:444-477` (creates inside `status_writer`, audits `Device Created` under the real user); no `_parked_*` file under `page/wa_onboarding/` |
| D-119 `whatsapp_webhook_base_url` | D | `webhook_setup.receiver_url` :53-58 (site config only) |
| D-120 (a) endpoint events; (b) verified retry takes over a rejected row | D | `snd_platform.configure_webhook` :953-958; `webhooks/idempotency.py:43-63,103-121` (take-over only when `signature_valid and timestamp_fresh`, never the reverse) |
| D-121 platform accepts link user's own `api_secret`; `api_endpoint` savepoint/commit; `PLATFORM_SOURCE_TYPES` | D | `platform:services/api_auth.py:88-139` (`verify_secret` → `_link_user_secret_valid`, only when `frappe.session.user == link user`); `platform:services/errors.py:274-331`; `snd_platform.py:646-655` |
| D-122 Outbound filters; Contact Group tabs / State / Import CSV / form tabs; Template tabs + `preview_html` | D | `listview/whatsapp_log_list.js`, `listview/whatsapp_contact_group_list.js`, `form/whatsapp_contact_group.js`, `whatsapp_template.json` (`preview_html`, tab breaks), `form/whatsapp_template.js` |
| D-123 command service user enabled (dev site state) | D | `scripts/seed_demo_functions.py:109` `enable_commands`; `install.py` still seeds disabled by default |

### J. Platform (`backend-plan-platform.md` §M via `10-build-order.md`) and reviewed files

| Item | Status | Evidence |
|---|---|---|
| P-1..P-10 | D (ticked, phases 3–4) | `platform:api/v1.py`, `services/{errors,api_auth,receiver,devices,message_queue,webhooks,audit,settings}.py` present |
| P-12 `test_patches.py` idempotent; suite green on `w-platform.dev` | P (phase 9) | — |
| Docs (quickstart, auth, rate limits, sandbox, events; curl/Python/JS) | P (phase 10) | — |
| `api_auth._link_user_secret_valid` | reviewed | accepted only for the link's portal user and only when that user is the authenticated caller; constant-time compare on the stored path. **Consequence:** for that caller `X-SND-API-Secret` repeats the `Authorization` secret, so C-04 no longer adds a link-level factor — consistent with D-020's three-credential shape, cited by D-121, but not yet written into the platform docs / a platform decision |
| `errors.api_endpoint` | reviewed | per-call savepoint; after an in-call commit the savepoint is left alone and a later exception rolls back the whole transaction; traceback logged without the request body — correct for PostgreSQL |

### K. `risks.md` — status review

| Risk | Recorded | Audit view |
|---|---|---|
| R-008 secret never enforced | open | platform now enforces per link (`require_api_secret`, default 1 for new links, D-042) and accepts the user secret (D-121) → **re-word and close**, replace with the C-04 note above |
| R-009 secret re-key / double delivery | open | `ensure_endpoint(refresh_secret=True)` on link; idempotent intake → **closable** |
| R-010 device fallback | open | client always passes `device`; platform flag `allow_device_fallback=0` **still unset on the real link** (R-030) → keep open until R-030 closes |
| R-013 payload dump | open | gated in P-1 (ticked) → **closable** after a look at `w-platform.dev` config |
| R-022 bulk variants | open | delivered (`_bulk.py`) → **close** |
| R-023 `doc_events["*"]` perf test | open | cache built; no dedicated perf test found → phase 9 |
| R-025 audit key regex drops `function_key` | open | `functions_catalog.py:351-393` uses `version`/`from`/`to` keys → mitigated, add the test → **closable in phase 9** |
| R-028 core `Contact` grants `All` | open | still the single biggest gap between spec §4's promise and a default site — see Findings S-1 |
| R-030 no Integration Link on `w-platform.dev` / flags | open | unchanged; D-121 proves the path only on `platform.localhost` |
| R-035 Held / Unsent cancel | open | **still open**: `dispatch.cancel_outbound` (`dispatch.py:1232-1248`) refuses rows without an open queue item; phase 7 added queue-row cancel only |
| R-040 report column language | open | unchanged |
| R-041 whole-table test clean-ups | open | unchanged; phase 9 |
| R-003, R-004, R-014, R-016..R-021, R-024, R-026, R-027, R-029, R-031, R-033, R-034, R-039 | open | unchanged; R-027 largely mitigated by D-103 |

## Findings

Severity: **Critical** blocks release · **High** must be fixed before Gate 3 / release · **Medium** fix in phase 9–10 · **Low** housekeeping.

| # | Sev | Area | Finding | Evidence | Plan status |
|---|---|---|---|---|---|
| S-1 | High | Security §4 | The contextual role is blocked from direct `Contact` access **only if the site removes Frappe's default `All` read/write/create row on `Contact`**. The layer itself is correct (`require`, declared sets, query filters, real-user audit) and tests patch `has_permission`; nothing in install, migrate or docs enforces or warns about the site matrix | `services/permissions.py:94-118`; D-044 note; R-028; `tests/test_permissions.py` | known (R-028), no owner decision; deployment step undocumented |
| S-2 | Medium | Security (platform) | D-121 makes `X-SND-API-Secret` accept the link user's own Frappe `api_secret` when that user is the caller — the header then duplicates `Authorization`, so C-04's "link-level second secret" is not a second factor for the portal-user caller. Consistent with D-020, owner-requested, but the platform contract docs (`docs/`) and `backend-plan-platform` C-04 are not updated | `platform:services/api_auth.py:104-139` | Dv cited (D-121); documentation missing |
| S-3 | Medium | Security (queue) | `Held` and `Unsent` outbound rows cannot be cancelled from any API (R-035) — a message held by the platform stays uncancellable from the UI | `services/dispatch.py:1232-1248` | open risk, no decision |
| S-4 | Low | Security (receiver) | Only the per-IP 600/min limiter exists; the plan's site-wide 3 000/min counter is absent. Behind a shared proxy the per-IP key may collapse to one address | `webhooks/v1/receiver.py:22,38-45`; `backend-plan.md` §4.11 | Dv silent |
| S-5 | Low | Security (audit) | `contacts.search_company` reads `Company` with `ignore_permissions=True` for a Contact User without an `Elevated Contact Read` row (D-029 OQ-3 "audit every CU read"); field set is `name, company_name` only | `api/v1/contacts.py:97-114` | Dv silent |
| S-6 | Low | Security (webhook) | Take-over race: two concurrently retried verified deliveries of a previously rejected id both take the row and both enqueue; absorbed by `job_id` dedupe. Rejected deliveries with a fresh id are stored before verification (blanked payload) — bounded by the rate limit and retention | `webhooks/idempotency.py:43-63`; `receiver.py:134-142` | informational |
| A-1 | Medium | Architecture | **Provider-specific strings outside `providers/`**: the receiver imports `HEADER_EVENT`, `HEADER_EVENT_ID`, `HEADER_SIGNATURE` from `providers.snd_platform`, and the handler re-creates `X-SND-Event` / `X-SND-Event-ID` literals to re-parse a stored event. A second provider could not receive webhooks | `webhooks/v1/receiver.py:19,59-62`; `webhooks/handlers.py:128` | Dv **silent** |
| A-2 | Medium | Architecture | **Business logic in `api/`**: `commands.save_command` maps the payload onto the document, validates outputs, inserts/saves and audits (60 lines); `commands.restore_defaults`, `functions.save_settings`, `functions.set_status*`, `settings.save_settings` (section allow-lists + write), `contacts.search_company` / `get_activity` (query assembly), `numbers.search_numbers`, `campaigns.py:182` (qb group-by). All permission-checked, but a `v2` package would have to copy the logic | `api/v1/commands.py:140-262`; `api/v1/functions.py:149-207`; `api/v1/settings.py:151-183`; `api/v1/contacts.py:97-205`; `api/v1/numbers.py:117-145` | Dv **silent** |
| A-3 | Medium | Architecture / spec §1 | Home page assembles data in page JS (`frappe.db.get_list` on three DocTypes, client-side bucketing); Settings and Functions Center each make one direct Desk read | `page/wa_home/wa_home.js:386-420`; `wa_settings.js:477`; `wa_functions_center.js:916` | Dv silent (phase-6 open note, never closed) |
| A-4 | Medium | Spec / rules | Spec §1 bullet 1 ("Espresso tokens"), `09` §6 and `00-conventions.md` §JS style still mandate Espresso-only colours while `ui.md` and the code follow the prototype palette | `public/scss/_tokens.scss`; `plan/00-screens-spec.md:24-26` | Dv cited (D-100) — the binding spec needs the owner's edit |
| A-5 | Low | Architecture | `campaign_runner.refresh_counters` cron `*/5` from §5.2 is not registered; counters refresh at batch end and in reconcile finalisation | `hooks.py:85-110` | Dv silent |
| A-6 | Low | Architecture | D-060 said the Numbers link/convert dialog becomes `MetaDialog` in phase 7; it is still a page-local dialog | `public/js/screens/numbers.js` (no `MetaDialog`) | Dv silent, cosmetic |
| F-1 | Medium | Process (ui.md) | Design-quality-gate record exists for phase 5 only; phases 6–7 pages were reviewed against the prototype but no `design:*` findings record per page/component was written, and the `10-build-order` prerequisite stays unticked | `plan/13-design-gate-phase-5.md`; no gate strings under `page/*` | partially D |
| F-2 | Low | Standards (i18n) | `translations/ar.csv` still carries the pre-R-036 developer-note source strings (platform API names, D-numbers) as dead rows | `translations/ar.csv:880,942-946,1228,1256,1401,3139,3162-3168` | housekeeping (D-040 regenerate) |
| F-3 | Low | Standards (docs) | `00-conventions.md` §Naming lists `WhatsApp Outbound Message` (superseded by D-027) and §Test layout names files that exist under other names (`test_webhooks.py`, `test_permissions.py`, `test_platform_ops.py`, `test_fields_group_a/b.py`; no `test_queue.py`, `test_reconcile.py`, `test_indexes.py`, `test_scheduler_registration.py` — coverage lives in `test_dispatch`, `test_platform_ops`, `test_fields_group_a`, `test_smoke`) | `plan/00-conventions.md:21-24,111-125` | stale plan text |
| F-4 | Low | Standards (fixtures) | `fixtures/role.json` carries no `Dashboard Chart` / `Number Card` read grant (09 R-09 / OQ-13 "grant read via fixtures"); Home reads through the widget server methods instead | `fixtures/role.json` | unverified for a Viewer-only user |

**Security checklist against `security.md` (pass unless listed above)**

| Rule | Result | Evidence |
|---|---|---|
| Secrets in `Password` / site config; never logged, returned, or in list views | pass | 4 Password fields permlevel 1; `get_settings` `has_*` booleans; `onboarding.login` returns `{ok, customer, customer_name, credentials_stored, …}` only; `audit.sanitize_details` drops `key|secret|token|password` keys; every `frappe.log_error` message reviewed = codes / names only |
| Every whitelisted method: permission check, typed validation, `allow_guest=False` | pass | single `frappe.whitelist` call site `api/_common.py:71`; 139 endpoints; `roles=None` endpoints (contacts 10, numbers 3, picker 3, messages 1) each call `permissions.require` / `_require_write` / `has_permission`; `tests/test_api_common.py`, `test_guest_surface.py` |
| Receiver: only guest endpoint, HMAC, idempotent, rate-limited | pass (S-4 note) | `receiver.py`; `verify.py` (skew 300 s, 5-failure re-fetch); `idempotency.py` |
| Roles ≥ 4 + contextual; per-DocType matrix; per-account isolation possible | pass (S-1) | `fixtures/role.json`; `device` Link on transactional tables |
| PII: no payloads in Error Log; retention job | pass | `retention.purge` cron `0 3`; payload blanked on terminal events (`handlers.py:139-140`) |
| Audit: connect/disconnect, credential change, bulk send, campaign start/stop, every elevated write | pass | `services/audit.py` (real user, job name, IP, fields_written names only); `Device Created` on adoption (`devices.py:470-475`) |
| Elevated writes attributed to the real user | pass | `permissions.py` inserts with `ignore_permissions=True` under `frappe.session.user`; `frappe.set_user` only in `command_router.py:326-337` (service user, try/finally) |

**Architecture checklist against `architecture.md`**

| Rule | Result |
|---|---|
| Provider registered through the hook; nothing outside `providers/` imports a provider module | **fail** (A-1): `webhooks/v1/receiver.py:19` |
| No provider-specific string outside `providers/` | **fail** (A-1); `whatsapp_settings.json` Select options are registry keys (D-033, allowed) |
| No business logic in `api/`; no HTTP in controllers | **partial** (A-2); no HTTP in controllers (pass) |
| No `frappe.db.sql` without a decision | pass (0 occurrences; D-043) |
| Only UNION in the read layer | pass |
| E.164 central service | pass |
| Numbers: watermark nightly + incremental, idempotent | pass |
| Jobs: `frappe.enqueue` for every outbound call; named queues; backoff; dead letter; Queue as status DocType; realtime; scheduler events | pass; `frappe.db.commit()` only in job code (`dispatch.py:711,734` D-046; `campaign_runner.py:340,355,434,436` in `materialize*` jobs; `numbers_materializer.py:233,242`; `retention.py:85,133`; a patch) |
| Docstring on every public function, module header comment | pass on every module read |

**Frappe standards**

| Item | Result |
|---|---|
| Naming (`WhatsApp <Noun>`, `snake_case` fields, `phone`/`phone_e164` pairs, `wa_` prefix on the one core field, `wa-*` page slugs, `sanad.ui.*`) | pass |
| Permissions JSON vs `02` §6 | pass (system-only tables carry no C/W/D; Settings SM-write, MGR-read; Function R/W) |
| Page JSON roles vs `09` §1C | pass (`wa-contacts` CU/AGT/MGR/SM; `wa-settings` SM/MGR/VWR; `wa-onboarding` MGR/SM) |
| Translations (`ar.csv`, `_()` / `__()`) | pass; dead rows (F-2) |
| `frappe.qb` / `get_all` over raw SQL | pass |
| Workspace as module document + app-level sidebar (v16) | pass (D-058, D-110) |
| `patches.txt`, `after_migrate` index patch | pass |

## Gaps

| # | Gap | Where it was planned | Proposed home |
|---|---|---|---|
| G-1 | `home.get_series` / live-feed endpoint so `wa-home` stops reading three DocTypes directly | `10-build-order` phase-6 open item; spec §1 | `api/v1/home.py` + `services/home.py` (phase 9) |
| G-2 | `numbers.get_conversation_log`, `messages.get_inbound_summary` | 09 G-06, G-07 | build or record "not built" in `decisions.md` |
| G-3 | Simulator attachments (`send_test` media args) | 09 G-04 | phase 9/10 or record deferral |
| G-4 | Cancel path for `Held` / `Unsent` outbound | R-035 | `dispatch.cancel_outbound` transition + test |
| G-5 | Provider-neutral webhook header contract | architecture rule | `BaseProvider.webhook_header_names()` or `parse_stored_event(event_name, event_id, body)`; drop the `snd_platform` import from `webhooks/` |
| G-6 | Install/migrate warning when role `All` still holds `Contact` permission; developer-docs section | R-028 | `install.after_migrate` check → `frappe.msgprint` / log; `developer-docs/` permission model (phase 10) |
| G-7 | Platform decision + docs entry for the D-121 secret rule (C-04 scope) | platform.md "documented as you build it" | `platform:docs/authentication.md`, platform changelog |
| G-8 | Design-gate record for phases 6–7 | ui.md D-029c/D-030 | `plan/13-design-gate-phase-6-7.md` or README sections, then tick the prerequisite |
| G-9 | Owner edit of spec §1 bullet 1 (palette), `09` §6, `00-conventions.md` (naming, tests, colours) | D-100, D-027 | owner (hook-protected spec) / `plan(phase-8)` commit for the other two |

## Risks

| # | Risk | Impact | Mitigation |
|---|---|---|---|
| R-A | S-1 shipped to a default site: a Contact User opens `/app/contact` and `frappe.client.get("Contact")` | Spec §4 promise broken outside the product screens | G-6 + phase-10 docs; consider a `bench` check |
| R-B | A-1: a second provider (or a header rename on the platform) breaks intake silently | Receiver hard-wired to one provider | G-5 before the "Add a new provider" guide (phase 10) |
| R-C | A-2: `api/v2` would fork logic that lives in `api/v1` | Versioning promise (D-031) weakened | Move write paths to services in phase 9 or record a decision defining "thin" |
| R-D | R-030 / RC-3: the real link never exercised with `strict_client_ref=1`, `allow_device_fallback=0`; `CLIENT_REF_DUPLICATE` is mapped to a rejection, not "accepted earlier" | Duplicate sends after a worker crash go unnoticed until production | Create the link on `w-platform.dev`, set the flags, add the contract test (R-030) |
| R-E | R-041 test clean-ups on a shared site | Data loss on dev/staging | phase 9 (unchanged) |
| R-F | F-4: Viewer-only users may not see Home cards/charts | Blank Home for `WhatsApp Viewer` | verify with a VWR-only login in phase 9 |

## Recommendations

| # | Recommendation | Phase |
|---|---|---|
| RC-1 | Fix A-1 (provider-neutral header contract) and add a test that greps `webhooks/`, `services/`, `api/` for `X-SND` / `snd_platform` imports | 9 |
| RC-2 | Move `save_command`, `restore_defaults`, `functions.save_settings`, `settings.save_settings` bodies into `services/commands.py` / `services/settings.py`; keep `api/` at "validate args → call service → shape response"; or add a decision that read-only queries and single-document status flips may live in `api/` | 9 |
| RC-3 | Add `home.get_series` (+ live feed) and remove the three `frappe.db.get_list` calls from `wa_home.js`; same for the Settings / Functions Center counts | 9 |
| RC-4 | Extend `dispatch.cancel_outbound` to `Held` / `Unsent` with a transition test; close R-035 | 9 |
| RC-5 | `install.after_migrate`: warn when `Contact` still grants `All`; document the deployment step; record a decision on whether the app may remove that DocPerm on install | 9 / 10 |
| RC-6 | Platform: write the D-121 secret rule into `docs/authentication.md` and a platform decision; update R-008 wording | 10 |
| RC-7 | Owner edits spec §1 bullet 1 for D-100; `plan(phase-8)` commit fixes `00-conventions.md` (naming, colours, test layout) and `09` §6 | 8 |
| RC-8 | Regenerate `translations/ar.csv` (D-040) to drop dead developer-note rows | 9 |
| RC-9 | Close R-009, R-013, R-022, R-025 in `risks.md`; re-word R-008 | 8 |
| RC-10 | Write the phase 6–7 design-gate record and tick the prerequisite | 8 / 9 |

## Open questions

| # | Question | Blocks | Proposed default |
|---|---|---|---|
| OQ-1 | May the app remove Frappe's `All` DocPerm on `Contact` at install (making spec §4 hold by default), or is that a site-admin step only? | S-1 / R-028 | Site-admin step + install warning (RC-5); no schema change to a core DocType |
| OQ-2 | Is "read-only queries and single-document status flips in `api/`" an accepted definition of "thin", or must every write path move to `services/`? | A-2 / RC-2 | Move write paths; accept read-only queries with a decision entry |
| OQ-3 | Is the D-121 rule (user secret doubles as `X-SND-API-Secret`) the final platform contract, or should `login_with_password` return the link `api_secret` so C-04 keeps a separate factor? | S-2 / platform docs | Keep D-121, document it; revisit when the platform portal is built (spec §8) |
| OQ-4 | 09 G-06 / G-07 endpoints: build in phase 9 or record as not built? | G-2 | Record as deferred with the interim path |
| OQ-5 | Who edits spec §1 bullet 1 for D-100 and when? | A-4 | Owner, before Gate 3 |

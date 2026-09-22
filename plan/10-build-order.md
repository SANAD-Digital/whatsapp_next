# Build order — `whatsapp_next` + platform (phases 3–10)

Dependency-ordered checklist merged from `backend-plan.md` §15 (B-steps), `backend-plan-platform.md`
§M (P-steps), `09-ui-strategy-matrix.md` §1C/§3/§4 (UI rows) and the phase definitions in
`.claude/skills/run-phase/phases/`. Tick items as they land; every phase's closing step ticks here.
Nothing below starts before **Gate 1** is approved.

Legend: `B-n` = `backend-plan.md` §15 step · `P-n` = `backend-plan-platform.md` §M step ·
`UI-n` = `09-ui-strategy-matrix.md` row · `(dep)` = must be done first.

## Prerequisites

- [x] Phase 0 recon (`00-conventions.md`, `09` inventory)
- [x] Phase 1 analysis (`01-snd-whatsapp-summary.md`, `05-platform-summary.md`, D-010..D-024)
- [x] Phase 2 plans (`02`, `06`, `fields`, `fields-platform`, `backend-plan`, `backend-plan-platform`, `09`, this file)
- [x] **Gate 1 approved** (D-027..D-029) — all open questions resolved as the planners' defaults
- [ ] Design phases 5–7: design quality gate per `.claude/rules/ui.md` — `ui-ux-pro-max` (ux/product/chart/icons domains) + `design:design-critique` + `design:accessibility-review` + `design:ux-copy` on each component/page before ticking it (D-029c, D-030)

## Phase 3 — Scaffold & schema (exit: `bench migrate` clean on both sites) — **done 2026-09-22** (client 138 tests, platform 100 tests, both migrates clean; branch `phase-3-schema`, platform commits 1447cef + 7cb522a)

### 3.P Platform first deploy (branch `whatsapp-next-integration`) — unblocks client screens 1, 15 and the provider error layer
- [x] P-1 Foundations (all new endpoints under `…api.v1.*`, existing names aliased there, D-031): `services/errors.py`, `api_auth.resolve_link`, `settings.py`, `audit.py`, `WhatsApp Platform Settings`, `WhatsApp API Audit Log`, hooks `ignore_links_on_delete` (**before any new Link column**, PFD-01), `api/v1.py` aliases; C-01, C-02, C-05, C-06, C-07, C-29, C-30 + tests
- [x] P-2 Schema batch A (D-018): Webhook Endpoint `Locked` + counter/lock fields, Webhook Event `message.held`, Delivery Log `device`/`dispatched_at`/indexes; patch P-1 (`Failed`→`Locked`); C-08..C-12, C-14 + lock/dispatch tests (P-1)
- [x] P-3 `update_webhook_endpoint_api`, endpoint list/create changes, `rotate_integration_webhook_secret_api`, link secret at insert, patch P-3 (P-2)
- [x] P-4 Schema batch B: Message Log `client_ref`/`device`/indexes, Message Queue indexes, Usage Ledger `device`/`integration_link`; Integration Link `require_api_secret`, `allow_device_fallback`, `strict_client_ref`; patch P-2 flags; C-15..C-17, C-27 (P-1)
- [x] P-9 Role permission rows (C-36) + patch P-5 (P-1) — can slip to phase 4
- [x] Remove/gate the raw webhook payload `log_error` dump behind `log_webhook_payloads` + `webhook_payload_log_until` (R-013) — inside P-1/P-5
- [ ] Set on the whatsapp_next dev link: `require_api_secret=1`, `allow_device_fallback=0`, `strict_client_ref=1` (fields-platform step 7) — **blocked: no whatsapp_next link exists on `w-platform.dev` yet** (phase 3 report); new links now default to `require_api_secret=1`
- [x] Docs started: `docs/webhooks/contract.md`, `docs/errors.md` (RC-7, written before B-6)

### 3.C whatsapp_next skeleton and DocTypes
- [x] B-1 App skeleton: module tree (`backend-plan.md` §1), `hooks.py` (providers, scheduler, doc_events stubs, fixtures), `install.py`, `pyproject` deps (`openpyxl`, `vobject`), ruff, `.gitignore`, `README.md`, `tests/conftest_frappe.py`
- [x] B-2 `providers/exceptions.py`, `services/errors.py`, `api/_common.py` (`api_endpoint` decorator; test forbids bare `@frappe.whitelist` in `api/`) (B-1)
- [x] B-3 `services/phone.py` E.164 (+ JID pass-through; strips `+` at the provider boundary) + table-driven tests (B-1)
- [x] B-4 DocTypes as JSON in RC-01 order: Settings (+ Picker Source, incl. `filters_json` G-1) → Device → Template → WhatsApp Log → Inbound → Webhook Event → Queue Item → Number → Audit Log → Contact Group (+Member) → Campaign (+Message, +Recipient) → Function (+Setting, +Output) → Command (+Party Type) → Notification (+Recipient) → Notification Alert (+Recipient); thin controllers; status-writer guard; `patches/v0_1/add_indexes.py` (+ `after_migrate`); fixtures: 4 roles, `Contact Phone.wa_phone_e164` (D-028), Contact `validate` hook; `translations/ar.csv`; per-DocType `test_<dt>.py` + `test_fields.py` + `test_indexes.py` (B-3)
- [x] Fix the receiver URL description in Settings (`whatsapp_next.webhooks.v1.receiver.receive`, backend F-02, D-031) — inside B-4
- [x] B-5 `services/audit.py` (real user, masking) (B-4)
- [x] B-6 `providers/`: schemas, base, registry, `snd_platform`, `meta_cloud` skeleton, `tests/fake_provider.py`, webhook fixtures `tests/fixtures/webhooks/*.json` (B-2, B-4, platform docs)
- [x] Exit: `bench --site whatsapp.dev.sanad.digital migrate` and `bench --site w-platform.dev.sanad.digital migrate` clean; both test suites green

## Phase 4 — Backend & provider layer

### 4.P Platform (remaining steps)
- [ ] P-5 Receiver refactor `services/receiver.py` (auth, rate limit, payload gate, device by `wa_device_id`, delivered/read correlation, sender cache) (P-2, P-4)
- [ ] P-6 Device: `pairing_mode`, status audit, `update_device_api`, `reconnect_device_api` (P-1)
- [ ] P-7 Account/plan/wallet/usage endpoints (`get_account_api`, `list_plans_api`, `get_wallet_api`, `request_wallet_topup_api`, `get_usage_api`) (P-4)
- [ ] P-8 Messages/queue endpoints: `send_message_api` codes + `allow_fallback`, `enqueue_messages_api` per-item codes, `get_message_status_api` additive keys, `cancel_queued_messages_api`, `get_queue_status_api` (P-4)
- [ ] P-10 Credentials rotation: rotate `api_secret` with grace, keep `api_key` as identifier (D-029)
- [ ] Docs per step (`docs/` page list §L), `changelog.md`, `openapi.yaml` draft

### 4.C whatsapp_next services (order = `backend-plan.md` §15)
- [x] B-7 `services/read_layer.py` — the one UNION ALL via `frappe.qb` (`.run()` works on v16, no `frappe.db.sql`; D-043) (B-4) — 11 tests
- [ ] B-8 `services/permissions.py` contextual layer §4 (declared field sets, query filters, audit) (B-4, B-5)
- [ ] B-9 `services/templates.py`, `attachments.py`, `polls.py` (B-4)
- [ ] B-10 `services/dispatch.py` (claim `for_update(skip_locked)`, batch enqueue with `client_ref` = `WhatsApp Log` name, backoff, dead-letter, global/campaign pause, rate), `reconcile.py` (cron `*/5`), `quick_send.py` (B-5, B-6, B-9)
- [ ] B-11 `services/devices.py` + pairing cache (QR + 8-digit code) (B-5, B-6)
- [ ] B-12 `webhooks/` receiver (guest, HMAC over `<ts>.<body>`, window, dedupe `(event, event_id)` + `(client_ref, status)`, enqueue), handlers incl. `message.held`, `services/inbound.py`, D-012 command routing under the service user (B-6, B-10, B-11)
- [ ] B-13 `services/numbers_materializer.py` nightly watermark job + incremental companion, idempotency test (B-7)
- [ ] B-14 `functions/registry.py`, `functions/catalog/v1/catalog.json`, `services/functions_catalog.py`, `command_router.py`, `simulator.py` (B-9, B-10, B-12)
- [ ] B-15 `services/campaign_runner.py`, `services/picker.py` (six sources, add/remove, E.164 dedupe, Excel/CSV/vCard) (B-8, B-10, B-13)
- [ ] B-16 `services/notifications.py`, `alerts.py`, `alerts_dates.py`, `report_render.py`, `doc_events` hooks — D-016 port, sends through the queue (B-9, B-10)
- [ ] B-17 `services/webhook_setup.py`, `usage_sync.py`, `retention.py`; final `scheduler_events` (B-6, B-11)
- [ ] Realtime events wired: `wa:device:status`, `wa:message:status`, `wa:queue:progress` (+ `wa:campaign:status`, `wa:inbound:received`, `wa:pairing:status`, `wa:import:progress` — accepted D-029)

## Phase 5 — API surface + portable component kit

> Phase file says "Portable component kit"; the API layer (`backend-plan.md` B-18..B-27) has to exist first, so it opens this phase.

### 5.A API (`api/v1/<area>.py`, dotted `whatsapp_next.api.v1.<area>.<fn>`, thin, `api_endpoint`-decorated — D-031)
- [ ] B-18 `api/settings.py`, `api/onboarding.py`, `api/home.py` (B-17)
- [ ] B-19 `api/devices.py` (B-11)
- [ ] B-20 `api/quick_send.py`, `api/messages.py`, `api/simulator.py` (B-10, B-14)
- [ ] B-21 `api/queue.py` (B-10)
- [ ] B-22 `api/numbers.py`, `api/contacts.py` (B-8, B-13)
- [ ] B-23 `api/picker.py` (B-15)
- [ ] B-24 `api/campaigns.py` (B-15)
- [ ] B-25 `api/templates.py`, `api/notifications.py`, `api/alerts.py` (B-16)
- [ ] B-26 `api/functions.py`, `api/commands.py` (B-14)
- [ ] B-27 `webhooks.receiver` is the only guest endpoint; `tests/test_guest_surface.py` (B-12)
- [ ] Additive `names[]` bulk variants (09 G-01): resend failed, campaign pause/resume/cancel, function update/status, command status, contacts link, numbers convert

### 5.K Kit (`public/js/ui/<Component>/`, `sanad.ui.*`, README + one live use each; no `whatsapp_next.*` import)
- [ ] `StatusBadge`, `EmptyState`, `Toast`, `ConfirmDialog` (S — foundations used by everything)
- [ ] `FilterBar`, `TreeGroupBy`, `RowActions`, `BulkActions` (S — list helpers)
- [ ] `Stepper`, `PhoneField` (S)
- [ ] `ListStatsCard` (S) — live use: Campaigns
- [ ] `MetaDialog` (M) — live use: Commands modal
- [ ] `Drawer` record/form/choice (M) — live use: Outbound
- [ ] `ChatThread` (M) → `ConversationDrawer` variant (M) — live use: WhatsApp Numbers
- [ ] `QuickSend` (M) — live use: Outbound list
- [ ] `TemplateEditor` (M) — live use: Message Templates
- [ ] `PagedChildTable` (M) — live use: Contact Groups members
- [ ] `DashboardBlock` (M) + Number Card / Dashboard Chart fixtures
- [ ] **ContactPicker sub-system (XL)** — sub-plan:
  - [ ] Shell: modal/sheet, source tabs, Selected tab last, add/remove modes, `picker.list_sources`
  - [ ] Source 1 Contact Groups (`search_groups`, `get_group_members`)
  - [ ] Source 2 Contacts through the §4 layer (`search_contacts`)
  - [ ] Source 3 System screen: DocType from `Settings.picker_sources`, Frappe `FilterGroup` reused, server-side `filters_json` merged (`picker.query_doctype`)
  - [ ] Source 4 Excel upload → mapping → preview (`parse_upload kind=excel`)
  - [ ] Source 5 Phone export vCard / CSV (`parse_upload kind=vcf|csv`)
  - [ ] Source 6 Manual (`parse_manual`)
  - [ ] Selected tab: live counter, red duplicate flags on `phone_e164`, counts already-added / available / invalid, `known_count`
  - [ ] Confirm step with exact count → `commit_add` / `commit_remove`; audit rows; 409 on running campaign where applicable
  - [ ] Live use: Campaigns (Contacts tab) and Contact Groups (Members)
- [ ] Portability check: no `whatsapp_next.*` import under `public/js/ui/`; `public/js/ui/README.md` "copy the kit into another app"

## Phase 6 — Custom Desk pages (`page/wa-*`, all data from `api/`, Espresso tokens, RTL, states, realtime)
- [ ] `wa-home` (L) — device status, campaigns sending now, queue health, click-through; Number Cards/Charts via fixtures (D-029)
- [ ] `wa-devices` (L) — DeviceCard grid, PairingModal QR + 8-digit code, live status
- [ ] `wa-onboarding` (M) — Stepper sign-up / sign-in / forgot / pair; **redirect from Home NOT enabled** (phase 10)
- [ ] `wa-functions-center` (L) — catalog, FunctionDetail, PreviewModal diff-before-install/update
- [ ] `wa-simulator` (L) — ChatThread, composer, "message on behalf" (dry-run default, D-029)
- [ ] `wa-contacts` (L) — ContactsTable over `contacts.*`, Drawer create/edit, ConversationDrawer hidden on 403 (D-029), CU-only page permission
- [ ] `wa-settings` (L) — SettingsNav left / content right over the Single; sections per 09 row 15; billing actions hidden until platform A-01..A-04 (D-029)
- [ ] Page permissions JSON per 09 §5; `translations/ar.csv` for every string

## Phase 7 — Frappe-native customization (→ Gate 2)
- [ ] Outbound (UI-4): listview_settings, indicators, FilterBar presets, Drawer, RowActions (resend, quick send, cancel), BulkActions
- [ ] Inbound (UI-5): Drawer, tabs matched/unmatched, reply via QuickSend, "add as synonym" blocked on Active (D-029)
- [ ] Queue (UI-9): default status filter, ListStatsCard summary + pause banner + rate slider, pause/resume/delete-as-state/retry, ETA: summary + Drawer (D-029)
- [ ] Campaigns (UI-6): ListStatsCard "sending now" modal, form tabs Data/Contacts, PagedChildTable recipients, ContactPicker add/remove, start/pause/resume/cancel, `exclude_unknown_numbers` (D-029)
- [ ] Commands (UI-8): New/edit → CommandModal only, edit blocked while Active, restore defaults, native form fallback with redirect (D-029)
- [ ] Functions (UI-7 native list): primary action → Functions Center
- [ ] Message Templates (UI-10a), Notifications (UI-10b), Notification Alerts (UI-10c): forms, previews, send-now/run-now, bulk enable/disable
- [ ] WhatsApp Numbers (UI-13): `link_status` first column with indicator, ConversationDrawer, link/convert MetaDialog, no New
- [ ] Contact Groups (UI-14): kind tabs, PagedChildTable + ContactPicker, Blacklist banner, CSV import route
- [ ] Devices native list (UI-3 fallback), Settings native form (SM fallback)
- [ ] Workspace "WhatsApp" fixture: shortcuts, cards, Number Cards, sidebar order (09 §5)
- [ ] Form side: dashboards/connections (Campaign ↔ Outbound, Number ↔ messages), sidebar stats
- [ ] **Gate 2** demo checklist in Arabic

## Phase 8 — Planned-vs-delivered audit
- [ ] `git -C ../snd_whatsapp status --porcelain` captured; `traceability-auditor` → `plan/11-traceability-report.md`

## Phase 9 — Tests
- [ ] `test-engineer` runs the suite (`bench --site whatsapp.dev.sanad.digital run-tests --app whatsapp_next`), fixes whatsapp_next bugs, writes `plan/12-test-report.md`
- [ ] Platform suite green on `w-platform.dev.sanad.digital`; `test_patches.py` idempotent (P-12)

## Phase 10 — Documentation & release prep
- [ ] `developer-docs/`: README, architecture + diagram, install/configure, "Add a new provider" guide, API reference, events & hooks, kit reference, permission model incl. §4 layer, troubleshooting, CONTRIBUTING, LICENSE
- [ ] `../snd_whatsapp_platform/docs/` complete per `platform.md` (curl/Python/JS, webhook contract, pairing, errors, rate limits, sandbox, quickstart)
- [ ] Platform merge path `whatsapp-next-integration` → `feat/link-webhook-secret` → `main` (R-014); migrate rehearsal on a prod copy (PR-12/PR-18)
- [ ] Enable Home → Wizard redirect for unregistered users (last step)
- [ ] `decisions.md` updated, CHANGELOG written, deferred review (Wizard as modal? Home on Insights?) recorded as open items
- [ ] Final report in Arabic against the Definition of done

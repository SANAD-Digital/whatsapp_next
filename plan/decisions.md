# Decisions log — `whatsapp_next`

One entry per decision. Never delete; supersede with a new entry that references the old one.

| # | Date | Phase | Decision | Rationale / evidence |
|---|---|---|---|---|
| D-001 | 2026-09-22 | 0 | Dev site is `whatsapp.dev.sanad.digital`; `snd_whatsapp` uninstalled from it (backup `20260922_220707-*` in the site's `private/backups`), `whatsapp_next` installed. | Owner request. Legacy data still available on `acc.dev.sanad.digital`. |
| D-002 | 2026-09-22 | 0 | Claude project root is `apps/whatsapp_next`, not the bench. All `.claude/` hooks, rules, agents and phases use paths relative to the app (`../snd_whatsapp`, `../snd_whatsapp_platform`). | Original setup assumed the bench as root, so the legacy-app protection and the rule globs never matched. |
| D-003 | 2026-09-22 | 0 | `docs/` prototype reorganised into `screen/`, `component/`, `shared/`; scripts load from `../shared/`, `COMPONENT_DIR = "../component"`. `docs/` remains read-only input. | Owner started the split; duplicates were byte-identical. `docs/README.md` still describes the flat layout — owner to edit (hook-protected). |
| D-004 | 2026-09-22 | 0 | Phase 3 step 1 (`bench new-app`) is already done; publisher Sanad Digital, MIT, from `hooks.py`. There is no `CLAUDE.md`. | App created by the owner before phase 0. |
| D-005 | 2026-09-22 | 0 | Developer documentation (phase 10) goes to `developer-docs/`, not `docs/`. | `docs/` is the hook-protected prototype. |
| D-006 | 2026-09-22 | 0 | `Hub Page - *` files referenced by `docs/shared/hub-pages.js` are intentionally absent: they were only assemblies of screens + shell. `docs/screen/WhatsApp Hub App-pro.dc.html` plays that role. | Owner clarification. |
| D-007 | 2026-09-22 | 0 | Prototype screens `All Messages` and `Demo` have no spec entry: `All Messages` is served by the conversation drawer (spec §2 "deliberately not built"), `Demo` is prototype-only. Neither is a product screen unless Gate 1 says otherwise. | Spec §2 default rule. |
| D-008 | 2026-09-22 | 0 | Naming, layout, commit, i18n, style and test conventions fixed in `plan/00-conventions.md`. | Phase 0 deliverable. |
| D-009 | 2026-09-22 | 1 | Phase 0 branch `phase-0-recon` fast-forwarded into `version-16`; phase 1 works on `phase-1-analysis`. | Conventions: each phase branches off `version-16` and merges back. |
| D-010 | 2026-09-22 | 1 | Every outbound send in `whatsapp_next` is job-only: no HTTP call, PDF render or `frappe.db.commit()` in a web request or document hook. | Legacy summary F: `WhatsAppLog.after_insert` sends inline and commits inside the caller's transaction, blocking ERPNext saves. |
| D-011 | 2026-09-22 | 1 | Inbound store lives only in `whatsapp_next` (unified log with direction). Nothing is ported from legacy inbound or read from the platform's Delivery Log. | Legacy never unified inbound; platform purges Delivery Log after 30 days and forwards `message.received` only when the plan allows it. |
| D-012 | 2026-09-22 | 1 | No configurable dotted-path command execution. Inbound commands map only to allow-listed handlers from a registry and run as a dedicated service user, never Administrator. | Legacy command engine ran arbitrary dotted paths as Administrator from inbound text. |
| D-013 | 2026-09-22 | 1 | Platform client contract: always pass `device`; prefer batch `enqueue_messages_api` with `client_ref`; fetch webhook secret via `get_integration_webhook_secret_api` (never pass `secret` on endpoint create); verify HMAC-SHA256 over `<X-SND-Timestamp>.<raw body>`; dedupe on `X-SND-Event-ID`; treat HTTP 200 `ok:false` as business rejection. Settings hold three credentials (platform user token, link api_key, webhook secret). | Platform summary F-01/F-04/F-05 and R-002 working tree. |
| D-014 | 2026-09-22 | 1 | Secrets (API keys, tokens, webhook secret, pair code, QR payload) are `Password` fields, never in list views; Settings write is System Manager only. | Legacy stored all of these in plain fields with WhatsApp Manager write access. |

## Open decisions (resolve at Gate 1 — from spec §7)

- **OD-1** Virtual DocType filtering limits on Frappe 16.28 — evidence needed before locking Queue
  as a real DocType (§5.1) and before deciding whether Functions Center could be a Virtual DocType.
- **OD-2** *Post-build review, deferred:* Wizard as modal vs Page; Home on Insights components.
  Nothing may assume or block these.
- **OD-3** (phase 1) Which platform send/status contract is live on `w-platform.dev`: batch `enqueue_messages_api` + `get_message_status_api` vs per-message `send_message_api`. Decides the queue design.
- **OD-4** (phase 1) Spec webhook state "locked" has no platform counterpart (platform: Active/Disabled/Failed/Revoked, Failed never set). Client derivation or additive platform change (A-10 in `05-platform-summary.md`). Decides Screen 15.
- **OD-5** (phase 1) Are legacy `WhatsApp Notification` (doc-event sends) and `Notification Alert` (report digests) in scope? The spec has no screen for them.
- **OD-6** (phase 1) Which plan is the dev tenant on `w-platform.dev` on? Without `webhook_message_received` the inbound and Numbers screens cannot be tested.

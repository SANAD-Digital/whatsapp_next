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

## Open decisions (resolve at Gate 1 — from spec §7)

- **OD-1** Virtual DocType filtering limits on Frappe 16.28 — evidence needed before locking Queue
  as a real DocType (§5.1) and before deciding whether Functions Center could be a Virtual DocType.
- **OD-2** *Post-build review, deferred:* Wizard as modal vs Page; Home on Insights components.
  Nothing may assume or block these.

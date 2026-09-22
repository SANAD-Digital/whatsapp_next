# Phase 10 — Documentation & release prep

**`developer-docs/`** (not `docs/`, which is the read-only design prototype) — for a developer extending the product: README · architecture
overview with diagram · install and configure · **"Add a new provider" guide** (the `BaseProvider`
contract, a worked Meta Cloud skeleton, the registration hook, testing your provider) · API
reference (purpose, args, returns, permissions, errors, example for each endpoint) · events and
hooks · component kit reference · permission model including the contextual layer ·
troubleshooting · CONTRIBUTING and LICENSE.

**`../snd_whatsapp_platform/docs/`** — for external developers on any stack; follow
`.claude/rules/platform.md`.

Final steps, in this order:
1. Enable the Home → Wizard redirect for unregistered users.
2. Update `plan/decisions.md`, write the CHANGELOG.
3. Record the deferred post-build review from spec §7 (Wizard as modal? Home on Insights?) as open
   items in `plan/decisions.md`.
4. Final report in Arabic against the Definition of done in CLAUDE.md, item by item.

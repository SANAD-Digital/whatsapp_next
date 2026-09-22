# Phase 3 — Scaffold & schema

Prerequisite: Gate 1 approved.

1. Already done by the product owner: the app exists (`hooks.py` publisher Sanad Digital, MIT)
   and is installed on `whatsapp.dev.sanad.digital`. Verify with `bench --site whatsapp.dev.sanad.digital list-apps`.
2. Set up `hooks.py`, module structure, fixtures, `.gitignore`, `README.md`, a CI-ready test layout.
3. Build every DocType and field from `plan/02-doctypes-gap.md`, `plan/fields.md`,
   `plan/06-doctypes-gap-platform.md` and `plan/fields-platform.md` — as JSON in the repository,
   never through the UI — with permissions, roles (including the contextual role), naming rules,
   indexes and translations.
4. Platform changes are additive only.

Exit criterion: `bench --site <site> migrate` passes clean.

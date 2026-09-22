# Phase 0 — Recon & conventions

Main session. Produces files only.

1. Verify: bench path, site, the three app folders (confirm the platform's real folder name),
   git state of each app repo, Frappe/ERPNext versions, Python and Node versions.
2. Confirm `plan/00-screens-spec.md` exists. If it is missing, stop and ask — never recreate it.
3. Read the spec and the prototype in `docs/` once. Record a screen inventory (screens only) at the
   top of `plan/09-ui-strategy-matrix.md`.
4. Write `plan/00-conventions.md`: naming for DocTypes, fields and methods; module layout; commit
   format; i18n rules; JS and Python style; test layout.
5. Create `plan/decisions.md` and `plan/risks.md`.

Report in Arabic: environment facts, confirmation the spec was read, the screen inventory, the
agent roster for phases 1–2, and any blocking question. Then proceed to phase 1 in a new session.

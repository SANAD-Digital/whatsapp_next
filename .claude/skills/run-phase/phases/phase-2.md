# Phase 2 — Plan schema, fields, backend, and UI

Run four groups in order; the two agents inside a group run **in parallel**:

1. `doctype-planner` for whatsapp_next ‖ `doctype-planner` for the platform
   → `plan/02-doctypes-gap.md`, `plan/06-doctypes-gap-platform.md`
2. `field-designer` for whatsapp_next ‖ `field-designer` for the platform
   → `plan/fields.md`, `plan/fields-platform.md`
3. `backend-planner` for whatsapp_next ‖ `backend-planner` for the platform
   → `plan/backend-plan.md`, `plan/backend-plan-platform.md`
4. `ui-matrix-planner` → `plan/09-ui-strategy-matrix.md`

Then merge everything into `plan/10-build-order.md`: a dependency-ordered checklist covering
phases 3–10.

Also investigate once: **Virtual DocType filtering limits** on the installed Frappe version. Record
the evidence — it decides spec §5.1 (Queue) and whether the Functions Center could be a Virtual
DocType (spec §7).

> ## 🚦 GATE 1 — STOP
> Present in Arabic: about 10 lines per plan file, the decisions made, the open questions
> (including the Virtual DocType evidence and any disagreement with the spec), and the build order.
> **Wait for explicit approval. Write no code before it.**

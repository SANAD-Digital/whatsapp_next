# Phase 5 — Portable component kit

Build the kit listed in `.claude/rules/ui.md`. For each component: implementation, `README.md`
with a usage snippet, and one live use in a real screen.

**ContactPicker is a sub-system**, not one checkbox: give it its own sub-plan in
`plan/10-build-order.md` covering the six sources, the Selected tab with red duplicate flags
(comparing normalized E.164 values), counts, the confirmation step, and add/remove modes.

Portability check before closing: no import from `whatsapp_next.*` anywhere under `public/js/ui/`,
plus written instructions for copying the kit into another Frappe app.

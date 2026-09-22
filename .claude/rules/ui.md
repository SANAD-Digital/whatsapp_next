---
paths:
  - "apps/whatsapp_next/**/*.js"
  - "apps/whatsapp_next/**/*.css"
  - "apps/whatsapp_next/**/*.scss"
  - "apps/whatsapp_next/**/*.html"
  - "apps/whatsapp_next/**/page/**"
  - "plan/09-ui-strategy-matrix.md"
---

# UI — Desk, Espresso, portable components

## Platform: Frappe Desk, not Frappe UI
The product is embedded in ERPNext and the user is already in Desk. A Frappe UI / Vue SPA would
mean rebuilding Desk's meta-driven machinery and forfeiting future framework improvements.
- Custom Pages use Desk's **Espresso CSS custom properties** (`--surface-*`, `--ink-*`,
  `--outline-*`) — never hard-coded colours — so they read as native and inherit theme/dark mode.
- **Never mix the two UI worlds in one screen** (no Vue + frappe-ui Tailwind inside a Desk page).
- **Every custom Page takes all data from an independently callable API layer.** No business logic
  and no data assembly in page JS.

## Portable component kit — `whatsapp_next/public/js/ui/`
Must be copy-pasteable into any Frappe app:
- no imports from `whatsapp_next.*`; every label through `__()`;
- behaviour driven by **DocType meta** (`frappe.get_meta`, `frappe.model.with_doctype`), never
  hard-coded field lists;
- one `README.md` per component with a usage snippet; at least one live use in a real screen.

Kit: `Drawer` (record preview from a list, plus the **conversation variant** reading from the
unified read layer) · `ContactPicker` (a sub-system — six sources, see the screens spec §3.2) ·
`ListStatsCard` · `MetaDialog` · `FilterBar` · `TreeGroupBy` · `RowActions` · `BulkActions` ·
`QuickSend` · `StatusBadge` · `EmptyState` · `Stepper` · `DashboardBlock` (a real Frappe Custom
Block + Number Card / Dashboard Chart sources) · `Toast`.

Bundle as `whatsapp_next.bundle.js`, load via `app_include_js`, expose on one namespace
(e.g. `frappe.provide("sanad.ui")`).

## Every custom Page must
- be mobile-first and responsive (not a shrunk desktop);
- support Arabic **and** English with correct RTL;
- show loading, empty, and error states; have no dead buttons;
- be keyboard accessible;
- use realtime wherever the prototype shows live state.

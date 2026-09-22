---
paths:
  - "**/*.js"
  - "**/*.css"
  - "**/*.scss"
  - "**/*.html"
  - "**/page/**"
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

## Design quality gate (D-029c, D-030)
Before a kit component or custom Page is ticked in `plan/10-build-order.md`:
- query `ui-ux-pro-max` (project copy in `.claude/skills/ui-ux-pro-max/`, `ux`/`product`/`chart`/`icons` domains
  only — its palettes, fonts, GSAP and stack advice are **not** used; Espresso and Desk decide those);
- run `design:design-critique` and `design:accessibility-review` on the rendered screen, and
  `design:ux-copy` on its strings (Arabic + English);
- record the findings applied in the component `README.md` / page commit message.

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
- **The product's palette is the prototype's own, not Desk's.** Every `docs/screen/*.dc.html` opens
  with the same `:root` block — thirty-one values, light and dark. That block lives in
  `public/scss/_tokens.scss` as `--wa-*`, and the same file re-points Desk's Espresso variables at
  it on this product's surfaces, so a screen written against either name comes out in the product's
  colours. Write `--wa-pri`, `--wa-ok-s`, `--wa-wn-i`, `--wa-surface`, `--wa-ink-3`. Never write a
  colour anywhere else; `_tokens.scss` is the one place a colour is spelled out, and it is spelled
  out there because the prototype spelled it out first.
- Frappe is used for what is genuinely ready-made — routing, permissions, meta, dialogs, the file
  uploader, save and dirty state. It is not a reason to inherit Desk's look. Where the prototype
  draws its own control, draw its own control; `frappe.ui.form.make_control` is for a field the
  prototype did not design, not for one it did.
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

## The list table's stacking ladder (D-076)
`DataList` renders sticky headers, sticky pinned columns, a sticky checkbox and action column and
sticky group rows in one table. Changing one z-index in isolation has broken the grouped view more
than once, so the order is fixed and written in `DataList/style.scss`:

    0 body cell · 2 pinned body cell · 3 checkbox/action body cell · 5 group row
    8 header · 9 pinned header · 10 checkbox/action header

All of it lives inside `.sanad-datalist__wrap`, which is its own stacking context, so nothing here
can ever paint over Desk's menus. After touching `DataList` or `FilterBar`, run
`scripts/list_checks.mjs` — it hit-tests the sticky group row and checks the toolbar, the group
tree and group selection.

## Design quality gate (D-029c, D-030)
Before a kit component or custom Page is ticked in `plan/10-build-order.md`:
- query `ui-ux-pro-max` (project copy in `.claude/skills/ui-ux-pro-max/`, `ux`/`product`/`chart`/`icons` domains
  only — its palettes, fonts, GSAP and stack advice are **not** used; Espresso and Desk decide those);
- run `design:design-critique` and `design:accessibility-review` on the rendered screen, and
  `design:ux-copy` on its strings (Arabic + English);
- record the findings applied in the component `README.md` / page commit message.

# `sanad.ui` — portable Desk component kit

A set of Frappe Desk components that any Frappe app can copy and use. Everything is driven by
DocType meta (`frappe.get_meta`, `frappe.model.with_doctype`) and by a small API map the host app
provides; nothing in this folder knows which app it lives in (a test greps for that).

Colours come only from Desk's Espresso tokens (`--surface-*`, `--ink-*`, `--outline-*`), layout
uses CSS logical properties (RTL for free), every label goes through `__()`, every async pane has
loading (skeleton) / empty / error states, and every panel is keyboard-accessible.

## Components

| Component | What it does | Live use in this app |
|---|---|---|
| `_core` | namespace, `sanad.ui.configure`, `call`, escaping, icons, tones, announcer, focus trap, skeleton, meta helpers | everything |
| `Render` | one presentation layer: values, records and links at five display levels | every list cell, the drawer, Collection |
| `StatusBadge` | status pill coloured by the DocType's own indicator rules | Outbound / Numbers lists |
| `EmptyState` | loading (skeleton) · empty · error · offline | every panel |
| `Toast` | tone + timing + aria-live wrapper over `frappe.show_alert` | QuickSend, bulk actions |
| `ConfirmDialog` | impact rows, reason, acknowledgement, danger | pause/cancel flows, picker confirm |
| `FilterBar` | tabs / select / date range / search bound to a list's filter area | Outbound, Inbound |
| `TreeGroupBy` | sidebar group-by with counts | WhatsApp Numbers (`link_status`) |
| `RowActions` | per-row overflow menu + row click | Outbound, Inbound, Queue, Numbers, Commands |
| `BulkActions` | selection actions, native `names[]` or per-name loop with progress | Outbound, Campaigns, Queue |
| `Stepper` | multi-step flow with "Step n of m" | ContactPicker confirm, Onboarding (phase 6) |
| `PhoneField` | phone input with country hint and E.164 preview | ContactPicker manual source |
| `ListStatsCard` | cards above a list (count / sum / method) with a detail modal | Campaigns "sending now" |
| `MetaDialog` | tabbed dialog whose fields come from a DocType's meta | Commands modal |
| `Collection` | rows as a table, list, cards, gallery or timeline, with the switch between them | drawer activity history |
| `Drawer` | record / form / choice side panel from a list; `record` reads as a document | Outbound, Inbound, Queue |
| `ChatThread` | message bubbles, ticks, day separators | ConversationDrawer |
| `ConversationDrawer` | one thread across both directions (read layer), realtime | WhatsApp Numbers |
| `QuickSend` | one-message composer dialog | Outbound list, Numbers, Templates |
| `TemplateEditor` | variables sidebar + sample picker + live preview | Message Templates form |
| `CommandEditor` | the prototype's command editor: setup · per-type lists · live dry-run preview | Commands list and form |
| `PagedChildTable` | paged read table replacing a large child grid | Campaign recipients, Group members |
| `DashboardBlock` | Custom HTML Block rendering Number Cards / Dashboard Charts | Workspace "WhatsApp" |
| `ContactPicker` | six-source recipient picker with duplicate flags and confirm | Campaigns, Contact Groups |

Each folder has `index.js` (registers `sanad.ui.<Component>`), `style.scss` and a `README.md`
with a usage snippet, its live use and the design-gate findings applied.

## Copy the kit into another Frappe app

1. Copy this whole folder to `<your_app>/public/js/ui/` (keep `_core/`, `index.js`, `style.scss`).
2. Create `<your_app>/public/js/<your_app>.bundle.js`:
   ```js
   import "./ui/index.js";
   sanad.ui.configure({
     api: {
       // key the components use            → your whitelisted method
       "messages.get_conversation": "your_app.api.get_conversation",
       "quick_send.get_context": "your_app.api.quick_send_context",
       // … only the keys of the components you use (each README lists its keys)
     },
     defaults: { simulator_route: "your-simulator-page" },
     // optional: how your records look wherever the kit draws them (see Render/README.md)
     renderers: {
       doctypes: { "Your DocType": "document" },
       profiles: { "Your DocType": { lines: ["party_name"], value: "grand_total" } },
     },
   });
   ```
   and `<your_app>/public/scss/<your_app>.bundle.scss` containing `@import "../js/ui/style";`.
3. In `hooks.py`: `app_include_js = ["<your_app>.bundle.js"]`,
   `app_include_css = ["<your_app>.bundle.css"]`, then `bench build --app <your_app>`.
4. Mount components from your list/form scripts or pages, e.g.
   `new sanad.ui.Drawer({ doctype: "Sales Invoice", name, mode: "record" }).show()`.
5. Components that call the server expect the return shapes documented in their README; wire
   your own whitelisted methods to those shapes (they are plain dicts) or pass `api: {...}`
   overrides per instance.
6. Run the same guard test this app uses (`tests/test_kit_portability.py`) after adapting the
   app name, so the copy stays portable.

Nothing else is required: no npm packages, no build config, no Vue.

## Design gate (phase 5)

Applied kit-wide from `ui-ux-pro-max` (ux / icons domains), `design:design-critique`,
`design:accessibility-review` and `design:ux-copy` (see each component README for specifics):

- Colour is never the only signal (label + icon on badges and ticks).
- Focus is visible and trapped inside dialogs, drawers and sheets; Escape closes; focus returns
  to the opener.
- Errors are announced (`role="alert"`), placed next to the field, and always retryable.
- Loading is a skeleton with reserved height; empty states carry an action.
- Bulk actions show the count in the verb ("Resend 12"), cap selection at 200, show progress.
- Toasts are transient (3–8 s) and never carry decisions; decisions use ConfirmDialog with impact rows.
- Targets ≥ 32 px with ≥ 8 px gaps; tables scroll inside a wrapper; sheets use `100dvh`.
- Copy: sentence case, verbs on buttons, no "OK", numbers with tabular figures.
- One presentation language: every value and every record is drawn by `Render`, at the density the
  place calls for — a person reads as a person in a cell, a drawer and a picker row alike.

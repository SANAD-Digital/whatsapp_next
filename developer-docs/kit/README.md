# `sanad.ui` component kit — reference

`sanad.ui` is the Desk component kit this app is built from: drawers, list renderers, filter bars,
dialogs, pickers, editors. It lives in `whatsapp_next/public/js/ui/` and is written to be
**portable**: no file in that folder knows which app hosts it, so the whole folder can be copied
into another Frappe v16 app and used there.

This page covers what all components share. Each component then has its own page (see the
[index](#component-index)).

## The portability rule

- Nothing under `public/js/ui/` may contain the string `whatsapp_next`: no imports from the app,
  no dotted method paths, no app routes. Components name server methods by **key**
  (`"messages.get_conversation"`); the host app maps each key to a method (see
  [Server calls](#how-the-kit-calls-the-server)).
- App-level choices (default country, role lists, routes, the group DocType) arrive through
  `sanad.ui.config.defaults`, not constants. There are exceptions:
  - ConversationDrawer hardcodes its default roles (`WhatsApp Agent`, `WhatsApp Manager`).
  - FunctionDetail defaults to the ERPNext party types.
  - Render's built-in kind map names ERPNext DocTypes.

  None of these imports app code, but review them when you copy the kit.
- `whatsapp_next/tests/test_kit_portability.py` enforces the rule. It checks:
  - no file under `public/js/ui/` references `whatsapp_next`;
  - every component folder has `index.js`, `style.scss` and a `README.md` with `## Usage`, a code
    snippet, `## Live use` and `## Design gate`;
  - `index.js` assigns `sanad.ui.<Folder> = …`;
  - the barrel `ui/index.js` imports every `./<Name>/index.js` and `ui/style.scss` imports every
    `./<Name>/style`;
  - no hex, `rgb()` or `hsl()` colours and no physical `left/right` properties in kit SCSS;
  - `label:` / `title:` / `description:` / `placeholder:` string literals go through `__()`.

  Run it with `bench --site whatsapp.dev.sanad.digital run-tests --module whatsapp_next.tests.test_kit_portability`.

**One known dependency outside the folder:** the kit's SCSS draws with the product palette
(`--wa-bg`, `--wa-surface`, `--wa-ink-*`, `--wa-pri*`, `--wa-ok|wn|dg|nf-*`, `--wa-shadow-*`, and
others). There are about 1,000 `var(--wa-…)` references and almost none have a fallback. The palette
is defined in `whatsapp_next/public/scss/_tokens.scss`, not in the kit, so copy that file too (see
[Copying the kit](#copy-the-kit-into-another-app)).

## Including the kit

The kit comes in one Desk bundle. In this app it is `public/js/whatsapp_next.bundle.js`:

```js
import "./ui/index.js";              // the barrel: _core, _kit, then every component
import "./whatsapp_next_setup.js";   // sanad.ui.configure({...}) — API keys, defaults, renderers
import "./screens/console.js";       // app screens that use the kit
```

and `public/scss/whatsapp_next.bundle.scss`:

```scss
@import "tokens";           // the --wa-* palette and the Espresso bridge
@import "../js/ui/style";   // _kit, _core, then every component's style.scss
```

`hooks.py` loads both on every Desk page (`app_include_js = ["whatsapp_next.bundle.js"]`,
`app_include_css = ["whatsapp_next.bundle.css"]`).

Every component registers itself on the global namespace `sanad.ui` (created with
`frappe.provide("sanad.ui")`). Page, list and form scripts use it directly, often through an alias:

```js
const ui = sanad.ui;
new ui.Drawer({ doctype: "WhatsApp Log", name, mode: "record" }).show();
ui.Toast.success(__("Saved"));
```

Barrel order matters: `_core` and `_kit` come first, then foundations (`Render`, `Cards`,
`StatusBadge`, `EmptyState`, `Toast`, `ConfirmDialog`), then list helpers, inputs, list renderers,
panels, and last `ContactPicker`. Components that use other components expect them to be registered
already.

## How the kit calls the server

```js
sanad.ui.call(key, args = {}, { silent = false, freeze = false, freeze_message } = {}) // → Promise<r.message>
```

- `sanad.ui.api(key)` resolves the key through `sanad.ui.config.api`. A dotted path with three or
  more segments (`frappe.client.get_value`) passes through unchanged. An unmapped short key
  **throws** `sanad.ui: API method '<key>' is not configured`.
- A failure rejects with an `Error` built by `sanad.ui.error_from(r)`. It carries `message` (the
  server's own `_server_messages`, or "You are offline" / "Something went wrong. Please try
  again."), plus `exc_type` and `http_status`.
- A few components call Frappe core methods through `frappe.xcall` instead: `TreeGroupBy` (group-by
  counts), `DashboardBlock` (Number Card / Dashboard Chart / report endpoints) and `AlertEditor`
  (`frappe.desk.query_report.get_script`).

The host registers its keys once, with `sanad.ui.configure`. This app does it in
`public/js/whatsapp_next_setup.js`, which builds every key as `area.fn` →
`whatsapp_next.api.v1.<area>.<fn>`:

```js
const V1 = "whatsapp_next.api.v1";
const areas = { messages: ["get_conversation", "resend", /* … */], picker: [/* … */], /* … */ };
const api = {};
Object.entries(areas).forEach(([area, fns]) => fns.forEach((fn) => (api[`${area}.${fn}`] = `${V1}.${area}.${fn}`)));

sanad.ui.configure({
  api,
  defaults: {
    roles: { quick_send: [/* roles */], confirm: [/* roles */] },
    country: "SA",
    group_doctype: "WhatsApp Contact Group",
    contact_link_doctypes: ["Customer", "Supplier", "Employee"],
    simulator_route: "wa-simulator",
    devices_route: "wa-devices",
    contacts_route: "wa-contacts",
  },
  renderers: { doctypes: { /* DocType → kind */ }, profiles: { /* DocType → field roles */ } },
});
```

`configure(opts)` merges into the existing config: `api` and `defaults` are shallow-merged, and
`renderers` is merged and then passed to `sanad.ui.Render.configure` (see [Render](Render.md)).
Each component page lists the keys it calls and the arguments it sends. Several components also
accept a per-instance `api` override.

## Shared helpers

### `_core` — on `sanad.ui`

| Helper | What it does |
|---|---|
| `configure(opts)`, `config` | Host configuration: `api`, `defaults`, `renderers` |
| `api(key)`, `call(key, args, opts)`, `error_from(r)` | Server calls (see above) |
| `escape(v)` | `frappe.utils.escape_html`; `null` becomes `""`. Escape every value you interpolate into HTML |
| `icon(name, size, cls)` | Espresso / Frappe icon (`frappe.utils.icon`) |
| `icons` | Standard icons for common verbs: `quick_send`, `conversation`, `resend`, `cancel`, `open`, `edit`, `remove`, `link`, `more` |
| `is_rtl()` | Current direction |
| `uid(prefix)` | Random DOM id |
| `debounce(fn, 250)`, `throttle(fn, 1000)` | Frappe's debounce and throttle |
| `plural(n, forms)` | Picks the CLDR plural category (`Intl.PluralRules`; Arabic has six) and fills `{0}` |
| `format_int(n)` | Integer with locale grouping ("3,540") |
| `initials(text)` | Avatar initials |
| `on_list_render(listview, fn)` | Runs `fn` after every `render_list`; returns an unsubscribe function |
| `bind_list_realtime(listview, event, 2000)` | Throttled list refresh on a realtime event, only while that list is the current route |
| `visible_actions(actions, doc, doctype)` | Filters action specs by `roles`, `perm` and `condition(doc)`; shared by RowActions, BulkActions, Drawer and ConversationDrawer |
| `overlay.open(inst)` / `overlay.close(inst)` | Allows one drawer or panel at a time; opening one hides the previous |
| `roving_index(e, items, i)` | RTL-aware arrow, Home and End navigation |
| `tone(colour)`, `indicator_for(doctype, doc)` | Maps a Frappe indicator colour to a `.sanad-tone--*` tone; returns a document's `{label, colour, tone}` |
| `announce(text, {assertive})` | Writes to a shared `aria-live` region without moving focus |
| `trap_focus($root)` | Keeps Tab inside a drawer or sheet; returns a release function |
| `skeleton(rows, {lines})` | Skeleton markup for loading states |
| `meta.with_doctype`, `meta.preview_fields`, `meta.is_layout`, `meta.format` | DocType meta helpers |
| `docname_of_row($row)` | Docname of a Desk list row |

### `_kit` — the prototype's control layer (also on `sanad.ui`, and as `sanad.kit`)

| Helper | Returns |
|---|---|
| `btn({label, icon, variant, size, block, disabled, title, attrs, cls})` | `<button class="wa-btn wa-btn--{primary\|secondary\|danger\|ghost\|tonal}">`. With `icon` and no `label` it is an icon-only square, and `title` becomes its `aria-label` |
| `badge(label, tone, {dot, icon})` | `.wa-badge--{ok\|warn\|danger\|info\|muted\|pri}` |
| `segmented(options, value, {label, name})` + `bind_segmented(el, on_pick)` | A `role="radiogroup"` segmented control with arrow-key selection |
| `rule(label, note)` | A form-section rule |
| `avatar({name, text, src, size, square})`, `initials(name)` | An avatar |
| `ico(name, size, cls)`, `ICONS`, `ICON_NAMES` | The prototype's SVG icon set (`currentColor`). An unknown name returns `""` |
| `TONES`, `VARIANTS` | The allowed tone and variant names |

Component-level helpers that other components reuse: [Toast](Toast.md) (the only way to notify),
[EmptyState](EmptyState.md) (loading, empty, error and offline panes), [StatusBadge](StatusBadge.md),
[ConfirmDialog](ConfirmDialog.md) (every decision) and [Render](Render.md) (every value and record).

## Theming

- **Tokens.** Components use Espresso variables (`--surface-*`, `--ink-*`, `--outline-*`) and
  the kit's own tokens:
  - `_core/style.scss`: `--sanad-gap-*`, `--sanad-radius*`, `--sanad-target`, `--sanad-row-h`,
    `--sanad-ctl-h*`, `--sanad-accent*`, `--sanad-motion`, and tone classes `.sanad-tone--*`;
  - `_kit/style.scss`: density on `.wa` / `.wa--compact`, which set `--wa-h`, `--wa-fs`,
    `--wa-px`, `--wa-radius` and `--wa-motion`.

  Colours come from the `--wa-*` palette.
- **The bridge.** `public/scss/_tokens.scss` redefines the Espresso variables to palette values,
  but only on this product's own surfaces: its Pages (`#page-wa-*`), `WhatsApp *` forms,
  `.modal.sanad-sheet`, `.sanad-sw`, `.sanad-ae-layer` and `.sanad-op`. Desk lists keep Desk
  colours even when a kit component is mounted inside them.
- **Dark mode.** `_tokens.scss` defines the palette twice: in `:root` and in
  `[data-theme="dark"]`. That is Desk's own theme switch, so no component needs dark-mode rules.
- **Reduced motion.** `prefers-reduced-motion` sets `--sanad-motion` and `--wa-motion` to `0ms`.
- **RTL.**
  - Layout uses logical properties only; the test rejects physical `left` and `right`.
  - Frappe builds a second, rtlcss-flipped stylesheet (`dist/css-rtl/`), and rtlcss already flips
    `translateX` / `translate()`. **Never write a `[dir="rtl"]` transform override for a
    translate**: it flips twice, and the panel ends up off-centre or off-screen. Write the
    transform for LTR only. Centre modals with `inset: 0; margin: auto`, and make the open state
    `transform: none !important`.
  - The existing `[dir="rtl"]` rules only mirror glyphs (`scaleX(-1)` or `rotate`), gradients and
    inset shadows. If you add one, check the Arabic build.
  - JS positioning (AttachMenu, Drawer menus) uses `sanad.ui.is_rtl()`.

## Accessibility conventions

- Colour is never the only signal: badges and ticks carry a label or an icon.
- Dialogs, drawers and sheets trap focus (`trap_focus`), close on Escape, and return focus to the
  element that opened them. Only one overlay is open at a time (`overlay`).
- Tab lists, segmented controls and menus use roving tabindex with arrow keys (`roving_index`),
  mirrored in RTL.
- Loading states show a skeleton with reserved height, never a spinner. Empty states offer an
  action. Errors use `role="alert"`, sit next to their cause, and can be retried.
- Status changes are announced with `sanad.ui.announce`. Toasts rely on Desk's alert container,
  which is already a live region. Toasts never carry a decision; decisions use ConfirmDialog.
- Targets are at least `--sanad-target` (32 px) with 8 px or more between them. Icon-only buttons
  have an `aria-label`. Hidden text uses `.sanad-visually-hidden`.
- Copy is sentence case and goes through `__()`. Counts use `plural()` and `format_int()`. Bulk
  verbs carry the count ("Resend 12").

## Copy the kit into another app

1. Copy `whatsapp_next/public/js/ui/` to `<your_app>/public/js/ui/`, whole (`_core/`, `_kit/`,
   `index.js`, `style.scss` and every component folder). To drop a component, remove both of its
   lines: the import in `index.js` and the `@import` in `style.scss`.
2. Copy `whatsapp_next/public/scss/_tokens.scss` to `<your_app>/public/scss/_tokens.scss`. Then
   edit its `$wa-surfaces` list so it names your own Page ids and form routes instead of
   `#page-wa-*` and `Form/WhatsApp `. Keep `.modal.sanad-sheet`, `.sanad-sw`, `.sanad-ae-layer` and
   `.sanad-op`.
3. Create `<your_app>/public/js/<your_app>.bundle.js`:
   ```js
   import "./ui/index.js";
   sanad.ui.configure({
     api: { "messages.get_conversation": "your_app.api.get_conversation" /* only keys you use */ },
     defaults: { country: "US" },
     renderers: { doctypes: { "Sales Invoice": "document" } },
   });
   ```
   and `<your_app>/public/scss/<your_app>.bundle.scss`:
   ```scss
   @import "tokens";
   @import "../js/ui/style";
   ```
4. In `hooks.py`: `app_include_js = ["<your_app>.bundle.js"]` and
   `app_include_css = ["<your_app>.bundle.css"]`. Then run `bench build --app <your_app>`.
5. For each component that calls the server, implement whitelisted methods that return the shapes
   its page documents, and map its keys. Components with app-bound backends (flagged
   **Portability** on their pages) need the most work.
6. Copy `tests/test_kit_portability.py`, change the app name, and run it. This keeps your copy
   portable.

No npm packages, build config or Vue are needed.

## Component index

"Live use" lists the places in this app that construct or call the component. Paths are relative
to `whatsapp_next/`: `page/<x>` means `whatsapp_next/page/<x>/<x>.js`, and `listview/`, `form/` and
`screens/` are under `public/js/`.

| Component | What it is | Live use |
|---|---|---|
| [AlertEditor](AlertEditor.md) | Scheduled-alert editor: when · what · to whom · from, with live preview and test send | `screens/alerts.js` |
| [AttachMenu](AttachMenu.md) | The composer's "+" menu: image, video, document, voice note, location, contact card | `page/wa_simulator`, inside BulkSend |
| [BulkActions](BulkActions.md) | Actions on a list selection, with the count in the verb and progress | `screens/messages.js`; Campaign, Command and Number lists |
| [BulkSend](BulkSend.md) | Bulk-message window: groups, contacts, numbers, settings, preview, send | `page/wa_simulator` |
| [Cards](Cards.md) | The prototype's card set: `stat`, `kpi`, `panel`, `alert` | `page/wa_functions_center` |
| [ChatThread](ChatThread.md) | Message bubbles, ticks, day separators | `page/wa_simulator`; ConversationDrawer, TemplateEditor, CommandEditor, FunctionDetail |
| [Collection](Collection.md) | Rows as a table, list, cards, gallery or timeline, with a view switch | Drawer (activity history) |
| [CommandEditor](CommandEditor.md) | Command editor: setup, per-type lists, live dry-run | `form/whatsapp_command.js`; FunctionDetail |
| [ConfirmDialog](ConfirmDialog.md) | Decision dialog with impact rows, reason and acknowledgement | ~20 forms, lists, screens and pages |
| [ContactPicker](ContactPicker.md) | Multi-source recipient picker with duplicate flags and an add/remove confirm | `form/whatsapp_contact_group.js`, `screens/alerts.js`, `screens/campaign/audience.js`, `screens/campaign/builder.js` |
| [ConversationDrawer](ConversationDrawer.md) | One thread across both directions, live | `screens/numbers.js`, `form/whatsapp_log.js`, Number list, `page/wa_contacts` |
| [DashboardBlock](DashboardBlock.md) | Custom HTML Block that renders Number Cards and Dashboard Charts | `fixtures/custom_html_block.json` (Workspace block) |
| [DataList](DataList.md) | The prototype's data table over a Desk ListView: sortable headers, typed cells, pager | 7 list views, `screens/messages.js`, `screens/campaign/audience.js`, `page/wa_contacts`, `page/wa_functions_center` |
| [DateFilter](DateFilter.md) | Date and range picker with presets (`DateFilter`, `DateFilterSet`) | FilterBar |
| [Drawer](Drawer.md) | Record, form or choice side panel; records read as documents | `screens/messages.js`, Inbound list, `page/wa_contacts`, `page/wa_functions_center` |
| [EmptyState](EmptyState.md) | Loading, empty, error and offline panes | Most pages and components |
| [FilterBar](FilterBar.md) | Tabs, selects, dates and search bound to a list | Same places as DataList |
| [FunctionDetail](FunctionDetail.md) | Function window: details, version log, dry-run | `page/wa_functions_center` |
| [ListStatsCard](ListStatsCard.md) | Stat cards above a list, with a detail modal | Inbound list; PageHeader |
| [MessageComposer](MessageComposer.md) | Editor for the ordered messages a record sends: rail, editor, preview | `screens/campaign/messages.js` |
| [MetaDialog](MetaDialog.md) | Tabbed dialog built from DocType meta | **No live use** |
| [OverlayPanel](OverlayPanel.md) | The prototype's overlay panel for forms (modal or drawer) | `page/wa_contacts`, `page/wa_functions_center`, `page/wa_simulator` |
| [PageHeader](PageHeader.md) | Screen header above a list or page: title, primary action, KPI row, banner | 8 list views, `page/wa_home`, `page/wa_devices`, `page/wa_contacts`, `page/wa_functions_center` |
| [PagedChildTable](PagedChildTable.md) | Paged read-only table in place of a large child grid | `form/whatsapp_contact_group.js` |
| [PhoneField](PhoneField.md) | Phone input with country and E.164 preview | `page/wa_devices`, `page/wa_onboarding`, `page/wa_simulator`, `screens/campaign/messages.js`; QuickSend, OverlayPanel, ContactPicker |
| [QuickSend](QuickSend.md) | One-message composer dialog | 11 places (forms, lists, screens, pages) |
| [Render](Render.md) | Presentation layer for values, records and links at several densities | `screens/messages.js`, Inbound list, `page/wa_contacts`, `page/wa_home`; DataList, Drawer, Collection |
| [RowActions](RowActions.md) | Per-row overflow menu and row click | 7 list views |
| [SettingsWindow](SettingsWindow.md) | Settings window: search, sections, rows | `screens/settings.js` |
| [StatusBadge](StatusBadge.md) | Status pill coloured by the DocType's indicator | Most lists and screens |
| [Stepper](Stepper.md) | Multi-step flow with "Step n of m" | `page/wa_devices`; ContactPicker Excel source |
| [TemplateEditor](TemplateEditor.md) | Variables sidebar, sample picker and live preview | `form/whatsapp_template.js` |
| [Toast](Toast.md) | Tone and timing wrapper over `frappe.show_alert` | Almost everywhere |
| [TreeGroupBy](TreeGroupBy.md) | Sidebar group-by with counts | **No live use** |

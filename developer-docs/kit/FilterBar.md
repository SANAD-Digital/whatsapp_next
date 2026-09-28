# `sanad.ui.FilterBar`

The prototype's one-row toolbar, above a Desk list or on a custom page. It lays out, in this order:

- a search box
- one dropdown button per filter: a checkbox or radio popover whose options come from meta, a Link target, or the caller
- at the inline end, a cluster holding the period control or the full date filter, the actions (Group by, Columns, Export) and Desk's own Filter button
- status pills (`tabs`) on a row below
- an optional one-line intro above

**List mode.** The bar hides Frappe's standard filter fields and moves Desk's Filter button into its cluster. Every change is written into `listview.filter_area`, so saved views and the URL stay the source of truth, and the list refreshes once per change. The search box adds `or_filters` by wrapping `listview.get_args`. Filters the bar does not own show up as removable chips.

**Page mode.** The bar only reports through `on_change(filters, extra)`.

On desktop the toolbar stays on one line. Filters that do not fit move behind a **More** button, and action icons that do not fit move behind a **…** button. Under 768 px the bar becomes a **Filters** button that opens a sheet, and each filter's options open in a bottom drawer.

**Portability:** it needs only a DocType name. The `group_by` / `columns` actions need a kit `DataList`, which it finds from `opts.datalist` or `listview._sanad_datalist`. The `date` preset needs `DateFilter` / `DateFilterSet`.

## Options

| Option | Type | Default | Meaning |
|---|---|---|---|
| `listview` | ListView | — | List mode. |
| `page` | `frappe.ui.Page` | — | Page mode. The bar is prepended to `page.main` when there is no `wrapper`. |
| `wrapper` | jQuery \| HTMLElement | — | Explicit mount point. The default is the start of `listview.$frappe_list`, or `page.main`. |
| `doctype` | string | `listview.doctype` | The meta source. The constructor throws if it is missing. |
| `presets` | Array | `[]` | The filters, described below. Presets render grouped by type, not in array order. |
| `actions` | string[] | `[]` | Any of `"group_by"`, `"columns"` and `"export"`. `export` is list mode only. |
| `intro` | string | — | A paragraph above the toolbar. |
| `replace_standard_filters` | boolean | `true` | List mode: hide Desk's standard filter row and adopt Desk's Filter button into the cluster. |
| `on_change` | `(filters, {or_filters, values, search}) => void` | — | Fired on every change, in both modes. |
| `datalist` | DataList \| `() => DataList` | — | The table that `group_by` / `columns` drive in page mode. |
| `debounce` | number (ms) | `300` | Search debounce. |
| `max_inline` | number | `4` | How many `select` / `daterange` presets are rendered. Presets beyond this number are **not rendered at all**, so on a list they are reachable only through Desk's Filter popover. |

Preset spec, where `type` defaults to `"select"`:

| `type` | Keys | Filter produced |
|---|---|---|
| `search` | `fields` (default: `name`, the title field and meta `search_fields`), `label`, `placeholder` | `or_filters`: `[doctype, f, "like", "%txt%"]` for each field |
| `select` | `fieldname`, `label`, `options`, `multiple` (default `true`) | `in` (a multiple select always stores an array), `=` when `multiple: false` |
| `tabs` | `fieldname`, `label`, `options`, `all_label` (default "All") | `=`. The pills are a `radiogroup` on their own row. |
| `period` | `fieldname` (default `creation`), `label`, `options: [{value: days\|"30d"\|"today"\|"all"\|null, label}]`, `default` | `>= today − N days`. The default buttons are Today · 7 days · 30 days · All. |
| `daterange` | `fieldname`, `label` | `Between`, using Frappe's own `DateRange` control |
| `date` | `fieldname`, `label`, `default_op`, `date_fields` (strings or `{value, label}`), `fields: false` | `Between`, `>`, `>=`, `<` or `<=` for each field. A Datetime field gets `00:00:00` / `23:59:59` or the chosen times. |

Options for `select` / `tabs` are resolved in this order:

- `options` given as an array of strings, numbers or `{value, label}`, or as `(txt) => Promise<array>`
- a Check field gives Yes / No
- a Select field gives its meta options
- a Link field searches its target with `frappe.db.get_list`, 20 rows by `modified desc`, and uses the title field when `show_title_field_in_link` is set

Fetched lists are cached per search text. A popover gets a search box when its options are fetched, or when there are more than 8 static options.

`date` defaults: the field list is every visible Date / Datetime field plus `creation` / `modified`. It starts on the preset's `fieldname`, otherwise meta `sort_field`, otherwise the first field. With `fields: false`, or when `DateFilterSet` is missing, the bar mounts a single `DateFilter`. When `DateFilter` itself is missing, it falls back to `period`.

## Methods

- `set(fieldname, value)` sets or clears one preset (`null`, `""` or `[]` clears it), writes it to the list, and emits.
- `set_search(text, fields)` applies the search.
- `clear()` clears every own value, every extra list filter and the search, then refreshes once and announces "Filters cleared.".
- `sync()` re-reads `filter_area` into the buttons and pills, mapping `=` / `in` back to checked options and `>=` back to a period. It also redraws the extra chips.
- `get_filters()` returns the Frappe filter tuples. `get_or_filters()` returns the search `or_filters`. `filter_of(fieldname, value)` returns the tuple for one preset.
- `remove_filter(fieldname)` drops a filter the bar does not own (list mode).
- `export()` opens Desk's `DataExporter` over the checked rows or the current filters.
- `open_filter_sheet()` opens the phone sheet. `relayout()` re-fits the toolbar.
- `destroy()` closes the popovers, removes the document handlers and removes the bar.

## Events and callbacks

- `on_change` is described under Options.
- In list mode the bar wraps `listview.on_filter_change` (then calls `sync()`) and `listview.get_args` (adds `or_filters`). It sets `listview._sanad_filterbar` and adds `sanad-hide-page-form` to the page wrapper.
- It uses `ui.on_list_render` to re-label the Group by button.
- Handlers `mousedown`/`touchstart`/`keydown.<id>` on `document` close the popovers on an outside click or Escape.
- A `ResizeObserver` on the toolbar, plus `resize.<id>` on `window`, re-run the fit.
- It announces through `ui.announce` and subscribes to no realtime events.

## Server calls

| Call | Args | When |
|---|---|---|
| `frappe.db.get_list(link_target, …)` | `fields: [name, title?]`, `like` filter on the title or name, `limit 20` | opening or searching a Link `select` without `options` |
| `listview.refresh()` | — | once per change in list mode |
| `frappe.require("data_import_tools.bundle.js")` → `DataExporter` | filters | the `export` action |

It makes no `ui.call`.

## Usage

```js
new sanad.ui.FilterBar({
  listview,
  actions: ["group_by", "columns", "export"],
  presets: [
    { fieldname: "campaign_name", type: "search", fields: ["campaign_name", "owner"] },
    { fieldname: "status", type: "select" },
    { fieldname: "device", type: "select" },
    { fieldname: "started_at", type: "date", label: __("Start"), default_op: "between" },
  ],
});

// page mode
new sanad.ui.FilterBar({
  page, wrapper: $toolbar, doctype: "WhatsApp Function",
  presets: [{ fieldname: "category", type: "select", options: cats }],
  on_change: (filters, { or_filters }) => load(filters, or_filters),
});
```

## CSS hooks

- **Root:** `.sanad-filterbar`, plus `--list` in list mode. It has `role="group"`.
- **Layout:** `__intro` and `__row--toolbar`, containing `__main` (the search and filters) and `__end` (holding `__period`, `__datefilter` (`--set`) and `__actions`). The pills go in `__row--tabs` / `__pills`.
- **Filter buttons:** `__dd`, containing `__btn`, which holds `__btn-label`, `__btn-value`, `__btn-clear` and `__chevron`. `__btn--active` marks a button with a value set.
- **Popovers:** `__pop` (with `--more`, `--amore`, `--levels` and `--columns`), containing `__pop-head`, `__pop-search`, `__pop-list`, `__opt`, `__pop-foot` and `__pop-empty`.
- **Overflow:** `__more` / `__more-count`, `__hidden`, `__amore-item` / `__amore-label`, and `__native` (Desk's adopted Filter section).
- **Extra filters and clear:** `__chipfilter` (with its `-label`, `-value` and `-x` parts) and `__clear`.
- **Actions:** `__action`, `--icon`, `--group` and `--active`, plus `__levels`, `__level*` and `__column`.
- **Phone:** `__mobile-toggle`, `__mobile-count` and `.sanad-filter-sheet*` (the sheet rows). The bottom drawer is `.sanad-optsheet` (`--in`, `__scrim`, `__panel`, `__list`, `__done`).
- **Page:** `.sanad-hide-page-form` on the page wrapper keeps Desk's `page_form` row hidden.

## Notes

- **Loading and errors:** loading inside a popover is a skeleton (`ui.skeleton`). Fetch errors render an EmptyState error with a Retry button. The empty copy is "No match for {0}" or "No options".
- **Keyboard and ARIA:**
  - Buttons carry `aria-haspopup="dialog"`, `aria-expanded` and `aria-controls`.
  - ArrowDown opens a popover. Arrows, Home and End move between options.
  - Escape or an outside click closes the popover and returns focus to its button.
  - Pills use a roving `tabindex`.
- **Chosen values stay listed:** a chosen value remains in the popover even when the search text hides it.
- **Period default:** `period.default` applies once, and only when the field has no value and there are no `frappe.route_options`.
- **Preserved popover state:** the column and level popovers re-render through `keeping_place()`, which keeps their scroll position and focus. The column order is frozen while the picker is open.
- **Clean-up caveats:**
  - `destroy()` removes only the `document` handlers. It does not disconnect the `ResizeObserver` or the `resize.<id>` handler on `window`.
  - Nothing restores the wrapped `get_args` or `on_filter_change`.
- **Live use outside the kit:**
  - `public/js/listview/`: `whatsapp_campaign_list.js`, `whatsapp_command_list.js`, `whatsapp_contact_group_list.js`, `whatsapp_notification_alert_list.js`, `whatsapp_notification_list.js`, `whatsapp_number_list.js`, `whatsapp_template_list.js`
  - `public/js/screens/messages.js` (`message_list`, which serves the Outbound, Inbound and Queue lists)
  - `public/js/screens/campaign/audience.js` (page mode)
  - `whatsapp_next/page/wa_contacts/wa_contacts.js`
  - `whatsapp_next/page/wa_functions_center/wa_functions_center.js` (page mode)

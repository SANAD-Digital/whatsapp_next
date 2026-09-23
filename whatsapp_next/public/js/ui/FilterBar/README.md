# FilterBar

One toolbar above a Desk list or a custom page, in the prototype's order: **search** first,
then **selects** / a **date range**, then **period** pills (All · Today · 7 days · 30 days), with
the status **tabs** (pills) on their own row below, and an optional one-line **intro**. On a
list view it replaces Frappe's standard-filter fields (`replace_standard_filters`, default true —
the Filter popover, the sort selector and the applied-filter chips stay) and every control writes
into the list's own `filter_area` (saved views and the URL stay the source of truth); the search
box adds `or_filters` over the meta search fields through `listview.get_args`. On a page it only
calls `on_change(filters, extra)`. Options come from meta (Select options, Check → Yes/No, Link →
a Link control) unless the preset supplies them. Portable: needs only a DocType name.

## Usage

```js
// Desk list (in listview_settings.onload) — one row: search → dropdown filters → period control
new sanad.ui.FilterBar({
  listview,
  intro: __("Everything sent from your devices: status, document, device and errors."),
  actions: ["group_by", "export"],                 // optional second row
  presets: [
    { fieldname: "phone_e164", type: "search", fields: ["phone_e164", "display_name"], placeholder: __("Search…") },
    { fieldname: "status", type: "select" },                       // Select → multi-select checkboxes (→ `in`)
    { fieldname: "device", type: "select" },                       // Link → searched server-side (title field when shown)
    { fieldname: "is_simulated", type: "select" },                 // Check → Yes / No
    { fieldname: "source_type", type: "select", multiple: false }, // single choice (→ `=`)
    { fieldname: "error_code", type: "select",                     // Data → caller-supplied options (array or (txt) => Promise)
      options: (txt) => frappe.db.get_list("ToDo", { fields: ["priority"], group_by: "priority" }).then((r) => r.map((x) => x.priority)) },
    { fieldname: "creation", type: "period", default: "30d" },     // Today · 7 days · 30 days · All → `>=`
    // still available for other lists:
    { fieldname: "kind", type: "tabs" },                           // pill row below the toolbar
    { fieldname: "received_at", type: "daterange" },               // → `Between`
  ],
});

// Custom page
const bar = new sanad.ui.FilterBar({
  page, doctype: "ToDo", presets: [...],
  on_change: (filters, { or_filters, values, search }) => load(filters, or_filters),
});
```

Options: `listview` | `page` (+ `doctype`), `wrapper`, `intro`, `actions` (`"group_by"` mounts a
`TreeGroupBy` rail on a chosen preset field, `"export"` opens Desk's own Data Export dialog over
the checked rows or the current filters), `replace_standard_filters` (default true),
`presets[]` (`fieldname`, `type` = `select` (default) | `tabs` | `daterange` | `search` | `period`,
`label`, `options` — strings, `{value, label}` objects or `(txt) => Promise<…>`; for `period`:
`[{value: days | null, label}]`, `multiple` (select, default true), `default` (period:
`"30d"` / `"7d"` / `"today"` / `"all"`), `all_label`, `fields` / `placeholder` for search),
`on_change`, `debounce`. Presets render by type in the prototype order regardless of array order.
Methods: `set(fieldname, value)`, `set_search(text, fields)`, `sync()` (re-read the list's
filters, incl. mapping an `in` filter back to checked boxes), `get_filters()`,
`get_or_filters()`, `group_by(fieldname)`, `export()`, `clear()`, `destroy()`.

## Widths: one line, then "More"

The toolbar is **one line at every desktop width**. It is not wrapped to a second line and it is
not squeezed: filter buttons that do not fit are hidden from the end and counted on a **More**
button, which opens them as a list of fields — each naming what is chosen and opening its own
options in place, with a search box where the list is long. If every filter is already behind
`More` and the row is still short, the action icons start moving into a **…** menu of their own
(they are lent to it and handed back, so each keeps its own popover).

The measurement is the browser's: the row is allowed to wrap in CSS and items are hidden until
nothing has wrapped, which is checked by **vertical overlap**, not `offsetTop` — the row centres
its items, so a short button sits a few pixels lower than a tall one on the very same line. That
detail is what made two earlier attempts (D-072, D-075b) hide a toolbar that fit perfectly.
`ResizeObserver` re-runs it, once per frame.

## Phones: a drawer off the bottom edge

Under 768 px the filters collapse behind one **Filters** button carrying the number that is set.
Its sheet is a list of fields, and tapping one raises that filter's options in a **drawer off the
bottom of the screen** — around half the height, growing to 88 % as the list needs it, scrolling
inside itself, with 48 px rows, its own search when the list is long, `Clear`, and a `Done` that
only dismisses (choices apply as they are made). The scrim, Escape and Done all close it. It is the
same option list the desktop popover and `More` use — one implementation, three hosts.

## Live use
Outbound list — `public/js/listview/whatsapp_log_list.js` (status tabs, device, source, campaign,
reference DocType, period, search, simulated); Inbound list —
`public/js/listview/whatsapp_inbound_message_list.js` (matched tabs, command, contact, device,
period, search).

## Design gate
Applied from the phase-5 audit, the owner's review of the real Outbound list against the
prototype (`docs/component/Toolbar.dc.html`) and the WCAG 2.1 AA review:
- **One row like the prototype**: search (~300 px, icon) → one dropdown button per filter
  (label + chevron, 32 px outline; `Label: value` / `Label: N` and the active tone when set) →
  segmented period control at the inline-end (Desk `.btn-group`, the active segment
  `btn-primary`); wraps only on narrow widths. Desk's standard-filter grid is hidden (the Filter
  popover and the sort selector stay), so there is no duplicate filter UI.
- **Multi-select popovers** with native checkboxes (`accent-color: --ink-blue-3`, 32 px rows,
  hover `--surface-gray-2`), a title row with ×, a search box for Link targets or > 8 options,
  "Clear" in the footer; each toggle applies immediately (`in`, single → `=`). Chosen values stay
  listed even when a search hides them.
- ARIA: buttons `aria-haspopup="dialog"` / `aria-expanded` / `aria-controls`; the popover is a
  `role="dialog"` with the option list as a `role="group"` under a visually-hidden legend; arrows /
  Home / End move between options, Space toggles, Escape and outside click close and focus returns
  to the button (WCAG 2.1.1, 2.4.3, 4.1.2). Status pills (`tabs`) stay a `role="radiogroup"` with
  manual activation (3.2.2). Every control has an accessible name.
- Loading inside a popover is a skeleton, errors show Retry (EmptyState); "No match for {0}" /
  "No options" empty copy.
- Second row "Group by ▾" / "Export" reuse the kit (`TreeGroupBy`) and Desk (`DataExporter`)
  instead of new UI; the group-by rail is a chip rail with counts.
- Reserved bar height, `--sanad-gap-*` spacing, global kit focus ring, full-width search and a
  wrapping toolbar under 768 px; announcements are sentences ("Filters cleared.").

# FilterBar

A compact preset bar above a Desk list or a custom page: status **tabs**, **selects**, a **date
range** and a **search** box. On a list view every control writes into the list's own
`filter_area` (so Frappe's filter UI, saved views and the URL stay the source of truth) and the
search box adds `or_filters` over the meta search fields through `listview.get_args`. On a page it
only calls `on_change(filters, extra)`. Options come from meta (Select options, Check → Yes/No,
Link → a Link control) unless the preset supplies them. Portable: needs only a DocType name.

## Usage

```js
// Desk list (in listview_settings.onload)
new sanad.ui.FilterBar({
  listview,
  presets: [
    { fieldname: "status", type: "tabs" },                                   // options from meta + "All"
    { fieldname: "command_status", type: "tabs",
      options: [{ value: ["Matched", "Executed"], label: __("Matched") }, "Not Matched"] }, // array → `in`
    { fieldname: "device", type: "select" },                                 // Link → Link control
    { fieldname: "creation", type: "daterange", label: __("Period") },       // → `Between`
    { fieldname: "phone_e164", type: "search", fields: ["phone_e164", "display_name"] },
    { fieldname: "is_simulated", type: "select" },                           // Check → Yes / No
  ],
});

// Custom page
const bar = new sanad.ui.FilterBar({
  page, doctype: "ToDo", presets: [...],
  on_change: (filters, { or_filters, values, search }) => load(filters, or_filters),
});
```

Options: `listview` | `page` (+ `doctype`), `wrapper`, `presets[]` (`fieldname`, `type`,
`label`, `options`, `all_label`, `fields` / `placeholder` for search), `on_change`, `debounce`.
Methods: `set(fieldname, value)`, `set_search(text, fields)`, `sync()` (re-read the list's
filters), `get_filters()`, `get_or_filters()`, `clear()`, `destroy()`.

## Live use
Outbound list — `public/js/listview/whatsapp_log_list.js` (status tabs, device, source, campaign,
reference DocType, period, search, simulated); Inbound list —
`public/js/listview/whatsapp_inbound_message_list.js` (matched tabs, command, contact, device,
period, search).

## Design gate
Applied from the phase-5 audit (`ui-ux-pro-max` ux domain, WCAG 2.1 AA review, UX-copy review):
- Status presets are filters, not tabs: rendered as a `role="radiogroup"` of `.sanad-chip`
  buttons with `role="radio"` / `aria-checked` (WCAG 1.3.1, 4.1.2). Arrow / Home / End only move
  focus (`sanad.ui.roving_index`, RTL-aware); Enter / Space applies — no list reload while
  merely moving focus (WCAG 3.2.2).
- Every select has a visually-hidden `<label for>`; the search box and Link / date controls
  carry `aria-label`s (2.4.6).
- One chip style from `_core` (`.sanad-chip`, 32 px targets, 8 px gaps — WCAG 2.5.8) and the
  global kit focus ring; no per-component focus or colour rules.
- "Clear filters" only appears when something is set; clearing is announced as a sentence.
- Reserved bar height (`min-height`) so the list does not jump while meta loads; spacing through
  `--sanad-gap-*` tokens; full-width fields under 768 px, chips scroll instead of wrapping the page.

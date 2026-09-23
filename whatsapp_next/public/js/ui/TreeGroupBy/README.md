# TreeGroupBy

A "group by" rail with live counts for one field. On a Desk list it calls
`frappe.desk.listview.get_group_by_count` with the list's current filters (minus this field) and
applies `= value` through `filter_area`; on a custom page it calls the host's `counts_method` and
reports `on_select(value, row)`. Labels are meta-driven (Link titles from the server, Select
options translated, Check → Yes / No, empty → "Not set"). Frappe 16 hides the list sidebar, so
the rail renders above the list as chips and collapses to a `<select>` under 768 px.

## Usage

```js
// Desk list
new sanad.ui.TreeGroupBy({ listview, group_by_field: "category" });

// Custom page — counts from an API key returning [{name, count, title?}]
new sanad.ui.TreeGroupBy({
  page, doctype: "Contact", group_by_field: "link_doctype",
  counts_method: "contacts.count_by_link_doctype",
  counts_args: () => ({ search: current_search }),
  on_select: (value) => reload({ link_doctype: value }),
});
```

Options: `listview` | `page` (+ `doctype`), `wrapper`, `group_by_field`, `label`,
`counts_method`, `counts_args()`, `on_select`, `show_all` (default true), `limit` (chips before
"N more", default 12). Methods: `refresh()`, `select(value | null)`, `destroy()`.
Counts refresh after every list render (wraps `listview.render_list`, shared with RowActions).

## Live use
Functions Center page (`category`), Contacts page (`link_doctype`) — mounted by those pages'
scripts; the list-mode path is exercised by the same class on any Desk list.

## Design gate
Applied from the phase-5 audit:
- Chips are `.sanad-chip` toggle buttons with `aria-pressed` inside a labelled `role="group"`;
  the count is visually a `.sanad-chip__count` and, for assistive technology, a visually-hidden
  "{0} records" sentence through `sanad.ui.plural` (no `aria-label` on a `<span>`, WCAG 1.3.1).
- Roving `tabindex` with `sanad.ui.roving_index` (arrows / Home / End, RTL-aware); the selection
  is announced as one sentence ("Grouped by Category: Sales").
- Counts refresh through the shared `sanad.ui.on_list_render` hook (one wrapper per list).
- Overflow button says "Show {0} more" / "Show less" (verb on the button); "Not set" and "All"
  are explicit entries.
- Loading is a skeleton in a reserved slot (never a spinner); errors show Retry (EmptyState);
  mobile gets a native `<select>` with the same entries and counts.

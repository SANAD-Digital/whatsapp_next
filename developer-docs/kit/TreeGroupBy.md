# `sanad.ui.TreeGroupBy`

A "group by" rail with live counts for one field.

- **On a Desk list**, it counts with `frappe.desk.listview.get_group_by_count`, using the list's current filters minus this field. Picking a value applies `= value` through `listview.filter_area`.
- **On a custom page**, it calls the host's `counts_method` and reports the pick through `on_select`.

Labels come from meta: Link titles from the count rows, Select values translated, Check shown as Yes / No, and an empty value as "Not set". On desktop the rail is a row of chips. Under 768 px it becomes a native `<select>`.

**Portability:** list mode needs only Frappe. Page mode depends on an API key the host provides that returns `[{name, count, title?}]`.

## Options

| Option | Type | Default | Meaning |
|---|---|---|---|
| `listview` | ListView | — | List mode. The count query reads its filters and the rail writes to its `filter_area`. |
| `page` | `frappe.ui.Page` | — | Page mode. The rail is prepended to `page.main` when no `wrapper` is given. Needs `counts_method`. |
| `wrapper` | jQuery \| HTMLElement | — | Explicit mount point. Without it, in list mode the rail goes after `.sanad-filterbar` in `$frappe_list`, or is prepended when there is no bar. |
| `doctype` | string | `listview.doctype` | The meta source for the field label and fieldtype. |
| `group_by_field` | string | — (required) | The field to group by. The constructor throws if it is missing. |
| `label` | string | the field's label | The rail's caption. |
| `counts_method` | string | — | API key called through `ui.call`. When set, it is used in list mode too. |
| `counts_args` | `() => Object` | — | Arguments for `counts_method`. |
| `on_select` | `(value \| null, row) => void` | — | Called after every selection. `null` means "All". |
| `show_all` | boolean | `true` | Adds an "All" entry carrying the total. |
| `limit` | number | `12` | Chips shown, not counting "All", before "Show N more". The `<select>` always lists everything. |

## Methods

- `refresh()` re-fetches the counts and re-renders. A second call while one is in flight returns the same promise.
- `select(value | null)` sets the selection, announces it, applies the list filter in list mode, and calls `on_select`.
- `current_value()` returns the value of this field's `=` filter in list mode, or the last selection in page mode.
- `destroy()` unhooks the list render hook and removes the rail.

## Events and callbacks

- `on_select(value, row)` is described under Options.
- The rail re-counts after every list render through `ui.on_list_render(listview, …)`. This is the shared `render_list` wrapper that RowActions and FilterBar also use.
- Each selection is announced through `ui.announce("Grouped by {0}: {1}")`.

## Server calls

| Call | Args | When |
|---|---|---|
| `frappe.desk.listview.get_group_by_count` (`frappe.xcall`) | `{doctype, current_filters, field}` | list mode without `counts_method`, on every refresh |
| `counts_method` (host key, `ui.call`) | `counts_args()` | whenever it is set |

Rows with `count === 0` are dropped.

## Usage

```js
// Desk list
new sanad.ui.TreeGroupBy({ listview, group_by_field: "category" });

// Custom page
new sanad.ui.TreeGroupBy({
  page, doctype: "Contact", group_by_field: "link_doctype",
  counts_method: "contacts.count_by_link_doctype",
  counts_args: () => ({ search: current_search }),
  on_select: (value) => reload({ link_doctype: value }),
});
```

## CSS hooks

- `.sanad-groupby` is the root. In list mode it also has `.sanad-groupby--list`, which adds inline padding and a bottom border.
- The chips row is `.sanad-groupby__label` followed by `.sanad-groupby__chips` (`.sanad-chip-row`). Each chip is `.sanad-groupby__chip` (`.sanad-chip`) with `aria-pressed` and `data-value`, and holds `.sanad-groupby__chip-label` and `.sanad-chip__count`.
- `.sanad-groupby__more` is the "Show N more" / "Show less" link.
- `.sanad-groupby__select` is the `<select>`, shown under 768 px while the chips are hidden.
- `.sanad-groupby__state` is the EmptyState slot.
- The root gets the `hidden` attribute when there is nothing to group, and `aria-busy` while loading.

## Notes

- **Loading and errors:** loading is a one-row `sm` EmptyState skeleton. Errors show an EmptyState error with a Retry button. With no rows, the whole rail is hidden instead of showing an empty panel.
- **Accessibility:** chips are toggle buttons inside a labelled `role="group"` and use roving `tabindex` through `ui.roving_index` (arrows, Home, End). Each chip's count also has a visually hidden sentence "{0} record(s)", built with `ui.plural`.
- **Setup:** meta is loaded with `ui.meta.with_doctype` before the first render, so the rail mounts asynchronously.
- **No live use in the app.** Nothing outside the kit constructs it, and FilterBar's `group_by` action now drives DataList grouping instead. The Live use section in `README.md`, which names the Outbound and Inbound lists, the Functions Center and Contacts, is stale.

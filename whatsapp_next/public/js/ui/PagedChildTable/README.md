# PagedChildTable

Replaces the native grid of a large child table (thousands of rows) with a paged, read-only
table fed by a configured API key that returns `{rows, total}`. The child data stays on the form
and the **field stays visible** (its label, description and the tab it lives in are kept — Frappe
hides a tab whose fields are all hidden); the component mounts inside the field's `.grid-field`
wrapper and hides only the native grid DOM (`.form-grid-container`, `.grid-footer`, custom grid
buttons) through a host class, so saving, printing and server logic are untouched. Columns default to the child DocType's `in_list_view` fields from
meta and are formatted through `frappe.format`; the `status` column (or any `status_field`)
renders as a StatusBadge coloured by the child DocType's indicator rules. Filter chips (options
from the Select field's meta), a search box, a toolbar for the caller's actions and per-row
actions are options. Loading / empty / error states come from EmptyState.

## Usage

```js
frappe.ui.form.on("Sales Order", {
  refresh(frm) {
    frm.items_table = new sanad.ui.PagedChildTable({
      frm,
      fieldname: "items",
      page_method: "orders.get_items_page",          // → {rows, total}; args {name, page, page_length, search, ...filters}
      page_length: 50,
      filters: [{ fieldname: "item_group", type: "select" }],   // options from meta when omitted
      status_field: "status",
      row_actions: [{ label: __("Open item"), icon: "es-line-link", handler: (row) => frappe.set_route("Form", "Item", row.item_code) }],
      toolbar_actions: [{ label: __("Add rows"), primary: true, condition: () => !frm.is_new(), handler: () => open_picker(frm) }],
      empty_text: __("No items yet"),
    });
  },
});

// A method with different argument names: adapt with `args(state)`
new sanad.ui.PagedChildTable({ frm, fieldname: "members", page_method: "picker.get_group_members",
  args: (s) => ({ group: frm.doc.name, page: s.page, page_length: s.page_length }) });
```

Options: `frm`, `fieldname`, `page_method`, `args?(state)`, `page_length` (50), `columns?
[{fieldname, label?, format?(value, row) → string | {html}, width?}]`, `row_actions?[{label,
icon?, condition?(row), handler(row, table)}]`, `status_field` (`"status"`, `null` to disable),
`status_indicator?(row) → {label, colour}`, `filters?[{fieldname, type: "select", label?,
options?}]`, `toolbar_actions?[{label, primary?, icon?, condition?(), disabled?, title?,
handler(table)}]`, `empty_text?`, `search` (true), `hide_grid` (true).
Methods: `refresh()`, `go(page)`, `update(opts)` (re-renders the toolbar with new options —
call it from `refresh` when the document status changes), `set_filter(fieldname, value)`,
`destroy()` (restores the grid). `state` exposes `{page, page_length, total, rows, search, filters}`.

## Live use
`WhatsApp Campaign` form — `public/js/form/whatsapp_campaign.js` (recipients, filters by
status / source type, "Add recipients" / "Remove recipients" through ContactPicker);
`WhatsApp Contact Group` form — `public/js/form/whatsapp_contact_group.js` (members).

## Design gate
- Skeleton with reserved height while loading; the pager text ("1–50 of 1,234", "No rows") is an
  `aria-live` slot that stays in place.
- Empty states carry a helpful message (and "Try a different search or filter" when a filter is
  active); errors carry a Retry action.
- A disabled toolbar action shows its reason as visible text (`hint`, linked with
  `aria-describedby`) instead of a hover-only `title`.
- Filter chips are the shared `.sanad-chip` toggle buttons (`aria-pressed`, ≥ 32 px); more than
  eight options fall back to a native select; search is debounced (300 ms).
- The table is the shared `.sanad-table` inside a focusable `.sanad-table-wrap` (horizontal scroll
  on phones, no page scroll); the pager buttons keep only their icons under 768 px but retain
  `aria-label`. Focus ring from the kit's global rule.
- Unsaved documents show "Save the document first" instead of a dead toolbar.

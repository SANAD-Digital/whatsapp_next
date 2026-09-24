# DataList

The prototype's data table on top of a Desk `ListView`: sortable headers with a sort icon, a
checkbox column (Desk's own `.list-row-checkbox[data-name]`, so `listview.get_checked_items()`
and `BulkActions` keep working), dense rows with a muted second line, typed cells (status badge
through the DocType's indicator rule, 2-letter avatar chip, tabular numbers, user-formatted dates,
form links), a per-row "View" button, an optional expandable row and a footer with the count and a
"Page 1 of 9 · Previous · Next" pager. `frappe.views.ListView` keeps doing data, filters, sorting
and the URL; DataList only replaces how rows, the count and paging render (overrides on the list
instance — nothing patched globally). Cards under 768 px through CSS alone. Portable: needs only a
Desk list and explicit columns (DocType `in_list_view` flags are a fallback, not the source).

## Usage

```js
// in listview_settings.onload
new sanad.ui.DataList({
  listview,
  columns: [
    { fieldname: "display_name", label: __("Contact"), sortable: true,
      format: (v) => sanad.ui.escape(v || __("Unknown")),
      sub: (doc) => `<span dir="ltr">${sanad.ui.escape(doc.phone_e164 || "")}</span>` },
    { fieldname: "status", type: "status" },                         // StatusBadge via sanad.ui.indicator_for
    { fieldname: "reference_doctype", label: __("Document type") },
    { fieldname: "reference_name", label: __("Document no."),
      format: (v, doc) => v ? frappe.utils.get_form_link(doc.reference_doctype, v, true, sanad.ui.escape(v)) : "" },
    { fieldname: "device", type: "avatar" },                         // initials chip + Link title
    { fieldname: "sent_at", type: "date", label: __("Sent at"), format: (v, doc) => … },
    { fieldname: "attempts", type: "number" },                        // tabular digits, aligned end
  ],
  selectable: true,
  row_action: { label: __("View"), handler: (doc) => open_drawer(doc) },
  on_row_click: (doc) => open_drawer(doc),
  expand: ($el, doc) => render_members($el, doc),                    // optional chevron column
  page_length: 20,
  footer: { count: (total) => sanad.ui.plural(total, { one: __("{0} message"), other: __("{0} messages") }) },
  empty: { title: __("No messages match"), description: __("Change the filters or the period.") },
});
```

Options: `listview`, `columns[]` (`fieldname`, `label`, `width`, `align`, `sortable` — default
true for plain fields, false for `format` / `sub` columns, `format(value, doc)`, `sub(doc)`,
`type` = `status` | `avatar` | `number` | `date` | `link` | `text` (inferred from the docfield),
`hidden_xs`), `selectable`, `row_action {label, handler}` | `false`, `on_row_click`,
`expand($el, doc, list)`, `page_length`, `footer {count, extra}`, `empty {title, description,
action}`, `mobile` (`cards` | `scroll`).
Methods: `refresh()`, `set_columns(cols)`, `get_selected()`, `expand_row(name)`, `destroy()`;
static `DataList.format(type, value, df, doc, display, doctype)`. Helper: `sanad.ui.initials(text)`.
Keep every rendered field in `listview_settings.add_fields`.

## On a custom page

A page that has no Desk list view passes a `wrapper` instead of a `listview` and owns the data:
the table draws what it is given, and asks for more through `on_page` / `on_sort`.

```js
const table = new sanad.ui.DataList({
  wrapper: $panel,                       // any element; the table, its summary line and its footer go inside
  doctype: "Contact",                    // optional: used for meta-driven formatting only
  columns: [{ fieldname: "full_name", label: __("Contact"), sortable: true }, …],
  page_length: 20,
  rows: [], total: 0,                    // or leave out for a skeleton until the first `set_rows`
  on_page: (page, t) => load(page).then((r) => t.set_rows(r.rows, r.total)),
  on_sort: (fieldname, order, t) => { state.order_by = `${fieldname} ${order}`; t.refresh(); },
  on_select: (rows) => bar.update(rows), // instead of the list view's own selection bar
  on_row_click: (doc) => open(doc),
});
load(0).then((r) => table.set_rows(r.rows, r.total));
```

`set_rows(rows, total)` is the only way data enters; `refresh()` calls `on_page` for the current
page. Grouping is a list-view feature and stays off on a page; pinning, sorting, selection, the
expandable row, the mobile card layout, the summary line and the pager all work the same.

## Live use
Outbound list — `public/js/listview/whatsapp_log_list.js`; Inbound list —
`public/js/listview/whatsapp_inbound_message_list.js` (both: "View" and row click open the record
Drawer).

## Design gate
Applied from the prototype comparison (`proto-outbound.png`, `proto-inbound.png`,
`proto-datalist.png`) and the WCAG 2.1 AA review:
- Real `<table>` with `scope="col"` headers, `aria-sort` on the sorted column and a sort button
  whose name says the next direction ("Sort by Status, ascending"); the checkbox column keeps
  Desk's selection semantics (shift-click ranges, Actions menu, BulkActions).
- Clickable rows are focusable (`tabindex="0"`, Enter opens) and never swallow clicks on
  controls or links; the "View" button is a real button at the inline-end for touch / keyboard.
- Status = StatusBadge (colour + label + icon); the avatar chip pairs initials with the name;
  numbers are `tabular-nums`; dates go through `frappe.datetime.str_to_user`.
- Loading is a skeleton (initial) or a dimmed table with `aria-busy` (refresh); empty state through
  EmptyState with a helpful action; the footer count is a live region and the pager announces
  "Page 2 of 9."
- Expandable rows use `aria-expanded` on the chevron button; the detail row renders a skeleton
  while its loader runs and an inline error on failure.
- Under 768 px each row becomes a card of `label: value` pairs (`data-label`), `hidden_xs`
  columns drop out, the pager stretches; no horizontal page scroll.
- Every colour from Espresso tokens; logical properties only; hover / selected tints from
  `--surface-gray-1` / `--surface-blue-1`.

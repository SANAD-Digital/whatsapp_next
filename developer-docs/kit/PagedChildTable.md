# `sanad.ui.PagedChildTable`

Replaces the native grid of a large child table on a form with a paged, read-only panel fed by an
API key that returns `{rows, total, counts?}`. The child data stays on the form and the field
stays visible (Frappe would hide a tab whose fields are all hidden): the panel mounts inside the
field's grid wrapper and only the native grid parts are hidden through a host class. Columns
default to the child DocType's `in_list_view` fields, values are formatted from meta, and a status
column renders as a StatusBadge. Filter chips, a search box, toolbar actions and per-row actions
are options.

**Portability:** portable. The page method is any `sanad.ui.call` key; the only contract is the
return shape `{rows, total, counts?}` and the default args `{name, page, page_length, search,
...filters}` (adapt with `args`).

## Options

| Option | Type | Default | Meaning |
|---|---|---|---|
| `frm` | Frappe form | — | Host form. |
| `fieldname` | string | — | The Table field to replace. |
| `page_method` | string | — | API key → `{rows, total, counts?}`. |
| `args` | `(state) => args` | — | Build call args from `{name, page, page_length, search, filters, total, rows, counts}`. Default: `{name, page, page_length, search, ...filters}`. |
| `page_length` | number | `50` | Rows per page. |
| `columns` | `Array<Column>` | child `in_list_view` fields | See below. |
| `row_actions` | `Array<RowAction>` | `[]` | Buttons in a trailing column. |
| `status_field` | string \| null | `"status"` | Rendered as a StatusBadge if that field exists on the child; `null` disables. |
| `status_indicator` | `(row) => {label, colour}` | `ui.indicator_for(child_doctype)` | Badge override. |
| `filters` | `Array<Filter>` | `[]` | Chip groups / selects above the table. |
| `toolbar_actions` | `Array<ToolbarAction>` | `[]` | Buttons in the panel head. |
| `empty_text` | string | "No rows yet" | Empty-state title. |
| `hide_grid` | boolean | `true` | Add `sanad-pct-host` to the field wrapper (hides the grid and the field label). |
| `search` | boolean | `true` | Search box, sent as `search` (debounced 300 ms). |

- **Column** `{fieldname, label?, format?(value, row) → string | {html}, width?}` — a string is
  escaped, `{html}` is inserted raw. Without `format`: status field → badge, known field →
  `ui.meta.format(value, df, row)`, else the raw value escaped.
- **RowAction** `{label, icon?, condition?(row), handler(row, table)}` — with `icon`, the button
  is icon-only with `aria-label`/`title`.
- **Filter** `{fieldname, type, label?, options?}` — `type: "search"` entries are skipped;
  options default to the child field's Select options. ≤ 8 options → chip group with "All";
  more → a native `<select>`.
- **ToolbarAction** `{label, handler(table), primary?, icon?, condition?(), disabled?, hint?,
  title?}` — skipped without `handler` or when `condition()` is false. When `disabled`, `hint`
  (or `title`) is shown as visible text in the note line (linked by `aria-describedby`).

## Methods

- `refresh()` → Promise — reload the current page (unsaved doc → "Save the document first").
- `go(page)` — clamp to `1…pages` and refresh.
- `set_filter(fieldname, value)` — set / clear a filter and go to page 1.
- `update(opts)` — merge options, re-render the toolbar, refresh (filters are not re-rendered).
- `destroy()` — remove the panel and the host class.
- `state` — `{page, page_length, search, filters, total, rows, counts}`.

## Events and callbacks

Only the handlers in `row_actions` / `toolbar_actions`. No DOM events, no realtime.

## Server calls

| Key | Args | When |
|---|---|---|
| `opts.page_method` | `build_args()` | Construction, page change, filter / search change, `update`, Retry. `{silent: true}`; stale responses dropped by sequence. |

## Usage

```js
frm.sanad_members = new sanad.ui.PagedChildTable({
  frm,
  fieldname: "members",
  page_method: "picker.get_group_members",
  args: (s) => ({ group: frm.doc.name, page: s.page, page_length: s.page_length }),
  columns: [{ fieldname: "display_name" }, { fieldname: "phone_e164" }, { fieldname: "source_type" }],
  status_field: null,
  search: false,
  row_actions: [{ label: __("Open contact"), icon: "es-line-people", condition: (r) => !!r.contact,
                  handler: (r) => frappe.set_route("Form", "Contact", r.contact) }],
  toolbar_actions: [{ label: __("Add members"), primary: true, disabled: frm.is_dirty(),
                      hint: __("Save the group first."), handler: () => open_picker(frm) }],
});
// later, on refresh: frm.sanad_members.update({ toolbar_actions });
```

## CSS hooks

- `.sanad-pct-host` on the field wrapper — hides `.grid-custom-buttons`, `.form-grid-container`,
  `.grid-footer`, `.control-label`, `.grid-label`.
- Root `.sanad-kit.sanad-pct[data-fieldname]`; `__head`, `__title`, `__count`, `__actions`,
  `__toolbar`, `__filters`, `__chips[data-field]`, `__chip[data-value][aria-pressed]`,
  `__chip-label`, `__chip-count`, `__select`, `__search`, `__note`, `__state`, `__scroll`
  (`.sanad-table-wrap`), `__table` (`.sanad-table`), `__th-actions`, `__row-actions`, `__pager`,
  `__range`, `__pager-btns`, `__prev`, `__next`.

## Notes

- **Mounting:** inside `field.grid.wrapper` (else `field.$wrapper`, else the form's first
  `.form-page`). Idempotent: an existing `.sanad-pct` for the same field is replaced.
- **States:** EmptyState loading skeleton, empty (with "Try a different search or filter." when
  filtered), error with Retry; `aria-busy` on the table while loading. Unsaved document →
  "Save the document first".
- **Counts:** if the response has `counts` `{fieldname: {value: n, All: n}}`, the head shows the
  first field's `All` (else `total`) as "N rows", each chip gets its number, zero-count chips hide
  unless active, and a chip group with ≤ 1 real choice hides itself.
- **Pager:** "a–b of N" / "No rows" (`aria-live`); hidden when `total ≤ page_length`; pager icons
  mirrored in RTL.
- **ARIA:** chip groups are `role="group"` with `aria-pressed` chips; the scroll area is focusable;
  the table has `aria-label` = field label.
- **Live use:** `public/js/form/whatsapp_contact_group.js` (members). The `README.md` also claims
  the WhatsApp Campaign form; `public/js/form/whatsapp_campaign.js` no longer instantiates it
  (campaign recipients are drawn by `public/js/screens/campaign/audience.js`).

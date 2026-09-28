# `sanad.ui.DataList`

The prototype's data table. It has two hosts:

- **List mode** (`listview`): replaces how a Desk `ListView` renders rows, header, count and
  skeleton by overriding methods **on that instance only** (`render_list`, `render_header`,
  `render_skeleton`, `render_count`, `get_count_str`, `freeze`, `set_result_height`,
  `toggle_result_area`). Frappe keeps data, filters, sorting, URL and its paging area (moved into
  the footer). Checkboxes stay Desk's `.list-row-checkbox[data-name]`, so `get_checked_items()`
  and BulkActions keep working.
- **Page mode** (`wrapper`): the page owns fetching and hands rows over with `set_rows()`; sort
  and paging are reported through callbacks.

Features: sortable headers, pinned (sticky) columns, typed cells, a muted second line per cell,
per-row "View" button, expandable detail rows, multi-level grouping of the loaded rows with group
selection and sums, per-user column choice, phone card layout (CSS, < 768 px). Portable; column
choices are stored in Frappe user settings under `sanad_columns_<settings_key>`.

## Options

| Option | Type | Default | Meaning |
|---|---|---|---|
| `listview` | Desk ListView | — | List mode host. One of `listview` / `wrapper` is required (throws otherwise). |
| `wrapper` | jQuery \| HTMLElement | — | Page mode host. |
| `doctype` | string | `listview.doctype` | Page mode: meta source. |
| `columns` | `Column[]` | from `listview.columns` (Field/Subject/Status) | Declared column set. **Required in page mode.** |
| `settings_key` | string | `"default"` | Suffix of the user-settings key for saved columns. |
| `selectable` | boolean | `true` | Checkbox column + "select all on this page". |
| `row_action` | `{label?, handler(doc, $btn)}` \| `false` | — | Inline-end button (label default "View"). |
| `on_row_click` | `(doc, $row) => any` | — | Row click / Enter (ignores controls, links, Ctrl/Cmd clicks); rows get `tabindex=0`. |
| `expand` | `($body, doc, datalist) => void\|Promise` | — | Adds a chevron column and a detail row (loading skeleton, error on rejection). |
| `page_length` | number | `20` | Sets `lv.page_length` / page size in page mode. |
| `footer` | `{count?(total, rows) → string, extra?($el, rows, datalist)}` | `{}` | Count text override; extra footer content. |
| `empty` | `{title?, description?, action?}` | `{}` | EmptyState copy (defaults "No records match" / "Change the filters or the period to see more."). |
| `mobile` | `"cards"` \| `"scroll"` | `"cards"` | Phone layout. |
| `mobile_columns` | `string[]` | first column + status columns | Columns kept in the card layout. |
| `group_by` | `string[]` | `[]` | Initial grouping levels, outermost first. |
| `sum` | string \| `{fieldname, label?}` | — | Field totalled on each group row. |
| `pinnable` | boolean | `true` | Pin toggle in every header cell. |
| `pinned` | `string[]` | `[]` | Initially pinned fieldnames. |
| `groupable` | boolean | `true` | Declared but not read by the component (grouping UI lives in FilterBar). |
| `on_group_change` | `(levels, datalist) => void` | — | After `set_group_by()`. |
| `rows` | `Object[]` | `[]` | Page mode: initial rows (rendered immediately; otherwise skeleton). |
| `total` | number | `rows.length` | Page mode: total count for the pager. |
| `sort` | `{fieldname, order}` | `{}` | Page mode: initial sort state. |
| `on_sort` | `(fieldname, order, datalist) => void` | — | Page mode: header sort clicked (table shows loading). |
| `on_page` | `(page_index, datalist) => void` | — | Page mode: Previous/Next clicked; also used by `refresh()`. |
| `on_select` | `(rows, datalist) => void` | — | Page mode: selection changed (list mode calls `lv.on_row_checked()`). |

**Column** — `{fieldname, label?, width? (number → px), align? ("start"|"end"|"center"; numbers
default "end"), sortable? (default true unless `format`/`sub`), format?(value, doc) → html,
sub?(doc) → html, type?, hidden_xs?, groupable?, group_label?(raw, doc)}`. `type` is inferred
from the docfield: `link`, `number` (Int/Float/Currency/Percent), `date` (Date/Datetime), else
`text`; explicit extras are `status` (StatusBadge via `ui.indicator_for`), `avatar` (initials chip
+ text) and `entity` (`Render.entity`). `text` with a non-Data fieldtype renders through
`sanad.ui.Render.value`.

## Methods

- `refresh()` — `listview.refresh()` or page mode `on_page(page)`.
- `set_rows(rows, total?)` — page mode data hand-over.
- `set_columns(columns)`, `set_visible_columns(fieldnames, {save = true})`, `reset_columns()`,
  `available_columns()`, `visible_columns()` — column management (used by FilterBar).
- `set_group_by(fields)`, `group_options()`, `set_all_folded(bool)` — grouping.
- `toggle_pin(fieldname)`, `expand_row(name)`, `sort(fieldname)`.
- `get_selected()`, `clear_selection()`, `set_loading(bool)`, `render()`, `destroy()`.
- `static format(type, value, df, doc, display?, doctype?)` — typed cell HTML for callers.

## Events and callbacks

Callbacks above. Delegated jQuery handlers namespaced `.<id>` on the result area/wrapper; window
`resize.<id>`; a `ResizeObserver` on the list card's other children re-fits the height. Sets
`lv._sanad_datalist` (read by FilterBar) and runs `lv._sanad_render_hooks` after each render (the
hooks `ui.on_list_render` registers). No realtime subscriptions of its own.

## Server calls

| Call | When |
|---|---|
| `frappe.db.count(doctype, {filters})` | List mode footer, only when a full page came back and the filters changed. |
| `frappe.model.user_settings.save(doctype, "sanad_columns_<key>", fields\|null)` | `set_visible_columns` / `reset_columns`. |

No `sanad.ui.call` keys.

## Usage

```js
frappe.listview_settings["ToDo"] = {
  add_fields: ["status", "allocated_to", "date"],
  onload(listview) {
    listview.sanad_datalist = new sanad.ui.DataList({
      listview,
      settings_key: "todo",
      columns: [
        { fieldname: "description", label: __("Task"), sub: (d) => sanad.ui.escape(d.name) },
        { fieldname: "status", type: "status" },
        { fieldname: "allocated_to", type: "avatar" },
        { fieldname: "date", type: "date" },
      ],
      row_action: { label: __("View"), handler: (doc) => frappe.set_route("Form", "ToDo", doc.name) },
      empty: { title: __("No tasks match") },
    });
  },
};
```

## CSS hooks

- List host: `sanad-datalist-host` (on `$result`), `sanad-list-card` (on `$frappe_list`),
  `sanad-list-card-host` (its parent). Page host: `sanad-kit sanad-datalist-page`.
- `sanad-datalist__wrap` (+ `--cards`) → `table.sanad-datalist` (`--loading`, `aria-busy`).
- Header: `__th` (`--check`, `--expand`, `--action`, `--start|end|center`, `--sorted`, `--pinned`,
  `--hidden-xs`, `data-fieldname`), `__sort`, `__sort-icon`, `__label`, `__pin` (`--on`).
- Rows: `__row` (`--clickable`, `--skeleton`, `--empty`, `data-name`), `__td` (same modifiers plus
  `--status`, `--card-extra`, `--off-card`, `data-label`), `__cell`, `__main`, `__sub`, `__muted`,
  `__date`, `__avatar-text`, `__view`/`__action`, `__toggle`, `__detail[data-for]`, `__detail-body`,
  `__cell--pin-edge`, `__empty`.
- Groups: `__group` (`--l0..`, `data-gid`), `__group-cell`, `__group-inner`, `__group-check`,
  `__group-checkbox`, `__rail`, `__indent`, `__group-toggle`, `__group-field`, `__group-label`,
  `__group-count`, `__group-sum`.
- Footer: `sanad-datalist__footer`, `__count` (live region), `__extra`, `__group-tools`,
  `__group-tool[data-fold]`, `__pager`, `__paging`, `__page-btn[data-go]`, `__page-state`.
- Stacking order is fixed in `style.scss` (see `.claude/rules/ui.md`, D-076).

## Notes

- States: 6-row skeleton on mount, dimmed `aria-busy` table while loading, EmptyState when empty.
- A11y: real `<table>`, `scope="col"`, `aria-sort`, sort button named with the next direction,
  `aria-expanded` on chevrons and group toggles, indeterminate group/all checkboxes, selection
  announcements via `ui.announce`.
- Selection survives re-renders (sort, fold, realtime); grouping is over loaded rows only.
- List mode sizes the card to the viewport (min 280 px table), accounting for a console above the
  FilterBar.
- Handler rejections toast unless the message is `"cancelled"`.
- Live use: `public/js/listview/whatsapp_campaign_list.js`, `whatsapp_command_list.js`,
  `whatsapp_contact_group_list.js`, `whatsapp_notification_list.js`,
  `whatsapp_notification_alert_list.js`, `whatsapp_number_list.js`, `whatsapp_template_list.js`;
  `public/js/screens/messages.js`, `screens/campaign/audience.js`; pages (page mode)
  `whatsapp_next/page/wa_contacts/wa_contacts.js`, `wa_functions_center/wa_functions_center.js`.

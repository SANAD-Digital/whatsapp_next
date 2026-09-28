# `sanad.ui.Collection`

Renders one set of records in the view that suits them — **table**, **list**, **cards**,
**gallery** or **timeline** — with a segmented switch between the allowed views, the reader's
choice remembered per `settings_key`, an optional footer total and "Show all" limit. Every row
goes through `sanad.ui.Render` (entity / value / vm), so a record looks the same here as in a
Drawer. Columns come from the DocType meta unless named. No server calls of its own; data is
`rows` or a caller `fetch()`.

## Options

| Option | Type | Default | Meaning |
|---|---|---|---|
| `wrapper` | jQuery \| HTMLElement | — | Emptied; the collection is appended. |
| `doctype` | string | — | Meta source for columns, kind and formatting. |
| `kind` | string | `Render.kind_of(doctype)` or `"generic"` | `person` \| `item` \| `document` \| `file` \| `generic`; picks default views. |
| `rows` | `Object[]` | `[]` | Records to show. |
| `fetch` | `() => Promise<rows>` | — | Used instead of `rows`; loading/error states via EmptyState. |
| `views` | `string[]` | by kind (below) | Allowed views; the switch shows only when ≥ 2. |
| `view` | string | saved view, else `views[0]` | Initial view. |
| `columns` | `Column[]` | meta `preview_fields` (first 5), else first 5 row keys | Table columns. |
| `identity` | boolean | — | `false` keeps the first table column a plain value (otherwise it renders `Render.entity`, when `doctype` is set). |
| `title` / `description` / `icon` | string | — | Header; header hidden without `title` unless the switch is shown. |
| `total` | `{label?, value, fieldtype?, note?}` | — | Footer total; `value` may be `(rows) => value`; `fieldtype` formats via `Render.value`. |
| `actions` | `Action[]` \| `(doc) => Action[]` | `[]` | Per-row quick actions (Render action spec), filtered by `ui.visible_actions`. |
| `on_click` | `(doc, event) => void` | — | Makes rows focusable/clickable (Enter/Space too); disables Render's own href. |
| `profile` | object | — | Render profile override. |
| `timeline` | `(doc) => TimelineRow` | identity | Maps a row for the timeline view. |
| `settings_key` | string | — | localStorage key suffix (`sanad_collection_<key>`) for the chosen view. |
| `limit` | number | — | Show first N rows plus a "Show all N" button. |
| `gallery_max` | number | `8` | Gallery tiles; the last shows `+N`. |
| `empty_title` / `empty_description` / `empty_action` | string / string / object | "Nothing to show" | Passed to EmptyState when there are no rows. |

Default views by kind: person `list, cards, table`; item `table, list, cards, gallery`;
document `table, list, cards`; file `list, gallery, cards`; generic `table, list, cards`.

**Column** — `{fieldname, label?, align? ("start"/"end"; numeric fieldtypes default "end"), width?, format?(value, doc) → html, df?, entity?, variant?}`.

**TimelineRow** — `{title, time?, description?, html? (description not escaped), user?, icon?, tone? (default gray)}`.

## Methods

- `set_rows(rows)`, `set_columns(columns)`, `set_view(view)` — update and re-render.
- `refresh()` — re-run `fetch` (loading skeleton, error with Retry).
- `render()` — re-render current view; `destroy()` — remove markup.

## Events and callbacks

`on_click(doc, e)`; action handlers via Render's `bind_actions`. Announces view changes and
"N more rows shown" through `ui.announce`. No realtime events.

## Server calls

None directly (the caller's `fetch` does its own).

## Usage

```js
new sanad.ui.Collection({
  wrapper: $el,
  doctype: "Sales Invoice Item",
  rows: frm.doc.items,
  views: ["table", "list", "cards"],
  columns: [{ fieldname: "item_code" }, { fieldname: "qty" }, { fieldname: "amount" }],
  total: { label: __("Total"), value: (rows) => rows.reduce((s, r) => s + r.amount, 0), fieldtype: "Currency" },
  settings_key: "invoice-items",
  title: __("Items"),
});

new sanad.ui.Collection({
  wrapper: $el, rows: events, views: ["timeline"],
  timeline: (e) => ({ title: e.text, time: e.at, tone: e.tone, icon: e.icon, user: e.by }),
});
```

## CSS hooks

- Root `<section class="sanad-kit sanad-collection">` (labelled by the title id).
- `__head`, `__heading`, `__icon`, `__title`, `__desc`, `__views`, `__body[data-view]`, `__list`,
  `__item`, `__grid`, `__cell`, `__gallery`, `__tile`, `__caption`, `__more`, `__clickable`,
  `__foot`, `__total`, `__total-label`, `__total-value`, `__total-note`, `__more-btn`, `__table`.
- Table: `sanad-table-wrap`, `sanad-table`, `sanad-table__start|end`, cells carry `data-label`.
- View switch: `sanad-seg` / `sanad-seg__btn[data-view]` (`role="tab"`, `aria-selected`).
- Timeline: `sanad-timeline`, `__item`, `__rail`, `__dot` (+ `sanad-tone--*`), `__body`, `__head`,
  `__title`, `__time`, `__desc`, `__user`.

## Notes

- States: EmptyState `loading` (3 rows) during `fetch`, `error` with Retry, `empty` when no rows.
- Keyboard: view switch is a `tablist` with roving arrow keys (`ui.roving_index`); clickable rows
  take `tabindex=0` and ignore clicks on inner links/buttons/actions.
- Below 640 px the table stacks cells with their `data-label`; switch labels hide on phones.
- localStorage access is try/catch-guarded.
- Live use: no screen instantiates it directly. It is used inside the kit by
  `public/js/ui/Drawer/index.js` (`render_activity`, timeline view), which serves the activity
  history in `public/js/screens/messages.js` and `whatsapp_next/page/wa_contacts/wa_contacts.js`.
  The README's reference to `whatsapp_log_list.js` / `whatsapp_inbound_message_list.js` is stale.

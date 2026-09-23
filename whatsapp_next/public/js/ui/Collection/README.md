# Collection

Many rows are not always a table. The same records can be read as a **table** (when comparing
columns is the point — accounting entries), a **list** (dense scanning), **cards** (when a picture
or a value matters), a **gallery** (images) or a **timeline** (when *when* is the information —
activity history). `Collection` owns that choice: it renders one of those views, offers the switch
between the ones you allow, remembers the reader's pick, and hands every row to
[`sanad.ui.Render`](../Render/README.md) so a person, an item or a document looks the same here as
in a drawer.

## Usage

```js
// A child table read as rows, with a total under it
new sanad.ui.Collection({
  wrapper: $el,
  doctype: "Sales Invoice Item",
  rows: doc.items,
  views: ["table", "list", "cards"],
  columns: [{ fieldname: "item_code" }, { fieldname: "qty" }, { fieldname: "rate" }, { fieldname: "amount" }],
  total: { label: __("Total"), value: (rows) => rows.reduce((s, r) => s + r.amount, 0), fieldtype: "Currency" },
  title: __("Items"),
  icon: "es-line-storage",
});

// Loaded from the server, click opens the record
new sanad.ui.Collection({
  wrapper: $el,
  doctype: "Contact",
  fetch: () => sanad.ui.call("contacts.list_contacts", { group }),
  views: ["list", "cards"],
  settings_key: "group-members",
  on_click: (doc) => sanad.ui.Drawer.open({ doctype: "Contact", name: doc.name }),
  actions: [{ icon: "es-line-call", label: __("Call"), href: (d) => `tel:${d.mobile_no}` }],
});

// Activity history
new sanad.ui.Collection({
  wrapper: $el,
  rows: events,
  views: ["timeline"],
  timeline: (e) => ({ title: e.text, time: e.at, tone: e.tone, icon: e.icon, user: e.by }),
});
```

Options: `wrapper`, `doctype`, `rows` | `fetch`, `views` (default: by kind), `view`, `columns`,
`title`, `description`, `icon`, `total`, `actions`, `on_click`, `profile`, `kind`, `timeline`,
`settings_key`, `limit` (with a "show all" control), `gallery_max`, `empty_title`,
`empty_description`, `empty_action`, `identity` (`false` keeps the first column a plain value).
Methods: `set_rows`, `set_columns`, `set_view`, `refresh`, `destroy`.

Columns come from the DocType's meta (`in_list_view` / `bold`) when you do not name them; the first
column carries the record's identity (avatar + name) unless `identity: false`.

## Live use
The Outbound and Inbound drawers render their activity history through the timeline view
(`public/js/listview/whatsapp_log_list.js`, `whatsapp_inbound_message_list.js`).

## Design gate
- The view switch is a segmented control with `role="tablist"`, arrow-key roving and a remembered
  choice; on phones the labels drop and the icons stay.
- The table degrades to stacked rows below 640 px, each cell carrying its column name — no
  horizontal scroll on a phone.
- Empty, loading (skeleton) and error (with retry) states come from `EmptyState`, like every other
  panel in the kit.
- A row is clickable only when there is something to open; it then takes focus and answers Enter
  and Space, and the quick actions inside it never trigger the row.
- The timeline states time and sequence first: one dot per event, its tone carrying an icon too.

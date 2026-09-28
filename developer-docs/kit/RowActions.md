# `sanad.ui.RowActions`

Adds a per-row overflow button to a Desk list (the `ui.icons.more` icon) that opens a small menu. The menu shows the actions allowed for that row by `roles`, `perm` and `condition(doc)`. An optional `on_row_click` handler replaces the form route, for example to open a Drawer. Rows are decorated again after every render through the shared `ui.on_list_render` hook, so paging, filtering and realtime refreshes keep their buttons. The menu is appended to `<body>` because list rows clip overflow.

## Options

| Option | Type | Default | Meaning |
|---|---|---|---|
| `listview` | ListView | — (required) | The Desk list. The constructor throws if it is missing. |
| `actions` | Array | `[]` | The action specs described below. |
| `on_row_click` | `(doc, $row) => void` | — | Makes the whole row clickable and suppresses the form route. |
| `label` | string | `__("Actions")` | The accessible name. The button reads "{label} for {title}", and the menu uses it as `aria-label`. |

Action spec:

- `label` (string) is the menu text.
- `icon` (string) is an optional icon name.
- `handler(doc, $row)` runs on click. It may return a promise. A rejection is shown as `Toast.error`, except when the message is `"cancelled"`.
- `condition(doc)` hides the entry when it returns false. An exception inside it also hides the entry.
- `perm` (string) is a ptype checked with `frappe.perm.has_perm(doctype, 0, perm, doc)`.
- `roles` (string[]) shows the entry when the user has any one of these roles.
- `danger` (boolean) styles the entry red.

## Methods

- `decorate()` adds the button to every rendered row that does not have one yet. It is idempotent.
- `visible_actions(doc)` returns the actions allowed for `doc`, computed by `ui.visible_actions`.
- `open_menu($btn)` and `close_menu(restore_focus = false)` open and close the menu.
- `destroy()` closes the menu, unhooks the render hook, removes the `.sanadrow` handlers and removes the buttons.

## Events and callbacks

- `handler(doc, $row)` and `on_row_click(doc, $row)` are described under Options. `doc` is looked up by name in `listview.data`.
- While the menu is open, `.sanadrowmenu` listeners on `document` (mousedown/touchstart outside) and `window` (resize/scroll) close it.
- No custom events are triggered and no realtime events are subscribed.

## Server calls

None of its own. The action handlers make the calls.

## Usage

```js
new sanad.ui.RowActions({
  listview,
  actions: [
    { label: __("View"), icon: sanad.ui.icons.open,
      handler: (doc) => frappe.set_route("Form", listview.doctype, doc.name) },
    { label: __("Cancel"), icon: "es-line-close-circle", danger: true, roles: ["WhatsApp Manager"],
      condition: (doc) => doc.status === "Queued",
      handler: (doc) => sanad.ui.call("queue.delete_items", { names: [doc.name] }).then(() => listview.refresh()) },
  ],
  on_row_click: (doc) => new sanad.ui.Drawer({ doctype: listview.doctype, name: doc.name }).show(),
});
```

## CSS hooks

- `.sanad-rowactions` is the cell, appended to the row's `.level-right` (or `.list-row` when there is no `.level-right`). It keeps a 28 px slot even when the row has no actions.
- `.sanad-rowactions__btn` carries `aria-expanded` and `data-name`.
- `.sanad-rowactions__clickable` is added to rows when `on_row_click` is set.
- The menu is `.sanad-rowactions__menu`. It uses `position: fixed` with the CSS variables `--sanad-menu-x` / `--sanad-menu-y` and `z-index: 1035`.
- Menu entries are `.sanad-rowactions__item`, with `--danger` for red entries, and `.sanad-rowactions__icon`.
- The stylesheet also widens `.level-right` to 216 px on decorated rows.
- The stylesheet also carries shared two-line cell helpers: `.sanad-cell`, `.sanad-cell__sub`, `.sanad-cell__muted`, `.sanad-cell__error` and `.sanad-list--two-line`.

## Notes

- **Keyboard and focus:** the button opens the menu on Enter, Space or ArrowDown. In the menu, arrows, Home and End move between items, Escape closes the menu and returns focus to the button, and Tab closes it. The first item is focused on open.
- **ARIA:** the button has `aria-haspopup="menu"`, `aria-expanded` and `aria-controls`. The menu is `role="menu"` and its entries are `menuitem`.
- **RTL:** position is computed in JavaScript and handles RTL via `ui.is_rtl()`. The menu flips above the button when there is no room below it.
- **Row click** is ignored on checkboxes, links, buttons, dropdowns, Desk's like/filterable targets, and on Ctrl/⌘-click, which Frappe uses for multi-select.
- Rows whose docname cannot be read (`ui.docname_of_row`) are skipped.
- **Live use:** it is the fallback row menu when a list does not mount DataList. The lists are in `public/js/listview/`:
  - `whatsapp_campaign_list.js`
  - `whatsapp_command_list.js`
  - `whatsapp_contact_group_list.js`
  - `whatsapp_notification_alert_list.js`
  - `whatsapp_notification_list.js`
  - `whatsapp_number_list.js`
  - `whatsapp_template_list.js`
- The Live use section in `README.md` (log, inbound and queue lists) is stale. Those lists go through `screens/messages.js`, which uses DataList.

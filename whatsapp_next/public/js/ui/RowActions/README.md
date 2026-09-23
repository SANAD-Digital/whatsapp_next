# RowActions

A per-row overflow button (`es-line-overflow`) on a Desk list opening a menu of the actions whose
`condition(doc)` passes, plus an optional row-click handler that replaces the form route (used to
open a Drawer). Rows are decorated after every render by wrapping `listview.render_list`, so
paging, filters and realtime updates keep their buttons. The menu is appended to `<body>` because
list rows clip overflow; it is keyboard-complete and closes on Escape / outside click / scroll.

## Usage

```js
new sanad.ui.RowActions({
  listview,
  actions: [
    { label: __("Resend"), icon: "es-line-reload",
      condition: (doc) => ["Failed", "Sent"].includes(doc.status),
      handler: (doc) => sanad.ui.call("messages.resend", { name: doc.name }).then(() => listview.refresh()) },
    { label: __("Cancel"), icon: "es-line-close-circle", danger: true,
      roles: ["WhatsApp Manager"], condition: (doc) => doc.status === "Queued",
      handler: (doc) => cancel(doc) },
  ],
  on_row_click: (doc) => new sanad.ui.Drawer({ doctype: listview.doctype, name: doc.name }).show(),
});
```

Options: `listview`, `actions[]` (`label`, `icon`, `condition(doc)`, `handler(doc, $row)`,
`danger`, `perm` — ptype checked with `frappe.perm.has_perm`, `roles` — any-of), `on_row_click`,
`label` (accessible name, default "Actions"). Methods: `decorate()`, `close_menu()`, `destroy()`.
`doc` comes from `listview.data` by name; a handler may return a promise — rejections are
toasted.

## Live use
Outbound list — `public/js/listview/whatsapp_log_list.js`; Inbound list —
`public/js/listview/whatsapp_inbound_message_list.js`; Queue list —
`public/js/listview/whatsapp_queue_item_list.js`.

## Design gate
Applied from the phase-5 audit:
- Button: `aria-haspopup="menu"`, `aria-expanded`, `aria-controls`, an accessible name that
  includes the row title (WCAG 2.5.3); icon from the shared `sanad.ui.icons.more`.
- Menu: `role="menu"` / `menuitem`, arrow / Home / End navigation, Escape and Tab close it,
  focus returns to the button; the focused item shows a 2 px `--ink-blue-3` outline (WCAG 1.4.11
  — the earlier inset light-blue shadow was replaced).
- Rows are re-decorated through the shared `sanad.ui.on_list_render` hook; visibility rules
  (`roles` / `perm` / `condition`) go through `sanad.ui.visible_actions` so Drawer, BulkActions
  and RowActions agree.
- A row without applicable actions keeps an empty slot of the same width — no column jitter.
- Row click never fires on checkboxes, links, buttons or Ctrl/⌘-click (Frappe's multi-select).
- Danger entries are red **and** listed last with an icon; ≥ 32 px menu items, 28 px button with
  8 px spacing (WCAG 2.5.8).

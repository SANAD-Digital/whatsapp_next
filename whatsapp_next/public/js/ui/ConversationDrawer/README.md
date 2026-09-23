# ConversationDrawer

The conversation variant of the drawer: an inline-end panel (full-height `100dvh` sheet under
768 px) showing one number's merged outbound + inbound thread from the read layer, the number's
link status, and the contextual actions — Add as contact / Open contact, Quick send, Confirm
conversation. Exactly one drawer is open at a time (`sanad.ui.ConversationDrawer.current`); it
traps focus, closes on Escape and backdrop, restores focus to the opener and unsubscribes its
realtime handlers on close. Data: `messages.get_conversation` (newest-first pages with a keyset
`next_cursor`), `numbers.search_numbers` + `numbers.get_number` for the header,
`numbers.confirm_conversation`. Portable through the `api` key map and the `on_link` callback.

## Usage

```js
sanad.ui.ConversationDrawer.open({
  key: doc.phone_e164 || doc.jid,     // E.164 or group JID
  device: doc.last_device,            // optional: restrict the thread to one device
  page_length: 50,
  actions: ["link", "quick_send", "confirm"],
  on_link: (number, drawer) => open_link_dialog(number),   // the caller's link / convert dialog
  on_close: () => listview.refresh(),
});
```

Options: `key`, `device`, `page_length` (50), `actions` (strings, or `{key, label, icon,
condition(number), handler(number, drawer)}` objects for custom actions), `title`, `on_close`,
`on_link`, `on_row_click`, `roles` (`{quick_send: [...], confirm: [...]}` — role lists gating
those actions; defaults to the host's `sanad.ui.config.defaults.roles`, an empty list means permission checks only), `api` (`{conversation, number,
number_search, confirm}` key overrides).
Methods: `close()`, `load_older()`, `refresh_newest()`, `confirm_conversation()`.
Static: `open(opts)`, `current`.

Behaviour:
- Header: display name + number, or "Unknown number" with a *Not Linked* badge when no Number
  row exists (looked up with `search_numbers` first so Desk's global "Not found" message is never
  raised for an unknown key).
- Actions render only when they can run: *Add as contact* needs `on_link`; *Quick send* needs
  `sanad.ui.QuickSend` and the role; *Confirm conversation* opens a ConfirmDialog with a mandatory
  note and toggles the flag.
- Body: EmptyState skeleton → ChatThread; 403 → "You need the Viewer role to read
  conversations"; other errors → retry. "Load older" pages with `next_cursor` and keeps the
  scroll position.
- Realtime: `wa:message:status` patches ticks; `wa:inbound:received` matches `key_hash` (SHA-1 of
  the key via `crypto.subtle`, cached; falls back to the `device` when WebCrypto is unavailable)
  and appends only rows the thread does not have yet.

## Live use
`public/js/listview/whatsapp_number_list.js` (row click and the *Messages* row action) and
`public/js/form/whatsapp_number.js` (*Messages* button); Contacts page.

## Design gate
- One panel grammar: built on the shared `.sanad-panel` / `.sanad-backdrop` shell (same header,
  close button, width variable and `100dvh` mobile sheet as Drawer) and registered with
  `sanad.ui.overlay`, so a ConversationDrawer and a Drawer never stack two `aria-modal` dialogs.
- Focus: trapped inside the panel (`sanad.ui.trap_focus`), Escape and backdrop close, focus
  returns to the opener; the close button is the first focusable element.
- Reserved heights for the badge and the action row while the number loads (skeleton, no jump).
- Every state through EmptyState (loading / empty / error with retry); a 403 shows "You do not
  have permission to read conversations. Ask an administrator for access." — no host role name.
- Action visibility through `sanad.ui.visible_actions` (roles / perm / condition) — the same rule
  RowActions and Drawer use; the icons come from `sanad.ui.icons` (`quick_send`, `cancel`).
- "Not linked" is a neutral gray badge without a warning icon; "Linked" is green with a check.
- Decisions go to ConfirmDialog (`ConversationDrawer.confirm_dialog`, shared with the Numbers
  list) with a mandatory note; phone numbers inside sentences are bidi-isolated (LRI…PDI) so
  they read correctly in Arabic; success uses a 4 s toast; announcements are full sentences
  ("3 new messages arrived.") with `sanad.ui.plural`.
- Only Espresso tokens; logical properties so the panel sits on the inline-end side in RTL.

# ChatThread

A WhatsApp-style thread over read-layer message rows. Bubbles follow `direction` (outbound on the
inline-end side, inbound on the inline-start side — logical properties, so RTL needs nothing),
day separators come from `frappe.datetime` in the user's time zone, outbound rows carry status
ticks (clock → single check → double check → blue double check; Failed / Cancelled / Held show an
icon **and** the word), media rows link the attachment with an icon by `message_type`, and a
reference chip links `reference_doctype: reference_name` to its form. The caller owns the data
(ConversationDrawer, the Simulator); the thread renders, de-duplicates, keeps the scroll position
when older rows are prepended and patches ticks in place on realtime updates. Portable: it knows
nothing about the host app or its API — pass rows in.

## Usage

```js
const thread = new sanad.ui.ChatThread({
  wrapper: $panel,
  rows: page.rows.slice().reverse(),          // API pages are newest-first; display is oldest-first
  has_more: page.has_more,
  on_load_more: () => load_older(),           // returns a promise; the button shows "Loading…"
  on_row_click: (row) => open_drawer(row),    // optional: rows become focusable buttons
  highlight: "WAL-0001",                      // optional: scroll to and outline one row
  empty_text: __("No messages yet"),
});

thread.prepend(older_rows);                   // scroll position preserved, count announced
thread.append(new_rows);                      // scrolls down only if the reader was at the bottom
thread.update_status("WAL-0001", "Delivered"); // realtime `wa:message:status`
thread.set_has_more(false);
thread.scroll_to_bottom();
thread.set_rows(rows);
```

Options: `wrapper`, `rows` (`{direction, name, ts, status, message_type, body, caption,
display_name, key, attachment, reference_doctype, reference_name, cursor}`), `on_load_more`,
`has_more`, `on_row_click`, `highlight`, `empty_text`, `empty_description`, `empty_action`,
`max_height`.
Methods: `set_rows(rows)`, `prepend(rows)`, `append(rows)` (both return the number of new rows),
`update_status(name, status)`, `set_has_more(bool)`, `scroll_to_bottom()`, `scroll_to(name)`,
`load_more()`, `destroy()`.
Static helpers: `ChatThread.format(text)` (escape + WhatsApp `*bold*` / `_italic_` / `~strike~` /
`` `code` `` + line breaks), `ChatThread.status_html(status)`, `ChatThread.day_of(ts)`,
`ChatThread.time_of(ts)`, `ChatThread.sort(rows)`.

## Live use
ConversationDrawer body (WhatsApp Numbers list and form, Contacts); the Simulator page thread.

## Design gate
- Status is never colour alone: every tick has `role="img"` + `aria-label`; failure states add a
  visible word (Failed / Cancelled / Held). Row labels read "Sent message, Delivered" /
  "Received message from …" — no system terms.
- The scroll region is a plain `role="log"` **without** `aria-live` (the list is re-rendered on
  prepend / append, which would otherwise re-read the whole thread); the owner announces
  "N older messages loaded." / "N new messages arrived." through `sanad.ui.announce`.
- No nested interactive content: when `on_row_click` is set, attachment and reference links are
  rendered as text and each bubble gets an explicit "Open" button (keyboard path); the mouse can
  still click anywhere on the bubble.
- Reserved space: the "Load older messages" slot keeps its height while loading; the empty state
  uses the shared EmptyState (skeleton / empty, never a spinner).
- Media rows and buttons are ≥ 32 px targets (the inline "Open" button 24 px with 8 px gaps);
  attachment links open in a new tab with `rel="noopener"` and an explicit "Open …" label.
- Bubbles cap at 60ch / 78 % (88 % on phones); `overflow-wrap: anywhere` prevents horizontal
  scroll; spacing only through `--sanad-gap-*`; the focus ring comes from the kit's global rule.
- All text is escaped before the WhatsApp formatting pass; only Espresso tokens are used.

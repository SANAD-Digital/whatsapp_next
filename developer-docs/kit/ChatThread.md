# `sanad.ui.ChatThread`

A WhatsApp-style message thread over read-layer rows: bubbles by `direction` (outbound on the
inline-end side, inbound on the inline-start side), day separators ("Today" / "Yesterday" / user
date format, in the user's time zone), time, outbound status ticks, media rows, a reference chip
and a "Load older messages" button. The caller owns the data; the thread only renders,
de-duplicates, keeps the scroll position when older rows are prepended and patches status ticks in
place.

**Portability:** no server calls, but the row shape is this app's read layer
(`messages.get_conversation` rows): `direction` (`"Inbound"` vs anything else = outbound),
`status` values `Unsent` / `Queued` / `Sending` / `Sent` / `Delivered` / `Read` / `Failed` /
`Cancelled` / `Held`, and `message_type` values `Text` / `Image` / `Video` / `Audio` / `Document` /
`Sticker` / `Location` / `Poll` / `Contact` / `Reaction` / `Other`.

## Options

| Option | Type | Default | Meaning |
|---|---|---|---|
| `wrapper` | jQuery \| HTMLElement | required | Emptied and filled. |
| `rows` | array | `[]` | Rows in any order (sorted oldest → newest). |
| `on_load_more` | `() => Promise` | — | Enables the "Load older messages" button. |
| `has_more` | boolean | `true` | Whether that button shows (with `on_load_more`). |
| `on_row_click` | `(row) => void` | — | Bubbles become clickable, get an "Open" button; attachment / reference links render as text. |
| `highlight` | row `name` | — | Outlines that row and scrolls it into view (centre). |
| `empty_text` | string | "No messages yet" | Empty-state title. |
| `empty_description` | string | — | Empty-state description. |
| `empty_action` | EmptyState action | — | Empty-state action. |
| `max_height` | number (px) | — | Caps the root height; omit when the parent scrolls. |

**Row fields read:** `name` (required; dedupe key is `direction:name`), `direction`, `ts` (or
`creation`), `status`, `message_type` (default `Text`), `body`, `caption`, `attachment` (URL),
`reference_doctype`, `reference_name`, `display_name` / `key` (inbound aria label).

## Methods

- `set_rows(rows)` — replace all, render, scroll to bottom (then to `highlight`).
- `prepend(rows)` → count added; keeps the visible message in place, announces "{n} older messages loaded.".
- `append(rows)` → count added; scrolls down only if the reader was within 40px of the bottom.
- `update_status(name, status)` → boolean; patches one outbound row's ticks.
- `set_has_more(bool)`, `load_more()` (calls `on_load_more`, button shows "Loading…", errors → `Toast.error`).
- `scroll_to_bottom()`, `scroll_to(name)`, `is_at_bottom(threshold = 40)`, `get_row(key)`, `render()`, `destroy()`.
- Static helpers: `ChatThread.sort(rows)` (by `ts`/`creation`, then `name`), `status_html(status)`, `media_html(row, {link})`, `format(text)` (escape + WhatsApp `*bold*`, `_italic_`, `~strike~`, `` `code` ``, line breaks), `day_of(ts)` → `{key, label}`, `time_of(ts)` → `{label, full, iso}`, `moment_of(ts)`.

## Events and callbacks

`on_load_more`, `on_row_click`. No custom events and no realtime subscriptions of its own — the
owner calls `update_status` / `append` from its realtime handlers (ConversationDrawer does so for
`wa:message:status` and `wa:inbound:received`).

## Server calls

None.

## Usage

```js
const thread = new sanad.ui.ChatThread({
  wrapper: $panel,
  rows: page.rows.slice().reverse(),     // API pages are newest-first
  has_more: page.has_more,
  on_load_more: () => fetch_older().then((older) => { thread.prepend(older.rows); thread.set_has_more(older.has_more); }),
  empty_text: __("No messages yet"),
});
frappe.realtime.on("wa:message:status", (p) => thread.update_status(p.outbound, p.status));
```

## CSS hooks

- Root `.sanad-kit.sanad-chat` (`id` = uid), `__top`, `__more`, `__scroll` (`role="log"`), `__state`, `__list`, `__day`.
- Rows: `.sanad-chat__row--in|--out`, `--clickable`, `--highlight`, `data-key`, `data-name`; `__bubble`, `__text` (`--muted`), `__caption`, `__meta`, `__open`, `__ref`.
- Media: `__media` (`--plain`), `__media-icon`, `__media-name`, `__media-type`.
- Status: `__status--gray|blue|red|amber`, `__status-text` (visible word for Failed / Cancelled / Held).

## Notes

- States: empty via `EmptyState` (`size: "sm"`); the "Load older" button is disabled with `aria-busy` while loading.
- A11y: the scroll region is `role="log"` without `aria-live` (re-renders would re-read everything); ticks are `role="img"` with `aria-label`; rows are `role="group"` labelled "Sent message, {status}" / "Received message from {who}"; day separators `role="separator"`. No nested interactive content when rows are clickable.
- RTL via logical properties; all text escaped before formatting. Re-renders the whole list on prepend / append.
- `cursor` is listed in the JSDoc row shape but not read by the component.
- Live use: `public/js/ui/ConversationDrawer/index.js`, `whatsapp_next/page/wa_simulator/wa_simulator.js`, and inside the kit `CommandEditor` / `FunctionDetail` (reply preview) and `TemplateEditor` (`ChatThread.format`).

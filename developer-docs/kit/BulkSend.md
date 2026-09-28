# `sanad.ui.BulkSend`

The "Send a bulk message" window: a full-height modal with a header (title, subtitle, close) over
two panes. **Recipients** — Groups · Contacts · Numbers segments with counts, a search, selectable
rows, a numbers box, and a footer with "Selected N", "Show the selected" and "Remove all".
**The message** — a header saying who it goes to with a "Send settings" pill (template, device,
rate, timing), the first recipient as the preview identity, the message bubble, a composer with a
"+" that opens `sanad.ui.AttachMenu`, and an estimates bar with the send pill. Sending asks through
`sanad.ui.ConfirmDialog` with the facts of the send. The constructor opens the window immediately.

**Portability:** the data source is passed in as functions, so the component makes no server calls
of its own; but the shapes it expects (`load`, `estimate`, `send` payload/result) mirror this app's
`bulk_send.*` API, and the stylesheet uses the app's `--wa-*` palette tokens from
`public/scss/_tokens.scss`, which live outside the kit. It reuses `CommandEditor`'s layer/modal
classes (`sanad-ce-*`), so that stylesheet must load too (the kit's `style.scss` imports both).

## Options

| Option | Type | Default | Meaning |
|---|---|---|---|
| `load` | `() => Promise<ctx>` | — | Required. Context: see below. |
| `estimate` | `({groups, contacts, numbers}) => Promise<{total, excluded, invalid}>` | — | Required. Called 250 ms after the selection changes; `contacts` are names. |
| `search_contacts` | `(txt) => Promise<[{name, label, phone, party_type}]>` | — | Required. Called 220 ms after typing in the Contacts segment, and by AttachMenu's contact picker. |
| `send` | `(payload) => Promise<{campaign, status, recipients}>` | — | Required. Runs as the confirm dialog's `on_confirm`. |
| `prefill` | `{groups[], contacts[{name, label, phone}], numbers[]}` | `{}` | Initial selection. |
| `title` | string | `__("Send a bulk message")` | Window title. |
| `subtitle` | string | "Pick the recipients, write the message, then send…" | Line under the title. |
| `on_sent` | `(result) => void` | — | After a successful send, before the window closes. |
| `on_templates` | `() => void` | — | If given, the settings show "Manage message templates"; clicking closes the window and calls it. |
| `on_close` | `() => void` | — | After every close. |

**`load()` context:** `groups[{name, group_name, kind, description, source, member_count}]`
(`kind === "Blacklist"` gets a warning badge), `templates[{name, template_name, category, body}]`,
`devices[{name, device_name, status}]`, `default_device`, `rate` (default 20), `max_rate`
(optional cap; a higher rate is refused with a message), `messages_remaining` (optional).

**`send(payload)` payload:** `{groups, contacts (names), numbers, body, template (null when an
attachment is set), kind ("text" or the AttachMenu kind), attachment, contact, device, rate,
scheduled_at ("YYYY-MM-DD HH:mm" or null)}`.

## Methods

- `show()` — build and open the window (called by the constructor), then `load()`.
- `close()` — remove the window, restore focus to the opener, call `on_close`.
- `hide()` — remove the window without restoring focus or calling `on_close`.
- `render()` — redraw both panes, keeping focus, caret and list scroll.
- `ask_send()` — run the guards and the confirmation (what the send buttons call).

## Events and callbacks

- `on_sent(result)`, `on_templates()`, `on_close()` as above.
- No custom DOM events; no realtime subscriptions. All clicks are delegated through `data-act`
  attributes on the root; inputs through `data-in` / `data-ch`.
- Registers itself with `sanad.ui.overlay.open/close` when available.

## Server calls

None directly — everything goes through the host's `load`, `estimate`, `search_contacts` and
`send`. The app wires them to `bulk_send.get_context`, `bulk_send.estimate`,
`bulk_send.search_contacts` (`{txt}`) and `bulk_send.send` (`{payload}`).

## Usage

```js
const call = (m, args) => sanad.ui.call(`bulk_send.${m}`, args);
new sanad.ui.BulkSend({
  load: () => call("get_context"),
  estimate: (sel) => call("estimate", sel),
  search_contacts: (txt) => call("search_contacts", { txt }),
  send: (payload) => call("send", { payload }),
  prefill: { groups: ["Customers"] },
  on_sent: () => list.refresh(),
  on_templates: () => frappe.set_route("List", "WhatsApp Template"),
});
```

## CSS hooks

- Layer/modal: `.sanad-kit.sanad-ce-layer.sanad-bs-layer` > `.sanad-ce-backdrop` +
  `.sanad-ce.sanad-bs[role=dialog]`; `body.sanad-ce-open` while any layer is open.
- Header: `.sanad-bs__top`, `__title`, `__subtitle`; body `__body`, `__grid`.
- Recipients: `__list-pane`, `__list-head`, `__segs` (`--sm`), `__seg` (`.is-sel`), `__seg-n`,
  `__search`, `__list`, `__row` (`.is-on`), `__avatar` (`--nf`, `--q`, `.is-on`), `__row-name`,
  `__row-sub`, `__badge--{wn|muted|pri|nf}`, `__mark` (`.is-on`, `.is-rm`), `__none`, `__manual`,
  `__numbers`, `__list-foot`, `__picked`, `__show` (`.is-on`), `__clear`.
- Message: `__main`, `__head`, `__head-title`, `__head-sub`, `__settings-btn`, `__settings`,
  `__form`, `__fld`, `__ctl`, `__who`, `__note`, `__thread`, `__day`, `__bubble`, `__bubble-file`,
  `__bubble-at`, `__empty`, `__attach`, `__composer`, `__round` (`--plain`, `--pri`), `__input`,
  `__clear-x`, `__bar`, `__est`, `__send` (`.is-ready`).

## Notes

- **Loading/error:** "Loading…" until `load()` resolves; a rejected `load()` shows its message
  with `role="alert"`. The Contacts list shows "Loading…" while searching and a "no results" line
  when empty.
- **Numbers:** split on newlines, commas, `،` and `;`; spaces, dashes and parentheses stripped;
  valid means `+?` and 9–15 digits; duplicates skipped; a Toast reports how many were added.
- **Guards before confirm** (each a warning Toast): no recipients, empty message and no
  attachment, device not Connected, "At a time" without a start time, rate above `max_rate`. The
  send pill stays clickable and gets `.is-ready` only when ready. Over 200 recipients the
  confirmation requires an acknowledgement checkbox.
- Choosing a template replaces the body with the template's `body`. A rate above 30 shows a ban-risk
  warning. The expected time is `total / rate` minutes.
- The "+" offers image, video, document, audio and contact; location is shown with a reason.
- **A11y:** `role="dialog"` + `aria-modal`, Tab trapped, Esc closes, focus returns to the opener;
  segments are `role="tab"` with `aria-selected`; rows are buttons with `aria-pressed`; the settings
  pill has `aria-expanded`. Numbers and phones render `dir="ltr"`; logical properties throughout.
- **Live use:** `whatsapp_next/page/wa_simulator/wa_simulator.js` ("Send a bulk message").

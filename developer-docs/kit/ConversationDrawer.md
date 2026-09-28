# `sanad.ui.ConversationDrawer`

The conversation variant of the side panel: the shared `.sanad-panel` shell (full-height sheet on
mobile) showing one number's merged outbound + inbound thread (a `sanad.ui.ChatThread`), the
number's link status badge and contextual actions — Add as contact / Open contact, Quick send,
Confirm conversation. One overlay at a time through `ui.overlay` (opening it closes a Drawer and
vice versa); it traps focus, closes on Escape / backdrop, restores focus to the opener and
unsubscribes its realtime handlers on close. **Constructing it opens it.**

**Portability:** tied to this app's backend. Default API keys are `messages.get_conversation`,
`numbers.get_number`, `numbers.search_numbers`, `numbers.confirm_conversation` (overridable via
`api`), and it expects their return shapes (`{rows, has_more, next_cursor}`; number rows with
`phone_e164`, `display_name`, `link_status`, `contact`, `number_type`, `last_device`,
`conversation_confirmed`). Realtime events `wa:message:status` / `wa:inbound:received` (with
`key_hash` = SHA-1 of the key) are app events. **Default role lists are hardcoded** as
`["WhatsApp Agent", "WhatsApp Manager"]` (override with `roles`).

## Options

| Option | Type | Default | Meaning |
|---|---|---|---|
| `key` | string | required | `phone_e164` or group JID; throws when empty. |
| `device` | string | — | Restrict the thread (and realtime matching when no hash) to one device. |
| `page_length` | number | `50` | `limit` per page. |
| `actions` | `Array<string \| spec>` | `["link", "quick_send", "confirm"]` | Built-in keys or custom specs. |
| `title` | string | number's `display_name`, the key, or "Unknown number" | Header title. |
| `width` | number \| CSS string | 520px (shell) | Sets `--sanad-panel-width`. |
| `on_close` | `(drawer) => void` | — | Not called on `close({silent: true})`. |
| `on_link` | `(number_row, drawer) => void` | — | Caller's link / convert dialog; without it "Add as contact" is not rendered. |
| `on_row_click` | `(row) => void` | — | Forwarded to ChatThread. |
| `roles` | `{quick_send?: [], confirm?: []}` | Agent / Manager roles | Role gates for those two actions. |
| `api` | `{conversation?, number?, number_search?, confirm?}` | see Portability | API key overrides. |

**Built-in actions** (`ui.visible_actions` against the number row):
- `link` — "Open contact" (`frappe.set_route("Form", "Contact", n.contact)`) when linked; else "Add as contact" → `on_link`, only for a known individual number.
- `quick_send` — opens `sanad.ui.QuickSend` with `phone` (or `jid` when the key contains `@`) and `device` (option or `last_device`); only if QuickSend is loaded.
- `confirm` — "Confirm conversation" / "Remove confirmation" for a known individual number.

**Custom action spec:** `{key, label, icon?, handler(number, drawer), condition?(number), roles?, perm?}`.

## Methods

- `close({silent} = {})` / `hide(opts)` (alias for `ui.overlay`).
- `load_number()` — re-fetch the header row (badge + actions show skeletons meanwhile).
- `load_first_page()`, `load_older()`, `refresh_newest()` (appends only rows the thread lacks, announces "{n} new messages arrived.").
- `confirm_conversation()` — runs `confirm_dialog` and updates the header.
- `render_header()`, `render_actions()`, `action_specs()`, `fetch_page(before?)`.
- Static: `open(opts)`, `current` (the open instance or `null`), `link_badge(linked)` → StatusBadge HTML ("Linked" green / "Not linked" gray, no icon), `confirm_dialog(number, api?)` → Promise (a `ConfirmDialog` with mandatory note; resolves with `{conversation_confirmed}`, rejects on cancel).

## Events and callbacks

- Callbacks: `on_close`, `on_link`, `on_row_click`, action `handler`s.
- Realtime subscribed while open: `wa:message:status` (`{outbound, status}` → `thread.update_status`); `wa:inbound:received` (`{key_hash, device}` → `refresh_newest()` when `key_hash` matches, or — before the hash is known / without WebCrypto — when `device` matches or no device was given).

## Server calls

| Key | Args | When |
|---|---|---|
| `numbers.search_numbers` | `{txt: key, page_length: 5}` (silent) | On open, to avoid a 404 for unknown keys. |
| `numbers.get_number` | `{phone_e164: key}` (silent) | When the search hit matches; falls back to the hit. |
| `messages.get_conversation` | `{key, limit, device?, before?}` (silent) | First page, "Load older" (`before` = `next_cursor`), realtime refresh. |
| `numbers.confirm_conversation` | `{phone_e164, confirmed: 0\|1, note}` | Confirm dialog submit. |

## Usage

```js
sanad.ui.ConversationDrawer.open({
  key: doc.phone_e164 || doc.jid,
  device: doc.last_device,
  on_link: (number) => open_link_dialog(number),
  on_close: () => listview.refresh(),
  actions: ["link", "quick_send", "confirm",
    { key: "unlink", label: __("Unlink"), roles: ["System Manager"], condition: (n) => !!(n && n.contact), handler: (n, d) => unlink(n).then(() => d.load_number()) }],
});
```

## CSS hooks

- Root `aside.sanad-kit.sanad-panel.sanad-convo` (`.sanad-panel--open`), `.sanad-convo__backdrop`.
- `__avatar` (two initials), `__title`, `__sub` (key, LTR), `__badge`, `__badge-skeleton`, `__close`, `__actions` (`role="group"`), `__action`, `__body`, `__state`, `__thread` (contains `.sanad-chat`).

## Notes

- States: skeleton (4 rows) → thread; empty → "No messages yet" / "Messages exchanged with this number will appear here."; 403 / `PermissionError` → "No access to conversations" (no retry); other errors → "Could not load the conversation" with Retry. Header badge and action row reserve space with skeletons while the number loads; a non-403 number-lookup error shows a toast and the thread still loads.
- Announces "{n} messages loaded." on first load. Phone numbers in confirm sentences are bidi-isolated (LRI…PDI).
- `role="dialog"` + `aria-modal`, labelled by the title; focus starts on the close button.
- The README says default roles come from `sanad.ui.config.defaults.roles`; the code actually uses the hardcoded `DEFAULT_ROLES`.
- Live use: `public/js/screens/numbers.js` (`open_conversation`, used by `public/js/listview/whatsapp_number_list.js` and `public/js/form/whatsapp_number.js`; `confirm_dialog`), `public/js/listview/whatsapp_number_list.js` (`link_badge`), `public/js/form/whatsapp_log.js`, `whatsapp_next/page/wa_contacts/wa_contacts.js`.

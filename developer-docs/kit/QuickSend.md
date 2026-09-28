# `sanad.ui.QuickSend`

The one-message composer as a `frappe.ui.Dialog`: recipient resolved server-side (name, number,
Known / New / Blacklisted / Group badges), device select with the configured default, optional
template with a live preview over a reference document, Text / Document / Image body, private
attachment + caption, optional schedule, and an "Open in the simulator" footer action.
**Constructing it opens the dialog** and loads the context.

**Portability:** tied to this app's backend. It calls `quick_send.get_context` / `.preview` /
`.send` (overridable via `api`) and relies on their shapes (`{recipient, devices, default_device,
templates, policy}`, `{body, errors}`, `{outbound, queue_item, warnings}`), on this app's error
types (`WAInvalidPhoneError`, `WABlacklistedError`, `WAUnknownNumberPolicyError`, `WAFileError`,
`WAValidationError`) and warning codes (`device_offline`, `queue_paused`).

## Options

All optional.

| Option | Type | Default | Meaning |
|---|---|---|---|
| `phone` | string | — | Pre-fills the recipient (hides the Phone field). |
| `contact` | string | — | Contact name; pre-fills and is sent as `contact`. |
| `number` | string | — | WhatsApp Number row. |
| `jid` | string | — | Group JID (sent to `get_context` as `phone`). |
| `reference_doctype` / `reference_name` | string | — | Document the template / body preview renders over; sent with the message. |
| `device` | string | context `default_device`, else first device | Pre-selected device. |
| `template` | string | — | Pre-selected template (triggers preview). |
| `body` | string | — | Initial message text. |
| `on_sent` | `(result) => void` | — | After a successful send; `{outbound, queue_item, warnings[]}`. |
| `on_close` | `() => void` | — | Dialog `on_hide`. |
| `api` | `{get_context?, preview?, send?}` | `quick_send.*` | API key overrides. |
| `simulator_route` | string | `sanad.ui.config.defaults.simulator_route` | Footer action route; no route → no action. |
| `title` | string | "Send message" | Dialog title. |

Also read from config: `sanad.ui.config.defaults.devices_route` (the "Open devices" fix button when
no device is enabled).

## Methods

- `send()` — validate inline, then call `send`; disables the primary button meanwhile.
- `preview()` — refresh the preview bubble (only with a template, or a reference + body).
- `hide()`.
- `load()`, `resolve_phone()`, `set_recipient(recipient)`, `set_error(fieldname, message, {focus})`, `clear_error(fieldname)`, `validate(values)`.
- Static: `QuickSend.open(opts)`.
- Properties: `dialog` (the `frappe.ui.Dialog`), `context`, `recipient`.

## Events and callbacks

`on_sent`, `on_close`. Template change and body input trigger a 400 ms debounced preview (body
input only when a reference is set). Phone blur resolves the recipient. No realtime.

## Server calls

| Key | Args | When |
|---|---|---|
| `quick_send.get_context` | `{phone?, contact?, number?, reference_doctype?, reference_name?}` (`jid` → `phone`) | On open; again (silent) on phone blur. |
| `quick_send.preview` | `{template, body, reference_doctype, reference_name}` (silent) | Template change / body input / open with template or reference. |
| `quick_send.send` | `{device, message_type, body, template, attachment, caption, scheduled_at, reference_doctype, reference_name, phone \| jid, contact?}` (silent) | Send. |

## Usage

```js
new sanad.ui.QuickSend({ phone: doc.phone_e164, contact: doc.contact, on_sent: () => listview.refresh() });
sanad.ui.QuickSend.open({ reference_doctype: frm.doctype, reference_name: frm.docname, template: "Invoice reminder" });
new sanad.ui.QuickSend();   // blank: the user types the number
```

## CSS hooks

- Dialog wrapper `.sanad-kit.sanad-sheet.sanad-quicksend`.
- `__recipient` (`--empty`), `__avatar`, `__who`, `__name`, `__phone`, `__badges`.
- `__preview`, `__preview-label`, `__bubble`; `__error` (`role="alert"`), `__field--invalid`, `__fix`, `__simulator`.

## Notes

- Fields: Recipient (HTML), Phone (only without a pre-filled recipient; wrapped by `sanad.ui.PhoneField` when loaded), Device, Template, Message type, Schedule, Message, Preview, Attachment (private, single) and Caption (only for non-Text types).
- Validation: every error inline with `aria-invalid` / `aria-describedby`; only the first invalid field takes focus. Server errors are mapped to the recipient line, Attachment or Message; others → `Toast.error`.
- States: recipient skeleton while loading; context error → EmptyState with Retry (or an inline phone error); blacklisted recipient disables Send with an explanation; no devices → inline error (+ "Open devices"); `policy.send_only_to_known_numbers` adds a hint under Phone.
- Warnings `device_offline` / `queue_paused` → `Toast.warnings`; success toast "Message queued" / "Message scheduled".
- Selecting a template makes the body optional and adopts the template's `message_type`.
- Live use: `public/js/screens/messages.js`, `public/js/screens/numbers.js`, `public/js/form/whatsapp_log.js`, `public/js/form/whatsapp_template.js`, `public/js/listview/whatsapp_log_list.js`, `public/js/listview/whatsapp_inbound_message_list.js`, `public/js/listview/whatsapp_template_list.js`, `whatsapp_next/page/wa_contacts/wa_contacts.js`, `whatsapp_next/page/wa_home/wa_home.js`; inside the kit, ConversationDrawer.

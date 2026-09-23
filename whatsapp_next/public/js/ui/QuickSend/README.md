# QuickSend

The one-message composer as a `frappe.ui.Dialog`: recipient resolved server-side (name, E.164,
**Known / New / Blacklisted** badges), device select with the configured default, optional
template with a live preview over the reference document, Text / Document / Image body, private
attachment, optional schedule, and an "Open in Simulator" footer link. Data flows only through the
configured keys `quick_send.get_context` / `quick_send.preview` / `quick_send.send` (overridable
with `api`), so the component knows nothing about the host app.

## Usage

```js
// from a row that knows the number
new sanad.ui.QuickSend({ phone: doc.phone_e164, contact: doc.contact, device: doc.device,
                         on_sent: () => listview.refresh() });

// from a document (template preview renders over it)
new sanad.ui.QuickSend({ contact: frm.doc.contact_person, reference_doctype: frm.doctype,
                         reference_name: frm.docname, template: "Invoice reminder" });

// blank — the user types the number, it is resolved on blur
listview.page.add_inner_button(__("Quick send"), () => new sanad.ui.QuickSend());
```

Options: `phone` | `contact` | `number` | `jid`, `reference_doctype`, `reference_name`,
`device`, `template`, `body`, `on_sent(result)` with `{outbound, queue_item, warnings[]}`,
`on_close`, `api {get_context, preview, send}`, `simulator_route` (default
`sanad.ui.config.defaults.simulator_route`), `title`. Methods: `send()`, `preview()`, `hide()`;
static `open(opts)`. Warnings `device_offline` / `queue_paused` become toasts through
`sanad.ui.Toast.warnings` (the message is queued anyway); `WAInvalidPhoneError`,
`WABlacklistedError`, `WAUnknownNumberPolicyError` land next to the recipient, `WAFileError` next
to the attachment, `WAValidationError` next to the message.

## Live use
Outbound list — `public/js/listview/whatsapp_log_list.js` (row action, drawer action, page
button); Outbound form — `public/js/form/whatsapp_log.js`; Inbound list "Reply" —
`public/js/listview/whatsapp_inbound_message_list.js`.

## Design gate
Applied from the phase-5 audit:
- The phone input is wrapped in `sanad.ui.PhoneField` (country hint, loose E.164 normalisation,
  `aria-describedby` hint) — no hard-coded example number; the client guess is sent, the server
  normaliser stays authoritative.
- Validation on blur; every error inline with `role="alert"` + `aria-describedby`; only the
  **first** invalid field takes focus (WCAG 2.4.3).
- "No device is enabled. Pair or enable a device, then try again." comes with an inline
  "Open devices" action (route from `sanad.ui.config.defaults.devices_route`, rendered only when
  configured — no dead button) (WCAG 3.3.3).
- `sanad-sheet`: full-height sheet with a sticky footer under 768 px like every kit dialog.
- Copy: "Open in the simulator", "No template (write the message)", "Enter a phone number to
  look up the recipient.", "This number is blacklisted, so the message cannot be sent.",
  "The template text is sent. Leave this empty, or type to replace it."
- Recipient line reserves its height while the context loads (skeleton); a blacklisted recipient
  disables Send and explains why.
- Preview is a chat bubble (what the recipient sees), errors listed under it; debounced 400 ms.
- Attachments are uploaded private; the attachment section only appears for Document / Image.
- Toasts for non-critical warnings (device offline, queue paused); success toast + `on_sent`;
  the global kit focus ring (no per-component focus rule).

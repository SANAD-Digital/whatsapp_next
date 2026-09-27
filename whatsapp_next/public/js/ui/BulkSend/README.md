# BulkSend

The prototype's "Send a bulk message" window (`docs/component/Send Message Dialog.dc.html`
around `docs/component/Bulk Send.dc.html`), value for value: a 1180 px full-height modal with a
white header over two panes.

- **Recipients** (330 px): the Groups · Contacts · Numbers segments with their counts, a pill
  search, rows with a round check (a blacklist group carries its badge), the numbers box ("one per
  line, or separated by commas"; invalid and repeated ones skipped), and the footer — "Selected N",
  "Show the selected" (each pick removable) and "Remove all".
- **The message**: the green header (who it goes to, the "Send settings" pill opening template ·
  device · rate · timing), the first recipient as the preview's identity, the note that the send is
  real, the message as it will arrive, the composer, and the estimates bar (recipients, expected
  time, from the plan) with the send pill.

The count is the host's `estimate` (blacklists applied), refreshed as the selection changes. Send
asks first (the prototype's confirmation with the facts; an acknowledgement over 200 recipients).

Portable: the host passes the data source. It draws on `CommandEditor`'s shell (the layer and the
modal), so both styles must load — the kit's `style.scss` imports both.

## Usage

```js
const call = (m, args) => sanad.ui.call(`bulk_send.${m}`, args);
new sanad.ui.BulkSend({
  load: () => call("get_context"),                     // {groups[], templates[], devices[], default_device, rate, messages_remaining}
  estimate: (sel) => call("estimate", sel),            // {total, excluded, invalid}
  search_contacts: (txt) => call("search_contacts", { txt }),   // [{name, label, phone, party_type}]
  send: (payload) => call("send", { payload }),        // → {campaign, status, recipients}
  prefill: { groups: ["Customers"] },                  // optional
  on_sent: (r) => {},
  on_templates: () => frappe.set_route("List", "Message Template"),
});
```

## Live use
The host app's simulator: its "Send a bulk message" button.

## Design gate
- `role="dialog"` + `aria-modal`, focus kept inside, Esc closes, focus returns to the opener;
  registered with `sanad.ui.overlay`.
- Segments are `role="tab"` with `aria-selected`; rows are buttons with `aria-pressed`; the
  settings pill carries `aria-expanded`.
- The send pill stays clickable when not ready and says why (no recipients, empty text, device
  offline, no start time) instead of doing nothing.
- "+" (message type) is drawn disabled with its reason: a bulk message carries text only for now.
- Product tokens only; logical offsets, so Arabic and English need nothing extra.

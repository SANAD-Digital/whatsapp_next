# `sanad.ui.StatusBadge`

A status pill. Its colour comes from the DocType's own indicator rules through `frappe.get_indicator`, so `listview_settings[doctype].get_indicator`, workflow states and docstatus all apply. Anything it cannot resolve falls back to gray. The label is always rendered, so colour is never the only signal. The green, red and amber tones also get an icon, and every other tone gets a dot. Use it as an instance mounted in a wrapper, or through the static `html()` renderer in formatters and templates.

## Options

| Option | Type | Default | Meaning |
|---|---|---|---|
| `wrapper` | jQuery \| HTMLElement | — | Where to render. Without it the instance is only useful through `html()`. |
| `doctype` | string | — | Resolves label and colour through `ui.indicator_for(doctype, doc)` (wraps `frappe.get_indicator`). |
| `fieldname` | string | `"status"` | The status field read from `doc`. |
| `doc` | Object | — | The document, or any `{[fieldname]: value}`. |
| `value` | string | — | Shortcut for `{ [fieldname]: value }`, used when `doc` is absent. |
| `colour` | string | — | An explicit Frappe colour (`green`, `orange`, `blue`, …). It skips the meta lookup. |
| `label` | string | translated raw value | An explicit label. When absent, the indicator's label wins over the raw value. |
| `icon` | boolean | `true` | Adds the semantic icon for the green / red / amber tones. Other tones always get a dot. |
| `size` | `"sm"` \| `"md"` | `"sm"` | Pill size. |
| `title` | string | — | The `title` attribute. Useful for labels that get truncated. |

Static `StatusBadge.html({label, colour, tone, icon, size, title})`: `tone` overrides the tone derived from `colour`.

## Methods

- `resolve()` returns `{label, colour, tone}` for the current options.
- `html()` returns the badge markup for the current options.
- `refresh(doc?)` replaces `opts.doc` when a doc is given, then re-renders into the wrapper.
- `static html(opts)` is the stateless renderer and does not look up meta.

## Events and callbacks

None.

## Server calls

None. Colour comes from client-side meta and `listview_settings`.

## Usage

```js
// in a list formatter
formatters: {
  status: (value, df, doc) =>
    sanad.ui.StatusBadge.html({ label: __(value), colour: sanad.ui.indicator_for(doc.doctype, doc).colour }),
},

// meta-driven, mounted
const badge = new sanad.ui.StatusBadge({ wrapper: $el, doctype: "WhatsApp Device", doc });
badge.refresh(updated_doc);
```

## CSS hooks

- `.sanad-badge` is the root. Size modifiers are `.sanad-badge--sm` and `--md`. The tone class is `.sanad-tone--{green|blue|amber|red|gray|cyan|violet|pink}`, and the colours come from the shared tone classes, not this stylesheet.
- `.sanad-badge__label` (ellipsis), `.sanad-badge__dot` (6 px, `currentColor`) and `.sanad-badge__icon`.

## Notes

- Tone mapping is `ui.tone(colour)`. For example, `orange` / `yellow` map to `amber` and `purple` maps to `violet`. Unknown colours map to `gray`.
- If the meta is not loaded yet, `ui.indicator_for` swallows the error and returns a neutral gray badge.
- The icons and dot are `aria-hidden`. The label is the accessible text.
- Live use outside the kit:
  - `public/js/form/whatsapp_command.js`
  - `public/js/listview/`: `whatsapp_campaign_list.js`, `whatsapp_contact_group_list.js`, `whatsapp_inbound_message_list.js`, `whatsapp_notification_alert_list.js`, `whatsapp_notification_list.js`, `whatsapp_queue_item_list.js`, `whatsapp_template_list.js`
  - `public/js/screens/`: `campaigns.js`, `messages.js`, `settings.js`
  - `whatsapp_next/page/wa_contacts/wa_contacts.js` and `wa_functions_center/wa_functions_center.js`
- Kit users: DataList, Drawer, ConversationDrawer, ContactPicker, PagedChildTable, QuickSend and Render.

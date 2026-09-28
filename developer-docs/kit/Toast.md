# `sanad.ui.Toast`

A thin wrapper over `frappe.show_alert`. It maps semantic tones to Desk indicators, sets an auto-dismiss time per tone, and can add one inline action link. Constructing a Toast shows it immediately. Desk's alert container is already a live region, so the Toast adds no announcement of its own. Placement is Desk's own and follows the document direction.

## Options

The constructor takes either a message string or an object with these options.

| Option | Type | Default | Meaning |
|---|---|---|---|
| `message` | string | — | Body text. It is escaped. |
| `title` | string | — | Bold first line, joined to the message with `<br>`. |
| `tone` | `"success"` \| `"info"` \| `"warning"` \| `"error"` | `"info"` | Maps to the Desk indicator `green` / `blue` / `orange` / `red`. |
| `seconds` | number | success 4, info 5, warning 6, error 8 | Auto-dismiss time. The default is 5 when the tone is unknown. |
| `action` | `{label, on_click}` | — | One inline link after the text. `onclick` is accepted as an alias. |

## Methods

- `show()` (re)shows the alert. It is called by the constructor and stores the returned alert in `this.$alert`.
- `Toast.success(message, opts?)`, `Toast.info(…)` and `Toast.warning(…)` are shortcuts that set the tone.
- `Toast.error(messageOrError, opts?)` accepts an `Error`-like object and uses its `.message`.
- `Toast.warnings(codes = [], labels = {})` shows one warning toast per code. The text is `labels[code]` when present, or `__(code)` otherwise.

## Events and callbacks

- `action.on_click()` runs when the action link is clicked. The handler is bound on the next tick with `setTimeout(…, 0)`, found by a unique `data-id`.

## Server calls

None.

## Usage

```js
sanad.ui.Toast.success(__("Message queued"));
sanad.ui.Toast.error(err);
sanad.ui.Toast.warning(__("Device offline — message stays queued"), {
  action: { label: __("Open devices"), on_click: () => frappe.set_route("wa-devices") },
});
sanad.ui.Toast.warnings(r.warnings, { device_offline: __("The device is offline.") });
```

## CSS hooks

- `.sanad-toast__action` is the inline action link: start margin, weight 600, underlined. Everything else is Desk's `.alert` markup.

## Notes

- The `README.md` says errors are announced as `assertive` and success/info as `polite`. The code does not do this: it adds no live region and relies entirely on Desk's alert container.
- Do not put decisions in toasts. Use ConfirmDialog for those.
- Live use outside the kit:
  - `public/js/form/`: `whatsapp_command.js`, `whatsapp_device.js`, `whatsapp_log.js`, `whatsapp_notification.js`, `whatsapp_notification_alert.js`, `whatsapp_queue_item.js`
  - `public/js/listview/`: `whatsapp_command_list.js`, `whatsapp_log_list.js`, `whatsapp_notification_alert_list.js`, `whatsapp_notification_list.js`, `whatsapp_queue_item_list.js`
  - `public/js/screens/`: `campaign/audience.js`, `campaign/messages.js`, `campaign/monitor.js`, `campaign/review.js`, `campaigns.js`, `messages.js`, `numbers.js`, `queue.js`, `settings.js`
  - `whatsapp_next/page/`: `wa_contacts`, `wa_devices`, `wa_functions_center`, `wa_home`, `wa_onboarding`, `wa_simulator`
- Kit users: BulkActions, RowActions, BulkSend, ChatThread, CommandEditor, ConfirmDialog, ContactPicker, ConversationDrawer, DataList, Drawer, FunctionDetail, ListStatsCard, QuickSend, Render and TemplateEditor.

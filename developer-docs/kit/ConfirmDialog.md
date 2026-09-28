# `sanad.ui.ConfirmDialog`

A confirmation that states the **impact** of an action before it runs: a list of `{label, value}`
facts (supplied by the caller, or fetched after open while a skeleton shows), an optional
mandatory reason, an optional "I understand" checkbox that gates the primary button, and a
danger variant. It wraps `frappe.ui.Dialog`, so Escape, backdrop click and focus trapping are
Desk's own; the kit adds the impact layout, the copy defaults and a promise interface. It makes
no server calls itself and holds no app-specific strings.

## Options

| Option | Type | Default | Meaning |
|---|---|---|---|
| `title` | string | — | Dialog title. |
| `message` | string | — | One sentence shown above the impact list. |
| `impact` | `Array<{label, value, tone?}>` | `[]` | Facts rendered as a `<dl>`. `tone` is passed through `ui.tone()` and added as `sanad-tone--<tone>` on the value. |
| `load_impact` | `() => Promise<impact[]>` | — | Called on `show()`; a skeleton shows until it resolves, then the list re-renders. A rejection appends an inline `role="alert"` error. |
| `reason_field` | `true` \| `{label?, required?, description?}` | — | Adds a `Small Text` field `reason`. Required unless `required === false`. Label defaults to "Reason", description to "Recorded in the audit log." |
| `ack_checkbox` | string | — | Label of a Check field; the primary button stays disabled until it is ticked. |
| `danger` | boolean | `false` | Swaps `btn-primary` for `btn-danger` on the primary button. |
| `confirm_label` | string | "Confirm" | Primary button text (name the verb). |
| `cancel_label` | string | "Cancel" | Secondary button text. |
| `size` | string | `"small"` | Passed to `frappe.ui.Dialog`. |
| `on_confirm` | `({reason}) => Promise\|any` | — | Runs on confirm. A rejected promise keeps the dialog open, re-enables the button and toasts `err.message` via `sanad.ui.Toast.error`. |
| `on_cancel` | `() => void` | — | Called on Cancel, Escape, backdrop or any hide without a confirm. |

## Methods

- `show()` — opens the dialog, starts `load_impact`, returns a Promise that resolves with the
  `on_confirm` result (or the `{reason}` payload when `on_confirm` returns `undefined`) and
  rejects with `Error("cancelled")` on cancel.
- `static ask(opts)` — `new ConfirmDialog(opts).show()`; the usual entry point.
- `render_impact(impact)` — re-renders the message and impact list (e.g. to update counts).
- `confirm(values)` / `cancel(silent = false)` — what the buttons call; callers rarely need them.
- `dialog` — the underlying `frappe.ui.Dialog` instance.

## Events and callbacks

- `on_confirm({reason})`, `on_cancel()`.
- Listens to Bootstrap `hidden.bs.modal` on the dialog wrapper to treat any unconfirmed close as a cancel.
- No realtime subscriptions.

## Server calls

None. Callers do their own calls inside `load_impact` / `on_confirm`.

## Usage

```js
sanad.ui.ConfirmDialog.ask({
  title: __("Cancel {0} messages?", [names.length]),
  impact: [{ label: __("Will be cancelled"), value: names.length, tone: "red" }],
  reason_field: true,
  ack_checkbox: __("I understand these messages will not be sent."),
  danger: true,
  confirm_label: __("Cancel messages"),
  on_confirm: ({ reason }) => frappe.xcall("my_app.api.cancel", { names, reason }),
})
  .then(() => sanad.ui.Toast.success(__("Cancelled")))
  .catch(() => {}); // user cancelled
```

## CSS hooks

- Root: the dialog `$wrapper` gets `sanad-kit sanad-confirm`.
- `sanad-confirm__message`, `sanad-confirm__impact` (the `<dl>`), `sanad-confirm__row`
  (`dt` label / `dd.sanad-tabular` value, plus `sanad-tone--*`), `sanad-confirm__error`.

## Notes

- States: skeleton (`ui.skeleton(2, {lines: 1})`) while `load_impact` runs; inline error on
  failure; primary button disabled while `on_confirm` is pending (double-submit guard).
- Keyboard/focus/ARIA come from `frappe.ui.Dialog` (Escape closes and counts as cancel).
- Toast on `on_confirm` rejection only when the error has a `message`.
- Live use: `public/js/form/whatsapp_command.js`, `whatsapp_device.js`, `whatsapp_notification.js`,
  `whatsapp_notification_alert.js`; `public/js/listview/whatsapp_command_list.js`,
  `whatsapp_notification_list.js`, `whatsapp_notification_alert_list.js`,
  `whatsapp_queue_item_list.js`; `public/js/screens/campaigns.js`, `messages.js`, `numbers.js`,
  `queue.js`, `settings.js`, `campaign/audience.js`, `campaign/monitor.js`, `campaign/review.js`;
  pages `whatsapp_next/page/wa_devices/wa_devices.js`, `wa_functions_center/wa_functions_center.js`,
  `wa_home/wa_home.js`. Inside the kit: BulkActions, BulkSend, CommandEditor, ContactPicker,
  ConversationDrawer, ListStatsCard, MessageComposer.

# ConfirmDialog

A confirmation that states the **impact** before running: facts as `{label, value}` rows (counts
the caller already has, or fetched with `load_impact` while a skeleton shows), an optional
mandatory reason ("recorded in the audit log"), an optional "I understand…" checkbox that gates
the button, and a danger variant. Built on `frappe.ui.Dialog`, so Escape, backdrop and focus
trapping are Desk's own.

## Usage

```js
sanad.ui.ConfirmDialog.ask({
  title: __("Pause the queue?"),
  message: __("Sending stops immediately. Messages stay queued."),
  load_impact: () => sanad.ui.call("queue.get_summary").then((s) => [
    { label: __("Messages that will stop"), value: s.counts_by_status.Queued || 0 },
    { label: __("Current rate"), value: __("{0} / minute", [s.rate]) },
  ]),
  reason_field: true,
  confirm_label: __("Pause"),
  on_confirm: ({ reason }) => sanad.ui.call("queue.pause_queue", { reason }),
}).then(() => sanad.ui.Toast.success(__("Queue paused")))
  .catch(() => {});   // cancelled

sanad.ui.ConfirmDialog.ask({
  title: __("Cancel {0} messages?", [n]),
  impact: [{ label: __("Will be cancelled"), value: n, tone: "red" }],
  ack_checkbox: __("I understand these messages will not be sent."),
  danger: true,
  confirm_label: __("Cancel messages"),
});
```

Options: `title`, `message`, `impact[]`, `load_impact()`, `reason_field` (`true` or
`{label, required, description}`), `ack_checkbox`, `danger`, `confirm_label`, `cancel_label`,
`on_confirm({reason})` (return a promise; rejection keeps the dialog open and toasts the error),
`on_cancel`, `size`. `show()` returns a promise resolved with the confirm payload / rejected on cancel.

## Live use
Campaigns list bulk pause/cancel, Outbound `messages.cancel` (reason), ContactPicker confirm step.

## Design gate
- The primary button names the verb ("Pause", "Cancel messages"), never "OK".
- Reason field explains where it goes; acknowledgement checkbox gates destructive actions.

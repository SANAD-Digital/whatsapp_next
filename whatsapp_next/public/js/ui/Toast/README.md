# Toast

A thin wrapper over `frappe.show_alert` that fixes tone, timing and accessibility once:
`success` 4 s · `info` 5 s · `warning` 6 s · `error` 8 s, every toast announced through an
aria-live region, one optional inline action. Position follows Desk (bottom-start on RTL).

## Usage

```js
sanad.ui.Toast.success(__("Message queued"));
sanad.ui.Toast.error(err);                                  // accepts an Error or a string
sanad.ui.Toast.warning(__("Device offline — message stays queued"), {
  action: { label: __("Open devices"), on_click: () => frappe.set_route("wa-devices") },
});
sanad.ui.Toast.warnings(r.warnings, {
  device_offline: __("The device is offline; the message will be sent when it reconnects."),
  queue_paused: __("The queue is paused; the message will be sent after it resumes."),
});
new sanad.ui.Toast({ title: __("Campaign started"), message: name, tone: "success", seconds: 3 });
```

## Live use
QuickSend (warnings after `send`), BulkActions (progress result), Outbound list row actions.

## Design gate
- Auto-dismiss 3–8 s (transient, non-critical only); anything that needs a decision uses
  ConfirmDialog, never a toast.
- Errors use `assertive` announcement; success/info use `polite`.

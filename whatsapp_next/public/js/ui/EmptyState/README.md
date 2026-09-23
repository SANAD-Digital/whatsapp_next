# EmptyState

The four non-data states of any panel, list or page — `loading`, `empty`, `error`, `offline` —
rendered the same way everywhere. Loading is a **skeleton, never a spinner** (prototype rule);
`error` and `offline` render with `role="alert"` so screen readers announce them; each state can
carry a primary action ("Create…", "Retry") and a secondary one.

## Usage

```js
const state = new sanad.ui.EmptyState({ wrapper: $panel, state: "loading" });

sanad.ui.call("home.get_dashboard")
  .then((data) => {
    if (!data.devices.length) {
      return state.empty({ title: __("No devices yet"), description: __("Pair a phone to start sending."),
        action: { label: __("Pair a device"), on_click: () => frappe.set_route("wa-devices") } });
    }
    state.hide();
    render(data);
  })
  .catch((err) => state.error(err, { action: { label: __("Retry"), on_click: load } }));
```

Options: `wrapper`, `state`, `title`, `description`, `action {label, onclick, icon, primary}`,
`secondary {label, onclick}`, `rows` (skeleton rows), `size` (`sm` | `md`).
Methods: `loading()`, `empty()`, `error(err)`, `offline()`, `set(state, opts)`, `hide()`.

## Live use
Drawer body (loading / error), ContactPicker source panes and Selected tab, PagedChildTable,
ListStatsCard modal.

## Design gate
- Reserved height (`min-height`) so the panel does not jump between skeleton and content.
- Errors announced (`role="alert"`) and always paired with a retry action when one exists.

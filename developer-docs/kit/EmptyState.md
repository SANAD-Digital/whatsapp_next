# `sanad.ui.EmptyState`

The single renderer for the four non-data states of any panel, list or page:

- `loading` shows skeleton rows, never a spinner.
- `empty` shows the empty message.
- `error` shows the error with `role="alert"` and an optional retry.
- `offline` shows the offline message.

Custom pages, drawers and kit components render these states through it so they look and behave the same everywhere. The instance keeps its options, and every state method merges new options before it re-renders.

## Options

| Option | Type | Default | Meaning |
|---|---|---|---|
| `wrapper` | jQuery \| HTMLElement | — (required) | The container. Its content is replaced on every render. |
| `state` | `"loading"` \| `"empty"` \| `"error"` \| `"offline"` | `"empty"` | The initial state. An unknown value renders the `empty` defaults. |
| `title` | string | per state: "Loading…", "Nothing here yet", "Something went wrong", "You are offline" | The heading. For `loading` it is only a visually hidden label. |
| `description` | string | — | Muted text under the title. |
| `action` | `{label, on_click, icon?, primary?}` | — | The main button, `btn-primary` unless `primary: false`. `onclick` is accepted as an alias. |
| `secondary` | `{label, on_click}` | — | A second button (`btn-default`). `onclick` is accepted as an alias. |
| `rows` | number | `3` | Skeleton rows for `loading`. |
| `size` | `"sm"` \| `"md"` | `"md"` | Padding and minimum height. |

The default icons are `es-line-inbox` for `empty`, `es-line-alert-circle` for `error` and `es-line-wifi-off` for `offline`. `loading` has no icon. There is no option to change the icon.

## Methods

- `set(state, opts = {})` merges `opts`, sets the state, re-renders, and returns `this`.
- `loading(opts)`, `empty(opts)` and `offline(opts)` are shortcuts for `set`.
- `error(err, opts = {})` shows the error state. The description is `err.message` when `err` has one, otherwise `opts.description`.
- `hide()` empties the wrapper.
- `render()` renders the current options.

## Events and callbacks

- `action.on_click()` and `secondary.on_click()` run on button click.

## Server calls

None.

## Usage

```js
const state = new sanad.ui.EmptyState({ wrapper: $panel, state: "loading" });
sanad.ui.call("home.get_dashboard")
  .then((data) => {
    if (!data.devices.length)
      return state.empty({ title: __("No devices yet"),
        action: { label: __("Pair a device"), on_click: () => frappe.set_route("wa-devices") } });
    state.hide();
    render(data);
  })
  .catch((err) => state.error(err, { action: { label: __("Retry"), on_click: load } }));
```

## CSS hooks

- `.sanad-empty` is the root. Size modifiers are `--sm` and `--md`. State modifiers are `--loading`, `--empty`, `--error` and `--offline`.
- Inner elements are `.sanad-empty__icon`, `__title`, `__desc` and `__actions`. `__actions` is removed when it has no buttons.
- The icon is red in `--error` and amber in `--offline`. The root has a reserved `min-height` (120 px, or 80 px for `sm`) so the panel does not jump.

## Notes

- `loading` renders `role="status" aria-busy="true"` with a visually hidden title and `ui.skeleton(rows)`.
- `error` and `offline` render with `role="alert"`.
- Options persist across calls. A `description` set for `error` stays for a later `empty()` unless you pass a new one.
- Live use outside the kit:
  - `public/js/form/whatsapp_command.js`
  - `public/js/listview/`: `whatsapp_campaign_list.js`, `whatsapp_contact_group_list.js`, `whatsapp_inbound_message_list.js`
  - `public/js/screens/settings.js`
  - `whatsapp_next/page/`: `wa_contacts`, `wa_devices`, `wa_functions_center`, `wa_home`, `wa_simulator`
- Kit users: ChatThread, Collection, ContactPicker, ConversationDrawer, DashboardBlock, DataList, Drawer, FilterBar, ListStatsCard, MessageComposer, PageHeader, PagedChildTable, QuickSend, Render, TemplateEditor and TreeGroupBy.

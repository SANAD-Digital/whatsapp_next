# `sanad.ui.BulkActions`

Runs actions over the checked rows of a Desk list. Each action is registered in the list's own **Actions** menu with `page.add_actions_menu_item`, and Desk shows that menu once rows are checked. An action runs in one of three modes:

- **Native** calls the API once with `{names}`.
- **`per_name`** loops over the names and calls the API once per name with `{name}`, behind a progress dialog the user can stop.
- **`handler`** replaces the API call with your own function.

Labels carry the selection count, selections are capped, an optional ConfirmDialog can ask first, and every run ends with a result toast, `clear_checked_items()` and `listview.refresh()`.

## Options

| Option | Type | Default | Meaning |
|---|---|---|---|
| `listview` | ListView | — (required) | The Desk list. The constructor throws if it is missing. |
| `actions` | Array | `[]` | The action specs described below. |
| `cap` | number | `200` | The maximum number of checked rows per run. |

Action spec:

| Key | Type | Meaning |
|---|---|---|
| `label` | string \| `(count) => string` | Menu text. A string gets " (n)" appended while rows are checked. |
| `method` | string | The API key called through `ui.call`. |
| `args` | `(names, {docs, reason}) => Object` | Extra arguments merged over `{names}` (native) or `{name}` (per name). |
| `per_name` | boolean | Loop over the names one at a time, with a progress dialog. |
| `handler` | `(names, docs, payload) => any` | Replaces the API call. `payload` is the ConfirmDialog result, or `{reason: null}`. |
| `confirm` | Object \| `(names, docs) => Object \| null` | A `sanad.ui.ConfirmDialog.ask` spec. Cancelling it aborts the run. |
| `condition` | `(docs) => boolean` | Evaluated on every selection change to show or hide the menu item. An exception hides it. |
| `roles` | string[] | Any-of role check, decided once at mount. |
| `perm` | string | A ptype on the list's DocType, decided once at mount. |
| `cap` | number | A per-action override of `opts.cap`. |
| `success` | string \| `(result, names) => string` | The success toast text. A function replaces the default report entirely. |
| `on_done` | `(result, names) => void` | Called after the refresh. |

`progress` and `icon` do not exist on the action spec. `progress` appears only in the JSDoc and `icon` only in `README.md`; neither is read by the code.

## Methods

- `update()` refreshes the count in each label, re-evaluates `condition(docs)` and announces "{n} selected". It runs automatically on selection change.
- `run(action)` performs one action over the current selection.
- `run_native(action, names, docs, payload)` makes one `ui.call` with `{freeze: true}` and returns its result.
- `run_per_name(action, names, docs, payload)` loops and resolves to `{count, done[], failed[{name, error}], skipped[], cancelled}`.
- `report(action, result, names)` shows the result toast.
- `destroy()` removes the menu items. It does not restore `on_row_checked`.

## Events and callbacks

- It wraps `listview.on_row_checked` so that every selection change calls `update()`.
- `handler`, `confirm`, `condition`, `args`, `success` and `on_done` are described in the action spec.
- `listview.disable_list_update` is set while an action runs.

## Server calls

| Call | Args | When |
|---|---|---|
| `action.method` (host key, `ui.call`) | `{names, reason?, …args()}`, frozen with "Working on {n} rows…" | native mode |
| `action.method` (host key, `ui.call`, `silent`) | `{name, reason?, …args([name])}` for each name, one after another | `per_name` mode |

The default report understands a result of `{count}` or `{count, failed[], skipped[], cancelled}`.

## Usage

```js
new sanad.ui.BulkActions({
  listview,
  actions: [{
    label: (n) => __("Pause {0}", [n]),
    method: "campaigns.pause_many",
    roles: ["WhatsApp Manager"],
    condition: (docs) => docs.some((d) => d.status === "Running"),
    confirm: (names) => ({ title: __("Pause {0} campaigns?", [names.length]), reason_field: { label: __("Reason"), required: true } }),
    success: (r) => __("Paused {0} campaigns", [r.count]),
  }],
});
```

## CSS hooks

- `.sanad-bulk__item` is the class added to each Actions-menu item.
- The progress dialog is `.sanad-bulk__dialog` (also `.sanad-kit`). It contains `.sanad-bulk__progress` (`role="progressbar"`), `.sanad-bulk__bar` and `.sanad-bulk__status`.

## Notes

- With no rows selected, running an action shows `Toast.info`. Above the cap it shows `Toast.warning` naming both the cap and the current count.
- Errors are toasted, except when the message is `"cancelled"`.
- The progress dialog is `static`. Its secondary "Stop" button becomes "Stopping…", and the loop stops before the next name.
- The dialog's `aria-live` status region is rendered once, and only its text and `aria-valuenow` update on each step.
- `roles` / `perm` are checked once at mount, while `condition` is re-checked per selection. Items are matched back to their specs by `label` + `method`.
- Live use outside the kit:
  - `public/js/listview/`: `whatsapp_campaign_list.js`, `whatsapp_command_list.js`, `whatsapp_number_list.js`
  - `public/js/screens/messages.js` (`message_list`, through `opts.bulk`). Only `whatsapp_log_list.js` passes `bulk` today.

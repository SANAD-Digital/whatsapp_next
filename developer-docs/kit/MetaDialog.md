# `sanad.ui.MetaDialog`

A `frappe.ui.Dialog` whose fields come from the DocType meta. The caller names fieldnames per tab
(or one flat list); label, fieldtype, options, `reqd`, description and `depends_on` come from
`frappe.get_meta`, and child tables render as an editable Table control over the child meta
(rows held on `df.data`, no form object needed). It loads a document by name or starts from
`values`, validates required fields inline (on blur and on submit, with a focusable summary),
submits through an API key or a handler, and shows server errors inline.

**Portability:** fully generic — works with any DocType; the submit key is resolved by
`sanad.ui.call` (a configured key or a dotted path).

## Options

| Option | Type | Default | Meaning |
|---|---|---|---|
| `doctype` | string | required | Throws without it. |
| `name` | string | — | Load with `frappe.db.get_doc`; title defaults to "Edit {DocType}" (else "New {DocType}"). |
| `values` | object | `null` | Initial values; merged over the loaded document. |
| `title` | string | see `name` | Dialog title. |
| `tabs` | `[{label, fields[]}]` | — | One Tab Break per entry (label default "Details"). |
| `fields` | array | `[]` | Single-pane alternative to `tabs`. |
| `primary_action` | object | — | See below; omitted (or `read_only`) → no primary button. |
| `extra_actions` | `[{label, handler(values, dialog), css_class?}]` | `[]` | Footer buttons; `values` are `get_values({clean: true})`. |
| `read_only` | boolean | `false` | Every field read-only, grids locked, primary hidden. |
| `size` | `"small"` \| `"large"` \| `"extra-large"` | `"large"` with tabs | Dialog size. |
| `on_change` | `(fieldname, value, dialog)` | — | After any non-layout, non-Table field changes. |
| `on_load` | `(doc, dialog)` | — | Once values are in place. |
| `on_hide` | `(dialog)` | — | Dialog `on_hide`. |

**Field entries:** `"fieldname"`; `{fieldname, ...docfield overrides}` (meta first, overrides on
top; a field missing from meta needs its own `fieldtype`, else it is skipped with a console
warning); or `{fieldtype: "HTML", fieldname, label?, render($wrapper, dialog)}`.

**`primary_action`:** `{label = "Save", method?, args?(values, dialog), handler?(values, dialog), on_success?(result, dialog), keep_open?}`
— `handler` (returns a promise) replaces the call; otherwise `ui.call(method, args ? args(values, dialog) : values)`.
The dialog closes on success unless `keep_open`.

## Methods

- `show()` → Promise<this> — awaits meta, shows, loads values.
- `ready` — Promise resolving once meta is loaded and `dialog` exists.
- `hide()`, `set_title(title)`, `get_field(fieldname)`.
- `get_values({clean} = {})` — all values; Table fields as row arrays (`clean` keeps child-meta fieldnames + `idx`).
- `set_values(obj)` → Promise — Table fields take row arrays and re-render the grid.
- `set_read_only()`, `validate()` → boolean, `validate_field(field)`, `focus_field(fieldname)`, `clear_errors()`, `show_error(err, {retry})`, `submit()`, `load()`.
- Static: `MetaDialog.clean_rows(rows, child_doctype)`.
- Properties: `dialog`, `doc`, `meta`, `result` (last submit result).

## Events and callbacks

`on_change`, `on_load`, `on_hide`, `primary_action.handler` / `on_success`, `extra_actions[].handler`,
HTML pane `render`. No custom events, no realtime.

## Server calls

| Call | When |
|---|---|
| `frappe.model.with_doctype` (via `ui.meta.with_doctype`) | Construction. |
| `frappe.db.get_doc(doctype, name)` | `show()` / `load()` when `name` is set. |
| `ui.call(primary_action.method, args)` | Submit, unless a `handler` is given. |

## Usage

```js
new sanad.ui.MetaDialog({
  doctype: "ToDo",
  name,
  tabs: [
    { label: __("Task"), fields: ["description", "priority", "date", { fieldname: "status", read_only: 1 }] },
    { label: __("Preview"), fields: [{ fieldtype: "HTML", fieldname: "preview", render: ($el) => $el.text("…") }] },
  ],
  primary_action: {
    label: __("Save"),
    method: "my_app.api.save_task",
    args: (values) => ({ name, payload: values }),
    on_success: () => sanad.ui.Toast.success(__("Saved")),
  },
}).show();
```

## CSS hooks

- Wrapper `.sanad-kit.sanad-sheet.sanad-metadialog`, modifiers `--loading`, `--readonly`.
- `__alert` (container prepended to the body), `__summary` (`__summary-title`, list of links), `__error` (with Retry), `__field-error`, `__field--invalid` (plus Frappe's `has-error`).

## Notes

- Loading: body `aria-busy`, primary disabled, `--loading` class; load failure → inline error with Retry.
- Validation skips hidden, dependency-hidden, layout and HTML fields; HTML is stripped before emptiness checks. The summary (`role="alert"`, `tabindex="-1"`) activates the first invalid field's tab and takes focus; each link focuses its field. Field errors use `aria-invalid` + `aria-describedby`.
- Server errors render inline (Frappe's msgprint, if any, stays); a rejection with message `"cancelled"` is silent; the primary button is re-enabled.
- Live use: none outside the kit at present (only registered in `public/js/ui/index.js`). The README's claim of use in `public/js/form/whatsapp_command.js` is stale.

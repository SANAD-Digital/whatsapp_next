# MetaDialog

A `frappe.ui.Dialog` whose fields are the DocType's own: the caller lists **fieldnames per tab**
and label, fieldtype, options, `reqd`, description and `depends_on` all come from
`frappe.get_meta` (loaded with `frappe.model.with_doctype`); child tables render as a Table control
over the child meta. It loads a document by name (`frappe.db.get_doc`) or starts from `values`,
validates required fields with an inline, focusable summary, submits through a configured API key
(`sanad.ui.call`) or a handler, shows server errors inline (Frappe's msgprint stays) and re-enables
the button. Portable to any DocType — the field lists are options, never code.

## Usage

```js
const dialog = new sanad.ui.MetaDialog({
  doctype: "ToDo",
  name,                                   // omit for a new record
  title: name ? __("Edit task") : __("New task"),
  tabs: [
    { label: __("Task"), fields: ["description", "priority", "date", { fieldname: "status", read_only: 1 }] },
    { label: __("Assignment"), fields: ["allocated_to", "reference_type", "reference_name"] },
    { label: __("Preview"), fields: [{ fieldtype: "HTML", fieldname: "preview", render: ($el, d) => $el.text("…") }] },
  ],
  primary_action: {
    label: __("Save"),
    method: "tasks.save_task",            // API key from sanad.ui.config.api, or a dotted path
    args: (values, d) => ({ payload: values }),
    on_success: (r, d) => sanad.ui.Toast.success(__("Saved")),
  },
  extra_actions: [{ label: __("Duplicate"), handler: (values, d) => …}],
  on_change: (fieldname, value, d) => fieldname === "priority" && d.set_values({ status: "Open" }),
  on_load: (doc, d) => …,
  read_only: false,
  size: "large",
});
dialog.show();                            // → Promise<dialog> once meta + document are in place
```

Options: `doctype`, `name`, `values`, `title`, `tabs[{label, fields[]}]` | `fields[]` (entries:
`"fieldname"`, `{fieldname, …df overrides}`, `{fieldtype: "HTML", fieldname, render($wrapper, dialog)}`),
`primary_action {label, method | handler(values, dialog), args(values, dialog), on_success(result, dialog), keep_open}`,
`extra_actions[{label, handler}]`, `read_only`, `size`, `on_change`, `on_load`, `on_hide`.

Methods: `show()`, `hide()`, `get_values({clean})` (`clean` keeps only child-meta fieldnames on
rows), `set_values(obj)`, `set_read_only()`, `get_field(fieldname)`, `set_title()`, `validate()`,
`ready` (promise), `dialog` (the underlying `frappe.ui.Dialog`).
Static: `MetaDialog.clean_rows(rows, child_doctype)`.

Table fields: rows are held on the control (`df.data`) — no form object is needed — and come back
from `get_values()` as arrays; `set_values({outputs: rows})` re-renders the grid.

## Live use
Commands list and form — `public/js/form/whatsapp_command.js` (`command_modal`, tabs Command ·
Permissions · Preview), opened from `public/js/listview/whatsapp_command_list.js`.

## Design gate
- Failed submit → a focusable summary (`role="alert"`, `tabindex="-1"`) listing the fields as links
  that switch to the right tab and focus the control; each field carries its own error text with
  `aria-describedby` / `aria-invalid`; required fields validate on blur.
- Server errors render inline next to the form (not only as a toast) and the primary button is
  re-enabled; "cancelled" handler rejections are silent. Copy: "Something went wrong. Try again."
  (no "please"), "Fill in the required fields".
- Focus goes to the first field on open (Frappe's dialog); the tab strip stays sticky while
  scrolling; loading marks the body `aria-busy` and disables the primary action until values are set.
- Shared shell: the wrapper carries `sanad-kit sanad-sheet` — the kit's one mobile-sheet rule
  (`100dvh`, sticky footer, `scroll-padding-block-end`) and the one global `:focus-visible` ring;
  no per-component copies. Spacing through `--sanad-gap-*` tokens.

# CommandEditor

The prototype's command editor (`docs/component/Command Editor.dc.html`), value for value: a
full-height modal on the page background with a header (command word, "not saved yet" chip, status
switch, close; tabs Setup · Permissions · Preview; 30-day runs and the function chip), three tabs
and a footer (Save · Cancel · hint · Delete).

- **Setup** (340 | 1fr | 1fr): Definition — function search, synonyms (Enter adds), words the
  function suggests, allowed party types, "requires linking"; Variables and options — the
  function's inputs with an on / off switch each, its settings (check / number / list / text,
  "Default: …"); Outputs — text templates with variable chips that append `{{ var }}`, document
  outputs (print format, file name). "Restore function defaults" / "Restore default texts".
- **Permissions**: one segment per allowed party type; Allow All (the entries are a blacklist) or
  Deny All (a whitelist); contact groups and specific contacts through search pickers.
- **Preview** (320 | 1fr | 420): assumptions (sender type, sender contact, its account, the
  variables, "Fill with examples"), the same options and outputs, and the reply as the customer
  receives it — the unsaved draft run by the host's `preview` (a real dry run: nothing saved,
  nothing sent) in a `ChatThread`.

Under 1080 px the first column spans two rows beside the second; under 760 px everything stacks
and the modal body scrolls.

Portable: the component knows nothing about the host app. The host passes the data source.

## Usage

```js
const call = (m, args) => sanad.ui.call(`commands.${m}`, args);
new sanad.ui.CommandEditor({
  name: "doc",                                   // empty for a new command
  read_only: !frappe.user.has_role("System Manager"),
  load: (name) => call("get_editor", { name }),  // {command, functions, party_types, function}
  load_function: (fn) => call("get_function_spec", { function: fn }),
  save: (payload) => call("save_editor", { payload }),      // → {name, status}
  remove: (name) => call("delete_command", { name }),
  preview: ({ payload, sender, values }) => call("preview_command", { payload, sender, values }),
  search_groups: (txt) => call("search_groups", { txt }),   // → [{name, label}]
  search_contacts: (txt, party_type) => call("search_contacts", { txt, party_type }),
  on_saved: (result) => cur_list.refresh(),      // also after a delete: {name, deleted: true}
  on_close: () => {},
});
```

`command`: `{name, code, function, status, synonyms[], requires_linked_contact,
allowed_party_types[], disabled_inputs[], settings_overrides{}, outputs[], access{type: {mode,
groups[{name,label}], contacts[{name,label,phone}]}}, runs_30d}`. Function spec: `{name,
function_name, category, status, when_to_use, example, inputs[{key,label,type,required,rest,
details,example}], settings[{key,label,fieldtype,choices[],default_value,notes}], outputs[],
party_types[], suggested_commands[]}`. The save payload is the same shape with `synonyms` as text,
`access` as names and `status`.

## Live use
The host app's Commands list (New command, View, Edit) and its command form ("Open editor"),
through the host's own `command_modal(name, opts)` wrapper.

## Design gate
- `role="dialog"` + `aria-modal`, focus kept inside (Tab / Shift+Tab wrap), Esc closes the open
  dropdown first and the editor last, focus returns to the opener; closing with unsaved changes
  asks first.
- Tabs are `role="tab"` with `aria-selected`; the status control is `role="switch"` with
  `aria-checked` and a visible word (Enabled / Stopped), never colour alone; party-type and mode
  pills carry `aria-pressed`.
- Every remove "×" has an `aria-label` naming what it removes; inputs without a visible label have
  one.
- Re-renders keep the focused field, its caret and each column's scroll position, so typing and
  picking never jump.
- The preview thread is `aria-live="polite"`; while a run is in flight the thread dims instead of
  flashing a spinner.
- Colours are product tokens only (`--wa-*`); offsets are logical, so Arabic and English need
  nothing extra; the entry animation is off under `prefers-reduced-motion`.

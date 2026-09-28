# `sanad.ui.CommandEditor`

A full-height modal for creating and editing a chat command: a command word (plus synonyms) that
runs a "function" when an inbound message matches it. Header: command word, "Not saved yet" chip,
Active / Inactive switch, close, tabs **Setup · Permissions · Preview**, the 30-day run count and a
function chip. **Setup** picks the function and edits synonyms, allowed party types, "requires
linking", which of the function's inputs are enabled, per-command setting overrides and output
texts. **Permissions** sets, per allowed party type, Allow All (blacklist) or Deny All (whitelist)
with contact groups and contacts. **Preview** dry-runs the unsaved draft for a chosen sender and
shows the reply in a chat thread. All data comes from host-supplied functions.

**Portability:** no app imports, but the shapes (`command`, the function spec with `inputs` /
`settings` / `outputs` / `suggested_commands`, party-type keys matching Contact `links[].link_doctype`,
`access` modes `Allow All` / `Deny All`, preview result `{status, replies, missing, text, reply_sent}`)
are this app's `WhatsApp Command` / Functions model and its `commands.*` API. It also requires
`sanad.ui.Toast` and `sanad.ui.ConfirmDialog`, and uses `sanad.ui.ChatThread` when present.

## Options

| Option | Type | Default | Meaning |
|---|---|---|---|
| `name` | string \| null | `null` | Command to open; empty for a new one. |
| `read_only` | boolean | `false` | View only: no Save / Delete, inputs disabled (except controls marked `data-keep`: tabs, close, preview sender/variables). |
| `load` | `(name) → Promise<{command, functions, party_types, function}>` | required | Initial data (see below). |
| `load_function` | `(fn) → Promise<Spec>` | required | Spec of a newly picked function. |
| `save` | `(payload) → Promise<{name, status}>` | required | Save; payload also carries `status`. |
| `remove` | `(name) → Promise` | — | Enables **Delete command** on a saved, editable command. |
| `preview` | `({payload, sender, values}) → Promise<Result>` | required | Dry run of the draft. |
| `search_groups` | `(txt) → Promise<[{name, label}]>` | required | Permissions group picker. |
| `search_contacts` | `(txt, party_type) → Promise<[{name, label, phone, links}]>` | required | Permissions contact picker and Preview sender picker. |
| `on_saved` | `(result)` | — | After save (`{name, status}`) and delete (`{name, deleted: true}`). |
| `on_close` | `()` | — | After the modal is removed. |

**`load` result**

- `command` — `{name, code, function, status, synonyms[], requires_linked_contact, allowed_party_types[], disabled_inputs[], settings_overrides{}, outputs[], access{<type>: {mode, groups[{name,label}], contacts[{name,label,phone}]}}, runs_30d}`.
- `functions[]` — `{name, function_name, category, status}`; a non-`Active` function shows a "stopped" callout.
- `party_types[]` — `{key, label}`.
- `function` — the current function's spec, or `null`.

**Spec** — `{when_to_use, example, suggested_commands[], party_types[], inputs[{key, label, type, required, rest, details, example}], settings[{key, label, fieldtype: Check|Int|Select|Data, choices[], default_value, notes}], outputs[{output_key, label, output_type: Text|Document, default_template, template, variables, notes, print_format, file_name_template}]}`.
Picking a function resets inputs, overrides and outputs, fills `allowed_party_types` from
`spec.party_types` if empty, and the command word from `suggested_commands[0]` if empty.

**Payload** — `{name?, code, function, synonyms (newline-joined), requires_linked_contact, allowed_party_types[], disabled_inputs[], settings_overrides{}, outputs[], access{<type>: {mode, groups[names], contacts[names]}}}`; `save` also receives `status`. Overrides equal to the default are dropped.

**Preview args** — `sender` is `{contact, label, phone, party_type, party_name}` (the chosen linked account) or `{phone: null}`; `values` maps input keys to typed values.
**Result** — `{status, text, replies[{message_type, body, file_name}], missing[{key, label}], reply_sent}`.

## Methods

The constructor opens the modal and calls `load`.

- `close(force = false)` — asks "Discard unsaved changes?" when dirty (and not read-only) unless `force`; destroys the thread.
- `save()` — validates (word, function, ≥1 party type), calls `opts.save`, lowercases the word, toasts.
- `remove()` — `sanad.ui.ConfirmDialog.ask` (danger) whose `on_confirm` calls `opts.remove`; then closes.
- `payload()` — the draft as the payload above. `is_dirty()` — draft differs from last load/save.
- `render()` — full re-render; keeps focused field, caret and per-column scroll.

## Events and callbacks

`on_saved`, `on_close`. No custom DOM events and no realtime. Errors surface via
`sanad.ui.Toast.error`; save/delete success via `Toast.success`. A window `resize.<id>` handler
re-renders (debounced 150 ms) and is removed on close.

## Server calls

None directly — everything goes through the option functions. This app wires them in
`public/js/form/whatsapp_command.js` (`whatsapp_next.command_modal`) to:

| Key | Args | When |
|---|---|---|
| `commands.get_editor` | `{name}` | open |
| `commands.get_function_spec` | `{function}` | a function is picked |
| `commands.save_editor` | `{payload}` | Save |
| `commands.delete_command` | `{name}` | Delete confirmed |
| `commands.preview_command` | `{payload, sender, values}` | entering Preview; 450 ms after edits there; sender / account / "Fill with examples" |
| `commands.search_groups` | `{txt}` | typing in a group picker (200 ms debounce) |
| `commands.search_contacts` | `{txt, party_type}` | contact picker or Preview sender (200 ms debounce) |

## Usage

```js
const call = (m, args) => sanad.ui.call(`commands.${m}`, args);
new sanad.ui.CommandEditor({
  name: null,
  read_only: !frappe.user.has_role("WhatsApp Manager"),
  load: (n) => call("get_editor", { name: n }),
  load_function: (fn) => call("get_function_spec", { function: fn }),
  save: (payload) => call("save_editor", { payload }),
  remove: (n) => call("delete_command", { name: n }),
  preview: (args) => call("preview_command", args),
  search_groups: (txt) => call("search_groups", { txt }),
  search_contacts: (txt, party_type) => call("search_contacts", { txt, party_type }),
  on_saved: () => cur_list && cur_list.refresh(),
});
```

## CSS hooks

- Layer: `.sanad-kit.sanad-ce-layer` > `.sanad-ce-backdrop` + `.sanad-ce` (dialog; `.sanad-ce--readonly`). `body.sanad-ce-open` locks scroll.
- Header: `__head`, `__head-row(--tabs)`, `__code`, `__dirty`, `__status.is-on` (`__track`, `__knob`), `__x`, `__tabs` / `__tab.is-sel`, `__count`, `__runs`, `__fnchip`.
- Layout: `__grid--setup`, `__grid--preview`, `__col--surface|--bg|--span|--last`, `__col-head`, `__col-body`, `__pane`, `__foot`, `__foot-hint`, `__loading`.
- Controls: `__combo`, `__pop`, `__opt.is-sel`, `__chip--pri|--ghost|--dg`, `__chip-x`, `__pill.is-on`, `__seg.is-sel`, `__card.is-off|.is-missing`, `__tag--warn|--ok`, `__token`, `__callout--warn|--danger|--muted`, `__note--warn|--danger`.
- Preview: `__phone`, `__phone-head`, `__thread.is-running`, `__bubble--in|--out` (fallback without ChatThread), `__sim`.
- Buttons: `__btn`, `__btn--pri`, `__btn--danger`, `__link`.
- Breakpoints (`$ce-narrow` / `$ce-mobile` in `style.scss`): narrower grid, then stacked and full-screen; entry animation off under `prefers-reduced-motion`.

## Notes

- **States:** "Loading…" until `load` resolves; a failed load shows the message and Close. Empty
  columns explain themselves ("Pick a function…", "This function defines no outputs.", no party
  type allowed). Pickers show "Loading…", the server error, or a "No matching…" line. Preview
  shows "Running the preview…" first, then dims the thread (`.is-running`) during reruns;
  stale results are dropped by token.
- **Keyboard:** Tab / Shift+Tab wrap inside the modal; Esc closes the open dropdown first
  (sender, function, then pickers), else the editor. Enter in the synonym field adds it
  (not duplicates or the command word itself). Pickers open on focus.
- **ARIA:** `role="dialog"` + `aria-modal` with an sr-only title; tabs `role="tab"` +
  `aria-selected`; status `role="switch"` + `aria-checked` and a visible word; pills
  `aria-pressed`; function field `role="combobox"`; lists `role="listbox"`; thread
  `aria-live="polite"`. Focus returns to the opener on close.
- **RTL:** logical offsets; words, numbers and phones are `dir="ltr"`.
- **Limits:** function list shows the first 40 matches.
- **Live use:** `public/js/form/whatsapp_command.js` defines `whatsapp_next.command_modal`, called
  from that form, `public/js/listview/whatsapp_command_list.js` and `public/js/screens/messages.js`
  (read-only).

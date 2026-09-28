# `sanad.ui.FunctionDetail`

A read-mostly, full-height modal describing one catalog "function" (a server-side handler that chat
commands run). Header: name, category, Active / Stopped and Installed / Not installed badges, tabs
**Details · Version log · Preview**, and current / latest version chips. **Details** shows the
description, when to use it, party types served, four figures (calls in 30 days, average run time,
linked commands, active ones), suggested command words, linked commands, the inputs and settings it
takes and its outputs (text / file-name templates with copy buttons, fields that copy `{{ field }}`).
**Version log** lists versions newest first with changelog bullets. **Preview** dry-runs the
function through the host's `preview` with preview-only settings / texts. The footer offers Update,
Install / Uninstall, Linked commands, a More menu and Close — all delegated to host callbacks. It
reuses `CommandEditor`'s shell classes (`sanad-ce*`), so both stylesheets must be loaded.

**Portability:** no app imports, but the `entry` / `manifest` shapes are this app's Functions
catalog (`functions.get_manifest`), the preview result is this app's `commands.preview_command`
result, the default party types are hardcoded ERPNext doctypes (`Customer`, `Supplier`, `Employee`,
`Sales Person`), and the preview-blocked message says "Only a WhatsApp manager can run the preview."

## Options

| Option | Type | Default | Meaning |
|---|---|---|---|
| `entry` | object | `{}` | The catalog row (see below). |
| `manifest` | object | `{inputs: [], settings: [], outputs: []}` | The function's manifest (see below). |
| `tab` | `"details"` \| `"log"` \| `"preview"` | `"details"` | Tab shown first; `"preview"` starts a run on `show()`. |
| `party_types` | `[{key, label}]` | the four ERPNext types above | Preview sender-type pills; `key` matches Contact `links[].link_doctype`. |
| `preview` | `({code, settings, outputs, values, sender}) → Promise<Result>` | — | Dry run. Omitted (or `entry.installed` falsy) → the Preview tab shows why instead. |
| `search_contacts` | `(txt, party_type) → Promise<[{name, label, phone, links}]>` | — | Preview sender search; without it the list stays empty. |
| `on_update` | `(entry)` | — | "Update to {latest}" button, shown when `installed && update_available`. |
| `on_toggle_install` | `(entry)` | — | "Install the function" / "Uninstall" button. |
| `on_open_commands` | `(entry)` | — | "Linked commands" footer button and "Open in commands" link. |
| `more` | `[{label, handler(entry), danger?}]` | `[]` | Extra verbs in a "More ▾" menu; `danger` colours the item. |
| `on_close` | `()` | — | After `close()`. |

- **`entry`** — `{function_key, function_name, category, description, when_to_use, status, installed, installed_version, latest_version, update_available, versions[], releases{<v>: {released, changelog}}, changelog{<v>: text} (fallback), party_types[], linked_commands[{name, code, status}], calls_30d, avg_ms}`.
- **`manifest`** — `{example, suggested_commands[], party_types[], inputs[{key, label, type, options, required, rest, example, notes | details}], settings[{key, label, fieldtype: Check|Int|Select|Data, choices ("\n"-separated), value, default_value, notes}], outputs[{output_key, label, output_type: Text|Document, default_template, file_name_template, variables, notes}]}`.
- **Preview args** — `code` is the first linked command's word, else `suggested_commands[0]`, else `function_key`; `settings` = preview overrides; `outputs` = manifest outputs with edited `template` / `file_name_template`; `values` = typed inputs; `sender` = `{contact, label, phone, party_type, party_name}` or `{phone: null}`.
- **Result** — `{text, status, block_reason, missing[{key, label}], replies[{message_type, body, file_name}]}`; a thrown error is shown as a danger callout.

## Methods

- `show()` — builds and opens the window (the constructor does not); returns `this`. Registers with `sanad.ui.overlay` when present; focuses the close button.
- `close()` — `hide()`, restore focus to the opener, call `on_close`.
- `hide()` — remove without callbacks (another overlay took the screen); `destroy()` is an alias.
- `render()` — re-render, preserving focused field, caret and per-column scroll.

## Events and callbacks

The option callbacks above only; they receive `entry` and do not close the window themselves.
No custom DOM events, no realtime. `copy` uses `frappe.utils.copy_to_clipboard`, falling back to
`navigator.clipboard` + `sanad.ui.Toast.success`.

## Server calls

None directly. In this app `whatsapp_next/page/wa_functions_center/wa_functions_center.js`
(`FunctionWindow`) supplies:

| Key | Args | When |
|---|---|---|
| `functions.get_manifest` | `{function_key}` | before `show()` (host side) |
| `commands.preview_command` | `{payload, sender, values}` (payload is a throw-away command draft built from `code`, `settings`, `outputs`) | entering Preview; 450 ms after edits; sender / account / fill / reset |
| `commands.search_contacts` | `{txt, party_type}` | entering Preview (empty query), typing (200 ms debounce) |

## Usage

```js
const view = new sanad.ui.FunctionDetail({
  entry,
  manifest: await sanad.ui.call("functions.get_manifest", { function_key: entry.function_key }),
  party_types: [{ key: "Customer", label: __("Customer") }],
  preview: (args) => run_dry_run(args),
  search_contacts: (txt, party_type) => sanad.ui.call("commands.search_contacts", { txt, party_type }),
  on_toggle_install: (e) => install_or_remove(e),
  more: [{ label: __("Deactivate"), handler: (e) => set_status(e, "Inactive") }],
}).show();
// later, when another form takes the screen:
view.hide();
```

## CSS hooks

- Layer: `.sanad-kit.sanad-ce-layer.sanad-fd-layer` > `.sanad-ce-backdrop` + `.sanad-ce.sanad-fd` (dialog). Sets `body.sanad-ce-open` (removed only when no `.sanad-ce-layer` remains).
- Own classes: `sanad-fd__identity`, `__name`, `__badge--ok|--muted|--line|--pri|--wn`, `__ver--pri|--wn`, `__grid`, `__body(--outs)`, `__lede`, `__box`, `__stats` / `__stat`, `__word`, `__cmd.is-on`, `__value`, `__choices`, `__copybox(--sm)`, `__copy`, `__field`, `__log.is-current`, `__log-head`, `__changes`, `__grid--preview`, `__more`, `__menu`, `__danger`, `__btn-pri-soft`, `__close`.
- Shared `sanad-ce__*` shell: tabs, columns, cards, pills, callouts, `__thread.is-running`, `__btn--pri`.
- Breakpoints: Preview grid 320 | 1fr | 400 → two columns under 1080 px → one under 760 px.

## Notes

- **States:** Preview shows "Running the preview…" on first run, then dims the thread; stale runs
  are dropped by token. Empty texts: no description, no versions, no outputs, no variables, no
  linked commands. Preview blocked when not installed or no `preview`.
- **Preview edits are local:** settings, output texts and file names changed in Preview only feed
  the dry run; "Back to the function's defaults" clears them and the typed values.
- **Version log:** sorted by numeric dot/dash parts; the newest card opens by default;
  latest marked "Latest", installed one "Installed now" (`.is-current`).
- **Keyboard:** Tab / Shift+Tab wrap; Esc closes the contact dropdown, then the More menu, then
  the window. Sender picker opens on focus.
- **ARIA:** `role="dialog"` + `aria-modal`, labelled by the name; tabs `role="tab"` +
  `aria-selected`; version heads `aria-expanded`; More `aria-haspopup="menu"` with `role="menu"` /
  `menuitem`; copy buttons have `aria-label`; thread `aria-live="polite"`.
- **RTL:** logical offsets; versions, keys and numbers are `dir="ltr"`, prose `dir="auto"`.
- **Chat bubbles** need `sanad.ui.ChatThread`; without it the thread slot stays empty (unlike
  CommandEditor, there is no fallback).
- **Live use:** `whatsapp_next/page/wa_functions_center/wa_functions_center.js` (as `ui.FunctionDetail`).

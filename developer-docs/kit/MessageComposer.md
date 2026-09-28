# `sanad.ui.MessageComposer`

An editor for the ordered messages a record sends, mounted over a Desk form's **Table** field. It
replaces the child grid with a rail of messages (order, type, one-line summary, a "missing" dot,
move/duplicate/delete) beside one writing surface and a foldable chat-bubble preview. Which fields a
message type offers is read from the child DocType's Select options and each field's `depends_on`,
so a host adds a type by adding it to the Select. Values are written with
`frappe.model.set_value` / `frm.add_child`, so Frappe's dirty state, validation and save are
untouched — the native grid stays in the DOM (it is what saves) and is hidden by CSS.

**Portability:** the component is generic over the child DocType, but a few field names are
hardcoded in its type logic: `caption`, `attachment`, `print_format`, `poll_question`,
`poll_options` (JSON list), `poll_allow_multiple`, and the type names `Text`, `Poll`, `Location`,
`Document`, `Image`, `Video`, `Audio`, `Sticker`, `Template` (icons, shelves, "missing" checks,
summaries). The server preview shape (`{body, attachment_name, message_type, errors[]}`) is the one
this app's `campaigns.preview_message` returns.

## Options

| Option | Type | Default | Meaning |
|---|---|---|---|
| `frm` | Form | — | The host form (required). |
| `fieldname` | string | — | The Table field holding the messages (required). |
| `type_field` | string | `"message_type"` | Select on the child row; its options are the types offered. |
| `body_field` | string | `"body"` | Text field that gets the marks toolbar and variable insertion (a Small Text `caption` gets it too). |
| `delay_field` | string | — | Int seconds before this message. Drawn as a "wait N" connector between rail items and a sentence under the editor; never on the first message. |
| `primary_fields` | `{[type]: string[]}` | — | Per type, the fields that lead the editor; every other allowed field goes under a "More options" `<details>`. Without an entry, all allowed fields lead. |
| `fields` | string[] | every non-layout, non-read-only child field | Which fields the editor may offer at all (type and delay fields are always excluded). |
| `preview` | `{method, args(row, frm)}` | — | Server preview; `method` is a `ui.call` key. Result: `{body, attachment_name, message_type, errors[]}`. |
| `variables` | `Array<{name, label}>` \| `{method, args(frm)}` | — | Variables offered by the "Variable" button, inserted as `{{ name }}`. |
| `can_edit` | `() => boolean` | not `frm.read_only`, docstatus 0, and `frappe.model.can_write` | Gates every verb and makes fields read-only. |
| `empty_text` | string | `__("No message yet")` | Title of the empty rail. |
| `max` | number | — | Cap on the number of messages; "Add message" disables at the cap. |
| `debounce` | number (ms) | `400` | Delay before the local preview redraws after typing. |

## Methods

- `refresh()` — re-read the child meta and redraw; returns `this`.
- `render()` — redraw count, header action, rail and editor; returns `this`.
- `select(name)` — make a row (by child `name`) the one being edited, and focus its first input.
- `add(type?)` — append a row of `type` (default: first Select option, else `"Text"`) and select it.
- `duplicate(row)` — copy a row (system keys stripped) and select the copy.
- `remove(row)` — remove a row; asks via `sanad.ui.ConfirmDialog.ask` unless it is empty.
- `move(row, delta)` — move a row up (`-1`) or down (`1`) and renumber `idx`.
- `ask_delay(row)` — open the "Wait before this message" dialog for `delay_field`.
- `load_variables()` — (re)load variables; returns a Promise of the list.
- `destroy()` — close menus, unbind document handlers, remove the element and the host class.

The instance exposes `$el`, which a host may move elsewhere after construction (the campaign
screen does this).

## Events and callbacks

- `can_edit()` is polled on every render.
- `preview.args(row, frm)` and `variables.args(frm)` build the call arguments.
- No custom events are triggered and no realtime events are subscribed. Document-level click
  handlers are namespaced `click.<id>-types` / `click.<id>-vars` and removed on close/`destroy()`.

## Server calls

| Key | Args | When |
|---|---|---|
| `opts.preview.method` | `opts.preview.args(row, frm)` | Each time the editor draws or a field changes, **only** when the record is saved and not dirty. `silent: true`; failures ignored. |
| `opts.variables.method` | `opts.variables.args(frm)` or `{}` | Once, on construction, when `variables` is `{method}`. `silent: true`. |

Nothing else; row changes go through `frappe.model`.

## Usage

```js
frappe.ui.form.on("WhatsApp Campaign", {
  refresh(frm) {
    frm.composer = new sanad.ui.MessageComposer({
      frm,
      fieldname: "messages",
      type_field: "message_type",
      body_field: "body",
      delay_field: "delay_seconds",
      max: 5,
      primary_fields: { Text: ["body"], Image: ["attachment", "caption"], Poll: ["poll_question", "poll_options"] },
      can_edit: () => frm.doc.status === "Draft",
      preview: { method: "campaigns.preview_message", args: (row) => ({ name: frm.doc.name, idx: row.idx }) },
      variables: [{ name: "recipient.display_name", label: __("Recipient name") }],
    });
  },
});
```

## CSS hooks

- Root `.sanad-kit.sanad-mc[data-fieldname]`; the field wrapper gets `.sanad-mc-host`, which hides
  the native grid, its label, buttons and help.
- Head: `__head`, `__title`, `__count`, `__head-actions`, `__add`, `__addwrap`.
- Rail: `__split`, `__rail`, `__raillist`, `__railitem` (`--on`, `--problem`), `__railtop`,
  `__order`, `__railtype`, `__raildot`, `__railactions`, `__icon-btn`, `__railbtn`, `__railline`,
  `__railwait`, `__delay`, `__railadd`, `__railaddbtn`.
- Type chooser: `__typewrap`, `__typepick` (`-icon`, `-text`, `-caption`, `-name`, `-caret`),
  `__typemenu`, `__typegroup`, `__typeopt` (`--on`, `-icon`, `-text`, `-name`, `-hint`, `-tick`).
- Editor: `__editor`, `__etop`, `__toggle-preview`, `__egrid` (`--nopreview`), `__eform`,
  `__field--<fieldtype>`, `__more`, `__toolbar`, `__mark`, `__varpick`, `__varbtn`, `__varmenu`,
  `__varopt`, `__delayline`.
- Preview: `__epreview`, `__pane-label`, `__chat`, `__bubble`, `__text` (`--empty`), `__var`,
  `__thumb`, `__file` (`--under`), `__poll`, `__poll-q`, `__poll-o`, `__poll-note`, `__meta`,
  `__errors`.
- Layout is container-query driven: rail beside editor at ≥760px, preview beside fields at ≥820px.

## Notes

- **Empty:** the rail shows a `sanad.ui.EmptyState` (`size: "sm"`) with "Add the first message"
  when editable.
- **Problems** per row: no type, empty text, poll without question or with fewer than two answers,
  media without a file (a Document may use `print_format` instead). Shown as a dot with a title.
- **Preview:** drawn locally at once (WhatsApp marks `*_~```, unfilled `{{ var }}` as chips,
  image thumbnails for image files whatever the type, file chip, poll); the server preview replaces
  it once the record is saved and clean and lists `errors` under the bubble (`role="alert"`).
- **Keyboard/ARIA:** the type chooser is a `role="menu"` of `menuitemradio`s with roving arrow
  focus, Escape closes and restores focus; icon buttons carry `aria-label`; the count and editor are
  `aria-live="polite"`; inserts, moves, duplicates and removals are announced via `ui.announce`.
  Row verbs show on hover, focus, the active row, and always under `@media (hover: none)`.
- Opening an editor never marks the form dirty (controls are unbound; the change handler is armed
  after the first tick).
- RTL: logical properties only; text uses `dir="auto"`.
- **Live use:** `public/js/screens/campaign/messages.js` (campaign builder message step; the
  element is moved into the step's pane after mounting).

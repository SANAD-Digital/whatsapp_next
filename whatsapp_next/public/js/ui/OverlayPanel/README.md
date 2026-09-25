# OverlayPanel

The design prototype's overlay panel (`docs/component/Overlay Panel.dc.html`), ported as a
component: "the same language as the table — type, width, content and actions all from one
object". A **modal** (a 12 px-radius card centred on the dimmed page) or a **drawer** (a sheet on
the inline edge); a header that names the record (title, a subtitle or a monospace id, a badge,
the "Unsaved changes" pill, a 32 px close); a body that is either a **form** of sections or a
record's **detail** (an alert, a facts grid, list and text blocks); a footer of verbs, the
start-aligned ones at the start and the rest at the end.

The fields are the prototype's own — `text`, `number`, `email`, `textarea`, `select`, `segment`,
`toggle`, `readonly`, `link` (the prototype's autocomplete: the typed text is looked up on the
server and only a listed record can be chosen), `rows` (a child table whose rows are `select` and
`link` controls with a remove, and an add button), `list` (a bordered read-mostly table with an
add row), `choice` (a searchable grid of options), `phone` (the kit's `PhoneField`) and `html` — drawn with the kit's controls (`wa-input`, `wa-select`,
`wa-seg`, `wa-toggle`, `wa-btn`, `wa-badge`). Values are tracked against the initial ones, so the
header says when something changed and an action with `requires_dirty` sleeps until then.

## Usage

```js
// an edit modal
const panel = new sanad.ui.OverlayPanel({
  type: "modal", width: "600px",
  title: __("Edit «{0}»", [doc.full_name]), subtitle: doc.name, subtitle_mono: true,
  badge: { text: __("Linked"), tone: "ok" },
  sections: [{
    title: __("Contact details"), cols: 2,
    fields: [
      { key: "first_name", label: __("First name"), required: true },
      { key: "email_id", label: __("Email"), type: "email", mono: true },
      { key: "phone", label: __("WhatsApp number"), type: "phone", required: true, value: "+9665…" },
      { key: "company_name", label: __("Company"), type: "link", value: doc.company_name, display: doc.company_name,
        search: (txt) => sanad.ui.call("contacts.search_company", { txt }).then((rows) => rows.map((r) => ({ value: r.name, label: r.title }))) },
      { key: "links", type: "rows", span: 2, value: rows, add_label: __("Add an account"),
        columns: [
          { key: "link_doctype", label: __("Account type"), type: "select", width: "150px", resets: ["link_name"],
            options: [{ value: "Customer", label: __("Customer") }] },
          { key: "link_name", label: __("Account"), type: "link",
            search: (txt, row) => sanad.ui.call("contacts.search_party", { party_type: row.link_doctype, txt }) },
        ] },
      { key: "status", label: __("Status"), type: "readonly", html: sanad.kit.badge(__("Blocked"), "danger"), hint: __("Changed with the Block action.") },
    ],
  }],
  actions: [
    { key: "cancel", label: __("Cancel"), close: true },
    { key: "save", label: __("Save"), variant: "primary", requires_dirty: true,
      handler: (values, p) => sanad.ui.call("contacts.update_contact", { name: doc.name, payload: values }, { silent: true }) },
  ],
}).show();

// a record's detail as a drawer
sanad.ui.OverlayPanel.open({
  type: "drawer", width: "520px", title: doc.full_name, subtitle: doc.phone, subtitle_mono: true,
  badge: { text: __("Not linked"), tone: "warn" },
  detail: {
    alert: { tone: "warn", title: __("The number is not linked to an account."), lines: [__("Automatic notifications are not sent.")] },
    facts: [{ k: __("Messages sent"), v: 12, mono: true }, { k: __("Status"), v: __("Open"), tone: "info" }],
    blocks: [
      { label: __("Linked accounts"), list: [{ avatar: "AB", text: "Al Bayan", sub: "CUST-0001", sub_mono: true, badge: __("Customer"), badge_tone: "info" }] },
      { label: __("Recent messages"), render: ($el, panel) => load_messages($el) },
    ],
  },
  actions: [{ key: "edit", label: __("Edit"), align: "start", handler: () => open_form(doc) }, { key: "close", label: __("Close"), close: true }],
});
```

Options: `type` (`modal` | `drawer`), `width`, `side` (drawer: `start` | `end`), `title`, `subtitle`,
`subtitle_mono`, `badge {text, tone}`, `sections[{title, note, note_tone, cols, fields[]}]`,
`detail {alert, facts[], blocks[]}`, `actions[{key, label, icon, variant, align, close, requires_dirty,
validate, handler(values, panel)}]`, `on_change(key, value, panel)`, `on_close`, `close_on_backdrop`,
`compact`. A handler may return a promise: the button waits, a rejection is shown inline above
the fields, `false` keeps the panel open. Field entries: `key`, `label`, `type`, `value`, `span`,
`required`, `placeholder`, `hint`, `mono`, `rows`, `options[{value, label}]`, `on_change`; list
fields add `head`, `row_cols`, `columns`, `empty`, `max_height`, `add {placeholder, label, options,
search(txt, type), on_add(item, type, rows)}`; link fields add `search(txt)` and `display`; rows
fields add `columns[{key, label, type, options, resets, search(txt, row), width}]`, `add_label`,
`incomplete_text`; choice fields add `cols`, `search(txt, panel)`, `searchable`, `empty`.

Methods: `show()`, `hide()`, `destroy()`, `get_values()`, `get_value(key)`, `set_value(key, v)`,
`field(key)` (`.reload()` on a choice, `.set_rows()` on a list), `validate()`, `set_error(key,
text)`, `clear_error(key)`, `show_error(err)`, `is_dirty()`, `mark_clean()`, `set_badge(badge)`,
`set_title(title, subtitle)`, `set_action_disabled(key, bool)`; static `open(opts)`.

## Live use
The host app's Contacts page (`page/wa_contacts/wa_contacts.js`): the row's detail drawer, the
create / edit modal with its linked-accounts list, the "link to an account" chooser, and the
conversation-state and block modals. Functions Center (`page/wa_functions_center/wa_functions_center.js`):
the dry-run preview (a form with an `html` result that stays open across runs), the diff shown
before install / update (`detail` with facts and blocks, the verb disabled while no handler exists),
and the settings editor (fields typed from the function's own setting rows, `requires_dirty` save).

## Design gate
- One overlay at a time through `sanad.ui.overlay`; `role="dialog"` + `aria-modal`, labelled by
  the title; focus trapped, Escape closes, focus returns to the opener; the opening is announced.
- Required fields fail with a focusable summary (`role="alert"`) whose entries are links that focus
  the field, and each field carries its own error with `aria-invalid` / `aria-describedby`; a
  server failure is shown in the same place, not only as a toast.
- The link field is a `combobox` over a `listbox` (arrow keys, Enter, Escape, `aria-activedescendant`),
  and only a listed record becomes a value — typed text that was not picked is put back on blur;
  the choice grid is a `listbox` of `option`s; the segment is the kit's radio group.
- Nothing moves on open: the panel fades in where it will stay, and a closed panel leaves the
  document so its buttons never shadow a live one's.
- Copy: "Unsaved changes", "Fill in the required fields:", "{0} is required", "No match.",
  "Nothing here yet." — the verbs on the buttons are the caller's ("Save", "Link", "Block").
- Under 768 px both geometries become a full-height sheet with a sticky footer; the grid, the facts
  and the choices collapse to one column; `prefers-reduced-motion` drops the transition.

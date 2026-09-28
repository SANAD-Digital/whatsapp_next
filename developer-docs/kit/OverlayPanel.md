# `sanad.ui.OverlayPanel`

The design prototype's overlay panel (`docs/component/Overlay Panel.dc.html`): one object
describes type, width, content and actions. It renders a **modal** (centred card) or a
**drawer** (side sheet) with a header (title, subtitle or monospace id, badge, "Unsaved changes"
pill, close), a body that is a **form** of sections and/or a record **detail** (alert, facts
grid, list/text blocks), and a footer of verbs (start-aligned ones at the start, the rest at the
end). Values are tracked against their initial state, so `requires_dirty` actions wake up only
after a change. It talks to the outside only through the callbacks it is given; no server calls.
Depends on the kit's `_kit` controls (`btn`, `badge`, `segmented`, `rule`, `avatar`, `ico`) and
`sanad.ui.PhoneField` for `phone` fields. Per project rule, use it for **forms**; record panels
use the Drawer document layout.

## Options

| Option | Type | Default | Meaning |
|---|---|---|---|
| `type` | `"modal"` \| `"drawer"` | `"modal"` | Geometry. |
| `width` | string | — | CSS width (sets `--sanad-op-width`). |
| `side` | `"start"` \| `"end"` | `"end"` | Drawer edge. |
| `title` | string | — | Header title (labels the dialog). |
| `subtitle` | string | — | Secondary line. |
| `subtitle_mono` | boolean | — | Monospace, `dir="ltr"` subtitle (ids, numbers). |
| `badge` | `{text, tone?}` | — | Header badge (`kit.badge`). |
| `sections` | `Section[]` | — | Form content. |
| `detail` | `{alert?, facts?, blocks?}` | — | Record content, rendered before sections. |
| `actions` | `Action[]` | `[]` | Footer buttons; falsy entries are skipped; footer hidden when empty. |
| `on_change` | `(key, value, panel)` | — | After any field change. |
| `on_close` | `(panel)` | — | After `hide()`. |
| `close_on_backdrop` | boolean | `true` | Backdrop click closes. |
| `compact` | boolean | — | Adds `wa--compact` density. |

Tones everywhere: `ok`, `warn`, `danger`, `info`, `muted`, `pri` (anything else → `muted`).

**Section** — `{title?, note?, note_tone? (default info), note_end?, cols? (default 2), layout?, fields[]}`.
`layout: "rows"` draws a large title then one label/value row per field; otherwise a grid of
`cols` columns with `kit.rule(title, note_end)` as heading.

**Field (common)** — `{key, type = "text", label?, value?, span?, required?, placeholder?, hint?, mono?, on_change?(value, panel)}`.

| `type` | Extra keys | Value |
|---|---|---|
| `text` / `number` / `email` | `maxlength`, `autocomplete` | string (number → `Number` or `""`) |
| `textarea` | `rows` (3) | string |
| `select` | `options[{value,label}]` | string |
| `segment` | `options` (kit segmented) | option value |
| `toggle` | — (label drawn inside) | boolean |
| `readonly` | `html` (raw) | `value` as given |
| `phone` | `tip` | `phone_e164` string (via PhoneField) |
| `link` | `search(txt) → Promise<[{value,label,note?}]>`, `display` | picked `value` only |
| `rows` | `columns[{key,label,type ("select"\|link),options?,resets?,search?(txt,row),width?,placeholder?}]`, `add_label`, `empty`, `incomplete_text` | array of row objects (links also store `<key>_title`) |
| `list` | `head[]`, `columns` (default `text, sub, tag, remove`), `row_cols`, `max_height`, `empty`, `on_rows(rows, panel)`, `add{label?, placeholder?, options?, type_label?, empty?, search?(txt,type), on_add?(item,type,rows)}` | array of rows `{text, sub, tag, tag_tone, text_mono, …}` |
| `choice` | `options[{value,label,note?,mono?,note_mono?}]` or `search(txt, panel)`, `cols`, `searchable` (true), `toggle` (true = click again clears), `empty` | chosen value |
| `html` | `render($el, panel)` | none |

**Detail** — `alert {tone, title, lines[] | text}`; `facts [{k, v, html?, mono?, tone?}]`;
`blocks [{label, more?, render?($body, panel) | list?[{text, sub?, sub_mono?, avatar?, badge?, badge_tone?}] | text, empty?, tone?}]`.

**Action** — `{key, label, icon?, variant = "secondary", align ("start"|end), close (default true),
requires_dirty?, validate (default true), handler?(values, panel)}`. With a handler the form is
validated first (unless `validate: false`). A promise disables the button (`wa-btn--busy`);
resolving `false` (or returning `false`) keeps the panel open; a rejection shows inline
(ignored if `message === "cancelled"`). No handler → just closes.

## Methods

- `show()` / `hide()` / `destroy()`; `static open(opts)` = `new OverlayPanel(opts).show()`.
- `get_values()`, `get_value(key)`, `set_value(key, value, display?)`.
- `field(key)` — entry `{df, $el, $input?, control?, link?, get?, set_rows?, reload?, incomplete?}`.
- `validate()` → `[{key, label}]` missing; `set_error(key, text)`, `clear_error(key)`,
  `show_error(err)`, `focus_field(key)`.
- `is_dirty()`, `mark_clean()`, `set_badge(badge)`, `set_title(title, subtitle?)`,
  `set_action_disabled(key, bool)`.
- `render_body()`, `render_actions()` — re-render after changing `opts`.
- `make_link($host, {id, placeholder, search, value, display, required, on_pick})` — standalone
  autocomplete returning `{$input, get(), set(value, display)}`.

## Events and callbacks

`on_change`, `on_close`, per-field `on_change`, list `on_rows`, action handlers. Registers with
`ui.overlay.open/close` (one overlay at a time) and adds `sanad-op-open` to `<body>` while open.
No realtime events.

## Server calls

None (field `search` callbacks and action handlers make the caller's calls).

## Usage

```js
sanad.ui.OverlayPanel.open({
  type: "modal", width: "560px",
  title: __("Edit {0}", [doc.name]), subtitle: doc.name, subtitle_mono: true,
  sections: [{ title: __("Details"), cols: 2, fields: [
    { key: "subject", label: __("Subject"), required: true, value: doc.subject },
    { key: "priority", label: __("Priority"), type: "select", value: doc.priority,
      options: ["Low", "Medium", "High"].map((v) => ({ value: v, label: __(v) })) },
    { key: "owner", label: __("Owner"), type: "link", value: doc.owner,
      search: (txt) => frappe.xcall("frappe.desk.search.search_link", { doctype: "User", txt })
        .then((r) => r.map((u) => ({ value: u.value, label: u.label || u.value, note: u.value }))) },
  ] }],
  actions: [
    { key: "cancel", label: __("Cancel") },
    { key: "save", label: __("Save"), variant: "primary", requires_dirty: true,
      handler: (values) => frappe.xcall("frappe.client.set_value", { doctype: "ToDo", name: doc.name, fieldname: values }) },
  ],
});
```

## CSS hooks

- `<section class="sanad-kit sanad-op wa">` with `--modal` / `--drawer`, `--start` / `--end`,
  `--in` (visible), `wa--compact`; `role="dialog"`, `aria-modal`. Backdrop `.sanad-op-backdrop`;
  body class `sanad-op-open`. Custom properties `--sanad-op-width`, `--sanad-op-cols`,
  `--sanad-op-rowcols`.
- Shell: `__head`, `__heading`, `__title`, `__meta`, `__subtitle(--mono)`, `__badge`, `__dirty`,
  `__close`, `__body`, `__summary`, `__foot`, `__foot-start`, `__foot-end`.
- Form: `__section(--rows)`, `__rows-title`, `__note--<tone>`, `__grid`, `__field` +
  `__field--<type>` (`data-key`, also `wa-field`, `wa-field--invalid`, `wa-field__label/__hint/__error`),
  `__readonly`, `__html`, `__mono`.
- List field: `__listfield`, `__table`, `__thead`, `__trow(--empty)`, `__trow-text/-sub/-meta/-tag/-remove`,
  `__tadd`, `__tadd-input`, `__tadd-type`, `__tadd-btn`, `__tadd-list`, `__tadd-opt`, `__tadd-empty`.
- Link: `__link(--set)`, `__link-input`, `__link-clear`, `__pop`, `__pop-item`, `__pop-label`,
  `__pop-note`, `__pop-empty`. Rows field: `__rows`, `__rows-head`, `__rows-body`, `__row`,
  `__cell`, `__row-remove`, `__rows-empty`, `__rows-foot`. Choice: `__choice`, `__search`,
  `__choices`, `__opt`, `__opt-label`, `__opt-note`, `__empty(--dashed)`.
- Detail: `__alert--<tone>`, `__alert-title`, `__alert-line`, `__facts`, `__fact(--<tone>)`,
  `__block`, `__block-head`, `__block-label`, `__block-more`, `__block-body`, `__list`, `__item`,
  `__item-main`, `__item-text`, `__item-sub`, `__text--<tone>`.

## Notes

- A11y: focus trapped (`ui.trap_focus`), first input focused on open, focus returned to the
  opener, Escape closes (nested popups close first), opening announced. Validation shows a
  focusable `role="alert"` summary with links to each field plus per-field `aria-invalid` /
  `aria-describedby`. Link and list-add inputs are combobox/listbox with arrow keys, Enter,
  `aria-activedescendant` (link); a link accepts only a picked item — unpicked text reverts on blur.
- A closed panel is detached from the document (re-attached by `show()`); `destroy()` removes it.
- Under 767 px both types become a full-height sheet; grids collapse to one column;
  `prefers-reduced-motion` drops the transition.
- Class reuse: `sanad-op__rows` is used both for a `layout: "rows"` section container and for
  the `rows` field wrapper; target `.sanad-op__field--rows .sanad-op__rows` to distinguish.
- Live use: `whatsapp_next/page/wa_contacts/wa_contacts.js` (detail drawer, create/edit modal,
  link chooser), `whatsapp_next/page/wa_functions_center/wa_functions_center.js` (dry-run,
  install/update diff, settings editor), `whatsapp_next/page/wa_simulator/wa_simulator.js`.

# `sanad.ui.Render`

The kit's presentation layer — a **namespace object, not a class** (never `new`). It decides how a
field value, a record ("entity") or a list of records looks, at five display levels, so a person
reads as the same person in a table cell, a drawer, a picker row and a card. Records become a
**view model** (`vm`) derived from DocType meta, optionally shaped by a per-DocType **profile**,
then drawn by the renderer of the record's **kind** at the requested **density**. Files:
`index.js` (registries, view model, entity API), `values.js` (one renderer per fieldtype),
`entities.js` (kinds × densities), `parts.js` (HTML building blocks).

**Portability:** the kit code is generic. The built-in DocType → kind map names ERPNext / Frappe
DocTypes (`Contact`, `User`, `Employee`, `Customer`, `Supplier`, `Lead`, `Sales Person`, `Item`,
`Product`, `File`); `identity_fields` and the Drawer's time lookup prefer `sent_at` / `received_at`.
This app's own kinds and profiles live in `public/js/whatsapp_next_setup.js`.

## Levels (densities)

`Render.DENSITIES = ["inline", "compact", "row", "card", "hero"]` — table cell / dense list /
drawer & picker row / card with room / subject of the screen. Unknown densities fall back to `row`.

## Kinds

`generic`, `person` (circle avatar, status emphasis), `item` (thumbnail, value emphasis, cover card),
`document` (tile, number LTR, amount or progress), `file` (type chip, size, Preview / Download
actions). Resolution order in `kind_of(doctype, doc)`: `Render.doctype_kinds` map → the profile's
`kind` → meta hints (`first_name`/`employee_name`/`user_image`/`designation`/`customer_name`/`supplier_name`
→ person; `item_code`/`stock_uom`/`item_group` → item; `file_url`/`file_name`/`file_size` → file) →
submittable or has `status` → document → `generic`. The answer is cached into `doctype_kinds` only
when meta was loaded.

## Configuration

### `configure(opts)` — one call, used by `sanad.ui.configure({renderers})`

`sanad.ui.configure({ api, defaults, renderers })` stores `renderers` on `ui.config.renderers` and
calls `Render.configure(renderers)`:

| Key | Shape | Effect |
|---|---|---|
| `fields` | `{Fieldtype: (value, df, doc, opts) => html}` | `Render.field(obj)` |
| `kinds` | `{kind: {inline?, compact?, row?, card?, hero?}}` | `Render.register(kind, r)` each |
| `doctypes` | `{DocType: kind}` | `Render.map(obj)` |
| `profiles` | `{DocType: profile}` | `Render.profile(dt, spec)` each |

### `map(mapping)` — `Render.map({"WhatsApp Number": "person"})`; merges into `doctype_kinds`.

### `register(kind, renderers)` — merges density functions `(vm, opts) => html` into `Render.kinds[kind]`; missing densities fall back to `BASE`.

### `field(fieldtype, fn)` / `field({...})` — add or replace a value renderer.

### `profile(doctype, spec?)` — getter without `spec`; otherwise merges into `Render.profiles[doctype]`.

Every entry is a fieldname, a spec `{field, value?, label?, icon?, ltr?, variant?, df?}` (`value` may
be `(doc) => value`), a pre-rendered `{html}` / `{text}`, or a function `(doc) => value | spec`.
`false` switches a part off.

| Key | Meaning |
|---|---|
| `kind` | Kind for this DocType (after the explicit map). |
| `title` / `title_ltr` | Title entry (default: meta `title_field`, then common name fields, then `name`); force LTR (default: `document` kind). |
| `lines` / `subtitle` | Supporting lines (default: `__doctype` label for documents + first two of `phone_e164`, `mobile_no`, `phone`, `email_id`, …). |
| `description` | Card / hero paragraph. |
| `image` | Image entry (default: meta `image_field`, `image`/`user_image`/`avatar`/…, first filled Attach Image). |
| `status` | `false`, a status fieldname, or `(doc) => {label, colour}`; default from `ui.indicator_for`. |
| `value` | Headline value (default first of `grand_total`, `total`, `amount`, `rate`, … if numeric); `false` for none. |
| `progress` | Percent entry (default `percent_complete`, `progress`, …). |
| `facts` | Fact entries (default: `in_list_view`/`bold` fields — 2 at row, 3 at card, 6 at hero). |
| `actions` | `[{icon, label, on_click(doc, e) \| href, target?, download?, tone?, show_label?, condition?, perm?, roles?}]` or `(doc) => []`. |
| `href` | `false`, or `(doc) => url` (default: form link; none for `File`). |
| `icon`, `tone`, `shape` (`circle`/`thumb`/`tile`), `emphasis` (`status`/`value`/`progress`/`none`) | Visual overrides. |
| `after(vm, doc)` | Last hook to mutate the view model. |

## Methods

Values:
- `value(value, df, doc?, opts?)` → html. `opts`: `{density="inline", variant, doctype, icon, target}`. Variants: `badge`, `strong`, `progress`, `number`, `relative`, `readable`, `text`. Errors fall back to escaped text.
- `field_icon(df)` — icon for a fact tile from field name / fieldtype.
- `doc_link(doctype, name, display?, {icon})` — inline chip linking to the form.
- `values` — the individual value helpers (`amount`, `date`, `link`, `phone`, `fallback`, `wrap`, …); `file_size(bytes)`, `file_ext(url)`.

Records:
- `vm(doc, opts)` — view model. `opts`: `{doctype, kind, density, profile, actions, href, on_click, name, vm}` (`vm` = object merged over the result). Returns `{kind, doctype, doctype_label, name, title, title_ltr, lines[], description, image, initials, icon, tone, shape, emphasis, status, value, progress, facts[], actions[], href, clickable, doc, used[]}` (+ `ext`, `is_image`, `meta_text` for files).
- `entity(doc, opts)` → html at `opts.density` (default `row`); accepts `opts.vm_built`.
- `mount(wrapper, doc, opts)` → jQuery; renders and binds action `on_click`s and `opts.on_click(doc, e)`.
- `list(wrapper, docs, opts)` — mounts each doc; `opts.empty_title`, `opts.empty = false` to skip the empty state.
- `load(doctype, name, opts)` → Promise<vm>; `load_into(wrapper, doctype, name, opts)` — skeleton → row → error.
- `fields_needed(doctype)` — fields to fetch for a linked record's vm; `identity_fields(doctype)` — extra fields for the Drawer identity block.
- `kind_of(doctype, doc?)`, `icon_for(doctype)`, `resolve(entry, doc, meta)`.

Registries (mutable): `fields`, `kinds`, `doctype_kinds`, `profiles`, `DENSITIES`, `parts`.

**Parts** (`Render.parts`, pure HTML builders): `avatar({image, initials, icon, tone, size, alt})`,
`thumb({src, alt, size, icon})`, `chip({icon, text, title, ltr, tone, href, cls})`, `chips(list)`,
`fact({label, value, icon, ltr, tone})`, `progress(pct, {tone, label})`, `stars(value, {max})`,
`dl(rows, {columns})`, `code(value, {density, language})`, `actions(list, {size})`,
`bind_actions($root, list, doc)`, `bind_copy()`.

## Events and callbacks

Profile / opts `on_click(doc, e)` on the entity and per-action `on_click(doc, e)` (bound by
`mount`). A single delegated `document` click handler copies `.sanad-code-block` contents (Toast +
announce "Copied"). No realtime.

## Server calls

| Call | When |
|---|---|
| `frappe.db.get_value(doctype, name, fields_needed(doctype))` | `load` / `load_into` (after `ui.meta.with_doctype`). |

## Usage

```js
sanad.ui.configure({
  renderers: {
    doctypes: { "Library Member": "person" },
    profiles: { "Library Member": { title: "member_name", lines: [{ field: "phone", ltr: true }], value: false } },
  },
});
$cell.html(sanad.ui.Render.value(doc.grand_total, { fieldtype: "Currency" }, doc, { density: "row" }));
sanad.ui.Render.mount($el, doc, { doctype: "Library Member", density: "card", on_click: (d) => open(d) });
sanad.ui.Render.load_into($slot, "Contact", doc.contact, { density: "row" });
```

## CSS hooks

- Entity: `.sanad-ent.sanad-ent--{density}.sanad-ent--{kind}`, `.sanad-ent--go` (link / clickable), `data-name`; parts `__title`, `__sub`, `__text`, `__trail`, `__go`, `__value` (`--hero`), `__head`, `__desc`, `__facts`, `__foot`, `__cover`, `__body`, `__flag`, `__dot`, `__hero-media|-body|-head`.
- Lists: `.sanad-ent-list.sanad-ent-list--{density}`, `__item`.
- Parts: `.sanad-avatar--{size}` (`--image`, `--icon`, `--circle`), `.sanad-thumb--{size}` (`--empty`), `.sanad-filetype`, `.sanad-chipline` (`--link`, `__icon`, `__text`), `.sanad-chipline-row`, `.sanad-fact-grid` / `.sanad-fact` (`__head`, `__icon`, `__label`, `__value`), `.sanad-dl.sanad-dl--cols-N` / `__row--wide`, `.sanad-progress` (`__track`, `__bar`, `__value`), `.sanad-stars`, `.sanad-code`, `.sanad-code-block` (`__copy`, `__pre`), `.sanad-iconbtn-row` / `.sanad-iconbtn--{size}`.
- Values: `.sanad-amount` / `.sanad-number` (`--strong`), `.sanad-when`, `.sanad-tabular`, `.sanad-clamp--1|4`, `.sanad-rich`, `.sanad-tag-row` / `.sanad-tag` (`--rest`), `.sanad-swatch`; tones via `.sanad-tone--{tone}`.

## Notes

- Mixed text: phones, IDs, amounts and dates are `dir="ltr"`; free text `dir="auto"`. Status is never colour-only (badge label, progress number, Yes/No for Check).
- Initials only for name-like titles (not document numbers such as `SAL-ORD-2026-00004`).
- `Text Editor` / `HTML` are sanitised with `frappe.utils.sanitise_html` when available; everything else escaped.
- `load_into` uses `EmptyState` for loading / error; `list` shows "Nothing to show" when empty.
- Live use (outside the kit): `public/js/whatsapp_next_setup.js` (renderers config), `public/js/screens/messages.js` (`mount`), `public/js/listview/whatsapp_inbound_message_list.js` (`parts`), `whatsapp_next/page/wa_contacts/wa_contacts.js` (`mount`), `whatsapp_next/page/wa_home/wa_home.js` (`list`). Inside the kit: Drawer, DataList, Collection.

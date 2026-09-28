# `sanad.ui.Drawer`

An inline-end side panel that inspects (`record`), edits (`form`) or picks (`choice`) without
leaving the list. Meta-driven: in `record` mode the default **document layout** reads the record as
a document — identity (avatar, title, lines, status, time) · highlight (the main text) · key facts
grid · related records · caller sections · collapsible "More details" · activity timeline — built
from `sanad.ui.Render`; the plain `fields` layout is a two-column definition list. `form` fields are
real Frappe controls (`frappe.ui.form.make_control`) built from meta docfields. The payload comes
from a configured API key (`method`) or `frappe.db.get_value` with an explicit field list. Built on
the shared `.sanad-panel` / `.sanad-backdrop` shell; one overlay at a time through `ui.overlay`.

**Portability:** fully generic — needs only a DocType name and, optionally, an API key whose
return shape is the record as a flat object. Relations default to link fields whose target Render
classifies as a `person`.

## Options

| Option | Type | Default | Meaning |
|---|---|---|---|
| `doctype` | string | required (except `choice`) | Throws without it. |
| `name` | string | — | Record to fetch; also drives the header "Open" link. |
| `mode` | `"record"` \| `"form"` \| `"choice"` | `"record"` | Adds `sanad-drawer--{mode}`. |
| `layout` | `"document"` \| `"fields"` | `"document"` | `record` mode only. |
| `fields` | `Array<string \| df-like>` | `ui.meta.preview_fields(meta)` | Fieldnames or docfield overrides merged over meta; layout fields dropped; `"name"` allowed. |
| `method` | API key | — | `ui.call(method, args)` replaces `frappe.db.get_value`. |
| `args` | object \| `() => object` | `{name}` | Args for `method`. |
| `doc` | object | — | Render this payload without fetching (meta still loaded). |
| `title` | string | doctype label / title field | In the document layout the header shows the DocType; the record title goes to the identity block. |
| `subtitle` | string | — | Header subtitle. |
| `actions` | array | `[]` | Footer verbs, see below. |
| `sections` | `[{label, icon?, render($body, doc, drawer), condition?(doc)}]` | `[]` | Extra blocks (both layouts). A throw renders an error state in that block. |
| `profile` | object | — | `Render` profile overrides for the identity block (`facts: []` is forced). |
| `highlight` | fieldname \| `{field, label?, icon?, df?}` \| `($body, doc, drawer) => void` | first non-empty long-text field | Primary content block. |
| `highlight_label` | string | "Content" | Label when `highlight` is a function. |
| `facts` | `Array<string \| {field, label?, icon?, variant?, ltr?}>` | first `facts_max` short fields | Quick-facts grid. |
| `facts_max` | number | `6` | |
| `relations` | `Array<string \| {field, label?, doctype?, icon?, actions?, on_click?}>` | link fields to a `person` kind | Each rendered with `Render.load_into(..., {density: "row"})`. |
| `details` | `Array<string \| spec>` | every remaining non-empty field | "More details" `<details>` block (open). |
| `time_field` | fieldname | `sent_at` / `received_at` / `creation`, else `modified` | Timestamp in the identity block. |
| `activity` | `rows[]` \| `(doc, drawer) => rows \| Promise<rows>` | — | Timeline rows `{title, description?, time, user?, icon?, tone?}` rendered by `sanad.ui.Collection` (`view: "timeline"`). |
| `activity_label` | string | "Activity" | |
| `timeline` | object | — | Passed through as Collection's `timeline` option. |
| `on_save` | `(values, doc, drawer) => Promise` | — | `form` mode: adds a primary Save action; closes on resolve. |
| `save_label` | string | "Save" | |
| `choices` | `[{label, description?, value, icon?}]` | `[]` | `choice` mode. |
| `on_choose` | `(value, choice) => void` | — | Called after the drawer hides. |
| `on_close` | `(drawer) => void` | — | Not called on `hide({silent: true})` / `destroy()`. |
| `width` | number \| CSS string | 520px (shell) | Sets `--sanad-panel-width`. |
| `open_link` | boolean | `true` | Header "Open" link to the form when a name is known. |
| `listview` | list view | `cur_list` | Focus fallback target on close. |

**Action spec:** `{label, icon?, handler(doc, drawer), primary?, danger?, menu?, condition?(doc), perm?, roles?}`.
Filtered by `ui.visible_actions`. `menu: true` moves it behind the single "More" (⋯) button at the
footer's start. The button is disabled while the handler's promise runs; a rejection other than
`"cancelled"` shows `Toast.error`.

## Methods

- `show()` — open (captures opener, fetches / renders); returns `this`.
- `hide({silent} = {})` — close, restore focus, call `on_close` unless silent.
- `refresh()` — re-fetch and re-render (skeleton, error with Retry).
- `set_doc(doc)` — replace the payload; re-renders when open.
- `set_title(title, subtitle?)`
- `get_values()` — `form` mode: `{fieldname: value}` of the controls.
- `save()` — `form` mode: required-field check (focusable summary with links) then `on_save`.
- `destroy()` — remove DOM (hides silently first if open).
- `field_list()` — resolved docfields.
- Static: `Drawer.open(opts)` (= `new Drawer(opts).show()`), getter `Drawer.current`.

## Events and callbacks

`on_close`, `on_save`, `on_choose`, action `handler`s, section `render`s, `activity` function,
relation `actions` / `on_click`. No custom DOM events; no realtime subscriptions. Adds
`sanad-drawer-open` to `<body>` while open.

## Server calls

| Call | When |
|---|---|
| `ui.call(opts.method, args)` | `show()` / `refresh()` when `method` is set. |
| `frappe.db.get_value(doctype, name, fields)` | Otherwise; fields = `field_list()` + title field + `name`, `modified`, `status`, `docstatus` (submittable) + `Render.identity_fields()` in the document layout. |
| `frappe.db.get_value(target, value, Render.fields_needed(target))` | Per relation, through `Render.load_into`. |

## Usage

```js
sanad.ui.Drawer.open({
  doctype: "ToDo", name: row.name, listview,
  highlight: "description",
  facts: ["status", "priority", { field: "date", icon: "es-line-calender" }],
  relations: [{ field: "allocated_to", doctype: "User" }],
  activity: (doc) => frappe.xcall("my_app.api.todo_log", { name: doc.name }),
  actions: [
    { label: __("Close task"), primary: true, condition: (d) => d.status === "Open", handler: (d, dr) => close(d).then(() => dr.refresh()) },
    { label: __("Delete"), danger: true, menu: true, perm: "delete", handler: (d) => remove(d) },
  ],
});

new sanad.ui.Drawer({
  mode: "choice", title: __("Pick a version"),
  choices: [{ label: "1.2.0", description: __("Latest"), value: "1.2.0" }],
  on_choose: (v) => install(v),
}).show();
```

## CSS hooks

- Root `aside.sanad-kit.sanad-panel.sanad-drawer.sanad-drawer--{record|form|choice}`, `.sanad-panel--open` when visible; `.sanad-drawer__backdrop`.
- Header: `__heading`, `__title`, `__meta` (badge + `.sanad-panel__subtitle`), `__tools`, `__open`, `__close`.
- Body / footer: `__body`, `__footer`, `__action`, `__more`, `__menu` (reuses `.sanad-rowactions__menu` / `__item`).
- `fields` layout: `__dl`, `__field`, `__field--wide`. Form: `__form`, `__summary`. Choice: `__choices`, `__choice`, `__choice-icon|-text|-label|-desc`.
- Document layout: `.sanad-doc__identity` (`-main`, `-text`, `-title`, `-sub`, `-ref`, `-side`, `-time`, `-value`), `.sanad-doc__block` (`--highlight`), `__block-title`, `__block-icon`, `__block-body`, `.sanad-doc__highlight`, `.sanad-doc__details`, `__details-body`; facts use `.sanad-fact-grid` / `.sanad-fact`, details `.sanad-dl`.
- Menu position via `--sanad-menu-x` / `--sanad-menu-y`.

## Notes

- States: skeleton (`EmptyState` loading, 4 rows) → content; fetch error → error state with Retry; `fields` layout with nothing to show → "This record has no fields marked for preview."; empty choices / activity → small empty states.
- `role="dialog"` + `aria-modal`, labelled by the title; focus trapped; Escape and backdrop close; focus returns to the opener, else the list row with the same name (`listview` or `cur_list`), else the first row. Opening announces "{0} details opened.".
- Choice list and More menu: arrow / Home / End via `ui.roving_index`; menu closes on Escape, Tab or outside click. Menu position is RTL-aware.
- Every field of `field_list()` lands in exactly one document block (identity fields excluded via `vm.used`).
- Live use: `public/js/screens/messages.js` (`open_outbound_drawer`, used by the Outbound and Queue lists and form), `public/js/listview/whatsapp_inbound_message_list.js`, `whatsapp_next/page/wa_contacts/wa_contacts.js`, `whatsapp_next/page/wa_functions_center/wa_functions_center.js`.

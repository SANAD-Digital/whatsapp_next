# `sanad.ui.TemplateEditor`

A live Jinja preview mounted into any Desk form that has a template body field: a sample-record
picker (a Link control on the reference DocType plus "Use latest"), a debounced preview pane that
renders the body server-side and lists render errors, and a variables sidebar whose buttons insert
`{{ name }}` at the caret of the body control (Ace editor, textarea or input). Field names are
options, so the same component serves any template-like DocType.

**Portability:** the three server keys default to this app's `templates.preview`,
`templates.list_variables` and `templates.pick_sample` (override with `api`), and the component
relies on their shapes (below). Styles use Espresso/kit tokens only.

## Options

| Option | Type | Default | Meaning |
|---|---|---|---|
| `frm` | Form | — | Required; the constructor throws without it. |
| `body_field` | string | `"body"` | The Jinja body (Code / Text / Small Text / Data). |
| `reference_doctype_field` | string | `"reference_doctype"` | Link to DocType driving the sample picker and variables; may be absent on the form (falsy disables it). |
| `sample_field` | string | `"sample_context"` | JSON field with extra context; may be absent (falsy disables it). |
| `preview_field` | string | — | An HTML field to mount into (its wrapper is emptied). Otherwise mounts right after the body field, else at the end of `.form-layout`. |
| `debounce` | number (ms) | `400` | Between a change and the preview call. |
| `api` | `{preview?, variables?, sample?}` | the `templates.*` keys | `ui.call` key overrides. |

## Methods

- Static `TemplateEditor.mount(opts)` — create once per form (stored as
  `frm.__sanad_template_editor`) and `refresh()` it on later calls; call it from `refresh(frm)`.
  Returns the instance, or `null` without `frm`.
- Static `TemplateEditor.bind_form_events(doctype, opts)` — registers `frappe.ui.form.on` handlers
  for the body, reference and sample fields once per DocType (called by the constructor).
- `refresh()` — rebuild picker and variables if the reference DocType changed, else re-preview.
- `on_reference_change()` — reset the sample record, rebuild the picker, reload variables, preview.
- `preview()` — render now (returns a Promise); `schedule_preview()` is the debounced form.
- `use_latest()` — pick the newest record of the reference DocType as the sample.
- `load_variables()` / `render_variables()` — fetch / redraw (respecting the filter box).
- `insert_variable(name)` — insert `{{ name }}` at the body caret (appends when the body is not
  visible, e.g. mounted on another tab).
- `render_errors(errors)` — replace the error list only when it changed.
- `destroy()` — remove the DOM and the form reference.

## Events and callbacks

- No option callbacks. Form events: changes to `body_field` and `sample_field` schedule a preview;
  a change to `reference_doctype_field` calls `on_reference_change()`. These are bound once per
  DocType with the field names of the **first** instance's options.
- The sample Link control's `change` re-previews. No custom events; no realtime.

## Server calls

| Key (default) | Args | Returns | When |
|---|---|---|---|
| `templates.preview` | `{body, reference_doctype, reference_name, sample_context?}` | `{body, errors[]}` | Debounced after body/sample/record changes; `silent`. Skipped when the body is blank. |
| `templates.list_variables` | `{reference_doctype}` or `{}` | `[{name, label?, fieldtype?}]` | On mount and on reference change; `silent`. |
| `templates.pick_sample` | `{reference_doctype}` | `{name}` | "Use latest" click. |

## Usage

```js
frappe.ui.form.on("WhatsApp Template", {
  refresh(frm) {
    sanad.ui.TemplateEditor.mount({
      frm,
      body_field: "body",
      reference_doctype_field: "reference_doctype",
      sample_field: "sample_context",
      preview_field: "preview_html",
    });
  },
});
```

## CSS hooks

- Root `.sanad-kit.sanad-tpl`.
- Toolbar: `__toolbar`, `__sample`, `__sample-control`, `__latest`, `__sample-note`.
- Preview: `__grid`, `__preview`, `__h`, `__state`, `__bubble`, `__muted`, `__errors`.
- Variables: `__vars`, `__search`, `__vars-state`, `__list`, `__var[data-name]`, `__var-label`.
- Single column under 768 px (preview first).

## Notes

- **States:** `sanad.ui.EmptyState` skeletons while loading (preview and variables); "Nothing to
  preview" for a blank body; "The template renders to an empty message." for an empty render;
  errors with a Retry action; "No variables" / "No variables match".
- Invalid JSON in `sample_field` is reported in the error list and the preview continues without it.
- The preview uses `sanad.ui.ChatThread.format` when loaded (WhatsApp marks), else escaped text with
  line breaks. Stale responses are discarded (sequence counter); the bubble is `aria-busy` during
  a render; the error list is `role="alert"` and re-rendered only when its content changes.
- "Use latest" is hidden without a reference DocType, disabled/`aria-busy` while calling, and a
  Toast says so when there are no records.
- **Live use:** `public/js/form/whatsapp_template.js` (mounted into `preview_html` on the Preview tab).

# TemplateEditor

A live Jinja preview for any form with a template body: a variables sidebar
(`templates.list_variables(reference_doctype)` → click inserts `{{ name }}` at the caret of the
body control — Ace editor, textarea or input), a sample-record picker (a Link control on the
reference DocType plus "Use latest" through `templates.pick_sample`) and a debounced (400 ms)
preview pane calling `templates.preview({body, reference_doctype, reference_name,
sample_context})` → `{body, errors[]}`. Render errors are listed under the preview with
`role="alert"`. The field names are options, so the same component serves a message template,
a notification message or a command output template.

## Usage

```js
frappe.ui.form.on("Message Template", {
  refresh(frm) {
    sanad.ui.TemplateEditor.mount({
      frm,
      body_field: "body",                          // Code (Jinja) / Text / Small Text / Data
      reference_doctype_field: "reference_doctype", // Link → DocType (optional)
      sample_field: "sample_context",              // JSON field with extra context (optional)
      // preview_field: "preview_html",            // mount into an HTML field instead of after the body
    });
  },
});
```

Options: `frm`, `body_field` ("body"), `reference_doctype_field` ("reference_doctype"),
`sample_field` ("sample_context"), `preview_field`, `debounce` (400), `api`
(`{preview, variables, sample}` key overrides).
Methods: `refresh()`, `preview()`, `insert_variable(name)`, `use_latest()`, `load_variables()`,
`destroy()`. Static: `mount(opts)` (idempotent per form; call it from `refresh`).

The editor binds `frappe.ui.form.on(doctype, {body, reference_doctype, sample_context})` once per
DocType and routes the events to the mounted instance, so typing in the Ace editor re-renders
after Frappe's own 300 ms model update plus the 400 ms debounce.

## Live use
`public/js/form/whatsapp_template.js` (Message Templates); Notifications `message` field and
Command outputs in phase 7.

## Design gate
- Errors next to the content they describe in a `role="alert"` list that is re-rendered **only
  when the errors change**, so assistive technology hears them once, not on every keystroke; the
  preview bubble itself is not a live region. Invalid sample JSON is reported with a how-to-fix.
- Reserved `min-height` on the preview pane; loading is a skeleton (EmptyState), never a spinner;
  the pane is `aria-busy` while a render is in flight and stale responses are discarded.
- No dead buttons: "Use latest" renders only when a reference document type is set; an empty
  document type shows a toast that says why nothing happened ("There are no … records to
  preview with yet.").
- Copy says "reference document type", never "DocType".
- Variables are real buttons (≥ 32 px, global kit focus ring, "Insert {{ … }}" labels) with a
  filter box; tokens are `dir="ltr"` islands so they read correctly inside Arabic labels.
- Single column under 768 px (preview first, variables under it).

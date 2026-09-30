# TemplateWindow

One window to write, check and save a message template — the port of
`docs/component/Template Editor.dc.html`. The name is the header (a field that reads as a title),
and under it three columns:

1. **Editor** — the message type as a segmented control (Text · Image · Document), a category
   (free text, suggesting the ones already used), the document the message is about (a Link on
   DocType — it drives the variables and the preview), and the text with a formatting bar:
   *bold*, _italic_, ~strike~, ```mono``` and a ready `{% if %} … {% else %} … {% endif %}` with
   its condition selected. An image message takes its image under the text (upload / replace /
   remove); a document message its print format (filtered to the document), letter head and file
   name. Description, language, "offered when sending" and extra JSON sample values fold away
   under **More options**.
2. **Preview** — the text as WhatsApp shows it, rendered by the host's sandbox with a record of
   the chosen document (picked, or the latest one the reader may read). A template that does not
   render still shows its text as written, with the reason under it.
3. **Variables** — what the text may use, the document's fields first, filtered as you type; a
   click inserts `{{ … }}` at the caret.

Under 960 px the variables become a tab beside the editor; under 720 px the window takes the
whole screen and all three are tabs.

## Usage

```js
new sanad.ui.TemplateWindow({
  name: "Payment reminder" /* or null for a new one */,
  load: (name) => api("get_editor", { name }),        // {template, categories[], message_types[], can_write, can_delete}
  save: (payload) => api("save_editor", { payload }),  // → {name, modified}
  remove: (name) => api("delete_template", { name }),
  preview: (args) => api("preview", args),             // {body, reference_doctype, reference_name, sample_context} → {body, errors[]}
  variables: (doctype) => api("list_variables", { reference_doctype: doctype }), // [{name, label, fieldtype}]
  pick_sample: (doctype) => api("pick_sample", { reference_doctype: doctype }),  // {name}
  use_in_message: (name) => new sanad.ui.QuickSend({ template: name }),
  on_saved: (r) => list.refresh(),                     // r.deleted after a delete
});
```

The payload is `{name?, modified?, template_name, category, description, message_type, disabled,
body, attachment, print_format, letter_head, file_name_template, reference_doctype, language,
sample_context}`. `modified` is the version the window opened, so the host can refuse to
overwrite an edit saved elsewhere since; a changed `template_name` on a saved template is a
rename. The host decides what it accepts.

## Live use
Message templates: "New template", a row and "View" in the templates list open it
(`public/js/screens/templates.js` → `api/v1/templates.py`), and the template form offers
"Open in the editor".

## Design gate
- A labelled `role="dialog"` with `aria-modal`; Tab stays inside; Esc closes a Link list first,
  then the window (asking before unsaved changes are dropped); Ctrl/⌘+S saves.
- The header says Unsaved / New / Not offered / Read only in words, as a live region.
- What is missing is said before the server has to, next to the Save button, and focus goes to
  the field that needs it.
- The DOM is built once; typing redraws only the preview, the counter and the status, so the
  caret never jumps. Preview renders are debounced (400 ms) and stale ones are dropped; render
  errors are re-announced only when they change.
- A reader without write permission gets the same window read-only, with Close and "Use in a
  message".
- Product tokens only; logical properties; tokens are `dir="ltr"` islands inside Arabic labels.

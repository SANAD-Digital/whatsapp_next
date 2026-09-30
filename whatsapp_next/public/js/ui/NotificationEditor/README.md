# NotificationEditor

One window to create, edit and try a document notification — a WhatsApp message that goes out
when something happens to a record. The AlertEditor's anatomy and styling (`sanad-ae`), with
four cards that tick themselves green once complete:

1. **When** — the document type (searched), the event as chips (created, saved, submitted,
   cancelled, a field changes, N days before / after a date, N minutes before / after a time,
   another document event) in two labelled groups — "something happens to it" and "on a
   schedule" — with the detail the event needs on one line; then **for which records**: every
   record, the ones **matching filters** (Frappe's own `FilterGroup` on the document type, stored
   as Frappe's Notification stores it: `condition_type = "Filters"` and a JSON `filters` list), or
   an expression (`condition_type = "Python"`, a Python expression over `doc`).
2. **What** — the message **from a template** or **written here**. Templates are cards, the ones
   written for this document type first, with a "New template" card and "Edit this template";
   both open the host's template editor, and a template saved there is chosen. Written text
   inserts the document's fields as `{{ doc.field }}` and can be saved as a template. Then what it
   attaches: nothing, a print of the record (print format, letter head) or a file in one of its
   Attach fields.
3. **To whom** — a number in the document (a phone field or a Contact link), a number through a
   linked record, a fixed number, or the host's contact picker; chips, each removable.
4. **From** — the sending device as a Link field.
5. **Afterwards** (optional, folded) — set a field of the record once the message is sent.

Beside them, a live preview of the unsaved draft on one record (the latest, or one picked):
whether the condition holds, the message as the first recipient gets it, the attachment and how
many numbers it reaches, and what is still missing. **Send a test** sends it once to one number.
A saved notification also shows what it has sent.

## Usage

```js
new sanad.ui.NotificationEditor({
  name: "Invoice submitted" /* or null for a new one */,
  load: (name) => api("get_editor", { name }),            // {notification, stats, recent[], options{event, method, recipient_type}, devices[], templates[], fields, me{phone}, can_write, can_delete}
  setup: (doctype) => api("get_document_setup", { document_type: doctype }), // {fields, templates}
  preview: (payload, ref) => api("preview_draft", { payload, reference_name: ref }),
  save: (payload) => api("save_editor", { payload }),     // → {name}
  remove: (name) => api("delete_notification", { name }),
  send_test: (payload, phone, ref) => api("send_test", { payload, phone, reference_name: ref }),
  search: (kind, txt, doctype) => api("search", { kind, txt, document_type: doctype }), // document_type | print_format | letter_head
  device_link: { doctype: "WhatsApp Device", filters: { status: "Connected" } },
  open_template: (name, { defaults, on_saved }) => open_template_window(name, { defaults, on_saved }),
  pick_recipients: ({ existing }) => Promise.resolve(rows),  // [{phone_e164, display_name}]
  on_saved: (r) => list.refresh(),                          // r.deleted after a delete
});
```

`fields` is `{date_fields, datetime_fields, phone_fields, link_fields, all_fields}` of the
document type (`{fieldname, label, fieldtype, options}` rows); `templates` are `{name,
template_name, category, reference_doctype, message_type, body}`. The payload is the
notification's own fields plus `recipients` rows; a template keeps the written text on the record
so switching back loses nothing.

## Live use
Notifications: "New notification", a row and "View" in the notifications list, and "Open in the
editor" on the form (`public/js/screens/notifications.js` → `api/v1/notifications.py`).

## Design gate
- The AlertEditor's: a labelled `role="dialog"` with `aria-modal`; Tab stays inside; Esc closes a
  picker first, then the window (asking before unsaved changes are dropped); Ctrl/⌘+S saves.
- Template cards are buttons with `aria-pressed`; the chosen one is ticked, not only coloured.
- What is missing is said in the preview and next to Save before the server has to.
- A document type the reader cannot read still saves; the preview says why it has nothing to show.
- Product tokens only; logical properties; `{{ … }}` tokens and numbers are `dir="ltr"` islands.

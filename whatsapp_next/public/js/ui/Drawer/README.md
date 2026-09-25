# Drawer

An inline-end side panel to inspect (`record`), edit (`form`) or pick (`choice`) without leaving
the list. Meta-driven: the header badge comes from the DocType's indicator rules
(`sanad.ui.indicator_for`), `record` fields default to `sanad.ui.meta.preview_fields(meta)`
(`in_list_view` + `bold`) and every value is rendered with `sanad.ui.meta.format`; `form` fields
are real Frappe controls (`frappe.ui.form.make_control`) built from the meta docfields. The payload
comes from a configured API key (`method`) or from `frappe.client.get_value` with the explicit
field list. Exactly one drawer is open at a time (`sanad.ui.Drawer.current`). Portable: only a
DocType name and, optionally, an API key.

## Usage

```js
// record (from a list row) with a host payload and extra sections
new sanad.ui.Drawer({
  doctype: "WhatsApp Log", name: doc.name, mode: "record",
  method: "messages.get_outbound",                 // default: frappe.client.get_value(fields)
  fields: ["status", "phone_e164", "body", "sent_at"],
  sections: [
    { label: __("Timeline"), render: ($el, d) => render_timeline($el, d.timeline) },
    { label: __("Reference"), condition: (d) => d.reference?.name, render: render_reference },
  ],
  actions: [
    { label: __("Resend"), icon: "es-line-reload", condition: (d) => d.status === "Failed", handler: (d) => resend(d) },
    { label: __("Cancel"), danger: true, roles: ["WhatsApp Manager"], handler: (d, drawer) => cancel(d).then(() => drawer.refresh()) },
  ],
}).show();

// form — create / edit with meta controls
new sanad.ui.Drawer({
  doctype: "Contact", name, mode: "form", fields: ["first_name", "last_name", "email_id"],
  on_save: (values) => sanad.ui.call("contacts.update_contact", { name, payload: values }),
}).show();

// choice — a list of options
new sanad.ui.Drawer({
  mode: "choice", title: __("Simulate a message"),
  choices: [{ label: "#balance", description: __("Account balance"), value: "balance" }],
  on_choose: (value) => simulate(value),
}).show();
```

Options: `doctype`, `name`, `mode`, `fields[]` (fieldnames or docfield-like objects), `method`,
`args`, `doc` (render without fetching), `title`, `subtitle`, `actions[]` (`label`, `icon`,
`handler(doc, drawer)`, `primary`, `danger`, `menu` — behind the footer's one "More" button —, `condition(doc)`, `perm`, `roles`), `sections[]`
(`label`, `render($el, doc, drawer)`, `condition`), `on_save(values, doc)`, `save_label`,
`choices[]`, `on_choose(value, choice)`, `on_close`, `width`, `open_link`.
Methods: `show()`, `hide()`, `refresh()`, `set_doc(doc)`, `get_values()` (form), `destroy()`;
static `open(opts)`, `current`. Helper classes for sections: `sanad-drawer__dl` / `__field`,
`sanad-drawer__timeline` / `__event`.

## Live use
Contacts page — `page/wa_contacts/wa_contacts.js` (document layout of a Contact from the
page's own row: identity, an alert as the highlight, facts, the linked accounts rendered as the
parties they are, the last messages, an audit timeline, three verbs and a "More" menu);
Functions Center — `page/wa_functions_center/wa_functions_center.js` (document layout of a
catalog function: the alert and the description as the highlight, six facts, the manifest's
variables · settings · outputs as sections, the linked commands rendered as commands, the
versions as the activity timeline, Install / Update / Preview in the footer and the rest behind
"More"; plus a `choice` drawer to pick another version);
Outbound list — `public/js/listview/whatsapp_log_list.js` (`messages.get_outbound`: fields +
Reference + Timeline sections); Inbound list — `public/js/listview/whatsapp_inbound_message_list.js`
(`messages.get_inbound`: Command trace + Reply); Queue list —
`public/js/listview/whatsapp_queue_item_list.js` (drawer of the linked outbound row).

## Design gate
Applied from the phase-5 audit:
- Built on the shared `.sanad-panel` shell and `.sanad-backdrop` (same header / body / footer
  grammar, width var, 100 % sheet on mobile as ConversationDrawer) — one side-panel look.
- One overlay at a time through `sanad.ui.overlay` (opening a Drawer closes a ConversationDrawer
  and vice versa — never two `aria-modal` dialogs).
- Focus: the opener is captured **before** a previous panel is hidden; on close focus returns to
  the opener only if it is still in the DOM, otherwise to the list row of the same docname
  (`listview` option or `cur_list`), otherwise to the list (WCAG 2.4.3).
- `role="dialog"` + `aria-modal`, labelled by the title; focus trapped, Escape closes; the opened
  record is announced as a sentence ("{0} details opened.").
- Choice mode is a `role="list"` of plain buttons (no permanent `aria-selected="false"`), with
  arrow / Home / End navigation through `sanad.ui.roving_index`.
- Copy: "Choose an option", "No options available", "This record has no fields marked for
  preview.", "Fill in the required fields:" (focusable `role="alert"` summary with links).
- Loading is a skeleton with reserved body height; errors render with Retry (EmptyState);
  `scroll-padding-block-end` keeps a focused control clear of the sticky footer; long text
  fields span both columns, one column under 768 px; `prefers-reduced-motion` via `--sanad-motion`.
- Action visibility through `sanad.ui.visible_actions` (roles / perm / condition).

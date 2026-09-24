# MessageComposer

The ordered messages a record will send, drawn as **the conversation they will produce** instead of
as a child-table grid. Each message is a card — its order, its type, the line it will send and what
is missing from it — that opens into its own editor beside a live chat bubble, and the gap between
two cards *is* the delay between them, set by pressing it.

Which fields a type offers is read from the child DocType's own `depends_on` rules and its Select
options, so a host app adds a message type by adding it to the field and the component follows.
Values are written with `frappe.model.set_value`, so Frappe's dirty state, validation and save are
untouched; the native grid stays in the DOM (it is what saves) and is hidden behind the component.

## Usage

```js
frappe.ui.form.on("Campaign", {
  refresh(frm) {
    frm.composer = new sanad.ui.MessageComposer({
      frm,
      fieldname: "messages",             // the Table field
      type_field: "message_type",        // Select — drives which fields show
      body_field: "body",                // where a variable is inserted
      delay_field: "delay_seconds",      // Int — drawn as the connector between two cards
      max: 5,
      can_edit: () => frm.doc.status === "Draft",
      preview: {                          // optional; called when the record is saved and clean
        method: "campaigns.preview_message",
        args: (row) => ({ name: frm.doc.name, idx: row.idx }),
      },
      variables: [                        // an array, or {method, args} to fetch them
        { name: "recipient.display_name", label: __("Recipient name") },
      ],
      empty_text: __("No message yet"),
    });
  },
});
```

Options: `frm`, `fieldname`, `type_field` (`"message_type"`), `body_field` (`"body"`),
`delay_field`, `fields?` (default: every editable non-layout field of the child DocType),
`preview?` (`{method, args(row, frm)}` → `{body, attachment_name, message_type, errors[]}`),
`variables?` (array of `{name, label}` or `{method, args(frm)}`), `can_edit?()`, `max?`,
`empty_text?`, `debounce` (500).
Methods: `refresh()`, `add(type?)`, `duplicate(row)`, `remove(row)`, `move(row, delta)`,
`insert_variable(row, name)`, `destroy()`.

A type the host adds to the Select but does not name in the component's own catalogue still works:
it takes the default icon, no explanatory line, and the last shelf of the chooser.

The bubble renders WhatsApp's own emphasis (asterisks, underscores, tildes, backticks), draws an
attachment as a file chip and a poll as its question and answers, and shows a variable that has not
been filled in yet as a chip rather than as stray braces — so an unsaved message still reads as a
message. Once the record is saved and clean, the server preview replaces it and render errors are
listed under the bubble.

## Live use
`public/js/form/whatsapp_campaign.js` — the campaign's messages (Text, Document, Image, Video,
Audio, Sticker, Location, Poll), five at most, with the campaign's own variables.

## Design gate
- The editor and its result are on one screen: the preview is sticky beside the fields on a wide
  column and moves **above** them on a narrow one, because it is the reason the editor exists.
- A card says what is missing from a message ("The text is empty", "At least two answers") on the
  collapsed row, so a campaign is never started on a message that cannot be sent.
- The delay is not a number in a form: it is the space between two messages, and it is edited where
  it is read.
- The type is **one control, not one per type**. A button per type spent a whole band of the editor
  on a choice made once per message, and read as a toolbar rather than as an answer to "what is
  this?". A pill says what the message is and opens the list of what else it could be — grouped by
  what the writer is trying to do (write · send a file · ask something), each with the line that
  tells it from its neighbours. The same list is what "Add message" opens, because the type is the
  one thing about a message that cannot be typed into a field, so it is asked at the only moment
  the writer is thinking about it.
- The verb that adds a message is in two places, because a writer looking at the list of messages
  should not have to look back up at the header to add one: the header carries it as the primary
  action, and the foot of the rail carries it again.
- The chooser is a `menu` of `menuitemradio`s with arrow-key roving focus, Escape to close and
  focus returned to the button that opened it; every icon-only action carries its name; inserting a
  variable announces itself; the form is not marked dirty by opening an editor.
- A row's verbs appear on hover, on focus **and** on the row being edited — and unconditionally
  where the pointer cannot hover (`@media (hover: none)`), since a finger has no hover state.
- Removing a message that has content asks first and names it; an empty one goes without a question.

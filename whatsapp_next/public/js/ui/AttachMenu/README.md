# AttachMenu

The composer's "+" from the prototype's Chat Thread (`docs/component/Chat Thread.dc.html`,
`composer.attach`): a 14 px-radius popover over the button with a 3-column grid — image · video ·
document · voice note · location · contact card — each a 38 px round icon in its tone over its
label, and the chip the picked kind leaves above the field.

- A file kind opens Frappe's own uploader (a private file, restricted to that family: images,
  videos, audio; any file for a document).
- Location and contact card are a second step inside the same popover (latitude · longitude ·
  place name with "Use my current location", or a contact search), so the menu never closes the
  window it lives in.
- A kind the host cannot send is drawn disabled with the host's reason.

The value is the host's to send: `{kind, label, attachment, file_name, contact, contact_label,
location{latitude, longitude, name}}`.

## Usage

```js
new sanad.ui.AttachMenu({
  anchor: plus_button,
  kinds: ["image", "video", "document", "audio", "contact"],          // optional; default all six
  reasons: { location: __("Send a location from one conversation.") }, // why a kind is off
  search_contacts: (txt) => search(txt),                               // → [{name, label, phone}]
  on_pick: (value) => { draft.attach = value; redraw(); },
});

$slot.html(sanad.ui.AttachMenu.chip_html(draft.attach));   // the chip; its × is [data-attach-clear]
sanad.ui.AttachMenu.icon("image");  sanad.ui.AttachMenu.label("image");
```

## Live use
The host app's simulator composer and the bulk message window (`BulkSend`).

## Design gate
- The popover is a labelled `role="dialog"`; focus moves into it, Esc closes it and returns focus
  to "+", a click outside closes it.
- Every item is a button with a visible label; a disabled kind carries its reason as a title.
- The location step validates the range before it closes and says what is wrong in `role="alert"`.
- The chip names the kind and the file / contact / place, and its × has an `aria-label`.
- Product tokens only; logical offsets; the popover keeps inside the viewport on a phone.

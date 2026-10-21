# GroupCreate

Create a WhatsApp group from any screen: a `frappe.ui.Dialog` with the group's name, the device
that creates it (connected devices only, the default one first) and becomes its admin, an
optional description, and its members. Members start from what the host passes — numbers, or the
records behind a selection (`wa_groups.members_from`: Contacts, contact groups or WhatsApp
Numbers) — and more are chosen with the ContactPicker in local mode. After creating, a second
dialog reports every number: **added**, **needs an invitation** (their privacy settings refuse
being added by others; the group's invite link is shown with a copy button), or **not on
WhatsApp**. With `contact`, the group is also saved among that contact's numbers.

## Usage

```js
// from a selection of contacts / contact groups / numbers
new sanad.ui.GroupCreate({ source: { doctype: "Contact", names: selected } });

// from one contact: its numbers to start with, and the group saved on it
new sanad.ui.GroupCreate({ source: { doctype: "Contact", names: [frm.doc.name] }, contact: frm.doc.name, name: frm.doc.full_name });

// numbers already in hand
new sanad.ui.GroupCreate({ members: [{ phone_e164: "+9677…", display_name: "Ali" }], on_created: (r) => … });
```

Options: `members?`, `source?: {doctype, names}`, `contact?`, `name?`, `on_created?(result)`.
API keys: `wa_groups.members_from`, `wa_groups.create_group`, `devices.list_devices`.
The result is `{jid, name, members[{phone, status, jid}], invite_link, saved_to_contact}`.

## Live use

The Contacts page, the Contact form, the WhatsApp Numbers list and the contact group form.

## Design gate
- Both steps are Frappe dialogs (`frappe.ui.Dialog`): focus trap, Escape and the primary verb come
  from Frappe; the form fields are Frappe controls with their own labels.
- Every member chip's remove button carries an `aria-label` naming the member ("Remove {name}").
- The report never uses colour alone: each number's state is a StatusBadge with its label
  (added / needs an invitation / not on WhatsApp).
- The invite link is plain selectable text beside a real `<button>` that copies it.

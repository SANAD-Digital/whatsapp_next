# wa_groups

Module `whatsapp_next/api/v1/wa_groups.py`. These endpoints serve the "Create WhatsApp group"
dialog of the Contacts, Contact Groups and WhatsApp Numbers screens (`whatsapp_next.wa_groups` in
`whatsapp_next_setup.js`). They are thin wrappers over `services/wa_groups.py`. The device creates
the group through the provider and becomes its admin. The group then exists here as a
`WhatsApp Number` of type `Group` and, when it was created for a Contact, as one of that contact's
numbers. WhatsApp groups are the plan feature `allow_groups`.

| Endpoint | Roles |
|---|---|
| `members_from` | `AGENT_UP` (WhatsApp Agent, WhatsApp Manager, System Manager) |
| `create_group` | `MANAGER` (WhatsApp Manager, System Manager) |

Not to be confused with [groups.md](groups.md), the editor of the site's own contact groups
(`WhatsApp Contact Group`), which never touches WhatsApp.

Conventions are in [README.md](README.md). File name of this page: `whatsapp-groups.md`. Python
module: `wa_groups`. Kit keys: `"wa_groups.<fn>"`. Provider exceptions are mapped as described in
README §5.

### Realtime

None of these endpoints publishes a realtime event.

---

## members_from

The individual WhatsApp numbers behind the selected records, to prefill the dialog. It reads
through the caller's permissions and writes nothing.

- **Path:** `whatsapp_next.api.v1.wa_groups.members_from`
- **Methods:** GET, POST
- **Roles:** `AGENT_UP`

| Argument | Type | Required / default | Meaning |
|---|---|---|---|
| `source_doctype` | str | required | `Contact`, `WhatsApp Contact Group` or `WhatsApp Number` |
| `names` | list[str] | required | The selected record names. Only the first 256 are read. |

| `source_doctype` | Numbers taken |
|---|---|
| `Contact` | The individual WhatsApp numbers (`wa_phone_e164`) of the contacts. Without the contacts role's elevated read, contacts the user can't read are dropped silently. |
| `WhatsApp Contact Group` | The individual members of the groups. A group the user can't read raises `PermissionError` (403). |
| `WhatsApp Number` | The selected rows of type `Individual`, through the user's list permission |

Group JIDs are left out, and each number appears once (the first name found is kept).

**Returns.** `display_name` is the contact's `full_name`, the group member's or the number's
display name, and may be `null`.

```json
{"members": [{"phone_e164": "+966501234567", "display_name": "Ali Saleh"},
             {"phone_e164": "+966507654321", "display_name": null}]}
```

**Errors:** `WAValidationError` (417) for a `source_doctype` outside the list. `PermissionError`
(403) for a contact group the user can't read.
**Realtime:** none.

```js
const { members } = await whatsapp.ui.call("wa_groups.members_from", {
  source_doctype: "WhatsApp Contact Group", names: ["VIP customers"],
});
```

---

## create_group

Creates a WhatsApp group on a connected device with the given numbers. The group's
`WhatsApp Number` row is created (`number_type = "Group"`, `link_status = "Not Linked"`), or its
name is updated when it already exists. With `contact`, the group's address is saved among that
contact's numbers (a `phone_nos` row whose `wa_phone_e164` is the group JID), and the group's
number is linked to the contact. Audited as `WhatsApp Group Created`, with the members' statuses
counted.

- **Path:** `whatsapp_next.api.v1.wa_groups.create_group`
- **Methods:** POST
- **Roles:** `MANAGER`

| Argument | Type | Required / default | Meaning |
|---|---|---|---|
| `device` | str | required | `WhatsApp Device` name. It must be `Connected`. |
| `name` | str | required | The group's name, 1–100 characters (trimmed) |
| `members` | list[str] | required | Numbers to add. Only individual numbers are kept, normalised to E.164 and deduplicated: 1–256. |
| `description` | str | optional | The group's description |
| `contact` | str | optional | `Contact` name to save the group under. Needs the elevated contact write (the contacts role, or native write on every Contact). |

**Returns.** Each member's `status` is `added`, `invite_required` (their privacy settings refuse
being added; share `invite_link` with them), `not_on_whatsapp` or `failed`. `saved_to_contact` is
`false` when no `contact` was given or the contact already had the group.

```json
{"jid": "120363025246125486@g.us", "name": "VIP customers",
 "members": [{"phone": "966501234567", "status": "added", "jid": "966501234567@s.whatsapp.net"},
             {"phone": "966507654321", "status": "invite_required", "jid": null}],
 "invite_link": "https://chat.whatsapp.com/AbCdEfGhIjK",
 "saved_to_contact": true}
```

**Errors:**

| Exception | HTTP | When |
|---|---|---|
| `WANotSupportedError` | 422 | The plan doesn't include WhatsApp groups |
| `WAValidationError` | 417 | An empty name or one over 100 characters, no individual number in `members`, more than 256 members, or an unknown device |
| `WAStateConflictError` | 409 | The device isn't `Connected`, or the provider didn't answer with a group JID ("The group was not created") |
| `WAPermissionError` | 403 | `contact` was given and the user lacks the elevated contact write |
| `WANotFoundError` | 404 | `contact` doesn't exist |
| Provider errors (mapped, README §5) | 4xx/5xx | The platform refused to create the group |

The group is created on WhatsApp before the contact is checked. When saving it to the contact
fails, the request is rolled back here (no `WhatsApp Number` row), but the group stays on
WhatsApp.

**Realtime:** none.

```js
const g = await whatsapp.ui.call("wa_groups.create_group", {
  device: "WA-DEV-001", name: "VIP customers",
  members: ["+966501234567", "+966507654321"], contact: "Ali Saleh",
}, { freeze: true });
```

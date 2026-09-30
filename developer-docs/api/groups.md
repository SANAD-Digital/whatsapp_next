# Contact groups API (`groups.*`)

Module: `whatsapp_next/api/v1/groups.py` — the contact group editor window
(`whatsapp_next.groups.open`, `public/js/screens/groups.js`). Thin wrappers over
`whatsapp_next/services/groups_editor.py`.

URL form, authentication, the error envelope and the role groups are in [README.md](README.md).
Every endpoint also answers **403** (`WAPermissionError` / `PermissionError`) for a missing role or
document permission, and **417** (`WAValidationError`) for an unknown, missing or untypeable
argument. Returns are shown as the value of the response's `message` key.

Members are not returned here: the window pages them through
[`picker.get_group_members`](picker.md) and picks new ones with the ContactPicker in local mode
(nothing is written until `save_editor`).

---

## get_editor

What the window opens with.

- **Path:** `whatsapp_next.api.v1.groups.get_editor`
- **Methods:** GET, POST
- **Roles:** `VIEWER_UP + CONTACT_USER`, plus **read** on the group (or **create** for a new one)

| Argument | Type | Required | Meaning |
|---|---|---|---|
| `name` | str | optional | A `WhatsApp Contact Group`; omitted → a new group's defaults. |

Returns `{group: {name, group_name, kind, description, disabled, member_count, source, modified},
kinds: [str], can_write: bool}`. `name` and `modified` are `null` for a new group; `kinds` are the
`kind` Select options. Unknown group → `WANotFoundError`.

## save_editor

Create or update the group and apply the member changes, in one request: a failure leaves nothing
half-written.

- **Path:** `whatsapp_next.api.v1.groups.save_editor`
- **Methods:** POST
- **Roles:** `AGENT_UP + CONTACT_USER`, plus **create** (new) or **write** (existing) on the group

| Argument | Type | Required | Meaning |
|---|---|---|---|
| `payload` | dict | yes | See below. |

`payload` keys — any other key is ignored:

| Key | Meaning |
|---|---|
| `name` | The group being edited; omitted → create. |
| `modified` | The `modified` the window opened with; a different value on the server → `WAValidationError` ("someone else saved this group"). |
| `group_name` | Required. A changed name renames the group; a name already taken → `WAValidationError`. |
| `kind`, `description`, `disabled` | The group's own fields. |
| `add` | Picker rows (`{phone, phone_e164, display_name, contact, source_type, source_doctype, source_name}`) to add. |
| `remove` | E.164 keys of members to remove. |

Behaviour:

1. The group is created (`source` = `Picker` when rows are added, else `Manual`) or saved, then renamed if needed.
2. `remove` runs through `picker.commit_remove`, then `add` through `picker.commit_add`, one call
   per `(source_type, source_name)` so the audit log says where each batch came from.
   Numbers already in the group or invalid are skipped, not errors.
3. At most 20,000 rows in `add` and in `remove`.

Returns `{name, modified, added, removed, skipped}`.

# Numbers API (`numbers.*`)

Module: `whatsapp_next/api/v1/numbers.py` — the WhatsApp Numbers screen, over the materialized
`WhatsApp Number` table (one row per E.164 number, group JID or LID the site has talked to).
Contact access goes through the contextual permission layer in `services/permissions.py`; nothing
here writes core `Contact` directly.

URL form, authentication, the error envelope, the role groups (`VIEWER_UP`, `AGENT_UP`,
`MANAGER`, `CONTACT_USER`) and the `names[]` bulk result shape are described once in
[README.md](README.md). Every endpoint below also answers:

- **403** `WAPermissionError` when the caller holds none of the listed roles;
- **417** `WAValidationError` for an unknown argument, a missing required argument, or a value
  that cannot be coerced to the declared type (`api/_common.py`).

Returns are shown as the value of the response's `message` key.

**The key.** Every `phone_e164` argument is passed through `services.phone.classify`: an E.164
number (any format `phone.normalize` accepts), a group JID (`…@g.us`) or a LID JID. The row key is
the normalized value.

**"Contact User | Contact <ptype>"** means: the caller holds `WhatsApp Contact User`, **or** has
native `<ptype>` permission on `Contact` (`permissions.can_elevate`). These endpoints use
`roles=None` in the decorator and check inside; a refusal is `WAPermissionError` (403,
"Not permitted to <ptype> contacts").

---

## get_number

Read one number row plus a summary of its linked contact.

- **Path:** `whatsapp_next.api.v1.numbers.get_number`
- **Methods:** GET, POST
- **Roles:** `VIEWER_UP` + `WhatsApp Contact User`

| Argument | Type | Required | Meaning |
|---|---|---|---|
| `phone_e164` | str | yes | Number, group JID or LID. |

**Returns** — the `WhatsApp Number` fields plus `contact_summary`:

```json
{
  "name": "+966500000002",
  "phone_e164": "+966500000002",
  "jid": null,
  "number_type": "Individual",
  "display_name": "Ahmed",
  "contact": "Ahmed Ali",
  "link_status": "Linked",
  "linked_by": "agent@example.com",
  "linked_at": "2026-09-22 10:03:11",
  "first_seen": "2026-09-01 08:00:00",
  "last_seen": "2026-09-22 10:00:00",
  "last_direction": "Inbound",
  "last_device": "WAD-0001",
  "outbound_count": 12,
  "inbound_count": 7,
  "conversation_confirmed": 1,
  "conversation_confirmed_by": "agent@example.com",
  "conversation_confirmed_at": "2026-09-22 10:05:00",
  "conversation_note": "Asked for a statement",
  "modified": "2026-09-22 10:05:00",
  "contact_summary": { "name": "Ahmed Ali", "full_name": "Ahmed Ali", "phone_nos": [], "links": [], "has_whatsapp": 1, "blacklisted": 0 }
}
```

`contact_summary` is `null` when the number has no contact or the caller cannot read contacts
(`can_elevate("read")` false). When present it is the same shape as
[`contacts.get_contact`](contacts.md#get_contact) without `numbers` (declared READ field set,
`phone_nos[]`, `links[]`, number counters, `blacklisted`). A Contact User's read is audited
`Elevated Contact Read`.

**Errors:** `WANotFoundError` (404) — the key does not classify or no such row.

**Realtime:** none.

```bash
curl -G "https://site/api/method/whatsapp_next.api.v1.numbers.get_number" \
  -H "Authorization: token <api_key>:<api_secret>" \
  --data-urlencode "phone_e164=+966500000002"
```

---

## search_numbers

Page through number rows by text and link status (used by Quick Send and the picker).

- **Path:** `whatsapp_next.api.v1.numbers.search_numbers`
- **Methods:** GET, POST
- **Roles:** `VIEWER_UP` + `WhatsApp Contact User`

| Argument | Type | Required / default | Meaning |
|---|---|---|---|
| `txt` | str | optional | `LIKE %txt%` on `phone_e164` **or** `display_name`. |
| `link_status` | str | optional | `Linked` or `Not Linked` (enum-checked). |
| `page` | int | `1` | 1-based page. |
| `page_length` | int | `20` | Capped at 200. |

**Returns**

```json
{
  "rows": [
    {
      "name": "+966500000002", "phone_e164": "+966500000002", "number_type": "Individual",
      "display_name": "Ahmed", "contact": null, "link_status": "Not Linked",
      "last_seen": "2026-09-22 10:00:00", "outbound_count": 3, "inbound_count": 1,
      "conversation_confirmed": 0
    }
  ],
  "total": 1
}
```

Ordered `last_seen desc, name asc`. `total` counts every match, not just the page.

**Errors:** 417 for a `link_status` outside the enum.

**Realtime:** none.

```js
const { rows, total } = await sanad.ui.call("numbers.search_numbers", { txt: "5000", link_status: "Not Linked" });
```

---

## link_number

Link a number to an existing Contact.

- **Path:** `whatsapp_next.api.v1.numbers.link_number`
- **Methods:** POST
- **Roles:** decorator `roles=None`; gate is Contact User | Contact **write**

| Argument | Type | Required | Meaning |
|---|---|---|---|
| `phone_e164` | str | yes | Number, group JID or LID. |
| `contact` | str | yes | `Contact.name`. |

Writes `contact`, `link_status = "Linked"`, `linked_by`, `linked_at` and `display_name` (the
contact's `full_name`, else the number's current display name). Audited `Number Linked`.
Re-linking an already linked number simply overwrites the link.

**Returns**

```json
{ "contact": "Ahmed Ali", "link_status": "Linked" }
```

**Errors**

| Exception | HTTP | When |
|---|---|---|
| `WAPermissionError` | 403 | Not a Contact User and no Contact write. |
| `WANotFoundError` | 404 | Number key unknown, or `contact` does not exist. |

**Realtime:** none.

```bash
curl -X POST "https://site/api/method/whatsapp_next.api.v1.numbers.link_number" \
  -H "Authorization: token <api_key>:<api_secret>" \
  -d phone_e164=+966500000002 -d contact="Ahmed Ali"
```

---

## convert_number

Create a Contact from a number (its phone row, optional party link) and link the number to it.

- **Path:** `whatsapp_next.api.v1.numbers.convert_number`
- **Methods:** POST
- **Roles:** `roles=None`; gate is Contact User | Contact **create** (the link step also needs
  write, which the contextual role grants)

| Argument | Type | Required | Meaning |
|---|---|---|---|
| `phone_e164` | str | yes | Must classify as an **Individual** number. |
| `first_name` | str | yes | Contact first name. |
| `last_name` | str | optional | |
| `party_type` | str | optional | `Customer`, `Supplier`, `Employee` or `Sales Person`. |
| `party_name` | str | optional | Name of the party record (must exist). |

The Contact gets one `phone_nos` row (`phone` = the key, `is_primary_mobile_no = 1`). Audited
`Elevated Contact Write`, `Number Linked` and `Number Converted`.

**Returns**

```json
{ "contact": "Ahmed Ali", "link_status": "Linked" }
```

**Errors**

| Exception | HTTP | When |
|---|---|---|
| `WAPermissionError` | 403 | No create permission. |
| `WANotFoundError` | 404 | Number unknown, or not an individual number (group / LID). |
| `WAStateConflictError` | 409 | The number is already linked to a contact. |
| `WAValidationError` | 417 | Unsupported `party_type`, or `party_name` not found. |

**Realtime:** none.

```js
await sanad.ui.call("numbers.convert_number", {
  phone_e164: "+966500000002", first_name: "Ahmed", last_name: "Ali",
  party_type: "Customer", party_name: "CUST-0001",
});
```

---

## convert_many

Bulk convert: create a Contact for every unlinked individual number.

- **Path:** `whatsapp_next.api.v1.numbers.convert_many`
- **Methods:** POST
- **Roles:** `roles=None`; gate is Contact User | Contact **create**

| Argument | Type | Required | Meaning |
|---|---|---|---|
| `phone_e164s` | list[str] | yes | Keys to convert (JSON list). Duplicates and empty values are ignored. |

Each number becomes a Contact whose `first_name` is the number's `display_name` (trimmed), or
the key itself when there is no display name. Each row runs in its own savepoint (`_bulk.run_bulk`).

**Returns** — the bulk shape:

```json
{
  "count": 1,
  "done": ["+966500000002"],
  "failed": [{ "name": "+966500000009", "error": "WhatsApp Number +966500000009 not found" }],
  "skipped": [{ "name": "+966500000003", "reason": "already linked" }]
}
```

`skipped.reason` is `already linked` or `not an individual number`.

**Errors:** 403 without create permission (aborts the whole call). Per-row failures are reported
in `failed`, never raised.

**Realtime:** none.

```js
await sanad.ui.call("numbers.convert_many", { phone_e164s: ["+966500000002", "+966500000003"] });
```

---

## unlink_number

Detach a number from its Contact. The Contact itself is not touched.

- **Path:** `whatsapp_next.api.v1.numbers.unlink_number`
- **Methods:** POST
- **Roles:** `MANAGER`

| Argument | Type | Required | Meaning |
|---|---|---|---|
| `phone_e164` | str | yes | Number, group JID or LID. |

Clears `contact`, `linked_by`, `linked_at`; sets `link_status = "Not Linked"`. Audited
`Number Linked` with `details.unlinked = 1`. Calling it on an already unlinked number succeeds.

**Returns**

```json
{ "link_status": "Not Linked" }
```

**Errors:** `WANotFoundError` (404) — number unknown.

**Realtime:** none.

```bash
curl -X POST "https://site/api/method/whatsapp_next.api.v1.numbers.unlink_number" \
  -H "Authorization: token <api_key>:<api_secret>" -d phone_e164=+966500000002
```

---

## confirm_conversation

Mark or unmark a number as a confirmed conversation.

- **Path:** `whatsapp_next.api.v1.numbers.confirm_conversation`
- **Methods:** POST
- **Roles:** `AGENT_UP`

| Argument | Type | Required | Meaning |
|---|---|---|---|
| `phone_e164` | str | yes | Number, group JID or LID. |
| `confirmed` | bool | yes | `1/true/yes/on` or `0/false/no/off`. |
| `note` | str | optional | Stored in `conversation_note` (first 500 characters) and the audit `reason`. |

Sets `conversation_confirmed`, and `conversation_confirmed_by` / `_at` to the caller and now
(cleared when `confirmed` is false). The note is overwritten on every call (an omitted note
clears it). Audited `Conversation Confirmed` with `details.confirmed`.

**Returns**

```json
{ "conversation_confirmed": true }
```

**Errors:** `WANotFoundError` (404) — number unknown.

**Realtime:** none.

```js
await sanad.ui.call("numbers.confirm_conversation", { phone_e164: "+966500000002", confirmed: 1, note: "Asked for a statement" });
```

---

## get_conversation_log

The number's confirm / unconfirm history, newest first (from its `Conversation Confirmed` audit
rows; never the IP address or the raw row).

- **Path:** `whatsapp_next.api.v1.numbers.get_conversation_log`
- **Methods:** GET, POST
- **Roles:** `roles=None`; gate is Contact User | Contact **read**

| Argument | Type | Required | Meaning |
|---|---|---|---|
| `phone_e164` | str | yes | Number, group JID or LID. |

**Returns** — up to 50 rows:

```json
{
  "rows": [
    { "at": "2026-09-22 10:05:00", "user": "agent@example.com", "user_name": "Sara Agent", "confirmed": true, "note": "Asked for a statement" }
  ]
}
```

**Errors:** 403 without read; `WANotFoundError` (404) — number unknown.

**Realtime:** none.

```js
const { rows } = await sanad.ui.call("numbers.get_conversation_log", { phone_e164: "+966500000002" });
```

# Contacts API (`contacts.*`)

Module: `whatsapp_next/api/v1/contacts.py` — the product Contacts screen. Every endpoint is a thin
wrapper over `services/permissions.py`, the **contextual permission layer**: a user with the
`WhatsApp Contact User` role has no rows in the core `Contact` permission matrix and reaches
Contact only through these functions, which

1. read and write **declared field sets only** (module constants, never client-supplied),
2. filter in the query, never only in the view,
3. audit every elevated access under the real session user (`Elevated Contact Read` /
   `Elevated Contact Write`; reads are audited only for users acting through the contextual role).

URL form, authentication, the error envelope, the role groups and the `names[]` bulk result shape
are in [README.md](README.md). Every endpoint also answers **403** (`WAPermissionError`) when the
gate fails and **417** (`WAValidationError`) for an unknown, missing or untypeable argument.
Returns are shown as the value of the response's `message` key.

**Gate "Contact User | Contact <ptype>"**: the decorator uses `roles=None`; inside,
`permissions.require(ptype)` passes when the caller holds `WhatsApp Contact User` **or** has native
`<ptype>` on `Contact`. Otherwise 403 "Not permitted to <ptype> contacts".

**Declared field sets** (`services/permissions.py`)

| Set | Fields |
|---|---|
| Contact READ | `name, first_name, last_name, full_name, salutation, designation, company_name, email_id, image, status, modified` |
| Phone READ (`phone_nos[]`) | `phone, is_primary_mobile_no, is_primary_phone, wa_phone_e164` |
| Link READ (`links[]`) | `link_doctype, link_name, link_title` — party types only |
| Contact WRITE | `first_name, last_name, salutation, designation, company_name, email_id` |
| Phone WRITE | `phone, is_primary_mobile_no` |
| Link WRITE | `link_doctype, link_name` |
| Party types | `Customer, Supplier, Employee, Sales Person` |

**Contact row** (returned by `list_contacts` and `get_contact`): the READ fields plus
`phone_nos[]`, `links[]`, `blacklisted` (0/1: any phone in the global blacklist group) and
`has_whatsapp`. When at least one phone matches a `WhatsApp Number` row, the row also carries
`last_seen`, `last_direction` (from the most recently seen number), `outbound_count`,
`inbound_count` (summed) and `conversation_confirmed` (max).

---

## list_contacts

One page of the Contacts screen.

- **Path:** `whatsapp_next.api.v1.contacts.list_contacts`
- **Methods:** GET, POST
- **Roles:** Contact User | Contact **read**

| Argument | Type | Required / default | Meaning |
|---|---|---|---|
| `search` | str | optional | `full_name` or `email_id` LIKE, or a phone (`Contact Phone.phone` LIKE / `wa_phone_e164` LIKE on the normalized digits). |
| `link_doctype` | str | optional | Only contacts linked to this party type (one of the four). |
| `link_name` | str | optional | With `link_doctype`: only contacts linked to this party. |
| `has_whatsapp` | bool | optional | True: at least one phone exists in `WhatsApp Number`; false: none. An empty string means "no filter". |
| `blacklisted` | bool | optional | True: a phone is in the global blacklist group; false: none is. With no blacklist group configured, `true` matches nothing. |
| `linked` | bool | optional | True: tied to at least one party; false: to none. |
| `status` | str | optional | Contact `status` equals this value. |
| `page` | int | `1` | |
| `page_length` | int | `20` | Capped at 200. |
| `order_by` | str | `"modified desc"` | `<field> [asc\|desc]`, field from the Contact READ set. |

**Returns**

```json
{
  "rows": [
    {
      "name": "Ahmed Ali", "first_name": "Ahmed", "last_name": "Ali", "full_name": "Ahmed Ali",
      "salutation": null, "designation": null, "company_name": null, "email_id": null,
      "image": null, "status": "Passive", "modified": "2026-09-22 10:00:00",
      "phone_nos": [{ "phone": "+966500000002", "is_primary_mobile_no": 1, "is_primary_phone": 0, "wa_phone_e164": "+966500000002" }],
      "links": [{ "link_doctype": "Customer", "link_name": "CUST-0001", "link_title": "Ahmed Trading" }],
      "has_whatsapp": 1, "last_seen": "2026-09-22 10:00:00", "last_direction": "Inbound",
      "outbound_count": 12, "inbound_count": 7, "conversation_confirmed": 1,
      "blacklisted": 0
    }
  ],
  "total": 1,
  "page": 1,
  "page_length": 20
}
```

**Errors:** 417 `Cannot order by …` for an `order_by` outside the READ set; 417
`Unsupported party type …` for another `link_doctype`.

**Realtime:** none.

```js
const page = await sanad.ui.call("contacts.list_contacts", { search: "Ahmed", has_whatsapp: 1, page: 1 });
```

---

## get_stats

The Contacts screen's metric row, counted through the same filtered query the list uses (one
audit row).

- **Path:** `whatsapp_next.api.v1.contacts.get_stats`
- **Methods:** GET, POST
- **Roles:** Contact User | Contact **read**

No arguments.

**Returns**

```json
{ "total": 120, "linked": 80, "multi_linked": 4, "with_whatsapp": 95, "blacklisted": 2, "unlinked": 40 }
```

`linked` = contacts with at least one party link, `multi_linked` = more than one, `unlinked` =
`total − linked`.

**Realtime:** none.

```bash
curl "https://site/api/method/whatsapp_next.api.v1.contacts.get_stats" -H "Authorization: token <api_key>:<api_secret>"
```

---

## get_contact

One contact through the READ sets.

- **Path:** `whatsapp_next.api.v1.contacts.get_contact`
- **Methods:** GET, POST
- **Roles:** Contact User | Contact **read**

| Argument | Type | Required | Meaning |
|---|---|---|---|
| `name` | str | yes | `Contact.name`. |

**Returns** — a contact row (see above) plus `numbers`: the contact's `wa_phone_e164` values,
primary mobile first.

```json
{ "name": "Ahmed Ali", "full_name": "Ahmed Ali", "phone_nos": [], "links": [], "has_whatsapp": 0, "blacklisted": 0, "numbers": ["+966500000002"] }
```

**Errors:** `WANotFoundError` (404) — no such contact.

**Realtime:** none.

```js
const c = await sanad.ui.call("contacts.get_contact", { name: "Ahmed Ali" });
```

---

## create_contact

Insert a Contact from the WRITE sets, as the session user.

- **Path:** `whatsapp_next.api.v1.contacts.create_contact`
- **Methods:** POST
- **Roles:** Contact User | Contact **create**

| Argument | Type | Required | Meaning |
|---|---|---|---|
| `payload` | dict | yes | Keys limited to the Contact WRITE set plus `phone_nos` and `links`. |

Payload rules:

- `first_name` is required.
- `phone_nos`: list of `{phone, is_primary_mobile_no?}`; every `phone` must normalize. When no
  row is primary, the first one becomes primary.
- `links`: list of `{link_doctype, link_name}`; `link_doctype` one of the four party types and the
  party must exist.
- Any other key (top level or inside a row) is refused.

Audited `Elevated Contact Write` (`reason = create`, fields written).

**Returns**

```json
{ "name": "Ahmed Ali" }
```

**Errors**

| Exception | HTTP | When |
|---|---|---|
| `WAValidationError` | 417 | `payload must be an object`; unknown field; `first_name is required`; `phone_nos[i]: invalid phone number`; `links[i]: unsupported party type` / `not found`. |
| `WAPermissionError` | 403 | No create permission. |

**Realtime:** none.

```bash
curl -X POST "https://site/api/method/whatsapp_next.api.v1.contacts.create_contact" \
  -H "Authorization: token <api_key>:<api_secret>" -H "Content-Type: application/json" \
  -d '{"payload": {"first_name": "Ahmed", "last_name": "Ali",
       "phone_nos": [{"phone": "0500000002", "is_primary_mobile_no": 1}],
       "links": [{"link_doctype": "Customer", "link_name": "CUST-0001"}]}}'
```

---

## update_contact

Partial update with the same payload shape. `phone_nos` / `links`, when present, replace the
existing rows as a set (links to non-party DocTypes are kept).

- **Path:** `whatsapp_next.api.v1.contacts.update_contact`
- **Methods:** POST
- **Roles:** Contact User | Contact **write**

| Argument | Type | Required | Meaning |
|---|---|---|---|
| `name` | str | yes | `Contact.name`. |
| `payload` | dict | yes | Same rules as `create_contact` (`first_name` not required). |

Audited `Elevated Contact Write` with the fields that actually changed; nothing is saved when
nothing changed.

**Returns**

```json
{ "name": "Ahmed Ali", "fields_written": ["designation", "phone_nos"] }
```

`fields_written` is the **sorted list of the payload's keys**, not the subset that actually
changed (the audit row holds the latter).

**Errors:** `WANotFoundError` (404) — contact missing; `WAValidationError` (417) — as in create.

**Realtime:** none.

```js
await sanad.ui.call("contacts.update_contact", { name: "Ahmed Ali", payload: { designation: "Buyer" } });
```

---

## search_party

`{name, title}` rows of one party DocType, for the contact form's link picker.

- **Path:** `whatsapp_next.api.v1.contacts.search_party`
- **Methods:** GET, POST
- **Roles:** Contact User | Contact **read**

| Argument | Type | Required / default | Meaning |
|---|---|---|---|
| `party_type` | str | yes | `Customer`, `Supplier`, `Employee` or `Sales Person`. |
| `txt` | str | optional | LIKE on `name` or the DocType's title field. |
| `page` | int | `1` | |
| `page_length` | int | `20` | Capped at 200. |

Disabled parties are excluded (`disabled = 0` when the field exists); Employees are limited to
`status = Active`. The read ignores DocType permissions but returns only `name` and the title.

**Returns**

```json
[{ "name": "CUST-0001", "title": "Ahmed Trading" }]
```

**Errors:** 417 `Unsupported party type`.

**Realtime:** none.

```js
const rows = await sanad.ui.call("contacts.search_party", { party_type: "Customer", txt: "Ahmed" });
```

---

## search_company

The site's companies for the contact form's Company field (`name` and `company_name` only).

- **Path:** `whatsapp_next.api.v1.contacts.search_company`
- **Methods:** GET, POST
- **Roles:** Contact User | Contact **read**

| Argument | Type | Required / default | Meaning |
|---|---|---|---|
| `txt` | str | optional | LIKE on `company_name`. |
| `page_length` | int | `20` | Clamped to 1–50 here (the decorator's 200 cap applies first). |

**Returns**

```json
[{ "name": "Sanad", "title": "Sanad Digital" }]
```

**Realtime:** none.

```js
const rows = await sanad.ui.call("contacts.search_company", { txt: "San" });
```

---

## get_activity

What happened to one contact, newest first, for the drawer's activity timeline.

- **Path:** `whatsapp_next.api.v1.contacts.get_activity`
- **Methods:** GET, POST
- **Roles:** Contact User | Contact **read**

| Argument | Type | Required | Meaning |
|---|---|---|---|
| `name` | str | yes | `Contact.name`. |

Collects `WhatsApp Audit Log` rows whose `reference_name` or `target_name` equals the contact,
whose `reference_name` is one of the contact's numbers, and the blacklist changes
(`Contact Group Members Changed`) whose `details.key` is one of its numbers. De-duplicated, at most
30 rows.

**Returns**

```json
[
  { "action": "Conversation Confirmed", "summary": "Conversation Confirmed", "reason": "Asked for a statement",
    "user": "agent@example.com", "timestamp": "2026-09-22 10:05:00", "blocked": null, "confirmed": true }
]
```

`summary` falls back to `action`; `blocked` / `confirmed` come from the audit row's `details`.
The IP address is never returned.

**Realtime:** none.

```js
const events = await sanad.ui.call("contacts.get_activity", { name: "Ahmed Ali" });
```

---

## toggle_blacklist

Add a number to, or remove it from, the **global blacklist group** (`WhatsApp Settings.global_blacklist_group`).

- **Path:** `whatsapp_next.api.v1.contacts.toggle_blacklist`
- **Methods:** POST
- **Roles:** `WhatsApp Contact User` + `AGENT_UP`; additionally **write** on `WhatsApp Contact Group`

| Argument | Type | Required | Meaning |
|---|---|---|---|
| `blocked` | bool | yes | True = add, false = remove. |
| `contact` | str | optional | Used when `phone` is empty: the contact's first `wa_phone_e164` (primary first). |
| `phone` | str | optional | Number or JID to toggle. |
| `note` | str | optional | Stored on the member row and as the audit `reason`. |

Idempotent: when the number is already in the requested state nothing is written. Otherwise the
group is saved and audited `Contact Group Members Changed` with `details {blocked, key}`.

**Returns**

```json
{ "blocked": true }
```

**Errors**

| Exception | HTTP | When |
|---|---|---|
| `WAValidationError` | 417 | Neither `phone` nor a contact with a phone; the value is not a valid number / JID. |
| `WAPermissionError` | 403 | No write on `WhatsApp Contact Group`. |
| `WAStateConflictError` | 409 | No global blacklist group configured in WhatsApp Settings. |

**Realtime:** none.

```js
await sanad.ui.call("contacts.toggle_blacklist", { contact: "Ahmed Ali", blocked: 1, note: "Asked to stop" });
```

---

## get_contact_numbers

WhatsApp activity of the contact's phones that exist in `WhatsApp Number`.

- **Path:** `whatsapp_next.api.v1.contacts.get_contact_numbers`
- **Methods:** GET, POST
- **Roles:** Contact User | Contact **read**

| Argument | Type | Required | Meaning |
|---|---|---|---|
| `contact` | str | yes | `Contact.name`. |

**Returns** — ordered `last_seen desc`; `[]` when the contact has no normalized phone.

```json
[{ "phone_e164": "+966500000002", "last_seen": "2026-09-22 10:00:00", "outbound_count": 12, "inbound_count": 7, "conversation_confirmed": 1 }]
```

**Realtime:** none.

```js
const nums = await sanad.ui.call("contacts.get_contact_numbers", { contact: "Ahmed Ali" });
```

---

## link_many

Bulk: add one party link to every contact in `names`.

- **Path:** `whatsapp_next.api.v1.contacts.link_many`
- **Methods:** POST
- **Roles:** Contact User | Contact **write**

| Argument | Type | Required | Meaning |
|---|---|---|---|
| `names` | list[str] | yes | Contact names. |
| `link_doctype` | str | yes | One of the four party types. |
| `link_name` | str | yes | Existing party. |

Each contact goes through `update_contact` (audited per contact), in its own savepoint.

**Returns** — the bulk shape; contacts that already carry the link are `skipped` with reason
`already linked`; a missing contact or an invalid party appears in `failed`.

```json
{ "count": 2, "done": ["Ahmed Ali", "Sara Omar"], "failed": [], "skipped": [{ "name": "Ali Saad", "reason": "already linked" }] }
```

**Errors:** 403 without write (aborts the whole call).

**Realtime:** none.

```js
await sanad.ui.call("contacts.link_many", { names: ["Ahmed Ali", "Sara Omar"], link_doctype: "Customer", link_name: "CUST-0001" });
```

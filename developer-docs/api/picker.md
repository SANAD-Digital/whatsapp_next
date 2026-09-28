# Contact Picker API (`picker.*`)

Module: `whatsapp_next/api/v1/picker.py`, thin wrappers over `whatsapp_next/services/picker.py`.
The ContactPicker component uses these endpoints to collect phone numbers from six sources and add
them to, or remove them from, a **target document**: a campaign's recipients or a contact group's
members.

URL form, authentication, the error envelope and the role groups are in [README.md](README.md).
Every endpoint also answers **403** (`WAPermissionError`) for a missing role and **417**
(`WAValidationError`) for an unknown, missing or untypeable argument. Returns are shown as the
value of the response's `message` key.

**Roles.** The source endpoints and `classify` require `PICKER_ROLES` = `AGENT_UP` +
`WhatsApp Contact User` (Agent, Manager, System Manager, Contact User). `preview`, `commit_add`
and `commit_remove` use `roles=None` and require **write permission on the target document**.

## Concepts

### The picker row

Every source returns rows of one shape (`services.picker.make_row`):

| Field | Meaning |
|---|---|
| `phone` | The raw value as found in the source. |
| `phone_e164` | Normalized key: E.164 for an individual, the JID for a group / LID; `null` when invalid. |
| `display_name` | Name from the source, trimmed. |
| `contact` | Linked `Contact`, when the source knows it. |
| `source_type` | `Contact Group`, `Contact`, `DocType`, `Excel`, `vCard` or `Manual`. |
| `source_doctype`, `source_name` | Record the row came from (group, contact, DocType row). |
| `valid` | False when the phone is missing or does not normalize. |
| `error` | `Invalid phone number`, `Missing phone number`, `Contact has no phone number`, `No phone number` (vCard). |
| `recipient_type` | Present and `"Group"` only when the key is a group / LID JID. |

Duplicates are decided on `phone_e164` only.

### The six sources

| # | `key` in `list_sources` | Endpoint(s) | What it reads |
|---|---|---|---|
| 1 | `Contact Group` | `search_groups`, `get_group_members` | Enabled `WhatsApp Contact Group` rows and their members (read permission on the group). |
| 2 | `Contact` | `search_contacts` | Contacts through the contextual permission layer, one row per contact (primary WhatsApp phone). |
| 3 | `DocType` | `list_doctype_rows` | Rows of a DocType enabled in **WhatsApp Settings → Picker Sources**, with the server filters of that source merged in. |
| 4 | `Excel` | `parse_upload(kind="excel")` | First sheet of a private `.xlsx` you uploaded; first row = headers. |
| 5 | `vCard` | `parse_upload(kind="vcf" \| "csv")` | A phone export: vCard (`FN` + every `TEL`) or CSV with headers. |
| 6 | `Manual` | `parse_manual` | Pasted text, one entry per line. |

### The add / remove commit flow

1. **Collect** rows from any source (the client may mix sources).
2. **Classify** them:
   - with a saved target: `preview(target_doctype, target_name, rows)`;
   - without one (the host keeps its own list, e.g. an alert's recipients): `classify(rows, existing)`.
   Both return `{available[], already_added[], invalid[], duplicates_in_selection[], known_count}`.
3. **Commit** with `commit_add(target_doctype, target_name, rows, source_type, source_ref)`. The
   server re-runs the preview, appends only the `available` rows in one save, and audits
   `Campaign Recipients Changed` or `Contact Group Members Changed` with the counts. On a
   `Running` / `Paused` campaign a `long` job (`campaign_runner.materialize_pending`) materializes
   the new recipients into outbound messages.
4. **Remove** with `commit_remove(target_doctype, target_name, phone_e164s | filters)`. Group
   member rows are deleted. Campaign rows of a `Running`, `Paused` or `Queued` campaign become
   `Removed` (their `Queued` / `Paused` queue items are set to `Deleted` and the outbound rows to
   `Cancelled`); rows of a `Draft` / `Scheduled` campaign are deleted.

A campaign in `Completed`, `Partially Failed` or `Cancelled` refuses both commits with
`WAStateConflictError` (409).

Targets (`services.picker.TARGETS`):

| `target_doctype` | Child table |
|---|---|
| `WhatsApp Campaign` | `recipients` (`WhatsApp Campaign Recipient`) |
| `WhatsApp Contact Group` | `members` (`WhatsApp Contact Group Member`) |

---

## list_sources

The six sources with their enablement.

- **Path:** `whatsapp_next.api.v1.picker.list_sources`
- **Methods:** GET, POST
- **Roles:** `PICKER_ROLES`

| Argument | Type | Required | Meaning |
|---|---|---|---|
| `target_doctype` | str | optional | Accepted; not used by the service. |

**Returns**

```json
[
  { "key": "Contact Group", "label": "Contact Groups", "enabled": true },
  { "key": "Contact", "label": "Contacts", "enabled": true, "link_doctypes": ["Customer", "Supplier", "Employee"] },
  { "key": "DocType", "label": "System screen", "enabled": true, "doctypes": [{ "document_type": "Customer", "label": "Customers" }] },
  { "key": "Excel", "label": "Excel upload", "enabled": true, "kinds": ["excel"] },
  { "key": "vCard", "label": "Phone export (vCard / CSV)", "enabled": true, "kinds": ["vcf", "csv"] },
  { "key": "Manual", "label": "Manual entry", "enabled": true }
]
```

Labels are translated. `DocType.enabled` is false when no Picker Source is enabled.
`link_doctypes` lists those of `Customer, Supplier, Employee, Sales Partner, Lead` installed on the
site (chips for source 2).

**Realtime:** none.

```js
const sources = await sanad.ui.call("picker.list_sources");
```

---

## search_groups

Source 1: enabled contact groups by name.

- **Path:** `whatsapp_next.api.v1.picker.search_groups`
- **Methods:** GET, POST
- **Roles:** `PICKER_ROLES`

| Argument | Type | Required / default | Meaning |
|---|---|---|---|
| `txt` | str | optional | LIKE on `group_name`. |
| `kind` | str | optional | Group kind (`Marketing`, `Mailing List`, `Professional`, `Blacklist`, `Other`). Not enum-checked. |
| `exclude` | str | optional | A group name to leave out (the target group itself). |
| `page` | int | `1` | |
| `page_length` | int | `20` | Capped at 200. |

**Returns**

```json
{ "rows": [{ "name": "VIP", "group_name": "VIP", "kind": "Marketing", "member_count": 42, "description": null }], "total": 1 }
```

Read with the caller's permissions on `WhatsApp Contact Group`.

**Realtime:** none.

```js
const { rows } = await sanad.ui.call("picker.search_groups", { txt: "VIP", exclude: "Blacklist" });
```

---

## get_group_members

Source 1: members of one group as picker rows.

- **Path:** `whatsapp_next.api.v1.picker.get_group_members`
- **Methods:** GET, POST
- **Roles:** `PICKER_ROLES` + read on that group

| Argument | Type | Required / default | Meaning |
|---|---|---|---|
| `group` | str | yes | `WhatsApp Contact Group` name. |
| `page` | int | `1` | |
| `page_length` | int | `50` | Capped at 200. |

**Returns** — picker rows with `source_type = "Contact Group"`, `source_doctype =
"WhatsApp Contact Group"`, `source_name = group`, in member order:

```json
{ "rows": [{ "phone": "+966500000002", "phone_e164": "+966500000002", "display_name": "Ahmed", "contact": null,
  "source_type": "Contact Group", "source_doctype": "WhatsApp Contact Group", "source_name": "VIP", "valid": true, "error": null }],
  "total": 42 }
```

**Errors:** `WAPermissionError` (403) — no read on the group.

**Realtime:** none.

```js
const { rows, total } = await sanad.ui.call("picker.get_group_members", { group: "VIP", page: 1 });
```

---

## search_contacts

Source 2: contacts through the contextual permission layer (audited for Contact Users).

- **Path:** `whatsapp_next.api.v1.picker.search_contacts`
- **Methods:** GET, POST
- **Roles:** `PICKER_ROLES`; the layer also requires Contact User | Contact **read**

| Argument | Type | Required / default | Meaning |
|---|---|---|---|
| `txt` | str | optional | Name, email or phone. |
| `link_doctype` | str | optional | Only contacts linked to this party type (`Customer`, `Supplier`, `Employee`, `Sales Person`). |
| `page` | int | `1` | |
| `page_length` | int | `20` | Capped at 200. |

**Returns** — one picker row per contact (`source_type = "Contact"`), using the primary
`wa_phone_e164` (else the first one). A contact without a normalized phone comes back
`valid: false` with `error: "Contact has no phone number"`.

```json
{ "rows": [{ "phone": "+966500000002", "phone_e164": "+966500000002", "display_name": "Ahmed Ali", "contact": "Ahmed Ali",
  "source_type": "Contact", "source_doctype": "Contact", "source_name": "Ahmed Ali", "valid": true, "error": null }], "total": 1 }
```

**Errors:** 403 without contact read; 417 for an unsupported `link_doctype`.

**Realtime:** none.

```js
const { rows } = await sanad.ui.call("picker.search_contacts", { txt: "Ahmed", link_doctype: "Customer" });
```

---

## list_doctype_rows

Source 3: rows of an enabled picker DocType.

- **Path:** `whatsapp_next.api.v1.picker.list_doctype_rows`
- **Methods:** GET, POST
- **Roles:** `PICKER_ROLES`; the layer also requires Contact User | Contact **read**

| Argument | Type | Required / default | Meaning |
|---|---|---|---|
| `document_type` | str | yes | Must be an enabled row of WhatsApp Settings → Picker Sources. |
| `filters` | list | optional | Frappe-style filters: `[field, op, value]`, `[doctype, field, op, value]` or `[field, value]`. |
| `page` | int | `1` | |
| `page_length` | int | `50` | Capped at 200. |

Every filter field must be a field of the DocType or `name, owner, creation, modified, docstatus,
idx`; operators are limited to `= != in "not in" like "not like" > < >= <= between is`; values
cannot be objects. The client filters are **merged with the source's own `filters_json`**. The
read is elevated (`ignore_permissions`) but limited to `name`, the source's name field (or the
DocType title field) and its phone: either a phone field, or the primary phone of a linked
Contact (`phone_source = "Linked Contact"`).

**Returns** — picker rows (`source_type = "DocType"`, `source_doctype = document_type`,
`source_name` = the row name) plus paging:

```json
{ "rows": [{ "phone": "0500000002", "phone_e164": "+966500000002", "display_name": "Ahmed Trading", "contact": null,
  "source_type": "DocType", "source_doctype": "Customer", "source_name": "CUST-0001", "valid": true, "error": null }],
  "total": 1, "page": 1, "page_length": 50 }
```

**Errors:** `WAPermissionError` (403) — `document_type` is not an enabled picker source;
`WAValidationError` (417) — `Invalid filters: …`.

**Realtime:** none.

```js
await sanad.ui.call("picker.list_doctype_rows", { document_type: "Customer", filters: [["customer_group", "=", "Retail"]] });
```

---

## parse_upload

Sources 4 and 5: parse a private file you uploaded.

- **Path:** `whatsapp_next.api.v1.picker.parse_upload`
- **Methods:** POST
- **Roles:** `PICKER_ROLES`

| Argument | Type | Required | Meaning |
|---|---|---|---|
| `file_url` | str | yes | URL of a **private** `File` you own (or may write). |
| `kind` | str | yes | `excel`, `csv` or `vcf` (enum-checked). |
| `mapping` | dict | optional | `{phone: <column>, name: <column>}` for Excel / CSV. |

Excel / CSV: without `mapping` the server guesses the phone column (headers matching
phone / mobile / whatsapp / tel / cell and Arabic equivalents) and the name column. When no phone
column is found the result has `needs_mapping: true`, the column list and a message in `error`;
the client asks the user and calls again with `mapping`. CSV rows carry `source_type = "vCard"`,
Excel rows `source_type = "Excel"`. vCard: one row per `TEL` of each card, `FN` as the name.

Limits: 5 MB, 20 000 rows (`MAX_UPLOAD_BYTES`, `MAX_UPLOAD_ROWS`).

**Returns**

```json
{
  "rows": [{ "phone": "0500000002", "phone_e164": "+966500000002", "display_name": "Ahmed", "contact": null,
    "source_type": "Excel", "source_doctype": null, "source_name": null, "valid": true, "error": null }],
  "invalid": [{ "phone": "12", "phone_e164": null, "display_name": "Bad", "valid": false, "error": "Invalid phone number" }],
  "columns": ["Name", "Mobile"],
  "total": 2,
  "needs_mapping": false,
  "error": null
}
```

**Errors**

| Exception | HTTP | When |
|---|---|---|
| `WAFileError` | 417 | File is public; larger than 5 MB; more than 20 000 rows; unreadable Excel / vCard; `openpyxl` / `vobject` missing. |
| `WAPermissionError` | 403 | The file is not yours and you cannot write it. |
| `WAValidationError` | 417 | `kind` outside the enum. |

**Realtime:** `wa:import:progress` to the calling user, twice:
`{kind, stage: "parsing", total: 0}` then `{kind, stage: "parsed", total, valid, invalid}`.

```js
const r = await sanad.ui.call("picker.parse_upload", { file_url: "/private/files/customers.xlsx", kind: "excel" });
if (r.needs_mapping) { /* ask, then call again with mapping: { phone: "Mobile", name: "Name" } */ }
```

---

## parse_manual

Source 6: pasted text, one entry per line.

- **Path:** `whatsapp_next.api.v1.picker.parse_manual`
- **Methods:** POST
- **Roles:** `PICKER_ROLES`

| Argument | Type | Required | Meaning |
|---|---|---|---|
| `text` | str | optional | Lines like `0500000002`, `Ahmed;0500000002`, `Ahmed,0500000002`, `Ahmed<TAB>0500000002`, `0500000002 Ahmed` or `Ahmed Ali 0500000002`. |

For a separated line the side that normalizes is the phone; for a space-separated line the first
or last token that normalizes is the phone. Blank lines are skipped.

**Returns**

```json
{ "rows": [/* valid picker rows, source_type "Manual" */], "invalid": [/* rows with valid:false */], "columns": [], "total": 2, "needs_mapping": false, "error": null }
```

**Realtime:** none.

```js
const r = await sanad.ui.call("picker.parse_manual", { text: "Ahmed;0500000002\n0500000003 Sara" });
```

---

## preview

Classify candidate rows against a saved target (nothing is written).

- **Path:** `whatsapp_next.api.v1.picker.preview`
- **Methods:** POST
- **Roles:** `roles=None`; **write** on the target document

| Argument | Type | Required | Meaning |
|---|---|---|---|
| `target_doctype` | str | yes | `WhatsApp Campaign` or `WhatsApp Contact Group`. |
| `target_name` | str | yes | The target document. |
| `rows` | list[dict] | optional | Picker rows (at least `phone_e164` or `phone`; other fields are carried). |

Rows already in the target (not `Removed`) are `already_added`; a second occurrence of a key in
the selection is `duplicates_in_selection`. `known_count` is how many `available` keys already
exist in `WhatsApp Number`.

**Returns**

```json
{ "available": [/* rows */], "already_added": [], "invalid": [], "duplicates_in_selection": [], "known_count": 1 }
```

**Errors**

| Exception | HTTP | When |
|---|---|---|
| `WAValidationError` | 417 | Unsupported target DocType; target not found. |
| `WAPermissionError` | 403 | No write on the target. |

**Realtime:** none.

```js
const p = await sanad.ui.call("picker.preview", { target_doctype: "WhatsApp Campaign", target_name: "CAMP-0001", rows });
```

---

## classify

The same classification with no target document: the host passes the keys it already holds.

- **Path:** `whatsapp_next.api.v1.picker.classify`
- **Methods:** POST
- **Roles:** `PICKER_ROLES`

| Argument | Type | Required | Meaning |
|---|---|---|---|
| `rows` | list[dict] | optional | Picker rows. |
| `existing` | list[str] | optional | E.164 keys already in the host's list (first 5 000 used). |

**Returns** — same shape as `preview`. Writes nothing.

**Realtime:** none.

```js
const p = await sanad.ui.call("picker.classify", { rows, existing: ["+966500000002"] });
```

---

## commit_add

Append the available rows to the target in one save; audited.

- **Path:** `whatsapp_next.api.v1.picker.commit_add`
- **Methods:** POST
- **Roles:** `roles=None`; **write** on the target document

| Argument | Type | Required / default | Meaning |
|---|---|---|---|
| `target_doctype` | str | yes | `WhatsApp Campaign` or `WhatsApp Contact Group`. |
| `target_name` | str | yes | |
| `rows` | list[dict] | yes | Picker rows. |
| `source_type` | str | `"Manual"` | One of the six source keys (enum-checked). Used when a row carries no `source_type`. |
| `source_ref` | str | optional | For `Contact Group`: the group name, stored in the campaign row's `contact_group`; also recorded in the audit details. |

Each new row gets `contact` from the row or, failing that, the Contact whose phone matches.
Campaign rows are added `Pending` with `added_by` / `added_at`, `recipient_type`
(`Individual` or `Group`) and the campaign's `added_count` is incremented; group rows get
`added_by` / `added_on`. Audited `Campaign Recipients Changed` or `Contact Group Members Changed`
with `{action: "add", source_type, source_ref, skipped_duplicates, skipped_invalid}`.

**Returns**

```json
{ "added": 40, "skipped_duplicates": 2, "skipped_invalid": 1 }
```

`skipped_duplicates` = already in the target + repeated in the selection.

**Errors**

| Exception | HTTP | When |
|---|---|---|
| `WAStateConflictError` | 409 | Campaign is `Completed`, `Partially Failed` or `Cancelled`. |
| `WAPermissionError` | 403 | No write on the target. |
| `WAValidationError` | 417 | Unsupported target, target not found, `source_type` outside the enum. |

**Realtime:** none directly. On a `Running` / `Paused` campaign the enqueued materialization job
creates outbound rows, whose later delivery updates arrive as `wa:message:status` /
`wa:campaign:status`.

```bash
curl -X POST "https://site/api/method/whatsapp_next.api.v1.picker.commit_add" \
  -H "Authorization: token <api_key>:<api_secret>" -H "Content-Type: application/json" \
  -d '{"target_doctype": "WhatsApp Contact Group", "target_name": "VIP",
       "rows": [{"phone": "0500000002", "display_name": "Ahmed"}], "source_type": "Manual"}'
```

---

## commit_remove

Remove rows from the target by key or by source.

- **Path:** `whatsapp_next.api.v1.picker.commit_remove`
- **Methods:** POST
- **Roles:** `roles=None`; **write** on the target document

| Argument | Type | Required | Meaning |
|---|---|---|---|
| `target_doctype` | str | yes | `WhatsApp Campaign` or `WhatsApp Contact Group`. |
| `target_name` | str | yes | |
| `phone_e164s` | list[str] | optional | Keys to remove (normalized before matching). |
| `filters` | dict | optional | `{source_type?, source_ref?}`: remove rows of that source; `source_ref` matches `source_name` or the row's `contact_group`. |

Rows already `Removed` are ignored. See the flow above for what happens on a live campaign
(`removed_by` / `removed_at` set, `removed_count` incremented). Audited with
`{action: "remove", filters: [keys of filters]}`.

**Returns**

```json
{ "removed": 3 }
```

`{"removed": 0}` when nothing matched (no audit row).

**Errors**

| Exception | HTTP | When |
|---|---|---|
| `WAStateConflictError` | 409 | Campaign is `Completed`, `Partially Failed` or `Cancelled`. |
| `WAPermissionError` | 403 | No write on the target. |
| `WAValidationError` | 417 | Unsupported target / not found. |

**Realtime:** on a live campaign, `wa:message:status` with `status: "Cancelled"` for each outbound
whose queue item was deleted.

```js
await sanad.ui.call("picker.commit_remove", {
  target_doctype: "WhatsApp Campaign", target_name: "CAMP-0001",
  filters: { source_type: "Contact Group", source_ref: "VIP" },
});
```

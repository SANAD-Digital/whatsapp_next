# Templates API (`templates.*`)

Module: `whatsapp_next/api/v1/templates.py` — the WhatsApp Template editor: sandboxed preview,
variable hints and a sample record picker. Thin wrappers over `whatsapp_next/services/templates.py`
(Frappe's sandboxed Jinja environment).

URL form, authentication, the error envelope and the role groups are in [README.md](README.md).
Every endpoint also answers **403** (`WAPermissionError`) for a missing role and **417**
(`WAValidationError`) for an unknown, missing or untypeable argument. Returns are shown as the
value of the response's `message` key.

**Render context.** A body renders with `doc` (the record, or a `frappe._dict`), `recipient`
(`{phone_e164, display_name, contact, …}`), `now`, `today`, `site_url`, `doc_url`, and Frappe's
Jinja globals (`_`, `frappe.utils`, `frappe.format_value`, …).

---

## preview

Render a body — unsaved text or a saved template's — against a record or sample data.

- **Path:** `whatsapp_next.api.v1.templates.preview`
- **Methods:** POST
- **Roles:** `AGENT_UP`

| Argument | Type | Required | Meaning |
|---|---|---|---|
| `template` | str | optional | A `WhatsApp Template` name; its `body`, `reference_doctype` and `sample_context` are used when `body` is not given. |
| `body` | str | optional | Jinja source to render (wins over `template`). |
| `reference_doctype` | str | optional | DocType of `doc` (defaults to the template's). |
| `reference_name` | str | optional | Render against this record; the caller must be able to **read** it. |
| `sample_context` | dict | optional | Extra values. Without a record it overlays sample data: a `doc` key is merged over the latest record's fields, other keys become top-level variables. With a record it is passed as extra context. |

Behaviour:

1. The source is compile-checked first; compile errors return immediately with an empty body.
2. With `reference_name` **and** a DocType: `doc` is that record (permission-checked).
3. Otherwise: `doc` is the **latest record** of the DocType (by `modified`) overlaid with
   `sample_context`, and `recipient` is a sample (`+966500000000`, "Recipient").
4. Render errors are returned, never raised.

**Returns**

```json
{ "body": "Dear Ahmed, invoice INV-0001 is due on 2026-10-01.", "errors": [] }
```

```json
{ "body": "", "errors": ["TemplateSyntaxError: unexpected '}'"] }
```

**Errors**

| Exception | HTTP | When |
|---|---|---|
| `frappe.PermissionError` | 403 | No read permission on `reference_name`. |

**Realtime:** none.

```js
const r = await sanad.ui.call("templates.preview", {
  body: "Dear {{ doc.customer_name }}, invoice {{ doc.name }} is due on {{ doc.due_date }}.",
  reference_doctype: "Sales Invoice", reference_name: "ACC-SINV-2026-00001",
});
```

---

## list_variables

Variable hints for the editor's autocomplete.

- **Path:** `whatsapp_next.api.v1.templates.list_variables`
- **Methods:** GET, POST
- **Roles:** `AGENT_UP`

| Argument | Type | Required | Meaning |
|---|---|---|---|
| `reference_doctype` | str | optional | Adds `doc.<field>` hints for this DocType. |

The list is the base names (`doc`, `recipient`, `now`, `today`, `site_url`, `doc_url`, `_`,
`frappe.utils`, `frappe.format_value`), then — for an existing DocType — `doc.name`, `doc.owner`,
`doc.creation`, `doc.modified`, every data field as `doc.<fieldname>`, and for each table field the
first 8 child fields as `doc.<table>[0].<field>`. Plain `doc.<field>` hints get the field's label
and type; the rest are `label = name`, `fieldtype = "Data"`.

**Returns**

```json
[
  { "name": "doc", "label": "doc", "fieldtype": "Data" },
  { "name": "doc.customer_name", "label": "Customer Name", "fieldtype": "Data" },
  { "name": "doc.items[0].item_code", "label": "doc.items[0].item_code", "fieldtype": "Data" }
]
```

**Realtime:** none.

```bash
curl -G "https://site/api/method/whatsapp_next.api.v1.templates.list_variables" \
  -H "Authorization: token <api_key>:<api_secret>" -d reference_doctype="Sales Invoice"
```

---

## pick_sample

The latest record of a DocType the caller may read, for "preview against a sample".

- **Path:** `whatsapp_next.api.v1.templates.pick_sample`
- **Methods:** GET, POST
- **Roles:** `AGENT_UP`

| Argument | Type | Required | Meaning |
|---|---|---|---|
| `reference_doctype` | str | yes | Any non-single DocType. |

Uses `frappe.get_list` (the caller's permissions), ordered `modified desc`.

**Returns**

```json
{ "name": "ACC-SINV-2026-00001" }
```

`{"name": null}` when the DocType does not exist, is a Single, or has no readable record.

**Realtime:** none.

```js
const { name } = await sanad.ui.call("templates.pick_sample", { reference_doctype: "Sales Invoice" });
```

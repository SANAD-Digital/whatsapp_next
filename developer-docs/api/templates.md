# Templates API (`templates.*`)

Module: `whatsapp_next/api/v1/templates.py` — the WhatsApp Template editor: sandboxed preview,
variable hints, a sample record picker, and the editor window's open / save / delete. Thin wrappers
over `whatsapp_next/services/templates.py` (Frappe's sandboxed Jinja environment) and
`whatsapp_next/services/templates_editor.py`.

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
const r = await whatsapp.ui.call("templates.preview", {
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
const { name } = await whatsapp.ui.call("templates.pick_sample", { reference_doctype: "Sales Invoice" });
```

---

## get_editor

What the template editor window (`whatsapp.ui.TemplateWindow`) opens with: the template, or the
defaults of a new one, plus the choices its controls offer.

- **Path:** `whatsapp_next.api.v1.templates.get_editor`
- **Methods:** GET, POST
- **Roles:** `AGENT_UP` | `WhatsApp Template` **read** (with `name`) or **create** (without)

| Argument | Type | Required | Meaning |
|---|---|---|---|
| `name` | str | optional | A `WhatsApp Template` name. Empty opens a new template. |

**Returns.** `template` holds `name` and the editable fields (`template_name, category,
description, message_type, disabled, body, attachment, print_format, letter_head,
file_name_template, reference_doctype, language, sample_context`), plus `use_count`,
`last_used_at` and `modified` for a saved one. `sample_context` comes back as indented JSON text.
`categories` are the distinct categories of the templates the caller can list (at most 100);
`message_types` are the `message_type` options. A new template has `name: null`,
`message_type: "Text"`, `disabled: 0`, `body: ""`, `can_write: true`, `can_delete: false`.

```json
{
  "template": { "name": "Invoice Ready", "template_name": "Invoice Ready", "category": "Billing",
    "description": null, "message_type": "Document", "disabled": 0,
    "body": "Dear {{ doc.customer_name }}, your invoice {{ doc.name }} is attached.",
    "attachment": null, "print_format": "Standard Invoice", "letter_head": null,
    "file_name_template": "{{ doc.name }}", "reference_doctype": "Sales Invoice", "language": "en",
    "sample_context": null, "use_count": 42, "last_used_at": "2026-11-08 17:20:00", "modified": "2026-11-01 09:00:00.000000" },
  "categories": ["Billing", "Sales"],
  "message_types": ["Text", "Document", "Image"],
  "can_write": true,
  "can_delete": true
}
```

**Errors**

| Exception | HTTP | When |
|---|---|---|
| `WANotFoundError` | 404 | Unknown template ("Template … not found"). |
| `frappe.PermissionError` | 403 | No read on the template, or no create permission when opening a new one. |

**Realtime:** none.

```js
const ed = await whatsapp.ui.call("templates.get_editor", { name: "Invoice Ready" });
```

---

## save_editor

Creates or updates a template from the editor's payload. Only the editable fields listed under
`get_editor` are taken; strings are trimmed (except `body` and `description`) and an empty string
becomes `null`. A file belongs to one message type only: `attachment` is cleared unless the type is
`Image`, and `print_format`, `letter_head`, `file_name_template` unless it is `Document`. The
DocType controller validates the rest (the body compiles, a `Document` template has a print
format). A changed `template_name` renames the template.

- **Path:** `whatsapp_next.api.v1.templates.save_editor`
- **Methods:** POST
- **Roles:** `MANAGER` | `WhatsApp Template` **write** (update) or **create** (new)

| Argument | Type | Required | Meaning |
|---|---|---|---|
| `payload` | dict | yes | The editable fields, plus `name` (the template being edited; omit for a new one) and `modified` (the value `get_editor` returned; guards against an edit saved elsewhere since). `template_name` is required. |

**Returns** — the template's name after any rename, and its new `modified`.

```json
{ "name": "Invoice Ready", "modified": "2026-11-09 10:12:03.441210" }
```

**Errors**

| Exception | HTTP | When |
|---|---|---|
| `WAValidationError` | 417 | `payload` is not an object; no `template_name` ("Give the template a name"); a template with the new name already exists; `modified` differs from the stored one ("Someone else saved this template after you opened it…"); a controller validation. |
| `WANotFoundError` | 404 | `name` is given but unknown. |
| `frappe.PermissionError` | 403 | No write (update) or create (new) permission. |

**Realtime:** none.

```js
const { name, modified } = await whatsapp.ui.call("templates.save_editor", {
  payload: { name: "Invoice Ready", modified: ed.template.modified, template_name: "Invoice Ready",
             message_type: "Text", body: "Dear {{ doc.customer_name }}, invoice {{ doc.name }} is ready." },
});
```

---

## delete_template *(destructive)*

Deletes a template. Frappe refuses while sent messages or campaigns still link to it, and its
message names them; the window then suggests disabling the template instead.

- **Path:** `whatsapp_next.api.v1.templates.delete_template`
- **Methods:** POST
- **Roles:** `MANAGER` | `WhatsApp Template` **delete**

| Argument | Type | Required | Meaning |
|---|---|---|---|
| `name` | str | yes | `WhatsApp Template` name. |

**Returns**

```json
{ "deleted": true }
```

**Errors**

| Exception | HTTP | When |
|---|---|---|
| `WANotFoundError` | 404 | Unknown template. |
| `frappe.PermissionError` | 403 | No delete permission. |
| `frappe.LinkExistsError` | 417 | Other records still link to the template. |

**Realtime:** none.

```js
await whatsapp.ui.call("templates.delete_template", { name: "Old Reminder" });
```

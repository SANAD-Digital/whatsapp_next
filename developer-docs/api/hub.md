# hub

Module `whatsapp_next/api/v1/hub.py`. These endpoints serve the WhatsApp hub window: the
ready-made content the platform publishes (functions, message templates, commands, alerts and
notifications). Each of those screens opens the hub on its own type, shows what this site lacks
and what changed since an entry was installed, and installs or updates an entry here. They are
thin wrappers over `services/hub.py`, which reads the hub through the active provider
(`list_hub`, `get_hub_entry`).

Every endpoint needs **`MANAGER`** (WhatsApp Manager, System Manager). Installing a **function**
also needs **System Manager**, checked in the service, because a function is a Server Script that
runs code on this site.

Conventions are in [README.md](README.md). Provider exceptions are mapped as described in
README §5. A provider without a hub answers with `WANotSupportedError` (422).

### Hub types

| `hub_type` | Installs as |
|---|---|
| `Function` | `WhatsApp Function` (and its `Server Script`) |
| `Template` | `WhatsApp Template` |
| `Command` | `WhatsApp Command` |
| `Alert` | `WhatsApp Notification Alert` |
| `Notification` | `WhatsApp Notification` |

### State

A record installed from the hub keeps the entry's name and checksum (`hub_entry`,
`hub_checksum`). An entry's `state` here is:

- `not_installed`: no record here comes from the entry, and none has the name it installs as.
- `update_available`: a record here comes from the entry with another checksum, or a record
  already has the name the entry installs as (a function: its Server Script) without coming from
  the hub. Installing it brings the hub's version and links it.
- `installed`: the record here has the entry's checksum.

`local` is the name of that record here, or `null`.

### Realtime

None of these endpoints publishes a realtime event.

---

## list_entries

The hub's published entries of one type, each with its `state` here. The entry's data is not
included.

- **Path:** `whatsapp_next.api.v1.hub.list_entries`
- **Methods:** GET, POST
- **Roles:** `MANAGER`

| Argument | Type | Required / default | Meaning |
|---|---|---|---|
| `hub_type` | str | required | `Function`, `Template`, `Command`, `Alert` or `Notification` |
| `txt` | str | optional | Matches the entry's name or description. At most 100 characters. |

**Returns.** A list, sorted by `hub_name`. `target` is the record name the entry installs as (a
function's Server Script).

```json
[
  {"name": "HUB-0012", "hub_name": "Invoice reminder", "hub_type": "Template",
   "description": "Reminds the customer of an unpaid invoice", "checksum": "9b1c…",
   "modified": "2026-10-29 12:04:11.000000", "target": "Invoice reminder",
   "state": "update_available", "local": "Invoice reminder"}
]
```

**Errors:** `WAValidationError` (417) for a `hub_type` outside the list. Provider errors are mapped.
**Realtime:** none.

```js
const rows = await whatsapp.ui.call("hub.list_entries", { hub_type: "Template", txt: "invoice" });
```

---

## get_entry

One entry with all its data, its `state` here, and the labels of its fields for the details view.

- **Path:** `whatsapp_next.api.v1.hub.get_entry`
- **Methods:** GET, POST
- **Roles:** `MANAGER`

| Argument | Type | Required / default | Meaning |
|---|---|---|---|
| `name` | str | required | The hub entry's `name`. At most 140 characters. |

**Returns.** `payload` is the record the entry installs (its fields, and for a function
`server_script` and `script`). `payload.requires` lists entry names it needs. `labels` maps each
payload key that is a field of the target DocType to its label, in the user's language.

```json
{"name": "HUB-0012", "hub_name": "Invoice reminder", "hub_type": "Template",
 "description": "Reminds the customer of an unpaid invoice", "checksum": "9b1c…",
 "modified": "2026-10-29 12:04:11.000000",
 "payload": {"name": "Invoice reminder", "template_name": "Invoice reminder", "message_type": "Text",
             "reference_doctype": "Sales Invoice", "body": "Dear {{ doc.customer_name }}, …"},
 "labels": {"template_name": "Template Name", "message_type": "Message Type",
            "reference_doctype": "Reference DocType", "body": "Body"},
 "state": "not_installed", "local": null}
```

**Errors:** `WAValidationError` (417) for an unknown or unpublished entry, or an entry of an
unknown type. Provider errors are mapped.
**Realtime:** none.

```js
const entry = await whatsapp.ui.call("hub.get_entry", { name: "HUB-0012" });
```

---

## install

Installs the entry, or updates the record installed from it before. Entries named in
`payload.requires` (a command's function, a notification's template) are installed first when
this site has no record of them. Audited as `Hub Entry Installed`.

- A new notification or alert arrives with `enabled = 0`, and a new command with
  `status = "Inactive"`. An update keeps what this site switched on or off. A running command is
  stopped for the update, then put back to `Active`.
- A function writes its `Server Script` (created, or its code replaced and enabled), then
  installs or updates the `WhatsApp Function` from it.
- Only the DocType's own set-up fields are taken from the payload.

- **Path:** `whatsapp_next.api.v1.hub.install`
- **Methods:** POST
- **Roles:** `MANAGER`; a `Function` entry also needs System Manager

| Argument | Type | Required / default | Meaning |
|---|---|---|---|
| `name` | str | required | The hub entry's `name`. At most 140 characters. |

**Returns.** `created` is `false` for an update.

```json
{"doctype": "WhatsApp Template", "name": "Invoice reminder", "created": true}
```

**Errors:**

| Exception | HTTP | When |
|---|---|---|
| `WAPermissionError` | 403 | A `Function` entry and the user isn't a System Manager |
| `WAValidationError` | 417 | Unknown or unpublished entry, an entry with no data, a function without a valid `wa_fn_` script, or a record of the same name that didn't come from the hub |
| Provider errors (mapped, README §5) | 4xx/5xx | The hub couldn't be read |

**Realtime:** none.

```js
const r = await whatsapp.ui.call("hub.install", { name: "HUB-0012" }, { freeze: true });
```

# Functions API (`functions.*`)

Module: `whatsapp_next/api/v1/functions.py` — the Functions Center: the catalog storefront,
diff-before-install, install / update / remove, status and setting values of installed
`WhatsApp Function` rows. Thin wrappers over `whatsapp_next/services/functions_catalog.py`.
Commands that call functions are managed through the [commands API](commands.md).

URL form, authentication, the error envelope, the role groups and the `names[]` bulk result shape
are in [README.md](README.md). Every endpoint also answers **403** (`WAPermissionError`) for a
missing role and **417** (`WAValidationError`) for an unknown, missing or untypeable argument.
Returns are shown as the value of the response's `message` key.

## How functions work

A **function** is server code an inbound WhatsApp command runs, e.g. `#ping hello`. Three layers
keep it safe (D-012):

1. **The handler registry** — `whatsapp_next/functions/registry.py`. A dict
   `FUNCTION_HANDLERS = {function_key: callable}` is the **only** place a command's function is
   resolved. Built-ins are `ping` (`functions/handlers/ping.py`) and `document_info`
   (`functions/handlers/document_info.py`). Other apps add handlers through the
   `whatsapp_function_handlers` hook — a dict `{function_key: "dotted.path.to.handle"}` resolved
   once per process at load time; an unresolvable path is logged and skipped. A command stores a
   `function` **key**, never a dotted path: the router looks the key up in this allow-list and
   never calls `frappe.get_attr` on data, so no request or record can make the router run
   arbitrary code.
2. **The catalog** — `functions/catalog/v<N>/catalog.json` in this app, plus any module listed in
   the `whatsapp_function_catalogs` hook. Each entry declares `function_key`, `function_name`,
   `category`, `description`, `when_to_use`, `party_types` and `versions{<semver>: manifest}`; a
   manifest carries `released`, `changelog`, `inputs[]`, `settings[]`, `outputs[]`, `example`,
   `suggested_commands[]`. Later sources extend earlier ones per key. The merged catalog is cached
   5 minutes (`wa:functions:catalog`).
3. **The installed row** — `WhatsApp Function` (name = `function_key`), created by `install` from a
   manifest: settings and outputs copied, a manifest snapshot and its sha256 `checksum` kept for
   later diffs, `handler_registered` refreshed on every save. Install refuses a key with no
   registered handler.

A handler is `Callable[[FunctionContext], FunctionResult]` (`functions/context.py`):

- `FunctionContext(function_key, command, args, settings, sender, device, inbound, dry_run)`;
  `sender` is `Sender(phone_e164, jid, display_name, contact, party_type, party_name, is_group)`.
- `FunctionResult(data={}, files=[(file_name, bytes, mime)], error=None)`. `data` feeds output
  templates as `{{ data.x }}`; `files` become Document outputs; `error` marks a handled failure.
- It runs **as the Command Service User** (WhatsApp Settings; must be enabled and not a System
  Manager), and never sends — the router renders the outputs and hands them to the dispatcher.

---

## get_catalog

Every catalog function merged with its install state.

- **Path:** `whatsapp_next.api.v1.functions.get_catalog`
- **Methods:** GET, POST
- **Roles:** `VIEWER_UP`

No arguments.

**Returns**

```json
{
  "entries": [
    {
      "function_key": "ping", "function_name": "Ping", "category": "Diagnostics",
      "description": "Replies with an echo of the text you sent. …", "when_to_use": "First function to install …",
      "party_types": [], "latest_version": "1.0.0", "versions": ["1.0.0"],
      "installed": true, "installed_version": "1.0.0", "status": "Active", "update_available": false,
      "handler_registered": true, "source": "whatsapp_next.functions.catalog/v1",
      "commands_count": 1,
      "changelog": { "1.0.0": "Initial release." },
      "releases": { "1.0.0": { "released": "2026-09-22", "changelog": "Initial release." } }
    }
  ],
  "catalog_source": ["whatsapp_next.functions.catalog/v1"],
  "catalog_errors": [],
  "checked_at": "2026-09-28 10:00:00"
}
```

- Entries are sorted by `function_key`; `versions` ascending (semantic order).
- `handler_registered` is checked live against the registry.
- `commands_count` counts `WhatsApp Command` rows using the function (any status).
- `catalog_errors` lists unreadable catalog files and entries without key / versions.

**Realtime:** none.

```bash
curl "https://site/api/method/whatsapp_next.api.v1.functions.get_catalog" -H "Authorization: token <api_key>:<api_secret>"
```

---

## get_manifest

What one version of a catalog function is made of.

- **Path:** `whatsapp_next.api.v1.functions.get_manifest`
- **Methods:** GET, POST
- **Roles:** `VIEWER_UP`

| Argument | Type | Required | Meaning |
|---|---|---|---|
| `function_key` | str | yes | Catalog key. |
| `version` | str | optional | Default: the installed version, else the latest. |

**Returns**

```json
{
  "function_key": "document_info",
  "version": "1.0.0",
  "released": "2026-09-22",
  "changelog": "Initial release.",
  "inputs": [{ "key": "name", "label": "Document name", "type": "str", "required": true, "position": 1 }],
  "settings": [{ "key": "document_type", "label": "Document Type", "fieldtype": "Data", "default_value": "Sales Invoice", "notes": "DocType to look up.", "value": "Sales Invoice" }],
  "outputs": [{ "output_key": "summary", "label": "Summary", "output_type": "Text", "default_template": "{{ data.doctype }} {{ data.name }}\nStatus: {{ data.status }}…" }],
  "example": "#doc SINV-0001",
  "suggested_commands": ["doc", "فاتورة"],
  "party_types": ["Customer", "Supplier"],
  "installed": {
    "installed_version": "1.0.0", "installed_at": "…", "installed_by": "manager@example.com",
    "catalog_source": "whatsapp_next.functions.catalog/v1", "call_count": 12, "avg_ms": 35,
    "error_count": 1, "last_called_at": "…", "last_error": null
  }
}
```

Setting rows carry the site's `value` only when the function is installed; `installed` is `{}`
otherwise.

**Errors:** `WANotFoundError` (404) — key not in the catalog, or no such version.

**Realtime:** none.

```js
const m = await sanad.ui.call("functions.get_manifest", { function_key: "document_info" });
```

---

## preview_install

What installing, or moving to, a version would change.

- **Path:** `whatsapp_next.api.v1.functions.preview_install`
- **Methods:** GET, POST
- **Roles:** `MANAGER`

| Argument | Type | Required | Meaning |
|---|---|---|---|
| `function_key` | str | yes | Catalog key. |
| `version` | str | optional | Target version (default latest). |

**Returns**

```json
{
  "diff": {
    "settings": { "added": ["party_field"], "removed": [], "changed": [{ "key": "document_type", "fields": { "default_value": ["Sales Invoice", "Sales Order"] } }] },
    "outputs": { "added": [], "removed": [], "changed": [] },
    "manifest": { "added": [], "removed": [], "changed": ["changelog", "released"] }
  },
  "commands_impacted": ["doc"],
  "handler_registered": true,
  "installed_version": "1.0.0",
  "target_version": "1.1.0"
}
```

- `settings` diffs by `key`, `outputs` by `output_key`; `changed[].fields` maps each field to
  `[current, target]`.
- `manifest` lists manifest keys (`inputs, outputs, settings, example, suggested_commands,
  changelog, released, party_types`) added, removed or changed.
- For a function not installed, everything in the target is `added` and `installed_version` is
  `null`.

**Errors:** `WANotFoundError` (404) — unknown key / version.

**Realtime:** none.

```js
const d = await sanad.ui.call("functions.preview_install", { function_key: "document_info", version: "1.1.0" });
```

---

## install

Install a function from the catalog, `Active`.

- **Path:** `whatsapp_next.api.v1.functions.install`
- **Methods:** POST
- **Roles:** `MANAGER`

| Argument | Type | Required | Meaning |
|---|---|---|---|
| `function_key` | str | yes | Catalog key. |
| `version` | str | optional | Default latest. |

Settings start at their `default_value`; outputs' `template` = `default_template`. Audited
`Function Installed` with `details.version`.

**Returns**

```json
{ "name": "document_info", "installed_version": "1.0.0" }
```

**Errors**

| Exception | HTTP | When |
|---|---|---|
| `WAStateConflictError` | 409 | Already installed (use `update`). |
| `WAValidationError` | 417 | No handler registered for the key on this site. |
| `WANotFoundError` | 404 | Key not in the catalog, or no such version. |

**Realtime:** none.

```bash
curl -X POST "https://site/api/method/whatsapp_next.api.v1.functions.install" \
  -H "Authorization: token <api_key>:<api_secret>" -d function_key=ping
```

---

## update

Move an installed function to another version (default latest; an older one is a rollback).

- **Path:** `whatsapp_next.api.v1.functions.update`
- **Methods:** POST
- **Roles:** `MANAGER`

| Argument | Type | Required | Meaning |
|---|---|---|---|
| `function_key` | str | yes | Installed key. |
| `version` | str | optional | Target version. |

Site setting values are kept for keys that still exist, and customised output templates (a
`template` different from the old `default_template`) are kept for output keys that still exist.
Audited `Function Updated` with `details {from, to}`.

**Returns**

```json
{ "installed_version": "1.1.0", "previous_version": "1.0.0" }
```

**Errors:** `WANotFoundError` (404) — not installed, not in the catalog, or no such version.

**Realtime:** none.

```js
await sanad.ui.call("functions.update", { function_key: "document_info", version: "1.1.0" });
```

---

## update_many

Bulk update to each function's latest version.

- **Path:** `whatsapp_next.api.v1.functions.update_many`
- **Methods:** POST
- **Roles:** `MANAGER`

| Argument | Type | Required | Meaning |
|---|---|---|---|
| `function_keys` | list[str] | yes | Installed keys. |

**Returns** — the bulk shape; functions already on the latest version are `skipped` with reason
`already latest`; a key that is not installed is in `failed` (`Function … is not installed`).

```json
{ "count": 1, "done": ["document_info"], "failed": [], "skipped": [{ "name": "ping", "reason": "already latest" }] }
```

**Realtime:** none.

```js
await sanad.ui.call("functions.update_many", { function_keys: ["ping", "document_info"] });
```

---

## remove

Delete an installed function.

- **Path:** `whatsapp_next.api.v1.functions.remove`
- **Methods:** POST
- **Roles:** `MANAGER`

| Argument | Type | Required | Meaning |
|---|---|---|---|
| `function_key` | str | yes | Installed key. |

Audited `Function Removed`.

**Returns**

```json
{ "removed": true }
```

**Errors**

| Exception | HTTP | When |
|---|---|---|
| `WANotFoundError` | 404 | Not installed. |
| `WAStateConflictError` | 409 | An `Active` command still uses it (`Deactivate commands … before removing the function`). |

**Realtime:** none.

```js
await sanad.ui.call("functions.remove", { function_key: "ping" });
```

---

## set_status

Activate or deactivate an installed function. An `Inactive` function blocks every command that
uses it (block reason `Function Inactive`).

- **Path:** `whatsapp_next.api.v1.functions.set_status`
- **Methods:** POST
- **Roles:** `MANAGER`

| Argument | Type | Required | Meaning |
|---|---|---|---|
| `function_key` | str | yes | Installed key. |
| `status` | str | yes | `Active` or `Inactive` (enum-checked). |

**Returns**

```json
{ "status": "Inactive" }
```

**Errors:** `WANotFoundError` (404) — not installed.

**Realtime:** none.

```js
await sanad.ui.call("functions.set_status", { function_key: "ping", status: "Inactive" });
```

---

## set_status_many

Bulk activate / deactivate.

- **Path:** `whatsapp_next.api.v1.functions.set_status_many`
- **Methods:** POST
- **Roles:** `MANAGER`

| Argument | Type | Required | Meaning |
|---|---|---|---|
| `function_keys` | list[str] | yes | Installed keys. |
| `status` | str | yes | `Active` or `Inactive`. |

**Returns** — the bulk shape; rows already in `status` are `skipped` (`already Active` /
`already Inactive`); unknown keys are in `failed`.

**Realtime:** none.

```js
await sanad.ui.call("functions.set_status_many", { function_keys: ["ping", "document_info"], status: "Active" });
```

---

## save_settings

Write setting values of an installed function by key.

- **Path:** `whatsapp_next.api.v1.functions.save_settings`
- **Methods:** POST
- **Roles:** `MANAGER`

| Argument | Type | Required | Meaning |
|---|---|---|---|
| `function_key` | str | yes | Installed key. |
| `values` | dict | yes | `{setting_key: value}`; values are stored as strings (`null` → `""`) and validated by the row's `fieldtype` / `choices` in the controller. |

**Returns** — every setting after the save:

```json
{ "values": { "document_type": "Sales Invoice", "party_field": "customer", "require_party": "1" } }
```

**Errors:** `WANotFoundError` (404) — not installed; `WAValidationError` (417) — `Unknown setting
keys for function …`, or controller validation.

**Realtime:** none.

```bash
curl -X POST "https://site/api/method/whatsapp_next.api.v1.functions.save_settings" \
  -H "Authorization: token <api_key>:<api_secret>" -H "Content-Type: application/json" \
  -d '{"function_key": "document_info", "values": {"document_type": "Sales Order", "party_field": "customer"}}'
```

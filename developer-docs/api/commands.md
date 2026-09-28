# Commands API (`commands.*`)

Module: `whatsapp_next/api/v1/commands.py` — the Commands screen and the command editor (D-132).
Writes live in `whatsapp_next/services/commands.py`; routing and dry runs in
`whatsapp_next/services/command_router.py`. The functions a command calls are installed through
the [functions API](functions.md).

URL form, authentication, the error envelope, the role groups and the `names[]` bulk result shape
are in [README.md](README.md). Every endpoint also answers **403** (`WAPermissionError`) for a
missing role and **417** (`WAValidationError`) for an unknown, missing or untypeable argument.
Returns are shown as the value of the response's `message` key.

## How commands work

A `WhatsApp Command` maps a **word** (`code`, stored casefolded; the document name) plus optional
`synonyms` to an installed **function key**. When an inbound text message arrives, a background
job (`command_router.route`, never inside a web request) matches the first token against the
cached word map of `Active` commands, checks access, parses typed arguments from the function's
manifest `inputs`, runs the handler, renders the command's `outputs` and queues the replies at
priority 1.

**No arbitrary code (D-012).** The command's `function` field is a key into the handler allow-list
in `whatsapp_next/functions/registry.py` (built-ins plus the `whatsapp_function_handlers` hook).
The router resolves the key there and nowhere else; it never runs a dotted path taken from a
request or a record. A key with no registered handler, or an `Inactive` function, blocks the
command with `Function Inactive`. See [functions.md](functions.md#how-functions-work).

**Access checks, in order** (first failure wins → `block_reason`): commands disabled in Settings
(`Commands Disabled`) → not a text message (`Not Allowed`) → sender in the global blacklist group
or the command's `blocked_group` (`Blacklist`) → not in `allowed_group` (`Not Allowed`) →
`requires_linked_contact` without a contact (`Not Linked`) → party type not allowed
(`Party Type`) → the party type's list: `Deny All` and not listed (`Not Allowed`), `Allow All` and
listed (`Blacklist`) → function inactive / unregistered (`Function Inactive`).

**Edit lock.** While a command is `Active`, only its status and counters may change: `save_command`
and `restore_defaults` raise `WAStateConflictError` (409); `save_editor` stops, saves and
restarts it in one request.

**Payload keys** (`save_command`; anything else is refused):

| Key | Meaning |
|---|---|
| `name` | Existing command to update; absent = create (created `Inactive`). |
| `code` | The command word (casefolded, stripped; required). |
| `title` | Defaults to `code`. |
| `function` | Installed `WhatsApp Function` key. |
| `synonyms` | Newline-separated words; casefolded, de-duplicated; may not equal `code` or any word of another command. |
| `requires_linked_contact` | 0 / 1. |
| `allowed_group`, `blocked_group` | `WhatsApp Contact Group` names. |
| `reply_device` | Device used for replies. |
| `description` | Free text. |
| `allowed_party_types` | List of party types (`Customer`, `Supplier`, `Employee`, `Sales Person`, `User`). |
| `settings_overrides` | Object `{setting_key: value}`; every key must be a setting of the function. |
| `outputs` | List of output rows with only `output_key, label, output_type, default_template, template, condition, print_format, file_name_template, variables, notes`. On create with no outputs, they are copied from the function. |
| `disabled_inputs` | List (or newline text) of input keys the command does not accept. |
| `access` | `{party_type: {mode: "Allow All" \| "Deny All", groups: [group], contacts: [contact]}}`; types not in `allowed_party_types` are dropped. Without `access`, changing `allowed_party_types` drops list rows of removed types. |

`save_editor` / `preview_command` accept the same keys plus `status`.

---

## list_commands

Command rows with their function's status and 30-day run count.

- **Path:** `whatsapp_next.api.v1.commands.list_commands`
- **Methods:** GET, POST
- **Roles:** `VIEWER_UP`

| Argument | Type | Required / default | Meaning |
|---|---|---|---|
| `filters` | dict | optional | Only `status` and `function` are honoured; other keys are ignored. |
| `page` | int | `1` | |
| `page_length` | int | `20` | Capped at 200. |

**Returns** — ordered by `code`:

```json
{
  "rows": [
    { "name": "ping", "code": "ping", "title": "ping", "function": "ping", "status": "Active", "synonyms": "بنق",
      "requires_linked_contact": 0, "allowed_group": null, "blocked_group": null, "reply_device": null,
      "description": null, "run_count": 40, "last_run_at": "…", "defaults_restored_at": null, "modified": "…",
      "function_status": "Active", "function_name": "Ping", "run_count_30d": 12 }
  ],
  "total": 1
}
```

`run_count_30d` counts `WhatsApp Inbound Message` rows matched to the command with `received_at`
in the last 30 days.

**Realtime:** none.

```js
const { rows } = await sanad.ui.call("commands.list_commands", { filters: { status: "Active" } });
```

---

## get_defaults

Outputs, settings, party types and suggested words of an installed function (to prefill a new
command).

- **Path:** `whatsapp_next.api.v1.commands.get_defaults`
- **Methods:** GET, POST
- **Roles:** `MANAGER`

| Argument | Type | Required | Meaning |
|---|---|---|---|
| `function` | str | yes | Installed function key. |

**Returns**

```json
{
  "outputs": [{ "output_key": "summary", "label": "Summary", "output_type": "Text", "default_template": "…", "template": "…",
                "condition": "", "print_format": null, "file_name_template": null, "variables": "…", "notes": null }],
  "settings": [{ "key": "document_type", "label": "Document Type", "fieldtype": "Data", "choices": null,
                 "default_value": "Sales Invoice", "value": "Sales Invoice", "notes": "DocType to look up." }],
  "party_types": ["Customer", "Supplier"],
  "suggested_commands": ["doc", "فاتورة"]
}
```

**Errors:** `WANotFoundError` (404) — function not installed.

**Realtime:** none.

```js
const d = await sanad.ui.call("commands.get_defaults", { function: "document_info" });
```

---

## save_command

Create or update a command from the allow-listed payload.

- **Path:** `whatsapp_next.api.v1.commands.save_command`
- **Methods:** POST
- **Roles:** `MANAGER`

| Argument | Type | Required | Meaning |
|---|---|---|---|
| `payload` | dict | yes | See **Payload keys**. |

Audited `Command Changed` (`fields_written`, `details.created`). Saving clears the router's word
map cache.

**Returns**

```json
{ "name": "doc" }
```

**Errors**

| Exception | HTTP | When |
|---|---|---|
| `WAValidationError` | 417 | `payload must be an object`; `Unknown payload keys`; `Command Word is required`; word already used by another command; synonym equals the word; unknown override key; bad `outputs` / `disabled_inputs` / `access` shape or list rows. |
| `WAStateConflictError` | 409 | The target command is `Active`. |
| `WANotFoundError` | 404 | `payload.name` unknown. |

**Realtime:** none.

```bash
curl -X POST "https://site/api/method/whatsapp_next.api.v1.commands.save_command" \
  -H "Authorization: token <api_key>:<api_secret>" -H "Content-Type: application/json" \
  -d '{"payload": {"code": "doc", "function": "document_info", "synonyms": "فاتورة",
       "requires_linked_contact": 1, "allowed_party_types": ["Customer"]}}'
```

---

## set_status

Start or stop a command.

- **Path:** `whatsapp_next.api.v1.commands.set_status`
- **Methods:** POST
- **Roles:** `MANAGER`

| Argument | Type | Required | Meaning |
|---|---|---|---|
| `name` | str | yes | Command name (its word). |
| `status` | str | yes | `Active` or `Inactive` (enum-checked). |

**Returns**

```json
{ "status": "Active" }
```

**Errors:** `WANotFoundError` (404) — `Command … not found`.

**Realtime:** none.

```js
await sanad.ui.call("commands.set_status", { name: "doc", status: "Active" });
```

---

## set_status_many

Bulk start / stop.

- **Path:** `whatsapp_next.api.v1.commands.set_status_many`
- **Methods:** POST
- **Roles:** `MANAGER`

| Argument | Type | Required | Meaning |
|---|---|---|---|
| `names` | list[str] | yes | Command names. |
| `status` | str | yes | `Active` or `Inactive`. |

**Returns** — the bulk shape; commands already in `status` are `skipped` (`already Active` /
`already Inactive`); unknown names are in `failed`.

**Realtime:** none.

```js
await sanad.ui.call("commands.set_status_many", { names: ["doc", "ping"], status: "Inactive" });
```

---

## restore_defaults

Re-copy `outputs` from the function and clear `settings_overrides`.

- **Path:** `whatsapp_next.api.v1.commands.restore_defaults`
- **Methods:** POST
- **Roles:** `MANAGER`

| Argument | Type | Required | Meaning |
|---|---|---|---|
| `name` | str | yes | Command name. |

Sets `defaults_restored_at`. Audited `Command Defaults Restored`.

**Returns**

```json
{ "outputs": [{ "output_key": "summary", "label": "Summary", "output_type": "Text", "template": "…" }], "settings_overrides": {} }
```

**Errors:** `WANotFoundError` (404); `WAStateConflictError` (409) — the command is `Active`.

**Realtime:** none.

```js
await sanad.ui.call("commands.restore_defaults", { name: "doc" });
```

---

## test_command

Dry-run a message text from a sender number through the real router — nothing persisted in the
message tables, nothing sent.

- **Path:** `whatsapp_next.api.v1.commands.test_command`
- **Methods:** POST
- **Roles:** `MANAGER`

| Argument | Type | Required | Meaning |
|---|---|---|---|
| `text` | str | yes | The message, e.g. `#doc SINV-0001`. |
| `sender_phone` | str | yes | Number or JID the message is "from"; its Contact is resolved by phone. |
| `device` | str | optional | Default: the Settings default device. |

**Returns**

```json
{
  "matched": true,
  "status": "Executed",
  "command": "doc",
  "block_reason": null,
  "args": { "name": "SINV-0001" },
  "reply_body": "Sales Invoice SINV-0001\nStatus: Paid\nDate: 2026-09-01",
  "replies": [{ "output_key": "summary", "message_type": "Text", "body": "Sales Invoice SINV-0001\n…", "attachment": null }],
  "error": null,
  "function_ms": 42
}
```

- `status`: `None`, `Not Matched`, `Blocked`, `Matched`, `Executed` or `Failed`; `matched` is
  true for anything but `None` / `Not Matched` (a `Blocked` command is matched).
- `block_reason`: one of the access-check reasons above.
- `reply_body`: the first reply with a body; `replies` may include the unknown-command reply when
  Settings define one.
- `function_ms`: elapsed routing time in ms.
- The handler really runs (as the Command Service User, with `dry_run=True` in its context), and
  its call is counted in the function's `call_count` / `avg_ms` / `error_count`.

**Errors**

| Exception | HTTP | When |
|---|---|---|
| `WAInvalidPhoneError` | 417 | `sender_phone` is not a valid number / JID. |
| `WAValidationError` | 417 | `Message text is required`. |
| `WAStateConflictError` | 409 | The Command Service User is not configured, disabled, or a System Manager (raised when a matched command reaches its handler). |

**Realtime:** none.

```bash
curl -X POST "https://site/api/method/whatsapp_next.api.v1.commands.test_command" \
  -H "Authorization: token <api_key>:<api_secret>" \
  --data-urlencode "text=#ping hello" -d sender_phone=+966500000002
```

---

## get_editor

Everything the command editor opens with.

- **Path:** `whatsapp_next.api.v1.commands.get_editor`
- **Methods:** GET, POST
- **Roles:** `MANAGER`

| Argument | Type | Required | Meaning |
|---|---|---|---|
| `name` | str | optional | Command to open; omit for a new one. |

**Returns**

```json
{
  "command": {
    "name": "doc", "code": "doc", "title": "doc", "function": "document_info", "status": "Inactive",
    "synonyms": ["فاتورة"], "requires_linked_contact": 1, "allowed_party_types": ["Customer"],
    "disabled_inputs": [], "settings_overrides": {}, "outputs": [{ "output_key": "summary", "…": "…" }],
    "access": { "Customer": { "mode": "Deny All", "groups": [{ "name": "VIP", "label": "VIP" }], "contacts": [{ "name": "Ahmed Ali", "label": "Ahmed Ali", "phone": "+966500000002" }] } },
    "runs_30d": 12, "has_history": true
  },
  "functions": [{ "name": "document_info", "function_name": "Document Status", "category": "Documents", "status": "Active" }],
  "party_types": [{ "key": "Customer", "label": "Customer" }, { "key": "Supplier", "label": "Supplier" }, { "key": "Employee", "label": "Employee" }, { "key": "Sales Person", "label": "Sales Person" }, { "key": "User", "label": "User" }],
  "function": { /* get_function_spec of the command's function, or null */ }
}
```

A new command starts `Inactive` with empty values. `has_history` is true when inbound messages
already point at the command (it can then only be stopped, not deleted).

**Errors:** `WANotFoundError` (404) — unknown command, or its function is no longer installed.

**Realtime:** none.

```js
const ed = await sanad.ui.call("commands.get_editor", { name: "doc" });
```

---

## get_function_spec

Inputs, settings, outputs and suggested words of one installed function, for the editor.

- **Path:** `whatsapp_next.api.v1.commands.get_function_spec`
- **Methods:** GET, POST
- **Roles:** `MANAGER`

| Argument | Type | Required | Meaning |
|---|---|---|---|
| `function` | str | yes | Installed function key. |

**Returns**

```json
{
  "name": "document_info", "function_name": "Document Status", "category": "Documents", "status": "Active",
  "when_to_use": "Customers or suppliers asking about …", "example": "#doc SINV-0001",
  "inputs": [{ "key": "name", "label": "Document name", "type": "str", "required": true, "rest": false, "options": null, "details": null, "example": null }],
  "settings": [{ "key": "document_type", "label": "Document Type", "fieldtype": "Data", "choices": [], "default_value": "Sales Invoice", "notes": "DocType to look up." }],
  "outputs": [{ "output_key": "summary", "…": "…" }],
  "party_types": ["Customer", "Supplier"],
  "suggested_commands": ["doc", "فاتورة"]
}
```

`inputs` are sorted by `position`; a setting's `default_value` is the site's current value when
set, else the manifest default; `choices` is split into a list.

**Errors:** `WANotFoundError` (404) — function not installed.

**Realtime:** none.

```js
const spec = await sanad.ui.call("commands.get_function_spec", { function: "document_info" });
```

---

## save_editor

Save from the editor, status included. An `Active` command is stopped, saved, then set to the
chosen status (default: back to `Active`) in one request.

- **Path:** `whatsapp_next.api.v1.commands.save_editor`
- **Methods:** POST
- **Roles:** `MANAGER`

| Argument | Type | Required | Meaning |
|---|---|---|---|
| `payload` | dict | yes | Payload keys plus `status` (`Active` / `Inactive` / absent). |

**Returns**

```json
{ "name": "doc", "status": "Active" }
```

**Errors:** `WAValidationError` (417) — `Unknown payload keys`, `Unknown status …`, and every
`save_command` validation; `WANotFoundError` (404).

**Realtime:** none.

```js
await sanad.ui.call("commands.save_editor", { payload: { name: "doc", synonyms: "فاتورة\ninvoice", status: "Active" } });
```

---

## preview_command

Dry-run the editor's draft (saved or not) for an assumed sender — nothing saved, nothing sent.

- **Path:** `whatsapp_next.api.v1.commands.preview_command`
- **Methods:** POST
- **Roles:** `MANAGER`

| Argument | Type | Required | Meaning |
|---|---|---|---|
| `payload` | dict | yes | Editor payload (`name` and `status` are ignored for the draft). A draft without `outputs` gets the function's. |
| `sender` | dict | optional | `{contact, party_type, party_name, phone, label}`; `party_*` count only with a `contact`. |
| `values` | dict | optional | `{input_key: text}` used to build the message text. |

The text is built as `<code> <value> …` in input order (disabled inputs and empty values
skipped); then the access checks, argument parsing, handler and output rendering run with
`dry_run`. Messages Frappe would otherwise queue for the Desk are discarded; failures are in the
result.

**Returns**

```json
{
  "text": "doc SINV-0001",
  "status": "Executed",
  "block_reason": null,
  "reply_sent": true,
  "args": { "name": "SINV-0001" },
  "missing": [],
  "replies": [{ "output_key": "summary", "message_type": "Text", "body": "…", "attachment": null }],
  "error": null
}
```

- `status`: `Blocked`, `Failed` (argument or handler error) or `Executed`.
- `missing`: required inputs with no value, `[{key, label}]`.
- On `Blocked`, `replies` holds the refusal text and `reply_sent` says whether a live route would
  send it (Settings `send_receipt_reply`).

**Errors**

| Exception | HTTP | When |
|---|---|---|
| `WAValidationError` | 417 | `payload must be an object`; `Unknown payload keys`; `Pick a function first`. |
| `WANotFoundError` | 404 | `sender.contact` or the function does not exist. |
| `WAStateConflictError` | 409 | Command Service User not usable (when the handler is reached). |

**Realtime:** none. As with `test_command`, the handler call is counted in the function's metrics.

```js
const p = await sanad.ui.call("commands.preview_command", {
  payload: { code: "doc", function: "document_info", allowed_party_types: ["Customer"] },
  sender: { contact: "Ahmed Ali", party_type: "Customer", party_name: "CUST-0001" },
  values: { name: "SINV-0001" },
});
```

---

## delete_command

Delete a command that has no run history.

- **Path:** `whatsapp_next.api.v1.commands.delete_command`
- **Methods:** POST
- **Roles:** `MANAGER`

| Argument | Type | Required | Meaning |
|---|---|---|---|
| `name` | str | yes | Command name. |

Audited `Command Deleted` with `details {code, function}`.

**Returns**

```json
{ "deleted": true }
```

**Errors:** `WANotFoundError` (404); `WAStateConflictError` (409) — inbound messages point at the
command (`… has run history; stop it instead of deleting it`).

**Realtime:** none.

```js
await sanad.ui.call("commands.delete_command", { name: "doc" });
```

---

## search_groups

Enabled contact groups for the editor's allowed / blocked / list pickers.

- **Path:** `whatsapp_next.api.v1.commands.search_groups`
- **Methods:** GET, POST
- **Roles:** `MANAGER`

| Argument | Type | Required | Meaning |
|---|---|---|---|
| `txt` | str | optional | LIKE on `group_name`. |

**Returns** — at most 20:

```json
[{ "name": "VIP", "label": "VIP", "member_count": 42 }]
```

**Realtime:** none.

```js
const groups = await sanad.ui.call("commands.search_groups", { txt: "VI" });
```

---

## search_contacts

Contacts for the editor's lists and the preview sender, through the contextual permission layer
(audited for Contact Users).

- **Path:** `whatsapp_next.api.v1.commands.search_contacts`
- **Methods:** GET, POST
- **Roles:** `MANAGER`, **and** Contact User | Contact read

| Argument | Type | Required | Meaning |
|---|---|---|---|
| `txt` | str | optional | Name, email or phone. |
| `party_type` | str | optional | Only contacts linked to this party type (ignored unless one of `Customer`, `Supplier`, `Employee`, `Sales Person`). |

**Returns** — at most 20:

```json
[{ "name": "Ahmed Ali", "label": "Ahmed Ali", "phone": "+966500000002",
   "links": [{ "link_doctype": "Customer", "link_name": "CUST-0001", "link_title": "Ahmed Trading" }] }]
```

`phone` is the first normalized phone, else the first raw phone.

**Errors:** 403 without contact read.

**Realtime:** none.

```js
const contacts = await sanad.ui.call("commands.search_contacts", { txt: "Ahmed", party_type: "Customer" });
```

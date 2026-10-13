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
`synonyms` to an installed **function** — a Server Script with a `WA-FUNCTION` header (see
[functions.md](functions.md#how-functions-work) and
[commands-and-functions.md](../commands-and-functions.md)). When an inbound text message arrives, a
background job (`command_router.route`, never inside a web request) matches the first token against
the cached word map of `Active` commands, checks access, reads typed values from the text by the
function's header parameters, merges and fills them (`function_runner.prepare`), asks for what is
still missing, runs the script, checks its messages against `@reply` and queues the replies at
priority 1.

**No arbitrary code (D-012).** The command's `function` field is the key of an installed
`WhatsApp Function`; the router runs that row's `server_script` and nothing else, never a path
taken from a request or a record. The script runs as the Command Service User, and its direct URL
is refused by the `wa_fn_` guard every function script starts with.

**Access checks, in order** (first failure wins → `block_reason`): commands disabled in Settings
(`Commands Disabled`) → not a text message (`Not Allowed`) → sender in the global blacklist group
or the command's `blocked_group` (`Blacklist`) → not in `allowed_group` (`Not Allowed`) →
`requires_linked_contact` without a contact (`Not Linked`) → party type not in the command's
`allowed_party_types` (`Party Type`) → the party type's list: `Deny All` and not listed
(`Not Allowed`), `Allow All` and listed (`Blacklist`) → the function: not installed, `Inactive`,
without a `server_script`, or an `@requires` not met on this site (`Function Inactive`; the reasons
go to `command_error`) → the sender's party type not allowed by `@party_types` (`Party Type`).
A function that needs the sender's party (`source=sender`) when the number is linked to none ends
`Blocked` with `Not Linked`.

**Values of a run.** The sender may write only the header's `source=command` parameters that are
not Templates, not in `disabled_inputs` and not fixed in `settings_overrides`: `key=value` first,
then by position, the last text parameter taking the rest of the message. Any other `key=value` is
ignored — the party comes only from the Contact, and a message template never from the sender's
text. Priority per parameter: the sender's value → the command's `settings_overrides` → the
function's site `values` → the header default. A Template comes from the command's `templates`
rows in the run's language (exact, then base language, then the row without a language), else the
function's value, else the header's `@default <param> [lang]`. The run's language is
`settings_overrides.language` when set, else Settings' `command_reply_language`.

**Replies.** Each message the script returns must name a declared `@reply`; the keys in the
command's `disabled_replies` are dropped. A `text` message becomes a Text reply; a `report` message
is printed (`services/report_file.py`, PDF or Excel) and sent as a Document with its caption. A
script error sends its `error` text alone; an exception sends a generic text and is logged.

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
| `synonyms` | Newline-separated words; casefolded, de-duplicated; may not equal `code`, a help word, or any word of another command. |
| `requires_linked_contact` | 0 / 1. |
| `allowed_group`, `blocked_group` | `WhatsApp Contact Group` names. |
| `description` | Free text. |
| `ask_inputs` | One parameter per line, `key` or `key: v1=Label, v2=Label`: asked over WhatsApp when the text did not give it. |
| `allowed_party_types` | List of party types (`Customer`, `Supplier`, `Employee`, `Sales Person`, `User`); each must be one the function's `@party_types` allows. |
| `settings_overrides` | Object `{param: value}`; every key must be a `source=command` parameter of the function's header, or `language`. A parameter set here is fixed: the sender cannot give it. |
| `templates` | List of `{param, language, text}` rows (only these keys): the command's own text for a Template parameter, one row per parameter and language (`language` empty = any). A row with an empty `text` is skipped, so the function's text applies. |
| `disabled_inputs` | List (or newline text) of parameters the sender may not give in this command. |
| `disabled_replies` | List (or newline text) of `@reply` keys this command never sends. |
| `access` | `{party_type: {mode: "Allow All" \| "Deny All", groups: [group], contacts: [contact]}}`; types not in `allowed_party_types` are dropped. Without `access`, changing `allowed_party_types` drops list rows of removed types. |

The controller checks every name against the function's installed header: `disabled_inputs` and
`ask_inputs` against the parameters a sender may give, `disabled_replies` against `@reply`,
`templates[].param` against the Template parameters. `save_editor` / `preview_command` accept the
same keys plus `status`.

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
    { "name": "فحص", "code": "فحص", "title": "فحص الاتصال", "function": "ping", "status": "Active", "synonyms": "ping\nبنق",
      "requires_linked_contact": 0, "allowed_group": null, "blocked_group": null,
      "description": "…", "run_count": 40, "last_run_at": "…", "defaults_restored_at": null, "modified": "…",
      "function_status": "Active", "function_name": "فحص الاتصال", "run_count_30d": 12 }
  ],
  "total": 1
}
```

`run_count_30d` counts `WhatsApp Inbound Message` rows matched to the command with `received_at`
in the last 30 days, leaving out `Blocked` and simulated rows.

**Realtime:** none.

```js
const { rows } = await sanad.ui.call("commands.list_commands", { filters: { status: "Active" } });
```

---

## get_defaults

What a new command on a function starts from, read from the function's installed header: the
values a sender may write, the other parameters, the message templates, the replies and the party
types.

- **Path:** `whatsapp_next.api.v1.commands.get_defaults`
- **Methods:** GET, POST
- **Roles:** `MANAGER`

| Argument | Type | Required | Meaning |
|---|---|---|---|
| `function` | str | yes | Installed function key. |

**Returns** — the `inputs, settings, templates, replies, party_types, party_types_text` keys of
[get_function_spec](#get_function_spec):

```json
{
  "inputs": [{ "key": "document_name", "label": "رقم المستند", "type": "str", "required": true, "options": null, "choices": [], "position": 1 }],
  "settings": [{ "key": "document_type", "label": "نوع المستند", "fieldtype": "Link", "options": "DocType", "choices": [],
                 "required": false, "depends_on": null, "header_default": null, "default_value": null }],
  "templates": [{ "key": "msg_result", "label": "رسالة حالة المستند", "default": "…", "defaults_by_lang": {}, "site": null, "vars": [{ "name": "status", "label": "…", "messages": ["msg_result"] }] }],
  "replies": [{ "key": "result_text", "type": "text", "report_name": null, "format": null, "label": "…" }],
  "party_types": { "mode": "only", "types": ["Customer", "Supplier"] },
  "party_types_text": "Customer, Supplier"
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
{ "name": "فاتورة" }
```

**Errors**

| Exception | HTTP | When |
|---|---|---|
| `WAValidationError` | 417 | `payload must be an object`; `Unknown payload keys`; `Command Word is required`; word already used by another command or a help word; synonym equals the word; an override key that is not a header parameter; a `disabled_inputs` / `ask_inputs` / `disabled_replies` name not in the header; a `templates` row with unknown fields, a `param` that is not a Template parameter, or the same parameter and language twice; a party type outside `@party_types`; bad `access` shape or list rows. |
| `WAStateConflictError` | 409 | The target command is `Active`. |
| `WANotFoundError` | 404 | `payload.name` unknown. |

**Realtime:** none.

```bash
curl -X POST "https://site/api/method/whatsapp_next.api.v1.commands.save_command" \
  -H "Authorization: token <api_key>:<api_secret>" -H "Content-Type: application/json" \
  -d '{"payload": {"code": "فاتورة", "function": "document_info", "synonyms": "invoice",
       "requires_linked_contact": 1, "allowed_party_types": ["Customer"],
       "disabled_inputs": ["document_type", "party_field"],
       "templates": [{"param": "msg_result", "language": "ar", "text": "فاتورتك {{ name }}: {{ status }}"}]}}'
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
await sanad.ui.call("commands.set_status", { name: "فاتورة", status: "Active" });
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
await sanad.ui.call("commands.set_status_many", { names: ["فاتورة", "فحص"], status: "Inactive" });
```

---

## restore_defaults

Drop the command's own message texts (`templates`) and parameter values (`settings_overrides`), so
it uses the function's again.

- **Path:** `whatsapp_next.api.v1.commands.restore_defaults`
- **Methods:** POST
- **Roles:** `MANAGER`

| Argument | Type | Required | Meaning |
|---|---|---|---|
| `name` | str | yes | Command name. |

Sets `defaults_restored_at`. Audited `Command Defaults Restored`. `disabled_inputs`,
`disabled_replies` and `ask_inputs` are kept.

**Returns**

```json
{ "templates": [], "settings_overrides": {} }
```

**Errors:** `WANotFoundError` (404); `WAStateConflictError` (409) — the command is `Active`.

**Realtime:** none.

```js
await sanad.ui.call("commands.restore_defaults", { name: "فاتورة" });
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
| `text` | str | yes | The message, e.g. `فاتورة SINV-0001`. |
| `sender_phone` | str | yes | Number or JID the message is "from"; its Contact is resolved by phone. |
| `device` | str | optional | Default: the Settings default device. |

**Returns**

```json
{
  "matched": true,
  "status": "Executed",
  "command": "فاتورة",
  "block_reason": null,
  "args": { "party_type": "Customer", "party": "CUST-0001", "document_name": "SINV-0001" },
  "reply_body": "فاتورة SINV-0001\nالحالة: Paid\n…",
  "replies": [{ "output_key": "result_text", "message_type": "Text", "body": "فاتورة SINV-0001\n…", "attachment": null }],
  "error": null,
  "function_ms": 42
}
```

- `status`: `None`, `Not Matched`, `Blocked`, `Executed` or `Failed`; `matched` is true for
  anything but `None` / `Not Matched` (a `Blocked` command is matched). A dry run never asks for a
  missing value: a required one still empty is `Failed` (`… is required`).
- `block_reason`: one of the access-check reasons above.
- `args`: every value the script received, after merging and defaults.
- `reply_body`: the first reply with a body; `replies` may include the unknown-command reply when
  Settings define one. Each reply's `output_key` is its `@reply` key (or `error`, `blocked`,
  `help`, `unknown`).
- A `report` reply is not printed: it comes back as `message_type: "Document"` with
  `attachment: null` and `report_name, filters, format, file_name`.
- `function_ms`: elapsed routing time in ms.
- The script really runs (as the Command Service User), but the run is **not** counted in the
  function's `call_count` / `avg_ms` / `error_count`.

**Errors**

| Exception | HTTP | When |
|---|---|---|
| `WAInvalidPhoneError` | 417 | `sender_phone` is not a valid number / JID. |
| `WAValidationError` | 417 | `Message text is required`. |
| `WAStateConflictError` | 409 | The Command Service User is not configured, disabled, or a System Manager (raised when a matched command reaches its function). |

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
    "name": "فاتورة", "code": "فاتورة", "title": "حالة الفاتورة", "function": "document_info", "status": "Inactive",
    "synonyms": ["invoice"], "requires_linked_contact": 1, "allowed_party_types": ["Customer"],
    "disabled_inputs": ["document_type", "party_field"], "ask_inputs": "",
    "settings_overrides": {}, "templates": [{ "param": "msg_result", "language": "ar", "text": "…" }],
    "disabled_replies": [],
    "access": { "Customer": { "mode": "Deny All", "groups": [{ "name": "VIP", "label": "VIP" }], "contacts": [{ "name": "Ahmed Ali", "label": "Ahmed Ali", "phone": "+966500000002" }] } },
    "runs_30d": 12, "has_history": true
  },
  "functions": [{ "name": "document_info", "function_name": "حالة مستند", "server_script": "wa_fn_document_info", "status": "Active" }],
  "party_types": [{ "key": "Customer", "label": "Customer" }, { "key": "Supplier", "label": "Supplier" }, { "key": "Employee", "label": "Employee" }, { "key": "Sales Person", "label": "Sales Person" }, { "key": "User", "label": "User" }],
  "function": { /* get_function_spec of the command's function, or null */ }
}
```

A new command starts `Inactive` with empty values. `has_history` is true when inbound messages
already point at the command (it can then only be stopped, not deleted).

**Errors:** `WANotFoundError` (404) — unknown command, or its function is no longer installed.

**Realtime:** none.

```js
const ed = await sanad.ui.call("commands.get_editor", { name: "فاتورة" });
```

---

## get_function_spec

What the editor shows for one installed function, read from its installed header.

- **Path:** `whatsapp_next.api.v1.commands.get_function_spec`
- **Methods:** GET, POST
- **Roles:** `MANAGER`

| Argument | Type | Required | Meaning |
|---|---|---|---|
| `function` | str | yes | Installed function key. |

**Returns**

```json
{
  "name": "document_info", "function_name": "حالة مستند", "description": "…", "status": "Active",
  "version": "1.0.0", "server_script": "wa_fn_document_info", "available": true, "reasons": [],
  "party_types": { "mode": "only", "types": ["Customer", "Supplier"] }, "party_types_text": "Customer, Supplier",
  "inputs": [{ "key": "document_name", "label": "رقم المستند", "type": "str", "required": true, "options": null, "choices": [], "position": 1 }],
  "settings": [{ "key": "document_type", "label": "نوع المستند", "fieldtype": "Link", "options": "DocType", "choices": [],
                 "required": false, "depends_on": null, "header_default": null, "default_value": null }],
  "templates": [{ "key": "msg_result", "label": "رسالة حالة المستند", "default": "…", "defaults_by_lang": {}, "site": null, "vars": [] }],
  "replies": [{ "key": "result_text", "type": "text", "report_name": null, "format": null, "label": "…" }]
}
```

- `inputs` and `settings` both list the typed `source=command` parameters (not the party, not a
  Template), in header order: `inputs` as the router reads them (`type` is `str`, `int`, `date`,
  `link`, `check` or `select`; `required` is true only for a required parameter with no default),
  `settings` as the editor's value form (`default_value` is the site's value when set, else the
  header default).
- `templates` are the Template parameters: the header's `default` and `defaults_by_lang`, the
  site's text (`site`: a text or `{language: text}`) and the `@var` values the text may use.
- `available` / `reasons` come from `@requires`.

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
{ "name": "فاتورة", "status": "Active" }
```

**Errors:** `WAValidationError` (417) — `Unknown payload keys`, `Unknown status …`, and every
`save_command` validation; `WANotFoundError` (404).

**Realtime:** none.

```js
await sanad.ui.call("commands.save_editor", { payload: { name: "فاتورة", synonyms: "فاتورتي\ninvoice", status: "Active" } });
```

---

## preview_command

Dry-run the editor's draft (saved or not) for an assumed sender — nothing saved, nothing sent.

- **Path:** `whatsapp_next.api.v1.commands.preview_command`
- **Methods:** POST
- **Roles:** `MANAGER`

| Argument | Type | Required | Meaning |
|---|---|---|---|
| `payload` | dict | yes | Editor payload (`name` and `status` are ignored for the draft). |
| `sender` | dict | optional | `{contact, party_type, party_name, phone, label}`. `party_*` count only with a `contact`, and must be one of that contact's own links; without them the party is the one the router would pick for that contact. |
| `values` | dict | optional | `{param: text}` for the inputs, used to build the message text. |

The text is built as `<code> <value> …` in input order (disabled, fixed and empty inputs
skipped); then the access checks, argument parsing, value merging, the script and the replies run
with `dry_run`, in the reply language. Messages Frappe would otherwise queue for the Desk are
discarded; failures are in the result.

**Returns**

```json
{
  "text": "فاتورة SINV-0001",
  "status": "Executed",
  "block_reason": null,
  "reply_sent": true,
  "args": { "party_type": "Customer", "party": "CUST-0001", "document_name": "SINV-0001" },
  "missing": [],
  "replies": [{ "output_key": "result_text", "message_type": "Text", "body": "…", "attachment": null }],
  "error": null
}
```

- `status`: `Blocked`, `Failed` (a value not allowed, a required value missing, or the script's
  error) or `Executed`. `Blocked` with `Not Linked` when the function needs a party and the sender
  has none.
- `missing`: required inputs with no value and no default, `[{key, label}]`.
- On `Blocked`, `replies` holds the refusal text and `reply_sent` says whether a live route would
  send it (Settings `send_receipt_reply`).
- A `report` reply is not printed (see `test_command`).

**Errors**

| Exception | HTTP | When |
|---|---|---|
| `WAValidationError` | 417 | `payload must be an object`; `Unknown payload keys`; `Pick a function first`; `sender.party_*` not linked to `sender.contact`. |
| `WANotFoundError` | 404 | `sender.contact` or the function does not exist. |
| `WAStateConflictError` | 409 | Command Service User not usable (when the script is reached). |

**Realtime:** none. As with `test_command`, the run is not counted in the function's metrics.

```js
const p = await sanad.ui.call("commands.preview_command", {
  payload: { code: "فاتورة", function: "document_info", allowed_party_types: ["Customer"] },
  sender: { contact: "Ahmed Ali", party_type: "Customer", party_name: "CUST-0001" },
  values: { document_name: "SINV-0001" },
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
await sanad.ui.call("commands.delete_command", { name: "فاتورة" });
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

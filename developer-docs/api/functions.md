# Functions API (`functions.*`)

Module: `whatsapp_next/api/v1/functions.py` — the Functions Center: the function scripts of the
site with their install state, one function's header, diff-before-install, install / update /
remove, status, the site's parameter values and the "Try" run. Thin wrappers over
`whatsapp_next/services/functions_catalog.py` and `whatsapp_next/services/function_runner.py`.
Commands that call functions are managed through the [commands API](commands.md).

URL form, authentication, the error envelope, the role groups and the `names[]` bulk result shape
are in [README.md](README.md). Every endpoint also answers **403** (`WAPermissionError`) for a
missing role and **417** (`WAValidationError`) for an unknown, missing or untypeable argument.
Returns are shown as the value of the response's `message` key.

## How functions work

A **function** is a Frappe **Server Script** — nothing else (no Python handler in an app, no
catalog file, no hook). A Server Script is a function when it is:

- Script Type **API**,
- its **API Method starts with `wa_fn_`** (`function_header.API_PREFIX`),
- **enabled**,
- and its script starts with a valid **`WA-FUNCTION` comment header**.

The full authoring guide (header tags, the run contract, the sandbox limits and a minimal example)
is in [commands-and-functions.md](../commands-and-functions.md) §2. In short:

1. **Discovery** — `functions_catalog.discover()` reads every matching Server Script and parses its
   header (`services/function_header.py`). The result is cached under `wa:functions:scripts` per
   `name + modified`; the `Server Script` `on_update` / `on_trash` doc events clear it. A script
   whose header does not parse is listed with the error and the line it comes from; two scripts
   declaring the same `@function` are both marked invalid.
2. **The installed row** — `WhatsApp Function` (name = the header's `@function`), created by
   `install`: `server_script` (the Link), `manifest` (the header as a JSON spec), `manifest_checksum`
   (sha256 of the header text only — a change in the code below the header is not an update) and
   `values` (the site's values of the header's parameters, JSON). `installed_version` is `@version`.
3. **The run** — `function_runner.run_function` calls Frappe's `run_script(server_script, **params)`:
   the parameters land in `frappe.form_dict`, and the script answers by setting
   `frappe.flags.wa_result = {"error", "messages", "data"}`. Every message must name a declared
   `@reply`; anything else fails the run and nothing is sent.

**Safety (§7).**

- Every function script starts, right after the header, with the guard
  `if (frappe.form_dict.get("cmd") or "").startswith("wa_fn_"): frappe.throw("Not allowed", frappe.PermissionError)`.
  Calling `/api/method/wa_fn_…` directly puts the script's own method in `cmd`, so the guard stops
  it for every user, Administrator included; the router passes `cmd=None`. `install` and `update`
  refuse a script without the guard (`function_header.guard_present`, within 40 lines after
  `END WA-FUNCTION`).
- No endpoint of this app has a method name starting with `wa_fn_`.
- A command stores a function **key**; the router reads the `server_script` from the installed row
  and never runs a path taken from a request or a message.
- The function runs **as the Command Service User** (WhatsApp Settings; enabled, not
  Administrator, not a System Manager), and never sends — the router turns its messages into
  replies and hands them to the dispatcher.
- Live routing runs only in the worker; the "Try" run (`try_function`) rolls back to a savepoint.

**States** in the storefront (`state`): `available`, `unavailable` (an `@requires` not met here;
`reasons[]`), `invalid` (header error, or a duplicate `@function`; `error`), `update` (installed,
and the script's header checksum differs), `missing` (installed, but the script is gone, disabled
or no longer a function).

---

## get_catalog

Every function script of the site merged with its install state.

- **Path:** `whatsapp_next.api.v1.functions.get_catalog`
- **Methods:** GET, POST
- **Roles:** `VIEWER_UP`

No arguments.

**Returns**

```json
{
  "entries": [
    {
      "function_key": "party_balance", "function_name": "استعلام عن رصيد",
      "description": "رصيد الأستاذ المساعد بعملة الشركة من تقرير Trial Balance for Party",
      "version": "2.2.0", "server_script": "wa_fn_party_balance",
      "party_types": { "mode": "all", "types": [] }, "party_types_text": "All",
      "requires": [{ "kind": "report", "name": "Trial Balance for Party" }],
      "replies": [{ "key": "result_text", "type": "text", "report_name": null, "format": null, "label": "الرصيد (من msg_result)" }],
      "state": "available", "error": null, "available": true, "reasons": [], "guarded": true,
      "installed": true, "installed_version": "2.2.0", "status": "Active", "update_available": false,
      "commands_count": 1, "calls_30d": 14
    }
  ],
  "checked_at": "2026-10-13 10:00:00"
}
```

- Entries are sorted by `function_name` (case-folded).
- `guarded` says whether the script carries the direct-URL guard (an unguarded script cannot be
  installed).
- A `missing` entry carries only `function_key, function_name, server_script, state, error,
  available, reasons, installed, installed_version, status, update_available, replies, requires`.
- `commands_count` counts `WhatsApp Command` rows using the function (any status); `calls_30d` sums
  their runs in the last 30 days (`command_router.recent_run_counts`: not Blocked, not simulated).

**Realtime:** none.

```bash
curl "https://site/api/method/whatsapp_next.api.v1.functions.get_catalog" -H "Authorization: token <api_key>:<api_secret>"
```

---

## get_manifest

One function's header for the detail panel and its settings form: an installed function by
`function_key` (its **installed** header, with the site's value of each parameter), or a script not
installed yet by `server_script`.

- **Path:** `whatsapp_next.api.v1.functions.get_manifest`
- **Methods:** GET, POST
- **Roles:** `VIEWER_UP`

| Argument | Type | Required | Meaning |
|---|---|---|---|
| `function_key` | str | one of the two | Installed function key. |
| `server_script` | str | one of the two | Server Script name, for a function not installed. |

**Returns**

```json
{
  "function_key": "party_balance", "function_name": "استعلام عن رصيد", "description": "…", "version": "2.2.0",
  "party_types": { "mode": "all", "types": [] }, "party_types_text": "All",
  "requires": [{ "kind": "report", "name": "Trial Balance for Party" }],
  "params": [
    { "name": "company", "fieldtype": "Link", "options": "Company", "required": false, "source": "command",
      "default": "@default_company", "defaults_by_lang": {}, "label": "الشركة", "select_options": null,
      "depends_on": null, "value": "SANAD Digital (Demo)", "vars": [] },
    { "name": "msg_result", "fieldtype": "Template", "…": "…", "default": "*رصيد حسابكم*\n…",
      "value": null, "vars": [{ "name": "balance_formatted", "label": "…", "messages": ["msg_result"] }] }
  ],
  "sender_params": [{ "name": "party_type", "source": "sender", "…": "…" }, { "name": "party", "…": "…" }],
  "replies": [{ "key": "result_text", "type": "text", "…": "…" }],
  "vars": [{ "name": "party", "label": "…", "messages": ["all"] }],
  "server_script": "wa_fn_party_balance", "available": true, "reasons": [],
  "installed": {
    "installed_version": "2.2.0", "installed_at": "…", "installed_by": "manager@example.com", "status": "Active",
    "update_available": false, "call_count": 12, "avg_ms": 35, "error_count": 1, "last_called_at": "…", "last_error": null
  }
}
```

- `params` are the parameters a command or the site sets (`source=command`); `sender_params` are
  the sender's party (`source=sender`), filled only from the Contact.
- A Template parameter carries `vars`: the `@var` values its text may use.
- `installed` is `{}` for a script not installed.

**Errors:** `DoesNotExistError` (404) — `function_key` not installed and no `server_script`;
`WANotFoundError` (404) — no such Server Script; `WAValidationError` (417) — the script is not a
function (type / method prefix) or its header does not parse.

**Realtime:** none.

```js
const m = await sanad.ui.call("functions.get_manifest", { function_key: "party_balance" });
```

---

## preview_install

What installing, or updating from, a script would change.

- **Path:** `whatsapp_next.api.v1.functions.preview_install`
- **Methods:** GET, POST
- **Roles:** `MANAGER`

| Argument | Type | Required | Meaning |
|---|---|---|---|
| `server_script` | str | yes | Server Script name. |

**Returns**

```json
{
  "function_key": "party_balance",
  "server_script": "wa_fn_party_balance",
  "installed_version": "2.1.0",
  "target_version": "2.2.0",
  "changed": true,
  "params": { "added": ["show_zero_values"], "removed": [], "changed": [{ "name": "to_date", "fields": { "default": [null, "today"] } }] },
  "replies": { "added": [], "removed": [], "changed": [] },
  "commands_impacted": ["رصيد"],
  "available": true,
  "reasons": []
}
```

- `params` diff by `name` over `fieldtype, options, required, source, default, defaults_by_lang,
  label, select_options, depends_on`; `replies` by `key` over `type, report_name, format, label`.
  `changed[].fields` maps each field to `[current, target]`.
- `changed` is false when the installed checksum equals the script's.
- For a function not installed, every parameter and reply is `added`, `installed_version` is `null`
  and `commands_impacted` is empty.

**Errors:** `WANotFoundError` (404) — no such Server Script; `WAValidationError` (417) — not a
function script, or the header does not parse.

**Realtime:** none.

```js
const d = await sanad.ui.call("functions.preview_install", { server_script: "wa_fn_party_balance" });
```

---

## install

Install the function a Server Script declares, `Active`.

- **Path:** `whatsapp_next.api.v1.functions.install`
- **Methods:** POST
- **Roles:** `MANAGER`

| Argument | Type | Required | Meaning |
|---|---|---|---|
| `server_script` | str | yes | Server Script name. |

The row is named after `@function`; `values` start empty (every parameter takes the header's
default). Audited `Function Installed` with `details {version, server_script}`.

**Returns**

```json
{ "name": "party_balance", "installed_version": "2.2.0" }
```

**Errors**

| Exception | HTTP | When |
|---|---|---|
| `WAStateConflictError` | 409 | `@function` already installed (use `update`). |
| `WAValidationError` | 417 | Not an API script with a `wa_fn_` method; header error; script disabled; an `@requires` not met here; no direct-URL guard; another script declares the same `@function`. |
| `WANotFoundError` | 404 | No such Server Script. |

**Realtime:** none.

```bash
curl -X POST "https://site/api/method/whatsapp_next.api.v1.functions.install" \
  -H "Authorization: token <api_key>:<api_secret>" -d server_script=wa_fn_ping
```

---

## update

Re-read the installed function's Server Script: its current header replaces the installed one.

- **Path:** `whatsapp_next.api.v1.functions.update`
- **Methods:** POST
- **Roles:** `MANAGER`

| Argument | Type | Required | Meaning |
|---|---|---|---|
| `function_key` | str | yes | Installed key. |

The site's `values` are kept for parameters that kept their name and dropped for the others;
`update_available` is cleared. The same checks as `install` apply, and the script must still declare
the same `@function`. Audited `Function Updated` with `details {from, to}`.

**Returns**

```json
{ "installed_version": "2.2.0", "previous_version": "2.1.0" }
```

**Errors:** `WANotFoundError` (404) — not installed, or its Server Script is gone;
`WAValidationError` (417) — the script now declares another `@function`, or an install check fails.

**Realtime:** none.

```js
await sanad.ui.call("functions.update", { function_key: "party_balance" });
```

---

## update_many

Bulk update from the scripts.

- **Path:** `whatsapp_next.api.v1.functions.update_many`
- **Methods:** POST
- **Roles:** `MANAGER`

| Argument | Type | Required | Meaning |
|---|---|---|---|
| `function_keys` | list[str] | yes | Installed keys. |

**Returns** — the bulk shape; a function whose script header has the installed checksum is
`skipped` with reason `already latest`; a key that is not installed is in `failed`
(`Function … is not installed`).

```json
{ "count": 1, "done": ["party_balance"], "failed": [], "skipped": [{ "name": "ping", "reason": "already latest" }] }
```

**Realtime:** none.

```js
await sanad.ui.call("functions.update_many", { function_keys: ["ping", "party_balance"] });
```

---

## check_updates

Clear the discovery cache and re-read every installed function's script now (the same job runs
daily from the scheduler).

- **Path:** `whatsapp_next.api.v1.functions.check_updates`
- **Methods:** POST
- **Roles:** `MANAGER`

No arguments. Sets `update_available` on each installed row whose script header checksum differs.

**Returns**

```json
{ "checked": 6, "updates": 1, "missing": 0 }
```

`missing` counts installed functions whose script is gone, disabled or no longer parses.

**Realtime:** none.

```js
await sanad.ui.call("functions.check_updates");
```

---

## remove

Delete an installed function (the Server Script itself is not touched).

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
await sanad.ui.call("functions.set_status_many", { function_keys: ["ping", "party_balance"], status: "Active" });
```

---

## save_values

Write the site's values of an installed function's parameters (the `values` JSON). Commands
override them per command (`settings_overrides`, `templates`); see the
[commands API](commands.md#how-commands-work).

- **Path:** `whatsapp_next.api.v1.functions.save_values`
- **Methods:** POST
- **Roles:** `MANAGER`

| Argument | Type | Required | Meaning |
|---|---|---|---|
| `function_key` | str | yes | Installed key. |
| `values` | dict | yes | `{param: value}` for `source=command` parameters only (never the sender's party). A value is checked and typed by the header (`function_header.coerce`; a Date may stay a date word such as `today`). A Template takes one text, or `{language: text}` with `""` meaning every language. An empty value removes the key, so the parameter returns to the header's default. |

**Returns** — every stored value after the save:

```json
{ "values": { "company": "SANAD Digital (Demo)", "msg_result": { "ar": "رصيدك: {{ balance_formatted }}" } } }
```

**Errors:** `WANotFoundError` (404) — not installed; `WAValidationError` (417) — `values must be an
object`, `Unknown parameters of function …`, or a value of the wrong type / not allowed.

**Realtime:** none.

```bash
curl -X POST "https://site/api/method/whatsapp_next.api.v1.functions.save_values" \
  -H "Authorization: token <api_key>:<api_secret>" -H "Content-Type: application/json" \
  -d '{"function_key": "party_balance", "values": {"company": "SANAD Digital (Demo)"}}'
```

---

## try_function

The Functions Center's **Try**: run the function as a command would, step by step — nothing sent,
nothing kept (the run happens inside a savepoint that is rolled back).

- **Path:** `whatsapp_next.api.v1.functions.try_function`
- **Methods:** POST
- **Roles:** `MANAGER`

| Argument | Type | Required | Meaning |
|---|---|---|---|
| `function_key` | str | yes | Installed key. |
| `party_type` | str | optional | The assumed sender's party type. |
| `party` | str | optional | The assumed sender's party (must exist). |
| `values` | dict | optional | `{param: value}` over the function's own values. |

Steps, stopping at the first failure: **Header** (the script still parses; if its checksum differs
from the installed one, an "Installed header" note is added and the installed header is used) →
**Requirements (@requires)** → **Party type (@party_types)** → **Party** (exists) →
**Parameters** (merged and filled; required ones still empty fail) → **Run** (as the Command
Service User; its time in ms) → **Replies (@reply)** (the messages validated).

**Returns**

```json
{
  "steps": [
    { "name": "Header", "ok": true, "detail": "party_balance 2.2.0" },
    { "name": "Requirements (@requires)", "ok": true, "detail": "Available" },
    { "name": "Party type (@party_types)", "ok": true, "detail": "Customer" },
    { "name": "Parameters", "ok": true, "detail": "8 values" },
    { "name": "Run", "ok": true, "detail": "84 ms" },
    { "name": "Replies (@reply)", "ok": true, "detail": "1 messages" }
  ],
  "params": { "party_type": "Customer", "party": "CUST-0001", "company": "…", "to_date": "2026-10-13", "…": "…" },
  "missing": [],
  "messages": [{ "reply": "result_text", "type": "text", "text": "*رصيد حسابكم*\n…" }],
  "error": null
}
```

A `report` message appears validated (`report_name, filters, format, file_name, caption`) but is
not printed. The call does not count in the function's metrics.

**Errors:** `WANotFoundError` (404) — not installed. Everything else comes back as a failed step,
not an error: a header that no longer parses, an unusable Command Service User or a script that
raises (**Run**, with the exception's type and message), a message the header did not declare.

**Realtime:** none.

```js
const t = await sanad.ui.call("functions.try_function", {
  function_key: "party_balance", party_type: "Customer", party: "CUST-0001", values: { to_date: "today" },
});
```

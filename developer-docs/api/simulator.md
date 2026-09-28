# simulator

Module `whatsapp_next/api/v1/simulator.py`. These endpoints serve the WhatsApp Simulator page.
They are thin wrappers over `services/simulator.py`:

- **Simulate inbound** ("message on behalf of"): stored as `is_simulated` rows and routed through
  the command router in **dry-run**. Replies are stored as `is_simulated` outbound rows and are
  **never sent**.
- **Test send**: a real send of one `is_test` message by a background job, bypassing the queue.
- **Dry-run command**: nothing is stored and nothing is sent. It shares its code with
  `commands.test_command` (see [commands.md](commands.md)).

Conventions are in [README.md](README.md).

The command-route fields in the responses below are:

- `status` / `command_status`: `None`, `Not Matched`, `Blocked`, `Matched`, `Executed`, or
  `Failed`.
- `replies[]`: `{output_key, message_type, body, attachment}`.
- `function_ms`: the time the function took.

---

## get_context

The Simulator page's bootstrap.

- **Path:** `whatsapp_next.api.v1.simulator.get_context`
- **Methods:** GET, POST
- **Roles:** `AGENT_UP`

Arguments: none.

**Returns:**

- `devices`: enabled devices, default first.
- `commands`: `Active` commands, by `code`.
- `commands_enabled`: Settings → `enable_commands`.
- `sample_contacts`: the 10 most recently seen individual WhatsApp Numbers.

```json
{
  "devices": [{"name": "WA-DEV-001", "device_name": "Sales", "status": "Connected", "is_default": 1, "phone_e164": "+966500000001"}],
  "default_device": "WA-DEV-001",
  "commands": [{"name": "balance", "code": "balance", "title": "Balance", "function": "…",
                "synonyms": "رصيد", "description": null, "requires_linked_contact": 1}],
  "commands_enabled": true,
  "sample_contacts": [{"phone_e164": "+966501234567", "display_name": "Ali", "contact": "Ali Saleh",
                       "link_status": "Linked", "last_seen": "…"}]
}
```

**Errors:** `WAPermissionError` (403).

```bash
curl -s "https://<site>/api/method/whatsapp_next.api.v1.simulator.get_context" \
  -H "Authorization: token <api_key>:<api_secret>"
```

---

## simulate_inbound

Stores `text` as a simulated inbound message from `sender_phone` to `device`
(`provider_message_id` starts with `sim-`), then optionally runs the command router in dry-run.
Replies are stored as `is_simulated` outbound rows and are never queued or sent.

- **Path:** `whatsapp_next.api.v1.simulator.simulate_inbound`
- **Methods:** POST
- **Roles:** `AGENT_UP`

| Argument | Type | Required / default | Meaning |
|---|---|---|---|
| `device` | str | required | `WhatsApp Device` name. It must exist, but it doesn't need to be connected. |
| `sender_phone` | str | required | A number, or a group or LID JID |
| `text` | str | required | Non-blank message text |
| `run_commands` | bool | `true` | When false, only the inbound row is stored, with `command_status` `None` |

**Returns.**

- `reply_outbound` is the first stored reply row, and `reply_outbounds` lists all of them.
- `reply_body` joins the reply bodies with blank lines.

```json
{
  "inbound": "9z8y7x6w5v", "command_status": "Executed", "command": "balance",
  "block_reason": null, "args": {},
  "reply_outbound": "c1d2e3f4a5", "reply_outbounds": ["c1d2e3f4a5"],
  "reply_body": "Your balance is 1,150.00 SAR",
  "replies": [{"output_key": "text", "message_type": "Text", "body": "Your balance is 1,150.00 SAR", "attachment": null}],
  "error": null, "function_ms": 42
}
```

**Errors:**

| Exception | HTTP | When |
|---|---|---|
| `WAValidationError` | 417 | "Message text is required", or an unknown device ("WhatsApp Device … not found") |
| `WAInvalidPhoneError` | 417 | "Invalid sender number: …" |

A failure inside a command function is reported in `error` and `command_status: "Failed"`. It
isn't raised.

```js
const r = await sanad.ui.call("simulator.simulate_inbound", {
  device: "WA-DEV-001", sender_phone: "+966501234567", text: "balance",
});
```

---

## send_test

Creates an `is_test` outbound (`source_type = "Simulator"`) and starts the
`dispatch.send_test_message` job (`short` queue, job id `wa-test-<outbound>`). The job sends it
once, straight to the provider, **bypassing the queue**. The known-number policy is skipped.
Audited as `Test Send`.

- **Path:** `whatsapp_next.api.v1.simulator.send_test`
- **Methods:** POST
- **Roles:** `AGENT_UP`

| Argument | Type | Required / default | Meaning |
|---|---|---|---|
| `device` | str | required | Sending device |
| `phone` | str | required | Recipient |
| `body` | str | required for `text`; otherwise optional | Text, or the caption of a file or contact card |
| `kind` | str | `text` | `text`, `image`, `video`, `document`, `audio`, `location`, or `contact` |
| `attachment` | str | required for file kinds | URL of an uploaded `File` whose MIME type fits the kind |
| `contact` | str | required for `contact` | Contact to share, stored as a private `.vcf` and sent as a Document |
| `location` | dict | required for `location` | `{latitude, longitude, name?, address?}`. The latitude must be in −90…90 and the longitude in −180…180. |

**Returns:** `{"outbound": "d4e5f6a7b8"}`

**Errors:**

| Exception | HTTP | When |
|---|---|---|
| `WAValidationError` | 417 | An unknown kind, "Message text is required", "Upload the file to send", "Pick the contact to share", or a bad or out-of-range location |
| `WAFileError` | 417 | The file is missing, or its MIME type doesn't fit the kind |
| `WAInvalidPhoneError` | 417 | The phone doesn't parse |
| `WABlacklistedError` | 417 | The number is on the global blacklist |
| `WADeviceOfflineError` | 409 | Unknown device, or no device configured |

**Realtime:** The job publishes `wa:message:status` as the row goes to `Sent` or `Failed`.

```bash
curl -s -X POST "https://<site>/api/method/whatsapp_next.api.v1.simulator.send_test" \
  -H "Authorization: token <api_key>:<api_secret>" -H "Content-Type: application/json" \
  -d '{"device": "WA-DEV-001", "phone": "+966501234567", "kind": "location",
       "location": {"latitude": 24.7136, "longitude": 46.6753, "name": "Office"}}'
```

---

## dry_run_command

Routes `text` from `sender_phone` through the command router on an **in-memory** inbound message.
Nothing is stored and nothing is sent. It shares its code with `commands.test_command`.

- **Path:** `whatsapp_next.api.v1.simulator.dry_run_command`
- **Methods:** POST
- **Roles:** `MANAGER`

| Argument | Type | Required / default | Meaning |
|---|---|---|---|
| `text` | str | required | Non-blank message |
| `sender_phone` | str | required | A number, or a group or LID JID |
| `device` | str | optional | The default is Settings → default device |

**Returns.** `matched` is true unless the status is `None` or `Not Matched`. `reply_body` is the
first reply that has a body.

```json
{"matched": true, "status": "Executed", "command": "balance", "block_reason": null, "args": {},
 "reply_body": "Your balance is 1,150.00 SAR",
 "replies": [{"output_key": "text", "message_type": "Text", "body": "Your balance is 1,150.00 SAR", "attachment": null}],
 "error": null, "function_ms": 38}
```

**Errors:** `WAInvalidPhoneError` (417) "Invalid sender number: …". `WAValidationError` (417)
"Message text is required".

```js
const r = await sanad.ui.call("simulator.dry_run_command", { text: "balance", sender_phone: "0501234567" });
```

---

## list_conversations

Returns the simulator's conversation rail: individual WhatsApp Numbers, most recently seen first,
each with its party type and a one-line preview of the last message in either direction.

- **Path:** `whatsapp_next.api.v1.simulator.list_conversations`
- **Methods:** GET, POST
- **Roles:** `AGENT_UP`

| Argument | Type | Required / default | Meaning |
|---|---|---|---|
| `txt` | str | optional | Matches `phone_e164` or `display_name` |
| `limit` | int | `30` | Clamped to 1–100 |

**Returns.** `party_type` is the contact's first account link (`Customer`, `Supplier`, …), or
`null`. `last_body` is at most 120 characters: the body, or the message type. `last_at` falls
back to `last_seen`. `total` counts every match, not only the rows returned.

```json
{"rows": [{"name": "+966501234567", "phone_e164": "+966501234567", "display_name": "Ali",
           "contact": "Ali Saleh", "link_status": "Linked", "last_seen": "…", "last_direction": "Inbound",
           "outbound_count": 12, "inbound_count": 9, "party_type": "Customer",
           "last_body": "balance", "last_at": "…"}],
 "total": 57}
```

**Errors:** `WAValidationError` (417) for a non-integer `limit`.

```js
const list = await sanad.ui.call("simulator.list_conversations", { txt: "ali" });
```

---

## get_identity

Returns the "who is this" panel for one number: name, link status, message counts, account links,
and the contact groups the number belongs to.

- **Path:** `whatsapp_next.api.v1.simulator.get_identity`
- **Methods:** GET, POST
- **Roles:** `AGENT_UP`

| Argument | Type | Required / default | Meaning |
|---|---|---|---|
| `phone_e164` | str | required | An individual number, in any parsable form |

**Returns.** `link_status` falls back to `Linked` or `Not Linked` for a number without a WhatsApp
Number row.

```json
{"phone_e164": "+966501234567", "name": "Ali", "contact": "Ali Saleh", "party_type": "Customer",
 "link_status": "Linked", "outbound_count": 12, "inbound_count": 9, "last_seen": "…",
 "accounts": [{"doctype": "Customer", "name": "CUST-0042", "title": "Ali Trading"}],
 "groups": [{"name": "VIP", "label": "VIP", "kind": "Marketing", "member_count": 120}]}
```

**Errors:** `WAInvalidPhoneError` (417) when the value isn't an individual number (a group JID is
refused too).

```bash
curl -s "https://<site>/api/method/whatsapp_next.api.v1.simulator.get_identity?phone_e164=%2B966501234567" \
  -H "Authorization: token <api_key>:<api_secret>"
```

# messages

Module `whatsapp_next/api/v1/messages.py`. These endpoints serve the Outbound and Inbound lists
and the message drawer. Reads return explicit field lists and never raw payloads. The
conversation goes through the unified read layer, which is the only place both directions are
read together. Resend and cancel go through the dispatcher, the single status writer.
`resend_many` is the bulk variant (README §7).

Outbound (`WhatsApp Log`) and inbound (`WhatsApp Inbound Message`) rows are named by hash.
Outbound statuses: `Unsent`, `Queued`, `Sending`, `Held`, `Sent`, `Delivered`, `Read`, `Failed`,
`Cancelled`. Terminal statuses: `Sent`, `Delivered`, `Read`, `Failed`, `Cancelled`.

Conventions are in [README.md](README.md).

---

## get_outbound

Returns the drawer payload for one outbound row: its fields, the reference document with its
amount, and a timeline made of the queue item and the webhook events (never their payloads).

- **Path:** `whatsapp_next.api.v1.messages.get_outbound`
- **Methods:** GET, POST
- **Roles:** `VIEWER_UP`, plus document read permission on the `WhatsApp Log` row

| Argument | Type | Required / default | Meaning |
|---|---|---|---|
| `name` | str | required | `WhatsApp Log` name |

**Returns.** The row's fields:

- Recipient: `name, creation, modified, owner, device, requested_device, device_fallback,
  recipient_type, phone, phone_e164, jid, display_name, contact`.
- Content: `message_type, body, caption, attachment, file_name, mime_type, view_once,
  print_format, letter_head, language`, the `location_*` fields, and the `poll_*` fields
  (including `poll_id`).
- Status: `status, scheduled_at, queued_at, sent_at, delivered_at, read_at, failed_at,
  cancelled_at, held_at, held_reason, error_code, error_message, attempts`.
- Origin: `source_type, reference_doctype, reference_name, template, campaign,
  campaign_recipient, campaign_message_idx, notification, notification_alert, command,
  trigger_inbound, is_test, is_simulated`.
- Queue and provider: `queue_item, provider, provider_message_id, platform_queue_id,
  platform_message_log`.

Two keys are added:

- `reference`: `{doctype, name, amount}`. `amount` is the first of `grand_total`,
  `rounded_total`, `amount`, or `total` that the DocType has, otherwise `null`.
- `timeline`: `{queue_item, webhook_events[]}`. The queue item carries `name, status, priority,
  scheduled_at, attempts, max_attempts, next_attempt_at, last_error_code, last_error, claimed_at,
  batch_id, platform_queue_id`, the pause and delete fields, `dead_letter_reason, completed_at,
  creation, modified`. The events are ordered by `received_at` and carry `name, event_name,
  event_id, received_at, event_timestamp, status, error, processed_at, signature_valid,
  duplicate_count`.

```json
{
  "name": "a1b2c3d4e5", "status": "Delivered", "device": "WA-DEV-001",
  "phone_e164": "+966501234567", "message_type": "Text", "body": "Your order has shipped.",
  "source_type": "Quick Send", "sent_at": "…", "delivered_at": "…", "…": "…",
  "reference": {"doctype": "Sales Order", "name": "SAL-ORD-2026-00017", "amount": 1150.0},
  "timeline": {
    "queue_item": {"name": "f6a7b8c9d0", "status": "Completed", "priority": 1, "attempts": 1, "…": "…"},
    "webhook_events": [{"name": "…", "event_name": "message.delivered", "status": "Processed", "…": "…"}]
  }
}
```

**Errors:** `WANotFoundError` (404) for an unknown name (checked before permission).
`WAPermissionError` (403) without read on the row.

```bash
curl -s "https://<site>/api/method/whatsapp_next.api.v1.messages.get_outbound?name=a1b2c3d4e5" \
  -H "Authorization: token <api_key>:<api_secret>"
```

---

## get_inbound

Returns one inbound row with its command trace, the reply it triggered, and a projection that is
safe for realtime.

- **Path:** `whatsapp_next.api.v1.messages.get_inbound`
- **Methods:** GET, POST
- **Roles:** `VIEWER_UP`, plus document read permission on the row

| Argument | Type | Required / default | Meaning |
|---|---|---|---|
| `name` | str | required | `WhatsApp Inbound Message` name |

**Returns.** The row's fields: `name, creation, device, phone, phone_e164, jid, chat_jid,
sender_jid, is_group, display_name, contact, message_type, body, caption, media_url,
media_mime_type, attachment, location_latitude, location_longitude, location_name, reaction,
reaction_to_provider_message_id, quoted_provider_message_id, provider_message_id, received_at,
webhook_event, is_simulated, replied_at`. Three keys are added:

- `command_trace`: `{command_status, command, command_text, command_args, command_error,
  block_reason}`.
- `reply_outbound`: `{name, status, body, message_type, sent_at, error_code, creation}` of the
  reply, or `null`.
- `ui`: `{name, device, message_type, body, display_name, contact, received_at, is_group,
  command_status}`.

```json
{
  "name": "9z8y7x6w5v", "device": "WA-DEV-001", "phone_e164": "+966501234567", "is_group": 0,
  "message_type": "Text", "body": "balance", "received_at": "…", "…": "…",
  "command_trace": {"command_status": "Executed", "command": "balance", "command_text": "balance",
                    "command_args": null, "command_error": null, "block_reason": null},
  "reply_outbound": {"name": "…", "status": "Sent", "body": "Your balance is …", "message_type": "Text",
                     "sent_at": "…", "error_code": null, "creation": "…"},
  "ui": {"name": "9z8y7x6w5v", "device": "WA-DEV-001", "command_status": "Executed", "…": "…"}
}
```

**Errors:** `WANotFoundError` (404). `WAPermissionError` (403).

```js
const row = await sanad.ui.call("messages.get_inbound", { name: "9z8y7x6w5v" });
```

---

## get_conversation

Returns the messages exchanged with one key, in both directions, newest first, through the read
layer. Paging uses a keyset cursor.

- **Path:** `whatsapp_next.api.v1.messages.get_conversation`
- **Methods:** GET, POST
- **Roles:** no role gate. The caller needs **read on both** `WhatsApp Log` and `WhatsApp Inbound
  Message`, so a Contact User without Viewer is refused.

| Argument | Type | Required / default | Meaning |
|---|---|---|---|
| `key` | str | required | E.164 number or group/LID JID, **exactly as stored**. It isn't normalised here. |
| `device` | str | optional | Restrict to one device |
| `before` | str | optional | A row's `cursor` (or a datetime). Returns rows older than it. |
| `limit` | int | `50` | Clamped to 1–500 |

**Returns.** Each row has the read layer's 16 columns plus `cursor`. `next_cursor` is the last
row's cursor when `has_more` is true.

```json
{
  "rows": [
    {"direction": "in", "name": "9z8y7x6w5v", "key": "+966501234567", "device": "WA-DEV-001",
     "ts": "2026-09-28 09:50:00", "creation": "…", "status": null, "message_type": "Text",
     "body": "balance", "caption": null, "display_name": "Ali", "contact": "Ali Saleh",
     "provider_message_id": "…", "attachment": null, "reference_doctype": null,
     "reference_name": null, "cursor": "…"}
  ],
  "has_more": true,
  "next_cursor": "…"
}
```

An empty `key` returns `{"rows": [], "has_more": false, "next_cursor": null}`.

**Errors:** `WAPermissionError` (403) "Not permitted to read conversations".

```js
let page = await sanad.ui.call("messages.get_conversation", { key: "+966501234567", limit: 30 });
if (page.has_more) page = await sanad.ui.call("messages.get_conversation", { key: "+966501234567", before: page.next_cursor });
```

---

## resend

Creates a **new** outbound row from a terminal one and queues it. The content, source, and
reference are copied, `attempts` starts at 0, and the priority is the source's. The original row
is left unchanged. All `send` checks run again: device, blacklist, known-number policy, and so on.

- **Path:** `whatsapp_next.api.v1.messages.resend`
- **Methods:** POST
- **Roles:** `AGENT_UP`

| Argument | Type | Required / default | Meaning |
|---|---|---|---|
| `name` | str | required | `WhatsApp Log` name in a terminal status |

**Returns:** `{"outbound": "<new WhatsApp Log>", "queue_item": "<WhatsApp Queue Item>"}`

**Errors:**

| Exception | HTTP | When |
|---|---|---|
| `WANotFoundError` | 404 | Unknown row |
| `WAStateConflictError` | 409 | The row is not terminal ("Only sent, failed or cancelled messages can be resent …") |
| `WABlacklistedError`, `WAUnknownNumberPolicyError`, `WAInvalidPhoneError`, `WAValidationError`, `WAFileError`, `WADeviceOfflineError` | 417 / 409 | The same checks as [quick_send.send](quick-send.md#send) |

```bash
curl -s -X POST "https://<site>/api/method/whatsapp_next.api.v1.messages.resend" \
  -H "Authorization: token <api_key>:<api_secret>" -d name=a1b2c3d4e5
```

---

## resend_many

The bulk form of `resend`. Terminal rows are resent one by one, each in its own savepoint.
Non-terminal rows are skipped, with their current status as the reason.

- **Path:** `whatsapp_next.api.v1.messages.resend_many`
- **Methods:** POST
- **Roles:** `AGENT_UP`

| Argument | Type | Required / default | Meaning |
|---|---|---|---|
| `names` | list[str] | required | `WhatsApp Log` names |

**Returns.** The bulk shape (README §7). `done` holds the **original** names. The new rows'
names are not returned.

```json
{"count": 1, "done": ["a1b2c3d4e5"], "failed": [{"name": "zzz", "error": "WhatsApp Log zzz not found"}],
 "skipped": [{"name": "b2c3d4e5f6", "reason": "Queued"}]}
```

**Errors:** Per row, in `failed`. A permission error aborts the call (403).

```js
const r = await sanad.ui.call("messages.resend_many", { names: ["a1b2c3d4e5", "b2c3d4e5f6"] });
```

---

## cancel  *(destructive)*

Cancels a queued or paused message. Its open queue rows become `Deleted` (a state change, never a
row removal), the outbound becomes `Cancelled`, and a linked campaign recipient becomes
`Cancelled`. Audited as `Queue Items Deleted`.

- **Path:** `whatsapp_next.api.v1.messages.cancel`
- **Methods:** POST
- **Roles:** `MANAGER`

| Argument | Type | Required / default | Meaning |
|---|---|---|---|
| `name` | str | required | `WhatsApp Log` name |
| `reason` | str | optional | Stored as the queue row's `delete_reason` |

**Returns:** `{"status": "Cancelled"}`. This is the outbound's status after the call.

**Errors:**

| Exception | HTTP | When |
|---|---|---|
| `WANotFoundError` | 404 | Unknown row |
| `WAStateConflictError` | 409 | No open (`Queued`, `Sending`, `Paused`) queue item ("… is not queued and cannot be cancelled"), or the item is `Sending` ("… being sent and cannot be deleted") |

**Realtime:** `wa:message:status` `{outbound, status: "Cancelled", …}`.

```bash
curl -s -X POST "https://<site>/api/method/whatsapp_next.api.v1.messages.cancel" \
  -H "Authorization: token <api_key>:<api_secret>" -d name=a1b2c3d4e5 -d reason="customer asked"
```

---

## get_inbound_summary

Returns the Inbound screen's figures over the last `days`, bucketed by `received_at`.

- **Path:** `whatsapp_next.api.v1.messages.get_inbound_summary`
- **Methods:** GET, POST
- **Roles:** `VIEWER_UP`

| Argument | Type | Required / default | Meaning |
|---|---|---|---|
| `days` | int | `30` | Window in days, including today. `0` or empty means all time. |

**Returns:**

- `by_status`: counts per `command_status`. A missing status has the key `"None"`.
- `matched`: rows whose status is Matched, Executed, Failed, or Blocked.
- `executed`: rows whose status is Executed.
- `unmatched`: rows whose status is `Not Matched`.
- `match_rate`: `matched × 100 / total`, rounded to 1 place, or `null`.
- `avg_reply_seconds`: the mean of `replied_at − received_at` over the newest replied rows (at
  most 5 000).
- `replies_measured`: how many rows went into that average.

```json
{"days": 30, "total": 420, "by_status": {"None": 300, "Executed": 100, "Not Matched": 20},
 "matched": 100, "executed": 100, "unmatched": 20, "match_rate": 23.8,
 "avg_reply_seconds": 3.42, "replies_measured": 100}
```

**Errors:** `WAValidationError` (417) for a non-integer `days`.

```js
const s = await sanad.ui.call("messages.get_inbound_summary", { days: 7 });
```

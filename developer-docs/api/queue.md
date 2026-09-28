# queue

Module `whatsapp_next/api/v1/queue.py`. These endpoints serve the Queue screen. They read
`WhatsApp Queue Item` rows with each row's position and ETA, and wrap the `services.dispatch`
queue operations: global pause, resume, and rate, and per-row pause, resume, delete, and retry.
Every state change goes through `dispatch`.

Queue item statuses: `Queued`, `Sending`, `Paused`, `Deleted`, `Completed`, `Dead Letter`.
Deleting a row is a **state change**. A row is never removed.

**Selections.** `pause_items`, `resume_items`, and `delete_items` take either `names[]`, which
wins when non-empty, or `filters` restricted to the keys `device`, `campaign`, and `phone_e164`
(exact match). Each operation acts only on the rows of the selection that are in the right source
state. Other rows are ignored and not reported. These endpoints return `{count}`, not the bulk
shape of README §7.

Conventions are in [README.md](README.md).

### The queue summary

`list_queue` returns this dict as `summary`, and `wa:queue:progress` carries it as its payload:

```json
{
  "device": null, "queued": 378, "sending": 0, "paused": 4, "dead_letter": 1, "completed": 9120,
  "held": 0, "sent_last_minute": null,
  "paused_globally": false, "paused_by": null, "paused_at": null, "pause_reason": null,
  "rate": 20, "plan_rate": 60
}
```

`held` counts `WhatsApp Log` rows in `Held`. `sent_last_minute` is filled only for a per-device
summary. `plan_rate` is `null` when the plan rate is unknown.

---

## list_queue

Returns queue rows, newest first, each with its position and ETA.

- **Path:** `whatsapp_next.api.v1.queue.list_queue`
- **Methods:** GET, POST
- **Roles:** `VIEWER_UP`

| Argument | Type | Required / default | Meaning |
|---|---|---|---|
| `filters` | dict | optional | Only these keys: `status` (one of the statuses above), `device`, `campaign`, and `phone` (a *contains* match on `phone_e164`) |
| `page` | int | 1 | 1-based page |
| `page_length` | int | 20 | Capped at 200 |

**Returns.** Each row has these fields: `name, outbound_message, device, campaign, phone_e164,
display_name, priority, scheduled_at, status, attempts, max_attempts, next_attempt_at,
last_error_code, last_error, claimed_at`, the pause, delete, and dead-letter fields,
`completed_at, creation`. Three fields are computed:

- `position`: the 1-based rank among the device's `Queued` rows, ordered by
  `(priority, scheduled_at, creation)`. It is `null` for other statuses.
- `eta_minutes`: `position ÷ rate`.
- `eta`: now + `eta_minutes`.

```json
{
  "rows": [{"name": "f6a7b8c9d0", "outbound_message": "a1b2c3d4e5", "device": "WA-DEV-001",
            "campaign": null, "phone_e164": "+966501234567", "display_name": "Ali", "priority": 1,
            "status": "Queued", "attempts": 0, "max_attempts": 3, "…": "…",
            "position": 3, "eta_minutes": 0.15, "eta": "2026-09-28 10:00:09"}],
  "total": 383,
  "summary": {"queued": 378, "…": "…"}
}
```

**Errors:** `WAValidationError` (417) "Unknown filters: …", or "Invalid value for status".

```bash
curl -s -G "https://<site>/api/method/whatsapp_next.api.v1.queue.list_queue" \
  -H "Authorization: token <api_key>:<api_secret>" \
  --data-urlencode 'filters={"status": "Dead Letter"}' --data-urlencode page_length=50
```

---

## get_limits

Returns the send rate the queue allows and the plan's ceiling. It makes no provider call, which
makes it cheap enough for a campaign form.

- **Path:** `whatsapp_next.api.v1.queue.get_limits`
- **Methods:** GET, POST
- **Roles:** `VIEWER_UP`

Arguments: none.

**Returns:** `{"rate": 20, "plan_rate": 60}` (`plan_rate` may be `null`)

**Errors:** `WAPermissionError` (403).

```js
const { rate, plan_rate } = await sanad.ui.call("queue.get_limits");
```

---

## get_summary

Returns counts by status, the global pause state, the rate and plan rate, and the provider's own
view of the queue.

- **Path:** `whatsapp_next.api.v1.queue.get_summary`
- **Methods:** GET, POST
- **Roles:** `VIEWER_UP`

Arguments: none.

**Returns.** `platform_queue` comes from the provider's `get_queue_status`, cached for 60 s. It is
`null` when the provider fails, and the failure is logged, not raised.

```json
{
  "counts_by_status": {"Queued": 378, "Sending": 0, "Paused": 4, "Dead Letter": 1, "Completed": 9120, "Held": 0},
  "paused": false, "paused_by": null, "paused_at": null, "reason": null,
  "rate": 20, "plan_rate": 60,
  "platform_queue": {"counts": {"queued": 12}, "messages_per_minute": 60, "messages_remaining": 8766,
                     "held_reason": null, "fetched_at": "2026-09-28 10:00:00"}
}
```

**Errors:** `WAPermissionError` (403).

```bash
curl -s "https://<site>/api/method/whatsapp_next.api.v1.queue.get_summary" \
  -H "Authorization: token <api_key>:<api_secret>"
```

---

## get_throughput

Returns what actually left the queue: the number of `Completed` items per minute over the last
`minutes`, zero-filled and oldest first. Compare it with the configured rate.

- **Path:** `whatsapp_next.api.v1.queue.get_throughput`
- **Methods:** GET, POST
- **Roles:** `VIEWER_UP`

| Argument | Type | Required / default | Meaning |
|---|---|---|---|
| `minutes` | int | `60` | Clamped to 5–180 |

**Returns.** `per_minute` is `sent ÷ minutes`, rounded to 2 places.

```json
{"minutes": 60, "buckets": [0, 0, 18, 20, "…"], "sent": 412, "peak": 20, "per_minute": 6.87}
```

**Errors:** `WAValidationError` (417) for a non-integer `minutes`.

```js
const t = await sanad.ui.call("queue.get_throughput", { minutes: 30 });
```

---

## pause_queue

Pauses the queue globally: `Settings.queue_paused = 1`. Rows stay `Queued` and the dispatcher
skips its ticks. Audited as `Queue Paused` (`scope: global`).

- **Path:** `whatsapp_next.api.v1.queue.pause_queue`
- **Methods:** POST
- **Roles:** `MANAGER`

| Argument | Type | Required / default | Meaning |
|---|---|---|---|
| `reason` | str | optional | Stored as `queue_pause_reason` |

**Returns:** `{"paused_at": "2026-09-28 10:00:00"}`

**Errors:** `WAPermissionError` (403).
**Realtime:** `wa:queue:progress` with the summary (forced, not throttled).

```bash
curl -s -X POST "https://<site>/api/method/whatsapp_next.api.v1.queue.pause_queue" \
  -H "Authorization: token <api_key>:<api_secret>" -d reason="Maintenance"
```

---

## resume_queue

Lifts the global pause and clears the pause fields. Audited as `Queue Resumed`.

- **Path:** `whatsapp_next.api.v1.queue.resume_queue`
- **Methods:** POST
- **Roles:** `MANAGER`

Arguments: none.

**Returns:** `{"resumed_at": "2026-09-28 10:10:00"}`

**Errors:** `WAPermissionError` (403).
**Realtime:** `wa:queue:progress`.

```js
await sanad.ui.call("queue.resume_queue");
```

---

## set_rate

Sets the global send rate. It must be between 5 and 60 messages per minute, and at most the plan
rate when that is known. Audited as `Queue Rate Changed`.

- **Path:** `whatsapp_next.api.v1.queue.set_rate`
- **Methods:** POST
- **Roles:** `MANAGER`

| Argument | Type | Required / default | Meaning |
|---|---|---|---|
| `messages_per_minute` | int | required | 5 … min(60, plan rate) |

**Returns:** `{"messages_per_minute": 30}`

**Errors:** `WAValidationError` (417) "Rate must be between 5 and N messages per minute".

```bash
curl -s -X POST "https://<site>/api/method/whatsapp_next.api.v1.queue.set_rate" \
  -H "Authorization: token <api_key>:<api_secret>" -d messages_per_minute=30
```

---

## pause_items

Moves the selected `Queued` rows to `Paused`, recording who paused them, when, and why. Audited
as `Queue Paused` with the count (`scope: items`).

- **Path:** `whatsapp_next.api.v1.queue.pause_items`
- **Methods:** POST
- **Roles:** `MANAGER`

| Argument | Type | Required / default | Meaning |
|---|---|---|---|
| `names` | list[str] | one of `names` / `filters` | Queue item names |
| `filters` | dict | one of `names` / `filters` | Keys `device`, `campaign`, `phone_e164` |
| `reason` | str | optional | `pause_reason` |

**Returns:** `{"count": 12}` (the rows actually paused)

**Errors:** `WAValidationError` (417) "Provide names[] or filters on device, campaign, phone_e164"
when both are empty or a filter key is unknown.

```bash
curl -s -X POST "https://<site>/api/method/whatsapp_next.api.v1.queue.pause_items" \
  -H "Authorization: token <api_key>:<api_secret>" -H "Content-Type: application/json" \
  -d '{"filters": {"campaign": "WA-CAMP-2026-00014"}, "reason": "hold"}'
```

---

## resume_items

Moves the selected `Paused` rows back to `Queued` and clears the pause fields and
`next_attempt_at`. Audited as `Queue Resumed` (`scope: items`).

- **Path:** `whatsapp_next.api.v1.queue.resume_items`
- **Methods:** POST
- **Roles:** `MANAGER`

| Argument | Type | Required / default | Meaning |
|---|---|---|---|
| `names` | list[str] | one of `names` / `filters` | Queue item names |
| `filters` | dict | one of `names` / `filters` | Keys `device`, `campaign`, `phone_e164` |

**Returns:** `{"count": 12}`

**Errors:** `WAValidationError` (417) for an empty or unknown selection.

```js
await sanad.ui.call("queue.resume_items", { names: ["f6a7b8c9d0"] });
```

---

## delete_items  *(destructive)*

Marks the selected `Queued` and `Paused` rows as `Deleted`, recording who deleted them, when, and
why. Each row's outbound becomes `Cancelled`, and its campaign recipient (if any) becomes
`Cancelled`. The outbound can't be sent afterwards. It can only be resent as a new row. Audited
as `Queue Items Deleted`.

- **Path:** `whatsapp_next.api.v1.queue.delete_items`
- **Methods:** POST
- **Roles:** `MANAGER`

| Argument | Type | Required / default | Meaning |
|---|---|---|---|
| `names` | list[str] | one of `names` / `filters` | Queue item names |
| `filters` | dict | one of `names` / `filters` | Keys `device`, `campaign`, `phone_e164` |
| `reason` | str | optional | `delete_reason` |

**Returns:** `{"count": 5}`

**Errors:**

| Exception | HTTP | When |
|---|---|---|
| `WAStateConflictError` | 409 | A row named in `names[]` is `Sending` ("N item(s) are being sent and cannot be deleted"). Nothing is deleted. With `filters`, `Sending` rows are skipped silently. |
| `WAValidationError` | 417 | Empty or unknown selection |

**Realtime:** `wa:message:status` `{outbound, status: "Cancelled", …}` for each row.

```bash
curl -s -X POST "https://<site>/api/method/whatsapp_next.api.v1.queue.delete_items" \
  -H "Authorization: token <api_key>:<api_secret>" -H "Content-Type: application/json" \
  -d '{"names": ["f6a7b8c9d0"], "reason": "duplicate"}'
```

---

## retry_dead_letter

Moves the named `Dead Letter` rows back to `Queued` with `attempts = 0`, clearing the error,
claim, and job fields. Their outbound rows go back to `Queued`, with `error_code`,
`error_message`, and `failed_at` cleared. Audited as `Queue Items Retried`.

- **Path:** `whatsapp_next.api.v1.queue.retry_dead_letter`
- **Methods:** POST
- **Roles:** `MANAGER`

| Argument | Type | Required / default | Meaning |
|---|---|---|---|
| `names` | list[str] | required, non-empty | Queue item names. Rows not in `Dead Letter` are ignored. |

**Returns:** `{"count": 1}`

**Errors:** `WAValidationError` (417) "names[] is required".

```js
await sanad.ui.call("queue.retry_dead_letter", { names: ["f6a7b8c9d0"] });
```

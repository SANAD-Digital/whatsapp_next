# Campaigns API (`campaigns.*`)

Module: `whatsapp_next/api/v1/campaigns.py`, thin wrappers over
`whatsapp_next/services/campaign_runner.py` — the **single status writer** of
`WhatsApp Campaign` — plus read helpers for the Campaigns screen. Recipients are added and removed
through the [picker API](picker.md) (`commit_add` / `commit_remove`), not here.

URL form, authentication, the error envelope, the role groups and the `names[]` bulk result shape
are in [README.md](README.md). Every endpoint also answers **403** (`WAPermissionError`) for a
missing role and **417** (`WAValidationError`) for an unknown, missing or untypeable argument.
Returns are shown as the value of the response's `message` key.

**Permissions.** Writes need the `MANAGER` role group **and** `write` permission on the campaign
document; reads need `VIEWER_UP` (some `MANAGER`) **and** `read` on the document. The per-document
check (`_require`) raises:

| Exception | HTTP | When |
|---|---|---|
| `WANotFoundError` | 404 | The campaign does not exist. |
| `WAPermissionError` | 403 | No `read` / `write` on this campaign. |

## Status machine

Statuses: `Draft`, `Scheduled`, `Queued`, `Running`, `Paused`, `Completed`, `Partially Failed`,
`Cancelled` (the last three are terminal).

| From | Allowed to |
|---|---|
| Draft | Scheduled, Queued, Cancelled |
| Scheduled | Queued, Draft, Cancelled |
| Queued | Running, Cancelled, Completed, Partially Failed |
| Running | Paused, Completed, Partially Failed, Cancelled |
| Paused | Running, Cancelled |
| Partially Failed | Running (only through `retry_failed`, while its new rows are sent) |

Any other transition raises `WAStateConflictError` (409). A campaign becomes `Completed` (no
failures) or `Partially Failed` by itself when no outbound row is open and no recipient is
`Pending`.

## Realtime: `wa:campaign:status`

Every status change (and every counter refresh) publishes `wa:campaign:status` after commit, both
to the site room and to the document room (`doctype="WhatsApp Campaign"`, `docname=<name>`):

```json
{ "campaign": "CAMP-0001", "status": "Paused", "counters": null }
```

`counters` is `null` for a plain status change and the counters object (see
[`get_progress`](#get_progress)) on a counter refresh.

---

## start

Start now: `Draft | Scheduled → Queued`; materialization of recipients into outbound messages
runs in a `long` job (`campaign_runner.materialize`, job id `wa-campaign-<name>`).

- **Path:** `whatsapp_next.api.v1.campaigns.start`
- **Methods:** POST
- **Roles:** `MANAGER` + write on the campaign

| Argument | Type | Required | Meaning |
|---|---|---|---|
| `name` | str | yes | Campaign name. |

Sets `started_at`, `started_by` and `scheduled_at` (kept if already set, else now). Audited
`Campaign Started` with the active recipient count.

**Returns**

```json
{ "status": "Queued" }
```

**Errors**

| Exception | HTTP | When |
|---|---|---|
| `WAStateConflictError` | 409 | Status is not `Draft` / `Scheduled` (e.g. already `Running`). |
| `WAValidationError` | 417 | `Campaign has no messages`; `Campaign has no recipients` (all `Removed`); `Choose a device for the campaign` (no campaign device and no default device). |

**Realtime:** `wa:campaign:status` (`Queued`).

```bash
curl -X POST "https://site/api/method/whatsapp_next.api.v1.campaigns.start" \
  -H "Authorization: token <api_key>:<api_secret>" -d name=CAMP-0001
```

---

## schedule

`Draft → Scheduled` at a future time. A per-minute scheduler job (`promote_scheduled`) starts it
when the time comes.

- **Path:** `whatsapp_next.api.v1.campaigns.schedule`
- **Methods:** POST
- **Roles:** `MANAGER` + write

| Argument | Type | Required | Meaning |
|---|---|---|---|
| `name` | str | yes | Campaign name. |
| `scheduled_at` | datetime | yes | `YYYY-MM-DD HH:MM[:SS]` in the site time zone; must be in the future. |

**Returns**

```json
{ "status": "Scheduled", "scheduled_at": "2026-10-01 09:00:00" }
```

**Errors**

| Exception | HTTP | When |
|---|---|---|
| `WAStateConflictError` | 409 | Not `Draft`. |
| `WAValidationError` | 417 | Time not in the future; or the same start checks as `start` (messages, recipients, device). |

**Realtime:** `wa:campaign:status` (`Scheduled`).

```js
await sanad.ui.call("campaigns.schedule", { name: "CAMP-0001", scheduled_at: "2026-10-01 09:00:00" });
```

---

## unschedule

`Scheduled → Draft` (clears `scheduled_at`).

- **Path:** `whatsapp_next.api.v1.campaigns.unschedule`
- **Methods:** POST
- **Roles:** `MANAGER` + write

| Argument | Type | Required | Meaning |
|---|---|---|---|
| `name` | str | yes | Campaign name. |

**Returns**

```json
{ "status": "Draft" }
```

**Errors:** `WAStateConflictError` (409) — `Campaign is not scheduled`.

**Realtime:** `wa:campaign:status` (`Draft`).

```js
await sanad.ui.call("campaigns.unschedule", { name: "CAMP-0001" });
```

---

## pause

Pause a `Running` (or `Queued`) campaign: its `Queued` queue items become `Paused`.

- **Path:** `whatsapp_next.api.v1.campaigns.pause`
- **Methods:** POST
- **Roles:** `MANAGER` + write

| Argument | Type | Required | Meaning |
|---|---|---|---|
| `name` | str | yes | Campaign name. |
| `reason` | str | optional | Stored in `pause_reason` and the audit rows. |

A `Queued` campaign is first moved to `Running`, then to `Paused`. Sets `paused_at`, `paused_by`,
`pause_reason` and increments `pause_count`. Audited `Queue Paused` (items) and
`Campaign Paused`.

**Returns** — `count` is the number of queue items paused:

```json
{ "status": "Paused", "count": 120 }
```

**Errors:** `WAStateConflictError` (409) — `Only a running campaign can be paused` (any status
other than `Running` / `Queued`).

**Realtime:** `wa:campaign:status` (`Paused`; preceded by `Running` when the campaign was `Queued`).

```js
await sanad.ui.call("campaigns.pause", { name: "CAMP-0001", reason: "Wrong attachment" });
```

---

## resume

`Paused → Running`: the campaign's `Paused` queue items return to `Queued`.

- **Path:** `whatsapp_next.api.v1.campaigns.resume`
- **Methods:** POST
- **Roles:** `MANAGER` + write

| Argument | Type | Required | Meaning |
|---|---|---|---|
| `name` | str | yes | Campaign name. |

Clears `paused_at`, `paused_by`, `pause_reason`. Audited `Queue Resumed` and `Campaign Resumed`.

**Returns**

```json
{ "status": "Running", "count": 120 }
```

**Errors:** `WAStateConflictError` (409) — `Campaign is not paused`.

**Realtime:** `wa:campaign:status` (`Running`).

```js
await sanad.ui.call("campaigns.resume", { name: "CAMP-0001" });
```

---

## cancel

Any non-terminal status → `Cancelled`. Open queue items (`Queued` / `Paused`) become `Deleted`
(state, not row removal), their outbound rows `Cancelled`, and `Pending` / `Queued` recipients
`Cancelled`.

- **Path:** `whatsapp_next.api.v1.campaigns.cancel`
- **Methods:** POST
- **Roles:** `MANAGER` + write

| Argument | Type | Required | Meaning |
|---|---|---|---|
| `name` | str | yes | Campaign name. |
| `reason` | str | optional | Stored in `cancel_reason` and the audit rows. |

Sets `cancelled_at`, `cancelled_by`, `cancel_reason`, `ended_at`. Audited `Queue Items Deleted` (when
items were deleted) and `Campaign Cancelled`; counters are refreshed.

**Returns** — `count` is the number of queue items deleted:

```json
{ "status": "Cancelled", "count": 80 }
```

**Errors:** `WAStateConflictError` (409) — `Campaign … is already Completed / Partially Failed /
Cancelled`.

**Realtime:** `wa:message:status` (`Cancelled`) per deleted item; `wa:campaign:status`
(`Cancelled`) and a second one carrying the refreshed `counters`.

```bash
curl -X POST "https://site/api/method/whatsapp_next.api.v1.campaigns.cancel" \
  -H "Authorization: token <api_key>:<api_secret>" -d name=CAMP-0001 -d reason="Duplicate campaign"
```

---

## pause_many / resume_many / cancel_many

Bulk variants over `_bulk.run_bulk` (one savepoint per campaign).

- **Paths:** `whatsapp_next.api.v1.campaigns.pause_many`, `….resume_many`, `….cancel_many`
- **Methods:** POST
- **Roles:** `MANAGER`; write on each campaign (checked per row)

| Endpoint | Arguments | Applies to | Others |
|---|---|---|---|
| `pause_many` | `names: list[str]`, `reason: str?` | `Running`, `Queued` | skipped |
| `resume_many` | `names: list[str]` | `Paused` | skipped |
| `cancel_many` | `names: list[str]`, `reason: str?` | every non-terminal status | skipped |

**Returns** — the bulk shape; `skipped[].reason` is the campaign's current status. A missing
campaign is reported in `failed` (`WhatsApp Campaign … not found`).

```json
{ "count": 2, "done": ["CAMP-0001", "CAMP-0002"], "failed": [], "skipped": [{ "name": "CAMP-0003", "reason": "Completed" }] }
```

**Errors:** a missing **write** permission on any campaign raises `WAPermissionError` (403) and
aborts the whole call (the bulk helper re-raises permission errors).

**Realtime:** as for the single-campaign endpoint, per campaign.

```js
await sanad.ui.call("campaigns.pause_many", { names: ["CAMP-0001", "CAMP-0002"], reason: "Maintenance" });
```

---

## get_progress

Live counters, rates and the most recently changed outbound rows of one campaign.

- **Path:** `whatsapp_next.api.v1.campaigns.get_progress`
- **Methods:** GET, POST
- **Roles:** `VIEWER_UP` + read

| Argument | Type | Required | Meaning |
|---|---|---|---|
| `name` | str | yes | Campaign name. |

**Returns**

```json
{
  "name": "CAMP-0001", "campaign_name": "October offer", "status": "Running", "device": "WAD-0001",
  "scheduled_at": "2026-10-01 09:00:00", "messages_per_minute": 20,
  "total_recipients": 500, "initial_recipients": 480, "added_count": 20, "removed_count": 0, "pause_count": 1,
  "started_at": "2026-10-01 09:00:02", "ended_at": null, "paused_at": null, "paused_by": null, "pause_reason": null,
  "first_message_at": "2026-10-01 09:00:10", "last_message_at": "2026-10-01 09:12:40",
  "counters": { "total": 500, "queued": 240, "sent": 200, "delivered": 40, "read": 15, "failed": 5, "cancelled": 0, "open": 240 },
  "rates": { "messages_per_minute": 20, "sent_last_minute": 19, "percent": 52.0, "eta_seconds": 720 },
  "recent": [
    { "name": "WAL-0000123", "phone_e164": "+966500000002", "display_name": "Ahmed", "status": "Delivered",
      "message_type": "Text", "campaign_message_idx": 1, "sent_at": "…", "failed_at": null, "error_code": null, "modified": "…" }
  ]
}
```

- `counters` group the campaign's `WhatsApp Log` rows by status: `queued` = `Queued`, `Sending`,
  `Unsent` or `Held`; `open` equals `queued`; the other buckets are disjoint.
- `rates.messages_per_minute` is the campaign's rate, else the Settings rate; `sent_last_minute`
  counts rows `Sent|Delivered|Read` with `sent_at` in the last 60 s; `percent` =
  `(total − open) / total`; `eta_seconds` = `open × 60 / rate`.
- `recent`: the 10 most recently modified outbound rows.

**Realtime:** none (subscribe to `wa:campaign:status` for pushes).

```js
const p = await sanad.ui.call("campaigns.get_progress", { name: "CAMP-0001" });
```

---

## get_overview

What every campaign together is doing — the console's metric row.

- **Path:** `whatsapp_next.api.v1.campaigns.get_overview`
- **Methods:** GET, POST
- **Roles:** `VIEWER_UP` (no per-document check)

| Argument | Type | Required / default | Meaning |
|---|---|---|---|
| `days` | int | `30` | Window for `totals`, clamped to 1–365. |

**Returns**

```json
{
  "days": 30,
  "states": { "Draft": 3, "Scheduled": 1, "Queued": 0, "Running": 1, "Paused": 0, "Completed": 12, "Partially Failed": 2, "Cancelled": 1 },
  "in_flight": 240,
  "sent_last_hour": 600,
  "per_minute": 10.0,
  "totals": { "recipients": 5000, "sent": 4700, "delivered": 4300, "read": 2100, "failed": 120 }
}
```

- `in_flight`: over `Running | Queued | Paused` campaigns, `total_recipients − sent_count −
  failed_count`.
- `sent_last_hour` / `per_minute`: campaign `WhatsApp Log` rows with `sent_at` in the last hour.
- `totals`: campaigns with `started_at` in the window, rolled up as stage shares — `sent` =
  sent + delivered + read, `delivered` = delivered + read.

**Realtime:** none.

```bash
curl -G "https://site/api/method/whatsapp_next.api.v1.campaigns.get_overview" \
  -H "Authorization: token <api_key>:<api_secret>" -d days=7
```

---

## get_sending_now

Campaigns `Running`, `Queued` or `Paused` with live counters (list stats card).

- **Path:** `whatsapp_next.api.v1.campaigns.get_sending_now`
- **Methods:** GET, POST
- **Roles:** `VIEWER_UP`

No arguments.

**Returns**

```json
[
  { "name": "CAMP-0001", "campaign_name": "October offer", "status": "Running", "device": "WAD-0001",
    "total_recipients": 500, "sent_count": 200, "failed_count": 5, "queued_count": 240, "started_at": "…",
    "counters": { "total": 500, "queued": 240, "sent": 200, "delivered": 40, "read": 15, "failed": 5, "cancelled": 0, "open": 240 } }
]
```

**Realtime:** none.

```js
const live = await sanad.ui.call("campaigns.get_sending_now");
```

---

## get_recipients_page

One page of the recipients child table, with chip counts.

- **Path:** `whatsapp_next.api.v1.campaigns.get_recipients_page`
- **Methods:** GET, POST
- **Roles:** `VIEWER_UP` + read

| Argument | Type | Required / default | Meaning |
|---|---|---|---|
| `name` | str | yes | Campaign name. |
| `status` | str or list | optional | One value or a list (JSON list over the wire) of `Pending, Queued, Sent, Delivered, Read, Failed, Cancelled, Removed`. |
| `source_type` | str or list | optional | One or several of `Contact Group, Contact, DocType, Excel, vCard, Manual`. |
| `search` | str | optional | LIKE on `phone_e164`, `phone` or `display_name`. |
| `page` | int | `1` | |
| `page_length` | int | `50` | Capped at 200. |
| `order_by` | str | `"idx asc"` | `<field> [asc\|desc]`, field one of `idx, display_name, phone_e164, status, source_type, added_at`. |

**Returns**

```json
{
  "rows": [
    { "name": "a1b2c3", "idx": 1, "recipient_type": "Individual", "phone": "+966500000002", "phone_e164": "+966500000002",
      "jid": null, "display_name": "Ahmed", "contact": "Ahmed Ali", "source_type": "Contact Group", "contact_group": "VIP",
      "source_doctype": "WhatsApp Contact Group", "source_name": "VIP", "status": "Delivered",
      "outbound_message": "WAL-0000123", "error_code": null, "added_by": "manager@example.com",
      "added_at": "…", "removed_by": null, "removed_at": null }
  ],
  "total": 1,
  "counts": {
    "status": { "Delivered": 1, "Pending": 20, "All": 21 },
    "source_type": { "Contact Group": 21, "All": 21 }
  }
}
```

Each field's `counts` ignore that field's own filter but keep the other filter and the search, so
a chip says how many rows it would show; `counts[field]["All"]` is their sum.

**Errors:** 417 `Invalid value for status: …` / `source_type`, and `Cannot order by …`.

**Realtime:** none.

```js
await sanad.ui.call("campaigns.get_recipients_page", { name: "CAMP-0001", status: ["Failed", "Cancelled"], search: "0500" });
```

---

## preview_message

Message `idx` of the campaign rendered for one recipient.

- **Path:** `whatsapp_next.api.v1.campaigns.preview_message`
- **Methods:** GET, POST
- **Roles:** `MANAGER` + read

| Argument | Type | Required | Meaning |
|---|---|---|---|
| `name` | str | yes | Campaign name. |
| `idx` | int | yes | 1-based message position. |
| `recipient_row` | str | optional | Name of a recipients child row; default is a sample recipient (`+966500000000`, "Recipient"). |

**Returns**

```json
{ "idx": 1, "message_type": "Document", "body": null, "caption": "Dear Ahmed, …", "attachment_name": "INV-0001.pdf", "errors": [] }
```

`body` is the rendered text of a text message and `caption` the rendered caption of a file
message — both per recipient, with the same variables. `attachment_name` is the attachment's file
name, or for a `Document` message built from a print format the rendered `file_name_template`.
`errors` are Jinja compile errors of the message body (or its template's body) and of the caption.

**Errors:** `WAValidationError` (417) — `Campaign has no message <idx>`; `Recipient row … not found`.

**Realtime:** none.

```js
await sanad.ui.call("campaigns.preview_message", { name: "CAMP-0001", idx: 1 });
```

---

## get_poll_results

Aggregated results of each `Poll` message, fetched from the provider over the sent rows'
`poll_id`, cached 10 minutes (`wa:poll-results:<name>`).

- **Path:** `whatsapp_next.api.v1.campaigns.get_poll_results`
- **Methods:** GET, POST
- **Roles:** `MANAGER` + read

| Argument | Type | Required / default | Meaning |
|---|---|---|---|
| `name` | str | yes | Campaign name. |
| `refresh` | bool | `false` | Bypass the cache. |

**Returns**

```json
{
  "campaign": "CAMP-0001",
  "fetched_at": "2026-10-01 10:00:00",
  "results": [
    { "idx": 2, "question": "Did you receive the invoice?", "sent": 480,
      "options": ["Yes", "No"],
      "counts": [{ "option": "Yes", "count": 300 }, { "option": "No", "count": 20 }],
      "responses": 320, "errors": 0,
      "by_poll_id": { "3EB0…": { "selected": ["Yes"], "error": null, "raw": {} } } }
  ]
}
```

`results` is empty when the campaign has no poll message. Provider failures for a batch are
recorded per poll id in `errors` / `by_poll_id[…].error`, never raised.

**Errors:** `WAValidationError` (417) — `Campaign device is not registered on the platform`.

**Realtime:** none.

```js
await sanad.ui.call("campaigns.get_poll_results", { name: "CAMP-0001", refresh: 1 });
```

---

## get_readiness

The five checks `start()` would apply, answered before pressing Start.

- **Path:** `whatsapp_next.api.v1.campaigns.get_readiness`
- **Methods:** GET, POST
- **Roles:** `VIEWER_UP` + read

| Argument | Type | Required | Meaning |
|---|---|---|---|
| `name` | str | yes | Campaign name. |

**Returns** — `ok` is true only when all five checks pass; each check is data (codes, counts),
the screen writes the sentence:

```json
{
  "campaign": "CAMP-0001", "status": "Draft", "ok": false,
  "checks": [
    { "key": "device", "ok": true, "device": "WAD-0001", "device_name": "Main", "status": "Connected", "disabled": false },
    { "key": "messages", "ok": false, "count": 2, "incomplete": [{ "idx": 2, "message_type": "Poll", "problem": "few_options" }] },
    { "key": "attachments", "ok": true, "missing": [] },
    { "key": "variables", "ok": true, "invalid": [] },
    { "key": "audience", "ok": true, "count": 500, "by_source": { "Contact Group": 480, "Manual": 20 }, "excluded_unknown": 0 }
  ]
}
```

- `device.ok`: a device (campaign or default) that is enabled and `Connected`.
- `messages.incomplete[].problem`: `empty_body` (Text), `no_attachment` (Document / Image / Video /
  Audio / Sticker), `no_question`, `few_options` (Poll, fewer than 2 options).
- `attachments.missing[]`: `{idx, message_type, attachment}` whose `File` no longer exists.
- `variables.invalid[]`: `{idx, errors[]}` Jinja compile errors.
- `audience`: recipients not `Removed`, by source; `excluded_unknown` = rows with
  `error_code = unknown_number_policy`.

**Realtime:** none.

```js
const r = await sanad.ui.call("campaigns.get_readiness", { name: "CAMP-0001" });
```

---

## get_failures

Failures grouped by `error_code`, largest first.

- **Path:** `whatsapp_next.api.v1.campaigns.get_failures`
- **Methods:** GET, POST
- **Roles:** `VIEWER_UP` + read

| Argument | Type | Required | Meaning |
|---|---|---|---|
| `name` | str | yes | Campaign name. |

**Returns**

```json
{
  "total": 12,
  "retryable": 8,
  "rows": [
    { "error_code": "device_disconnected", "count": 8, "retryable": true, "share": 66.7, "sample": "Device is not connected" },
    { "error_code": "not_on_whatsapp", "count": 4, "retryable": false, "share": 33.3, "sample": "Recipient is not a registered WhatsApp user" }
  ]
}
```

Retryable codes are `services.errors.RETRYABLE`: `device_disconnected`, `timeout`,
`rate_limited`. A null code is reported as `unknown`.

**Realtime:** none.

```js
await sanad.ui.call("campaigns.get_failures", { name: "CAMP-0001" });
```

---

## get_message_stats

Each campaign message with the status counts of its own outbound rows.

- **Path:** `whatsapp_next.api.v1.campaigns.get_message_stats`
- **Methods:** GET, POST
- **Roles:** `VIEWER_UP` + read

| Argument | Type | Required | Meaning |
|---|---|---|---|
| `name` | str | yes | Campaign name. |

**Returns**

```json
{
  "rows": [
    { "idx": 1, "message_type": "Text", "delay_seconds": 0, "preview": "Dear {{ recipient.display_name }} …",
      "attachment": false, "counts": { "Sent": 200, "Delivered": 40, "Failed": 5 }, "total": 245 }
  ]
}
```

`preview` is the first 140 characters of the body, poll question or caption (unrendered);
`counts` keys are `WhatsApp Log` statuses.

**Realtime:** none.

```js
await sanad.ui.call("campaigns.get_message_stats", { name: "CAMP-0001" });
```

---

## get_timeline

What happened to the campaign and when.

- **Path:** `whatsapp_next.api.v1.campaigns.get_timeline`
- **Methods:** GET, POST
- **Roles:** `VIEWER_UP` + read

| Argument | Type | Required | Meaning |
|---|---|---|---|
| `name` | str | yes | Campaign name. |

**Returns** — events sorted by time:

```json
{
  "status": "Running",
  "events": [
    { "key": "created", "at": "…", "user": "manager@example.com" },
    { "key": "started", "at": "…", "user": "manager@example.com", "reason": null, "count": 500 },
    { "key": "first_message", "at": "…" },
    { "key": "paused", "at": "…", "user": "manager@example.com", "reason": "Wrong attachment", "count": 120 },
    { "key": "last_message", "at": "…" }
  ]
}
```

Keys: `created`, `scheduled` (only while `Scheduled`), `started`, `paused`, `resumed`,
`cancelled`, `recipients_changed`, `first_message`, `last_message`, `ended` (carries `status`).
The audit-backed keys (`started` … `recipients_changed`) are included only when the caller may read
`WhatsApp Audit Log`.

**Realtime:** none.

```js
await sanad.ui.call("campaigns.get_timeline", { name: "CAMP-0001" });
```

---

## retry_failed

Resend the campaign's failed messages. Each resend is a **new** outbound row
(`dispatch.resend_outbound`); the failed one stays in the log, but once it has been sent again it
is history: it is not counted in `counters` / `get_failures`, and it is never sent a second time.
A `Partially Failed` campaign goes back to `Running` until the new rows are done.

- **Path:** `whatsapp_next.api.v1.campaigns.retry_failed`
- **Methods:** POST
- **Roles:** `MANAGER` + write

| Argument | Type | Required / default | Meaning |
|---|---|---|---|
| `name` | str | yes | Campaign name. |
| `error_code` | str | optional | Retry only this bucket; default = the retryable codes only. |
| `limit` | int | `500` | At most this many (clamped to 1–500), oldest first. |

On a `Paused` campaign the new rows are paused with it. Audited `Queue Items Retried` when at
least one row was resent; counters are refreshed.

**Returns**

```json
{ "retried": 8, "refused": 0, "remaining": 4 }
```

`refused` counts rows the dispatcher would not resend (logged to the Error Log); `remaining` is
the campaign's failed messages that have not been sent again.

**Errors:** `WAStateConflictError` (409) — `A cancelled campaign cannot send again`.

**Realtime:** `wa:campaign:status` with refreshed `counters` (when something was retried); the new
rows' progress later arrives as `wa:message:status`.

```bash
curl -X POST "https://site/api/method/whatsapp_next.api.v1.campaigns.retry_failed" \
  -H "Authorization: token <api_key>:<api_secret>" -d name=CAMP-0001 -d error_code=device_disconnected
```

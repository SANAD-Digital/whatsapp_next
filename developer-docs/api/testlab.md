# testlab

Module `whatsapp_next/api/v1/testlab.py`. These endpoints serve the Test Lab page
(`/app/wa-test-lab`): a manager picks a device and his own target numbers and runs each part of
the product for real against them. They are thin wrappers over `services/testlab.py`, which is
**not** a second sending engine — every check calls the service the product itself uses:

| Check (`kind`) | Path it exercises |
|---|---|
| `quick_text`, `quick_image`, `quick_document` | `quick_send.compose` (queue, priority 1); the file is the app's sample or one the caller uploaded |
| `template` | a WhatsApp Template rendered over a real record, sent like a quick send from that record |
| `notification` | `notifications_editor.send_test` to the target; `notifications.send_for_document` only with `real_recipients` + `confirm_real` |
| `alert` | `alerts_editor.send_test` to the target |
| `command` | `simulator.dry_run_command` (nothing stored or sent); with `send_reply` the replies are produced by `simulator.simulate_inbound` and really sent to the target |
| `campaign` | `bulk_send.send` → `campaign_runner.start` / `.schedule`, plus `campaign_runner.readiness` |

Every function is **Manager-only** (`MANAGER`): the page sends real messages.
Conventions are in [README.md](README.md).

## What the server enforces

- **Recipients.** A check writes only to the numbers the run was opened with (`start_run`);
  any other `target` is a `WAPermissionError`. Groups and blacklisted numbers cannot be targets.
  The one exception is a notification sent with `real_recipients` and `confirm_real`, which goes
  to the record's own recipients and is counted against the cap.
- **Cap.** `cap` messages per run (default 20, at most 50). A check that would pass it raises
  `WAValidationError`.
- **Pacing.** At least `pacing` seconds between two sending checks (default 8, 3–60). Asked
  earlier, `run_check` does nothing and returns `{wait: seconds}`. A campaign of *n* recipients
  holds the next check back *n* × `pacing` and runs at `60 // pacing` messages a minute.
- **Owner.** Only the user who started a run may add checks to it; any manager may read it.
- **Marking.** Every outbound row a check creates carries `is_test = 1` (rows made by the
  notification / alert / campaign services are marked right after they are created; a campaign's
  rows when the run is next read). A notification sent to its real recipients is real traffic and
  is not marked.
- **Audit.** `Test Send` — one row when a run starts (`summary` "Test Lab run started") and one
  per check ("Test Lab check"), under the real user. `get_health(live=1)` adds `Connection Tested`.

## Where a run lives

A run is not a DocType. While it is being run it lives in the site cache
(`wa:testlab:run:<id>`, 24 h). Its messages stay in the WhatsApp Log and its audit rows in the
audit log, and a run that is no longer in the cache (after `bench clear-cache` or a migrate) is
read back from those audit rows as an **archive**: `run.archived = true`, target numbers masked
as the audit log keeps them, incoming messages not matched, and nothing can be added to it.
History therefore lasts as long as the audit log's retention.

---

## get_context

- **Path:** `whatsapp_next.api.v1.testlab.get_context` · **Methods:** GET, POST

**Returns:** `devices[]`, `default_device`, `me{phone}` (the caller's own mobile, the default
target), `limits{cap, cap_max, pacing, pacing_min, pacing_max, max_targets, schedule_minutes,
schedule_min, schedule_max}`, `templates[]`, `notifications[]`, `alerts[]` (read with the caller's
permissions), `commands[]` (Active), `commands_enabled`, `samples{image, document}`, `history[]`
(see `list_runs`).

## get_health

- **Path:** `whatsapp_next.api.v1.testlab.get_health` · **Methods:** POST

| Argument | Type | Notes |
|---|---|---|
| `device` | str, optional | Defaults to the default device. |
| `live` | bool | `1` tests the platform connection now (`onboarding.test_connection`, audited); otherwise the last known state is reported and nothing leaves the site. |

**Returns:** `{ok, live, checked_at, checks[]}`; each check is `{key, title, status, detail, fix,
route, route_label}` with `status` `ok` / `warn` / `fail`. `ok` is false when any check fails.

| `key` | Fails / warns when |
|---|---|
| `credentials` | no API key saved; the last connection test failed; never tested (warn) |
| `subscription` | inactive / expired; no messages left; little left (warn) |
| `webhook` | no endpoint registered; state is not `Active` |
| `webhook_traffic` | no event ever, or none for a day (warn) |
| `device` | none; switched off; not `Connected`; events not registered and none arriving (warn) |
| `scheduler` | the site's scheduler is disabled; the app's every-minute job is stopped or has not run for 15 minutes |
| `workers` | Redis unreachable; no worker; a queue (`short` / `long` / `default`) without a worker; more than 50 jobs waiting (warn) |
| `queue` | sending is paused; messages waiting more than 5 minutes (warn); dead letters (warn) |
| `commands` | commands off, no service user, or no active command (all warn) |

## identify

- **Path:** `whatsapp_next.api.v1.testlab.identify` · **Methods:** GET, POST
- `phones` (list) → `[{input, valid, phone_e164, name, contact, party_type, party, link_status,
  blacklisted}]`. A command answers a number with its own party's records, so the page shows
  which party a target stands for.

## search_documents

- **Path:** `whatsapp_next.api.v1.testlab.search_documents` · **Methods:** GET, POST
- `doctype`, `txt` (optional) → `{rows[{name, title}], no_access}`: the newest records the caller
  may read (`frappe.get_list`). `WAValidationError` for an unknown or child DocType.

## preview

- **Path:** `whatsapp_next.api.v1.testlab.preview` · **Methods:** POST
- `kind` (`template` | `notification` | `alert` | `campaign`), `params`, `target` (optional).
  Nothing is sent.
  - `template` `{template, reference_name?}` → `{message, errors[], reference_doctype,
    reference_name, attachment}`.
  - `notification` `{notification, reference_name?}` → `notifications_editor.preview` (condition,
    message, masked recipients, attachment).
  - `alert` `{alert}` → `alerts_editor.preview` with the recipients masked.
  - `campaign` `{numbers[]}` → `{total, excluded, invalid}`.
- Needs read on the template / notification / alert and on the record it renders
  (`frappe.PermissionError` otherwise).

## start_run

- **Path:** `whatsapp_next.api.v1.testlab.start_run` · **Methods:** POST

| Argument | Type | Notes |
|---|---|---|
| `device` | str | An enabled device. |
| `targets` | list[str] | 1–5 individual numbers; normalised, duplicates dropped. |
| `cap` | int, optional | 1–50, default 20. |
| `pacing` | int, optional | 3–60 seconds, default 8. |

**Returns:** `{id, user, device, targets[], cap, pacing, started_at, used, archived}`.
**Errors:** `WAInvalidPhoneError`, `WABlacklistedError`, `WAValidationError`.

## run_check

- **Path:** `whatsapp_next.api.v1.testlab.run_check` · **Methods:** POST

| Argument | Type | Notes |
|---|---|---|
| `run` | str | From `start_run`. |
| `kind` | str | One of the checks above. |
| `target` | str | One of the run's numbers (not used by `campaign`, which takes them all). |
| `params` | dict | Per kind: `{body, attachment}` · `{template, reference_name}` · `{notification, reference_name, real_recipients, confirm_real}` · `{alert}` · `{text, send_reply}` · `{body \| template \| with_image, attachment, scheduled, schedule_minutes}`; `label` is kept with the step. |

**Returns:** `{wait}` while the pacing holds the next message back, otherwise the recorded step
`{idx, kind, target, label, at, dry, ok, error, outbounds[], campaign, count, result{}}`.
A check the product itself refuses (an empty template, a record the caller cannot read, a report
that cannot run) is **not raised**: it is recorded as a step with `ok: false` and its `error`,
and neither the cap nor the pacing moves.
**Errors (guards):** `WANotFoundError` (unknown or archived run), `WAPermissionError` (another
user's run, a target outside the run), `WAValidationError` (unknown kind, the cap).

## get_status

- **Path:** `whatsapp_next.api.v1.testlab.get_status` · **Methods:** POST
- `run` → `{run{}, steps[], summary{}, receipts{}, inbound[], webhook_last_event_at, finished}`.
  - `steps[]`: each step plus `state` (`running`, `scheduled`, `sent`, `delivered`, `read`,
    `passed`, `blocked`, `failed`), `messages[]` (the Log rows: `name, status, phone_e164,
    queue_item, error_code, error_message, send_seconds, deliver_seconds`, both timings measured
    from the row's creation) and `campaign_row`.
  - `summary`: `{checks, passed, failed, blocked, pending, messages, avg_send_seconds,
    avg_deliver_seconds}`.
  - `receipts`: `{messages, sent, delivered, read, failed}` — the webhook round trip, read off
    the run's own messages.
  - `inbound[]`: real messages the run's targets wrote since it began, with the command they
    matched and the state of the replies (`answered`, `delivered`).

## list_runs

- **Path:** `whatsapp_next.api.v1.testlab.list_runs` · **Methods:** GET, POST
- The 20 newest runs that ran at least one check, newest first: `[{id, user, user_name, device,
  started_at, targets, checks, messages, delivered, failed}]`.

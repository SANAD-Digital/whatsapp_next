# home

Module `whatsapp_next/api/v1/home.py`. The Home dashboard reads data through these two endpoints.
They only compose service reads (devices, campaigns, queue summary, today's counters, plan cache,
webhook state, onboarding status, and period activity) and change nothing.

Conventions are in [README.md](README.md).

---

## get_dashboard

Returns everything the Home page renders, in one call.

- **Path:** `whatsapp_next.api.v1.home.get_dashboard`
- **Methods:** GET, POST
- **Roles:** `VIEWER_UP` (WhatsApp Viewer, Agent, Manager, System Manager)

Arguments: none.

**Returns:**

| Key | Meaning |
|---|---|
| `devices[]` | Every `WhatsApp Device`, default device first: `name, device_name, status, last_seen, is_default, disabled, connected_at, disconnected_at, last_error` |
| `campaigns_sending[]` | Campaigns in `Running`, `Queued`, or `Paused`: `name, campaign_name, status, device, total_recipients, sent_count, failed_count, queued_count, started_at`, plus live `counters{total, queued, sent, delivered, read, failed, cancelled, open}` |
| `queue` | Queue item counts `queued, sending, paused, dead_letter`; `held` (WhatsApp Log rows in `Held`); the global pause state `paused_globally, paused_by, paused_at, reason`; and `rate` (messages per minute) |
| `today` | Counts since local midnight: `sent` (`sent_at`), `delivered` (`delivered_at`), `failed` (`failed_at`), `inbound` (`received_at`) |
| `plan` | The subscription cache (see [settings.md](settings.md#sync_subscription)), with `plan_features` parsed |
| `webhook_status` | `Active`, `Disabled`, `Locked`, `Revoked`, or `null` |
| `last_webhook_event_at` | When the last webhook arrived |
| `setup` | Same as [`onboarding.get_status`](onboarding.md#get_status) |

```json
{
  "devices": [{"name": "WA-DEV-001", "device_name": "Sales", "status": "Connected", "is_default": 1, "disabled": 0,
               "last_seen": "2026-09-28 09:59:00", "connected_at": "…", "disconnected_at": null, "last_error": null}],
  "campaigns_sending": [{"name": "WA-CAMP-2026-00012", "campaign_name": "October promo", "status": "Running",
                         "device": "WA-DEV-001", "total_recipients": 500, "sent_count": 120, "failed_count": 2,
                         "queued_count": 378, "started_at": "…",
                         "counters": {"total": 500, "queued": 378, "sent": 120, "delivered": 90, "read": 40,
                                      "failed": 2, "cancelled": 0, "open": 378}}],
  "queue": {"queued": 378, "sending": 0, "paused": 0, "held": 0, "dead_letter": 1,
            "paused_globally": false, "paused_by": null, "paused_at": null, "reason": null, "rate": 20},
  "today": {"sent": 140, "delivered": 110, "failed": 3, "inbound": 25},
  "plan": {"plan_code": "PRO", "messages_remaining": 8766, "…": "…"},
  "webhook_status": "Active",
  "last_webhook_event_at": "2026-09-28 09:58:12",
  "setup": {"setup_completed": true, "steps": ["…"], "…": "…"}
}
```

**Errors:** `WAPermissionError` (403).

```bash
curl -s "https://<site>/api/method/whatsapp_next.api.v1.home.get_dashboard" \
  -H "Authorization: token <api_key>:<api_secret>"
```

---

## get_activity

Returns the figures for one Home period. All grouping happens in the database.

- **Path:** `whatsapp_next.api.v1.home.get_activity`
- **Methods:** GET, POST
- **Roles:** `VIEWER_UP`

| Argument | Type | Required / default | Meaning |
|---|---|---|---|
| `period` | str | `today` | `today` (per hour), `7d` (per day, today and the 6 days before), or `30d` (per day, today and the 29 days before) |

**Returns:**

| Key | Meaning |
|---|---|
| `period` | The period asked for |
| `traffic.from` | First day of the period |
| `traffic.now` | `{status: count}` of outbound rows created in the period |
| `traffic.previous` | The same for the preceding window of equal length |
| `traffic.errors` | `{error_code: count}` of the period's `Failed` rows. A missing code has the key `""`. |
| `series[]` | `{key, status, count}`. `key` is `"00"`–`"23"` for `today`, or `"YYYY-MM-DD"`. |
| `scheduled[]` | Up to 5 `Scheduled` campaigns, soonest first: `name, campaign_name, status, total_recipients, scheduled_at` |
| `last_sent` | The latest `sent_at` of any outbound row, whatever the period |
| `feed[]` | The last 5 movements in both directions, newest first: outbound rows `name, display_name, phone_e164, status, device, creation, sent_at` and inbound rows `name, display_name, phone_e164, device, received_at, creation`, each with `doctype`, `direction` (`out` / `in`), and `at` |

```json
{
  "period": "7d",
  "traffic": {"from": "2026-09-22", "now": {"Sent": 300, "Read": 150, "Failed": 4},
              "previous": {"Sent": 280, "Failed": 9}, "errors": {"<error_code>": 3, "": 1}},
  "series": [{"key": "2026-09-27", "status": "Sent", "count": 51}],
  "scheduled": [{"name": "WA-CAMP-2026-00013", "campaign_name": "Reminder", "status": "Scheduled",
                 "total_recipients": 80, "scheduled_at": "2026-09-29 09:00:00"}],
  "last_sent": "2026-09-28 09:57:40",
  "feed": [{"name": "…", "doctype": "WhatsApp Inbound Message", "direction": "in",
            "display_name": "Ali", "phone_e164": "+966501234567", "device": "WA-DEV-001",
            "received_at": "…", "creation": "…", "at": "…"}]
}
```

**Errors:** `WAValidationError` (417) for a `period` outside the enum. `WAPermissionError` (403).

```js
const activity = await sanad.ui.call("home.get_activity", { period: "30d" });
```

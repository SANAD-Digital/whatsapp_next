# Install and configure

## 1. Install

```bash
cd /path/to/frappe-bench
bench get-app <repo-url> --branch version-16      # the app's working branch (plan/00-conventions.md)
bench --site <site> install-app whatsapp_next     # needs frappe + erpnext (required_apps)
bench --site <site> migrate
bench build --app whatsapp_next
```

Python dependencies (`openpyxl`, `vobject`) come from `pyproject.toml`. `phonenumbers` and
`requests` are provided by Frappe.

## 2. What install and migrate seed

`after_install` and `after_migrate` (`whatsapp_next/install.py`) run the same steps. Each one is
**idempotent**:

| Step | Function | Result |
|---|---|---|
| Roles | `ensure_roles` | `WhatsApp Manager`, `WhatsApp Agent`, `WhatsApp Viewer`, `WhatsApp Contact User` (desk access). They are also shipped as fixtures. |
| Command service user | `ensure_command_service_user` | `wa-commands@<site>`, a System User that is **disabled, with no roles and no welcome mail**. Commands run as this user, never as Administrator (D-012). To use commands, enable it and grant only what your functions need. It must not be a System Manager. |
| Settings defaults | `ensure_settings_defaults` | `default_country` from System Settings, and `command_service_user` = the service user |
| Composite indexes | `add_indexes` in `install.py` (after install and after every migrate) | Composite indexes on Log, Inbound, Queue Item, Audit Log, Notification, Notification Alert and Webhook Event. Composite **unique** keys on `(device, provider_message_id)` for Inbound (D-035) and `(event_name, event_id)` for Webhook Event (D-047). |
| Contact warning | `warn_contact_open_to_all` | Prints a warning while role `All` still has rights on `Contact` (see §7) |
| Desktop tile | `ensure_desktop_icons` | The app tile (`/app/wa-home`) and the WhatsApp workspace tile (D-131) |

Fixtures (`hooks.py → fixtures`) install the four roles, the custom field
**`Contact Phone.wa_phone_e164`** (Data, indexed, read-only, after `is_primary_mobile_no`, D-028),
the Number Cards and Dashboard Charts named `WA %`, and the `WA Dashboard Block` Custom HTML Block.

Patches (`patches.txt`, post model sync): `add_indexes`, `backfill_contact_phone_e164`
(normalises existing Contact phones, and creates the custom field if the fixture has not synced
yet), and `enable_wizard_redirect`.

## 3. Connect the platform

### Onboarding wizard (`/app/wa-onboarding`)

The page is open to WhatsApp Manager and System Manager. Its API calls that write need **System
Manager**. The wizard is a rail of three panels: account data · terms · activation, ending in
"ready" (D-102). It supports sign-up with a code (WhatsApp, SMS or email), sign-in, password reset
and coupons.

When sign-in (`onboarding.login`) or sign-up (`complete_signup`) stores the credentials,
`services.onboarding.link_site` runs these steps (D-118):

1. test the connection (`health_check`, which fills the `connection_*` fields)
2. register this site's webhook endpoint and fetch its signing secret
   (`webhook_setup.ensure_endpoint(refresh_secret=True)`)
3. adopt the account's existing devices (`devices.adopt_from_provider`)

Each step is reported separately and none of them raises. A step that failed can be repeated
from the Settings window.

Setup counts as complete (`onboarding.complete_setup` → `setup_completed`) once all four steps in
`services.onboarding.steps` are done: **credentials** (platform address + `customer_api_key`,
`api_key`, `api_secret`) · **connection** `OK` · at least one **Connected device** · **webhook**
`Active`. **Known gap (R-042):** no screen calls `complete_setup` yet, so `setup_completed` stays
empty even on sites that work. Do not rely on the flag. Use `onboarding.get_status` (the steps)
or `has_credentials()` instead, which is what the redirect and the Home setup band do (D-140).

### Home → Wizard redirect

`WhatsApp Settings.redirect_unregistered_to_wizard` is **on by default** (D-140). The field default is `1`,
and the patch `enable_wizard_redirect` switches it on for existing sites. The `boot_session` hook
(`whatsapp_next/boot.py`) sets `frappe.boot.whatsapp_next.setup_redirect` from
`onboarding.should_redirect_to_wizard()`. That is true only when the redirect is on, the user is a
**System Manager**, and the site has **no platform credentials** yet. Home (`wa-home`) then routes
to `wa-onboarding` **once per browser session** (a `sessionStorage` key), so Home stays reachable
afterwards. A site that has credentials but no device or webhook stays on Home. To turn the
redirect off, clear the field (Settings → Onboarding).

### Manual path (no wizard)

1. Open the Settings window (`/app/wa-settings`) or the `WhatsApp Settings` form as a System
   Manager.
2. Enter the credentials. The Settings window calls `onboarding.save_credentials`, which writes
   them with `set_password` and records a `Credentials Changed` audit row.
3. Run **Test connection** (`settings.test_connection`) and **Register webhook**
   (`settings.setup_webhook`).
4. Pair a device on `/app/wa-devices`.

## 4. Site config keys

| Key | Where | Default | Meaning |
|---|---|---|---|
| `whatsapp_platform_base_url` | site or common config | none | The platform address used when `WhatsApp Settings.platform_base_url` is empty (D-103). Every site of the product talks to the same platform, so set it once per bench. Settings wins when set (for example to point one site at staging). The address is never copied into Settings (D-128). |
| `whatsapp_webhook_base_url` | site config | `frappe.utils.get_url()` | The public https base the platform should deliver webhooks to, when the site's own URL is private or behind a tunnel (D-119) |

```bash
bench --site <site> set-config whatsapp_platform_base_url https://platform.example.com
bench set-config -g whatsapp_platform_base_url https://platform.example.com   # every site
```

**Webhook receiver URL:**
`<whatsapp_webhook_base_url or site URL>/api/method/whatsapp_next.webhooks.v1.receiver.receive`
(`webhook_setup.receiver_url()`). It is registered on the platform automatically. The platform
delivers only to public **https** addresses.

## 5. Workers and scheduler

- **The scheduler must be enabled.** Every send leaves through `dispatch_tick` (every minute).
  Reconcile, the Numbers job, retention, alerts and syncs are scheduled too. See
  [architecture.md → Scheduler jobs](architecture.md#scheduler-jobs).
  ```bash
  bench --site <site> enable-scheduler
  bench --site <site> scheduler resume
  bench doctor
  ```
- **The scheduler must tick every minute.** Frappe's scheduler wakes every **240 s** by default
  (`DEFAULT_SCHEDULER_TICK` in `frappe/utils/scheduler.py`), so a `* * * * *` job such as
  `dispatch_tick` or `promote_scheduled` really runs once every four minutes: a quick send waits
  up to 4 min before it leaves, a scheduled campaign starts up to 4 min late, and the queue's
  messages-per-minute rate is spent once per tick. Set the tick to 60 s for the bench and restart
  the scheduler process (the platform's own queue runs on the same kind of job and needs it too):
  ```bash
  bench set-config -g scheduler_tick_interval 60
  sudo supervisorctl restart <bench>-workers:   # or however `frappe schedule` is supervised
  ```
- **Workers** must consume the `short` queue (sends, webhook processing, command routing, Numbers
  upsert) and the `long` queue (campaign materialisation, alerts). The standard bench Procfile or
  supervisor configuration runs both.
- After changing `hooks.py` or adding a Python module, reload the web workers (`bench restart`, or
  `kill -HUP` on the gunicorn master) (R-039).

## 6. WhatsApp Settings fields

`WhatsApp Settings` is a Single. Only System Manager can read and write it; WhatsApp Manager can
read it (D-014). Password fields are encrypted and never returned by any API. **(ro)** means the
system writes the field.

### Provider

| Field | Type | Default | Meaning |
|---|---|---|---|
| `provider` | Select `snd_platform` / `meta_cloud` | `snd_platform` | Registry key from the `whatsapp_providers` hook, checked on save (D-033) |
| `platform_base_url` | Data | — | Optional override. Must be `https://` with no trailing slash (D-034, D-103) |
| `request_timeout` | Int | 30 | Seconds, 5 to 120 |
| `connection_status` (ro) | Select Untested / OK / Failed | Untested | Result of the last test. Dispatch also sets it to `Failed` on an `AuthError` |
| `last_connection_test_at`, `last_connection_latency_ms`, `last_connection_error` (ro) | | | Details of the last test |

### Credentials

| Field | Type | Meaning |
|---|---|---|
| `customer_api_key` | Password | Customer key → `X-SND-API-Key` |
| `customer_api_secret` | Password | The integration link's own secret → `X-SND-API-Secret` (D-130) |
| `api_key`, `api_secret` | Password | `Authorization: token key:secret` (D-020) |
| `credentials_updated_at` (ro) | Datetime | When the keys last changed |

### Webhook

| Field | Type | Default | Meaning |
|---|---|---|---|
| `webhook_secret` (ro) | Password | — | Signing secret fetched from the platform. You never type it |
| `webhook_endpoint` (ro), `webhook_endpoint_url` (ro) | Data | — | Platform endpoint id and the receiver URL registered with it |
| `webhook_status` (ro) | Select Active / Disabled / Locked / Revoked | — | Mirrored every hour (D-018) |
| `webhook_events` | JSON | — | Subscribed events. Defaults to `webhook_setup.DEFAULT_EVENTS` |
| `webhook_max_retries` | Select 1 / 3 / 5 | 3 | How often the platform retries a delivery |
| `webhook_synced_at`, `webhook_last_event_at` (ro) | Datetime | — | Last mirror; last **valid** delivery |

### Queue

| Field | Type | Default | Meaning |
|---|---|---|---|
| `messages_per_minute` | Int | 20 | Per-device send rate, 5 to 60, and never above `plan_messages_per_minute` |
| `max_attempts` | Int | 3 | Tries before a message goes to Dead Letter (at least 1) |
| `retry_backoff_seconds` | Int | 300 | First retry delay (at least 30); it doubles with each attempt |
| `queue_paused` (ro) | Check | 0 | Global pause. Set through the queue API (Manager) |
| `queue_paused_by`, `queue_paused_at`, `queue_pause_reason` (ro) | | | Who paused the queue, when and why |

### Commands

| Field | Type | Default | Meaning |
|---|---|---|---|
| `enable_commands` | Check | 0 | Route inbound text to commands |
| `command_service_user` | Link User | `wa-commands@<site>` | Required when commands are on. Must be enabled, not Administrator and not a System Manager |
| `unknown_command_reply` | Small Text | — | Reply sent when no command matches (direct chats only). Leave it empty for no reply |
| `send_receipt_reply`, `receipt_reply` | Check, Small Text | 0 | A short acknowledgement sent before running a command |
| `reply_device` | Link WhatsApp Device | — | Device that sends replies. Empty means the device that received the message |

### Policy

| Field | Type | Default | Meaning |
|---|---|---|---|
| `default_device` | Link WhatsApp Device | — | Used when a send names no device |
| `default_country` | Link Country | System Settings country | Region for national numbers (required) |
| `global_blacklist_group` | Link WhatsApp Contact Group | — | Must be a group of kind `Blacklist`. Its members never receive anything |
| `send_only_to_known_numbers` | Check | 0 | Outside campaigns, send only to numbers that have messaged you or are confirmed |

### Picker

| Field | Type | Meaning |
|---|---|---|
| `picker_sources` | Table (WhatsApp Settings Picker Source) | DocTypes the ContactPicker can take recipients from |

### Retention (0 = keep forever; run by `services.retention.purge` at 03:00)

| Field | Default | Purges |
|---|---|---|
| `outbound_retention_days` | 365 | WhatsApp Log in Sent / Delivered / Read / Failed / Cancelled, by `creation` |
| `inbound_retention_days` | 365 | WhatsApp Inbound Message, by `received_at` |
| `queue_retention_days` | 7 | Completed / Deleted / Dead Letter queue items, by `modified` |
| `webhook_event_retention_days` | 30 | WhatsApp Webhook Event, by `received_at` |
| `audit_retention_days` | 365 | WhatsApp Audit Log, by `timestamp` |
| `numbers_watermark`, `numbers_last_run_at` (ro) | — | Watermark and last run of the nightly Numbers job |

### Subscription (all read-only; `usage_sync.sync_subscription` refreshes them every hour)

`plan_code`, `plan_name`, `subscription_status`, `message_limit`, `messages_used`,
`messages_remaining`, `plan_messages_per_minute`, `device_limit`, `wallet_balance`,
`wallet_currency`, `subscription_start`, `subscription_end`, `plan_features` (JSON),
`subscription_synced_at`.

### Onboarding

| Field | Type | Default | Meaning |
|---|---|---|---|
| `setup_completed`, `setup_completed_at` (ro) | Check, Datetime | 0 | Set by `complete_setup` once all four steps are done. No screen calls it yet (R-042) |
| `redirect_unregistered_to_wizard` | Check | **1** | Send System Managers on a site with no credentials from Home to the wizard (§3) |

## 7. Required step for the site admin: core `Contact` permissions

Frappe's standard `Contact` grants role **All** read, write and create. Until those rights are
removed, a `WhatsApp Contact User` can open `/app/contact` directly. The app's own screens stay
correctly scoped either way. The app never changes core permissions (D-125, R-028). It prints a
warning on install and migrate, and Settings → Policy shows the state. To fix it, remove the rights
for `All` in the Role Permission Manager (`/app/permission-manager/Contact`). See
[permissions.md](permissions.md).

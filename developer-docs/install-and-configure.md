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

## 2. What install and migrate do

Nearly everything the app needs on a site is a **file in the folder Frappe syncs it from**. The
hooks in `whatsapp_next/install.py` do only what has no such folder.

### Files Frappe syncs by itself

| What | File | Frappe handler |
|---|---|---|
| DocTypes, Pages, the `WhatsApp` Workspace | `whatsapp_next/whatsapp_next/{doctype,page,workspace}/` | `frappe.model.sync.sync_for` |
| Roles | Named in the DocTypes' permissions: Frappe creates a role when it syncs a DocType that names it (`make_module_and_roles`). All four product roles are named by a DocType. `fixtures/role.json` then sets their properties. | `sync_for`, then `sync_fixtures` |
| Composite indexes | `on_doctype_update()` in the controller module of each DocType that has one (Log, Inbound Message, Queue Item, Audit Log, Notification, Notification Alert, Webhook Event). It also adds the composite **unique** keys `(device, provider_message_id)` on Inbound (D-035) and `(event_name, event_id)` on Webhook Event (D-047). | Called by Frappe when it syncs the DocType |
| The desktop tile | `whatsapp_next/desktop_icon/whatsapp.json`: a standard Desktop Icon (`Link` → Workspace Sidebar `WhatsApp`) whose `logo_url` is `/assets/whatsapp_next/images/whatsapp-beta-icon.svg`. The sidebar header draws the same icon: it looks up the Desktop Icon whose label is the sidebar's title. | `sync_for` (app-level folder) |
| The sidebar | `whatsapp_next/workspace_sidebar/whatsapp.json` | `sync_for` (app-level folder) |
| Number Cards, Dashboard Charts (`WA …`) | `whatsapp_next/whatsapp_next/number_card/<name>/`, `dashboard_chart/<name>/` — standard module documents | `frappe.utils.dashboard.sync_dashboards` |
| The custom field **`Contact Phone.wa_phone_e164`** (Data, indexed, hidden, read-only, D-028) | `whatsapp_next/whatsapp_next/custom/contact_phone.json`, the file Customize Form → *Export Customizations* writes (`custom_fields`, `custom_perms`, `property_setters`, `links`, `doctype`, `sync_on_migrate: 1`) | `frappe.modules.utils.sync_customizations` |
| `WA Dashboard Block` (Custom HTML Block — Frappe has no module folder for it) | `fixtures/custom_html_block.json` | `frappe.utils.fixtures.sync_fixtures` |
| Standard templates, notifications, alerts | `fixtures/standard_*.json`. See [standard-content.md](standard-content.md) | `sync_fixtures`, under the rules of `services/standards.py` |

A standard Desktop Icon or Workspace Sidebar **without** a file is deleted by every migrate
(`remove_orphan_entities`). That is why the tile must be a file and not a row made in code.

`add_to_apps_screen` is not declared in `hooks.py`. With it, Frappe adds an App icon of its own
when the app is installed, which would be a second tile for the same product.

### What the hooks do (`whatsapp_next/install.py`)

| Hook | Does | Why it is code |
|---|---|---|
| `after_install` | Creates the command service user `wa-commands@<site>`: a System User that is **disabled, with no roles and no welcome mail**, and names it in WhatsApp Settings → `command_service_user`. Commands run as this user, never as Administrator (D-012). To use commands, enable it and grant only what your functions need. It must not be a System Manager. | The user's name carries the site, and a User fixture would be replaced on every migrate together with what the admin granted it |
| `after_install`, `after_migrate` | Prints a warning while role `All` still has rights on `Contact` (see §7). Creates and changes nothing. | It reads the site's own permissions |
| `before_uninstall` | Deletes the standard-content fingerprints the app keeps in `tabDefaultValue` | They belong to no DocType of the app |

Nothing is created or re-asserted on migrate. The default country is not copied into WhatsApp
Settings any more: `services.phone.default_region` reads Settings first and falls back to System
Settings → Country, so an empty field means "the site's country".

### `bench --site <site> install-app whatsapp_next`, step by step

1. `sync_for`: DocTypes are created. For each one Frappe creates the roles its permissions name
   and calls `on_doctype_update()`, which builds the composite indexes. Then the Pages, the
   Workspace, `desktop_icon/whatsapp.json` and `workspace_sidebar/whatsapp.json`.
2. `after_install`: the disabled command service user, named in Settings; the Contact warning.
3. Frappe's own `after_app_install`: it would create a Desktop Icon for a public workspace that
   has none. Ours exists from step 1, so it creates nothing.
4. `sync_fixtures`: the role properties, the HTML block, the standard content (26 records, all
   notifications and alerts switched off).
5. `sync_customizations`: the custom field and its column.
6. `sync_dashboards`: the Number Cards and Dashboard Charts.

Until step 5 the `Contact.validate` hook does nothing (`services/phone.py` checks the field
first), so a Contact saved in between is never refused.

### `bench --site <site> migrate`, step by step

1. Patches: none (`patches.txt` is empty).
2. `sync_for`: only files that changed. A DocType whose JSON changed is re-synced and its
   `on_doctype_update()` runs again (an index that exists is skipped).
3. `sync_fixtures`: role properties and the HTML block are rewritten from the files; standard
   content follows [its own rules](standard-content.md) (your on/off, device, recipients and edits
   are kept).
4. `sync_dashboards`, `sync_customizations`: the custom field's row is updated in place.
5. `remove_orphan_entities`: finds nothing of this app to delete, because every standard record
   has its file.
6. `after_migrate`: the Contact warning.

**The custom field's column is never dropped or emptied.** `sync_customizations` looks the Custom
Field up by DocType and fieldname and updates that one row in place. It does not touch the custom
fields other apps have on the same DocType, and the schema sync that follows adds columns and
never removes one. Checked on the development site: the column, its index and the existing
`wa_phone_e164` values were identical before and after.

`wa_phone_e164` is filled when a Contact is saved; Contacts that existed before the app was
installed have it empty until their next save.

### Changing one of these files

- Desktop Icon, Workspace, Workspace Sidebar, Number Card, Dashboard Chart: edit the record on a
  site in **developer mode**; Frappe writes the file when you save a standard record.
- Custom field: Customize Form → *Actions → Export Customizations*, module **WhatsApp Next**,
  "Sync on Migrate" ticked. Do not add `Custom Field` or `Property Setter` to `hooks.py → fixtures`.
- A composite index: add it to `COMPOSITE_INDEXES` in the DocType's controller. It is built the
  next time that DocType is synced.

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

### Redirect to the wizard

`WhatsApp Settings.redirect_unregistered_to_wizard` is **on by default** (D-140). The field default is `1`,
and the patch `enable_wizard_redirect` switches it on for existing sites. The `boot_session` hook
(`whatsapp_next/boot.py`) sets `frappe.boot.whatsapp_next.setup_redirect` from
`onboarding.should_redirect_to_wizard()`. That is true only when the redirect is on, the user is a
**System Manager**, and the site has **no platform credentials** yet. Entering any screen of the app
then routes to `wa-onboarding` **once per browser session** (a `sessionStorage` key), so the app stays
reachable afterwards. "Any screen" is a `wa-*` Page, the `WhatsApp` workspace, or a list or form of a
`WhatsApp …` DocType (`public/js/desk/setup_redirect.js`): a theme's app rail may open the workspace
rather than Home, so the redirect does not depend on Home being opened. A site that has credentials but no device or webhook stays on Home. To turn the
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
| `whatsapp_platform_base_url` | site or common config | `https://w-platform.dev.sanad.digital` (`registry.DEFAULT_PLATFORM_BASE_URL`) | The platform address used when `WhatsApp Settings.platform_base_url` is empty (D-103). Every site of the product talks to the same platform, so set it once per bench. Settings wins when set (for example to point one site at staging). The address is never copied into Settings (D-128). |
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

# Events and hooks

## Hooks this app defines (for other apps)

Other apps declare these in their own `hooks.py`. `frappe.get_hooks` merges them across installed
apps.

### `whatsapp_providers`: add a provider

A dict of registry key → dotted class path to a `BaseProvider` subclass.
`providers.registry.provider_classes()` reads it. When two apps declare the same key, the **last
app wins**. The key is what `WhatsApp Settings.provider` stores, and the Settings controller checks
it on save (D-033).

```python
# my_app/hooks.py
whatsapp_providers = {
	"my_gateway": "my_app.whatsapp.MyGatewayProvider",
}
```

This app registers `snd_platform` and `meta_cloud`. The full contract is in
[add-a-provider.md](add-a-provider.md).

### `whatsapp_function_catalogs`: ship command functions

A list of **module paths**. Each module directory holds `vN/catalog.json` manifests
(`{catalog_version, functions[{function_key, function_name, category, description, when_to_use,
party_types[], versions{"x.y.z": {released, changelog, inputs, settings, outputs, example,
suggested_commands}}}]}`, D-048). `services.functions_catalog.load_catalog` merges this app's
catalog (`whatsapp_next.functions.catalog`) with every hooked module. Later sources and versions
extend earlier ones per `function_key`. The merged catalog is cached under `wa:functions:catalog`.

```python
# my_app/hooks.py
whatsapp_function_catalogs = ["my_app.whatsapp_functions"]
# → my_app/whatsapp_functions/__init__.py + my_app/whatsapp_functions/v1/catalog.json
```

A catalog file may name the apps its functions read, with a top-level
`"requires_apps": ["other_app"]`. On a site where one of them is not installed the file is
skipped, so its functions are never offered. This is how whatsapp_next ships functions over
another app's data without that app depending on it:
`whatsapp_next/functions/integrations/snd_accounting/` holds the accounting functions
(customer balance and statement for the sender's own customer; customer, supplier, cash and bank
balances for staff) over snd_accounting's reports. Its handlers import snd_accounting only when
called, and snd_accounting itself is not changed.

### `whatsapp_function_handlers`: register the code behind a function

A dict of `function_key` → dotted path of a handler. `functions.registry` merges it with the
built-in handlers (`ping`, `document_info`) once per process. An inbound command can only run a
handler from this registry, never a dotted path from data (D-012). A key that cannot be resolved
is logged as "WhatsApp functions: handler hook unresolved".

```python
# my_app/hooks.py
whatsapp_function_handlers = {"order_status": "my_app.whatsapp_functions.order_status.handle"}

# my_app/whatsapp_functions/order_status.py
from whatsapp_next.functions.context import FunctionContext, FunctionResult

def handle(ctx: FunctionContext) -> FunctionResult:
	# ctx.args (parsed from the manifest inputs), ctx.settings, ctx.sender, ctx.device, ctx.dry_run
	# runs as WhatsApp Settings.command_service_user, never Administrator
	return FunctionResult(data={"status": "Shipped"})   # or FunctionResult(error="…")
```

`FunctionResult` also takes `files: list[tuple[str, bytes, str]]`. The command's output templates
render `data.*`. Handlers are cached per process, so reload the workers after adding one.

## Frappe hooks this app uses

| Hook | Value | Purpose |
|---|---|---|
| `required_apps` | `["frappe", "erpnext"]` | |
| `app_home`, `app_logo_url` | `/app/wa-home` | `add_to_apps_screen` is off: the one desktop tile is the standard Desktop Icon in `whatsapp_next/desktop_icon/whatsapp.json`, shown to users whose sidebar has a visible item |
| `after_install`, `after_migrate`, `before_uninstall` | `whatsapp_next.install.*` | Install seeds the command service user; migrate creates nothing; uninstall drops the standard records' fingerprints. See [install-and-configure.md](install-and-configure.md#2-what-install-and-migrate-seed) |
| `boot_session` | `whatsapp_next.boot.boot_session` | Adds `frappe.boot.whatsapp_next = {setup_redirect: bool}`, which drives Home → Wizard. It never raises |
| `fixtures` | Roles (the 4 product roles), the Custom HTML Block named `WA %`, and the standard Templates / Notifications / Alerts ([standard-content.md](standard-content.md)) | The custom field lives in `whatsapp_next/custom/`, Number Cards and Dashboard Charts in their module folders |
| `doc_events` | see below | |
| `ignore_links_on_delete` | Webhook Event, Queue Item, Audit Log, WhatsApp Log, Inbound Message, WhatsApp Number | History never blocks deleting a device, contact or campaign (D-061) |
| `scheduler_events` | see below | |
| `app_include_js` / `app_include_css` | `whatsapp_next.bundle.js` / `whatsapp_next.bundle.css` | The kit, `whatsapp_next_setup.js`, the screens |
| `doctype_js` | 12 DocTypes → `public/js/form/<dt>.js` | Form customisation (D-057) |
| `doctype_list_js` | 12 DocTypes → `public/js/listview/<dt>_list.js` | List customisation (D-057) |

### `doc_events`

| DocType | Event | Handler | Note |
|---|---|---|---|
| `Contact` | `validate` | `services.phone.sync_contact_phones` | Keeps `Contact Phone.wa_phone_e164` normalised |
| `*` | `validate`, `on_update`, `on_submit`, `on_cancel`, `after_insert`, `on_change` | `services.notifications.on_doc_event` | Fires `WhatsApp Notification`. Returns at once during install, migrate or patch, for `WhatsApp *` DocTypes, and when no notification is configured for the DocType (a cached per-DocType list under `wa:notif:*`, R-023). `after_insert` → `New`; `on_update` → `Save` (existing docs only) and `Value Change`; `on_submit` → `Submit`; `on_cancel` → `Cancel`. `validate` is handled only for `Method` notifications (D-049) |
| `WhatsApp Log`, `WhatsApp Inbound Message` | `after_insert` | `services.numbers_materializer.on_message_insert` | Enqueues the incremental Numbers upsert after commit |

### `scheduler_events`

| Schedule | Handler |
|---|---|
| `cron * * * * *` | `services.dispatch.dispatch_tick`, `services.campaign_runner.promote_scheduled` |
| `cron */5 * * * *` | `services.reconcile.reconcile_statuses`, `services.notifications.trigger_offset` |
| `cron */10 * * * *` | `webhooks.handlers.reprocess_failed` |
| `cron */15 * * * *` | `services.alerts.run_due_alerts` |
| `cron 30 2 * * *` | `services.numbers_materializer.nightly_reconcile` |
| `cron 0 3 * * *` | `services.retention.purge` |
| `hourly` | `services.devices.sync_from_provider`, `services.usage_sync.sync_subscription`, `services.webhook_setup.sync_status` |
| `daily` | `services.notifications.trigger_daily`, `services.functions_catalog.check_updates` |

All handlers are under `whatsapp_next.`. What each job does is in
[architecture.md](architecture.md#scheduler-jobs).

## Realtime events (`wa:*`)

Every event is published with `frappe.publish_realtime(..., after_commit=True)`, except
`wa:import:progress`, which uses `after_commit=False`. No payload carries a phone number or a
message body.

| Event | Room | Payload | Publisher |
|---|---|---|---|
| `wa:device:status` | site, and doc room `WhatsApp Device/<name>` | `device, status, previous, at, source` (`status` is `Deleted` on delete) | `services/devices.apply_state`, `devices.delete` |
| `wa:pairing:status` | the user who started pairing | `device, mode, expires_at` | `services/devices.start_pairing` |
| `wa:message:status` | site, and doc room `WhatsApp Log/<name>` | `outbound, status, at, error_code, campaign, device` | `services/dispatch._publish_message_status` |
| `wa:queue:progress` | site | `device, queued, sending, paused, dead_letter, completed, held, sent_last_minute, paused_globally, paused_by, paused_at, pause_reason, rate, plan_rate` | `services/dispatch.publish_progress` (at most one per second per device; `force` on global pause and resume) |
| `wa:inbound:received` | site | `inbound, device, key_hash` (SHA-1 of the number key) | `services/inbound._publish` |
| `wa:campaign:status` | site, and doc room `WhatsApp Campaign/<name>` | `campaign, status, counters` | `services/campaign_runner._publish` |
| `wa:import:progress` | the uploading user | `kind, stage (parsing / parsed), total`, plus `valid, invalid` when parsed | `services/picker.parse_upload` |

Pages subscribe with `frappe.realtime.on(...)` and unsubscribe when hidden (for example `wa-home`,
`wa-devices`, `wa-simulator`, `wa-contacts`).

```js
frappe.realtime.on("wa:message:status", (p) => {
	if (p.outbound === my_log_name) refresh(p.status);
});
```

## Webhook events handled by the receiver

`POST /api/method/whatsapp_next.webhooks.v1.receiver.receive`. The SND provider reads the headers
`X-SND-Event`, `X-SND-Event-ID`, `X-SND-Timestamp` and `X-SND-Signature`. The request is signed
with HMAC-SHA256 over `<timestamp>.<raw body>` (D-013). `webhooks/handlers.handle_event` handles
these events:

| Event | Handling |
|---|---|
| `message.sent` / `message.delivered` / `message.read` | `dispatch.apply_status` → Sent / Delivered / Read (forward-only). The payload is blanked once processed |
| `message.failed` | `errors.classify` → `apply_status(Failed, error_code)` |
| `message.held` | `apply_status(Held)` |
| `message.received` | `inbound.record_inbound` → Numbers upsert, command routing, `wa:inbound:received` |
| `message.reaction` | `inbound.record_reaction` (an Inbound row of type `Reaction`) |
| `connection.connected` / `connection.disconnected` / `connection.logged_out` | `devices.apply_connection_event` → Connected / Disconnected / Logged Out |
| `group.updated` / `group.participants.updated` | `numbers_materializer.refresh_group_name` |
| anything else | stored, status `Ignored` |

`webhook_setup.DEFAULT_EVENTS` subscribes to exactly the events above. An event for a device this
site does not know is stored as `Ignored` ("unknown device"). The receiver never creates a device.
The response codes are listed in [api/webhooks.md](api/webhooks.md).

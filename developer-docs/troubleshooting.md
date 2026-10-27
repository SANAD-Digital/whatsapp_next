# Troubleshooting

Useful places to look first: **Error Log** (titles start with `WhatsApp …`), the `WhatsApp Webhook
Event` list (status, `error`, `signature_valid`, `timestamp_fresh`), the `WhatsApp Queue Item`
list (`last_error`, attempts), `WhatsApp Log.error_code`, `WhatsApp Audit Log`, and
`WhatsApp Settings` (connection and webhook status).

## Symptom → cause → fix

| Symptom | Likely cause | Fix |
|---|---|---|
| Messages stay **Queued** forever and nothing is sent | The scheduler is disabled. `dispatch_tick` runs from `scheduler_events` every minute | `bench --site <site> enable-scheduler` and `bench --site <site> scheduler resume`. Check with `bench doctor` |
| Queued, the scheduler runs, still nothing sent | No worker is consuming the `short` queue | Start workers for `short` (and `long` for campaigns and alerts). See [install-and-configure.md §5](install-and-configure.md#5-workers-and-scheduler) |
| Queued, workers fine | Global pause: `WhatsApp Settings.queue_paused = 1` makes `dispatch_tick` do nothing. A pause-only action raises `WAQueuePausedError` (409 `queue_paused`) | Resume from the Queue screen (Manager). `queue_paused_by`, `queue_paused_at` and `queue_pause_reason` say who paused it and why |
| Queued on one device only | That device is not `Connected`, is `disabled`, or has no `platform_device`. `dispatch_device_batch` skips it. Sends to it raise `WADeviceOfflineError` (409 `device_offline`) | Re-pair it on `/app/wa-devices`. The hourly `devices.sync_from_provider` and the `connection.*` webhooks update the status |
| A batch fails and the device flips to **Disconnected** | The provider raised `DeviceOfflineError` on the whole call. Every claimed row went back to `Queued` with back-off | Reconnect the device. The rows are then sent on the next tick |
| Items stuck in **Sending** | A worker died after claiming them | `reconcile.requeue_stale_claims` (every 5 minutes) puts claims older than 10 minutes back in the queue |
| Items in **Dead Letter** | `max_attempts` was used up, or the error is not retryable | Read `error_code` (table below), fix the cause, then **Retry** (`dispatch.retry_dead_letter`) |
| `connection_status = Failed`, sends fail with `auth` | Credentials rejected (`AuthError` → `WAProviderAuthError` 424), or the link is suspended or revoked | Sign in again in the wizard, or check the keys in Settings and run **Test connection** |
| "Platform base URL is not configured" (`AuthError NOT_CONFIGURED`) | Not raised by a fresh site any more: with Settings and `whatsapp_platform_base_url` both empty, the address is `registry.DEFAULT_PLATFORM_BASE_URL` (R-027) | `bench --site <site> set-config whatsapp_platform_base_url https://…` (D-103) |
| "This site does not know where the WhatsApp platform is" on sign-in | Same as above | Same as above |
| Status stays **Sent** or **Sending**, never Delivered / Read | Webhooks are not arriving: `webhook_status` is not `Active`, the endpoint is `Locked` after failed deliveries, or the site URL is not public https | Settings → Webhook → **Register** (`settings.setup_webhook`). Set `whatsapp_webhook_base_url` when the site sits behind a private host or tunnel (D-119). `reconcile_statuses` catches missed statuses every 5 minutes in the meantime |
| Webhook Events stored as **Ignored, "invalid signature"** (HTTP 401) | The secret changed on the platform, or the body was altered by a proxy | After 5 failures in 10 minutes the receiver enqueues `webhook_setup.fetch_secret` on its own. To force it, use **Rotate secret** or **Register webhook** in Settings |
| Ignored, **"stale timestamp"** (HTTP 401) | `X-SND-Timestamp` is more than 300 s away from server time (`verify.MAX_SKEW_SECONDS`) | Sync the server clock (NTP) on both sides. A later correctly signed retry of the same event takes over the rejected row |
| Receiver answers **503 "webhook secret not configured"** | `webhook_secret` is empty (logged once every 10 minutes) | Register the webhook, which fetches and stores the secret |
| Receiver answers **429** | More than 600 requests per minute from one IP (`RATE_LIMIT_PER_MINUTE`) | A platform retry storm or a misconfigured proxy that makes every request appear from one IP |
| Receiver answers **401 "missing headers"** | Event id or signature header is absent | The sender is not the platform, or a proxy strips `X-SND-*` headers |
| Webhook Event **Ignored, "unknown device"** | The event names a platform device this site has no row for. The receiver never creates devices | Adopt the account's devices: sign in again (runs `devices.adopt_from_provider`, D-118) |
| Webhook Event **Failed** | The handler raised an error | `reprocess_failed` retries it 3 times (every 10 minutes). After that, read `error` and the Error Log |
| Inbound commands get no reply | `enable_commands` is off; `command_status` shows `Blocked` or `Not Matched`; or the service user is misconfigured ("Command Service User is not configured / is disabled / must not be a System Manager", `WAStateConflictError`) | Check the Inbound row's `command_status`. Enable `wa-commands@<site>` (D-123) and grant it only the roles your functions need |
| Function reported **inactive** | The `WhatsApp Function` is not `Active`, or no handler is registered for its `function_key` | Install or activate it in the Functions Center. For a hooked handler, reload the workers |
| "Commands are routed by the worker, not in a web request" | Something called `command_router.route` in a request without `dry_run` | Enqueue it, as `services.inbound` does |
| "… can only be changed by the system" (`WAStateConflictError`) | A status field was edited outside `status_writer()` (D-038) | Change state through the service or API (`dispatch`, `campaign_runner`, …), never by writing to the document |
| Send refused with `blacklisted` / `unknown_number_policy` / `invalid_phone` | Global blacklist group, `send_only_to_known_numbers`, or `phone.normalize` returned `None` | Check the number and the Policy settings. National numbers use `default_country` |
| PDF attachments or alert reports fail: `OSError: No wkhtmltopdf executable found` or "PDF rendering failed" (`WAFileError`) | `wkhtmltopdf` is not installed. Print Format PDFs (`attachments.render_print_pdf`) and alert reports (`report_render`) need it. 5 tests fail for the same reason (plan/12-test-report.md) | Install the `wkhtmltopdf` build Frappe recommends on the bench host. An alert test can also be sent with "No file" |
| New endpoint returns 500 "module has no attribute", or a `hooks.py` change seems ignored | Gunicorn still has the old module or hooks loaded (R-039) | `bench restart`, or `kill -HUP` on the gunicorn master. Restart the workers too |
| Changed data or code still shows old values | Cached keys, some without an expiry: `wa:commands:map` (cleared on Command save), `wa:functions:catalog` (`functions_catalog.clear_cache`), `wa:notif:*` (cleared on Notification save), `wa:settings` (cleared on Settings save) | Save the owning document, or run `bench --site <site> clear-cache` |
| Assets or a kit change not visible | The bundle was not rebuilt | `bench build --app whatsapp_next`, then reload the browser without cache |
| A `WhatsApp Contact User` can still open `/app/contact` | Core `Contact` grants role `All` (R-028, D-125) | Remove `All` rights in `/app/permission-manager/Contact` |
| A test run wiped demo or site data, or tests fail at random | Two full suites ran on the same site at the same time, or an older suite version was used (R-034, R-041) | Run one full suite at a time. See [CONTRIBUTING.md](CONTRIBUTING.md#tests) |

## API error classes (`whatsapp_next/exceptions.py`)

Every endpoint maps provider exceptions to these classes (`api._common.api_endpoint`, D-039). The
JSON error carries `exc_type` and the class `code`.

| Class | HTTP | `code` | Raised when |
|---|---|---|---|
| `WAPermissionError` | 403 | `permission` | Role or document permission missing |
| `WAValidationError` | 417 | `validation` | Bad or unknown argument, schema violation |
| `WAInvalidPhoneError` | 417 | `invalid_phone` | `phone.normalize` returned `None` |
| `WABlacklistedError` | 417 | `blacklisted` | Recipient in the global or command blacklist |
| `WAUnknownNumberPolicyError` | 417 | `unknown_number_policy` | `send_only_to_known_numbers` blocks the recipient |
| `WAFileError` | 417 | `file` | Upload not private, not owned, too large, unparsable; PDF render failure |
| `WANotFoundError` | 404 | `not_found` | Record or key unknown |
| `WAStateConflictError` | 409 | `state_conflict` | Action not allowed in the current state |
| `WADeviceOfflineError` | 409 | `device_offline` | Device not Connected |
| `WAQueuePausedError` | 409 | `queue_paused` | Action needs a running queue |
| `WAProviderRejectedError` | 422 | `provider_rejected` | Platform business rejection (`reason`, `provider_code`) |
| `WANotSupportedError` | 422 | `not_supported` | The active provider lacks the capability (422, not 501: Desk's `request.js` breaks on 501) |
| `WARateLimitError` | 429 | `rate_limit` | Provider or local rate limit |
| `WAProviderAuthError` | 424 | `provider_auth` | Credentials rejected by the platform |
| `WAProviderUnavailableError` | 503 | `provider_unavailable` | Transient provider failure |

Provider-side exceptions (`providers/exceptions.py`): `AuthError`, `PermissionDeniedError`,
`NotFoundError`, `ValidationError`, `BusinessRejectedError` (with `QuotaExceededError` and
`FeatureNotInPlanError` under it), `DeviceOfflineError`\*, `RateLimitError`\* (`retry_after`),
`TransientError`\*, `NotSupportedError`, `WebhookSignatureError`. \* means `retryable = True`.

## `WhatsApp Log.error_code` vocabulary (`services/errors.py`)

`errors.classify` checks the exception type first, then the platform code, then patterns in the
error text. It masks phone numbers in the stored message.

| Code | Retried | Typical source |
|---|---|---|
| `device_disconnected` | yes | `DeviceOfflineError`; `DEVICE_NOT_CONNECTED`, `DEVICE_NO_TOKEN`, `DEVICE_NOT_FOUND`, `DEVICE_NOT_OWNED` |
| `timeout` | yes | `TransientError`, timeouts, 5xx; `PROVIDER_ERROR`, `INTERNAL_ERROR` |
| `rate_limited` | yes | `RateLimitError`; `RATE_LIMITED` |
| `recipient_not_registered` | no | "not on WhatsApp" type texts |
| `insufficient_balance` | no | `QuotaExceededError`; `QUOTA_EXCEEDED`, `SUBSCRIPTION_INACTIVE`, `SUBSCRIPTION_EXPIRED` |
| `auth` | no | `AuthError`, `PermissionDeniedError`, `WebhookSignatureError`; `AUTH_*`, `LINK_SUSPENDED`, `LINK_REVOKED`, `LINK_PENDING`, `CUSTOMER_SUSPENDED` |
| `platform_rejected` | no | `BusinessRejectedError`, `FeatureNotInPlanError`, `NotSupportedError`; `INVALID_MESSAGE_TYPE`, `FEATURE_NOT_IN_PLAN`, `CLIENT_REF_DUPLICATE` |
| `invalid_phone` | no | `RECIPIENT_REQUIRED`, "invalid phone" texts |
| `invalid_template` | no | Text mentioning a template |
| `blacklisted`, `unknown_number_policy` | no | Local policy checks |
| `unknown` | no | Nothing matched |

## Bench configuration: `developer_mode` lives in each site's config

On the development bench `developer_mode` is **not** in `sites/common_site_config.json`. It was
moved out (October 2026) because realtime (socket.io) authentication failed while it was set
bench-wide, and moving it fixed the symptom. It is set to `1` in each site's own
`sites/<site>/site_config.json` instead: 27 sites on 2026-10-26.

- **A new site does not inherit it.** Turn it on for that site alone:
  `bench --site <site> set-config developer_mode 1`.
- **Do not put it back in `common_site_config.json`** without re-testing realtime: device status,
  message ticks and queue progress all ride on socket.io.
- **Check the state:** `grep -c developer_mode sites/common_site_config.json` gives `0`, and
  `grep -l '"developer_mode": 1' sites/*/site_config.json | wc -l` counts the sites that have it.
- **Root cause: not established.** Only the symptom (socket.io auth with the bench-wide flag) is
  known. Look at it before the next Frappe upgrade.

## Useful commands

```bash
cd /path/to/frappe-bench
bench doctor                                            # scheduler / workers status
bench --site <site> enable-scheduler
bench --site <site> clear-cache
bench build --app whatsapp_next
bench --site <site> console                             # then, e.g.:
# from whatsapp_next.services import numbers_materializer; numbers_materializer.nightly_reconcile(full=True)
# from whatsapp_next.services import reconcile; reconcile.reconcile_statuses()
```

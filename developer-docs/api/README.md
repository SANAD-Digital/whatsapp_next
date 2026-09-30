# whatsapp_next API reference

This folder documents every whitelisted endpoint of `whatsapp_next`. It is written for a
developer who calls them from Desk JavaScript, from another Frappe app on the same bench, or over
HTTP from outside. Everything here comes from the code. The endpoint modules live in
`whatsapp_next/api/v1/<area>.py`, the shared decorator in `whatsapp_next/api/_common.py`, the role
groups in `whatsapp_next/api/v1/_roles.py`, and the exceptions in `whatsapp_next/exceptions.py`.

## 1. Paths and versioning

Each endpoint is a Python function in `whatsapp_next/api/v1/<area>.py`. Frappe routes whitelisted
functions by their dotted path:

| Use | Form |
|---|---|
| Dotted path (Python, `frappe.call`) | `whatsapp_next.api.v1.<area>.<fn>` |
| HTTP | `/api/method/whatsapp_next.api.v1.<area>.<fn>` |
| Desk kit key (`sanad.ui.call`) | `"<area>.<fn>"` |

**Versioning (decision D-031).** The version is a Python package in the path (`api/v1/`). A
breaking change goes into a new package, `api/v2/`, and `v1` stays as it is. A deprecation is
always documented, never silent. The decorator (`api/_common.py`) and the business logic
(`services/`) don't depend on a version, so every version calls the same services.

Frappe's own `/api/v1/…` and `/api/v2/…` URL prefixes version Frappe's REST protocol, not this
app, and are unrelated to the scheme above. For example,
`/api/v2/method/whatsapp_next.api.v1.home.get_dashboard` still calls this app's **v1**
function. The only difference is Frappe's v2 response envelope (see §6).

The inbound webhook receiver has its own versioned package:
`whatsapp_next.webhooks.v1.receiver.receive` (see [webhooks.md](webhooks.md)).

## 2. Authentication

Every endpoint requires a logged-in user. None is guest-accessible, because `allow_guest` is
reserved for the webhook receiver and a test enforces this.

| Caller | How |
|---|---|
| Desk / browser | The Frappe session cookie. `frappe.call` sends the CSRF token for you. |
| Server to server | `Authorization: token <api_key>:<api_secret>`, where the key pair is generated on a **User** record (User → Settings → API Access). The call runs as that user, with that user's roles. |
| Another app on the same bench | Import and call the function directly (`from whatsapp_next.api.v1 import queue; queue.get_summary()`). The decorator still checks roles against `frappe.session.user`. For in-process work, prefer the `services/` layer. |
| OAuth bearer | `Authorization: Bearer <access_token>` (standard Frappe). |

`Administrator` passes every role gate.

## 3. The `api_endpoint` decorator

Every function under `api/` is wrapped by `whatsapp_next.api._common.api_endpoint`. A bare
`@frappe.whitelist` there fails the test `tests/test_api_common.py`. The decorator:

1. **Whitelists** the function with `frappe.whitelist(methods=…)`.
2. **Checks roles.** The user needs at least one of the endpoint's roles (§4). Otherwise it raises
   `WAPermissionError` (403). `roles=None` means the function runs its own
   `frappe.has_permission` check.
3. **Coerces arguments** from request strings to the annotated Python types:

   | Annotation | Accepted input |
   |---|---|
   | `int` | Digits, optionally with a leading `-`. Anything else → `WAValidationError`. An empty string → `None`. |
   | `bool` | `1 true yes on y` → true, `0 false no off n ""` → false (case-insensitive). Anything else is an error. |
   | `float` | Anything `frappe.utils.flt` reads. |
   | `list` / `dict` | A JSON string, or a real list/object in a JSON body. An empty string → `[]` / `{}`. |
   | `datetime` / `date` | Anything `get_datetime` / `getdate` parses (`2026-09-28`, `2026-09-28 14:30:00`). |
   | Optional (`X \| None`) | An empty string becomes `None`. This is how a form-encoded client sends `null`. |

4. **Rejects unknown arguments** (`Unknown argument: x`) and **missing required arguments**
   (`Missing argument: x`), both as `WAValidationError`. The keys `cmd` and `_` are ignored.
5. **Applies schema rules** declared on the endpoint after coercion: `enum`, `max_length`, `min`,
   `max`. A violation raises `WAValidationError` ("Invalid value for x", "x must be at most 365",
   and similar). The reference pages list these rules as "allowed values".
6. **Caps `page_length`** at **200** for any endpoint that has a `page_length` argument.
7. **Maps provider exceptions** (`providers.exceptions.*`) to the app's exceptions, each with its
   HTTP status (§5).

### Allowed HTTP methods

| Declared | Meaning |
|---|---|
| `POST` (the default) | Every endpoint that changes state. |
| `GET, POST` | Reads. GET is convenient for curl and caches. |

A request with any other method is refused by Frappe with **403** (`PermissionError`).

> **Use POST for anything that writes.** Frappe commits the database transaction only for
> POST/PUT/PATCH/DELETE requests. One GET-capable read writes as a side effect:
> `devices.list_devices(refresh=1)` applies the provider's device states. Over GET, those writes
> are not committed and their after-commit realtime events never fire, so call it with POST.

## 4. Role groups

Defined in `whatsapp_next/api/v1/_roles.py`. Any one of the listed roles is enough.

| Name in the code | Roles | Typical use |
|---|---|---|
| `SYSTEM_MANAGER` | System Manager | Credentials, sign-up, webhook registration, settings writes (**admin-only**) |
| `MANAGER` | WhatsApp Manager, System Manager | Devices, queue control, bulk send, settings reads |
| `AGENT_UP` | WhatsApp Agent + `MANAGER` | Quick send, resend, simulator |
| `VIEWER_UP` | WhatsApp Viewer + `AGENT_UP` | Dashboards, lists, message reads |
| `CONTACT_USER` | WhatsApp Contact User | The contextual contacts role. It is added to some groups, for example `VIEWER_UP + CONTACT_USER`. |
| `None` | No role gate. The endpoint calls `frappe.has_permission` itself. | `messages.get_conversation` |

Role checks happen **before** argument validation. A caller without the role gets 403 even when
their arguments are wrong.

## 5. Errors

All app errors subclass `frappe.ValidationError` (except `WAPermissionError`, which subclasses
`frappe.PermissionError`) and carry `http_status_code`. The server raises them with `frappe.throw`,
so the readable message also goes into `_server_messages`.

| Exception (`exc_type`) | HTTP | When |
|---|---|---|
| `WAPermissionError` | 403 | A role or document permission is missing |
| `WAValidationError` | 417 | Bad or missing argument, schema violation, business-rule refusal. Also used for a provider `ValidationError` / `NotFoundError`. |
| `WAInvalidPhoneError` | 417 | The number does not normalise to E.164 or a JID |
| `WABlacklistedError` | 417 | The recipient is on the global blacklist |
| `WAUnknownNumberPolicyError` | 417 | `send_only_to_known_numbers` blocks the recipient |
| `WAFileError` | 417 | The file is missing, of the wrong type for the message, or unreadable |
| `WANotFoundError` | 404 | The record is unknown |
| `WAStateConflictError` | 409 | The action isn't allowed in the record's current state |
| `WADeviceOfflineError` | 409 | No usable device, or the device isn't registered on the platform |
| `WAQueuePausedError` | 409 | The action needs a running queue |
| `WAProviderRejectedError` | 422 | The provider rejected the request as a business rule. The Python object carries `reason` and `provider_code`. |
| `WANotSupportedError` | 422 | The active provider lacks the capability. It returns 422, not 501, because Frappe's `request.js` mishandles a 501. |
| `WARateLimitError` | 429 | A provider or local rate limit |
| `WAProviderAuthError` | 424 | The platform rejected the credentials (`AuthError`, `PermissionDeniedError`, `WebhookSignatureError`) |
| `WAProviderUnavailableError` | 503 | A transient provider failure or offline device on the provider side, or any other provider error |
| `PermissionError` (Frappe) | 403 | A disallowed HTTP method, or a Frappe document permission raised inside a service |

The provider-to-app mapping is `map_provider_error` in `api/_common.py`. It applies to provider
exceptions that escape an endpoint.

### Error envelope

Frappe builds the response. The status is the class's `http_status_code`. The body for
`/api/method/…` (Frappe API v1) is:

```json
{
  "exc_type": "WAStateConflictError",
  "exception": "whatsapp_next.exceptions.WAStateConflictError: Campaign WA-CAMP-2026-00001 is Running",
  "_server_messages": "[\"{\\\"message\\\": \\\"Campaign WA-CAMP-2026-00001 is Running\\\", \\\"title\\\": \\\"Message\\\", \\\"indicator\\\": \\\"red\\\", \\\"raise_exception\\\": 1}\"]"
}
```

- Branch on **`exc_type`**, which is the exception class name. The short `code` attribute on each
  class (`validation`, `not_supported`, …) is **not** put into the response.
- `exception` (the last traceback line) appears only when tracebacks are allowed: on the dev
  server, or when System Settings → *Allow error traceback* is on and the caller is a system user.
- `_server_messages` is a JSON string of JSON strings. The human message is its `message`.
- Over `/api/v2/method/…`, Frappe returns `{"errors": [{"type": "<exc_type>", "message": …}]}`
  instead.

`sanad.ui.call` normalises all of this into `Error { message, exc_type, http_status }`.

## 6. Success envelope

Frappe wraps the function's return value: `{"message": <return value>}` on `/api/method/…`, and
`{"data": <return value>}` on `/api/v2/method/…`. The reference pages show the unwrapped return
value.

Datetimes come back as strings in the site's time zone (`"2026-09-28 14:03:11.123456"`), and
dates as `"2026-09-28"`.

## 7. Bulk variants (`names[]`)

Where the UI acts on a selection, a **`<verb>_many`** variant sits next to the single-record
endpoint, for example `messages.resend_many`, `campaigns.pause_many`, and `numbers.convert_many`.
All of them run through `api/v1/_bulk.run_bulk`:

- It takes `names: list[str]`. Empty names and duplicates are dropped, and input order is kept.
- It calls the single-record service once per name, each **inside its own savepoint**. A failure
  rolls back only that row.
- A **permission error aborts the whole call** (403), and the rows already done in that request
  roll back with it.
- It returns the uniform shape below:

```json
{
  "count": 2,
  "done": ["a1b2c3d4e5", "f6a7b8c9d0"],
  "failed": [{"name": "0e9d8c7b6a", "error": "WhatsApp Log 0e9d8c7b6a not found"}],
  "skipped": [{"name": "5f4e3d2c1b", "reason": "Queued"}]
}
```

`count` is `len(done)`. `failed[].error` is capped at 300 characters. A row is `skipped` when its
state doesn't apply, which is not a failure. The queue endpoints (`queue.pause_items` and the
others) predate this pattern. They take `names[]` **or** `filters` and return `{count}` only (see
[queue.md](queue.md)).

## 8. Paging

List endpoints take `page` (1-based, default 1) and `page_length` (default 20, capped at 200) and
return `{rows, total}`. Conversation-style reads use a keyset cursor instead
(`messages.get_conversation`: `before` / `next_cursor`).

## 9. Calling from Desk

`whatsapp_next/public/js/whatsapp_next_setup.js` builds the kit's API map. Each key `"<area>.<fn>"`
maps to `whatsapp_next.api.v1.<area>.<fn>`. The map is registered with `sanad.ui.configure({api})`
and exposed as `whatsapp_next.api`.

```js
// kit helper: resolves the key, returns a Promise of r.message
const dash = await sanad.ui.call("home.get_dashboard");

// options: {silent, freeze, freeze_message}
await sanad.ui.call("queue.pause_queue", { reason: "Maintenance" }, { freeze: true });

// errors reject with Error {message, exc_type, http_status}
try {
  await sanad.ui.call("devices.start_pairing", { device: "WA-DEV-001", mode: "Code" });
} catch (e) {
  if (e.exc_type === "WAStateConflictError") { /* already connected */ }
}

// plain Frappe works too
frappe.call({ method: "whatsapp_next.api.v1.home.get_dashboard" }).then((r) => r.message);
```

`sanad.ui.api(key)` throws for a two-segment key that isn't in the map. A **full dotted path**
(three or more segments) passes through unchanged. Endpoints that aren't in the map can still be
called through `sanad.ui.call` with their full path. In the part-A areas these are
`onboarding.verify_code`, `onboarding.get_password_reset_status`,
`onboarding.complete_password_reset`, and `onboarding.validate_coupon`, for example
`sanad.ui.call("whatsapp_next.api.v1.onboarding.verify_code", {...})`.

## 10. HTTP examples

```bash
# a read (GET allowed)
curl -s "https://<site>/api/method/whatsapp_next.api.v1.queue.get_summary" \
  -H "Authorization: token <api_key>:<api_secret>"

# a write, JSON body (lists and objects stay JSON)
curl -s -X POST "https://<site>/api/method/whatsapp_next.api.v1.queue.pause_items" \
  -H "Authorization: token <api_key>:<api_secret>" \
  -H "Content-Type: application/json" \
  -d '{"names": ["q1a2b3c4d5", "q6e7f8a9b0"], "reason": "hold"}'

# the same with form encoding: lists and objects are JSON strings
curl -s -X POST "https://<site>/api/method/whatsapp_next.api.v1.queue.pause_items" \
  -H "Authorization: token <api_key>:<api_secret>" \
  --data-urlencode 'names=["q1a2b3c4d5"]'
```

## 11. Realtime events

Several endpoints publish Socket.IO events (after commit) through the services they call. Listen
with `frappe.realtime.on("<event>", handler)`.

| Event | Payload | Published by |
|---|---|---|
| `wa:device:status` | `{device, status, previous, at, source}` | Device state changes: `devices.poll_status`, `disconnect_device`, `delete_device` (`status: "Deleted"`), `list_devices(refresh=1)`, the webhook, and the hourly sync. Sent to the site room and the device's doc room. |
| `wa:pairing:status` | `{device, mode, expires_at}` | `devices.start_pairing`, sent to the calling user only |
| `wa:message:status` | `{outbound, status, at, error_code, campaign, device}` | Outbound status changes: `messages.cancel`, `queue.delete_items`, the dispatcher, webhooks, and the test-send job. Sent to the site room and the WhatsApp Log doc room. |
| `wa:queue:progress` | the `queue_summary` dict (see [queue.md](queue.md)) | `queue.pause_queue`, `queue.resume_queue`, and dispatcher batches (throttled to 1/s per device) |
| `wa:campaign:status` | `{campaign, status, counters}` | Every campaign transition, including `bulk_send.send` |
| `wa:inbound:received` | `{inbound, device, key_hash}` | A real inbound message stored by the webhook |
| `wa:import:progress` | picker import progress | ContactPicker imports (see [picker.md](picker.md)) |

## 12. Index

| Area | Page | Module | What it covers |
|---|---|---|---|
| settings | [settings.md](settings.md) | `api/v1/settings.py` | Settings sections, connection test, subscription and usage, webhook endpoint, audit log, picker sources |
| onboarding | [onboarding.md](onboarding.md) | `api/v1/onboarding.py` | Wizard status, sign-up, sign-in, password reset, coupons, credentials |
| home | [home.md](home.md) | `api/v1/home.py` | Dashboard and period activity |
| devices | [devices.md](devices.md) | `api/v1/devices.py` | Device list, create, pairing, disconnect, delete, default, stats |
| quick_send | [quick-send.md](quick-send.md) | `api/v1/quick_send.py` | Composer context, preview, single send |
| messages | [messages.md](messages.md) | `api/v1/messages.py` | Outbound and inbound drawers, conversation, resend, cancel |
| bulk_send | [bulk-send.md](bulk-send.md) | `api/v1/bulk_send.py` | "Send a bulk message" window (becomes a campaign) |
| simulator | [simulator.md](simulator.md) | `api/v1/simulator.py` | Simulated inbound, test send, command dry run |
| queue | [queue.md](queue.md) | `api/v1/queue.py` | Queue list, summary, global pause and rate, item actions |
| phone | [phone.md](phone.md) | `api/v1/phone.py` | Calling-region metadata |
| numbers | [numbers.md](numbers.md) | `api/v1/numbers.py` | WhatsApp Numbers: link, convert, conversation log |
| contacts | [contacts.md](contacts.md) | `api/v1/contacts.py` | Contacts page through the contextual permission layer |
| picker | [picker.md](picker.md) | `api/v1/picker.py` | ContactPicker sources, import, preview, commit |
| groups | [groups.md](groups.md) | `api/v1/groups.py` | The contact group editor window: open, save with member changes |
| campaigns | [campaigns.md](campaigns.md) | `api/v1/campaigns.py` | Campaign lifecycle, progress, results |
| templates | [templates.md](templates.md) | `api/v1/templates.py` | Template preview and variables |
| notifications | [notifications.md](notifications.md) | `api/v1/notifications.py` | Document-event notifications and the notification editor |
| alerts | [alerts.md](alerts.md) | `api/v1/alerts.py` | Scheduled report alerts and the alert editor |
| functions | [functions.md](functions.md) | `api/v1/functions.py` | Function catalog, install, update |
| commands | [commands.md](commands.md) | `api/v1/commands.py` | Inbound commands, editor, test |
| webhooks | [webhooks.md](webhooks.md) | `webhooks/v1/receiver.py` | The inbound receiver (the only guest endpoint) |

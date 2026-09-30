# Add a new provider

`whatsapp_next` never talks to a WhatsApp backend directly. Every outbound call and every
webhook goes through one object: the **provider**, a subclass of
`whatsapp_next.providers.base.BaseProvider`. The app ships two:

| Registry key | Class | State |
|---|---|---|
| `snd_platform` | `whatsapp_next.providers.snd_platform.SndPlatformProvider` | Production provider for the SND WhatsApp Platform |
| `meta_cloud` | `whatsapp_next.providers.meta_cloud.MetaCloudProvider` | Skeleton that proves the abstraction. Capabilities the Cloud API lacks (pairing, sign-up, batch, queue, polls, webhook management) raise `NotSupportedError`. The remaining network methods (`get_account`, device CRUD, `send_message`) raise `NotImplementedError`. Only `verify_webhook`, `parse_webhook` and `list_available_webhook_events` are real |

This guide explains the contract, how the app uses what you return, and how to register and
test a provider from your own app. For the wider picture see [architecture.md](architecture.md);
for the webhook pipeline and hook points see [events-and-hooks.md](events-and-hooks.md).

---

## 1. Ground rules

These come from the module headers in `providers/` and the architecture rules:

- **Outbound I/O only.** A provider translates between the normalised dataclasses in
  `providers/schemas.py` and its backend's wire format. It never writes a DocType and never reads
  `frappe.db` (the header of `base.py` allows `frappe.cache` only). Status changes, retries and
  audit happen in `services/`.
- **Only typed exceptions leave the provider.** "No `requests` exception ever leaves
  providers/; every method wraps into one of these" (`providers/exceptions.py`). See
  [§5](#5-exceptions-and-how-the-app-reacts).
- **Nothing imports a concrete provider.** Services call `registry.get_provider()`; the class is
  found through the `whatsapp_providers` hook (`providers/__init__.py`).
- **Secrets are never logged.** `ProviderSettings.__repr__` hides `credentials`;
  `SignupState.credentials` and `WebhookEvent.raw` are `repr=False`. Keep that property in your
  own classes, log messages and exception `details` ("`details` never carries bodies or phones").
- **Sending is job-only (D-010).** The dispatcher calls `send_batch` from an RQ job; the
  single `send_message` is the test send (D-024). Do not add a synchronous send path.

---

## 2. Registration and resolution

### 2.1 The hook

`whatsapp_next/hooks.py`:

```python
whatsapp_providers = {
	"snd_platform": "whatsapp_next.providers.snd_platform.SndPlatformProvider",
	"meta_cloud": "whatsapp_next.providers.meta_cloud.MetaCloudProvider",
}
```

Another app registers its provider the same way in **its own** `hooks.py`:

```python
# my_app/hooks.py
whatsapp_providers = {
	"acme_gateway": "my_app.whatsapp.acme.AcmeProvider",
}
```

`frappe.get_hooks("whatsapp_providers")` merges dict hooks from every installed app into
`{key: [path, ...]}`. `registry.provider_classes()` takes the **last** path per key, so an app
installed after `whatsapp_next` may also replace a shipped provider by reusing its key (D-033).

### 2.2 What `WhatsApp Settings.provider` stores

`WhatsApp Settings.provider` stores the **registry key**, not a label (D-033). The Settings
controller (`WhatsAppSettings._validate_provider`) refuses a key that is not in the hook.

> **Caveat: the Select options are static.** D-033 says the Select options are the hook keys.
> In `whatsapp_settings.json`, though, `provider` is a `Select` with the fixed options
> `snd_platform\nmeta_cloud`, and nothing in the app rewrites them. Frappe's Select validation
> runs before the controller does, so it refuses a third key. An app that adds a provider must
> also extend those options. A Property Setter on `WhatsApp Settings`-`provider`-`options`
> shipped as a fixture of your app is the usual Frappe way to do it.
> `registry.list_providers()` already returns every hook key with its `display_name`, and is the
> source to use if the options are ever made dynamic.

### 2.3 How `get_provider()` builds your instance

`providers/registry.py`:

1. `get_provider(key=None)` returns the test override first, if one is set
   (`override_for_tests`, see [§9](#9-testing-your-provider)).
2. `build_settings(key)` builds a frozen `ProviderSettings`:
   - `provider_key`: `key`, else `WhatsApp Settings.provider`, else `"snd_platform"`;
   - `base_url`: `registry.platform_base_url()`, which is `WhatsApp Settings.platform_base_url`
     when set and otherwise `whatsapp_platform_base_url` from site or common site config (D-103).
     The Settings controller only accepts `https://` addresses and strips a trailing `/`;
   - `timeout`: `WhatsApp Settings.request_timeout` (5 to 120 s, default 30);
   - `credentials`: the plaintext values of the Password fields listed in
     `registry.CREDENTIAL_FIELDS`: `customer_api_key`, `customer_api_secret`, `api_key`,
     `api_secret`, `webhook_secret`. Values come from `get_password`, and empty ones are left out.
3. The class is resolved with `frappe.get_attr(path)` and instantiated as `cls(settings)`. It is
   cached in `frappe.local.wa_provider_cache` for the rest of the request or job.
   `registry.clear_cache()` drops that cache.
4. An unknown key raises `NotSupportedError(code="PROVIDER_UNKNOWN")`.

Consequences for your constructor:

- It receives exactly one argument, `ProviderSettings`. Call `super().__init__(settings)`.
- It must be cheap and must not do I/O, because it runs once per request or job.
- Your credentials have to fit the five fields above. There is no per-provider credential store,
  and the onboarding service (`services/onboarding.save_credentials`) writes only
  `platform_base_url`, `customer_api_key`, `customer_api_secret`, `api_key` and `api_secret`.
  `webhook_secret` is written only by `services/webhook_setup.fetch_secret`, which stores
  whatever your `get_webhook_secret()` returns. The Meta skeleton in [§8](#8-worked-example-a-meta-cloud-api-provider-skeleton)
  shows one way to map a backend's secrets onto these fields.

---

## 3. The `BaseProvider` contract

```python
class BaseProvider(ABC):
	key: str = ""                              # registry key, e.g. "snd_platform"
	display_name: str = ""                     # shown by registry.list_providers()
	capabilities: frozenset[str] = frozenset()

	def __init__(self, settings: ProviderSettings) -> None: ...
	def supports(self, capability: str) -> bool: ...   # capability in self.capabilities
```

Module constants in `providers/base.py`:

| Constant | Value | Meaning |
|---|---|---|
| `MAX_BATCH` | 200 | Largest `send_batch`. Above it, raise `ValidationError` **before any I/O** |
| `MAX_STATUS_REFS` | 200 | Largest `get_message_status` / `cancel_queued` ref list |
| `MAX_POLL_IDS` | 100 | Largest `get_poll_results` id list |
| `DEFAULT_MAX_SKEW` | 300 | Default webhook timestamp tolerance, in seconds |

### 3.1 Capability flags

`capabilities` is a class-level `frozenset[str]`. The shipped values are:

| Provider | Flags |
|---|---|
| `snd_platform` | `batch_send`, `pair_code`, `qr`, `signup`, `usage`, `queue_cancel`, `polls`, `webhooks` |
| `meta_cloud` | `template`, `interactive`, `webhooks` |
| `tests/fake_provider.FakeProvider` | same as `snd_platform` |

Today the flags are **declarative only**: nothing under `services/`, `api/` or `webhooks/` calls
`supports()`. The app decides what a provider can do from the exceptions it raises. A method
your backend cannot serve raises `NotSupportedError`, and the caller turns that into
`WANotSupportedError` (HTTP 422), a `None` usage report, or similar. Declare the flags anyway,
using the same vocabulary, so a future UI gate works without changes.

### 3.2 Abstract methods

Every method below is `@abstractmethod`. `tests/test_providers_base.py` fails for any provider
that leaves one unimplemented. The "Used by" column shows the service that calls the method
today. Methods marked "(contract only)" have no caller yet, but they still have to exist.

#### Account and tenant linkage

| Method | Returns | Contract | Used by |
|---|---|---|---|
| `health_check()` | `HealthStatus` | **Never raises.** Put errors in `HealthStatus.error` with `ok=False` (the contract test calls it on every provider) | `services/onboarding` (connection test) |
| `get_account()` | `AccountInfo` | Plan, usage, limits, features, wallet | `services/usage_sync` |
| `get_usage(from_: date, to: date, group_by: str = "day")` | `UsageReport` | `group_by` is `day`, `week` or `month` (the API enum). Raise `NotSupportedError` when unavailable; `usage_sync` then returns `None` | `services/usage_sync` |
| `get_signup_bootstrap()` | `dict` | What the sign-up form needs before anything is typed (plans, code TTL) | onboarding |
| `start_signup(plan_code, mobile_e164, full_name, email, channel, coupon_code=None)` | `SignupState` | Starts a tenant sign-up and returns a request key. A coupon is validated here | onboarding |
| `get_signup_status(request_key)` | `SignupState` | Polls a sign-up | onboarding |
| `verify_signup_code(request_key, code, purpose=None)` | `SignupState` | Checks the code of a sign-up or password-reset request | onboarding |
| `complete_signup(request_key, code, password=None)` | `SignupState` | Finishes the sign-up. `credentials` may come back **once** and is never logged | onboarding |
| `start_password_reset(identifier)` | `SignupState` | | onboarding |
| `get_password_reset_status(request_key)` | `SignupState` | | onboarding |
| `complete_password_reset(request_key, password)` | `SignupState` | | onboarding |
| `login(email, password)` | `dict` | Returns the tenant's credentials once. Never logged | onboarding (D-118) |
| `validate_coupon(code, email=None, mobile_e164=None)` | `dict` | Is the coupon usable and what does it give? **Never redeems** | onboarding |
| `get_referral_coupon()` | `dict` | This tenant's own referral coupon. `NotSupportedError` when the backend has none | onboarding |

A backend with no self-service sign-up, such as Meta, raises `NotSupportedError` from all of the
sign-up and coupon methods. The skeleton does exactly this.

#### Device lifecycle

A "device" is one WhatsApp sender. `platform_device` is **the backend's id for it**. The app
stores it in `WhatsApp Device.platform_device` and resolves webhooks with
`services.devices.by_platform_device()`, which never creates a device.

| Method | Returns | Contract | Used by |
|---|---|---|---|
| `create_device(device_name, phone_e164, pairing_mode)` | `DeviceState` | `pairing_mode` is `QR` or `Code`. `phone_e164` is required for `Code` (`ValidationError` otherwise) | `services/devices` |
| `list_devices()` | `list[DeviceState]` | Every device of this tenant | `services/devices` |
| `get_device(platform_device)` | `DeviceState` | `NotFoundError` when unknown | (contract only) |
| `update_device(platform_device, device_name, phone_e164)` | `DeviceState` | Rename or re-number. `None` means unchanged. `NotSupportedError` is surfaced as "Renaming devices is not supported by this provider yet" | `services/devices` |
| `get_qr(platform_device)` | `PairingPayload` | `DeviceOfflineError` when the device has no token. `NotSupportedError` → "QR pairing is not supported by this provider" | `services/devices` |
| `get_pair_code(platform_device)` | `PairingPayload` | `ValidationError` when the device has no phone | `services/devices` |
| `verify_device(platform_device)` | `DeviceState` | Asks the backend for the live connection state | `services/devices` |
| `reconnect_device(platform_device)` | `DeviceState` | `NotSupportedError` when absent | (contract only) |
| `disconnect_device(platform_device)` | `DeviceState` | Logs the device out | `services/devices` |
| `delete_device(platform_device, delete_remote: bool)` | `None` | | `services/devices` |

#### Sending

| Method | Returns | Contract | Used by |
|---|---|---|---|
| `send_message(message: NormalizedMessage)` | `SendResult` | One synchronous send. **Test send only** (D-024) | `dispatch.send_test_message` |
| `send_batch(messages: list[NormalizedMessage], batch_id: str)` | `BatchResult` | The production send path. At most `MAX_BATCH` messages; raise `ValidationError` above that **before any I/O**. Report every message as either accepted or errored, keyed by `client_ref` | `dispatch.dispatch_device_batch` |
| `get_message_status(client_refs: list[str])` | `tuple[list[MessageStatus], list[str]]` | `(statuses, unknown_refs)` for at most `MAX_STATUS_REFS` refs | `services/reconcile` (every 5 min) |
| `get_queue_status()` | `QueueStatus` | Counts per status on the backend queue | `dispatch.platform_queue_status` |
| `cancel_queued(client_refs: list[str] \| None, batch_id: str \| None)` | `int` | Number cancelled. `NotSupportedError` when absent | (contract only) |
| `get_poll_results(platform_device, poll_ids: list[str])` | `dict[str, dict]` | Keyed by poll id. At most `MAX_POLL_IDS` | `services/polls` |

#### Contacts and groups

| Method | Returns | Used by |
|---|---|---|
| `list_device_contacts(platform_device)` | `list[ProviderContact]` | (contract only) |
| `list_device_groups(platform_device)` | `list[ProviderGroup]` | (contract only) |

#### Webhooks

| Method | Returns | Contract | Used by |
|---|---|---|---|
| `verify_webhook(headers, raw_body: bytes, secret: str, max_skew: int = DEFAULT_MAX_SKEW)` | `SignatureCheck` | Constant-time signature check plus timestamp freshness. **Pure: no DB** | `webhooks/verify.check` |
| `parse_webhook(headers, body: dict)` | `WebhookEvent` | Wire payload → `WebhookEvent`. **Pure.** An unknown event keeps its name, so `is_known` is `False` | receiver and `webhooks/handlers.process_event` |
| `get_webhook_secret()` | `str` | Fetches the signing secret. The caller stores it with `set_encrypted_password`; never log it | `webhook_setup.fetch_secret` |
| `configure_webhook(endpoint_url, events: list[str], max_retries: int)` | `WebhookEndpointState` | Registers the receiver URL and its event subscriptions | `services/webhook_setup` |
| `list_webhook_endpoints()` | `list[WebhookEndpointState]` | | `services/webhook_setup` |
| `update_webhook_endpoint(endpoint_id, status, events, url)` | `WebhookEndpointState` | Changes status (`Active`/`Disabled`; setting `Active` unlocks), events or URL. `None` means unchanged | `services/webhook_setup` |
| `test_webhook_endpoint(endpoint_id)` | `dict` | Asks the backend to POST a `test.webhook` event | `services/webhook_setup` |
| `delete_webhook_endpoint(endpoint_id)` | `None` | | (contract only) |
| `list_available_webhook_events()` | `list[dict]` | `[{event_name, enabled, disabled_reason}]` for the tenant's plan | `services/webhook_setup` |

### 3.3 Overridable (non-abstract) methods

| Method | Default | Override when |
|---|---|---|
| `supports(capability)` | `capability in self.capabilities` | Rarely |
| `webhook_envelope(headers) -> WebhookEnvelope` | `WebhookEnvelope(event_id=None, event_name=None, signed=False)` | **Always, if your backend delivers webhooks.** With the default, the receiver answers `401 missing headers` at step 1 for every delivery |
| `replay_headers(event_name, event_id) -> dict[str, str]` | `{}` | When `parse_webhook` reads the event name or id from headers. The stored `WhatsApp Webhook Event` keeps the body, `event_name` and `event_id` but not the wire headers, so the processing job re-parses with `parse_webhook(replay_headers(...), body)` |

---

## 4. The normalised dataclasses (`providers/schemas.py`)

All of them are `@dataclass(frozen=True)`. Vocabularies:

```python
RECIPIENT_TYPES = ("Individual", "Group")
MESSAGE_TYPES = ("Text", "Document", "Image", "Video", "Audio", "Sticker",
                 "Location", "Poll", "Template", "Interactive")
DEVICE_STATUSES = ("Pending QR", "Connected", "Disconnected", "Logged Out")
WEBHOOK_ENDPOINT_STATUSES = ("Active", "Disabled", "Locked", "Revoked")
CANONICAL_EVENTS = ("message.received", "message.sent", "message.delivered", "message.read",
                    "message.failed", "message.held", "message.reaction",
                    "connection.connected", "connection.disconnected", "connection.logged_out",
                    "group.updated", "group.participants.updated", "test.webhook")
```

### Inputs you receive

**`ProviderSettings`**

| Field | Type | Notes |
|---|---|---|
| `provider_key` | `str` | Registry key |
| `base_url` | `str` | `registry.platform_base_url()` ([§2.3](#23-how-get_provider-builds-your-instance)) |
| `timeout` | `int = 30` | Seconds, for every HTTP call |
| `credentials` | `dict[str, str]` | Plaintext `CREDENTIAL_FIELDS` values; `repr=False` |

**`NormalizedMessage`**, built by `dispatch.build_message` from one `WhatsApp Log` row:

| Field | Type | Notes |
|---|---|---|
| `client_ref` | `str` | The `WhatsApp Log` name. **Your idempotency key** ([§6](#6-idempotency-client_ref)) |
| `platform_device` | `str` | Backend device id (`WhatsApp Device.platform_device`) |
| `recipient_type` | `str = "Individual"` | `Individual` or `Group` |
| `phone_e164` | `str \| None` | `+9665…` for individuals |
| `jid` | `str \| None` | Group JID for `Group` |
| `message_type` | `str = "Text"` | One of `MESSAGE_TYPES` |
| `body` | `str \| None` | Rendered text |
| `caption` | `str \| None` | Media caption |
| `attachment` | `AttachmentRef \| None` | Set for Document / Image / Video / Audio / Sticker |
| `view_once` | `bool = False` | |
| `location` | `Location \| None` | For `Location` |
| `poll` | `Poll \| None` | For `Poll` |
| `template` | `TemplateRef \| None` | Meta-style template reference. `build_message` does not fill it today |
| `interactive` | `dict \| None` | Reserved. `build_message` does not fill it today |
| `source` | `Source` | Who created the message |
| `priority` | `int = 5` | Quick Send / Command Reply / Form / Simulator 1, API / Notification / Alert 3, Campaign 5 (D-046). The test send uses 1 |

`AttachmentRef(file_name, mime_type, content_b64=None, url=None)`: either inline base64 or a URL
the backend can fetch. `dispatch` inlines attachments (`services.attachments.attachment_ref`).

`Location(latitude: float, longitude: float, name=None, address=None)`.

`Poll(question: str, options: tuple[str, ...], allow_multiple: bool = False)`.

`TemplateRef(name: str, language: str = "ar", components: tuple[dict, ...] = ())`.

`Source(type="External API", doctype=None, docname=None, site=None)`. `type` holds the app's
source vocabulary (`Quick Send`, `Form`, `Campaign`, `Notification`, `Notification Alert`,
`Command Reply`, `Simulator`, `API`). `SndPlatformProvider.PLATFORM_SOURCE_TYPES` shows how one
backend maps that vocabulary to its own.

### Outputs you return

**`SendResult`** (from `send_message`)

| Field | Type | Used for |
|---|---|---|
| `ok` | `bool` | `True` → outbound `Sent`. `False` → `Failed`, classified from `reason` + `code` |
| `provider_message_id` | `str \| None` | Stored on `WhatsApp Log`. Webhooks without `client_ref` are matched on it |
| `platform_message_log` | `str \| None` | Backend's log id, stored for support |
| `device_fallback` | `bool = False` | The backend sent from another device. Sets `WhatsApp Log.device_fallback` |
| `requested_device` | `str \| None` | |
| `rejected` | `bool = False` | Business rejection (quota, plan, recipient) |
| `reason` | `str \| None` | Human text; classified by `services/errors.classify` |
| `code` | `str \| None` | Machine code; see [§5.1](#51-per-message-errors-batcherror) |
| `device` | `str \| None` | Device actually used |

**`BatchResult`** (from `send_batch`)

| Field | Type | Notes |
|---|---|---|
| `batch_id` | `str` | Echo the `batch_id` you were given, or the backend's own |
| `accepted` | `tuple[BatchAccepted, ...]` | One per message the backend took |
| `errors` | `tuple[BatchError, ...]` | One per message it refused |

`BatchAccepted(client_ref: str, queue_id: str, status: str = "Queued")`. `queue_id` is stored in
`WhatsApp Log.platform_queue_id` and `WhatsApp Queue Item.platform_queue_id`. With
`status="Held"` the outbound goes to `Held`; any other value leaves it `Sending` until a status
webhook or the reconcile job moves it.

`BatchError(client_ref: str | None, error: str, code: str | None = None, queue_id: str | None = None)`.

A message you mention in neither tuple is treated as transient and retried ("no result from
provider for this message", code `timeout`).

**`MessageStatus`** (from `get_message_status`)

| Field | Type | Notes |
|---|---|---|
| `client_ref` | `str` | |
| `queue_id` | `str \| None` | |
| `status` | `str` | Backend queue status. `reconcile` understands `Sent`, `Failed`, `Held`, `Cancelled`. Anything else (for example `Queued`, `Sending`) means "still in flight" |
| `reason` | `str \| None` | Classified for `Failed` |
| `platform_message_log` | `str \| None` | |
| `attempt_count` | `int = 0` | |
| `provider_message_id` | `str \| None` | |
| `device` | `str \| None` | |
| `sent_at` / `delivered_at` / `read_at` | `datetime \| None` | |
| `message_status` | `str \| None` | Delivery status. When it is `Sent`, `Delivered` or `Read`, it wins over `status` |

Refs you return in `unknown_refs` are re-queued once and then marked `Failed`
(`reconcile.reconcile_handed_over`).

**`DeviceState`**

| Field | Type | Notes |
|---|---|---|
| `platform_device` | `str` | Required |
| `device_name` | `str \| None` | |
| `phone_e164` | `str \| None` | With `+` |
| `status` | `str = "Pending QR"` | Must be one of `DEVICE_STATUSES`. Map your backend's words (see `snd_platform.STATUS_MAP`) |
| `wa_device_id` | `str \| None` | |
| `last_seen` | `datetime \| None` | |
| `webhook_registered` | `bool = False` | |
| `webhook_url` | `str \| None` | |
| `raw_status` | `str \| None` | The backend's own word, kept for diagnosis |
| `pairing_mode` | `str \| None` | `QR` or `Code` |
| `last_status_change_at` | `datetime \| None` | |
| `last_status_reason` | `str \| None` | |

**`PairingPayload`** is served from a 60 s cache and never persisted (D-014).

| Field | Type |
|---|---|
| `mode` | `str` (`QR` or `Code`) |
| `qr_code` | `str \| None` |
| `pair_code` | `str \| None` |
| `generated_at` / `expires_at` | `datetime \| None` |
| `expires_in` | `int = 60` |
| `phone_e164` | `str \| None` |

**`AccountInfo`**: `plan_code`, `plan_name`, `status` (all `str | None`), `message_limit`,
`messages_used`, `messages_remaining`, `messages_per_minute`, `device_limit`, `devices_used`
(all `int = 0`), `start_date` and `end_date` (`date | None`), `features: dict[str, bool]`,
`wallet_balance: float | None`, `wallet_currency: str | None`,
`webhook_events: dict[str, bool]`.

**`UsageReport`**: `from_: date`, `to: date`, `group_by: str`, `rows: tuple[UsageRow, ...]`, where
`UsageRow(key: str, sent=0, failed=0, units=0, rejected=0)`.

**`QueueStatus`**: `counts: dict[str, int]`, `messages_per_minute: int = 0`,
`messages_remaining: int = 0`, `held_reason: str | None`.

**`ProviderContact`**: `jid: str`, `phone_e164: str | None`, `name: str | None`.
**`ProviderGroup`**: `jid: str`, `name: str | None`, `participants_count: int = 0`.

**`WebhookEndpointState`**: `endpoint_id: str`, `url: str`, `status: str = "Active"` (one of
`WEBHOOK_ENDPOINT_STATUSES`), `events: tuple[str, ...]`, `max_retries: int = 3`,
`consecutive_failures: int = 0`, `locked_at: datetime | None`, `lock_reason: str | None`,
`last_http_status: int | None`, `lock_after_failures: int | None`, `unlocked_at: datetime | None`.

**`HealthStatus`**: `ok: bool`, `latency_ms: int | None`, `error: str | None`,
`checked_at: datetime | None`, `plan_code: str | None`.

**`SignupState`**: `request_key: str | None`, `status: str`,
`credentials: dict[str, str] | None` (`repr=False`, returned once),
`message: str | None`, `extra: dict[str, Any]` (the backend's public answer, credentials removed).

### Webhook types

**`SignatureCheck`**: `valid: bool`, `fresh: bool`, `event_timestamp: datetime | None`,
`reason: str | None`. The receiver accepts only `valid and fresh`. A backend that sends no
timestamp returns `fresh=True`, as the Meta skeleton does.

**`WebhookEnvelope`**: `event_id: str | None`, `event_name: str | None`, `signed: bool`. It is
read from headers **before** the body is trusted. `event_id` must be non-empty and `signed` true,
otherwise the delivery gets `401`.

**`WebhookEvent`**

| Field | Type | Read by |
|---|---|---|
| `event_id` | `str` | Dedupe key together with `event_name` (composite unique, D-047) |
| `event_name` | `str` | Routing. Use `CANONICAL_EVENTS`; `is_known` is `event_name in CANONICAL_EVENTS` |
| `timestamp` | `datetime \| None` | Status timestamps (`sent_at` …) |
| `platform_device` | `str \| None` | Device resolution. A value no local device matches → stored as `Ignored` ("unknown device") |
| `client_ref` | `str \| None` | First choice for finding the outbound row (`WhatsApp Log` name) |
| `provider_message_id` | `str \| None` | Second choice for finding the outbound row. Stored on status updates |
| `queue_id` | `str \| None` | |
| `platform_message_log` | `str \| None` | Stored on status updates |
| `status` | `str \| None` | For `message.failed`, an **upper-case** value is used as the provider code in classification |
| `reason` | `str \| None` | Failure / hold reason |
| `device` | `DeviceState \| None` | Required for `connection.*` (`devices.apply_connection_event`) |
| `inbound` | `InboundPayload \| None` | Required for `message.received` / `message.reaction` |
| `raw` | `dict` | The full body. Stored on `WhatsApp Webhook Event.payload`, never logged. Group events read `group_id` / `jid` / `chat_jid` and `subject` / `group_name` / `name` from it |

**`InboundPayload`**: `provider_message_id: str | None`, `sender_phone`, `sender_jid`,
`chat_jid`, `from_jid` (all `str | None`), `is_group: bool = False`, `push_name`,
`message_type: str = "Text"`, `body`, `caption`, `media_url`, `media_mime_type`,
`location: Location | None`, `reaction`, `reaction_to`, `quoted_id`,
`received_at: datetime | None`.

Event-name routing in `webhooks/handlers.handle_event`:

| `event_name` | Effect |
|---|---|
| `message.sent` / `delivered` / `read` / `failed` / `held` | `dispatch.apply_status` on the outbound found by `client_ref`, else `provider_message_id`. Forward-only: a later webhook never moves a row backwards, and `Failed` is final (D-029 OQ-4) |
| `message.received` | `inbound.record_inbound` (needs a resolved device) |
| `message.reaction` | `inbound.record_reaction` |
| `connection.*` | `devices.apply_connection_event` |
| `group.updated`, `group.participants.updated` | Group name refresh in the Numbers table |
| anything else | `Ignored` |

---

## 5. Exceptions and how the app reacts

`providers/exceptions.py`. Every class accepts `message`, and keyword-only `code`, `http_status`
and `details`:

| Exception | Parent | `retryable` | Raise for | Extra attributes |
|---|---|---|---|---|
| `ProviderError` | `Exception` | `False` | Base; unexpected backend answers | `code`, `http_status`, `details` |
| `AuthError` | `ProviderError` | `False` | 401/403 on auth, invalid key, `AUTH_*` codes, missing configuration | |
| `PermissionDeniedError` | `ProviderError` | `False` | 403 ownership (device or endpoint is not ours) | |
| `NotFoundError` | `ProviderError` | `False` | 404 | |
| `ValidationError` | `ProviderError` | `False` | 400 / 413 / 417 validation; batch too large or empty | |
| `BusinessRejectedError` | `ProviderError` | `False` | HTTP 200 with `ok:false` / `rejected:true`: quota, feature, recipient | `reason`, `platform_message_log` |
| `QuotaExceededError` | `BusinessRejectedError` | `False` | `QUOTA_EXCEEDED`, 402 | same |
| `FeatureNotInPlanError` | `BusinessRejectedError` | `False` | `FEATURE_NOT_IN_PLAN` | same |
| `DeviceOfflineError` | `ProviderError` | `True` | 409 device not connected / no token | `device_status` |
| `RateLimitError` | `ProviderError` | `True` | 429 / `RATE_LIMITED` | `retry_after` (seconds) |
| `TransientError` | `ProviderError` | `True` | Timeouts, connection errors, 5xx | |
| `NotSupportedError` | `ProviderError` | `False` | Capability absent on this backend or endpoint not live yet | |
| `WebhookSignatureError` | `ProviderError` | `False` | Bad HMAC or stale timestamp (the receiver itself uses `SignatureCheck`) | |

The class attribute `retryable` is informational. The decision the dispatcher acts on is made by
`services/errors.classify`, which maps an exception, a provider code or a free-text reason to the
canonical `WhatsApp Log.error_code` vocabulary:

```
recipient_not_registered, device_disconnected, timeout, platform_rejected, invalid_template,
insufficient_balance, invalid_phone, blacklisted, unknown_number_policy, rate_limited, auth, unknown
```

Only `device_disconnected`, `timeout` and `rate_limited` are retryable (`errors.RETRYABLE`).

| Exception | `classify` code | Retryable in the dispatcher |
|---|---|---|
| `WebhookSignatureError`, `AuthError`, `PermissionDeniedError` | `auth` | no |
| `DeviceOfflineError` | `device_disconnected` | yes |
| `RateLimitError` | `rate_limited` | yes |
| `TransientError`, Python `TimeoutError` | `timeout` | yes |
| `QuotaExceededError` | `insufficient_balance` | no |
| `FeatureNotInPlanError` | `platform_rejected` | no |
| `BusinessRejectedError` | the code from the platform code map, else a text match on message + `reason`, else `platform_rejected` | depends on the code |
| `NotSupportedError`, `NotFoundError` | `platform_rejected` | no |
| `ValidationError` | text match, else `platform_rejected` | no, unless the text matches a retryable pattern |
| bare `ProviderError` | the code from the platform code map, else text match, else `unknown` | depends |

The platform code map (`errors._PLATFORM_CODE_MAP`) knows the SND codes: `QUOTA_EXCEEDED`,
`SUBSCRIPTION_INACTIVE`, `SUBSCRIPTION_EXPIRED`, `DEVICE_NOT_CONNECTED`, `DEVICE_NO_TOKEN`,
`DEVICE_NOT_FOUND`, `DEVICE_NOT_OWNED`, `RECIPIENT_REQUIRED`, `INVALID_MESSAGE_TYPE`,
`FEATURE_NOT_IN_PLAN`, `CLIENT_REF_DUPLICATE`, `RATE_LIMITED`, `AUTH_*`, `LINK_*`,
`CUSTOMER_SUSPENDED`, `PROVIDER_ERROR`, `INTERNAL_ERROR`. After that, `errors._TEXT_PATTERNS`
match English phrases such as "not on whatsapp", "not connected", "timed out", "quota",
"template", "invalid phone", "rate limit" and "unauthorized". **A new backend's own codes are not
in the map.** Either raise the right exception class, or put a known code or recognisable English
text in `BatchError.code` / `BatchError.error`. Otherwise the error classifies as `unknown`, which
is not retryable and goes straight to dead letter.

### 5.1 Per-message errors (`BatchError`)

`dispatch.apply_batch_result`, for each `BatchError`:
`errors.classify(err.error, provider_code=err.code)`.

- retryable → `_retry_later`: attempts +1, `next_attempt_at = now + retry_backoff_seconds · 2^(attempts−1) ± 10 %`.
  When attempts reach `max_attempts`, the row is dead-lettered instead;
- not retryable → dead letter at once: Queue Item `Dead Letter`, outbound `Failed` with `error_code`.

### 5.2 Whole-call failure (`send_batch` raised)

`dispatch.apply_call_failure`: **every** claimed row goes back to `Queued` with backoff and
**attempts unchanged**. A whole-call failure never dead-letters, whatever the exception.
Additionally:

- `RateLimitError` with `retry_after` → that delay is used instead of the backoff;
- `DeviceOfflineError` → the device is set `Disconnected` (`devices.apply_state`);
- `AuthError` → `WhatsApp Settings.connection_status = "Failed"` and `last_connection_error` are
  set, plus an Error Log "WhatsApp dispatch: provider auth failed".

So a `send_batch` that always raises, for example `NotSupportedError`, re-queues the same rows
forever. Implement `send_batch` even if your backend only has single sends; see the loop in
[§8](#8-worked-example-a-meta-cloud-api-provider-skeleton).

Only `ProviderError` subclasses are caught. Anything else (a raw `requests` exception, a
`KeyError` while parsing, the skeleton's `NotImplementedError`) escapes the job. The claimed rows
then stay `Sending` until `reconcile.requeue_stale_claims` puts them back after 10 minutes.

### 5.3 Test send (`send_message`)

`dispatch.send_test_message`: a `ProviderError` → outbound `Failed` with the classified code, no
retry. `DeviceOfflineError` also flips the device. `SendResult(ok=False)` → `Failed`, classified
from `reason` + `code`.

### 5.4 API calls

Every `api/` endpoint runs inside `api_endpoint` (D-039), which converts a `ProviderError` with
`api/_common.map_provider_error`:

| Provider exception | App exception | HTTP |
|---|---|---|
| `RateLimitError` | `WARateLimitError` | 429 |
| `AuthError`, `PermissionDeniedError`, `WebhookSignatureError` | `WAProviderAuthError` | 424 |
| `TransientError`, `DeviceOfflineError` | `WAProviderUnavailableError` | 503 |
| `NotSupportedError` | `WANotSupportedError` | 422 (D-097) |
| `BusinessRejectedError` (and subclasses) | `WAProviderRejectedError` (carries `reason`, `provider_code`) | 422 |
| `ValidationError`, `NotFoundError` | `WAValidationError` | 417 |
| any other `ProviderError` | `WAProviderUnavailableError` | 503 |

Non-`ProviderError` exceptions are not mapped and surface as HTTP 500. See
[api/README.md](api/README.md) for the error envelope.

---

## 6. Idempotency (`client_ref`)

- `NormalizedMessage.client_ref` is the `WhatsApp Log` name. The **same** `client_ref` is sent
  again on every retry of a message: after backoff, after a whole-call failure, and after a
  reconcile re-queue.
- Pass it to your backend as the idempotency key, and echo it in `BatchAccepted.client_ref`,
  `BatchError.client_ref`, `MessageStatus.client_ref` and, when the backend can carry it,
  `WebhookEvent.client_ref`. The dispatcher matches results **only** by `client_ref`. Webhooks
  fall back to `provider_message_id`.
- The SND platform enforces uniqueness per link (`strict_client_ref`, D-029 OQ-2) and answers a
  repeat with `CLIENT_REF_DUPLICATE`, which classifies as `platform_rejected` (dead letter).
  **Recommendation:** when your backend already accepted a `client_ref`, report it again as
  `BatchAccepted` with the original id rather than as an error. A retry after a timeout whose
  first attempt actually got through then stays `Sending` and is later set `Sent` by the status
  webhook. The app does not require this; it is the safer choice.
- `batch_id` has the form `<device>-<12 hex>`. The SND provider truncates it to 64 characters.

---

## 7. Webhooks end to end

The only guest endpoint of the app is
`POST /api/method/whatsapp_next.webhooks.v1.receiver.receive` (D-031). `receiver.handle()` calls
your provider in this order:

1. `webhook_envelope(headers)`. No `event_id`, or `signed` false → `401 missing headers`.
2. Rate limit per source IP: 600 per minute (D-029 OQ-P6) → `429`.
3. The secret is `WhatsApp Settings.webhook_secret`. If it is missing → `503` (logged once per 10 minutes).
4. `verify_webhook(headers, raw_body, secret, 300)`. Not valid or not fresh → the delivery is
   stored as `Ignored` with a blank payload → `401`. Five invalid signatures in 10 minutes
   enqueue one `webhook_setup.fetch_secret`, which calls your `get_webhook_secret()`.
5. JSON body must be an object (`400` otherwise) → `parse_webhook(headers, body)`.
6. `platform_device` → local device (`devices.by_platform_device`). Unknown → `Ignored`.
7. Claim on `(event_name, event_id)`; a duplicate → `200 {"duplicate": true}` (D-047).
8. `200`, then `webhooks.handlers.process_event` runs in a `short` job. It re-parses the stored
   body with `parse_webhook(replay_headers(event_name, event_id), body)`, so parsing must be
   **deterministic and header-independent** once `replay_headers` supplies the name and id.
   Failed events are retried three times (`reprocess_failed`, cron every 10 minutes).

Rules for your two pure methods:

- `verify_webhook` compares with `hmac.compare_digest`, touches no DB, and returns rather than
  raises.
- `parse_webhook` never raises on an unknown shape. It returns a `WebhookEvent` with the
  backend's event name (so `is_known` is `False`) and `raw=body`. It must return a stable
  `event_id` for the same delivery.
- One delivery maps to **one** `WebhookEvent`. If your backend batches several messages or
  statuses in one POST, only what you return is processed (the Meta skeleton takes the first
  message or status).

---

## 8. Worked example: a Meta Cloud API provider skeleton

> **Illustrative skeleton, not shipped code.** The shipped `providers/meta_cloud.py` implements
> only `verify_webhook` and `parse_webhook`. The code below shows how a fuller provider would
> satisfy the same contract. Graph API paths, payload keys and error codes are given as commonly
> documented by Meta; check them against Meta's current documentation before relying on them.
> Everything that touches `whatsapp_next` (signatures, dataclasses, exceptions, hook) is real.

Design choices in this sketch:

- **Device = phone number.** `platform_device` is the Cloud API `phone_number_id`. That is also
  what the shipped `parse_webhook` puts in `WebhookEvent.platform_device`
  (`entry[].changes[].value.metadata.phone_number_id`).
- **Credentials mapped onto the existing fields** ([§2.3](#23-how-get_provider-builds-your-instance)):
  `api_secret` = system-user access token, `api_key` = WhatsApp Business Account id,
  `customer_api_secret` = the Meta app secret. `get_webhook_secret()` returns it, so the app's own
  `webhook_setup.fetch_secret` copies it into `webhook_secret`, where the receiver reads it.
- **`send_batch` loops over single sends**, because the Cloud API has no batch enqueue and the
  dispatcher only ever calls `send_batch` ([§5.2](#52-whole-call-failure-send_batch-raised)).
- **`client_ref` travels as `biz_opaque_callback_data`.** Meta echoes it on status webhooks, and
  the shipped `parse_webhook` already reads it into `WebhookEvent.client_ref`.

```python
# my_app/whatsapp/meta_cloud_full.py — ILLUSTRATIVE SKELETON, NOT SHIPPED CODE
from __future__ import annotations

import hashlib
import hmac
from collections.abc import Mapping
from datetime import date, datetime

import requests

from whatsapp_next.providers import exceptions as pex
from whatsapp_next.providers.base import DEFAULT_MAX_SKEW, MAX_BATCH
from whatsapp_next.providers.meta_cloud import MetaCloudProvider  # reuse parse_webhook
from whatsapp_next.providers.schemas import (
	BatchAccepted,
	BatchError,
	BatchResult,
	DeviceState,
	HealthStatus,
	NormalizedMessage,
	SendResult,
	SignatureCheck,
	WebhookEnvelope,
)

GRAPH = "https://graph.facebook.com/v21.0"  # assumption: pin the version you test against
MEDIA_TYPES = {"Image": "image", "Video": "video", "Audio": "audio", "Document": "document", "Sticker": "sticker"}


class MetaCloudFullProvider(MetaCloudProvider):
	key = "meta_cloud_full"
	display_name = "Meta Cloud API (full)"
	capabilities = frozenset({"template", "interactive", "webhooks"})

	def __init__(self, settings) -> None:
		super().__init__(settings)
		self._session = requests.Session()

	# ---------------------------------------------------------------- transport
	def _token(self) -> str:
		token = self.settings.credentials.get("api_secret")
		if not token:
			raise pex.AuthError("Access token is not configured", code="AUTH_KEY_MISSING")
		return token

	def _graph(self, method: str, path: str, *, json: dict | None = None, params: dict | None = None) -> dict:
		base = self.settings.base_url or GRAPH
		try:
			r = self._session.request(
				method,
				f"{base}/{path.lstrip('/')}",
				json=json,
				params=params,
				headers={"Authorization": f"Bearer {self._token()}"},
				timeout=self.settings.timeout,
				allow_redirects=False,
			)
		except requests.Timeout as exc:
			raise pex.TransientError("Graph API timed out", code="TIMEOUT") from exc
		except requests.RequestException as exc:  # never let requests escape (exceptions.py)
			raise pex.TransientError(f"Graph API error: {exc.__class__.__name__}", code="CONNECTION") from exc
		try:
			data = r.json() if r.content else {}
		except ValueError:
			data = {}
		if 200 <= r.status_code < 300:
			return data
		self._raise(r.status_code, (data or {}).get("error") or {}, r)
		return {}  # pragma: no cover

	@staticmethod
	def _raise(status: int, err: dict, r: requests.Response) -> None:
		code = err.get("code")
		text = str(err.get("message") or f"HTTP {status}")[:500]  # no phone numbers / bodies in details
		kw = {"code": str(code) if code is not None else None, "http_status": status}
		if status == 429 or code in (4, 80007, 130429, 131056):
			retry = r.headers.get("Retry-After")
			raise pex.RateLimitError(text, retry_after=int(retry) if retry and retry.isdigit() else None, **kw)
		if status == 401 or code == 190:
			raise pex.AuthError(text, **kw)
		if status == 403:
			raise pex.PermissionDeniedError(text, **kw)
		if status == 404:
			raise pex.NotFoundError(text, **kw)
		if code in (131026, 131047, 131030):  # undeliverable / outside 24h window / not allowed
			# English wording lets services/errors.classify pick a precise code from the text
			raise pex.BusinessRejectedError(text, reason=text, **kw)
		if code in (132000, 132001, 132005, 132007, 132012):
			raise pex.BusinessRejectedError(f"template: {text}", reason=text, **kw)
		if status >= 500:
			raise pex.TransientError(text, **kw)
		raise pex.ValidationError(text, **kw)

	# ---------------------------------------------------------------- account
	def health_check(self) -> HealthStatus:
		started = datetime.now()
		try:
			self._graph("GET", self.settings.credentials.get("api_key", ""), params={"fields": "id"})
		except pex.ProviderError as exc:
			return HealthStatus(ok=False, error=str(exc)[:200], checked_at=datetime.now())
		except Exception as exc:  # contract: never raises
			return HealthStatus(ok=False, error=exc.__class__.__name__, checked_at=datetime.now())
		return HealthStatus(
			ok=True, latency_ms=int((datetime.now() - started).total_seconds() * 1000), checked_at=datetime.now()
		)

	# get_account is still the parent's NotImplementedError. That is not a ProviderError, so an API
	# call reaching it answers HTTP 500: implement it or raise pex.NotSupportedError. The sign-up,
	# coupon and usage methods keep the parent's NotSupportedError.

	# ---------------------------------------------------------------- devices (= phone numbers)
	def list_devices(self) -> list[DeviceState]:
		waba = self.settings.credentials.get("api_key")
		data = self._graph("GET", f"{waba}/phone_numbers")
		return [
			DeviceState(
				platform_device=str(row["id"]),
				device_name=row.get("verified_name"),
				phone_e164="+" + "".join(ch for ch in str(row.get("display_phone_number", "")) if ch.isdigit()),
				status="Connected",  # Cloud numbers have no session to pair
				raw_status=row.get("status") or row.get("quality_rating"),
			)
			for row in data.get("data") or []
		]

	def get_device(self, platform_device: str) -> DeviceState:
		for state in self.list_devices():
			if state.platform_device == platform_device:
				return state
		raise pex.NotFoundError(f"Phone number {platform_device} not found", code="DEVICE_NOT_FOUND")

	def verify_device(self, platform_device: str) -> DeviceState:
		return self.get_device(platform_device)

	# create_device / update_device / delete_device: numbers are registered in Meta Business
	# Manager, so raise pex.NotSupportedError(...) here. get_qr / get_pair_code / reconnect /
	# disconnect keep the parent's NotSupportedError.

	# ---------------------------------------------------------------- sending
	def _payload(self, m: NormalizedMessage) -> dict:
		if m.recipient_type != "Individual" or not m.phone_e164:
			raise pex.ValidationError("The Cloud API sends to individual numbers only", code="RECIPIENT_REQUIRED")
		body: dict = {
			"messaging_product": "whatsapp",
			"recipient_type": "individual",
			"to": m.phone_e164.lstrip("+"),
			"biz_opaque_callback_data": m.client_ref,  # echoed on status webhooks → WebhookEvent.client_ref
		}
		if m.message_type == "Text":
			body.update(type="text", text={"body": m.body or "", "preview_url": False})
		elif m.message_type == "Template" and m.template:
			body.update(
				type="template",
				template={
					"name": m.template.name,
					"language": {"code": m.template.language},
					"components": list(m.template.components),
				},
			)
		elif m.message_type in MEDIA_TYPES and m.attachment:
			kind = MEDIA_TYPES[m.message_type]
			media: dict = {}
			if m.attachment.url:
				media["link"] = m.attachment.url
			else:
				media["id"] = self._upload(m.platform_device, m.attachment)  # POST {phone_number_id}/media
			if kind in ("image", "video", "document") and (m.caption or m.body):
				media["caption"] = m.caption or m.body
			if kind == "document":
				media["filename"] = m.attachment.file_name
			body.update(type=kind, **{kind: media})
		elif m.message_type == "Location" and m.location:
			body.update(
				type="location",
				location={
					"latitude": m.location.latitude,
					"longitude": m.location.longitude,
					"name": m.location.name,
					"address": m.location.address,
				},
			)
		elif m.message_type == "Interactive" and m.interactive:
			body.update(type="interactive", interactive=m.interactive)
		else:
			raise pex.NotSupportedError(f"{m.message_type} is not supported by the Cloud API", code="NOT_SUPPORTED")
		return body

	def _upload(self, phone_number_id: str, attachment) -> str:
		raise pex.NotSupportedError("Inline media upload is left out of this sketch")

	def send_message(self, message: NormalizedMessage) -> SendResult:
		data = self._graph("POST", f"{message.platform_device}/messages", json=self._payload(message))
		wamid = ((data.get("messages") or [{}])[0]).get("id")
		return SendResult(ok=bool(wamid), provider_message_id=wamid, device=message.platform_device)

	def send_batch(self, messages: list[NormalizedMessage], batch_id: str) -> BatchResult:
		if not messages:
			raise pex.ValidationError("Batch is empty", code="BATCH_EMPTY")
		if len(messages) > MAX_BATCH:  # before any I/O (contract test)
			raise pex.ValidationError(f"A batch carries at most {MAX_BATCH} messages", code="BATCH_TOO_LARGE")
		accepted, errors = [], []
		for m in messages:
			try:
				result = self.send_message(m)
			except (pex.AuthError, pex.RateLimitError, pex.TransientError) as exc:
				if not accepted and not errors:
					raise  # nothing sent yet: whole-call failure → every row re-queued, attempts unchanged
				# Codes from errors._PLATFORM_CODE_MAP so classify() picks the right class.
				code = {pex.AuthError: "AUTH_INVALID_KEY", pex.RateLimitError: "RATE_LIMITED"}.get(
					type(exc), "PROVIDER_ERROR"
				)
				errors.append(BatchError(client_ref=m.client_ref, error=str(exc), code=code))
				continue
			except pex.ProviderError as exc:
				# Meta's numeric codes are not in the platform code map; classify() falls back to
				# the English text of the error, then to "unknown" (dead letter).
				errors.append(BatchError(client_ref=m.client_ref, error=str(exc), code=exc.code))
				continue
			# queue_id is required by BatchAccepted; the wamid is the closest thing
			accepted.append(BatchAccepted(client_ref=m.client_ref, queue_id=result.provider_message_id or ""))
		return BatchResult(batch_id=batch_id, accepted=tuple(accepted), errors=tuple(errors))

	# get_message_status / get_queue_status / cancel_queued: the Cloud API reports status through
	# webhooks only, so keep the parent's NotSupportedError. reconcile.py logs the failure and
	# retries on the next run.

	# ---------------------------------------------------------------- webhooks
	def webhook_envelope(self, headers: Mapping[str, str]) -> WebhookEnvelope:
		# Meta sends no event-id header. The receiver needs a non-empty id before it reads the body,
		# so the signature (unique per body) stands in; parse_webhook supplies the real id.
		h = {str(k).lower(): str(v) for k, v in (headers or {}).items()}
		sig = h.get("x-hub-signature-256", "")
		return WebhookEnvelope(event_id=sig[7:] or None, event_name=None, signed=sig.startswith("sha256="))

	# verify_webhook: inherited. HMAC-SHA256(app_secret, raw_body) against X-Hub-Signature-256,
	# fresh=True because Meta sends no timestamp header.
	# parse_webhook: inherited. entry[].changes[].value → first message (message.received /
	# message.reaction) or first status (message.sent / delivered / read / failed).
	# replay_headers: default {} is enough, since the parent parses from the body alone.

	def get_webhook_secret(self) -> str:
		secret = self.settings.credentials.get("customer_api_secret")
		if not secret:
			raise pex.ProviderError("Meta app secret is not configured", code="NO_SECRET")
		return secret

	def list_available_webhook_events(self) -> list[dict]:
		return super().list_available_webhook_events()  # the five message.* events
```

Register it from your app:

```python
# my_app/hooks.py
whatsapp_providers = {"meta_cloud_full": "my_app.whatsapp.meta_cloud_full.MetaCloudFullProvider"}
```

Then extend the `WhatsApp Settings.provider` options ([§2.2](#22-what-whatsapp-settingsprovider-stores))
and set the provider.

Limits of this sketch that belong in your design, not in the app:

- **Subscription handshake.** Meta verifies a callback URL with a `GET` carrying `hub.mode`,
  `hub.verify_token` and `hub.challenge`. The app's receiver accepts `POST` only, and
  `tests/test_guest_surface.py` asserts it is the **only** guest method in `whatsapp_next`.
  Answering the handshake needs a guest endpoint in your own app, or a one-time manual setup.
  `configure_webhook` and the other endpoint methods stay `NotSupportedError`, as in the shipped
  skeleton ("configured in the Meta app dashboard").
- **Batched deliveries.** A Graph POST can carry several `messages` or `statuses`. The one-event
  contract processes the first.
- **24-hour window.** Free-form text outside the customer-service window is refused (131047). It
  surfaces as a non-retryable rejection and the row is dead-lettered.

---

## 9. Testing your provider

### 9.1 What the app already tests

| File | What it covers |
|---|---|
| `tests/test_providers_base.py` | **Contract test** over `SndPlatformProvider`, `MetaCloudProvider` and `FakeProvider`: every abstract method implemented and `key` / `display_name` set; the hook resolves both real classes; every platform fixture in `tests/fixtures/webhooks/` parses to its canonical event and keeps `raw`; inbound fields (LID sender, group, held, connection); signature valid / invalid / stale / missing; `MAX_BATCH + 1` raises `ValidationError` before I/O; `health_check` never raises; Meta skeleton parsing and `X-Hub-Signature-256` |
| `tests/test_registry.py` | `list_providers`, per-request cache, unknown key → `NotSupportedError`, `fake_provider()` override, credentials read with `get_password` and never masked or printed |
| `tests/test_snd_platform.py` | SND provider with HTTP mocked by `patch.object(provider._session, "request")`: D-020 headers, error mapping (200 `ok:false`, 401, 402, 409, 417, 429, 5xx), batch payload keys, status parsing |
| `tests/test_webhooks.py` | The receiver and handlers end to end with signed fixture deliveries |
| `tests/fake_provider.py` | `FakeProvider`: scripted, no network. Every call is recorded in `calls`; `batch_mode` (`accepted` / `held` / `error` / `transient` / `auth`) and `send_mode` script outcomes. It reuses the SND webhook helpers, and `signed_headers(secret, event, event_id, raw_body, timestamp=None)` builds signed SND headers |

Webhook fixtures in `tests/fixtures/webhooks/`: `message.{received, received.group,
received.lid, sent, delivered, read, failed, held, reaction}.json`,
`connection.{connected, disconnected, logged_out}.json`,
`group.{updated, participants.updated}.json`, `test.webhook.json`, `unknown.event.json`
(platform format), plus `meta_message_received.json` and `meta_message_delivered.json`
(Graph format). The contract test runs every file whose name does not start with `meta_`
through the SND parser.

### 9.2 A contract test for your provider

Put it in **your** app, so `whatsapp_next` stays untouched:

```python
# my_app/tests/test_acme_provider.py
import inspect
import json
from pathlib import Path
from unittest.mock import patch

from frappe.tests import IntegrationTestCase

from whatsapp_next.providers import exceptions as pex
from whatsapp_next.providers.base import MAX_BATCH, BaseProvider
from whatsapp_next.providers.registry import provider_classes
from whatsapp_next.providers.schemas import CANONICAL_EVENTS, NormalizedMessage, ProviderSettings

from my_app.whatsapp.acme import AcmeProvider

FIXTURES = Path(__file__).parent / "fixtures"


def _provider() -> AcmeProvider:
	return AcmeProvider(
		ProviderSettings(provider_key="acme_gateway", base_url="https://acme.invalid", timeout=5,
		                 credentials={"api_key": "k", "api_secret": "s"})
	)


class TestAcmeContract(IntegrationTestCase):
	def test_every_abstract_method_implemented(self):
		abstract = {
			name for name, _ in inspect.getmembers(BaseProvider, predicate=inspect.isfunction)
			if getattr(getattr(BaseProvider, name), "__isabstractmethod__", False)
		}
		for name in abstract:
			self.assertFalse(getattr(getattr(AcmeProvider, name), "__isabstractmethod__", False), name)
		self.assertTrue(AcmeProvider.key and AcmeProvider.display_name)

	def test_registered_through_the_hook(self):
		self.assertEqual(provider_classes()["acme_gateway"], "my_app.whatsapp.acme.AcmeProvider")

	def test_health_check_never_raises(self):
		p = _provider()
		with patch.object(p._session, "request", side_effect=RuntimeError("boom")):
			self.assertFalse(p.health_check().ok)

	def test_batch_guard_before_io(self):
		p = _provider()
		msg = NormalizedMessage(client_ref="r", platform_device="d", phone_e164="+966500000002", body="x")
		with patch.object(p._session, "request") as req, self.assertRaises(pex.ValidationError):
			p.send_batch([msg] * (MAX_BATCH + 1), "b")
		req.assert_not_called()

	def test_fixtures_parse_to_canonical_events(self):
		p = _provider()
		for path in sorted(FIXTURES.glob("*.json")):
			event = p.parse_webhook({}, json.loads(path.read_text()))
			self.assertTrue(event.event_id)
			self.assertIn(event.event_name, CANONICAL_EVENTS, path.name)

	def test_signature(self):
		...  # valid, wrong secret, stale timestamp, missing header, as in test_providers_base
```

The HTTP-mocking style (`patch.object(provider._session, "request")` returning a small response
stub) is the one `tests/test_snd_platform.py` uses. It assumes your provider keeps a
`requests.Session` in `self._session`, as both the SND provider and the sketch above do.

To drive the app's services with your provider inside a test, inject it through the registry,
exactly as the app's own tests inject `FakeProvider`:

```python
from whatsapp_next.tests.conftest_frappe import fake_provider

with fake_provider(_provider()) as provider:   # registry.override_for_tests under the hood
	...  # call services.dispatch / webhooks.v1.receiver.handle(...) here
```

### 9.3 Running

From the bench root (`/home/snd/frappe-bench`), on the development site:

```bash
# the app's own provider tests
bench --site whatsapp.dev.sanad.digital run-tests --app whatsapp_next --module whatsapp_next.tests.test_providers_base
bench --site whatsapp.dev.sanad.digital run-tests --app whatsapp_next --module whatsapp_next.tests.test_registry
bench --site whatsapp.dev.sanad.digital run-tests --app whatsapp_next --module whatsapp_next.tests.test_snd_platform

# your provider
bench --site whatsapp.dev.sanad.digital run-tests --app my_app --module my_app.tests.test_acme_provider
```

The site needs `allow_tests` in its `site_config.json`. Prefer `--module` runs: two full
`run-tests` on the same site at the same time interfere with each other. See
[CONTRIBUTING.md](CONTRIBUTING.md) for the full-suite routine and
[troubleshooting.md](troubleshooting.md) for worker reloads after adding a module.

---

## 10. Reference: how `SndPlatformProvider` maps to the platform

Transport (`_request`): URL = `base_url` + prefix + endpoint, with prefix
`/api/method/snd_whatsapp_platform.snd_whatsapp_platform.api.` (**api**) or
`…api.v1.` (**v1**). Authenticated calls send `X-SND-API-Key: customer_api_key`,
`Authorization: token api_key:api_secret` and `X-SND-API-Secret: customer_api_secret`
(D-020, D-129/D-130). Guest calls send no credentials. Every authenticated call requires
`customer_api_key` (`AuthError AUTH_KEY_MISSING` otherwise). Redirects are not followed. Frappe's
`message` wrapper is unwrapped.

| Method | HTTP | Prefix | Endpoint | Guest | Notes |
|---|---|---|---|---|---|
| `health_check` | GET | api | `get_subscription_status` | | Never raises; measures latency |
| `get_account` | GET | v1 | `get_account_api` | | On 404 / 501 / validation: `get_subscription_status` + `get_wallet_balance_api` |
| `get_usage` | GET | v1 | `get_usage_api` (`from`, `to`, `group_by`) | | 404 → `NotSupportedError` |
| `get_signup_bootstrap` | GET | api | `get_signup_bootstrap` | yes | |
| `start_signup` | POST | api | `start_signup` | yes | `coupon_code` sent only when used |
| `get_signup_status` | POST | api | `get_signup_status` (`token`) | yes | |
| `verify_signup_code` | POST | api | `verify_email_code` (`token`, `code`, `purpose?`) | yes | |
| `complete_signup` | POST | api | `verify_email_code` then `complete_signup` | yes | Returns credentials once |
| `start_password_reset` | POST | api | `start_password_reset` | yes | |
| `get_password_reset_status` | POST | api | `get_password_reset_status` | yes | |
| `complete_password_reset` | POST | api | `complete_password_reset` | yes | |
| `login` | POST | v1 | `login_with_password` | yes | Answer returned unchanged |
| `validate_coupon` | POST | v1 | `validate_coupon` | yes | Never redeems |
| `get_referral_coupon` | POST | v1 | `get_my_referral_coupon` | | |
| `create_device` | POST | api | `create_device_api` | | `Code` without phone → `ValidationError` before I/O |
| `list_devices` | GET | api | `list_devices_api` | | Status words mapped by `STATUS_MAP` |
| `get_device` | GET | api | `list_devices_api` | | Filters locally; `NotFoundError` |
| `update_device` | POST | v1 | `update_device_api` | | 404 → `NotSupportedError` |
| `get_qr` | GET | api | `get_device_qr_api` (`device`) | | No `qr_code` → `DeviceOfflineError` |
| `get_pair_code` | GET | api | `get_device_pair_code_api` (`device`) | | No `pair_code` → `ValidationError` |
| `verify_device` | GET | api | `verify_device_connection_api` (`device`) | | |
| `reconnect_device` | POST | v1 | `reconnect_device_api` | | 404 → `NotSupportedError` |
| `disconnect_device` | POST | api | `disconnect_device_api` | | |
| `delete_device` | POST | api | `delete_device_api` (`device`, `delete_local`) | | |
| `send_message` | POST | api | `send_message_api` | | `allow_fallback=0`; test send only |
| `send_batch` | POST | api | `enqueue_messages_api` (`messages[]`, `batch_id`) | | `client_ref` + `priority` per message; `Template` / `Interactive` → `NotSupportedError` |
| `get_message_status` | POST | api | `get_message_status_api` (`refs`) | | Returns `(statuses, unknown)` |
| `get_queue_status` | GET | api | `get_queue_status_api` | | |
| `cancel_queued` | POST | v1 | `cancel_queued_messages_api` (`refs?`, `batch_id?`) | | 404 → `NotSupportedError` |
| `get_poll_results` | POST | api | `get_poll_results_api` (`device`, `poll_ids`) | | |
| `list_device_contacts` | GET | api | `list_device_contacts_api` (`device`) | | |
| `list_device_groups` | GET | api | `list_device_groups_api` (`device`) | | |
| `verify_webhook` | — | — | local | | `hex(HMAC-SHA256(secret, "<X-SND-Timestamp>.<raw body>"))` vs `X-SND-Signature`, skew ≤ `max_skew` (D-013) |
| `webhook_envelope` | — | — | local | | `X-SND-Event-ID`, `X-SND-Event`, `X-SND-Signature` present |
| `replay_headers` | — | — | local | | `{X-SND-Event, X-SND-Event-ID}` |
| `parse_webhook` | — | — | local | | `message.status` aliased to a concrete event; `device` / `inbound` built when relevant |
| `get_webhook_secret` | GET | api | `get_integration_webhook_secret_api` | | Never passes `secret` on create (D-013) |
| `configure_webhook` | POST | api | `configure_integration_webhook_api`, then `list_webhook_endpoints_api`, then `update_webhook_endpoint_api` (v1) or `create_webhook_endpoint_api` | | Reuses the link's auto-created endpoint (D-120) |
| `list_webhook_endpoints` | GET | api | `list_webhook_endpoints_api` | | |
| `update_webhook_endpoint` | POST | v1 | `update_webhook_endpoint_api` | | 404 other than `WEBHOOK_NOT_FOUND` → `NotSupportedError` |
| `test_webhook_endpoint` | POST | api | `test_webhook_endpoint_api` | | |
| `delete_webhook_endpoint` | POST | api | `delete_webhook_endpoint_api` | | |
| `list_available_webhook_events` | GET | api | `list_available_webhook_events_api` | | |

Error mapping in `SndPlatformProvider._unwrap`:

| Platform answer | Exception |
|---|---|
| 2xx with `ok:false`, code `QUOTA_EXCEEDED` / `SUBSCRIPTION_INACTIVE` / `SUBSCRIPTION_EXPIRED` (or quota words without a code) | `QuotaExceededError` |
| 2xx with `ok:false`, `FEATURE_NOT_IN_PLAN` / `WEBHOOKS_NOT_IN_PLAN` | `FeatureNotInPlanError` |
| 2xx with `ok:false`, `DEVICE_NOT_CONNECTED` / `DEVICE_NO_TOKEN` (or device words) | `DeviceOfflineError` |
| other 2xx with `ok:false` | `BusinessRejectedError` |
| 429 or `RATE_LIMITED` | `RateLimitError` (`Retry-After`) |
| 401 or `AUTH_*` | `AuthError` |
| 403 | `PermissionDeniedError` (`NOT_OWNER`, `PERMISSION_DENIED`), `FeatureNotInPlanError`, else `AuthError` |
| 402 | `QuotaExceededError` |
| 404 | `NotFoundError` |
| 409 | `DeviceOfflineError` (device codes or words), else `BusinessRejectedError` |
| 400 / 413 / 415 / 422 | `ValidationError` |
| 417 | By text: `AuthError`, `DeviceOfflineError`, `QuotaExceededError`, else `ValidationError` |
| 501 | `NotSupportedError` |
| 5xx, 408, timeout, connection error | `TransientError` |

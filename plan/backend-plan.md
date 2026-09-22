# Backend plan — `whatsapp_next`

Phase 2 · 2026-09-22 · inputs: `plan/00-screens-spec.md` (binding §3.2, §4, §5, §6), `.claude/rules/{architecture,security}.md`
(binding), `plan/00-conventions.md`, `plan/02-doctypes-gap.md`, `plan/fields.md`, `plan/decisions.md` D-010..D-024,
`plan/01-snd-whatsapp-summary.md`, `plan/05-platform-summary.md`, `plan/06-doctypes-gap-platform.md`, `plan/fields-platform.md`,
legacy tree `../snd_whatsapp` (function inventory by grep), platform `api/__init__.py` + `services/message_queue.py` (payload keys).

## Purpose

| Item | Value |
|---|---|
| Scope | Everything server-side for phases 3–7: module tree, provider contract, services, API surface, jobs, realtime, webhooks, contextual layer, Numbers job, Notification/Alert port, retention, porting map, build order |
| Not decided here | Anything in the spec or D-010..D-024; DocType fields (`fields.md`); UI kit (`ui.md`). Disagreements → §Open questions |
| Roles | SM System Manager · MGR WhatsApp Manager · AGT WhatsApp Agent · VWR WhatsApp Viewer · CU WhatsApp Contact User |
| Job naming | `whatsapp_next.services.<module>.<function>`; queues `short` (sends, webhooks, status) / `long` (campaigns, imports, nightly) |
| Provider registry | `hooks.whatsapp_providers = {"snd_platform": "whatsapp_next.providers.snd_platform.SndPlatformProvider", "meta_cloud": "whatsapp_next.providers.meta_cloud.MetaCloudProvider"}` |

---

## Inventory

### 1. Module tree

```
whatsapp_next/
  hooks.py                          # whatsapp_providers, doc_events (6 events + Contact.validate), scheduler_events, fixtures, app_include_js
  install.py                        # after_install: roles, disabled service user (OQ-4), Settings defaults; after_migrate: add_indexes
  exceptions.py                     # WANextError(frappe.ValidationError) + subclasses = API error codes (§4.0)
  patches/v0_1/add_indexes.py       # composite indexes (fields.md RC-02), idempotent
  whatsapp_next/doctype/<24 dts>/   # thin controllers: validate, phone pair normalization, status-writer guard, cache invalidation
  whatsapp_next/page/wa-*/          # phase 7
  providers/
    __init__.py  base.py  registry.py  exceptions.py  schemas.py  snd_platform.py  meta_cloud.py
  services/
    phone.py               # E.164 (§6.2)                     read_layer.py          # the only UNION (§6.1)
    dispatch.py            # outbound create/claim/send/status  reconcile.py           # status + stale-claim + coherence
    campaign_runner.py     # materialize, pace, counters       picker.py              # 6 sources, parsers, dedupe, commit add/remove
    command_router.py      # inbound → allow-listed handler     inbound.py             # message.received/reaction → Inbound row
    devices.py             # device lifecycle, pairing cache    webhook_setup.py       # endpoint + secret on the platform
    numbers_materializer.py# incremental + nightly              functions_catalog.py   # catalog JSON, versions, diff, install
    permissions.py         # contextual layer (§4)              audit.py               # one insert function, real user
    templates.py           # sandboxed Jinja render             attachments.py         # File bytes, PDF/PNG render, mime
    notifications.py       # doc-event notifications (D-016)    alerts.py  alerts_dates.py  report_render.py   # report digests
    polls.py               # option parsing + results           errors.py              # provider text → error_code
    usage_sync.py          # subscription/wallet cache          retention.py           # purge jobs
    quick_send.py          # compose → Outbound                 simulator.py           # on-behalf inbound, test send
  functions/
    registry.py            # FUNCTION_HANDLERS: {function_key: callable}  (D-012 allow-list)
    handlers/*.py          # one module per function key
    catalog/v1/catalog.json
  api/                     # @frappe.whitelist only (§4); versioned packages (D-031)
    _common.py             # api_endpoint decorator: roles, typed args, error mapping (not whitelisted, version-neutral)
    v1/                    # one module per area: settings.py onboarding.py home.py devices.py quick_send.py messages.py simulator.py queue.py numbers.py contacts.py picker.py campaigns.py templates.py notifications.py alerts.py functions.py commands.py
    home.py onboarding.py settings.py devices.py quick_send.py messages.py queue.py numbers.py contacts.py
    picker.py campaigns.py templates.py notifications.py alerts.py functions.py commands.py simulator.py
  webhooks/
    receiver.py            # the only guest endpoint            verify.py              # HMAC + timestamp window
    idempotency.py         # Webhook Event row dedupe           handlers.py            # process_event + per-event handlers
  public/js/{ui,listview,form}/     # phase 6
  fixtures/                # role.json, custom_field.json (Contact Phone.wa_phone_e164), workspace
  translations/ar.csv
  tests/                   # conventions layout + tests listed in §15
```

### 2. Provider abstraction

#### 2.1 `providers/schemas.py` (dataclasses, frozen where possible)

| Class | Fields |
|---|---|
| `ProviderSettings` | `base_url`, `timeout`, `credentials: dict` (read via `get_password`, never logged), `provider_key` |
| `NormalizedMessage` | `client_ref`, `platform_device`, `recipient_type` (Individual/Group), `phone_e164`, `jid`, `message_type` (Text/Document/Image/Video/Audio/Sticker/Location/Poll/Template/Interactive), `body`, `caption`, `attachment: AttachmentRef|None` (`file_name`, `mime_type`, `content_b64` or `url`), `view_once`, `location: Location|None`, `poll: Poll|None`, `template: TemplateRef|None` (meta), `interactive: dict|None` (meta), `source: Source` (`type`, `doctype`, `docname`, `site`), `priority` |
| `SendResult` | `ok`, `provider_message_id`, `platform_message_log`, `device_fallback: bool`, `requested_device`, `rejected: bool`, `reason`, `code` |
| `BatchResult` | `batch_id`, `accepted: list[BatchAccepted(client_ref, queue_id, status)]`, `errors: list[BatchError(client_ref, error, code)]` |
| `MessageStatus` | `client_ref`, `queue_id`, `status` (provider vocabulary), `reason`, `platform_message_log`, `attempt_count`, `provider_message_id` |
| `DeviceState` | `platform_device`, `device_name`, `phone_e164`, `status` (Pending QR/Connected/Disconnected/Logged Out), `wa_device_id`, `last_seen`, `webhook_registered`, `webhook_url`, `raw_status` |
| `PairingPayload` | `mode` (QR/Code), `qr_code` or `pair_code`, `generated_at`, `expires_at`, `expires_in` |
| `WebhookEvent` | `event_id`, `event_name` (canonical), `timestamp`, `platform_device`, `client_ref`, `provider_message_id`, `queue_id`, `platform_message_log`, `status`, `reason`, `device: DeviceState|None`, `inbound: InboundPayload|None`, `raw: dict` |
| `InboundPayload` | `provider_message_id`, `sender_phone` (raw), `sender_jid`, `chat_jid`, `from_jid`, `is_group`, `push_name`, `message_type`, `body`, `caption`, `media_url`, `media_mime_type`, `location`, `reaction`, `reaction_to`, `quoted_id`, `received_at` |
| `AccountInfo` | `plan_code`, `plan_name`, `status`, `message_limit`, `messages_used`, `messages_remaining`, `messages_per_minute`, `device_limit`, `devices_used`, `start_date`, `end_date`, `features: dict`, `wallet_balance`, `wallet_currency` |
| `UsageReport` | `from_`, `to`, `group_by`, `rows: list[UsageRow(key, sent, failed, units)]` |
| `QueueStatus` | `counts: dict`, `messages_per_minute`, `messages_remaining` |
| `ProviderContact` / `ProviderGroup` | `jid`, `phone_e164`, `name` / `jid`, `name`, `participants_count` |
| `WebhookEndpointState` | `endpoint_id`, `url`, `status` (Active/Disabled/Locked/Revoked), `events`, `max_retries`, `consecutive_failures`, `locked_at`, `lock_reason` |
| `HealthStatus` | `ok`, `latency_ms`, `error`, `checked_at` |
| `SignatureCheck` | `valid`, `fresh`, `event_timestamp`, `reason` |
| `SignupState` | `request_key`, `status`, `credentials: dict|None` (returned once, never logged) |

#### 2.2 `providers/exceptions.py`

| Exception | Base | `retryable` | Raised for |
|---|---|---|---|
| `ProviderError(message, code=None, http_status=None, details=None)` | `Exception` | False | anything else; `details` never carries bodies/phones |
| `AuthError` | ProviderError | False | 401/403 on auth, invalid key, `AUTH_*` codes, 417 with auth text |
| `PermissionDeniedError` | ProviderError | False | 403 ownership (device/endpoint not ours) |
| `NotFoundError` | ProviderError | False | 404 |
| `ValidationError` | ProviderError | False | 400, 413, 417 `exc_type` validation |
| `BusinessRejectedError` | ProviderError | False | HTTP 200 `ok:false`/`rejected:true` (quota, feature, recipient) — carries `reason`, `platform_message_log` |
| `QuotaExceededError` | BusinessRejectedError | False | `QUOTA_EXCEEDED`, 402 |
| `FeatureNotInPlanError` | BusinessRejectedError | False | `FEATURE_NOT_IN_PLAN` |
| `DeviceOfflineError(device_status)` | ProviderError | True | 409 device not connected / no token |
| `RateLimitError(retry_after)` | ProviderError | True | 429 / `RateLimitExceededError` |
| `TransientError` | ProviderError | True | timeouts, connection errors, 5xx, 503 |
| `NotSupportedError` | ProviderError | False | capability absent on this provider (meta_cloud, A-0x endpoints not yet live) |
| `WebhookSignatureError` | ProviderError | False | bad HMAC / stale timestamp |

Rule: nothing outside `providers/` sees `requests` exceptions; every method wraps.

#### 2.3 `providers/base.py` — the contract

```python
class BaseProvider(ABC):
	key: str                      # registry key, e.g. "snd_platform"
	display_name: str
	capabilities: frozenset[str]  # {"batch_send","pair_code","signup","usage","queue_cancel","interactive","template"}

	def __init__(self, settings: ProviderSettings) -> None: ...

	# --- account / tenant linkage ---
	def health_check(self) -> HealthStatus: ...                                  # never raises; error in result
	def get_account(self) -> AccountInfo: ...                                    # AuthError, TransientError
	def get_usage(self, from_: date, to: date, group_by: str = "day") -> UsageReport: ...   # NotSupportedError until A-04
	def start_signup(self, plan_code: str, mobile_e164: str, full_name: str, email: str, channel: str) -> SignupState: ...
	def get_signup_status(self, request_key: str) -> SignupState: ...
	def complete_signup(self, request_key: str, code: str) -> SignupState: ...   # credentials returned once
	def start_password_reset(self, identifier: str) -> SignupState: ...

	# --- device lifecycle ---
	def create_device(self, device_name: str, phone_e164: str | None, pairing_mode: str) -> DeviceState: ...
	def list_devices(self) -> list[DeviceState]: ...
	def get_device(self, platform_device: str) -> DeviceState: ...              # NotFoundError
	def update_device(self, platform_device: str, device_name: str | None, phone_e164: str | None) -> DeviceState: ...  # NotSupported until A-05
	def get_qr(self, platform_device: str) -> PairingPayload: ...              # DeviceOfflineError(no token)
	def get_pair_code(self, platform_device: str) -> PairingPayload: ...       # ValidationError(no phone)
	def verify_device(self, platform_device: str) -> DeviceState: ...
	def reconnect_device(self, platform_device: str) -> DeviceState: ...       # NotSupported until A-05
	def disconnect_device(self, platform_device: str) -> DeviceState: ...
	def delete_device(self, platform_device: str, delete_remote: bool) -> None: ...

	# --- sending ---
	def send_message(self, message: NormalizedMessage) -> SendResult: ...      # single; test send only (D-024)
	def send_batch(self, messages: list[NormalizedMessage], batch_id: str) -> BatchResult: ...  # ≤ 200; ValidationError above
	def get_message_status(self, client_refs: list[str]) -> tuple[list[MessageStatus], list[str]]: ...  # (statuses, unknown)
	def get_queue_status(self) -> QueueStatus: ...
	def cancel_queued(self, client_refs: list[str] | None, batch_id: str | None) -> int: ...  # NotSupported until A-11
	def get_poll_results(self, platform_device: str, poll_ids: list[str]) -> dict[str, dict]: ...

	# --- contacts / groups ---
	def list_device_contacts(self, platform_device: str) -> list[ProviderContact]: ...
	def list_device_groups(self, platform_device: str) -> list[ProviderGroup]: ...

	# --- webhooks ---
	def verify_webhook(self, headers: Mapping[str, str], raw_body: bytes, secret: str, max_skew: int = 300) -> SignatureCheck: ...
	def parse_webhook(self, headers: Mapping[str, str], body: dict) -> WebhookEvent: ...   # pure; never touches DB
	def get_webhook_secret(self) -> str: ...                                  # value returned to caller only; caller stores via set_password
	def configure_webhook(self, endpoint_url: str, events: list[str], max_retries: int) -> WebhookEndpointState: ...
	def list_webhook_endpoints(self) -> list[WebhookEndpointState]: ...
	def update_webhook_endpoint(self, endpoint_id: str, status: str | None, events: list[str] | None, url: str | None) -> WebhookEndpointState: ...  # A-06
	def test_webhook_endpoint(self, endpoint_id: str) -> dict: ...
	def delete_webhook_endpoint(self, endpoint_id: str) -> None: ...
	def list_available_webhook_events(self) -> list[dict]: ...
```

Contract test (`tests/test_providers_base.py`): every registered provider class implements every abstract method; `parse_webhook` on the sample payloads in `tests/fixtures/webhooks/*.json` yields canonical `event_name` and `event_id`; `verify_webhook` rejects a stale timestamp and a wrong HMAC; `send_batch` with 201 messages raises `ValidationError` before any I/O; `health_check` never raises.

#### 2.4 `providers/registry.py`

| Function | Behaviour |
|---|---|
| `get_provider(key: str | None = None) -> BaseProvider` | key defaults to `Settings.provider`; class path from `frappe.get_hooks("whatsapp_providers")` (merged across apps); instantiates with `ProviderSettings` built from Settings (`get_password` for the three credentials); cached per request in `frappe.local` |
| `list_providers() -> list[dict]` | keys + display names for the Settings Select |
| `override_for_tests(instance)` / `clear_override()` | tests inject `FakeProvider`; production path never reads this |

#### 2.5 `providers/snd_platform.py` — method → platform endpoint

Transport: one `_request(method, endpoint, params=None, body=None) -> dict` over `requests.Session`; headers `X-SND-API-Key: customer_api_key`, `Authorization: token {api_key}:{api_secret}`, `X-SND-API-Secret: api_secret` (D-020); timeout `Settings.request_timeout`; unwraps Frappe `message`; maps status → exception (417 `exc_type` → `ValidationError`/`AuthError` by text, 200 `ok:false` → `BusinessRejectedError`, `rejected:true` keeps `platform_message_log`; `code` key (A-09) preferred over text when present).

| Method | Endpoint (`snd_whatsapp_platform.snd_whatsapp_platform.api.*`) | Notes |
|---|---|---|
| `health_check`, `get_account` | `get_subscription_status` (+ `get_wallet_balance_api`; `get_account_api` when A-01 lands) | latency measured around the first call |
| `get_usage` | `get_usage_api` (A-04) else `NotSupportedError` | |
| `start_signup` … | platform guest `start_signup`, `get_signup_status`, `complete_signup`, `start_password_reset` | called server-side; no credentials needed |
| `create_device` | `create_device_api(device_name, phone_number, pairing_mode)` | `phone_number` only for Code mode |
| `list_devices` / `get_device` | `list_devices_api` | status normalised to the four local values |
| `update_device`, `reconnect_device` | `update_device_api`, `reconnect_device_api` (A-05) | `NotSupportedError` until live |
| `get_qr` / `get_pair_code` | `get_device_qr_api` / `get_device_pair_code_api` | `qr_expires_in` (60) → `expires_at` |
| `verify_device` / `disconnect_device` / `delete_device` | `verify_device_connection_api` / `disconnect_device_api` / `delete_device_api(delete_local)` | |
| `send_message` | `send_message_api` with `device`, `client_ref` (A-08), `allow_fallback=0` (A-07) | `device_fallback` surfaced in `SendResult` |
| `send_batch` | `enqueue_messages_api(messages[], batch_id)` — per message only `_PAYLOAD_KEYS` + `client_ref`, `device`, `priority`, `source_*` | platform ignores unknown keys; **no `scheduled_at`** (Findings F-05) |
| `get_message_status` | `get_message_status_api(refs)` ≤ 200 | statuses: Queued/Sending/Sent/Failed/Held/Cancelled |
| `get_queue_status` | `get_queue_status_api` | cached 60 s by caller |
| `cancel_queued` | `cancel_queued_messages_api` (A-11) | `NotSupportedError` until live |
| `get_poll_results` | `get_poll_results_api(device, poll_ids)` ≤ 100 | |
| `list_device_contacts/groups` | `list_device_contacts_api` / `list_device_groups_api` | phone → `phone.normalize` |
| `verify_webhook` | local: `hmac.compare_digest(hex(HMAC-SHA256(secret, f"{ts}.{raw}")), X-SND-Signature)`; `abs(now-ts) ≤ max_skew` | header names `X-SND-Event`, `X-SND-Event-ID`, `X-SND-Timestamp`, `X-SND-Signature` |
| `parse_webhook` | maps 12 `SUPPORTED_WEBHOOK_EVENTS` + `message.status` alias; `sender_mobile_no`/`sender_jid` (D-023) | unknown name kept as-is, `event_name` unchanged → handler ignores |
| `get_webhook_secret` | `get_integration_webhook_secret_api` | never passes `secret` on create (D-013) |
| `configure_webhook` | `configure_integration_webhook_api(endpoint_url)` then `create_webhook_endpoint_api(endpoint_url, events, max_retries)` when no endpoint exists | |
| `list/update/test/delete_webhook_endpoint`, `list_available_webhook_events` | `list_webhook_endpoints_api`, `update_webhook_endpoint_api` (A-06), `test_webhook_endpoint_api`, `delete_webhook_endpoint_api`, `list_available_webhook_events_api` | |

#### 2.6 `providers/meta_cloud.py` skeleton

```python
class MetaCloudProvider(BaseProvider):
	"""Meta WhatsApp Cloud API — skeleton proving the abstraction. Every method raises NotImplementedError
	except `capabilities`, `parse_webhook` (Graph webhook envelope → WebhookEvent, pure) and `verify_webhook`
	(X-Hub-Signature-256 = HMAC-SHA256(app_secret, raw_body); no timestamp header → fresh=True)."""
	key = "meta_cloud"
	display_name = "Meta Cloud API"
	capabilities = frozenset({"template", "interactive"})
```
Pairing methods raise `NotSupportedError` (Cloud API has no QR/pair-code); the contract test asserts the skeleton still satisfies the ABC and that `parse_webhook` handles `tests/fixtures/webhooks/meta_*.json`.

### 3. Services and responsibilities

| Module | Public functions (typed, docstringed) | Responsibility / rules |
|---|---|---|
| `phone.py` | `default_region() -> str` (Settings.default_country → `Country.code` upper, cached); `normalize(raw, region=None) -> str|None`; `classify(value) -> tuple[kind, key]` (`Individual`→E.164, `Group`→`…@g.us`, `LID`→`…@lid`); `key_for(phone_e164, jid) -> str`; `to_jid(key) -> str`; `is_valid_key(value) -> bool`; `mask(e164) -> str` | `phonenumbers` (Frappe dependency). Strip spaces/`-`/`()`; `00` → `+`; digits-only or leading `0` → parse with region; `@c.us`/`@s.whatsapp.net` → digits → E.164; `@g.us`/`@lid` pass through untouched (gap F-05); invalid → `None` (callers raise `WAInvalidPhoneError`). Applied on `validate` of every phone pair (fields.md table) and in every comparison. No Yemen-specific rules (R-F) |
| `read_layer.py` | `conversation(key, device=None, before=None, limit=50) -> list[MessageRow]`; `iter_keys_since(watermark, upper, batch=5000) -> Iterator[set[str]]`; `stats_by_key(keys) -> dict[key, KeyStats(outbound_count, inbound_count, first_seen, last_seen, last_direction, last_device, display_name)]`; `known_keys(keys) -> set`; `device_stats(device, days=30) -> DeviceStats`; `reference_amount(doctype, name) -> Currency|None`; `cross_direction_rows(filters, page) -> list` | **The only UNION**: one `frappe.qb` union of Outbound (`phone_e164`/`jid`, `creation`, `status`, …) and Inbound (`phone_e164`/`sender_jid`/`chat_jid`, `received_at`, …) executed once via `frappe.db.sql(str(query))` (Findings F-03, decision entry required). Emits `direction`. Consumers: Numbers job, picker known-number flag, conversation drawer, device cards, reports. `reference_amount` uses a per-DocType field map (`grand_total`, `rounded_total`, `amount`) — never stored |
| `dispatch.py` | `create_outbound(spec: OutboundSpec, *, user=None) -> str` (validates recipient via `phone`, blacklist, known-number policy, template render, attachment ref; inserts Outbound `Unsent`); `enqueue(outbound_names, priority, scheduled_at=None) -> list[str]` (Queue Item rows, Outbound `Queued`, `queued_at`); `dispatch_tick()`; `dispatch_device_batch(device)`; `claim_batch(device, limit) -> list[QueueItem]`; `apply_batch_result(items, result)`; `apply_status(outbound, status, *, at, provider_message_id=None, error_code=None, reason=None, source)`; `pause_items(filters, user, reason)`; `resume_items(filters, user)`; `delete_items(filters, user, reason) -> int`; `retry_dead_letter(names, user)`; `pause_queue(user, reason)`; `resume_queue(user)`; `send_test_message(outbound)` | **Single status writer** for Outbound and Queue Item (sets `frappe.flags.wa_status_writer`; controllers reject status changes otherwise). Forward-only status (never `Read`→`Delivered`). No HTTP outside jobs. Priority: Quick Send/Command Reply 1, Notification/Alert 3, Campaign 5 |
| `reconcile.py` | `reconcile_statuses()`; `requeue_stale_claims(older_than_minutes=10)`; `assert_coherence() -> list[Drift]` | Every 5 min: `Outbound.status = Sending and platform_queue_id set and modified < now-10min` (≤ 200 refs per call) → `get_message_status`; `unknown` refs → back to `Queued` once, then `Failed(platform_rejected)`; stale `Sending` Queue Items without `platform_queue_id` → `Queued`; drift between Queue Item and Outbound → Error Log (no payload) + fix by Queue Item |
| `campaign_runner.py` | `start(campaign, user)`; `schedule(campaign, at, user)`; `promote_scheduled()`; `materialize(campaign)`; `pause(campaign, user, reason)`; `resume(campaign, user)`; `cancel(campaign, user, reason)`; `refresh_counters(campaign)`; `finalize_if_done(campaign)` | `materialize` (long queue): per recipient × message → Outbound rows via `frappe.db.bulk_insert` batches ≤ 500 with pre-rendered body (Jinja over recipient context) and PDF per recipient rendered here (not in dispatch); Queue Items with `scheduled_at = campaign.scheduled_at + Σ delay_seconds`; single `refresh_keys` call to the Numbers materializer for the whole recipient set. Pacing: campaign `messages_per_minute` applied by the dispatcher per campaign per tick. Counters from one grouped `count(*) group by status` query over Outbound `campaign=` |
| `picker.py` | `list_sources(user) -> list`; `search_groups(txt, kind, page)`; `search_contacts(txt, page)` (→ `permissions`); `doctype_rows(document_type, filters, page)` (→ `permissions`); `parse_manual(text) -> ParseResult`; `parse_excel(file) / parse_csv(file) / parse_vcard(file) -> ParseResult`; `preview(target, rows) -> Preview(available, already_added, invalid, duplicates_in_selection)`; `commit_add(target, rows, source, user) -> int`; `commit_remove(target, keys, user) -> int` | Every row normalised through `phone.normalize`; duplicate = same `phone_e164` in target child table **or** within the selection; `bulk_insert` for adds; removal = child row delete (Group) or `status=Removed` (+`removed_by/at`) for Campaign in `Running/Paused`; parent counters updated; audit row with `count` |
| `command_router.py` | `route(inbound_name, *, dry_run=False) -> RouteResult`; `match(text) -> Match|None`; `check_access(command, inbound) -> BlockReason|None`; `parse_args(command, text) -> dict`; `execute(command, inbound, args) -> FunctionResult`; `render_outputs(command, result) -> list[OutboundSpec]`; `help_text(sender_key) -> str` | D-012: handler = `functions.registry.FUNCTION_HANDLERS[function.function_key]`; `frappe.set_user(settings.command_service_user)` in `try/finally` restoring the job user; refuses to run in a web request (`frappe.request` set → raise). Access order: commands enabled → text type → global blacklist → command blocked_group → allowed_group → `requires_linked_contact` (Number.contact or `Contact Phone.wa_phone_e164`) → party types → function Active. Match on exact `phone_e164` membership, never digit suffixes (legacy F10). Metrics: Function `call_count`, `avg_ms`, `error_count` |
| `inbound.py` | `record_inbound(event: WebhookEvent, webhook_event_name) -> str|None`; `record_reaction(event, webhook_event_name)`; `resolve_contact(phone_e164) -> str|None`; `link_display_name(inbound)` | Dedupe on `provider_message_id` (OQ-B); `phone_e164 = normalize(sender_mobile_no)` else digits of `sender_jid` unless `@lid`; contact auto-link via `Contact Phone.wa_phone_e164` (OQ-5); enqueues Numbers upsert + `command_router.route` (short); publishes `wa:inbound:received` (Gaps G-3) |
| `devices.py` | `create(device_name, phone, pairing_mode, user) -> str`; `start_pairing(device, mode) -> PairingPayload`; `poll(device) -> DeviceState`; `apply_connection_event(event: WebhookEvent)`; `apply_state(device, state, source)`; `disconnect(device, user)`; `delete(device, delete_remote, user)`; `sync_from_provider()`; `set_default(device, user)`; `set_disabled(device, flag, user)` | Status writer for Device; pairing payload in `frappe.cache` key `wa:pair:{platform_device}` TTL 60 s, never persisted (D-014); `apply_state` publishes `wa:device:status` and writes Audit `Device Connected/Disconnected` (user = session or `Administrator` + `job_name`) |
| `webhook_setup.py` | `ensure_endpoint(user) -> WebhookEndpointState`; `fetch_secret(user)`; `rotate_secret(user)`; `set_status(status, user)`; `sync_status()`; `test(user)` | Secret stored with `settings.set_password("webhook_secret", value)`; Audit `Webhook Changed` / `Credentials Changed`; mirrors `webhook_status` (D-018) |
| `numbers_materializer.py` | `refresh_keys(keys: Iterable[str]) -> RefreshStats`; `upsert_from_message(doctype, name)`; `nightly_reconcile()` | §10 |
| `functions_catalog.py` | `load_catalog() -> Catalog`; `versions(function_key) -> list[str]`; `diff(function_key, target_version) -> Diff`; `install(function_key, version, user)`; `update(function_key, version, user)`; `remove(function_key, user)`; `check_updates()`; `validate_handler(function_key) -> bool` | Catalog = `functions/catalog/vN/catalog.json` in this app plus any app exposing hook `whatsapp_function_catalogs = ["<app>.functions.catalog"]`; `checksum = sha256(manifest)`; install copies `settings`/`outputs` rows, snapshots `manifest`; remove refuses while an `Active` command references it |
| `permissions.py` | §9 | contextual layer; the only module that writes core `Contact` |
| `audit.py` | `log(action, *, reference=None, target=None, fields_written=(), reason=None, count=None, details=None, severity="Action") -> str` | Inserts `WhatsApp Audit Log` with `ignore_permissions=True`, `user = frappe.session.user`, `job_name = frappe.local.job.name` when in a job, `ip_address = frappe.local.request_ip`; masks phones in `details` via `phone.mask`; never accepts secrets (keys filtered by name `*key*`, `*secret*`, `*token*`) |
| `templates.py` | `render(source: str, context: dict) -> str` (sandboxed `frappe.render_template`); `compile_check(source) -> list[str]`; `context_for(reference_doctype, reference_name, extra) -> dict`; `variables(reference_doctype) -> list[str]` | Errors → logged (`Notification.last_error`, `Template` preview error) never thrown at send (F2) |
| `attachments.py` | `as_bytes(file_url) -> bytes`; `render_print_pdf(doctype, name, print_format, letter_head, language) -> bytes`; `pdf_first_page_png(pdf_bytes) -> bytes|None` (PyMuPDF optional); `save_private_file(content, file_name, attached_to) -> str`; `mime_for(file_name) -> str`; `attachment_ref(outbound) -> AttachmentRef` | Uses `frappe.get_print(..., as_pdf=True)` (wkhtmltopdf). WeasyPrint not used (Open questions OQ-2). Only called from jobs |
| `notifications.py` | `on_doc_event(doc, method)`; `active_for(doctype, event) -> list` (cache `wa:notif:{doctype}`); `evaluate(notification, doc, event) -> bool`; `send_for_document(notification, doctype, name, event)`; `resolve_recipients(notification, doc) -> list[Recipient]`; `trigger_daily()`; `trigger_offset()`; `clear_cache(doctype=None)` | §11 |
| `alerts.py`, `alerts_dates.py`, `report_render.py` | `run_due_alerts()`; `run_alert(name, *, preview=False) -> AlertRun`; `compute_next_run(alert) -> datetime`; `expand_recipients(alert, rows) -> list[Recipient]`; `resolve_filters(alert) -> dict`; dates: `relative_date`, `week_range`, `month_range`, `quarter_range`, `year_range`, `fiscal_year_range`, `last_days_range`; render: `report_html(columns, rows, alert) -> str`, `report_pdf(html, alert) -> bytes` | §11 |
| `polls.py` | `parse_options(value) -> list[str]`; `fetch_results(campaign, refresh) -> dict`; `extract_selected(payload, options) -> list[str]` | one parser (legacy ×3) |
| `errors.py` | `classify(exc_or_text) -> ErrorClass(code, retryable)` | Maps provider text/codes → Outbound `error_code` vocabulary (`recipient_not_registered`, `device_disconnected`, `timeout`, `platform_rejected`, `invalid_template`, `insufficient_balance`, `invalid_phone`, `blacklisted`, `unknown_number_policy`, `unknown`) |
| `usage_sync.py` | `sync_subscription()`; `sync_usage(from_, to)` | Writes Settings cache fields with `ignore_permissions`; no audit (system cache) |
| `retention.py` | `purge()`; `purge_table(doctype, days, date_field, batch=1000) -> int` | §12 |
| `quick_send.py` | `compose(spec, user) -> str` | Wraps `dispatch.create_outbound` + `enqueue(priority=1)`; `source_type` Quick Send/Form/API |
| `simulator.py` | `simulate_inbound(device, sender, text, run_commands) -> SimResult`; `send_test(device, phone_e164, body, user) -> str` | Inbound/Outbound rows `is_simulated=1`; commands run in `dry_run` producing an Outbound `is_simulated=1` never dispatched; test send = Outbound `is_test=1` → job `dispatch.send_test_message` (D-010, D-024) |

### 4. API surface

> **Versioning (D-031):** every whitelisted method below lives in `whatsapp_next/api/v1/<area>.py` and is called as `whatsapp_next.api.v1.<area>.<fn>` (`/api/method/…`). Short names in the tables (`contacts.list_contacts`) are relative to `api.v1`. A breaking change ships as `api/v2/` with `v1` left intact. The receiver is `whatsapp_next.webhooks.v1.receiver.receive`.

#### 4.0 Conventions and error codes

`api/_common.py` provides `@api_endpoint(roles: tuple[str, ...] | None, schema: dict | None)`: checks `frappe.only_for(roles)` (or `has_permission` inside the function when document-scoped), coerces/validates arguments (`int`, `bool`, `list[str]`, `datetime`, enum), rejects unknown fieldnames, converts `providers.exceptions.*` to `WANextError` subclasses. Every endpoint is `allow_guest=False` (default) except `webhooks.receiver.receive`. Responses are plain dicts; lists paginate with `page`, `page_length ≤ 200`, return `{rows, total}`.

| Exception (`whatsapp_next/exceptions.py`) | HTTP | Meaning (JS maps `exc_type`) |
|---|---|---|
| `WAPermissionError` (`frappe.PermissionError`) | 403 | role/document permission missing |
| `WAValidationError` (`frappe.ValidationError`) | 417 | bad argument, schema, state guard text |
| `WANotFoundError` | 404 | record or key unknown |
| `WAStateConflictError` | 409 | editing an Active command, deleting a `Sending` queue item, starting a non-Draft campaign |
| `WAInvalidPhoneError` | 417 | `phone.normalize` returned `None` |
| `WABlacklistedError` | 417 | recipient in global/command blacklist |
| `WAUnknownNumberPolicyError` | 417 | `send_only_to_known_numbers` blocks the recipient |
| `WADeviceOfflineError` | 409 | device not Connected (send still queued when `allow_queue=1`) |
| `WAQueuePausedError` | 409 | action requires a running queue (informational only for sends) |
| `WAProviderAuthError` | 502 | credentials rejected by the platform |
| `WAProviderUnavailableError` | 503 | transient provider failure |
| `WAProviderRejectedError` | 422 | business rejection (`reason`, `code` passed through) |
| `WARateLimitError` | 429 | provider or local rate limit |
| `WAFileError` | 417 | upload not private / not owned / too large / unparsable |
| `WANotSupportedError` | 501 | capability absent for the active provider |

Common short-hands in the tables: **P** = permission, **E** = error codes beyond `WAPermissionError`/`WAValidationError`.

#### 4.1 `api.onboarding` (screen 1) and `api.settings` (screen 15)

| Function | Args | Returns | P | E |
|---|---|---|---|---|
| `onboarding.get_status` | — | `{setup_completed, steps[{key, done, detail}], redirect_enabled}` | any WhatsApp role | — |
| `onboarding.start_signup` | `plan_code, mobile, full_name, email, channel` | `{request_key, status, code_ttl}` | SM | `WAProviderUnavailableError`, `WARateLimitError`, `WANotSupportedError` |
| `onboarding.get_signup_status` | `request_key` | `{status}` | SM | idem |
| `onboarding.complete_signup` | `request_key, code` | `{ok}` — credentials written straight into Settings via `set_password`, never returned | SM | idem |
| `onboarding.start_password_reset` | `identifier` | `{ok}` | SM | idem |
| `onboarding.save_credentials` | `platform_base_url, customer_api_key, api_key, api_secret` | `{ok}` | SM | audit `Credentials Changed` |
| `onboarding.complete_setup` | — | `{setup_completed}` | SM | requires connection OK + ≥ 1 Connected device + webhook Active |
| `settings.get_settings` | `section=None` | non-secret fields; secrets as `has_customer_api_key` … booleans; permlevel-1 values never | MGR, SM | — |
| `settings.save_settings` | `section, values` | `{ok, changed[]}` | SM | fieldnames validated per section allow-list; audit `Settings Changed` (`fields_written`) |
| `settings.test_connection` | — | `{ok, latency_ms, plan_code, error}` | SM, MGR | writes `connection_status*`; never raises on provider failure |
| `settings.sync_subscription` | — | `{synced_at, plan…}` | MGR, SM | `WAProviderAuthError` |
| `settings.get_usage` | `from_date, to_date, group_by` | `{rows[], from, to}` (cached 10 min) | MGR, VWR | `WANotSupportedError` |
| `settings.setup_webhook` | — | `{endpoint_url, status, events[]}` | SM | audit `Webhook Changed` |
| `settings.set_webhook_status` | `status ∈ Active/Disabled` | `{status}` (unlock = `Active`) | SM | `WANotSupportedError` until A-06 |
| `settings.set_webhook_events` | `events[]` | `{events[]}` | SM | idem |
| `settings.rotate_webhook_secret` | — | `{rotated_at}` | SM | audit `Credentials Changed` |
| `settings.test_webhook` | — | `{status, http_status_code}` | SM, MGR | — |
| `settings.list_webhook_events_available` | — | `[{event_name, enabled, disabled_reason}]` | SM, MGR | — |
| `settings.list_audit_log` | `filters{action, user, from, to}, page` | `{rows, total}` | SM, MGR | — |
| `settings.list_picker_sources` | — | rows of `WhatsApp Settings Picker Source` | MGR, AGT, CU | — |
| `settings.get_doctype_fields` | `document_type` | `[{fieldname, label, fieldtype}]` for phone/name/link fields (picker source form, notification recipient selects) | MGR, SM | — |

#### 4.2 `api.home` (screen 2)

| Function | Args | Returns | P | E |
|---|---|---|---|---|
| `home.get_dashboard` | — | `{devices[{name, status, last_seen}], campaigns_sending[], queue{queued, sending, paused, held, dead_letter, paused_globally, paused_by, reason}, today{sent, delivered, failed, inbound}, plan{…cache}, webhook_status, last_webhook_event_at, setup}` | VWR+ | — |

#### 4.3 `api.devices` (screen 3)

| Function | Args | Returns | P | E |
|---|---|---|---|---|
| `devices.list_devices` | `refresh=0` | local rows (+ live merge when `refresh`) | VWR+ | — |
| `devices.create_device` | `device_name, phone=None, pairing_mode ∈ QR/Code` | `{name, platform_device, status}` | MGR | `WAInvalidPhoneError` (Code mode), `WAProviderRejectedError` (device limit), `WAProviderAuthError`; audit `Device Created` |
| `devices.start_pairing` | `device, mode` | `{mode, qr_code|pair_code, expires_at}` — from cache; never stored | MGR | `WADeviceOfflineError` (no token → provider recreates) |
| `devices.poll_status` | `device` | `{status, changed}` | MGR, AGT | — |
| `devices.disconnect_device` | `device` | `{status}` | MGR | audit `Device Disconnected` |
| `devices.delete_device` | `device, delete_remote=1` | `{deleted}` | MGR | `WAStateConflictError` if default device with others present; audit `Device Deleted` |
| `devices.update_device` | `device, device_name=None, phone=None` | row | MGR | `WANotSupportedError` until A-05 |
| `devices.set_default` | `device` | `{ok}` | MGR | — |
| `devices.set_disabled` | `device, disabled` | `{ok}` | MGR | — |
| `devices.get_device_stats` | `device, days=30` | `{sent, failed, fail_rate, outbound, inbound}` via read layer | VWR+ | — |

#### 4.4 `api.quick_send` (§3.4), `api.messages` (screens 4/5, drawer), `api.simulator` (screen 11)

| Function | Args | Returns | P | E |
|---|---|---|---|---|
| `quick_send.get_context` | `phone=None, contact=None, number=None, reference_doctype=None, reference_name=None` | `{devices[], default_device, templates[], recipient{phone_e164, display_name, contact, known, blacklisted}, policy{send_only_to_known_numbers}}` | AGT, MGR | `WAInvalidPhoneError` |
| `quick_send.preview` | `template=None, body=None, reference_doctype=None, reference_name=None` | `{body, errors[]}` | AGT, MGR | — |
| `quick_send.send` | `device, phone=None, contact=None, jid=None, message_type, body=None, template=None, attachment=None, caption=None, print_format=None, reference_doctype=None, reference_name=None, scheduled_at=None` | `{outbound, queue_item, warnings[]}` (`device_offline`, `queue_paused` are warnings — the row is queued) | AGT, MGR | `WAInvalidPhoneError`, `WABlacklistedError`, `WAUnknownNumberPolicyError`, `WAFileError`; audit `Bulk Send` only when `len(recipients) > 1` (not here) |
| `messages.get_outbound` | `name` | drawer payload: message fields + `reference{doctype, name, amount}` + timeline (queue item, webhook events) | VWR+ (Outbound read) | `WANotFoundError` |
| `messages.get_inbound` | `name` | fields + command trace + `reply_outbound` | VWR+ | idem |
| `messages.get_conversation` | `key, device=None, before=None, limit=50` | `{rows[MessageRow], has_more}` via read layer | Outbound **and** Inbound read (VWR+) | `WAPermissionError` for CU without Viewer |
| `messages.resend` | `name` | `{outbound}` new row (`source_type` copied, `attempts` 0) | AGT, MGR | terminal rows only |
| `messages.cancel` | `name, reason` | `{status}` → `queue.delete_items` | MGR | `WAStateConflictError` when `Sending` |
| `simulator.get_context` | — | `{devices[], commands[], sample_contacts[]}` | AGT, MGR | — |
| `simulator.simulate_inbound` | `device, sender_phone, text, run_commands=1` | `{inbound, command_status, reply_outbound, reply_body}` (nothing sent) | AGT, MGR | `WAInvalidPhoneError` |
| `simulator.send_test` | `device, phone, body` | `{outbound}` (`is_test=1`, job `dispatch.send_test_message`) | AGT, MGR | as `quick_send.send`; audit `Test Send` |
| `simulator.dry_run_command` | `text, sender_phone, device` | alias of `commands.test_command` | MGR | — |

#### 4.5 `api.queue` (screen 9)

| Function | Args | Returns | P | E |
|---|---|---|---|---|
| `queue.list_queue` | `filters{status, device, campaign, phone}, page, page_length` | `{rows[+position, eta], total, summary}`; position = rank over `(priority, scheduled_at, creation)` within `Queued`, ETA = position ÷ `messages_per_minute` | VWR+ | — |
| `queue.get_summary` | — | `{counts_by_status, paused, paused_by, paused_at, reason, rate, plan_rate, platform_queue (60 s cache)}` | VWR+ | — |
| `queue.pause_queue` | `reason` | `{paused_at}` | MGR | audit `Queue Paused`; realtime |
| `queue.resume_queue` | — | `{resumed_at}` | MGR | audit `Queue Resumed` |
| `queue.set_rate` | `messages_per_minute` | `{messages_per_minute}` | MGR | bounded 5–60 and ≤ `plan_messages_per_minute`; audit `Queue Rate Changed` |
| `queue.pause_items` | `names[] \| filters` | `{count}` | MGR | only `Queued`; audit `Queue Paused` with `count` |
| `queue.resume_items` | `names[] \| filters` | `{count}` | MGR | only `Paused` |
| `queue.delete_items` | `names[] \| filters, reason` | `{count}` — state `Deleted`, Outbound `Cancelled`, Campaign Recipient `Cancelled` | MGR | `WAStateConflictError` for `Sending`; audit `Queue Items Deleted` |
| `queue.retry_dead_letter` | `names[]` | `{count}` — `attempts=0`, `Queued` | MGR | audit `Queue Resumed` (Gaps G-8) |

#### 4.6 `api.campaigns` (screen 6)

| Function | Args | Returns | P | E |
|---|---|---|---|---|
| `campaigns.start` | `name` | `{status}` (`Draft/Scheduled` → `Queued`, job `campaign_runner.materialize`) | MGR | `WAStateConflictError`, `WAValidationError` (no recipients / no messages / device disabled); audit `Campaign Started` |
| `campaigns.schedule` / `unschedule` | `name, scheduled_at` / `name` | `{status}` | MGR | — |
| `campaigns.pause` / `resume` / `cancel` | `name, reason` / `name` / `name, reason` | `{status, count}` | MGR | audit `Campaign Paused/Resumed/Cancelled` |
| `campaigns.get_progress` | `name` | counters + rates + `recent[]` | VWR+ | — |
| `campaigns.get_sending_now` | — | `[{name, campaign_name, sent_count, total_recipients, started_at}]` (stats card) | VWR+ | — |
| `campaigns.get_recipients_page` | `name, filters{status, source_type, search}, page, page_length` | `{rows, total}` | VWR+ | — |
| `campaigns.preview_message` | `name, idx, recipient_row=None` | `{body, attachment_name}` | MGR | — |
| `campaigns.get_poll_results` | `name, refresh=0` | `{results}` | MGR | `WAProviderUnavailableError` |

Recipient add/remove is `api.picker.commit_*` with `target_doctype="WhatsApp Campaign"`.

#### 4.7 `api.picker` — ContactPicker sources 1–6 (§3.2)

Targets: `WhatsApp Campaign` (`recipients`) and `WhatsApp Contact Group` (`members`). P for commits = write on the target document (Campaign MGR; Group MGR/AGT/CU). Every row returned to the client carries `{phone, phone_e164, display_name, contact, source_type, source_doctype, source_name, valid, error}`.

| Function | Source | Args | Returns | P | E |
|---|---|---|---|---|---|
| `picker.list_sources` | — | `target_doctype` | `[{key, label, enabled}]` (source 3 only lists enabled Picker Sources; source 5 lists `vcf`, `csv`) | MGR, AGT, CU | — |
| `picker.search_groups` | 1 | `txt, kind=None, exclude=None, page` | `{rows[{name, kind, member_count}], total}` | idem | — |
| `picker.get_group_members` | 1 | `group, page, page_length` | rows | idem | — |
| `picker.search_contacts` | 2 | `txt, link_doctype=None, page` | rows (through `permissions.search_contacts`) | idem | — |
| `picker.list_doctype_rows` | 3 | `document_type, filters (Frappe filter list), page, page_length` | `{rows, total}` — only `name`, name field, phone field (through `permissions.list_doctype_rows`) | idem | `WAValidationError` (doctype not whitelisted / bad filter) |
| `picker.parse_upload` | 4, 5 | `file_url, kind ∈ excel/csv/vcf, mapping=None` | `{rows[], invalid[], columns[], total}` (server parse; file must be private and owned by the user; ≤ 20 000 rows, ≤ 5 MB; larger → `WAFileError`) | idem | `WAFileError` |
| `picker.parse_manual` | 6 | `text` | `{rows[], invalid[]}` (one per line, `name;phone` or `phone`) | idem | — |
| `picker.preview` | all | `target_doctype, target_name, rows[]` | `{available[], already_added[], invalid[], duplicates_in_selection[], known_count}` — compares `phone_e164` against the target child table; `known_count` from `read_layer.known_keys` | write on target | — |
| `picker.commit_add` | all | `target_doctype, target_name, rows[], source_type, source_ref=None` | `{added, skipped_duplicates, skipped_invalid}` | write on target | `WAStateConflictError` (campaign terminal); audit `Campaign Recipients Changed` / `Contact Group Members Changed` (Gaps G-2) |
| `picker.commit_remove` | all | `target_doctype, target_name, phone_e164s[] \| filters{source_type, source_ref}` | `{removed}` | write on target | idem |

#### 4.8 `api.contacts` (screen 12) and `api.numbers` (screen 13) — contextual layer

| Function | Args | Returns | P | E |
|---|---|---|---|---|
| `contacts.list_contacts` | `search, link_doctype=None, link_name=None, has_whatsapp=None, blacklisted=None, page, page_length, order_by` | `{rows[CONTACT_READ + numbers{count, last_seen, link}], total}` | CU \| Contact read | — |
| `contacts.get_contact` | `name` | `CONTACT_READ` + `phones[]` + `links[]` + `numbers[]` | idem | `WANotFoundError` |
| `contacts.create_contact` | `payload{first_name, last_name?, salutation?, designation?, company_name?, email_id?, phones[{phone, is_primary_mobile_no}], links[{link_doctype, link_name}]}` | `{name}` | CU \| Contact create | `WAInvalidPhoneError`; audit `Elevated Contact Write` |
| `contacts.update_contact` | `name, payload` (same shape, partial) | `{name, fields_written[]}` | CU \| Contact write | idem |
| `contacts.search_party` | `party_type ∈ Customer/Supplier/Employee/Sales Person, txt, page` | `[{name, title}]` | CU \| read on party type | audit `Elevated Contact Read` (CU only) |
| `contacts.toggle_blacklist` | `contact=None, phone=None, blocked, note=None` | `{blocked}` (member row in `Settings.global_blacklist_group`) | CU, AGT, MGR | `WAValidationError` when no blacklist group configured |
| `contacts.get_contact_numbers` | `contact` | `[{phone_e164, last_seen, outbound_count, inbound_count}]` | CU \| Number read | — |
| `numbers.get_number` | `phone_e164` | Number row + contact summary (`CONTACT_READ`) | VWR+, CU | `WANotFoundError` |
| `numbers.link_number` | `phone_e164, contact` | `{contact, link_status}` | CU \| Contact write | audit `Number Linked` |
| `numbers.convert_number` | `phone_e164, first_name, last_name=None, party_type=None, party_name=None` | `{contact, link_status}` — creates Contact with the number in `phone_nos`, then links | CU \| Contact create | audit `Number Converted` (target Contact) |
| `numbers.unlink_number` | `phone_e164` | `{link_status}` | MGR | audit `Number Linked` (`details.unlinked=1`) |
| `numbers.confirm_conversation` | `phone_e164, confirmed, note=None` | `{conversation_confirmed}` | AGT, MGR | audit `Conversation Confirmed` |
| `numbers.search_numbers` | `txt, link_status=None, page` | rows (QuickSend / picker helper) | VWR+, CU | — |

#### 4.9 `api.templates` (screen 10), `api.notifications`, `api.alerts` (D-016)

| Function | Args | Returns | P | E |
|---|---|---|---|---|
| `templates.preview` | `template=None, body=None, reference_doctype=None, reference_name=None, sample_context=None` | `{body, errors[]}` | AGT, MGR | — |
| `templates.list_variables` | `reference_doctype` | `[{name, label, fieldtype}]` | AGT, MGR | — |
| `templates.pick_sample` | `reference_doctype` | `{name}` latest readable record | AGT, MGR | — |
| `notifications.preview` | `name, reference_name` | `{meets_condition, message, recipients[{phone_e164 masked, source}], errors[]}` | MGR | — |
| `notifications.get_document_fields` | `document_type` | `{date_fields, datetime_fields, phone_fields, link_fields, all_fields}` | MGR | — |
| `notifications.send_now` | `name, reference_name` | `{outbounds[]}` (job) | MGR | — |
| `alerts.preview` | `name` | `{row_count, message, recipients_count, attachment_name}` (job-free; report run capped at 500 rows) | MGR | — |
| `alerts.run_now` | `name` | `{job_id}` → `alerts.run_alert` (long) | MGR | — |
| `alerts.get_report_columns` | `report, filters=None` | `[{fieldname, label, fieldtype}]` | MGR | — |
| `alerts.get_dynamic_filter_reference` | — | `[{name, example}]` helper functions of `alerts_dates` | MGR | — |

#### 4.10 `api.functions` (screen 7) and `api.commands` (screen 8)

| Function | Args | Returns | P | E |
|---|---|---|---|---|
| `functions.get_catalog` | — | `{entries[{function_key, name, category, latest_version, installed_version, update_available, handler_registered, commands_count, versions[], changelog}], catalog_source, checked_at}` | MGR, VWR (read) | — |
| `functions.preview_install` | `function_key, version=None` | `{diff{settings[], outputs[], manifest{added, removed, changed}}, commands_impacted[], handler_registered}` | MGR | `WANotFoundError` |
| `functions.install` | `function_key, version=None` | `{name, installed_version}` | MGR | `WAValidationError` (handler not registered); audit `Function Installed` |
| `functions.update` | `function_key, version=None` | `{installed_version, previous_version}` (older version allowed = rollback) | MGR | audit `Function Updated` |
| `functions.remove` | `function_key` | `{removed}` | MGR | `WAStateConflictError` (Active commands); audit `Function Removed` |
| `functions.set_status` | `function_key, status` | `{status}` | MGR | — |
| `functions.save_settings` | `function_key, values{key: value}` | `{values}` validated by `fieldtype`/`choices` | MGR | — |
| `commands.list_commands` | `filters{status, function}, page` | rows + `function_status` + 30-day `run_count` | VWR+ | — |
| `commands.get_defaults` | `function` | `{outputs[], settings[], party_types[], suggested_commands[]}` | MGR | — |
| `commands.save_command` | `payload{name?, code, title, function, synonyms, requires_linked_contact, allowed_party_types[], allowed_group, blocked_group, reply_device, settings_overrides{}, outputs[], description}` | `{name}` | MGR | `WAStateConflictError` when target is `Active`; `WAValidationError` (code/synonym collision, override key unknown); audit `Command Changed` |
| `commands.set_status` | `name, status` | `{status}` (stop/start) | MGR | — |
| `commands.restore_defaults` | `name` | `{outputs[], settings_overrides}` re-copied from Function | MGR | `WAStateConflictError` when Active; audit `Command Defaults Restored` |
| `commands.test_command` | `text, sender_phone, device=None` | `{matched, command, block_reason, args, reply_body, function_ms}` — `command_router.route(dry_run=True)` on an in-memory inbound (nothing persisted, nothing sent) | MGR | `WAInvalidPhoneError` |

#### 4.11 `webhooks.receiver.receive` — the only guest endpoint

| Item | Value |
|---|---|
| URL | `POST /api/method/whatsapp_next.webhooks.v1.receiver.receive` (architecture rule places it in `webhooks/`; fields.md's description string `api.webhook.receive` is corrected at build — Findings F-02) |
| Decorators | `@frappe.whitelist(allow_guest=True, methods=["POST"])`, `@frappe.rate_limiter.rate_limit(limit=600, seconds=60)` keyed by IP, plus a site-wide cache counter 3 000/min → 429 |
| Returns | `{ok: true}` 200 · `{ok: true, duplicate: true}` 200 · `{ok: false, error: "signature"}` 401 · `{ok:false, error:"stale"}` 401 · `{ok:false, error:"unconfigured"}` 503 · `{ok:false, error:"bad_json"}` 400 |
| Never | creates a Device, logs a payload to Error Log, returns platform data, blocks on processing |

### 5. Queue / job design

#### 5.1 Lifecycle (single writer `services/dispatch.py`)

| Step | Who | Queue Item | Outbound | Notes |
|---|---|---|---|---|
| create | `create_outbound` | — | `Unsent` | validation, blacklist (`Settings.global_blacklist_group` members by `phone_e164`), known-number policy (skipped for Campaign source), template render, contact resolve |
| enqueue | `enqueue` | insert `Queued` (`priority`, `scheduled_at`, `max_attempts` from Settings, `client_ref = outbound.name`) | `Queued`, `queued_at` | Numbers incremental upsert enqueued (non-campaign) |
| tick | `dispatch_tick` (cron `* * * * *`) | — | — | skip entirely when `Settings.queue_paused`; for each Device `status = Connected and disabled = 0` → `frappe.enqueue(dispatch_device_batch, device=…, queue="short", job_id=f"wa-dispatch-{device}", deduplicate=True, timeout=300)` |
| claim | `claim_batch(device, limit)` | `Queued → Sending`, `claimed_at`, `job_id` | `Sending` | `frappe.qb` select `for_update(skip_locked=True)` where `status='Queued' and device=… and scheduled_at <= now and (next_attempt_at is null or <= now) and (campaign is null or campaign not in paused set)` order `priority, scheduled_at, creation` limit = `min(Settings.messages_per_minute − sent_this_minute(device), 200)`; per-campaign cap `campaign.messages_per_minute` applied in Python on the claimed set (surplus rows released) |
| build | `build_messages(items)` | — | — | `NormalizedMessage` per row; attachment bytes via `attachments.attachment_ref` (pre-rendered File; PDF rendering happens at create time for Notification/Alert/Command and at materialize for Campaign — never here) |
| send | `provider.send_batch(messages, batch_id)` | — | — | one HTTP call; `batch_id = f"{device}-{uuid4().hex[:12]}"` |
| accepted | `apply_batch_result` | `Completed`, `platform_queue_id`, `completed_at` | stays `Sending` + `platform_queue_id` (status `Queued` on platform) **or** `Held` + `held_reason` (Open questions OQ-1) | `wa:queue:progress` published |
| per-message error | idem | hard (`errors.classify` non-retryable) → `Dead Letter` + reason · transient → `attempts+1`, `Queued`, `next_attempt_at = now + backoff·2^(attempts−1) ± 10 % jitter`, `last_error_code` · `attempts ≥ max_attempts` → `Dead Letter` | `Failed` + `error_code` / unchanged / `Failed` | backoff base `Settings.retry_backoff_seconds` (300 s → 5, 10, 20 min) |
| whole-call failure | idem | all claimed → `Queued`, `next_attempt_at` (+backoff), `attempts` unchanged for `AuthError`/`TransientError`/`RateLimitError(retry_after)`; `DeviceOfflineError` → also `devices.apply_state(Disconnected)` | `Queued` | `AuthError` → `Settings.connection_status = Failed` + Error Log (no payload) |
| webhook | `apply_status` | — | `Sent` / `Delivered` / `Read` / `Failed` / `Held`, timestamps | forward-only; `message.failed` after hand-over **does not** auto-retry (legacy F6 replay); user resends |
| reconcile | `reconcile.reconcile_statuses` | stale `Sending` without `platform_queue_id` (> 10 min) → `Queued` | `Sending` older than 10 min with `platform_queue_id` → `get_message_status` → `Sent`/`Failed`/`Held`; `Cancelled` → `Failed(platform_rejected)` | ≤ 200 refs per call |
| pause rows | `pause_items` | `Queued → Paused` (`paused_by/at`, reason) | unchanged | campaign pause = pause of its rows + Campaign `Paused` |
| resume rows | `resume_items` | `Paused → Queued` | unchanged | |
| delete | `delete_items` | `Queued\|Paused → Deleted` (`deleted_by/at`, reason) | `Cancelled`, `cancelled_at` | never a row removal; `Sending` refused |
| retry dead letter | `retry_dead_letter` | `Dead Letter → Queued`, `attempts = 0` | `Queued` | MGR action |
| test send | `send_test_message(outbound)` | none (bypasses queue) | `Sending → Sent/Failed` from `SendResult` | `is_test=1`, `send_message_api` (D-024); still a job (D-010) |
| purge | `retention.purge` | terminal rows older than `queue_retention_days` deleted | — | |

Global pause = `Settings.queue_paused` gate (rows stay `Queued`); Device `disabled`/not Connected = device skipped (rows stay `Queued`, UI shows "waiting for device"); campaign pause = row-level `Paused`.

#### 5.2 Jobs and scheduler entries

| Job (`whatsapp_next.services.…`) | Trigger | Queue | Dedupe / job_id | Timeout | Does |
|---|---|---|---|---|---|
| `dispatch.dispatch_tick` | cron `* * * * *` | scheduler | — | 60 s | fan-out per device |
| `dispatch.dispatch_device_batch(device)` | tick | `short` | `wa-dispatch-{device}` | 300 s | claim → send → apply |
| `dispatch.send_test_message(outbound)` | API | `short` | `wa-test-{outbound}` | 120 s | single send |
| `campaign_runner.promote_scheduled` | cron `* * * * *` | scheduler | — | 60 s | `Scheduled` with `scheduled_at <= now` → `start` |
| `campaign_runner.materialize(campaign)` | API start / promote | `long` | `wa-campaign-{name}` | 3600 s | Outbound + Queue Item bulk inserts, PDF renders, counters, `wa:campaign:status` |
| `campaign_runner.refresh_counters(campaign)` | end of each device batch touching the campaign; cron `*/5` for `Running` | `short` | `wa-camp-cnt-{name}` | 60 s | grouped count; `finalize_if_done` |
| `reconcile.reconcile_statuses` | cron `*/5 * * * *` | scheduler → `short` | `wa-reconcile` | 300 s | §5.1 reconcile |
| `webhooks.handlers.process_event(event)` | receiver | `short` | `wa-webhook-{event_id}` | 120 s | §7 |
| `webhooks.handlers.reprocess_failed` | cron `*/10 * * * *` | `short` | `wa-webhook-retry` | 300 s | `Failed` events < 3 tries |
| `inbound`→`command_router.route(inbound)` | inbound handler | `short` | `wa-cmd-{inbound}` | 120 s | §7.3 |
| `numbers_materializer.upsert_from_message(doctype, name)` | `after_insert` (enqueue_after_commit) | `short` | `wa-num-{key}` (deduplicate) | 60 s | §10 |
| `numbers_materializer.nightly_reconcile` | cron `30 2 * * *` | `long` | `wa-numbers-nightly` | 3600 s | §10 |
| `notifications.send_for_document(notification, doctype, name, event)` | doc event (enqueue_after_commit) | `short` | `wa-notif-{notification}-{name}-{event}` | 120 s | §11 |
| `notifications.trigger_daily` / `trigger_offset` | `daily` / cron `*/5 * * * *` | scheduler | — | 600 s | Days/Minutes Before/After |
| `alerts.run_due_alerts` | cron `*/15 * * * *` | scheduler | — | 60 s | select due → enqueue `run_alert` |
| `alerts.run_alert(name)` | due / API | `long` | `wa-alert-{name}` | 900 s | report → PDF → Outbound per recipient |
| `devices.sync_from_provider` | `hourly` | scheduler | — | 120 s | `list_devices` → `last_seen`, `webhook_registered`, status drift |
| `usage_sync.sync_subscription` | `hourly` + after `test_connection` | scheduler | — | 60 s | Settings cache fields |
| `webhook_setup.sync_status` | `hourly` | scheduler | — | 60 s | mirror endpoint state (D-018) |
| `functions_catalog.check_updates` | `daily` | scheduler | — | 60 s | `latest_version`, `update_available` |
| `retention.purge` | cron `0 3 * * *` | `long` | `wa-retention` | 3600 s | §12 |

All jobs `enqueue_after_commit=True` when triggered from a request; all catch `ProviderError` and never re-raise raw `requests` errors; no `frappe.db.commit()` outside job boundaries (jobs commit at end by the worker; long loops commit per batch explicitly and document it).

### 6. Realtime events

| Event | Payload (no PII) | Room | Published by |
|---|---|---|---|
| `wa:device:status` | `{device, status, previous, at, source}` | site room + `doctype/docname` room | `devices.apply_state` (`after_commit=True`) |
| `wa:message:status` | `{outbound, status, at, error_code, campaign, device}` | site room + `doctype/docname` | `dispatch.apply_status`, `send_test_message` |
| `wa:queue:progress` | `{device, queued, sending, paused, dead_letter, held, sent_last_minute, paused_globally, campaign{name, sent, total}}` | site room | `dispatch_device_batch` end (throttled ≤ 1/s per device), `pause_queue`/`resume_queue` |
| `wa:campaign:status` *(proposed, Gaps G-3)* | `{campaign, status, counters}` | `doctype/docname` | campaign_runner |
| `wa:inbound:received` *(proposed)* | `{inbound, device, key_hash}` (`sha1(phone_e164)` so an open drawer can match without a phone in the payload) | site room | `inbound.record_inbound` |
| `wa:pairing:status` *(proposed)* | `{device, mode, expires_at}` | user room of the pairing user | `devices.start_pairing` |

Frappe realtime cannot filter by role (Findings F-09); payloads carry names/counters only. Pages subscribe in `on_page_load`, unsubscribe in `on_page_hide`.

### 7. Webhook flow

#### 7.1 Receiver steps (`webhooks/v1/receiver.py`, `webhooks/verify.py`, `webhooks/idempotency.py`)

| # | Step | On failure |
|---|---|---|
| 1 | `raw = frappe.request.get_data()`; headers `X-SND-Event`, `X-SND-Event-ID`, `X-SND-Timestamp`, `X-SND-Signature` | missing id/signature → 401, nothing stored |
| 2 | `secret = Settings.get_password("webhook_secret")` | empty → 503 once-per-10-min Error Log "webhook secret not configured" |
| 3 | `verify.check(headers, raw, secret)` → `SignatureCheck`: `abs(now − int(ts)) ≤ 300` | stale → store Webhook Event `Ignored` (`timestamp_fresh=0`, payload blanked) → 401 |
| 4 | `hmac.compare_digest(HMAC-SHA256(secret, f"{ts}.{raw}").hexdigest(), sig)` | invalid → store `Ignored` (`signature_valid=0`, payload blanked) → 401; cache counter `wa:webhook:sigfail` ≥ 5 in 10 min → enqueue `webhook_setup.fetch_secret` once (PR-01) |
| 5 | `body = json.loads(raw)`; `event = provider.parse_webhook(headers, body)` | bad JSON → 400 |
| 6 | `idempotency.claim(event_id)`: `frappe.db.exists` → `duplicate_count += 1` (`update_modified=False`) → 200 duplicate; else insert Webhook Event `Received` (unique `event_id`; `DuplicateEntryError` race → treated as duplicate) | — |
| 7 | resolve `device` by `platform_device` (`WhatsApp Device.platform_device` unique) | unknown → row `Ignored`, error "unknown device" (never create, F6/R-G); `connection.*` for unknown device additionally Error Log without payload |
| 8 | store `client_ref`, `provider_message_id`, `event_timestamp`, `payload`; `Settings.webhook_last_event_at` via `set_single_value(update_modified=False)` | — |
| 9 | `frappe.enqueue("whatsapp_next.webhooks.handlers.process_event", event=row.name, queue="short", job_id=f"wa-webhook-{event_id}", deduplicate=True, enqueue_after_commit=True)` | — |
| 10 | return 200 `{ok: true}` (target < 50 ms) | — |

#### 7.2 Handlers (`webhooks/handlers.py`) — `process_event` loads the row, dispatches by `event_name`, sets `Processed`/`Failed`, `processed_at`, `processing_ms`, blanks `payload` for terminal `message.*` events

| Event | Handler | Effect |
|---|---|---|
| `message.sent` | `dispatch.apply_status(outbound, "Sent", sent_at, provider_message_id, platform_message_log)` | Outbound resolved by `client_ref` (= name) else `provider_message_id`; unresolved → `Ignored` |
| `message.delivered` / `message.read` | `apply_status("Delivered"/"Read")` | by `client_ref` (PG-03) else `provider_message_id` index |
| `message.failed` | `apply_status("Failed", error_code=errors.classify(reason))` | Queue Item untouched (already `Completed`); no auto-retry |
| `message.held` | `apply_status("Held", reason)`; `held_at` | Home/Queue banner; later `message.sent`/`failed` resolves; reconcile maps platform `Cancelled` |
| `message.reaction` | `inbound.record_reaction` | Inbound row `message_type = Reaction`, `reaction_to_provider_message_id` |
| `message.received` | `inbound.record_inbound` | §7.3 |
| `connection.connected/disconnected/logged_out` | `devices.apply_connection_event` | status machine (fields.md §3), `wa:device:status`, Audit, pairing cache cleared on connected |
| `group.updated` / `group.participants.updated` | `numbers_materializer.refresh_group_name(jid, name)` | Number row (`number_type = Group`) display name only; else no-op `Processed` |
| anything else | — | `Ignored`, payload kept until retention (forensics) |

Failure inside a handler → `Failed` + `error` (no PII) + Error Log with event name and id only; `reprocess_failed` retries 3×.

#### 7.3 Inbound message → command routing (D-012)

| # | Step | Outcome |
|---|---|---|
| 1 | `inbound.record_inbound`: dedupe `provider_message_id`; `phone = sender_mobile_no` (raw), `phone_e164 = phone.normalize(phone)`; if empty and `sender_jid` not `@lid` → digits of `sender_jid`; `is_group = chat_jid.endswith("@g.us")`; `display_name = push_name`; `contact = resolve_contact(phone_e164)`; `received_at` = provider timestamp else `X-SND-Timestamp` | Inbound row `command_status = None` |
| 2 | enqueue `numbers_materializer.upsert_from_message("WhatsApp Inbound Message", name)`; publish `wa:inbound:received` | — |
| 3 | if `Settings.enable_commands` and `message_type == Text` and (not `is_group` or text starts with a command token): enqueue `command_router.route(name)` | else stays `None` |
| 4 | `route`: `match(text)` on first token casefolded against cached `{code|synonym → command}` (`wa:commands:map`, invalidated on Command save); `*`/`?` → help | no match → `Not Matched` + `unknown_command_reply` Outbound (priority 1) when configured |
| 5 | `check_access` → `Blocked` + `block_reason` when blacklisted / not in allowed group / party type mismatch / not linked / function inactive / commands disabled | reply with a short block message only when `send_receipt_reply` is on |
| 6 | `parse_args` per manifest `inputs` (`#key=value` tokens or positional order; types `date|int|str|link`), `settings` = function settings merged with `command.settings_overrides` | `Matched`, `command_args` |
| 7 | receipt reply when `send_receipt_reply` (Outbound priority 1) | |
| 8 | `execute`: `handler = FUNCTION_HANDLERS[function_key]` (KeyError → `Failed`, `Function Inactive` style error, Error Log); `frappe.set_user(service_user)`; `handler(FunctionContext(args, settings, sender{phone_e164, contact, party}, device, inbound))` → `FunctionResult(data, files)`; `finally: frappe.set_user(previous)` | timings → Function `avg_ms`, `call_count` |
| 9 | `render_outputs`: for each Command `outputs` row whose `condition` (safe_eval over `data`) passes → `Text` → `templates.render(template, data)`; `Document` → `attachments.render_print_pdf(...)` saved as private File | `OutboundSpec` list |
| 10 | `dispatch.create_outbound` + `enqueue(priority=1)` per output (`source_type = Command Reply`, `trigger_inbound`, `command`, device = `command.reply_device or Settings.reply_device or inbound.device`) | Inbound `Executed`, `reply_outbound` (first), `replied_at` |
| 11 | exception → `Failed`, `command_error` (message class only), Function `error_count`, `last_error` | Error Log without body |

`dry_run=True` (Simulator / `test_command`) performs 4–9 on an unsaved Inbound and returns the rendered reply without creating Outbound rows unless the Simulator asked for `is_simulated` rows.

### 8. Status reconcile job — `services/reconcile.py` (cron `*/5`)

| Check | Query (qb) | Action |
|---|---|---|
| Handed-over, no webhook | Outbound `status = Sending and platform_queue_id is set and modified < now − 10 min` limit 200 | `provider.get_message_status(names)`; `Sent` → `apply_status(Sent)`, `Failed` → `Failed(classify(reason))`, `Held` → `Held`, `Cancelled` → `Failed(platform_rejected, "held expired")`, `Queued/Sending` → touch `modified` (wait); `unknown` → first time `Queued` again via new Queue Item attempt, second time `Failed(platform_rejected)` |
| Stale claims | Queue Item `status = Sending and claimed_at < now − 10 min and platform_queue_id is null` | `Queued`, `next_attempt_at = now`, `job_id` cleared; Error Log "stale claim" (names only) |
| Coherence | pairs where `(QI.status, OB.status)` not in the allowed map (fields.md §6) | fix Outbound from Queue Item; count → Error Log |
| Campaign finalisation | `Running` campaigns with no non-terminal Outbound | `campaign_runner.finalize_if_done` |
| Held expiry | `Held` older than 7 days | `get_message_status` → resolve |

### 9. Contextual permission layer — `services/permissions.py` (§4)

Declared field sets (module constants; never accepted from the client):

| Constant | Fields |
|---|---|
| `CONTACT_READ_FIELDS` | `name, first_name, last_name, full_name, salutation, designation, company_name, email_id, image, status, modified` |
| `CONTACT_PHONE_READ_FIELDS` | `phone, is_primary_mobile_no, is_primary_phone, wa_phone_e164` |
| `CONTACT_LINK_READ_FIELDS` | `link_doctype, link_name, link_title` filtered to `PARTY_TYPES = (Customer, Supplier, Employee, Sales Person)` |
| `CONTACT_WRITE_FIELDS` | `first_name, last_name, salutation, designation, company_name, email_id` |
| `CONTACT_PHONE_WRITE_FIELDS` | `phone, is_primary_mobile_no` (rows replaced as a set; `wa_phone_e164` computed) |
| `CONTACT_LINK_WRITE_FIELDS` | `link_doctype ∈ PARTY_TYPES, link_name` (existence checked with `frappe.db.exists`, no read of the party) |
| `PARTY_SEARCH_FIELDS` | `name` + title field of the party DocType only |
| `PICKER_ROW_FIELDS` | `name`, `Picker Source.name_fieldname` (or title field), `Picker Source.phone_fieldname` / linked `Contact` primary mobile |

| Function | Elevation check | Reads | Writes | Query-level filter | Audit |
|---|---|---|---|---|---|
| `can_elevate(ptype) -> bool` | `WhatsApp Contact User` in roles **or** `frappe.has_permission("Contact", ptype)` | — | — | — | — |
| `list_contacts(search, link_doctype, link_name, has_whatsapp, blacklisted, page, page_length, order_by)` | `can_elevate("read")` | READ sets + Number stats join on `Contact Phone.wa_phone_e164 = WhatsApp Number.phone_e164` | — | `search` on `full_name`/`phone`; `link_*` on `Dynamic Link`; `blacklisted` via blacklist group members; `order_by` restricted to READ fields | CU: `Elevated Contact Read` (`count`, `details.filters` keys) |
| `get_contact(name)` | idem | READ sets | — | — | CU: `Elevated Contact Read` |
| `search_contacts(txt, page)` (picker 2) | idem | `name, full_name, image` + phones | — | `txt` like on name/phone | CU: read audit (one per call) |
| `create_contact(payload)` | `can_elevate("create")` | — | WRITE sets only; `frappe.get_doc(...).insert(ignore_permissions=True)` under session user; unknown keys → `WAValidationError` | — | `Elevated Contact Write` (`fields_written`) |
| `update_contact(name, payload)` | `can_elevate("write")` | current phones for diff | WRITE sets; `save(ignore_permissions=True)` | — | idem |
| `search_party(party_type, txt, page)` | `can_elevate("read")` | `PARTY_SEARCH_FIELDS` | — | `txt` like on name/title; `disabled = 0` | CU: `Elevated Contact Read` (`details.party_type`) |
| `list_doctype_rows(document_type, filters, page, page_length)` (picker 3) | `can_elevate("read")` and `document_type` in enabled Picker Sources | `PICKER_ROW_FIELDS` | — | client filters validated against `frappe.get_meta(document_type)` fieldnames + operator allow-list (`=, !=, in, not in, like, >, <, >=, <=, between, is`), **merged with the source's server filters** (Gaps G-1); `frappe.get_all` (elevated) | `Elevated Contact Read` (`details.document_type`, `count`) |
| `contact_phones(contact) -> list[str]` (internal) | caller's context | phones | — | — | — |
| `resolve_contact_by_phone(phone_e164)` (internal, system) | none (system) | `Contact Phone.wa_phone_e164` → parent | — | exact match | — |
| `link_number(phone_e164, contact, user)` | `can_elevate("write")` | Number row | `WhatsApp Number.contact, link_status, linked_by, linked_at, display_name` (`ignore_permissions`) | — | `Number Linked` (reference Number, target Contact) |
| `convert_number(phone_e164, first_name, last_name, party_type, party_name, user)` | `can_elevate("create")` | Number row | Contact (WRITE sets + phone row from the number) then `link_number` | — | `Number Converted` + `Elevated Contact Write` |
| `toggle_blacklist(key, blocked, note, user)` | CU/AGT/MGR (Contact Group write) | blacklist group | `WhatsApp Contact Group Member` row add/remove, `note` | — | `Contact Group Members Changed` |

Blocked paths (tests assert): CU calling `frappe.client.get("Contact", …)`, `/app/contact`, `frappe.desk.reportview.get` on Contact → `PermissionError` (role holds zero rows in the Contact matrix). Every elevated write runs as `frappe.session.user`; `frappe.set_user` is never used here.

### 10. WhatsApp Numbers materialization — `services/numbers_materializer.py`

| Function | Behaviour |
|---|---|
| `refresh_keys(keys)` | For the given set of keys (E.164 or JID): `stats = read_layer.stats_by_key(keys)` (two grouped COUNT/MIN/MAX queries on indexed `phone_e164`/`jid`, joined in Python); for each key: existing row → **set** `outbound_count`, `inbound_count`, `first_seen`, `last_seen`, `last_direction`, `last_device`, `display_name` (Contact name when linked, else latest inbound push name, else unchanged), `number_type` from `phone.classify`; missing row → insert with the same values, `link_status = Linked if resolve_contact(key) else Not Linked`, `contact` auto-set only on insert (OQ-5). Writes via `frappe.db.set_value` in batches; `ignore_permissions` (no role has C/W) |
| `upsert_from_message(doctype, name)` | Reads the message row's key (`phone_e164` or `jid`/`sender_jid`) → `refresh_keys({key})`. Enqueued from `after_insert` of Outbound/Inbound with `enqueue_after_commit=True`, `job_id=f"wa-num-{sha1(key)}"`, `deduplicate=True`. Campaign materialization calls `refresh_keys(all_keys)` once instead of one job per row |
| `nightly_reconcile()` | `wm = Settings.numbers_watermark`; `upper = now_datetime()` fixed at start; for each batch from `read_layer.iter_keys_since(wm − 60 s, upper, 5000)` (keyset on `(creation, name)` across both tables via the union) → `refresh_keys(batch_keys)`; commit per batch; then `Settings.numbers_watermark = upper`, `numbers_last_run_at = now`; drift check: rows whose `contact` is set but `link_status != Linked` (fix), rows with both counters 0 (Error Log count only, never delete — spec: deletion blocked); first run with empty watermark processes everything in batches (one-time full pass, then incremental forever) |
| `refresh_group_name(jid, name)` | `display_name` on a `Group` row only |

Idempotency proof:

| Property | Mechanism |
|---|---|
| Re-running the nightly job changes nothing | Counters and timestamps are **assigned from a fresh aggregate over the source tables**, never incremented; the watermark only chooses *which keys* to visit. Same source → same values → no-op writes (`set_value` skipped when equal) |
| Overlap window (`wm − 60 s`) is harmless | Same reason: visiting a key twice recomputes the same aggregate |
| Incremental job racing the nightly job | Both call `refresh_keys`; last writer writes the same values; row-level lock on `tabWhatsApp Number` name |
| Duplicate `after_insert` jobs | `job_id` dedupe + idempotent recompute |
| Late-committed messages (creation < watermark but committed after the run) | Covered by the 60 s overlap; beyond that, the incremental job already visited the key on insert; monthly safety: `nightly_reconcile(full=True)` CLI flag |
| Test (`test_numbers_materializer.py`) | insert N messages → run nightly twice → assert table identical (row count, counters, `modified` unchanged on second run); run incremental then nightly → identical |

### 11. Notification and Notification Alert (D-016, ported with debt fixed)

| Legacy behaviour | New home | What changes |
|---|---|---|
| `doc_events["*"]` on 15 events → `run_whatsapp_notifications` | `hooks.doc_events["*"]` on `validate, on_update, on_submit, on_cancel, after_insert, on_change` (RC-04) → `services.notifications.on_doc_event` | `active_for(doctype, event)` from cache `wa:notif:{doctype}` (list of names; empty list cached too) → return in < 0.1 ms for DocTypes without notifications; `Value Change` compares `doc.get_doc_before_save()`; `Method` = doc event name matched against `method` |
| `evaluate_alert` → `frappe.throw` on template error (F2) | `evaluate(notification, doc, event)` | `condition` via `frappe.safe_eval` with `doc` context; any exception → `Notification.last_error/last_error_at` + Error Log (no doc payload) → returns False; **never** blocks the document |
| inline `send` with PDF + `commit` inside the hook (F1, D-010) | hook only enqueues `send_for_document(notification, doctype, name, event)` (`enqueue_after_commit=True`) | the job re-loads the document, re-checks the condition, renders body (`template` link preferred, inline `message` fallback — OQ-9), builds attachment (`attach_print` → `attachments.render_print_pdf`; `attach_field`), resolves recipients, `dispatch.create_outbound` + `enqueue(priority=3)` per recipient; `set_property_after_alert` applied with `frappe.db.set_value(update_modified=False)` after enqueue; `send_count`, `last_sent_at` |
| recipients: `receiver_by_document_field`, `linked_document_field`+`linked_mobile_fieldname`, `cc` | `resolve_recipients(notification, doc)` → `Document Field` (phone field or Link-to-Contact field → contact primary mobile), `Linked Document Field`, `Fixed Number` rows; row `condition` evaluated | every value through `phone.normalize`; invalid → skipped + logged on the notification |
| `trigger_daily_alerts` / `trigger_offset_alerts` (`Days/Minutes Before/After`) | `trigger_daily` (`daily`), `trigger_offset` (cron `*/5`) → `documents_due(notification)` via `frappe.get_all` on `date_changed`/`datetime_changed` with offset → enqueue `send_for_document` per doc | no `get_doc` loops before the condition; batch-limited 500 per notification per run |
| Notification Alert `scheduled_notification` (never scheduled, F11) | `alerts.run_due_alerts` cron `*/15`: `enabled = 1 and next_run_at <= now` → enqueue `run_alert(name)` (`long`) | `next_run_at` recomputed on save and after each run from `periodicity/day_of_week/day_of_month/month_of_year/notification_time` in site timezone |
| `fetch_data_and_send_message` (report → own HTML/PDF builder, 1 550 lines) | `run_alert`: `frappe.desk.query_report.run(report, filters)` with `resolve_filters` (static + `dynamic_filters_json` rendered through `alerts_dates` helpers) → `report_render.report_html(columns, rows, alert)` (Frappe print CSS + letter head) → `PDF` via `frappe.utils.pdf.get_pdf` / `PNG` via `wkhtmltoimage` when present (OQ-E) → body from `template` (context `rows, columns, report, alert, filters`) or inline `message` → one Outbound per recipient (`priority=3`, `source_type = Notification Alert`) | recipients: `User` (`User.mobile_no` normalised), `Role` (enabled users of role), `Phone`, `Report Column` (one message per distinct value, rows filtered to it) |
| `get_report_recipient_field_options`, `get_dynamic_filter_reference`, `process_dynamic_filters`, `get_users` | `api.alerts.get_report_columns`, `api.alerts.get_dynamic_filter_reference`, `alerts.resolve_filters`, `alerts.expand_recipients` | typed, MGR only |

### 12. Retention / cleanup — `services/retention.py` (cron `0 3 * * *`, `long`)

| Table | Setting (days) | Date field | Order / notes |
|---|---|---|---|
| WhatsApp Webhook Event | `webhook_event_retention_days` (30) | `received_at` | 1st; also blanks `payload` on `Processed` `message.*` rows older than 1 day |
| WhatsApp Queue Item | `queue_retention_days` (7) | `completed_at`/`deleted_at`/`modified` for terminal states | 2nd |
| WhatsApp Log | `outbound_retention_days` (365, 0 = never) | `creation` | 3rd; `ignore_links` for Inbound `reply_outbound`, Campaign Recipient `outbound_message`; attachments (private Files attached to the row) deleted with it |
| WhatsApp Inbound Message | `inbound_retention_days` (365) | `received_at` | 4th |
| WhatsApp Audit Log | `audit_retention_days` (365) | `timestamp` | last |
| pairing cache, `wa:rate:*`, `wa:commands:map` | TTL | — | cache only |

Batches of 1 000 deletes (`frappe.db.delete` with `name in (…)`), commit per batch, Audit `Retention Purge` with `count` per table and `severity Info`; Error Log never receives rows.

### 13. Hooks summary (`hooks.py`)

| Hook | Value |
|---|---|
| `whatsapp_providers` | `{"snd_platform": "…SndPlatformProvider", "meta_cloud": "…MetaCloudProvider"}` |
| `whatsapp_function_catalogs` | `["whatsapp_next.functions.catalog"]` (other apps may append) |
| `doc_events` | `"*"`: 6 events → `services.notifications.on_doc_event`; `"Contact"`: `validate` → `services.phone.sync_contact_phones` (fills `Contact Phone.wa_phone_e164`, OQ-5); `"WhatsApp Log"`/`"WhatsApp Inbound Message"`: `after_insert` → enqueue `numbers_materializer.upsert_from_message` |
| `scheduler_events` | §5.2 |
| `after_install` / `after_migrate` | `install.after_install` / `install.after_migrate` (indexes, fixtures sanity) |
| `fixtures` | `Role` (4), `Custom Field` (`Contact Phone-wa_phone_e164`), `Workspace` |
| `app_include_js` | `whatsapp_next.bundle.js` |
| `default_log_clearing_doctypes` | none (retention is Settings-driven, §12) |
| `ignore_links_on_delete` | `["WhatsApp Webhook Event", "WhatsApp Queue Item", "WhatsApp Audit Log"]` |

### 14. Porting map (legacy → new home → what changes)

| Legacy (`snd_whatsapp/…`) | New home | What changes |
|---|---|---|
| `hooks.py` `doc_events["*"]` 15 events | `hooks.py` 6 events + cache | RC-04; `autoname/onload/before_*` dropped |
| `hooks.py` 5 scheduler jobs | §5.2 | `send_message` (10 rows / 10 min, F3/R-H) → per-minute tick; `process_campaigns` → `promote_scheduled` + counters; Alert job registered (F11) |
| `hooks.py` `default_log_clearing_doctypes` | `services/retention.py` | Settings-driven per table |
| `hooks.py` `app_include_js` (errors, form timeline) | kit bundle | form-timeline injection dropped; QuickSend reachable per spec §3.4 |
| `api/whatsapp_webhook.receive` | `webhooks/receiver.py` | timestamp window (F6), event from header only, one device resolve, no device auto-create (R-G), Webhook Event row, enqueue |
| `whatsapp_webhook._verify_signature/_build_signature`, `platform_api_examples.build/verify_webhook_signature` | `webhooks/verify.py` + `provider.verify_webhook` | `compare_digest`; only `"<ts>.<raw>"` form (D-013) |
| `whatsapp_webhook._extract_event/_extract_device_id(s)/_extract_message_data/_event_payload_data/_message_id_from/_chat_target_from` (+ `webhook_logs._*` key-guessing helpers) | `providers/snd_platform.parse_webhook` | one parser, canonical `WebhookEvent`; no guessing across `data/payload/message` |
| `whatsapp_webhook._update_device_connection/_sync_local_whatsapp_device/_connection_status_from_event/_publish_connection_realtime` | `services/devices.apply_connection_event` | realtime `wa:device:status`; audit |
| `whatsapp_webhook._update_message_status/_status_from_event/_log_from_reference` | `webhooks/handlers.py` + `dispatch.apply_status` | forward-only; `failed` no longer resends; `held` = status |
| `whatsapp_webhook._clear_integration_qr_state_if_selected` | `devices.apply_state` | pairing cache cleared |
| `whatsapp_webhook._log_missing_secret_once` | `receiver` step 2 | kept (F16) |
| `api/webhook_logs.record_webhook_event/safely_record_webhook_event/_event_id` + 5 log DocTypes | `webhooks/idempotency.py` + `WhatsApp Webhook Event` | one table, unique `event_id`, `duplicate_count` |
| `api/webhook_logs._sender_number/_phone/_jid/_participant` | `services/inbound.record_inbound` | `sender_mobile_no` (D-023) + `phone.normalize`; `@lid` handled |
| `api/form_whatsapp.send_from_form` | `api.quick_send.send` (`reference_doctype/name`) | job-only; `cc/bcc/send_me_a_copy/read_receipt` dropped |
| `whatsapp_log.WhatsAppLog.after_insert` (inline send + commit, F1) | removed | D-010 |
| `whatsapp_log.claim_logs_for_sending/claim_log_for_sending/claim_and_load/_claim_is_still_ours/_dispatch_key/_mark_dispatching/is_dispatching` | `dispatch.claim_batch` | `frappe.qb … for_update(skip_locked=True)`; no `_cursor.rowcount` (R-D), no cache dispatch key |
| `whatsapp_log.requeue_stuck_sending_logs` | `reconcile.requeue_stale_claims` | 10 min, via `claimed_at` |
| `whatsapp_log.send_notification_now`, `whatsapp_chat.resend_message` | `api.messages.resend` | new Outbound row, queued |
| `whatsapp_log.add_notification_log` | `dispatch.create_outbound` + `enqueue` | validation centralised; `send_now` gone |
| `whatsapp_log.add_whatsapp_log_comment/clean_whatsapp_comment_message` | dropped | reference links on Outbound; timeline via `reference_doctype/name` filter in drawer |
| `whatsapp_log.send_message` (deferred flush) | `dispatch.dispatch_tick` | every minute, `messages_per_minute` per device |
| `whatsapp_log._normalize_mobile_for_whatsapp`, `whatsapp_chat._normalize_mobile`, `manual_whatsapp_message._normalize_mobile`, `whatsapp_campaign.normalize_recipient` (F10, R-F) | `services/phone.normalize` | one implementation, `phonenumbers`, region from Settings |
| `whatsapp_log._mark_log_failed/_mark_not_sent/_mark_handed_over` (commits) | `dispatch.apply_batch_result` | no `commit()` |
| `whatsapp_log.send()` prepare (attachment/base64/PDF/PNG) | `services/attachments.py` | rendering moved to create/materialize time; wkhtmltopdf |
| `whatsapp_log._pdf_attachment_from_log_data` (`data`, `create_pdf_from_data`) | dropped | no HTML-from-data path |
| `whatsapp_log._call_whatsapp_platform`, `page…_call_platform_method/_auth_headers/_build_url/_unwrap_platform_response/_require_credentials/_safe_platform_call` | `providers/snd_platform._request` | single transport, typed exceptions, three credentials (D-020), `ok:false` → `BusinessRejectedError` |
| `whatsapp_log._platform_devices_cache/_platform_device_candidates/_resolve_platform_device`, `whatsapp_device._resolve_platform_device_for_whatsapp_device/_platform_device_identifiers` (F9/F10) | dropped | `Device.platform_device` unique; always passed (D-013) |
| `whatsapp_log._resolve_platform_recipient/_digits_only/is_valid_whatsapp_identifier` | `phone.classify/is_valid_key` | group = JID suffix, never digit length |
| `whatsapp_log._single_page_pdf_as_image` | `attachments.pdf_first_page_png` | optional PyMuPDF (R-E) |
| `whatsapp_log._platform_send_payload/_platform_message_body/_platform_attachment_message_type/_parse_attachment_payload` | `snd_platform._message_payload(NormalizedMessage)` | keyed by `_PAYLOAD_KEYS` |
| `whatsapp_log._platform_text_only_payload/_send_platform_text_only_fallback` | dropped | no silent downgrade |
| `whatsapp_log._is_platform_device_unavailable_error` | `services/errors.classify` | code vocabulary |
| `whatsapp_log.send_whatsapp_via_platform/send_whatsapp` | `dispatch.dispatch_device_batch` | per device, per minute, backoff, dead letter |
| `whatsapp_log.reconcile_platform_queue` | `reconcile.reconcile_statuses` | + coherence + held expiry |
| `whatsapp_log.get_file_type/_mime_from_file_type` | `attachments.mime_for` | `mimetypes` |
| `whatsapp_log._parse_platform_poll_options`, `campaign._parse_poll_options`, `notification._split_poll_options`, `manual…_clean_poll_options` | `services/polls.parse_options` | one parser |
| `whatsapp_notification.WhatsAppNotification.validate*` (`validate_condition/filters/forbidden_document_types/templates/message_type`) | Notification controller `validate` | `compile_check` on body; `method` must be a doc-event name (D-012) |
| `whatsapp_notification.preview_meets_condition/preview_message/preview_subject/get_documents_for_today` | `api.notifications.preview`, `notifications.documents_due` | typed; MGR |
| `whatsapp_notification.queue_send/send/send_whatsapp/create_whatsapp_logs` | `notifications.send_for_document` | job; via dispatch |
| `whatsapp_notification.get_mobile_no/get_mobile_no_from_linked_doc/get_receiver_list/get_cc_mobile_numbers/_parse_receiver_by_document_field/_split_mobile_numbers` | `notifications.resolve_recipients` | recipient rows typed (`Fixed Number` per row, fields.md F-05) |
| `whatsapp_notification.get_attachment/get_print/get_template/load_standard_properties` | `attachments.render_print_pdf`, `WhatsApp Template` link | standard notifications loader dropped |
| `whatsapp_notification.run_whatsapp_notifications/trigger_notifications/evaluate_alert/get_context` | `notifications.on_doc_event/evaluate/context` | F2 fixed |
| `whatsapp_notification.trigger_daily_alerts/trigger_offset_alerts` | `notifications.trigger_daily/trigger_offset` | batch-limited |
| `whatsapp_notification.create_notifications/get_notification_templates/install_notification_templates/clear_notification_cache/delete_notification_folder` | `notifications.clear_cache` only | template folders dropped |
| `whatsapp_notification_alert` date helpers (`relative_date … fiscal_year_range`, 20 fns) | `services/alerts_dates.py` | same names; unit-tested |
| `whatsapp_notification_alert.get_dynamic_filter_reference/get_report_recipient_field_options/get_report_columns/process_dynamic_filters/get_users` | `api.alerts.*`, `alerts.resolve_filters/expand_recipients` | typed; MGR |
| `…alert.WhatsAppNotificationAlert.fetch_data_and_show_message/fetch_data_and_send_message` | `api.alerts.preview/run_now` → `alerts.run_alert` | job; via dispatch |
| `…alert.scheduled_notification/get_periodicity_seconds/get_now_time` | `alerts.run_due_alerts/compute_next_run` | scheduled (F11); `next_run_at` |
| `…alert.build_snd_report_print_html/get_snd_report_print_base_css/…letter_head…/sanitize_pdf_*/inline_or_strip_pdf_assets/get_local_image_data_uri/build_report_grid_html/build_report_filters_*/format_report_cell/…` (~30 fns) | `services/report_render.py` | trimmed to `report_html`/`report_pdf`; Frappe print CSS + `get_pdf` |
| `…alert.get_report_pdf`, `save_and_attach`, `utils/files.as_bytes` | `attachments.render_print_pdf/save_private_file/as_bytes` | private files |
| `…alert.split_mobile_numbers/get_user_mobile_numbers/get_mobile_no_from_report_link` | `alerts.expand_recipients` | `phone.normalize` |
| `…alert.replace_asterisks/replace_underscores/convert_newlines_to_br` | dropped | plain text body |
| `whatsapp_campaign.WhatsAppCampaign.validate/_validate_content/_validate_rate_limit/_validate_recipient_source/_normalize_recipients/_set_counts/_prevent_active_campaign_edits` | Campaign controller `validate` | multi-message (§5.4), `Paused`, state guards; recipient source fields gone |
| `whatsapp_campaign._candidate_document_names/_rule_recipients/_linked_recipient/_resolve_campaign_recipients/resolve_campaign_recipients/_parse_filters/_document_context/_document_title` (F9) | `api.picker.list_doctype_rows` → `permissions.list_doctype_rows` | one `get_all`; no Python conditions over every doc |
| `whatsapp_campaign._manual_recipient_rows/_file_recipient_rows/_recipient_rows_from_sheet/_clean_import_cell/_normalized_header/_split_mobile_numbers/_parse_receiver_field` | `picker.parse_manual/parse_excel/parse_csv` (+ new `parse_vcard`) | preview before commit; dedupe on E.164 |
| `whatsapp_campaign.load_manual_recipients/import_recipient_file/_append_manual_recipients/load_cached_recipients/_load_campaign_recipients_from_source/_campaign_source/_recipient_source_type` | `api.picker.parse_*/commit_add` | device contacts/groups source deferred (OQ-D) |
| `whatsapp_campaign.queue_campaign/_enqueue_campaign/_validate_campaign_for_queue` | `api.campaigns.start` → `campaign_runner.start/materialize` | long job; bulk inserts |
| `whatsapp_campaign.cancel_campaign` | `campaign_runner.cancel` | open Queue Items → `Deleted`, Outbound `Cancelled` |
| `whatsapp_campaign._recipient_context/_render_recipient_message/_render_recipient_poll/_create_log` | `campaign_runner.materialize` | pre-render per recipient × message |
| `whatsapp_campaign.execute_campaign/_execute_campaign/_campaign_batch_size/_campaign_batch_is_due/dispatch_campaign_batch` (filelock) | dispatcher pacing (§5.1) | no second loop; campaign rate cap in `claim_batch` |
| `whatsapp_campaign.refresh_campaign_status`, `process_campaigns` | `campaign_runner.refresh_counters/finalize_if_done/promote_scheduled` | grouped count, no per-minute UPDATE-JOINs |
| `whatsapp_campaign._fetch_platform_poll_results/get_campaign_poll_results/_extract_selected_poll_options/_poll_*` | `polls.fetch_results/extract_selected`, `api.campaigns.get_poll_results` | one parser |
| `whatsapp_campaign._device_identifiers`, `_invalid_recipient`, `_recipient_type_from_value`, `_plain_message` | dropped / `phone.classify` | |
| root `snd_whatsapp/whatsapp_campaign.py/.js` (stray) | dropped | |
| `whatsapp_command.WhatsAppCommand.validate` | Command controller | casefold, synonyms unique, edit lock while Active (§5.5) |
| `whatsapp_command.handle_received_message` (after_insert hook) | `inbound.record_inbound` → enqueue `command_router.route` | never inline |
| `whatsapp_command.process_received_message` (`set_user("Administrator")`, F5/R-B) | `command_router.route` | service user, registry, `finally` restore |
| `whatsapp_command._execute_api` (`frappe.get_attr(method)`) | `command_router.execute` | `FUNCTION_HANDLERS[function_key]` only |
| `whatsapp_command._command_apis/_api_parameters/_combined_parameters` | manifest `inputs` | from Function `manifest` |
| `whatsapp_command._parse_user_filters/_coerce_filter_value/_parse_command_date/_command_parts/_normalize_code/_is_help_request` | `command_router.parse_args/match` | typed by manifest |
| `whatsapp_command._command_help/_parameter_placeholder/_example_filter_value/translate` | `command_router.help_text` | `_()` |
| `whatsapp_command._render/_render_filters/_failure_message` | `templates.render`; filters from manifest only | no user Jinja in filters |
| `whatsapp_command._send_text/_send_document` | `command_router.render_outputs` → `dispatch` | Command `outputs` rows |
| `whatsapp_command._settings/_reply_device/_find_command_name/_mark_received/_is_text_message/_is_group_chat/_not_found_reply_applies` | `command_router` internals | cache map |
| `whatsapp_command._sender_identifier/_reply_identifier/_identifier_digits/_identifiers_match/_sender_is_allowed/_validate_contact_lists` (last-9-digit match) | `command_router.check_access` | exact `phone_e164` in Contact Group |
| `WhatsApp API` DocType + `page/whatsapp_apis._registry/_app_manifests/_payload_from_manifest/_sorted_versions/_version_tuple` | `WhatsApp Function` + `functions_catalog.load_catalog/sort_versions` | manifest → `settings/outputs/manifest`; `method` dotted path → `function_key` |
| `whatsapp_apis.get_library/_library_row/_publishing_apps/_installed_by_key/_usage/_counts` | `api.functions.get_catalog` | |
| `whatsapp_apis.install_api/update_api/rollback_api/uninstall_api/get_version/_apply_version/_version_payload/_entry` | `api.functions.install/update/remove/preview_install` | rollback = update to an older catalog version; diff-before-update |
| `whatsapp_apis.detach_api/save_api/delete_api/_custom_apis`, `whatsapp_commands.save_api/delete_api/_apis_payload` | dropped | D-012: no hand-written executable functions |
| `whatsapp_commands.get_console/_commands_payload/_child_rows/_devices/_print_formats/_stats/_contact_rows` | `api.commands.list_commands` + Frappe list | |
| `whatsapp_commands.save_settings/_settings_payload` | `api.settings.save_settings(section="commands")` | SM |
| `whatsapp_commands.save_command/_set_contact_table/_rename_if_title_changed` | `api.commands.save_command` | groups instead of contact tables; rename via `field:code` |
| `whatsapp_commands.toggle_command/delete_command` | `api.commands.set_status`; Desk delete (Inactive only) | |
| `whatsapp_commands.test_command` (broken `_tag_log`, F11) | `api.commands.test_command` → `route(dry_run=True)` | fixed |
| `whatsapp_device.WhatsAppDevice.validate/after_insert/create_on_platform`, `create_platform_device_for_doc/_create_platform_device_for_doc` | `api.devices.create_device` → `devices.create` | platform first, then local row |
| `whatsapp_device.get_qr_via_server/get_pair_code_via_server/_extract_qr_code/_extract_pair_code` | `api.devices.start_pairing` → `devices.start_pairing` | cache 60 s; never stored (F7) |
| `whatsapp_device.get_groups_via_server/_normalize_groups_for_dialog` | `provider.list_device_groups` (picker source deferred, OQ-D) | |
| `whatsapp_device._find_whatsapp_device_doc/_get_platform_devices/_platform_device_name/_update_local_platform_device_id/_extract_platform_device_name/_short_response/_extract_first_text` | dropped / `devices.sync_from_provider` | |
| `whatsapp_device._raise_client_error/_friendly_platform_error/_clean_error_message`, `utils/error_handler.*` (Arabic hardcoded) | `api/_common.py` + `exceptions.py` + `services/errors.py` | `_()`; codes via `exc_type` |
| `WhatsApp Platform Settings` (+ whitelist/blacklist children) | `WhatsApp Settings` | Password + permlevel 1 (D-014), Contact Group links |
| `WhatsApp Platform Contact/Group` + `page…_stored_contacts/_stored_groups/_directory_counts/_stored_directory_page/_directory_row/_extract_records/_replace_device_contacts/_replace_device_groups/get_device_directory_page/list_device_contacts/list_device_groups/_require_directory_permission/_ensure_connected_directory_device` | dropped; `WhatsApp Number` + live `provider.list_device_contacts/groups` | no cache tables, no raw SQL (F8/F9) |
| `page/whatsapp_platform_integration.get_page_data/get_dashboard/get_device_statuses` | `api.home.get_dashboard`, `api.settings.get_settings`, `api.devices.list_devices` | |
| `…save_settings/_settings_payload/_public_settings_payload/_mask_secret/_ensure_settings_doc/_normalize_api_prefix/_get_api_secret/get_webhook_secret` | `api.settings.save_settings/get_settings`; `providers.registry` credential accessor | `has_*` booleans; `api_prefix` dropped (full base URL) |
| `…create_device/request_device_qr/request_device_pair_code/verify_device_connection/disconnect_device/delete_device/_sync_local_device(s)_from_platform/_connection_status_from_platform_status/_is_connected_status` | `api.devices.*`, `devices.sync_from_provider/apply_state` | |
| `…send_test_message` | `api.simulator.send_test` | job; `is_test` |
| `…create_webhook_endpoint/sync_webhook_secret/fetch_webhook_secret_from_platform/_store_webhook_secret/_configure_platform_connection_webhook/_default_webhook_url/delete_webhook_event_endpoint/test_webhook_endpoint/delete_webhook_endpoint/_default_available_webhook_events/_normalize_available_webhook_events/_enabled_webhook_event_names` | `services/webhook_setup.py`, `api.settings.setup_webhook/test_webhook/set_webhook_status/set_webhook_events/rotate_webhook_secret/list_webhook_events_available` | `set_password`; D-018 states; audit |
| `…_phone_from_jid/_clean_group_id/_field_value/_parse_json/_json_dump` | `phone.classify`; dropped | |
| `page/whatsapp_integration`, `page/new_desgin` | dropped | Home + Settings pages |
| `page/whatsapp_chat.get_bootstrap/get_messages/_get_chat_messages/_get_recent_chats/_whatsapp_log_fields/_get_contact_suggestions/_get_whatsapp_contact_suggestions` (1 200-row scan, F4/F9) | `api.messages.get_conversation` via `read_layer.conversation` (indexed), `api.numbers.search_numbers` | inbound included |
| `whatsapp_chat.send_message` | `api.quick_send.send` | |
| `whatsapp_chat._get_direct_api_client/_get_platform_api_client/_get_integration_doc/_extract_device_token/_get_platform_chat_messages/_get_direct_chat_messages/_normalize_direct_message/_direct_message_text/_get_platform_groups/_get_selected_device_id`, `platform_api_examples.PlatformApiClient` (dead, F11) | dropped | |
| `whatsapp_chat._chat_kind/_display_label/_chat_jid/_digits_from_jid/_normalize_timestamp/_string_value/_extract_payload_items/_require_permission/_get_devices/_get_device_doc/_contact_suggestions_limit` | dropped / `phone.classify` | |
| `page/manual_whatsapp_message.get_compose_context/_can_read/_can_see_groups` | `api.quick_send.get_context` | |
| `manual_whatsapp_message.search_recipients/_contact_phone_numbers/get_contact_mobile/_resolve_recipient` | `api.picker.search_contacts/search_groups`, `api.numbers.search_numbers`, `permissions.contact_phones` | contextual layer |
| `manual_whatsapp_message.send_manual_message/_validate_message` | `api.quick_send.send` + schema validation | |
| `utils/permissions.has_any_role/require_any_role/require_whatsapp_manager/require_system_manager/require_whatsapp_sender/require_device_connector/require_group_viewer/require_doc_permission` | `api/_common.api_endpoint(roles=…)` + `frappe.has_permission` | five legacy roles → four (conventions) |
| `utils/error_handler.clean_error_message/format_client_error/log_and_throw/handle_whitelisted_error/error_response/…` | `api/_common.py` error mapping | no Arabic literals in Python |
| `snd_pdf.get_print_html/get_html/download_pdf/sanitize_weasyprint_html/resolve_letterhead/extract_repeat_sections/site_url_fetcher/import_weasyprint` (WeasyPrint, F14/R-E) | `attachments.render_print_pdf` (`frappe.get_print(as_pdf=True)`) | WeasyPrint dropped (Open questions OQ-2) |
| `patches/v1_0/*` (renames, backfills, fetch secret) | dropped (D-017); new `patches/v0_1/add_indexes.py` | |
| `public/js/form_whatsapp_timeline.js`, `snd_whatsapp_errors.js` | kit `QuickSend`, `Toast` + `exc_type` map (phase 6) | |
| Workspace `WhatsApp`, 6 number cards, 3 admin pages | Home page (2) + Settings page (15) + minimal workspace fixture | |
| Legacy tests (`test_whatsapp_campaign/command/log`) | `tests/` (§15) | rewritten against new services; scenarios kept (claim, dedupe, rate, command parsing) |

### 15. Build order (feeds phases 3–7)

| # | Phase | Step | Depends on | Tests added |
|---|---|---|---|---|
| 1 | 3 | App skeleton: folders of §1, `hooks.py` (providers, scheduler, doc_events stubs, fixtures), `install.py`, `pyproject` deps (`openpyxl`, `vobject`; `phonenumbers` from Frappe), ruff | — | `tests/conftest_frappe.py`, smoke import test |
| 2 | 3 | `exceptions.py`, `services/errors.py`, `api/_common.py` decorator | 1 | `test_errors.py`, `test_api_common.py` |
| 3 | 3 | `services/phone.py` (region param; Settings lookup lazy) | 1 | `test_phone.py` (table-driven: SA/YE/EG/AE, `00`, `0`, spaces, JIDs, invalid) |
| 4 | 3 | DocTypes in RC-01 order (Settings+Picker Source → Device → Template → Outbound → Inbound → Webhook Event → Queue Item → Number → Audit Log → Contact Group(+Member) → Campaign(+2) → Function(+2) → Command(+1) → Notification(+1) → Alert(+1)); thin controllers; status-writer guard; `patches/v0_1/add_indexes.py`; fixtures (roles, `Contact Phone.wa_phone_e164`, Contact validate hook) | 3 | `doctype/<dt>/test_<dt>.py` per DocType (permission matrix per role, phone pair, status guard), `test_fields.py` (meta = fields.md), `test_indexes.py` |
| 5 | 3 | `services/audit.py` | 4 | `test_audit.py` (real user, masking, secret filter) |
| 6 | 3 | `providers/`: schemas, exceptions, base, registry, `snd_platform`, `meta_cloud` skeleton, `tests/fake_provider.py` | 2, 4 | `test_providers_base.py` (contract), `test_snd_platform.py` (headers D-020, error mapping incl. 200 `ok:false`, 417, batch > 200, `parse_webhook` on `tests/fixtures/webhooks/*.json`), `test_registry.py` |
| 7 | 4 | `services/read_layer.py` (+ decision entry for the UNION) | 4 | `test_read_layer.py` (order, direction, keyset batches, stats) |
| 8 | 4 | `services/permissions.py` (contextual layer) | 4, 5 | `test_permissions_contextual.py` (CU blocked on `/app/contact` + client APIs; field sets; audit rows; query filters) |
| 9 | 4 | `services/templates.py`, `attachments.py`, `polls.py` | 4 | `test_templates.py`, `test_attachments.py` |
| 10 | 4 | `services/dispatch.py`, `services/reconcile.py`, `services/quick_send.py` | 5, 6, 9 | `test_queue.py` (state machine, pause/resume/delete-as-state, dead letter, backoff), `test_dispatch.py` (claim skip-locked under two workers, batch mapping, held), `test_reconcile.py` |
| 11 | 4 | `services/devices.py` (+ pairing cache) | 5, 6 | `test_devices.py` (status machine, cache TTL, never persisted) |
| 12 | 4 | `webhooks/` (receiver, verify, idempotency, handlers), `services/inbound.py` | 6, 10, 11 | `test_webhook.py` (signature, stale, idempotency race, rate limit, unknown device, guest-only), `test_inbound.py` (sender mobile/LID, contact link) |
| 13 | 4 | `services/numbers_materializer.py` | 7 | `test_numbers_materializer.py` (watermark, idempotent re-run, incremental vs nightly equality, group rows) |
| 14 | 4 | `functions/registry.py`, `functions/catalog/v1/catalog.json`, `services/functions_catalog.py`, `services/command_router.py`, `services/simulator.py` | 9, 10, 12 | `test_functions_catalog.py` (versions, diff, install/update/remove), `test_command_router.py` (match, access order, args, service user restore, dry run, no `get_attr`) |
| 15 | 4 | `services/campaign_runner.py`, `services/picker.py` | 8, 10, 13 | `test_campaign_runner.py` (materialize multi-message, pacing cap, counters, pause/cancel), `test_picker.py` (six sources, E.164 dedupe, add/remove, Excel/CSV/vCard fixtures) |
| 16 | 4 | `services/notifications.py`, `alerts.py`, `alerts_dates.py`, `report_render.py`, hooks `doc_events` | 9, 10 | `test_notifications.py` (cache, never blocks save, recipients, daily/offset), `test_alerts.py` (next_run, recipients, report column), `test_alerts_dates.py` |
| 17 | 4 | `services/webhook_setup.py`, `usage_sync.py`, `retention.py`; final `scheduler_events` | 6, 11 | `test_webhook_setup.py`, `test_retention.py` (order, links, audit count), `test_scheduler_registration.py` |
| 18 | 5 | `api/settings.py`, `api/onboarding.py`, `api/home.py` | 17 | `test_api_settings.py` (SM-only writes, secrets never returned) |
| 19 | 5 | `api/devices.py` | 11 | `test_api_devices.py` |
| 20 | 5 | `api/quick_send.py`, `api/messages.py`, `api/simulator.py` | 10, 14 | `test_api_messages.py` |
| 21 | 5 | `api/queue.py` | 10 | `test_api_queue.py` (MGR-only writes, position/ETA) |
| 22 | 5 | `api/numbers.py`, `api/contacts.py` | 8, 13 | `test_api_contacts.py` (per-role matrix) |
| 23 | 5 | `api/picker.py` | 15 | `test_api_picker.py` |
| 24 | 5 | `api/campaigns.py` | 15 | `test_api_campaigns.py` |
| 25 | 5 | `api/templates.py`, `api/notifications.py`, `api/alerts.py` | 16 | `test_api_templates.py` |
| 26 | 5 | `api/functions.py`, `api/commands.py` | 14 | `test_api_functions.py`, `test_api_commands.py` |
| 27 | 5 | `webhooks.receiver` wired as the only guest endpoint; `tests/test_guest_surface.py` asserts no other `allow_guest` | 12 | idem |
| 28 | 6 | UI kit consumes: `api.picker.*`, `messages.get_conversation`, `quick_send.*`, `campaigns.get_sending_now`, `settings.get_doctype_fields` | 18–26 | phase 6 |
| 29 | 7 | Pages consume: Home → `home`; Devices → `devices`; Functions Center → `functions`; Simulator → `simulator`, `commands.test_command`; Contacts → `contacts`, `numbers`; Settings → `settings`, `onboarding`; Onboarding → `onboarding` | 18–27 | phase 7 |

---

## Findings

| # | Finding | Consequence |
|---|---|---|
| F-01 | `fields.md` Outbound machine says `Sending →(batch accepted) Sent`, but `sent_at` is defined as "`message.sent`" and the platform's accepted status is `Queued` (its own queue) | Plan keeps Outbound `Sending` after hand-over and sets `Sent` on `message.sent` / reconcile; Queue Item `Completed` at hand-over. Open questions OQ-1 |
| F-02 | `fields.md` describes the receiver URL as `whatsapp_next.api.webhook.receive`; `architecture.md` places the guest endpoint in `webhooks/receiver.py` | URL `…whatsapp_next.webhooks.receiver.receive`; the field description is corrected in phase 3 |
| F-03 | `frappe.qb` union (`q1 + q2`) returns a pypika `_SetOperation` without Frappe's `.run()` | `read_layer` executes `frappe.db.sql(str(union))` — the single documented `frappe.db.sql` exception (decision entry at build) |
| F-04 | `frappe.qb … .for_update(skip_locked=True)` exists on Frappe 16 | Atomic claim needs no raw SQL and no `frappe.db._cursor.rowcount` (legacy R-D) |
| F-05 | Platform `enqueue_batch` keeps only `_PAYLOAD_KEYS` + `client_ref/device/priority/source_*`; no `scheduled_at`, no per-message metadata | Scheduling is client-side only (`Queue Item.scheduled_at`); nothing else is forwarded |
| F-06 | `get_message_status_api` reports platform queue states (`Queued/Sending/Sent/Failed/Held/Cancelled`) only | Reconcile can lift to `Sent/Failed/Held`; `Delivered/Read` come only from webhooks (correlated by `client_ref` after platform PG-03) |
| F-07 | Numbers counters computed by **set-from-aggregate** rather than increment | Idempotency by construction; watermark selects keys only (§10) |
| F-08 | Picker source 3 reads with `frappe.get_all` (elevated) — spec condition 2 needs a server-side restriction per source | Gap G-1: `filters_json` on `WhatsApp Settings Picker Source` |
| F-09 | Frappe realtime cannot target roles | Site-room publish with non-PII payloads; document rooms for forms |
| F-10 | `doc_events["*"]` on 6 events runs on every save of every DocType | Per-DocType cache of active notification names; empty list short-circuits |
| F-11 | Legacy matched senders on the last 9 digits | Exact `phone_e164` membership; LID senders can never match a phone-based list |
| F-12 | Legacy scanned every installed app for `whatsapp_command/vN/apis.json`; no such folder exists in the legacy tree today | Catalog ships inside `whatsapp_next/functions/catalog/v1/`; other apps via `whatsapp_function_catalogs` hook |
| F-13 | Test send must be a job (D-010) even though it is single-message (D-024) | Simulator waits on `wa:message:status` |
| F-14 | `frappe.set_user(service_user)` is only safe inside a job | `command_router.route` refuses to run in a request; `test_command` dry-run runs as the caller without impersonation and without executing writes |
| F-15 | Settings secrets at permlevel 1 return masked values to `frappe.get_single` for MGR | One accessor in `providers/registry` using `get_password`; tests assert MGR sessions never see plaintext |
| F-16 | Platform `strict_client_ref` (fields-platform §7) turns re-enqueue of the same Outbound into `CLIENT_REF_DUPLICATE` | Dead-letter retry and `unknown` re-queue create a **new** Outbound row (copy) rather than reusing the name; original marked `Cancelled` with `details.retried_as` |

## Gaps

| # | Gap | Proposed home |
|---|---|---|
| G-1 | Server-side mandatory filters for picker source 3 | Additive child field `WhatsApp Settings Picker Source.filters_json` (Code JSON, admin-only) merged into every query |
| G-2 | Audit actions missing for group membership and connection test | Additive Select options `Contact Group Members Changed`, `Connection Tested` on `WhatsApp Audit Log.action` |
| G-3 | Realtime for inbound/campaign/pairing/import | Proposed events in §6 (`wa:inbound:received`, `wa:campaign:status`, `wa:pairing:status`, `wa:import:progress`) |
| G-4 | Outbound `error_code` vocabulary lacks client-side rejections | `invalid_phone`, `blacklisted`, `unknown_number_policy` (Data field — no schema change) |
| G-5 | vCard / Excel parsing libraries | `vobject`, `openpyxl` in `pyproject.toml` |
| G-6 | Platform additive endpoints A-01..A-11 not yet live | Provider raises `NotSupportedError`; API returns `WANotSupportedError`; UI hides the action |
| G-7 | Onboarding: `complete_signup` returns link `api_key/api_secret` but not the platform Frappe user token (`customer_api_key`, PR-02) | Open questions OQ-6 |
| G-8 | Audit action for dead-letter retry | Reuse `Queue Resumed` with `details.retry=1` or add `Queue Items Retried` |
| G-9 | Notification for `Value Change` needs `doc_before_save` — unavailable on `after_insert` | Evaluate `Value Change` only on `on_update`/`on_change` |
| G-10 | Campaign per-recipient `Document` messages need a `source_doctype/source_name` on the recipient row | Picker source 3 fills it; other sources cannot use Document messages (validation on start) |

## Risks

| # | Risk | Mitigation |
|---|---|---|
| R-1 | Worker dies after `send_batch` succeeded but before local commit → resend on next tick | `strict_client_ref=1` on the platform link rejects the duplicate with `CLIENT_REF_DUPLICATE`; `apply_batch_result` treats that error as "accepted earlier" and asks `get_message_status` |
| R-2 | PDF rendering inside the `short` queue exceeds timeouts | Rendering only at create/materialize time (`long` for campaigns/alerts); dispatch reads Files |
| R-3 | 10k-recipient campaign enqueues 10k Numbers jobs | `materialize` calls `refresh_keys(all_keys)` once; per-message job only for non-campaign sources |
| R-4 | Realtime storm during campaigns | `wa:queue:progress` throttled per device (cache key, ≤ 1/s); message ticks only for non-campaign rows |
| R-5 | `set_user` leakage across jobs | `try/finally`; test asserts `frappe.session.user` restored after handler exception |
| R-6 | Webhook bursts (platform redelivery F-20) | idempotency row + `deduplicate` job id; receiver does no processing |
| R-7 | Python 3.14 wheels for PyMuPDF / vobject | PyMuPDF optional (PNG skipped when missing); vobject pure-Python |
| R-8 | Two workers claim overlapping rows | `for_update(skip_locked=True)` + test with two threads on separate connections |
| R-9 | Read-layer UNION grows with tables | Both branches filtered by indexed key + limit before the union; keyset pagination |
| R-10 | Site-room realtime leaks activity metadata to non-WhatsApp users | Payloads carry names/counters only; pages ignore events without role; acceptable per security baseline (no PII) |
| R-11 | `doc_events["*"]` + Contact `validate` hook add latency to every save | Cache short-circuit; Contact hook normalises only changed phone rows |

## Recommendations

| # | Recommendation |
|---|---|
| RC-1 | Record at build start: D-025 "read_layer executes one qb-built UNION via `frappe.db.sql`"; D-026 "Outbound stays `Sending` after hand-over until `message.sent`" (if OQ-1 confirms); D-027 "no automatic resend after `message.failed`" |
| RC-2 | Ship `tests/fake_provider.py` with scripted responses (accepted/held/error/transient) and use it in every service test; the contract test runs against `FakeProvider`, `SndPlatformProvider` (mocked HTTP) and `MetaCloudProvider` |
| RC-3 | Set on the platform link before phase 4 testing: `require_api_secret=1`, `allow_device_fallback=0`, `strict_client_ref=1` (fields-platform step 7) |
| RC-4 | Implement `api/_common.api_endpoint` first (step 2) and forbid bare `@frappe.whitelist` in `api/` via a test that scans the package |
| RC-5 | Keep `tests/fixtures/webhooks/*.json` in sync with `fields-platform.md` R-3 payload contract; one file per event |
| RC-6 | `add_indexes.py` also runs from `after_migrate` (fields.md F-11) and is asserted by `test_indexes.py` |

## Open questions

| # | Question | Blocks | Proposed default |
|---|---|---|---|
| OQ-1 | Outbound status at hand-over: stay `Sending` until `message.sent` (this plan) or `Sent` on batch accept (fields.md machine)? | Outbound list semantics, `sent_at` | `Sending` until `message.sent`; reconcile lifts after 10 min |
| OQ-2 | PDF engine: bench `wkhtmltopdf` via `frappe.get_print` (this plan) or keep the legacy WeasyPrint renderer (`snd_pdf.py`, undeclared dependency, Python 3.14 wheels)? | attachments, alerts | wkhtmltopdf; WeasyPrint only if the owner needs its print fidelity |
| OQ-3 | Audit `Elevated Contact Read` for every CU list call (volume 10k–100k/yr) or only writes? | audit volume | one row per call for CU only |
| OQ-4 | `message.failed` after hand-over: no automatic resend (this plan) vs one automatic retry | queue semantics | no auto-resend |
| OQ-5 | Conversation drawer for `WhatsApp Contact User` without Viewer role: deny or grant read on both message tables? | Contacts page | deny; owner grants Viewer when needed |
| OQ-6 | Onboarding sign-up: how does the site obtain the platform Frappe user token (`customer_api_key`) — returned by `complete_signup` (platform change) or entered manually? | screen 1 | request platform to return it once in `complete_signup`; manual entry fallback |
| OQ-7 | Nightly Numbers job time (`02:30`) and retention purge (`03:00`) in site timezone acceptable? | scheduler | yes |
| OQ-8 | Simulator inbound "on behalf": run real command handlers (side effects in ERPNext) or always dry-run? | Simulator | dry-run by default; `run_commands=1` executes read-only handlers only (registry flag `read_only`) |

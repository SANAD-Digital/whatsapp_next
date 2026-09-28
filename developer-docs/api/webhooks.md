# Inbound webhooks (`webhooks.v1.receiver.receive`)

Module: `whatsapp_next/webhooks/v1/receiver.py` — the **only guest endpoint** of the app. The SND
WhatsApp Platform posts delivery statuses, inbound messages and connection changes here. The
receiver authenticates the delivery, stores exactly one `WhatsApp Webhook Event` per
`(event_name, event_id)`, resolves the local device (never creates one) and hands processing to a
background job; it runs no business logic itself.

Related code: `webhooks/verify.py` (signature + freshness), `webhooks/idempotency.py`
(exactly-once intake), `webhooks/handlers.py` (processing), and the provider adapter
`providers/snd_platform.py` (header names, signing rule, payload parsing). Registering this URL
on the platform, subscribing events and rotating the secret are done from Settings
(`settings.*` endpoints, `services/webhook_setup.py`); the common API conventions are in
[README.md](README.md).

## Endpoint

| | |
|---|---|
| URL | `POST https://<site>/api/method/whatsapp_next.webhooks.v1.receiver.receive` |
| Method | POST only |
| Auth | Guest (`allow_guest=True`); authenticated by HMAC signature, not by a Frappe session or token |
| Body | The raw JSON event object (the signature covers the exact bytes) |
| Rate limit | 600 requests per minute per source IP (a constant) |

The response is Frappe's usual envelope: the body below sits under `message`, and the HTTP status
is set explicitly.

## Headers

Header names are case-insensitive.

| Header | Required | Meaning |
|---|---|---|
| `X-SND-Event` | recommended | Event name, e.g. `message.delivered`. Falls back to the body's `event`. |
| `X-SND-Event-ID` | **yes** | Event id. Without it the delivery is refused (401) and not stored. |
| `X-SND-Timestamp` | **yes** | Unix time in seconds (an integer; a float is accepted) when the platform signed. |
| `X-SND-Signature` | **yes** | Lower-case hex `HMAC-SHA256(secret, "<timestamp>.<raw body>")`. |
| `Content-Type` | — | `application/json`. |

## Signature and time window

```
signature = hex( HMAC_SHA256( key = webhook_secret,
                              msg = X-SND-Timestamp + "." + raw_request_body ) )
```

- `webhook_secret` is the platform-issued secret stored (encrypted) in **WhatsApp Settings →
  Webhook Secret**; the site fetches it from the platform, it is never typed in.
- The body is the exact bytes received (decoded as UTF-8), not a re-serialised JSON.
- The comparison is constant-time (`hmac.compare_digest`) against the header value, stripped and
  lower-cased.
- **Freshness:** `|now − X-SND-Timestamp| ≤ 300 s` (`MAX_SKEW_SECONDS`). A correctly signed but
  stale delivery is refused as `stale timestamp`.
- Five invalid signatures within 10 minutes enqueue one `webhook_setup.fetch_secret` job (the
  platform may have rotated the secret).

### Verifying (or producing) a signature in Python

```python
import hashlib
import hmac
import json
import time

import requests

SECRET = "<webhook secret>"  # WhatsApp Settings -> Webhook Secret
URL = "https://erp.example.com/api/method/whatsapp_next.webhooks.v1.receiver.receive"


def sign(secret: str, timestamp: str, raw_body: bytes) -> str:
    """The platform's rule: hex(HMAC-SHA256(secret, f"{timestamp}.{raw_body}"))."""
    msg = f"{timestamp}.{raw_body.decode('utf-8')}".encode()
    return hmac.new(secret.encode("utf-8"), msg, hashlib.sha256).hexdigest()


def verify(secret: str, headers: dict, raw_body: bytes, max_skew: int = 300) -> bool:
    """What the receiver checks: a valid signature and a fresh timestamp."""
    h = {k.lower(): v for k, v in headers.items()}
    ts, sig = h.get("x-snd-timestamp", ""), h.get("x-snd-signature", "")
    if not ts or not sig:
        return False
    fresh = abs(int(time.time()) - int(float(ts))) <= max_skew
    return fresh and hmac.compare_digest(sign(secret, ts, raw_body), sig.strip().lower())


# Replaying a fixture against a dev site
body = json.dumps({"event": "message.delivered", "event_id": "3EB0SENT0001", "device": "WAD-TEST-WH01",
                   "client_ref": "a1b2c3d4e5", "provider_message_id": "3EB0SENT0001"},
                  ensure_ascii=False).encode("utf-8")
ts = str(int(time.time()))
headers = {
    "Content-Type": "application/json",
    "X-SND-Event": "message.delivered",
    "X-SND-Event-ID": "3EB0SENT0001",
    "X-SND-Timestamp": ts,
    "X-SND-Signature": sign(SECRET, ts, body),
}
assert verify(SECRET, headers, body)
r = requests.post(URL, data=body, headers=headers, timeout=10)
print(r.status_code, r.json())  # 200 {'message': {'ok': True}}
```

Send the **same bytes** you signed (`data=body`, not `json=`).

## Processing steps and response codes

| Step | Condition | HTTP | Body (`message`) | Stored? |
|---|---|---|---|---|
| 1 | No event id header, or no signature header | 401 | `{"ok": false, "error": "missing headers"}` | no |
| 1b | More than 600 requests this minute from the IP | 429 | `{"ok": false, "error": "rate limited"}` | no |
| 2 | No webhook secret in Settings (logged once per 10 min) | 503 | `{"ok": false, "error": "webhook secret not configured"}` | no |
| 3–4 | Signature wrong, or timestamp missing / unparseable | 401 | `{"ok": false, "error": "invalid signature"}` | `Ignored`, payload blanked |
| 3–4 | Signature right, timestamp outside ±300 s | 401 | `{"ok": false, "error": "stale timestamp"}` | `Ignored`, payload blanked |
| 5 | Body is not UTF-8 JSON or not an object | 400 | `{"ok": false, "error": "invalid json"}` | no |
| 6 | Same `(event_name, event_id)` already stored and accepted | 200 | `{"ok": true, "duplicate": true}` | `duplicate_count` + 1 |
| 7 | Body names a `device` that matches no local `WhatsApp Device` | 200 | `{"ok": true, "ignored": true}` | `Ignored`, error `unknown device` |
| 8 | Accepted | 200 | `{"ok": true}` | `Received`, then processed by a job |

Notes:

- Rejected deliveries (steps 3–4) are stored as `Ignored` with `signature_valid` /
  `timestamp_fresh` flags and **no payload** (forensics without PII). A later, correctly signed and
  fresh delivery of the same `(event_name, event_id)` **takes that row over** instead of being
  treated as a duplicate, so a forged or stale request cannot suppress the real event.
- **Deduplication key.** `(event_name, event_id)` is a composite unique key (D-047) because the
  platform reuses one event id across the status events of a message. `event_name` is the header
  (else body `event`); a `message.status` event is renamed from the body's `status`
  (`sent|delivered|read|failed|held` → `message.<status>`, `cancelled` → `message.failed`). A
  concurrent insert race is resolved as a duplicate.
- Every accepted, non-duplicate delivery (including `ignored`) stamps
  `WhatsApp Settings.webhook_last_event_at`.
- Accepted events are processed by `whatsapp_next.webhooks.handlers.process_event` on the `short`
  queue (job id `wa-webhook-<event_id>`, de-duplicated, after commit, 120 s timeout). The receiver
  answers 200 as soon as the row is stored; processing happens afterwards.

## Events handled

`process_event` re-parses the stored payload through the provider and dispatches by name
(`handle_event`); the row ends `Processed`, `Ignored` or `Failed`, with `processed_at`,
`processing_ms` and a link to the message it touched (`outbound_message` / `inbound_message`).

| Event | What it does | Realtime |
|---|---|---|
| `message.sent` | Outbound found by `client_ref` (= `WhatsApp Log` name), else by `provider_message_id` → status `Sent`, `sent_at`, `provider_message_id`, `platform_message_log`. Not found → `Ignored`. | `wa:message:status` |
| `message.delivered` | Same lookup → `Delivered`. Status only moves forward (a `Read` row is not set back to `Delivered`). | `wa:message:status` |
| `message.read` | Same lookup → `Read`. | `wa:message:status` |
| `message.failed` | Same lookup → `Failed`, `error_code` / `error_message` from `services.errors.classify(reason)`. Final: `Failed` / `Cancelled` rows are never changed again. | `wa:message:status` |
| `message.held` | Same lookup → `Held` with `held_reason` (platform holds, e.g. quota); a later `Sent` / `Failed` resolves it. | `wa:message:status` |
| `message.received` | Stores a `WhatsApp Inbound Message` (deduplicated on `(device, provider_message_id)`), links the Contact by phone, enqueues the WhatsApp Number upsert and — for text commands — the command router. Needs a known device, else `Ignored`. | `wa:inbound:received` `{inbound, device, key_hash}` (no phone) |
| `message.reaction` | Stores an inbound row of type `Reaction`. Needs a known device. | `wa:inbound:received` |
| `connection.connected` / `connection.disconnected` / `connection.logged_out` | Device status → `Connected` / `Disconnected` / `Logged Out` through the device state machine (audited connect / disconnect). Unknown device → `Ignored` (a connection event for an unknown device is also logged at intake). | `wa:device:status` |
| `group.updated`, `group.participants.updated` | Refreshes the group's display name on its `WhatsApp Number` row (`group_id` / `jid` / `chat_jid`, `subject` / `group_name` / `name`). | — |
| anything else (e.g. `test.webhook`) | Stored and marked `Ignored`. | — |

After a terminal message event (`sent`, `delivered`, `read`, `failed`) is `Processed`, its stored
payload is blanked. A handler exception marks the row `Failed` with `[try N] <error>`; the
`*/10 * * * *` job `reprocess_failed` re-runs `Failed` rows until 3 tries.

The default subscription (`webhook_setup.DEFAULT_EVENTS`) is the twelve names above:
`message.sent`, `message.delivered`, `message.read`, `message.failed`, `message.held`,
`message.received`, `message.reaction`, `connection.connected`, `connection.disconnected`,
`connection.logged_out`, `group.updated`, `group.participants.updated`.

## Sample payload

From `whatsapp_next/tests/fixtures/webhooks/message.received.json` (sent with
`X-SND-Event: message.received`, `X-SND-Event-ID: 3EB0A1B2C3D4E5F6`):

```json
{
 "chat_jid": "966500000002@s.whatsapp.net",
 "device": "WAD-TEST-WH01",
 "device_name": "Main",
 "event": "message.received",
 "event_id": "3EB0A1B2C3D4E5F6",
 "from": "966500000002@s.whatsapp.net",
 "integration_link": "WAIL-00001",
 "message": {
  "conversation": "كشف حساب"
 },
 "message_type": "Text",
 "occurred_at": "2026-09-22 10:00:00",
 "phone_number": "966500000001",
 "provider_message_id": "3EB0A1B2C3D4E5F6",
 "push_name": "Ahmed",
 "received_at": "2026-09-22 09:59:58",
 "sender_jid": "966500000002@s.whatsapp.net",
 "sender_mobile_no": "966500000002",
 "status": "Connected",
 "subscription": "WASUB-00001",
 "text": "كشف حساب",
 "wa_device_id": "wa-dev-1"
}
```

A delivery status (`message.delivered.json`):

```json
{
 "client_ref": "a1b2c3d4e5",
 "delivered_at": "2026-09-22 10:00:05",
 "device": "WAD-TEST-WH01",
 "device_name": "Main",
 "event": "message.delivered",
 "event_id": "3EB0SENT0001",
 "integration_link": "WAIL-00001",
 "message_log": "WAML-00001",
 "occurred_at": "2026-09-22 10:00:00",
 "phone_number": "966500000001",
 "provider_message_id": "3EB0SENT0001",
 "queue_id": "WAMQ-00001",
 "subscription": "WASUB-00001",
 "wa_device_id": "wa-dev-1"
}
```

Field use: `device` is the platform device id (matched to `WhatsApp Device.platform_device`);
`client_ref` is the `WhatsApp Log` name the site sent with the message; `provider_message_id`
the WhatsApp message id; `message_log` the platform's log row; `reason` / `held_reason` / `error`
the failure or hold reason; `occurred_at` (or `timestamp`) the event time when the timestamp
header is absent on replay. The other fixtures in the same folder cover every event above,
including `message.received.group.json`, `message.received.lid.json`, `message.reaction.json`,
`unknown.event.json` and `test.webhook.json`.

## Testing locally

`whatsapp_next.webhooks.v1.receiver.handle(headers, raw_body, remote_ip=None)` is the pure core the
endpoint wraps; it returns `Outcome(http_status, body, event)` and can be called directly from a
test or `bench console` with a signed fixture.

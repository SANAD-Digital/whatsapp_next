# devices

Module `whatsapp_next/api/v1/devices.py`. These endpoints serve the Devices screen. They are thin
wrappers over `services/devices.py`, which is the only code that writes a device's `status`, and
over `read_layer.device_stats`. A pairing payload (QR or code) is cached for 60 s under
`wa:pair:{platform_device}` and never stored in the database.

Device statuses: `Pending QR`, `Connected`, `Disconnected`, `Logged Out`. Device names follow
`WA-DEV-.###`.

Conventions are in [README.md](README.md). Provider exceptions are mapped as described in
README §5.

### Realtime

A status change applied by `poll_status`, `disconnect_device`, or `list_devices(refresh=1)`
publishes `wa:device:status` `{device, status, previous, at, source}` to the site room and to the
device's document room. `delete_device` publishes the same event with `status: "Deleted"`.
`start_pairing` publishes `wa:pairing:status` `{device, mode, expires_at}` to the calling user.
Status changes are also audited (for example `Device Connected`), under the job user.

### Device row fields

`name, device_name, phone_e164, platform_device, wa_device_id, status, is_default, disabled, notes,
last_seen, connected_at, disconnected_at, logged_out_at, webhook_registered, last_error,
last_status_event_at, creation, modified`.

---

## list_devices

Returns the local device rows, default device first. With `refresh`, the provider's live state
is mirrored first.

- **Path:** `whatsapp_next.api.v1.devices.list_devices`
- **Methods:** GET, POST (use **POST** with `refresh=1`, see README §3)
- **Roles:** `VIEWER_UP`

| Argument | Type | Required / default | Meaning |
|---|---|---|---|
| `refresh` | bool | `false` | Calls `sync_from_provider` first. It mirrors `last_seen`, `webhook_registered`, `wa_device_id`, and status drift for known devices. Unknown provider devices are counted, never created. |

**Returns.** `synced` is `null` unless `refresh` is set.

```json
{
  "rows": [{"name": "WA-DEV-001", "device_name": "Sales", "phone_e164": "+966501234567",
            "status": "Connected", "is_default": 1, "disabled": 0, "…": "…"}],
  "total": 1,
  "synced": {"seen": 1, "changed": 0, "unknown": 0}
}
```

**Errors:** Provider errors when `refresh` is set (mapped). `WAPermissionError` (403).
**Realtime:** `wa:device:status` for each device whose status changed.

```bash
curl -s -X POST "https://<site>/api/method/whatsapp_next.api.v1.devices.list_devices" \
  -H "Authorization: token <api_key>:<api_secret>" -d refresh=1
```

---

## create_device

Creates the device on the provider, then the local row (normally `Pending QR`). The first device
on the site becomes the default. Audited as `Device Created`.

- **Path:** `whatsapp_next.api.v1.devices.create_device`
- **Methods:** POST
- **Roles:** `MANAGER`

| Argument | Type | Required / default | Meaning |
|---|---|---|---|
| `device_name` | str | required | Non-blank display name |
| `phone` | str | optional; **required** when `pairing_mode = "Code"` | The device's number, normalised to E.164 |
| `pairing_mode` | str | `QR` | `QR` or `Code` |

**Returns:** `{"name": "WA-DEV-002", "platform_device": "DEV-9f3a", "status": "Pending QR"}`

**Errors:**

| Exception | HTTP | When |
|---|---|---|
| `WAValidationError` | 417 | Blank name, or a bad `pairing_mode` |
| `WAInvalidPhoneError` | 417 | The phone doesn't parse, or no phone was given for `Code` |
| Provider errors (mapped, README §5) | 4xx/5xx | The provider refused to create the device |

```js
const dev = await sanad.ui.call("devices.create_device", { device_name: "Support", pairing_mode: "QR" });
```

---

## start_pairing

Returns a QR image or an 8-digit pairing code. A call within 60 s for the same mode returns the
cached payload. A `Logged Out` device goes back to `Pending QR`.

- **Path:** `whatsapp_next.api.v1.devices.start_pairing`
- **Methods:** POST
- **Roles:** `MANAGER`

| Argument | Type | Required / default | Meaning |
|---|---|---|---|
| `device` | str | required | `WhatsApp Device` name |
| `mode` | str | `QR` | `QR` or `Code` |

**Returns.** `qr_code` is set for `QR` and `pair_code` for `Code`.

```json
{"mode": "Code", "qr_code": null, "pair_code": "ABCD1234",
 "generated_at": "2026-09-28 10:00:00", "expires_at": "2026-09-28 10:01:00",
 "expires_in": 60, "phone_e164": "+966501234567"}
```

**Errors:**

| Exception | HTTP | When |
|---|---|---|
| `WANotFoundError` | 404 | Unknown device |
| `WAStateConflictError` | 409 | The device is disabled or already `Connected` |
| `WADeviceOfflineError` | 409 | The device isn't registered on the platform (no `platform_device`) |
| `WAInvalidPhoneError` | 417 | The provider refused the pairing ("Pairing failed: …"), for example no phone for code pairing |
| `WANotSupportedError` | 422 | The provider can't pair in this mode |
| `WAProviderUnavailableError` | 503 | The QR isn't available yet (the provider's `DeviceOfflineError`) |

**Realtime:** `wa:pairing:status` to the caller (on a fresh fetch only). `wa:device:status` when a
`Logged Out` device is reset to `Pending QR`.

```bash
curl -s -X POST "https://<site>/api/method/whatsapp_next.api.v1.devices.start_pairing" \
  -H "Authorization: token <api_key>:<api_secret>" -d device=WA-DEV-002 -d mode=QR
```

---

## poll_status

Asks the provider for the device's live state and applies it. The pairing page polls this.

- **Path:** `whatsapp_next.api.v1.devices.poll_status`
- **Methods:** POST
- **Roles:** `AGENT_UP`

| Argument | Type | Required / default | Meaning |
|---|---|---|---|
| `device` | str | required | `WhatsApp Device` name |

**Returns:** `{"status": "Connected", "changed": true, "previous": "Pending QR"}`

**Errors:** `WADeviceOfflineError` (409) when the device isn't registered on the platform or is
unknown. Provider errors are mapped.
**Realtime:** `wa:device:status` when `changed` is true.

```js
const s = await sanad.ui.call("devices.poll_status", { device: "WA-DEV-002" });
```

---

## disconnect_device  *(destructive)*

Logs the device out on the provider. The status becomes `Logged Out` (unless the provider reports
another known status), and the cached pairing payload is dropped. Audited through the status
change.

- **Path:** `whatsapp_next.api.v1.devices.disconnect_device`
- **Methods:** POST
- **Roles:** `MANAGER`

| Argument | Type | Required / default | Meaning |
|---|---|---|---|
| `device` | str | required | `WhatsApp Device` name |

**Returns:** `{"status": "Logged Out"}`

**Errors:** `WADeviceOfflineError` (409) when the device isn't registered on the platform or is
unknown. Provider errors are mapped.
**Realtime:** `wa:device:status`.

```bash
curl -s -X POST "https://<site>/api/method/whatsapp_next.api.v1.devices.disconnect_device" \
  -H "Authorization: token <api_key>:<api_secret>" -d device=WA-DEV-002
```

---

## delete_device  *(destructive)*

Deletes the device on the provider (optional) and locally. The provider answering "not found"
counts as already deleted. Configuration that points at the device loses the link: the `device`
field on Campaigns, Notifications, and Notification Alerts, `reply_device` on Commands, and
`default_device` / `reply_device` in Settings. Message history keeps its link, which then points
at nothing. Audited as `Device Deleted`.

- **Path:** `whatsapp_next.api.v1.devices.delete_device`
- **Methods:** POST
- **Roles:** `MANAGER`

| Argument | Type | Required / default | Meaning |
|---|---|---|---|
| `device` | str | required | `WhatsApp Device` name |
| `delete_remote` | bool | `true` | Passed to the provider's delete call |

**Returns:** `{"deleted": "WA-DEV-002"}`

**Errors:**

| Exception | HTTP | When |
|---|---|---|
| `WANotFoundError` | 404 | Unknown device |
| `WAStateConflictError` | 409 | It is the default device and other devices exist ("Set another device as default before deleting …") |
| Provider errors (mapped) | 4xx/5xx | Apart from not-found |

**Realtime:** `wa:device:status` with `status: "Deleted"`.

```js
await sanad.ui.call("devices.delete_device", { device: "WA-DEV-002", delete_remote: 1 });
```

---

## update_device

Renames the device or changes its number through the provider (platform A-05), then saves the
local row. A device without a `platform_device` is updated locally only.

- **Path:** `whatsapp_next.api.v1.devices.update_device`
- **Methods:** POST
- **Roles:** `MANAGER`

| Argument | Type | Required / default | Meaning |
|---|---|---|---|
| `device` | str | required | `WhatsApp Device` name |
| `device_name` | str | optional | New name (trimmed) |
| `phone` | str | optional | New number, normalised to E.164 |

**Returns.** The full device row (see *Device row fields*).

**Errors:**

| Exception | HTTP | When |
|---|---|---|
| `WANotFoundError` | 404 | Unknown device |
| `WAInvalidPhoneError` | 417 | The phone doesn't parse |
| `WANotSupportedError` | 422 | "Renaming devices is not supported by this provider yet" |

```bash
curl -s -X POST "https://<site>/api/method/whatsapp_next.api.v1.devices.update_device" \
  -H "Authorization: token <api_key>:<api_secret>" -d device=WA-DEV-002 -d device_name="Support KSA"
```

---

## set_default

Makes the device the default. The controller clears the flag on the others, and
`Settings.default_device` follows.

- **Path:** `whatsapp_next.api.v1.devices.set_default`
- **Methods:** POST
- **Roles:** `MANAGER`

| Argument | Type | Required / default | Meaning |
|---|---|---|---|
| `device` | str | required | `WhatsApp Device` name |

**Returns:** `{"ok": true}`

**Errors:** `WANotFoundError` (404). `WAStateConflictError` (409) "A disabled device cannot be the
default".

```js
await sanad.ui.call("devices.set_default", { device: "WA-DEV-001" });
```

---

## set_disabled

Disables or enables a device for dispatch. While a device is disabled, its rows stay `Queued`.
Disabling also drops the cached pairing payload. Setting the current value again does nothing.

- **Path:** `whatsapp_next.api.v1.devices.set_disabled`
- **Methods:** POST
- **Roles:** `MANAGER`

| Argument | Type | Required / default | Meaning |
|---|---|---|---|
| `device` | str | required | `WhatsApp Device` name |
| `disabled` | bool | required | `1` to disable, `0` to enable |

**Returns:** `{"ok": true}`

**Errors:** `WANotFoundError` (404). `WAStateConflictError` (409) when disabling the default
device while other enabled devices exist.

```bash
curl -s -X POST "https://<site>/api/method/whatsapp_next.api.v1.devices.set_disabled" \
  -H "Authorization: token <api_key>:<api_secret>" -d device=WA-DEV-002 -d disabled=1
```

---

## get_device_stats

Returns the device card's figures over the last `days`.

- **Path:** `whatsapp_next.api.v1.devices.get_device_stats`
- **Methods:** GET, POST
- **Roles:** `VIEWER_UP`

| Argument | Type | Required / default | Meaning |
|---|---|---|---|
| `device` | str | required | `WhatsApp Device` name. An unknown name returns zeros. |
| `days` | int | `30` | 1–365 |

**Returns:**

- `outbound`: every outbound row created in the window.
- `sent`: rows in Sent, Delivered, or Read.
- `failed`: rows in Failed.
- `fail_rate`: `failed / (sent + failed)`, rounded to 4 places.
- `inbound`: rows received in the window.
- `last_message_at`: the latest outbound creation or inbound receipt.

```json
{"device": "WA-DEV-001", "days": 30, "sent": 950, "failed": 12, "fail_rate": 0.0125,
 "outbound": 980, "inbound": 310, "last_message_at": "2026-09-28 09:57:40"}
```

**Errors:** `WAValidationError` (417) for `days` outside 1–365.

```js
const stats = await sanad.ui.call("devices.get_device_stats", { device: "WA-DEV-001", days: 7 });
```

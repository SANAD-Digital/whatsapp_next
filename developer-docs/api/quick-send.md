# quick_send

Module `whatsapp_next/api/v1/quick_send.py`. These endpoints serve the QuickSend composer (the
"send a WhatsApp" dialog on any form or list). They are thin wrappers over
`services/quick_send.py` and `services/dispatch.py`. `send` only creates the `WhatsApp Log` row
and queues it at **priority 1**. The dispatcher sends it on its next tick.

Conventions are in [README.md](README.md). File name of this page: `quick-send.md`. Python
module: `quick_send`. Kit keys: `"quick_send.<fn>"`.

---

## get_context

The composer's bootstrap: enabled devices, the default device, usable templates, the resolved
recipient, and the known-number policy.

- **Path:** `whatsapp_next.api.v1.quick_send.get_context`
- **Methods:** GET, POST
- **Roles:** `AGENT_UP` (WhatsApp Agent, WhatsApp Manager, System Manager)

| Argument | Type | Required / default | Meaning |
|---|---|---|---|
| `phone` | str | optional | A raw number, or a group or LID JID |
| `contact` | str | optional | `Contact` name. Its first WhatsApp number is used unless `phone` is also given. |
| `number` | str | optional | `WhatsApp Number` name (takes precedence) |
| `reference_doctype` | str | optional | Narrows the templates to generic ones plus those bound to this DocType |
| `reference_name` | str | optional | Echoed back in `reference` when both reference arguments are given |

**Returns.** `recipient` is `null` unless `phone`, `contact`, or `number` is given.

- `known`: the number appears in the message history (read layer).
- `blacklisted`: the number is in the global blacklist group.

For a JID, `phone_e164` is `null` and `jid` is set.

```json
{
  "devices": [{"name": "WA-DEV-001", "device_name": "Sales", "status": "Connected", "is_default": 1,
               "phone_e164": "+966500000001"}],
  "default_device": "WA-DEV-001",
  "templates": [{"name": "Invoice reminder", "template_name": "Invoice reminder", "message_type": "Text",
                 "category": "Billing", "reference_doctype": "Sales Invoice"}],
  "recipient": {"phone_e164": "+966501234567", "jid": null, "display_name": "Ali Saleh",
                "contact": "Ali Saleh", "known": true, "blacklisted": false},
  "reference": {"doctype": "Sales Invoice", "name": "ACC-SINV-2026-00042"},
  "policy": {"send_only_to_known_numbers": false}
}
```

**Errors:** `WAInvalidPhoneError` (417) in these cases: the phone doesn't parse, the WhatsApp
Number is unknown, or the contact has no WhatsApp number and no `phone` was given.

```bash
curl -s -G "https://<site>/api/method/whatsapp_next.api.v1.quick_send.get_context" \
  -H "Authorization: token <api_key>:<api_secret>" \
  --data-urlencode phone=0501234567 --data-urlencode reference_doctype="Sales Invoice"
```

---

## preview

Renders a template, or an ad-hoc body, over the reference document. When no reference is given,
it renders over a sample context. Render errors are **returned, never raised**.

- **Path:** `whatsapp_next.api.v1.quick_send.preview`
- **Methods:** GET, POST
- **Roles:** `AGENT_UP`

| Argument | Type | Required / default | Meaning |
|---|---|---|---|
| `template` | str | optional | `WhatsApp Template` name. It is ignored when `body` is given. |
| `body` | str | optional | Ad-hoc Jinja text |
| `reference_doctype` | str | optional | With `reference_name`, renders over that document. Alone, it builds a sample context for the DocType. |
| `reference_name` | str | optional | Document name |

**Returns:**

```json
{"body": "Dear Ali, invoice ACC-SINV-2026-00042 is due.", "errors": []}
```

An unknown template returns `{"body": "", "errors": ["WhatsApp Template X not found"]}`.

**Errors:** None beyond the role check.

```js
const p = await sanad.ui.call("quick_send.preview", {
  template: "Invoice reminder", reference_doctype: "Sales Invoice", reference_name: "ACC-SINV-2026-00042",
});
```

---

## send

Creates one outbound message and queues it at priority 1 (`source_type = "Quick Send"`). The
`device_offline` and `queue_paused` conditions don't block the send. They come back as
`warnings`, and the row is queued anyway.

- **Path:** `whatsapp_next.api.v1.quick_send.send`
- **Methods:** POST
- **Roles:** `AGENT_UP`

| Argument | Type | Required / default | Meaning |
|---|---|---|---|
| `device` | str | required | `WhatsApp Device` name. An empty string falls back to the default device, then to any Connected device. |
| `phone` | str | one of `phone` / `jid` | The recipient number, normalised to E.164. **`contact` alone is not enough.** |
| `jid` | str | one of `phone` / `jid` | A group or LID JID (group sends) |
| `contact` | str | optional | `Contact` name. It is stored on the row, and its `full_name` becomes `display_name`. |
| `message_type` | str | `Text` | `Text`, `Document`, `Image`, `Video`, `Audio`, `Sticker`, `Location`, or `Poll` |
| `body` | str | required for `Text` unless `template` is given | Message text |
| `template` | str | optional | `WhatsApp Template`. It is rendered over the reference document when `body` is empty. |
| `attachment` | str | required for `Document` / `Image` / `Video` / `Audio` / `Sticker` | The URL of an uploaded `File`. Its MIME type must fit the message type. |
| `caption` | str | optional | Caption for a file |
| `print_format` | str | optional | Stored on the row |
| `reference_doctype` | str | optional | The linked document (template context, drawer) |
| `reference_name` | str | optional | |
| `scheduled_at` | datetime | optional | Don't send before this time |
| `poll_question` | str | required for `Poll` | At most 255 characters |
| `poll_options` | list[str] | required for `Poll` | 2–12 distinct options, each at most 100 characters |
| `poll_allow_multiple` | bool | `false` | Allow several answers |
| `location` | dict | required for `Location` | `{latitude, longitude, name?, address?}` |

The checks run in this order: device, recipient, global blacklist, known-number policy, template
render, attachment type, poll shape. A template that fails to render leaves the body empty, which
a `Text` message refuses.

**Returns:** `queue_item` is the `WhatsApp Queue Item` name, and `warnings` is a subset of
`["queue_paused", "device_offline"]`.

```json
{"outbound": "a1b2c3d4e5", "queue_item": "f6a7b8c9d0", "warnings": ["device_offline"]}
```

**Errors:**

| Exception | HTTP | When |
|---|---|---|
| `WADeviceOfflineError` | 409 | No device could be resolved, or the named device doesn't exist ("No WhatsApp device is configured") |
| `WAInvalidPhoneError` | 417 | Neither `phone` nor `jid` parses |
| `WABlacklistedError` | 417 | The recipient is on the global blacklist |
| `WAUnknownNumberPolicyError` | 417 | `send_only_to_known_numbers` is on and the number is new (individual recipients only) |
| `WANotFoundError` | 404 | Unknown `template` |
| `WAValidationError` | 417 | A disabled template, an empty text body (with the template error appended), a missing attachment or location, a bad poll, or a `message_type` outside the enum |
| `WAFileError` | 417 | The attachment's `File` is missing, or its MIME type doesn't fit the message type |

**Realtime:** None at queue time. Later, the dispatcher publishes `wa:message:status` for this
outbound as it moves through Sending, Sent, Delivered, and Read (or Failed).

```bash
curl -s -X POST "https://<site>/api/method/whatsapp_next.api.v1.quick_send.send" \
  -H "Authorization: token <api_key>:<api_secret>" -H "Content-Type: application/json" \
  -d '{"device": "WA-DEV-001", "phone": "+966501234567", "body": "Your order has shipped.",
       "reference_doctype": "Sales Order", "reference_name": "SAL-ORD-2026-00017"}'
```

```js
const r = await sanad.ui.call("quick_send.send", {
  device: "WA-DEV-001", phone: "+966501234567", message_type: "Poll",
  poll_question: "Pick a slot", poll_options: JSON.stringify(["9:00", "11:00", "14:00"]),
});
```

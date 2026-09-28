# bulk_send

Module `whatsapp_next/api/v1/bulk_send.py`. These endpoints serve the "Send a bulk message"
window (D-136). A bulk send is **not** a second sending engine. The selection becomes a
`WhatsApp Campaign` that is started now or scheduled, and the campaign runner owns the rate,
queue, progress, pause, and cancel (see [campaigns.md](campaigns.md)). This module resolves the
selection, estimates it for the window, and hands it over.

**Selection rules** (`services/bulk_send.resolve`):

- Recipients are de-duplicated by E.164 number and kept in pick order: groups first, then
  contacts, then typed numbers.
- Members of any **Blacklist-kind** contact group are left out, unless that group itself was
  picked. Members of the site's **global blacklist group** are always left out. Both count as
  `excluded`.
- Numbers that don't parse, group JIDs, and contacts without a WhatsApp number count as
  `invalid`.
- The maximum is **20 000** recipients per bulk send.

File name of this page: `bulk-send.md`. Python module: `bulk_send`. Kit keys:
`"bulk_send.<fn>"`. Conventions are in [README.md](README.md).

---

## get_context

Returns what the window opens with.

- **Path:** `whatsapp_next.api.v1.bulk_send.get_context`
- **Methods:** GET, POST
- **Roles:** `MANAGER` (WhatsApp Manager, System Manager)

Arguments: none.

**Returns:**

- `groups`: enabled contact groups.
- `templates`: enabled `Text` templates.
- `devices`: enabled devices.
- `rate`: the default campaign rate, `min(20, queue rate)`, or 20 when there is no queue rate.
- `max_rate`: the site's queue rate (the cap), or `null`.
- `messages_remaining`: from the subscription cache.

```json
{
  "groups": [{"name": "VIP", "group_name": "VIP", "kind": "Marketing", "description": null,
              "source": "Manual", "member_count": 120}],
  "templates": [{"name": "Promo", "template_name": "Promo", "category": "Marketing", "body": "Hello {{ recipient.display_name }}"}],
  "devices": [{"name": "WA-DEV-001", "device_name": "Sales", "status": "Connected"}],
  "default_device": "WA-DEV-001",
  "rate": 20, "max_rate": 30, "messages_remaining": 8766
}
```

**Errors:** `WAPermissionError` (403).

```bash
curl -s "https://<site>/api/method/whatsapp_next.api.v1.bulk_send.get_context" \
  -H "Authorization: token <api_key>:<api_secret>"
```

---

## estimate

Returns live counts for a selection, with the blacklists applied. No rows are returned.

- **Path:** `whatsapp_next.api.v1.bulk_send.estimate`
- **Methods:** GET, POST
- **Roles:** `MANAGER`

| Argument | Type | Required / default | Meaning |
|---|---|---|---|
| `groups` | list | optional | `WhatsApp Contact Group` names |
| `contacts` | list | optional | `Contact` names. The first WhatsApp number of each is used. |
| `numbers` | list | optional | Raw numbers |

**Returns:** `{"total": 118, "excluded": 2, "invalid": 1}`

**Errors:** `WAValidationError` (417) when the selection exceeds 20 000 recipients, or when a
list argument isn't JSON.

```js
const est = await sanad.ui.call("bulk_send.estimate", { groups: ["VIP"], numbers: ["0501234567"] });
```

---

## search_contacts

Searches contacts that have a WhatsApp number, for the window's "Contacts" tab. It reads through
the contextual permission layer (`permissions.list_contacts`, page length 50). Contacts without a
WhatsApp number are dropped from the result.

- **Path:** `whatsapp_next.api.v1.bulk_send.search_contacts`
- **Methods:** GET, POST
- **Roles:** `MANAGER`, **and** either the `WhatsApp Contact User` role or core `Contact` read
  permission (`permissions.require("read")`). An elevated read by a Contact User is audited as
  `Elevated Contact Read`.

| Argument | Type | Required / default | Meaning |
|---|---|---|---|
| `txt` | str | optional | Matches name, e-mail, phone, or WhatsApp phone |

**Returns.** `phone` is the first `wa_phone_e164` of the contact. `party_type` is the first
link's DocType, or `null`.

```json
[{"name": "Ali Saleh", "label": "Ali Saleh", "phone": "+966501234567", "party_type": "Customer"}]
```

**Errors:** `WAPermissionError` (403) "Not permitted to read contacts", or when the role is
missing.

```bash
curl -s -G "https://<site>/api/method/whatsapp_next.api.v1.bulk_send.search_contacts" \
  -H "Authorization: token <api_key>:<api_secret>" --data-urlencode txt=ali
```

---

## send

Sends one message to the selection. It creates a `WhatsApp Campaign` named "Bulk message ·
dd-MM-yyyy HH:mm" with one message, adds the recipients, and then **starts** the campaign
(`Queued`, materialised in a `long` job) or **schedules** it. Audited as `Bulk Send` with the
count, and as `Campaign Started` when started now.

- **Path:** `whatsapp_next.api.v1.bulk_send.send`
- **Methods:** POST
- **Roles:** `MANAGER`. The caller also needs create permission on `WhatsApp Campaign`, because
  the campaign is inserted with normal permissions.

| Argument | Type | Required / default | Meaning |
|---|---|---|---|
| `payload` | dict | required | Only the keys below. Any other key → `WAValidationError`. |

| `payload` key | Type | Meaning |
|---|---|---|
| `groups` | list | Contact group names |
| `contacts` | list | Contact names |
| `numbers` | list | Raw numbers |
| `body` | str | Message text. For a file kind, it becomes the caption. |
| `template` | str | `WhatsApp Template` (text kind only) |
| `kind` | str | `text` (default), `image`, `video`, `document`, `audio`, or `contact`. `location` is refused. |
| `attachment` | str | URL of an uploaded `File` (file kinds). Its MIME type must fit the kind. |
| `contact` | str | For `kind = "contact"`: the Contact to share. It is stored as a private `.vcf` and sent as a Document. |
| `device` | str | Sending device. The default is Settings → default device. |
| `rate` | int | The campaign's messages per minute. Empty means the campaign default. |
| `scheduled_at` | datetime | A future time. When given, the campaign is scheduled instead of started. |

**Returns.** `status` is `Queued` (started) or `Scheduled`.

```json
{"campaign": "WA-CAMP-2026-00014", "status": "Queued", "recipients": 118, "excluded": 2, "invalid": 1}
```

**Errors:**

| Exception | HTTP | When |
|---|---|---|
| `WAValidationError` | 417 | `payload must be an object`, `Unknown payload keys: …`, "A location cannot be sent as a bulk message", "Write the message text or pick a template", an unknown `kind`, "Pick the contact to share", "Upload the file to send", "Pick a sending device", "The scheduled time must be in the future", "No recipient: …", over 20 000 recipients, or a campaign validation |
| `WAFileError` | 417 | The attachment is missing, or its MIME type doesn't fit the kind |
| `WAStateConflictError` | 409 | The campaign can't be started or scheduled from its state (not expected for a new campaign) |
| `PermissionError` | 403 | No create permission on `WhatsApp Campaign` |

**Realtime:** `wa:campaign:status` `{campaign, status, counters}` for the new campaign. After
that, progress arrives through the campaign and queue events.

```bash
curl -s -X POST "https://<site>/api/method/whatsapp_next.api.v1.bulk_send.send" \
  -H "Authorization: token <api_key>:<api_secret>" -H "Content-Type: application/json" \
  -d '{"payload": {"groups": ["VIP"], "numbers": ["0501234567"], "body": "Our store opens at 9.",
                   "device": "WA-DEV-001", "rate": 15}}'
```

```js
const r = await sanad.ui.call("bulk_send.send", {
  payload: { contacts: ["Ali Saleh"], kind: "image", attachment: "/private/files/flyer.png", body: "New flyer" },
});
```

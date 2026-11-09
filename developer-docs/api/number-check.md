# number_check

Module `whatsapp_next/api/v1/number_check.py`. These endpoints serve the "Check on WhatsApp" and
"Refresh WhatsApp profile" actions of the Contacts, Contact Groups and WhatsApp Numbers screens
(`whatsapp_next_setup.js`). They are thin wrappers over `services/number_check.py` and
`services/contact_profiles.py`. Both read the numbers behind the selected records with
`services/wa_groups.members_from`, then ask WhatsApp through a connected device.

Both endpoints need **`AGENT_UP`** (WhatsApp Agent, WhatsApp Manager, System Manager).

Conventions are in [README.md](README.md). File name of this page: `number-check.md`. Python
module: `number_check`. Kit keys: `"number_check.<fn>"`. Provider exceptions are mapped as
described in README §5.

### The numbers behind a selection

| `source_doctype` | Numbers taken |
|---|---|
| `Contact` | The individual WhatsApp numbers (`wa_phone_e164`) of the contacts. Without the contacts role's elevated read, contacts the user can't read are dropped silently. |
| `WhatsApp Contact Group` | The individual members of the groups. A group the user can't read raises `PermissionError` (403). |
| `WhatsApp Number` | The selected rows of type `Individual`, through the user's list permission |

Only the first **256** names of `names` are read. Group JIDs are left out, and each number
appears once.

### The device

The settings' default device is used when it is `Connected`. Otherwise the first connected,
enabled device is used.

### Realtime

None of these endpoints publishes a realtime event.

---

## check_selection

Checks the numbers behind the selected records with WhatsApp, always asking again (the 30-day
cache is bypassed). Each answer is stored in `WhatsApp Number Check` and, when the number has a
`WhatsApp Number` row, in its `on_whatsapp` and `whatsapp_checked_at`. The platform is asked in
batches of 1,000.

- **Path:** `whatsapp_next.api.v1.number_check.check_selection`
- **Methods:** POST
- **Roles:** `AGENT_UP`

| Argument | Type | Required / default | Meaning |
|---|---|---|---|
| `source_doctype` | str | required | `Contact`, `WhatsApp Contact Group` or `WhatsApp Number` |
| `names` | list[str] | required | The selected record names |

**Returns.** `results` keeps the order of the numbers found. `display_name` is the contact's
`full_name`, the group member's or the number's display name.

```json
{"checked": 3, "on_whatsapp": 2, "not_on": 1,
 "results": [{"phone_e164": "+966501234567", "display_name": "Ali Saleh", "on_whatsapp": true},
             {"phone_e164": "+966507654321", "display_name": "Sara", "on_whatsapp": true},
             {"phone_e164": "+966500000009", "display_name": null, "on_whatsapp": false}]}
```

**Errors:**

| Exception | HTTP | When |
|---|---|---|
| `WAValidationError` | 417 | A `source_doctype` outside the list, or more than 5,000 numbers ("Check at most 5000 numbers at a time") |
| `PermissionError` | 403 | A selected contact group the user can't read |
| `WAStateConflictError` | 409 | No device is connected ("No WhatsApp device is connected to check numbers with") |
| Provider errors (mapped, README §5) | 4xx/5xx | The platform refused the check |

**Realtime:** none.

```js
const r = await sanad.ui.call("number_check.check_selection", {
  source_doctype: "Contact", names: ["Ali Saleh", "Sara Omar"],
});
```

---

## refresh_profiles

Reads the WhatsApp profiles of the numbers behind the selected records now, even those read in
the last 7 days. A profile is the photo, the "about" text and, for a business, its verified name,
categories, email, address and opening hours. It is written onto the number's `WhatsApp Number`
row. The photo is saved as a private `File` on that row, and a linked `Contact` without a photo
takes it (audited as `Elevated Contact Write`). The registration answer also updates the number
check, as in `check_selection`. The platform is asked in batches of 20.

- **Path:** `whatsapp_next.api.v1.number_check.refresh_profiles`
- **Methods:** POST
- **Roles:** `AGENT_UP`

| Argument | Type | Required / default | Meaning |
|---|---|---|---|
| `source_doctype` | str | required | `Contact`, `WhatsApp Contact Group` or `WhatsApp Number` |
| `names` | list[str] | required | The selected record names |

**Returns.** `asked` is the number of numbers asked about. `updated` counts those with a
`WhatsApp Number` row that was written, and `photos` the new photos saved.

```json
{"asked": 3, "updated": 2, "photos": 1}
```

**Errors:**

| Exception | HTTP | When |
|---|---|---|
| `WAValidationError` | 417 | A `source_doctype` outside the list, or more than 200 numbers ("Refresh at most 200 numbers at a time") |
| `PermissionError` | 403 | A selected contact group the user can't read |
| `WAStateConflictError` | 409 | No device is connected |
| Provider errors (mapped, README §5) | 4xx/5xx | The platform refused the request |

**Realtime:** none.

```js
const r = await sanad.ui.call("number_check.refresh_profiles", {
  source_doctype: "WhatsApp Number", names: ["+966501234567"],
});
```

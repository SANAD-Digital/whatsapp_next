# phone

Module `whatsapp_next/api/v1/phone.py`. This module provides the phone-number metadata the
browser needs. The data comes from the same library the server validates with (`phonenumbers` /
libphonenumber), so a number that `PhoneField` accepts is also a number
`services.phone.normalize()` accepts. It is a thin wrapper over `services/phone.py`.

Conventions are in [README.md](README.md).

---

## get_countries

Returns every calling region libphonenumber knows, and the site's default region.

- **Path:** `whatsapp_next.api.v1.phone.get_countries`
- **Methods:** GET, POST
- **Roles:** `VIEWER_UP` + `CONTACT_USER` (any WhatsApp role)

Arguments: none.

**Returns.** `default` is the site's region: WhatsApp Settings → `default_country`, else System
Settings → country, else `SA`. The catalogue is cached for a day. Each country has these fields:

| Field | Meaning |
|---|---|
| `iso` | ISO 3166 alpha-2 region code |
| `dial` | Country calling code (an int) |
| `main` | `true` for the main region of a shared code (for example `US` for `+1`) |
| `example` | The region's sample **mobile** number in national form (a fixed-line number when there is no mobile sample). Used as the placeholder and the grouping mask. |
| `international` | The same example in international form |
| `trunk` | The national prefix the example carries (`0` in Saudi Arabia), so the field can drop it |
| `len` | Digits in the national significant number of the example |
| `mobile` | The library's regex for a mobile national number in this region, or `null` |

Region names are deliberately absent. Name a region in the reader's own language with
`Intl.DisplayNames`.

```json
{
  "default": "SA",
  "countries": [
    {"iso": "SA", "dial": 966, "main": true, "example": "051 234 5678",
     "international": "+966 51 234 5678", "trunk": "0", "len": 9, "mobile": "579[0-8]\\d{5}|5(?:[013-689]\\d|7[0-8])\\d{6}"}
  ]
}
```

**Errors:** `WAPermissionError` (403).

```bash
curl -s "https://<site>/api/method/whatsapp_next.api.v1.phone.get_countries" \
  -H "Authorization: token <api_key>:<api_secret>"
```

```js
const { default: region, countries } = await sanad.ui.call("phone.get_countries");
```

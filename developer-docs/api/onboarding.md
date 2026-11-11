# onboarding

Module `whatsapp_next/api/v1/onboarding.py`. These endpoints serve the Onboarding Wizard. Sign-up,
sign-in, password reset, and coupons go straight through to the provider (the SND platform).
Credentials the platform hands back are written with `set_password` and **never appear in a
response**. Almost every endpoint here is **admin-only** (`SYSTEM_MANAGER`).

Conventions are in [README.md](README.md). Provider exceptions that escape an endpoint are
mapped as described in README §5. The most common are `WAValidationError` (417) for a provider
validation or not-found error, `WAProviderAuthError` (424), `WAProviderUnavailableError` (503),
and `WARateLimitError` (429).

Kit keys: `get_status`, `start_signup`, `get_signup_status`, `complete_signup`,
`start_password_reset`, `save_credentials`, `complete_setup`, `login`, `validate_coupon`,
`get_referral_coupon`, and `get_signup_bootstrap` are in the `whatsapp.ui` map (`"onboarding.<fn>"`).
`verify_code`, `get_password_reset_status`, `finish_password_reset`, `sign_out`,
`get_account_switch` and `resolve_account_switch` are in the map as well.

### The link result

`complete_signup` (when credentials were stored) and `login` finish by **linking the site**. They
test the connection, register the webhook endpoint (refreshing the signing secret), and adopt the
account's existing devices as local `WhatsApp Device` rows. Each step is reported and none of them
raises:

```json
{
  "connection": {"ok": true, "error": null},
  "webhook": {"ok": true, "status": "Active"},
  "devices": {"ok": true, "adopted": 1}
}
```

When the connection fails, only `connection` is present. A failed webhook or device step carries
`error` and `ok: false`. Linking publishes no realtime event of its own.

---

## get_status

Returns the wizard's state: the four steps, whether setup is complete, and whether redirecting to
the wizard is on. It makes no provider call.

- **Path:** `whatsapp_next.api.v1.onboarding.get_status`
- **Methods:** GET, POST
- **Roles:** `VIEWER_UP` + `CONTACT_USER` (any WhatsApp role)

Arguments: none.

**Returns.** The steps, in order:

- `credentials`: the platform URL (from Settings or the bench default) and `customer_api_key`,
  `api_key`, and `api_secret` are all present.
- `connection`: `connection_status == "OK"`.
- `device`: at least one `Connected` device.
- `webhook`: `webhook_status == "Active"`.

`webhook_url` is the receiver URL this site registers.

```json
{
  "setup_completed": false,
  "setup_completed_at": null,
  "steps": [
    {"key": "credentials", "done": true, "detail": null},
    {"key": "connection", "done": true, "detail": "OK"},
    {"key": "device", "done": false, "detail": "0 connected device(s)"},
    {"key": "webhook", "done": false, "detail": "Not registered"}
  ],
  "redirect_enabled": true,
  "webhook_url": "https://<site>/api/method/whatsapp_next.webhooks.v1.receiver.receive"
}
```

**Errors:** `WAPermissionError` (403).

```bash
curl -s "https://<site>/api/method/whatsapp_next.api.v1.onboarding.get_status" \
  -H "Authorization: token <api_key>:<api_secret>"
```

---

## get_signup_bootstrap  *(admin-only)*

Returns what the sign-up form needs before anything is typed. Countries are not included: use
[phone.get_countries](phone.md).

- **Path:** `whatsapp_next.api.v1.onboarding.get_signup_bootstrap`
- **Methods:** GET, POST
- **Roles:** `SYSTEM_MANAGER`

Arguments: none.

**Returns.** `plans` is passed through from the platform unchanged. `code_ttl_minutes` is `null`
when the platform doesn't give it.

```json
{"plans": [{"plan_code": "PRO", "…": "…"}], "code_ttl_minutes": 10, "device_phone": "9665…", "device_ready": true}
```

**Errors:** Provider errors are mapped.

```js
const boot = await whatsapp.ui.call("onboarding.get_signup_bootstrap");
```

---

## start_signup  *(admin-only)*

Starts a tenant sign-up on the platform. `mobile` is normalised to E.164 first. The platform
validates `coupon_code` now, so a bad code is refused while the user is still on the form.

- **Path:** `whatsapp_next.api.v1.onboarding.start_signup`
- **Methods:** POST
- **Roles:** `SYSTEM_MANAGER`

| Argument | Type | Required / default | Meaning |
|---|---|---|---|
| `plan_code` | str | required | Plan from `get_signup_bootstrap` |
| `mobile` | str | required | Mobile number, in any form `services.phone.normalize` accepts |
| `full_name` | str | required | Tenant's name |
| `email` | str | required | Tenant's e-mail |
| `channel` | str | `whatsapp` | `whatsapp`, `sms`, or `email`. It is validated, but the SND provider doesn't forward it. |
| `coupon_code` | str | optional | Coupon to apply to the new subscription |

**Returns:**

```json
{"request_key": "c0ffee…", "status": "Pending", "code_ttl": 10, "coupon": null, "message": null}
```

**Errors:** `WAInvalidPhoneError` (417) "Invalid phone number: …". `WAValidationError` (417) for
a bad `channel`. Provider errors are mapped.

```bash
curl -s -X POST "https://<site>/api/method/whatsapp_next.api.v1.onboarding.start_signup" \
  -H "Authorization: token <api_key>:<api_secret>" -H "Content-Type: application/json" \
  -d '{"plan_code": "PRO", "mobile": "0501234567", "full_name": "Acme", "email": "ops@acme.sa"}'
```

---

## get_signup_status  *(admin-only)*

Polls a sign-up request.

- **Path:** `whatsapp_next.api.v1.onboarding.get_signup_status`
- **Methods:** GET, POST
- **Roles:** `SYSTEM_MANAGER`

| Argument | Type | Required / default | Meaning |
|---|---|---|---|
| `request_key` | str | required | From `start_signup` |

**Returns.** The status values come from the platform, for example `Pending`, `Verified`, and
`Completed`.

```json
{"status": "Pending", "message": null}
```

**Errors:** Provider errors are mapped.

```js
await whatsapp.ui.call("onboarding.get_signup_status", { request_key });
```

---

## verify_code  *(admin-only)*

Checks a verification code without finishing the sign-up.

- **Path:** `whatsapp_next.api.v1.onboarding.verify_code`
- **Methods:** POST
- **Roles:** `SYSTEM_MANAGER`

| Argument | Type | Required / default | Meaning |
|---|---|---|---|
| `request_key` | str | required | Sign-up request |
| `code` | str | required | Code the user received |
| `purpose` | str | optional | Passed through to the provider |

**Returns.** `ok` is true when the status is `Verified` or `Completed`.

```json
{"ok": true, "status": "Verified"}
```

**Errors:** Provider errors are mapped. A provider `ValidationError` becomes `WAValidationError`
(417).

```js
await whatsapp.ui.call("whatsapp_next.api.v1.onboarding.verify_code", { request_key, code: "123456" });
```

---

## complete_signup  *(admin-only)*

Finishes the sign-up. `code` verifies the request if it hasn't been verified yet, and `password`
sets the tenant's platform password. Any credentials the platform returns are stored (audited as
`Credentials Changed`), and then the site is linked (see *The link result* above).

- **Path:** `whatsapp_next.api.v1.onboarding.complete_signup`
- **Methods:** POST
- **Roles:** `SYSTEM_MANAGER`

| Argument | Type | Required / default | Meaning |
|---|---|---|---|
| `request_key` | str | required | Sign-up request |
| `code` | str | optional | Verification code |
| `password` | str | optional | New platform password |

**Returns.** When `credentials_stored` is false, the platform returned no keys and they must be
entered with `save_credentials`. In that case the link keys are absent.

```json
{
  "ok": true, "status": "Completed", "credentials_stored": true,
  "connection": {"ok": true, "error": null},
  "webhook": {"ok": true, "status": "Active"},
  "devices": {"ok": true, "adopted": 0}
}
```

**Errors:** Provider errors are mapped.

```bash
curl -s -X POST "https://<site>/api/method/whatsapp_next.api.v1.onboarding.complete_signup" \
  -H "Authorization: token <api_key>:<api_secret>" \
  -d request_key=c0ffee -d code=123456 -d password='S3cret!'
```

---

## login  *(admin-only)*

Signs in to the platform with an e-mail and password and stores the credentials the platform
returns (`set_password`, audited as `Credentials Changed`), then links the site. **No key is ever
part of the response.**

- **Path:** `whatsapp_next.api.v1.onboarding.login`
- **Methods:** POST
- **Roles:** `SYSTEM_MANAGER`

| Argument | Type | Required / default | Meaning |
|---|---|---|---|
| `platform_base_url` | str | **required** by the signature; send `""` to use the default | When it is non-empty and differs from the stored value, it is saved first. When it is empty, Settings or the bench's `whatsapp_platform_base_url` is used. |
| `email` | str | required | Platform user |
| `password` | str | required | Platform password |

**Returns:**

```json
{
  "ok": true, "customer": "CUST-0001", "customer_name": "Acme",
  "credentials_stored": true,
  "connection": {"ok": true, "error": null},
  "webhook": {"ok": true, "status": "Active"},
  "devices": {"ok": true, "adopted": 2}
}
```

**Errors:**

| Exception | HTTP | When |
|---|---|---|
| `WAValidationError` | 417 | `Missing argument: platform_base_url` when it is omitted; "This site does not know where the WhatsApp platform is…"; "The platform returned no credentials for this account"; an invalid URL rejected by the Settings controller |
| — | 200 | A wrong e-mail or password is an answer, not an error: `{ok: false, message}` for the card to show |
| `WAProviderAuthError` | 424 | The platform refused this site's own credentials |

```js
await whatsapp.ui.call("onboarding.login", { platform_base_url: "", email, password });
```

---

## start_password_reset  *(admin-only)*

Starts a password reset for a platform user.

- **Path:** `whatsapp_next.api.v1.onboarding.start_password_reset`
- **Methods:** POST
- **Roles:** `SYSTEM_MANAGER`

| Argument | Type | Required / default | Meaning |
|---|---|---|---|
| `identifier` | str | required | E-mail or mobile, as the platform accepts it |

**Returns:** `{"ok": true, "status": "Pending", "request_key": "…", "message": null}`

**Errors:** Provider errors are mapped.

```js
await whatsapp.ui.call("onboarding.start_password_reset", { identifier: "ops@acme.sa" });
```

---

## get_password_reset_status  *(admin-only)*

Polls a password-reset request.

- **Path:** `whatsapp_next.api.v1.onboarding.get_password_reset_status`
- **Methods:** GET, POST
- **Roles:** `SYSTEM_MANAGER`

| Argument | Type | Required / default | Meaning |
|---|---|---|---|
| `request_key` | str | required | From `start_password_reset` |

**Returns:** `{"status": "Verified", "message": null}`

**Errors:** Provider errors are mapped.

```bash
curl -s "https://<site>/api/method/whatsapp_next.api.v1.onboarding.get_password_reset_status?request_key=abc" \
  -H "Authorization: token <api_key>:<api_secret>"
```

---

## finish_password_reset  *(admin-only)*

Ends a password recovery in one step: verifies the reset, sets the new password on the platform,
then signs this site in with it (`login`), so the person lands on a linked account.

- **Path:** `whatsapp_next.api.v1.onboarding.finish_password_reset`
- **Methods:** POST
- **Roles:** `SYSTEM_MANAGER`

| Argument | Type | Required / default | Meaning |
|---|---|---|---|
| `request_key` | str | required | From `start_password_reset` |
| `password` | str | required | New password, at least 8 characters |
| `code` | str | optional | The code from the e-mail (`channel: "email"`). Without it, the request must already be `Verified` or `Completed` (a WhatsApp reset is verified by the person's reply). |

**Returns.** Whatever `login` returns for the account's e-mail and the new password. On success:

```json
{
  "ok": true, "customer": "CUST-0001", "customer_name": "Acme",
  "credentials_stored": true, "account_switched": false,
  "connection": {"ok": true, "error": null},
  "webhook": {"ok": true, "status": "Active"},
  "devices": {"ok": true, "adopted": 2}
}
```

`login`'s other answers pass through unchanged, for example
`{"ok": false, "choose_account": true, "accounts": [...], ...}` when the customer has several
accounts.

**Errors:**

| Exception | HTTP | When |
|---|---|---|
| `WAValidationError` | 417 | "The password must be at least 8 characters."; no `code` and the request is not verified yet ("The code has not been confirmed yet."); the platform changed the password but returned no e-mail ("The password was changed. Sign in with it.") |
| Provider errors (mapped) | 4xx/5xx | A wrong code, an unknown or expired request |

**Realtime:** none.

```js
const r = await whatsapp.ui.call("onboarding.finish_password_reset", { request_key, password, code: "123456" });
```

---

## validate_coupon  *(admin-only)*

Asks the platform whether a coupon is usable and what it gives. It never redeems the coupon. An
unusable coupon is a normal answer, not an error.

- **Path:** `whatsapp_next.api.v1.onboarding.validate_coupon`
- **Methods:** GET, POST
- **Roles:** `SYSTEM_MANAGER`

| Argument | Type | Required / default | Meaning |
|---|---|---|---|
| `code` | str | required | Coupon code |
| `email` | str | optional | Prospective tenant's e-mail |
| `mobile` | str | optional | Normalised to E.164. An unparsable number is silently dropped. |

**Returns.** The platform's answer, unchanged.

```json
{"ok": true, "valid": false, "code": "WELCOME", "message": "Coupon expired", "reason": "expired"}
```

A valid coupon may also carry `reward_kind` and `reward_value`.

**Errors:** Provider errors are mapped.

```js
await whatsapp.ui.call("onboarding.validate_coupon", { code: "WELCOME" });
```

---

## get_referral_coupon

Returns this tenant's own referral coupon, for the "share and get a free month" card.

- **Path:** `whatsapp_next.api.v1.onboarding.get_referral_coupon`
- **Methods:** GET, POST
- **Roles:** `VIEWER_UP`

Arguments: none.

**Returns.** The platform's answer, unchanged.

```json
{"ok": true, "customer": "CUST-0001", "redemption_count": 3, "coupon": {"code": "ACME-REF", "…": "…"}}
```

**Errors:** Provider errors are mapped. On a site without credentials, expect
`WAProviderAuthError` (424).

```js
const ref = await whatsapp.ui.call("onboarding.get_referral_coupon");
```

---

## save_credentials  *(admin-only)*

Stores the platform URL and any of the four credentials by hand. Empty values are ignored. Values
are written with `set_password` and never logged or returned. It sets `credentials_updated_at`,
clears the provider cache, and is audited as `Credentials Changed` with `fields_written`.

- **Path:** `whatsapp_next.api.v1.onboarding.save_credentials`
- **Methods:** POST
- **Roles:** `SYSTEM_MANAGER`

| Argument | Type | Required / default | Meaning |
|---|---|---|---|
| `platform_base_url` | str | optional | https, with no trailing slash (validated by the Settings controller). An explicit `""` is also written. |
| `customer_api_key` | str | optional | Platform customer key |
| `customer_api_secret` | str | optional | Needed when the platform link requires the secret header |
| `api_key` | str | optional | Platform API key |
| `api_secret` | str | optional | Platform API secret |

**Returns:** `{"ok": true, "fields_written": ["api_key", "api_secret"]}`

**Errors:** `WAValidationError` (417) "Nothing to save" when nothing is given, or when the URL is
invalid.

```bash
curl -s -X POST "https://<site>/api/method/whatsapp_next.api.v1.onboarding.save_credentials" \
  -H "Authorization: token <api_key>:<api_secret>" \
  -d customer_api_key=ck_… -d api_key=ak_… -d api_secret=as_…
```

---

## sign_out  *(admin-only)* *(destructive)*

Unlinks the site from its platform account. First the site's webhook endpoint is removed on the
platform with the current keys (best effort: an unreachable platform never keeps the site signed
in). Then the four keys and the webhook secret are deleted, and the link's state is reset
(connection status `Untested`, webhook endpoint and status, `setup_completed`, the usage cache), so
the wizard opens on sign-in. Devices, messages, the queue, and everything the site set up stay.
Audited as `Credentials Changed` with `details: {what: "sign_out", webhook_removed}`.

- **Path:** `whatsapp_next.api.v1.onboarding.sign_out`
- **Methods:** POST
- **Roles:** `SYSTEM_MANAGER`

Arguments: none.

**Returns.** `webhook_removed` is `false` when the site had no endpoint or no keys, or the platform
call failed (logged to the Error Log).

```json
{"ok": true, "webhook_removed": true}
```

**Realtime:** none.

```js
await whatsapp.ui.call("onboarding.sign_out");
```

---

## get_account_switch  *(admin-only)*

Says what the previous platform account left after the site was linked to another one. A switch
deletes nothing: the previous account's devices are disabled and the switch is recorded until a
System Manager decides (`resolve_account_switch`).

- **Path:** `whatsapp_next.api.v1.onboarding.get_account_switch`
- **Methods:** GET, POST
- **Roles:** `SYSTEM_MANAGER`

Arguments: none.

**Returns.** `{"pending": false}` when no switch is waiting. Otherwise `from` / `to` are the
platform accounts (integration links), `at` the moment of the switch, and `counts` the rows per
DocType that existed before it: `WhatsApp Queue Item`, `WhatsApp Webhook Event`,
`WhatsApp Number Check`, `WhatsApp Status Post`, `WhatsApp Log`, `WhatsApp Inbound Message`,
`WhatsApp Number` (not modified since the switch), and the previous account's `WhatsApp Device`
rows.

```json
{
  "pending": true, "from": "INT-0007", "to": "INT-0012", "at": "2026-11-08 14:02:11",
  "counts": {"WhatsApp Queue Item": 3, "WhatsApp Webhook Event": 5210, "WhatsApp Number Check": 0,
             "WhatsApp Status Post": 1, "WhatsApp Log": 2400, "WhatsApp Inbound Message": 1730,
             "WhatsApp Number": 512, "WhatsApp Device": 1}
}
```

**Realtime:** none.

```js
const sw = await whatsapp.ui.call("onboarding.get_account_switch");
```

---

## resolve_account_switch  *(admin-only)* *(destructive)*

Records the System Manager's decision on what the previous account left.

- **Path:** `whatsapp_next.api.v1.onboarding.resolve_account_switch`
- **Methods:** POST
- **Roles:** `SYSTEM_MANAGER`

| Argument | Type | Required / default | Meaning |
|---|---|---|---|
| `action` | str | required | `delete` or `keep` |

- `delete` queues a `long` job (timeout 3600 s) that empties the references to the old devices
  (`device` on Campaigns, Notifications, and Notification Alerts, `reply_device` on Commands,
  `outbound_message` on Campaign Recipients), then deletes every row counted by
  `get_account_switch` in batches of 1 000, child rows and attached files included, and clears the
  switch. ERPNext Contacts are never touched. Audited as `Account Data Deleted` when queued
  (`stage: "queued"`) and when done (`stage: "done"`).
- `keep` clears the switch and keeps the rows (the old devices stay disabled). Audited as
  `Settings Changed` with `action: "previous_account_kept"`.

**Returns.** For `delete`, `counts` is what `get_account_switch` counted at the call;
`{"queued": false, "counts": {}}` when no switch was waiting. For `keep`, always
`{"kept": true}`.

```json
{"queued": true, "counts": {"WhatsApp Log": 2400, "WhatsApp Device": 1, "…": "…"}}
```

**Errors:** `WAValidationError` (417) for an `action` other than `delete` or `keep`.
**Realtime:** none.

```js
await whatsapp.ui.call("onboarding.resolve_account_switch", { action: "keep" });
```

---

## complete_setup  *(admin-only)*

Sets `setup_completed` once every step is done: credentials, connection OK, at least one
Connected device, and an Active webhook. It is idempotent, and audited as `Settings Changed` the
first time.

- **Path:** `whatsapp_next.api.v1.onboarding.complete_setup`
- **Methods:** POST
- **Roles:** `SYSTEM_MANAGER`

Arguments: none.

**Returns:** `{"setup_completed": true}`

**Errors:** `WAStateConflictError` (409) "Setup step <key> is not complete: <detail>", naming the
first missing step.

```js
await whatsapp.ui.call("onboarding.complete_setup");
```

# Permissions

`whatsapp_next` controls access in five layers. Each one is described in its own section below.

1. **Roles**: four product roles plus System Manager ([§1](#1-roles)).
2. **DocType permissions**: the standard Frappe matrix in each DocType JSON ([§2](#2-doctype-permission-matrix)).
3. **Page roles**: who may open the custom Desk pages ([§3](#3-page-permissions)).
4. **API role gates**: `@api_endpoint(roles=...)` on every whitelisted function ([§4](#4-api-role-gates), [§5](#5-the-api_endpoint-decorator)).
5. **The contextual layer**: `services/permissions.py` reaches core `Contact` data for users who
   have no native rights on it, with fixed field sets, filters in the query and an audit trail
   ([§6](#6-the-contextual-permission-layer)).

Outside those layers sit the command service user ([§7](#7-the-command-service-user)), the secret
fields ([§8](#8-secrets-and-settings)), the single guest endpoint ([§9](#9-the-guest-surface)) and the audit log
([§10](#10-audit-log)).

See [api/README.md](api/README.md) for per-endpoint details and
[architecture.md](architecture.md) for where these modules sit.

---

## 1. Roles

The four product roles ship as fixtures (`hooks.py` → `fixtures`, `whatsapp_next/fixtures/role.json`).
`install.ensure_roles()` also creates them on `after_install` / `after_migrate`, because the
fixture sync runs after `after_install`. All four have `desk_access = 1`.

| Role | Intended user | In one line |
|---|---|---|
| **System Manager** | Site administrator | Everything a Manager can do, plus Settings writes, credentials, onboarding and webhook setup |
| **WhatsApp Manager** | Owner of the WhatsApp operation | Creates and changes devices, campaigns, templates, commands, notifications and alerts; runs the queue; reads Settings and the audit log |
| **WhatsApp Agent** | Front-line user | Sends (Quick Send, resend, simulator), edits contact groups, confirms conversations; reads the rest |
| **WhatsApp Viewer** | Read-only user | Reads messages, campaigns, queue, devices and dashboards |
| **WhatsApp Contact User** | Someone who manages contacts without native `Contact` rights | Contacts screen, Numbers search, contact groups, picker; **no** message history unless also Viewer (D-029 OQ-5) |

**Administrator** passes every `api_endpoint` role gate (`_require_roles` returns early) and the
desktop-tile check. It is refused as the command service user ([§7](#7-the-command-service-user)).

### Role ladder used by the API

`whatsapp_next/api/v1/_roles.py` (D-055):

```python
SYSTEM_MANAGER = ("System Manager",)
MANAGER        = ("WhatsApp Manager", "System Manager")
AGENT_UP       = ("WhatsApp Agent", *MANAGER)
VIEWER_UP      = ("WhatsApp Viewer", *AGENT_UP)
CONTACT_USER   = ("WhatsApp Contact User",)
```

System Manager is always included at Manager level, because site admins administer the product
(D-055). The ladder is cumulative for the three operational roles: Viewer ⊂ Agent ⊂ Manager ⊂
System Manager. **Contact User is not on the ladder.** It is added explicitly where it applies,
and holding it grants nothing on the Viewer / Agent tuples.

### App tile

`hooks.add_to_apps_screen[...]["has_permission"] = "whatsapp_next.install.has_app_permission"`.
The desktop tile appears for Administrator and for any user holding one of the four product
roles or System Manager.

The `WhatsApp` workspace (`whatsapp_next/workspace/whatsapp/whatsapp.json`) is public and lists
the four product roles.

---

## 2. DocType permission matrix

Read from the `permissions` array of every `whatsapp_next/whatsapp_next/doctype/*/*.json`.
Legend: **R** read · **W** write · **C** create · **D** delete · **Rp** report · **E** export ·
**P** print · **S** select. No DocType grants submit, cancel, amend, import, e-mail or share, and
none uses `if_owner`.

| DocType | System Manager | WhatsApp Manager | WhatsApp Agent | WhatsApp Viewer | WhatsApp Contact User |
|---|---|---|---|---|---|
| WhatsApp Settings (single) | R W (level 0 **and** level 1) | R (level 0 only) | — | — | — |
| WhatsApp Device | R W C D Rp E S | R W C D Rp E S | R Rp S | R Rp S | — |
| WhatsApp Template | R W C D Rp E S | R W C D Rp E S | R Rp S | R Rp S | — |
| WhatsApp Campaign | R W C D Rp E S | R W C D Rp E S | R Rp S | R Rp S | — |
| WhatsApp Command | R W C D Rp E S | R W C D Rp E S | R Rp S | R Rp S | — |
| WhatsApp Notification | R W C D Rp E S | R W C D Rp E S | R Rp S | R Rp S | — |
| WhatsApp Notification Alert | R W C D Rp E S | R W C D Rp E S | R Rp S | R Rp S | — |
| WhatsApp Contact Group | R W C D Rp E S | R W C D Rp E S | R W C Rp S | R Rp S | R W C Rp S |
| WhatsApp Function | R W Rp S | R W Rp S | R Rp S | R Rp S | — |
| WhatsApp Log (outbound) | R Rp E P S | R Rp E P S | R Rp S | R Rp S | — |
| WhatsApp Inbound Message | R Rp E P S | R Rp E P S | R Rp S | R Rp S | — |
| WhatsApp Queue Item | R Rp E S | R Rp E S | R Rp S | R Rp S | — |
| WhatsApp Number | R Rp E S | R Rp E S | R Rp E S | R Rp E S | R Rp S |
| WhatsApp Webhook Event | R Rp S | R Rp S | — | — | — |
| WhatsApp Audit Log | R Rp E S | R Rp E S | — | — | — |

Child tables have no rows of their own and follow their parent: WhatsApp Campaign Message,
WhatsApp Campaign Recipient, WhatsApp Command Access, WhatsApp Command Access Entry, WhatsApp
Command Party Type, WhatsApp Contact Group Member, WhatsApp Function Output, WhatsApp Function
Setting, WhatsApp Notification Recipient, WhatsApp Notification Alert Recipient, WhatsApp
Settings Picker Source.

What the matrix says by design:

- **System-written tables have no C/W/D for anyone:** `WhatsApp Log`, `WhatsApp Inbound
  Message`, `WhatsApp Queue Item`, `WhatsApp Number`, `WhatsApp Webhook Event`, `WhatsApp Audit
  Log`. Services write them with `ignore_permissions`. Status fields on Log, Inbound, Queue
  Item, Device, Campaign and Webhook Event can additionally change only inside
  `services.guards.status_writer()` (D-038). A Desk save or REST write that touches them raises
  `WAStateConflictError`. A `WhatsApp Device` can only be **inserted** inside `status_writer()`
  (D-112): a device exists on the provider first.
- **`WhatsApp Function` has no C/D.** Functions come from the catalog install flow
  (`services/functions_catalog`); managers only toggle status and settings.
- **`WhatsApp Audit Log` is `in_create`**: no New button, and no role can write or delete rows.
  Rows come only from `services/audit.log` ([§10](#10-audit-log)).
- **Webhook Event payloads carry PII** (full bodies) and are readable by System Manager and
  WhatsApp Manager only. Terminal `message.*` payloads are blanked after processing.
- The app declares no `permission_query_conditions` or `has_permission` hooks for its DocTypes.
  Row-level narrowing for Contact data happens in the contextual layer instead.

### Settings field levels

`WhatsApp Settings` puts every secret at **permlevel 1**: `customer_api_key`,
`customer_api_secret`, `api_key`, `api_secret` (Password), `webhook_secret` (Password,
read-only) and `credentials_updated_at`. Only System Manager holds a level-1 row, so a
WhatsApp Manager reading the document sees no credential values
(`tests/test_registry.py::test_credentials_read_with_get_password_and_never_masked` asserts it).
See [§8](#8-secrets-and-settings).

---

## 3. Page permissions

From `whatsapp_next/whatsapp_next/page/*/*.json` → `roles`:

| Page (route) | Title | Roles |
|---|---|---|
| `wa-home` | Home | Viewer, Agent, Manager, System Manager |
| `wa-devices` | Devices | Viewer, Agent, Manager, System Manager |
| `wa-functions-center` | Functions Center | Viewer, Agent, Manager, System Manager |
| `wa-contacts` | Contacts | **Contact User**, Agent, Manager, System Manager |
| `wa-simulator` | WhatsApp Simulator | Agent, Manager, System Manager |
| `wa-settings` | Subscription, usage and settings | Viewer, Manager, System Manager |
| `wa-onboarding` | WhatsApp setup | Manager, System Manager |

A page role only decides whether the page opens. Every call the page makes is gated again by its
endpoint ([§4](#4-api-role-gates)). For example, a Viewer can open `wa-settings` but only reaches
the sections whose endpoints accept `VIEWER_UP` (usage). `get_settings` itself requires `MANAGER`.
A Viewer is not listed on `wa-contacts`: the Contacts endpoints accept Contact User or native
`Contact` permission ([§6](#6-the-contextual-permission-layer)).

---

## 4. API role gates

Every whitelisted function under `whatsapp_next/api/v1/` is declared with `@api_endpoint`
([§5](#5-the-api_endpoint-decorator)). The tuple in `roles=` is checked before the function
runs. `roles=None` means the function performs its own permission check in its body. Summary
per area (endpoint-level detail is in [api/README.md](api/README.md) and `api/<area>.md`):

| Area (`api/v1/…`) | Read endpoints | Write / action endpoints | Notes |
|---|---|---|---|
| `home` | `VIEWER_UP` | — | |
| `messages` | `get_outbound`, `get_inbound`, `get_inbound_summary`: `VIEWER_UP` | `resend`, `resend_many`: `AGENT_UP`; `cancel`: `MANAGER` | `get_conversation`: `roles=None`, requires **read on both** `WhatsApp Log` and `WhatsApp Inbound Message`, else `WAPermissionError` (D-029 OQ-5). The conversation drawer hides itself on 403 (OQ-11) |
| `queue` | `VIEWER_UP` | pause / resume / rate / items / dead-letter retry: `MANAGER` | |
| `campaigns` | progress, overview, recipients, readiness, failures, stats, timeline: `VIEWER_UP` | start / schedule / pause / resume / cancel (+ `_many`), `retry_failed`, `preview_message`, `get_poll_results`: `MANAGER` | |
| `quick_send` | `AGENT_UP` | `AGENT_UP` | |
| `bulk_send` | `MANAGER` | `MANAGER` | |
| `simulator` | `AGENT_UP` | `send_test`, `simulate_inbound`: `AGENT_UP`; `dry_run_command`: `MANAGER` | |
| `templates` | `AGENT_UP` | `preview`: `AGENT_UP` | |
| `devices` | `list_devices`, `get_device_stats`: `VIEWER_UP`; `poll_status`: `AGENT_UP` | create / pair / disconnect / delete / update / default / disable: `MANAGER` | |
| `commands` | `list_commands`: `VIEWER_UP` | every other endpoint: `MANAGER` | |
| `functions` | `get_catalog`, `get_manifest`: `VIEWER_UP` | install / update / remove / status / settings: `MANAGER` | |
| `notifications` | `MANAGER` | `MANAGER` | |
| `alerts` | `MANAGER` | `MANAGER` | `search` runs with the caller's own permissions |
| `settings` | `get_usage`, `get_site_usage`: `VIEWER_UP`; `list_picker_sources`: `AGENT_UP + CONTACT_USER`; `get_settings`, `list_audit_log`, `list_webhook_events_available`, `get_doctype_fields`: `MANAGER` | `save_settings`, `setup_webhook`, `set_webhook_status`, `set_webhook_events`, `rotate_webhook_secret`: **`SYSTEM_MANAGER`**; `test_connection`, `sync_subscription`, `test_webhook`: `MANAGER` | D-014 |
| `onboarding` | `get_status`: `VIEWER_UP + CONTACT_USER`; `get_referral_coupon`: `VIEWER_UP` | sign-up, sign-in, password reset, coupon validation, `save_credentials`, `complete_setup`: **`SYSTEM_MANAGER`** | |
| `phone` | `get_countries`: `VIEWER_UP + CONTACT_USER` | — | |
| `contacts` | all `roles=None` + `permissions.require("read")` | `create_contact`: `require("create")`; `update_contact`, `link_many`: `require("write")`; `toggle_blacklist`: `CONTACT_USER + AGENT_UP`, plus write on `WhatsApp Contact Group` in the service | Contact User **or** native `Contact` permission (D-055) |
| `numbers` | `get_number`, `search_numbers`: `VIEWER_UP + CONTACT_USER`; `get_conversation_log`: `roles=None` → `require("read")` in the service | `link_number`: `require("write")`; `convert_number`, `convert_many`: `require("create")`; `unlink_number`: `MANAGER`; `confirm_conversation`: `AGENT_UP` | |
| `picker` | sources, groups, members, contacts, doctype rows, upload / manual parse, classify: `PICKER_ROLES = AGENT_UP + CONTACT_USER` | `preview`, `commit_add`, `commit_remove`: `roles=None` + **write permission on the target document** (`frappe.has_permission(target, "write", doc=name)`); targets are `WhatsApp Campaign` and `WhatsApp Contact Group` only | D-055 |

Two patterns to copy when you add an endpoint:

- **Role-gated**: `@api_endpoint(roles=VIEWER_UP, methods=("GET", "POST"))` for reads and
  `@api_endpoint(roles=MANAGER)` (POST only) for writes.
- **Document-gated**: `@api_endpoint(roles=None)` and an explicit check first thing in the body:
  `permissions.require(ptype)` for Contact data, or `frappe.has_permission(doctype, ptype, doc=name)`
  raising `WAPermissionError`. Never leave `roles=None` without a check.

Writes belong in `services/`. The endpoint keeps its allow-list and response shaping (D-128).

---

## 5. The `api_endpoint` decorator

`whatsapp_next/api/_common.py`. It is the only way to whitelist a function in `api/` (D-039).
`tests/test_api_common.py::test_no_bare_whitelist_in_api_package` fails on a bare
`@frappe.whitelist`, and `tests/test_guest_surface.py` checks that every
`whatsapp_next.api.v1.*` whitelisted function carries the decorator's marker.

```python
def api_endpoint(*, roles=None, methods=("POST",), allow_guest=False, schema=None): ...
```

On each call it does the following, in order:

1. **Role gate.** When `roles` is non-empty, `_require_roles`: Administrator passes; otherwise the
   user must hold at least one of the roles, else `WAPermissionError` (HTTP 403).
2. **Argument coercion** (`coerce_arguments`). Request strings are coerced to the annotated types
   (`int`, `bool`, `float`, `str`, `list` / `tuple` / `set` / `dict` from JSON, `date`,
   `datetime`). An empty string for an `Optional` parameter becomes `None`. Unknown arguments
   raise `WAValidationError`, except `cmd` and `_`, and except when the function takes
   `**kwargs`. Missing required arguments raise `WAValidationError`. A bad value raises
   "Invalid value for …".
3. **Schema rules** (`schema={"arg": {"enum": [...], "max_length": n, "min": x, "max": y}}`),
   applied after coercion.
4. **Page cap.** `page_length` is clamped to 1…200 (`MAX_PAGE_LENGTH`).
5. **Provider error mapping.** A `providers.exceptions.ProviderError` raised inside becomes the
   matching `whatsapp_next.exceptions` class with its HTTP code (`map_provider_error`; table in
   [add-a-provider.md §5.4](add-a-provider.md#54-api-calls)).
6. **Whitelisting.** `frappe.whitelist(allow_guest=allow_guest, methods=list(methods))`. The
   default is **POST only**; read endpoints opt in to `("GET", "POST")`.

The wrapper is marked `__wa_api_endpoint__ = True` and keeps its role tuple in `__wa_roles__`,
which the surface tests read.

Error classes (`whatsapp_next/exceptions.py`) and their HTTP codes: `WAPermissionError` 403,
`WANotFoundError` 404, `WAStateConflictError` 409 (and `WADeviceOfflineError`,
`WAQueuePausedError`), `WAValidationError` 417 (and `WAInvalidPhoneError`, `WABlacklistedError`,
`WAUnknownNumberPolicyError`, `WAFileError`), `WAProviderRejectedError` 422,
`WANotSupportedError` 422, `WARateLimitError` 429, `WAProviderAuthError` 424,
`WAProviderUnavailableError` 503.

---

## 6. The contextual permission layer

`whatsapp_next/services/permissions.py` (D-044). It is the **only** module allowed to write core
`Contact`. `api/v1/contacts.py`, `numbers.py` and `picker.py` are thin wrappers over it.

### 6.1 Who may elevate

```python
ELEVATED_ROLE = "WhatsApp Contact User"

def can_elevate(ptype="read", user=None) -> bool:
    # Guest → False; Contact User role → True; else frappe.has_permission("Contact", ptype, user=user)

def require(ptype="read") -> None:   # WAPermissionError "Not permitted to {ptype} contacts"
```

So a user reaches Contact data through the product in one of two ways: holding the contextual
role, or already having native `Contact` permission for that `ptype`. Every public read or write
function starts with `require(...)`.

### 6.2 Declared field sets

The layer reads with `ignore_permissions`, but only through module constants. Clients never
choose the fields:

| Constant | Fields |
|---|---|
| `CONTACT_READ_FIELDS` | `name`, `first_name`, `last_name`, `full_name`, `salutation`, `designation`, `company_name`, `email_id`, `image`, `status`, `modified` |
| `CONTACT_PHONE_READ_FIELDS` | `phone`, `is_primary_mobile_no`, `is_primary_phone`, `wa_phone_e164` |
| `CONTACT_LINK_READ_FIELDS` | `link_doctype`, `link_name`, `link_title` |
| `CONTACT_WRITE_FIELDS` | `first_name`, `last_name`, `salutation`, `designation`, `company_name`, `email_id` |
| `CONTACT_PHONE_WRITE_FIELDS` | `phone`, `is_primary_mobile_no` |
| `CONTACT_LINK_WRITE_FIELDS` | `link_doctype`, `link_name` |
| `CONTACT_TABLE_KEYS` | `phone_nos`, `links` (rows replaced as a set) |
| `PARTY_TYPES` | `Customer`, `Supplier`, `Employee`, `Sales Person` |
| `ORDERABLE_FIELDS` | `CONTACT_READ_FIELDS` |

Payload validation (`_validated_payload`) rejects any key outside the write sets, phone rows with
keys other than `phone` / `is_primary_mobile_no` or an unparsable number, and links outside
`PARTY_TYPES` or to a missing party. Non-party `Dynamic Link` rows already on a Contact are kept
when party links are replaced. Only links to `PARTY_TYPES` are ever read back.

### 6.3 Filters in the query, not in the view

`_contact_query` builds one `frappe.qb` query on `Contact`. Every filter is an `EXISTS`
sub-query, so paging and counts are correct and nothing is filtered after the fact:

- search: `full_name` / `email_id` LIKE, or `EXISTS` a `Contact Phone` whose `phone` or
  `wa_phone_e164` matches;
- party: `EXISTS` a `Dynamic Link` to the given party;
- `has_whatsapp`: `EXISTS` a `WhatsApp Number` for one of the contact's phones (or `NOT EXISTS`);
- `blacklisted`: `EXISTS` a membership in the global blacklist group;
- `linked`: `EXISTS` any party link.

Page length is capped at 200.

### 6.4 Picker Source filters (`filters_json`)

The ContactPicker's third source lists rows of arbitrary DocTypes configured in
`WhatsApp Settings.picker_sources` (`WhatsApp Settings Picker Source`). `list_doctype_rows`:

- refuses a DocType that is not an **enabled** picker source (`WAPermissionError`);
- validates both the client filters and the row's server-side `filters_json` with
  `validate_filters(meta, filters)`: the fieldname must be a field of the DocType or a standard
  column (`name`, `owner`, `creation`, `modified`, `docstatus`, `idx`); the operator must be in
  `FILTER_OPERATORS` (`=`, `!=`, `in`, `not in`, `like`, `not like`, `>`, `<`, `>=`, `<=`,
  `between`, `is`); values may not be objects;
- merges **server filters first, then client filters**, so a client can narrow the set but never
  widen it (gap G-1, D-044);
- reads with `ignore_permissions` but returns only `name`, the title field (as `label`), the
  phone field or the linked Contact's primary phone, and `phone_e164`.

The same `validate_filters` runs when Settings is saved, so a bad `filters_json` never reaches
production.

### 6.5 Audit of elevated access

- **Reads** (`_audit_read`) write `Elevated Contact Read` (severity Info) **only when the session
  user holds the Contact User role**. Users with native `Contact` permission are not audited
  (D-029 OQ-3, D-044). This covers `list_contacts`, `get_contact`, `contact_stats`,
  `search_contacts`, `search_party` and `list_doctype_rows`. Details carry counts and filter
  names, not contact data.
- **Writes** always write `Elevated Contact Write` with `fields_written` (field names only), for
  create and update. Number linking, conversion, conversation confirmation and blacklist changes
  write their own actions (`Number Linked`, `Number Converted`, `Conversation Confirmed`,
  `Contact Group Members Changed`).
- The layer never calls `frappe.set_user`. Every row is written under the real session user.

### 6.6 Core `Contact` and role `All`

Frappe ships `Contact` with role `All` holding read / write / create. While that row exists, any
desk user can open `/app/contact` directly, whatever the product roles say (R-028). The app
**does not change core permissions** (D-125). It reports instead:
`permissions.contact_open_to_all()` lists the rights `All` still holds (effective meta, so Custom
DocPerm counts); `after_install` / `after_migrate` print a warning; the Settings Policy section
shows a banner linking to the Role Permission Manager. Removing that row is a manual site-admin
step; see [install-and-configure.md](install-and-configure.md).

---

## 7. The command service user

Inbound WhatsApp commands run allow-listed handlers from a registry, never a configurable dotted
path, and they run as a dedicated service user, never as Administrator (D-012).

- `install.ensure_command_service_user()` seeds `wa-commands@<site>` on install and migrate:
  **disabled**, `System User`, no welcome mail, and **all auto-assigned roles removed** (D-029
  02 OQ-4). `ensure_settings_defaults()` puts it in `WhatsApp Settings.command_service_user`.
- The Settings controller (`_validate_command_service_user`) runs only when `enable_commands` is
  on. It requires a user that exists, is enabled, is not `Administrator` and does not hold
  `System Manager`.
- At execution, `command_router._service_user()` checks the same conditions again
  (`WAStateConflictError` otherwise). `execute()` then switches with `frappe.set_user`, runs the
  handler, and restores the caller's user, session id, session data and `form_dict` in a
  `finally` block.
- The site admin grants the service user exactly the roles the installed functions need. The
  shipped catalog functions read through `frappe.db` and need none (D-123).

---

## 8. Secrets and Settings

- Credentials are **Password** fields at permlevel 1 (D-014, D-020): `customer_api_key`,
  `customer_api_secret`, `api_key`, `api_secret`, `webhook_secret` (read-only; fetched from the
  provider, never typed). Pair codes and QR payloads are never stored: `PairingPayload` lives in
  a 60 s cache.
- **Writing Settings is System Manager only (D-014).** The DocType grants Manager read at level 0
  only. `settings.save_settings`, the webhook set-up endpoints and every onboarding / credential
  endpoint require `SYSTEM_MANAGER`.
- `settings.get_settings` (`MANAGER`) returns sections by allow-list. Password fields surface only
  as `has_<field>` booleans (`SECRET_FIELDS`), and permlevel-1 values are never returned.
- Plaintext credentials are read in one place, `providers/registry.credentials()`, through
  `get_password`. `ProviderSettings.__repr__` hides them.
- Credentials are written by `services/onboarding.save_credentials` (with `set_password`) and by
  `services/webhook_setup.fetch_secret` (`set_encrypted_password`). Both are audited as
  `Credentials Changed`, and neither logs the value.
- `audit.sanitize_details` drops any detail key matching `key|secret|token|password|passwd|credential`,
  and the `WhatsApp Audit Log` controller refuses such keys again on insert.

---

## 9. The guest surface

The app has exactly **one** guest method:
`whatsapp_next.webhooks.v1.receiver.receive` (`@api_endpoint(allow_guest=True, methods=("POST",))`,
D-031). It authenticates each delivery by itself:

- the provider's envelope headers must be present;
- 600 requests per minute per source IP (D-029 OQ-P6);
- the webhook secret must be configured (else 503);
- HMAC signature and timestamp freshness (±300 s) are verified by the provider (D-013);
- the delivery is deduplicated on `(event_name, event_id)` (D-047);
- devices are resolved, never created.

Rejected deliveries are stored as `Ignored` with a blank payload. Processing happens in a `short`
job, not in the guest request. The step-by-step flow is in
[add-a-provider.md §7](add-a-provider.md#7-webhooks-end-to-end) and
[events-and-hooks.md](events-and-hooks.md).

`tests/test_guest_surface.py` enforces this. It imports every `whatsapp_next.api.v1.*` module and
asserts:

- the set of `whatsapp_next.*` functions in `frappe.guest_methods` is exactly
  `{"whatsapp_next.webhooks.v1.receiver.receive"}`;
- every whitelisted function under `whatsapp_next.api.v1.` carries `__wa_api_endpoint__`.

Adding `allow_guest=True` anywhere else fails the suite. The decorator's docstring says the same.

---

## 10. Audit log

`services/audit.log(action, *, reference=None, target=None, fields_written=(), reason=None, count=None, details=None, severity=None, summary=None, summary_args=None, user=None) -> str`
is the one insert function for `WhatsApp Audit Log`.

- It writes under `frappe.session.user`, or under `user` when a service passes it. In a scheduler
  or RQ job it also records `job_name`, and it records `ip_address` from the request.
- `fields_written` holds field **names** only, never values.
- `details` is sanitised: secret-like keys are dropped, phone-like keys and values are masked
  (`services.phone.mask`), strings are capped at 500 characters, and the result is stored as JSON.
  `summary_args` go to `details.summary_args`, and `summary` is an English template key
  translated at read time (D-029 fields OQ-C).
- Severity comes from `severity=`, else `SEVERITY_BY_ACTION` (`Device Deleted` → Danger;
  `Credentials Changed`, `Queue Items Deleted`, `Campaign Cancelled`, `Function Removed` →
  Warning; `Retention Purge`, `Connection Tested`, `Elevated Contact Read` → Info), else `Action`.
- The insert uses `ignore_permissions`. The DocType is `in_create` and no role holds write or
  delete, so rows are append-only. The controller rejects an empty summary and secret-like keys
  in `details` at any depth.

`action` options (from the DocType): Device Created, Device Connected, Device Disconnected,
Device Deleted, Credentials Changed, Settings Changed, Webhook Changed, Connection Tested, Queue
Paused, Queue Resumed, Queue Rate Changed, Queue Items Deleted, Queue Items Retried, Campaign
Started, Campaign Paused, Campaign Resumed, Campaign Cancelled, Campaign Recipients Changed,
Contact Group Members Changed, Bulk Send, Test Send, Elevated Contact Read, Elevated Contact
Write, Number Linked, Number Converted, Conversation Confirmed, Function Installed, Function
Updated, Function Removed, Command Changed, Command Deleted, Command Defaults Restored, Retention
Purge, Alert Test Sent. A new action needs a new option in the DocType JSON.

Who reads the log: System Manager and WhatsApp Manager (DocType read / report / export), and
`settings.list_audit_log` (`MANAGER`) for the Settings window. Rows are purged after
`WhatsApp Settings.audit_retention_days` by the retention job.

---

## 11. Checklist for new code

- A new DocType: give it a `permissions` array that follows the matrix above. System-written
  tables get read-only rows and a status-writer guard; configuration tables get
  Manager + System Manager write.
- A new endpoint: `@api_endpoint` with a tuple from `_roles.py`, or `roles=None` plus an explicit
  document check. POST unless it is a pure read. Never `allow_guest`.
- New access to core `Contact`: add a function to `services/permissions.py` with `require()`, a
  declared field set, `EXISTS` filters and `_audit_read` / `_audit_write`. Do not read `Contact`
  with `ignore_permissions` anywhere else.
- A secret: a Password field at permlevel 1 in Settings, read only through `registry.credentials()`.
- A privileged action: call `audit.log` from the service that performs it.

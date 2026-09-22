# Conventions — `whatsapp_next`

Complements `.claude/rules/*.md` (architecture, ui, security, platform, layout). Where the two
disagree, the rules win; this file only pins the details the rules leave open.

## Environment (verified 2026-09-22)

| Item | Value |
|---|---|
| Bench | `/home/snd/frappe-bench` |
| This app | `apps/whatsapp_next`, branch `version-16`, module `WhatsApp Next` |
| Dev site | `whatsapp.dev.sanad.digital` (frappe, erpnext, hrms, whatsapp_next) |
| Legacy app | `apps/snd_whatsapp`, branch `redesgin-integration-ui`, read-only, still installed on `acc.dev.sanad.digital` |
| Platform | `apps/snd_whatsapp_platform`, branch `feat/link-webhook-secret`, on `w-platform.dev.sanad.digital` |
| Frappe / ERPNext / HRMS | 16.28.0 / 16.29.0 / 16.14.0 |
| Python (bench env) | 3.14.7 |
| Node | 24.20.0 |

## Naming

- **DocTypes:** `WhatsApp <Noun>` in Title Case, singular: `WhatsApp Device`, `WhatsApp Outbound
  Message`, `WhatsApp Inbound Message`, `WhatsApp Campaign`, `WhatsApp Queue Item`, `WhatsApp
  Number`, `WhatsApp Contact Group`, `WhatsApp Command`, `WhatsApp Function`, `WhatsApp Template`,
  `WhatsApp Settings` (Single), `WhatsApp Audit Log`. Child tables: parent name + role, e.g.
  `WhatsApp Campaign Message`, `WhatsApp Campaign Recipient`, `WhatsApp Contact Group Member`.
- **Fieldnames:** `snake_case`, no `wa_`/`whatsapp_` prefix inside our own DocTypes. Phone fields
  are always named `phone` (raw as entered) and `phone_e164` (normalized, indexed; the only field
  ever compared). Status fields are named `status`, `Select`, Title Case options.
- **Custom fields on core DocTypes** (only if unavoidable): prefix `wa_`, declared as fixtures.
- **Roles:** `WhatsApp Manager`, `WhatsApp Agent`, `WhatsApp Viewer`, `WhatsApp Contact User`.
- **Python:** modules/functions `snake_case`; classes `PascalCase`; provider classes end in
  `Provider`; service modules are verbs or nouns of the job (`dispatch.py`, `campaign_runner.py`,
  `read_layer.py`, `phone.py`).
- **Whitelisted API (versioned, D-031):** `whatsapp_next.api.v<N>.<area>.<verb_noun>` — e.g.
  `whatsapp_next.api.v1.contacts.list_contacts`, `whatsapp_next.api.v1.devices.pair_device`,
  reachable at `/api/method/whatsapp_next.api.v1.contacts.list_contacts`. One package per API
  version (`api/v1/`, later `api/v2/`), one module per screen/area inside it; no business logic.
  A new version is a new package; older versions are never edited except for security fixes and
  are removed only after a documented deprecation period. `api/_common.py` (decorator, error
  mapping) is version-neutral. The inbound webhook receiver follows the same rule:
  `whatsapp_next.webhooks.v1.receiver.receive`. Platform side: `…api.v1.<fn>` (backend-plan-platform §E).
- **Pages:** folder `whatsapp_next/whatsapp_next/page/<slug>/` with slug `wa-<name>`:
  `wa-onboarding`, `wa-home`, `wa-devices`, `wa-functions-center`, `wa-simulator`,
  `wa-contacts`, `wa-settings`.
- **JS namespace:** `sanad.ui.<Component>` for the kit, `whatsapp_next.<page>` for page code.
- **Realtime events:** `wa:<entity>:<event>` — `wa:device:status`, `wa:message:status`,
  `wa:queue:progress`.
- **Scheduler / queue job names:** `whatsapp_next.services.<module>.<function>`; queues `short`
  (single sends) and `long` (campaigns, imports, nightly jobs).

## Module layout

```
whatsapp_next/
  hooks.py                       # whatsapp_providers, scheduler_events, app_include_js, fixtures
  whatsapp_next/doctype/...      # module "WhatsApp Next" — controllers thin
  providers/                     # base.py registry.py snd_platform.py meta_cloud.py exceptions.py schemas.py
  services/                      # phone.py read_layer.py dispatch.py campaign_runner.py command_router.py
                                 # numbers_materializer.py functions_catalog.py permissions.py audit.py
  api/                           # one module per screen/area, @frappe.whitelist only
  webhooks/                      # receiver.py (guest), verify.py, idempotency.py
  public/js/ui/<Component>/      # index.js + README.md   → whatsapp_next.bundle.js
  public/js/listview/            # listview_settings per DocType
  public/js/form/                # form scripts
  fixtures/                      # roles, custom fields, workspace
  tests/                         # see below
developer-docs/                  # phase 10 output (docs/ is the read-only prototype)
```

## Commit format

`<type>(<scope>): <summary>` in English, imperative, ≤ 72 chars. Types: `feat`, `fix`,
`refactor`, `test`, `docs`, `chore`, `plan`. Scope = area (`providers`, `queue`, `contacts`,
`kit`, `page/devices`, `plan`, `platform`). Body explains *why* when not obvious. One phase = one
or more commits on the phase branch; plan-only changes use `plan(<phase>): …`. Each phase works on
branch `phase-<n>-<slug>` off `version-16` and merges back at the end of the phase.

## i18n

- Every user-facing string in Python through `frappe._()` / `_()`, in JS through `__()`.
  No string concatenation of translated fragments — use placeholders `{0}`.
- Arabic is the primary UI language of the product; English is the source string. Translations
  live in `whatsapp_next/translations/ar.csv`, updated in the same commit as the string.
- RTL: use CSS logical properties (`padding-inline`, `margin-inline-start`, `inset-inline`);
  never `left`/`right` for layout. Dates/numbers via `frappe.datetime` / `frappe.format`.
- DocType labels and Select options in English in JSON; Arabic through translations only.

## Python style

- Ruff (project `pyproject.toml`), line length 110, tabs (Frappe default), `pyupgrade` target
  as configured by pre-commit. Type hints on every public function; docstring on every public
  function; a module header comment stating the module's role.
- `frappe.qb` / `frappe.get_all` first; raw SQL only with a `plan/decisions.md` entry.
- Never `frappe.db.commit()` in request code. Background work through `frappe.enqueue` with
  `job_name` and `queue` set explicitly. Every provider call wrapped to raise a
  `providers.exceptions.*` type — no raw `requests` exceptions leave `providers/`.
- Secrets read with `get_password()`; never logged, never returned.

## JS style

- ESLint + Prettier from the repo config. ES2020, no build-time framework; Frappe bundle only.
- Components: one folder per component, `index.js` exports a class on `sanad.ui`; constructor
  takes `{ wrapper, doctype?, ...options }`; all data through `frappe.call` / `frappe.xcall` to the
  `api/` layer; behaviour from `frappe.get_meta`, never hard-coded field lists.
- Pages: `frappe.pages["wa-x"].on_page_load` creates the page, mounts kit components, subscribes
  to realtime, and unsubscribes in `on_page_hide`.
- Colours only from Espresso variables (`--surface-*`, `--ink-*`, `--outline-*`); the prototype's
  own palette (`--pri`, `--ok`…) is mapped to Espresso equivalents at build time, never copied.
- No dead buttons: every action either calls the API or is not rendered.

## Test layout

```
whatsapp_next/tests/
  conftest_frappe.py            # site fixtures helpers (frappe.tests style, no pytest plugin needed)
  test_phone.py                 # E.164 normalization table-driven
  test_read_layer.py
  test_permissions_contextual.py
  test_providers_base.py        # contract test every provider must pass, run against a FakeProvider
  test_webhook.py               # signature, idempotency, rate limit
  test_numbers_materializer.py  # watermark, idempotent re-run
  test_queue.py                 # state machine, pause/resume, dead-letter
  fixtures/                     # sample payloads (json), sample vcf/csv/xlsx
whatsapp_next/whatsapp_next/doctype/<dt>/test_<dt>.py   # Frappe's per-DocType tests
```
Run: `cd /home/snd/frappe-bench && bench --site whatsapp.dev.sanad.digital run-tests --app whatsapp_next`.
No test may call the real platform: providers are swapped through the registry with a
`FakeProvider`. Every bug fixed gets a regression test in the same commit.

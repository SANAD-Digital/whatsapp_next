# WhatsApp Next: developer documentation

**WhatsApp Next** (`whatsapp_next`) connects ERPNext to WhatsApp. It is a Frappe v16 app built on a
**provider abstraction**. The first provider is the SND WhatsApp Platform (`snd_platform`). A Meta
Cloud skeleton (`meta_cloud`) exists only to prove the abstraction: every one of its network
methods raises `NotImplementedError`.

What it does:

- sends outbound messages through a queue with a status on every item (retry, back-off, dead letter,
  pause and resume)
- stores every inbound message and every status update the provider sends back. This app is the
  system of record, not the platform (D-011, D-021)
- runs campaigns, templates, notifications fired by document events (`WhatsApp Notification`) and
  report digests (`WhatsApp Notification Alert`)
- answers inbound **commands** with **functions**: Frappe Server Scripts (API, method `wa_fn_…`)
  that carry a `WA-FUNCTION` header and are installed in the Functions Center. A command runs only
  its installed function's script, never a path taken from data, and never as Administrator; the
  script's direct URL is refused by a guard (D-012)
- ships Desk pages (`wa-*`) and a portable UI kit (`sanad.ui`)

| | |
|---|---|
| Version | `0.1.0` (`whatsapp_next/__init__.py`; changes in `CHANGELOG.md` at the repo root) |
| Frappe / ERPNext | v16 (developed on Frappe 16.28.0, ERPNext 16.29.0). `required_apps = ["frappe", "erpnext"]` |
| Python | `>=3.10` (`pyproject.toml`). The dev bench runs 3.14, so avoid syntax that needs 3.12 or later (R-003) |
| Extra Python dependencies | `openpyxl`, `vobject` (Excel and vCard import in the ContactPicker) |
| License | MIT, © Sanad Digital. See [LICENSE](LICENSE) |

## The system in five minutes

1. **Every send runs in a background job** (D-010). An API call or a document hook writes a
   `WhatsApp Log` row and a `WhatsApp Queue Item` row. The per-minute `dispatch_tick` then sends a
   batch to the provider inside a `short` job.
2. **Status comes back by webhook.** The provider POSTs to
   `/api/method/whatsapp_next.webhooks.v1.receiver.receive`, the app's only guest endpoint. The
   receiver checks the HMAC signature and how fresh the request is, removes duplicates, stores a
   `WhatsApp Webhook Event` and hands the rest to a job.
3. **The layers are fixed.** DocType controllers stay thin. Business logic lives in `services/`.
   Only `providers/` does outbound I/O. `api/v1/` holds thin, role-checked endpoints and
   `webhooks/v1/` holds the receiver.
4. **Phone numbers are E.164 everywhere.** `services/phone.normalize` is the only function that
   normalises numbers. Group and LID JIDs pass through unchanged.
5. **Only one module reads outbound and inbound together**: `services/read_layer.py`, which holds
   the codebase's only `UNION` (D-043).
6. **Extend through hooks and Server Scripts.** Other apps add providers through the
   `whatsapp_providers` hook. Command functions are not hooks: they are `wa_fn_` Server Scripts on
   the site ([commands-and-functions.md](commands-and-functions.md)).

## Index

| File | What it covers |
|---|---|
| [architecture.md](architecture.md) | The layers, component and sequence diagrams, DocTypes, read layer, E.164, Numbers materialisation, queue states, realtime, scheduler, API versioning |
| [install-and-configure.md](install-and-configure.md) | Installing, what the install seeds, the onboarding wizard, every WhatsApp Settings field, site config keys, workers and scheduler |
| [standard-content.md](standard-content.md) | The standard templates, notifications and alerts the app ships, and what a migrate keeps |
| [test-lab.md](test-lab.md) | The Test Lab page: testing every part of the app with real messages |
| [add-a-provider.md](add-a-provider.md) | Writing and registering a new `BaseProvider` |
| [api/README.md](api/README.md) | API conventions: `api_endpoint`, roles, errors, paging, versioning |
| [api/settings.md](api/settings.md) | Settings, connection test, webhook registration, usage, audit log |
| [api/onboarding.md](api/onboarding.md) | Sign-up, sign-in, credentials, finishing setup |
| [api/home.md](api/home.md) | Home screen figures and activity |
| [api/devices.md](api/devices.md) | Device lifecycle and pairing (QR and 8-digit code) |
| [api/quick-send.md](api/quick-send.md) | Composer context, preview, single send |
| [api/messages.md](api/messages.md) | Outbound and inbound messages, conversation, resend and cancel |
| [api/bulk-send.md](api/bulk-send.md) | The bulk-send window |
| [api/simulator.md](api/simulator.md) | The WhatsApp Simulator |
| [api/testlab.md](api/testlab.md) | The Test Lab: health checks and real test runs |
| [api/queue.md](api/queue.md) | Queue summary, pause, resume, delete, retry, rate |
| [api/phone.md](api/phone.md) | Phone normalisation and the country catalogue |
| [api/numbers.md](api/numbers.md) | Materialised WhatsApp Numbers |
| [api/contacts.md](api/contacts.md) | The contacts screen (contextual permission layer) |
| [api/picker.md](api/picker.md) | ContactPicker sources and file import |
| [api/campaigns.md](api/campaigns.md) | Campaign lifecycle and progress |
| [api/templates.md](api/templates.md) | Message templates and rendering |
| [api/notifications.md](api/notifications.md) | Notifications fired by document events |
| [api/alerts.md](api/alerts.md) | Report digests (Notification Alerts) |
| [commands-and-functions.md](commands-and-functions.md) | Commands and functions end to end (Arabic): the `WA-FUNCTION` header, the run contract, the Server Script sandbox, routing step by step, security |
| [api/functions.md](api/functions.md) | The Functions Center: function scripts, install, update, values, Try |
| [api/commands.md](api/commands.md) | Inbound commands |
| [api/webhooks.md](api/webhooks.md) | The inbound webhook receiver contract |
| [events-and-hooks.md](events-and-hooks.md) | Hooks the app defines and uses, realtime `wa:*` events, webhook event names |
| [kit/README.md](kit/README.md) | The portable `sanad.ui` component kit, with one page per component under `kit/` |
| [permissions.md](permissions.md) | Roles, the permission matrix, the contextual layer for `WhatsApp Contact User` |
| [troubleshooting.md](troubleshooting.md) | Symptom → cause → fix |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Branches, commits, code rules, lint, tests, translations, assets |
| [LICENSE](LICENSE) | MIT |

## Where things live

```
whatsapp_next/                      # the app repo (apps/whatsapp_next)
├── whatsapp_next/
│   ├── hooks.py                    # providers, fixtures, doc_events, scheduler, assets, list/form JS
│   ├── install.py                  # after_install / after_migrate seeding
│   ├── boot.py                     # boot_session → frappe.boot.whatsapp_next
│   ├── exceptions.py               # WA* error hierarchy (HTTP codes)
│   ├── providers/                  # base.py registry.py snd_platform.py meta_cloud.py exceptions.py schemas.py
│   ├── services/                   # business logic (dispatch, inbound, command_router, function_header,
│   │                               # functions_catalog, function_runner, report_file, read_layer, phone, …)
│   ├── api/_common.py, api/v1/     # whitelisted endpoints, one module per area
│   ├── webhooks/v1/receiver.py     # the only guest endpoint; verify.py, idempotency.py, handlers.py
│   ├── whatsapp_next/doctype/      # 26 DocTypes (module "WhatsApp Next")
│   ├── whatsapp_next/page/         # wa_home, wa_onboarding, wa_devices, wa_contacts, wa_functions_center, wa_simulator, wa_test_lab, wa_settings
│   ├── public/js/ui/               # portable kit (sanad.ui), never imports whatsapp_next
│   ├── public/js/{screens,form,listview}/  # app-specific screens, form and list scripts
│   ├── public/scss/_tokens.scss    # the product palette (--wa-*)
│   ├── fixtures/                   # roles, Custom HTML Block, standard templates / notifications / alerts
│   ├── desktop_icon/, workspace_sidebar/   # app-level folders Frappe syncs itself
│   ├── whatsapp_next/custom/       # customizations of core DocTypes (Contact Phone.wa_phone_e164)
│   ├── translations/ar.csv         # Arabic
│   └── tests/                      # the app test suite
├── plan/                           # design plan; decisions.md has the "why" (D-###)
├── docs/                           # read-only HTML design prototype
├── scripts/                        # demo seeds, browser smoke checks; functions/wa_fn_*.py (repo copies of
│                                   # the function Server Scripts), setup_functions.py, setup_commands.py
└── developer-docs/                 # this documentation
```

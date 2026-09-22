# WhatsApp Next

WhatsApp integration for ERPNext (Frappe v16), built on a provider abstraction. The first provider
is the SND WhatsApp Platform; a Meta Cloud API skeleton proves the abstraction.

- Outbound and inbound messages, a status-driven queue, campaigns, templates, doc-event
  notifications and report digests, inbound commands bound to an allow-listed function registry.
- Desk-native UI (Espresso tokens) with a portable component kit under `whatsapp_next/public/js/ui/`.
- Every outbound call runs in a background job; the webhook receiver is the only guest endpoint.

## Installation

```bash
cd $PATH_TO_YOUR_BENCH
bench get-app $URL_OF_THIS_REPO --branch version-16
bench --site <site> install-app whatsapp_next
```

`bench migrate` creates the composite indexes and the `Contact Phone.wa_phone_e164` custom field.
The install seeds four roles (`WhatsApp Manager`, `WhatsApp Agent`, `WhatsApp Viewer`,
`WhatsApp Contact User`) and a **disabled** command service user (`wa-commands@<site>`).

## Layout

```
whatsapp_next/
  hooks.py                  provider registry, fixtures, doc events
  install.py                roles, service user, indexes
  exceptions.py             API error hierarchy (HTTP codes)
  whatsapp_next/doctype/    module "WhatsApp Next" — thin controllers
  providers/                base contract, registry, snd_platform, meta_cloud skeleton
  services/                 business logic (phone, dispatch, read layer, audit, ...)
  api/v1/                   whitelisted endpoints, one module per area (D-031)
  webhooks/v1/              inbound receiver (guest), verify, idempotency
  patches/v0_1/             composite indexes, one-time backfills
  fixtures/                 roles, custom field
  tests/                    app-level tests (run with `bench run-tests --app whatsapp_next`)
  translations/ar.csv       Arabic UI strings
```

Planning documents live in `plan/`; developer documentation is written in `developer-docs/`.

## Tests

```bash
cd $PATH_TO_YOUR_BENCH
bench --site <site> run-tests --app whatsapp_next
```

No test calls the real platform: providers are swapped through the registry with a `FakeProvider`.

## Contributing

This app uses `pre-commit` (ruff, eslint, prettier, pyupgrade):

```bash
cd apps/whatsapp_next
pre-commit install
```

Conventions: `plan/00-conventions.md`. Commit format `<type>(<scope>): <summary>`.

## License

MIT — Sanad Digital.

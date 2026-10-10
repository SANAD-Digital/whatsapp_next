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

`bench migrate` applies the `Contact Phone.wa_phone_e164` custom field
(`whatsapp_next/custom/contact_phone.json`, Frappe's Export Customizations format), and syncs the
standard content: Arabic templates, notifications and report alerts for a trading company
(`fixtures/standard_*.json`). Standard notifications and alerts arrive **switched off**; what you
enable or edit survives every later migrate. See `developer-docs/standard-content.md`.
The install creates four roles (`WhatsApp Manager`, `WhatsApp Agent`, `WhatsApp Viewer`,
`WhatsApp Contact User`) and a **disabled** command service user (`wa-commands@<site>`).

### Fonts

The WhatsappNext identity uses two fonts: **IBM Plex Sans Arabic** (Arabic) and **Sora** (Latin).
Both are under the SIL Open Font License 1.1.

- **In the browser, nothing to install.** The app ships them itself as woff2 in
  `whatsapp_next/public/fonts/` (the originals are in `brand/fonts/`), and `bench build` serves them.
- **On the server, install them once.** The server draws PDFs without a browser: the invoices,
  statements and print formats it attaches to WhatsApp messages. Without the fonts installed, an
  Arabic PDF falls back to whatever font the server happens to have.

```bash
# as the user the bench runs as (the one that renders PDFs)
apps/whatsapp_next/scripts/install_fonts.sh            # → ~/.local/share/fonts/whatsappnext
# or for every user on the machine
sudo apps/whatsapp_next/scripts/install_fonts.sh --system   # → /usr/local/share/fonts/whatsappnext
```

The script downloads the TTF files and their licences from the official Google Fonts repository,
installs them, and refreshes the font cache (`fc-cache`). It needs `curl` and `fontconfig`, and
it is safe to run again. Check with `fc-list | grep -E "IBM Plex Sans Arabic|Sora"`. Restart the
bench afterwards if PDFs were generated earlier, so the PDF renderer picks up the new fonts.

## Layout

```
whatsapp_next/
  hooks.py                  provider registry, fixtures, doc events
  install.py                the command service user; everything else is a file Frappe syncs
  exceptions.py             API error hierarchy (HTTP codes)
  whatsapp_next/doctype/    module "WhatsApp Next" — thin controllers
  providers/                base contract, registry, snd_platform, meta_cloud skeleton
  services/                 business logic (phone, dispatch, read layer, audit, ...)
  api/v1/                   whitelisted endpoints, one module per area (D-031)
  webhooks/v1/              inbound receiver (guest), verify, idempotency
  whatsapp_next/custom/     customizations of core DocTypes (Contact Phone.wa_phone_e164)
  desktop_icon/             the desktop tile (standard Desktop Icon)
  workspace_sidebar/        the sidebar
  fixtures/                 roles, one HTML block, standard templates / notifications / alerts
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

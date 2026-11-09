# Changelog

All notable changes to `whatsapp_next`. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versions follow [Semantic Versioning](https://semver.org/). Decision numbers (`D-nnn`) point to
`plan/decisions.md`, which holds the reasoning behind each change.

## [Unreleased]

### Added

- **The print format's page size is kept in the PDF** (`attachments.page_options`): wkhtmltopdf
  takes its page size from Print Settings only, so an A5 or receipt format came out A4 whenever
  wkhtmltopdf drew it (its own engine, or the fallback when Chrome does not start). The format's
  "Paper size" (Frappe 16; a receipt is its width on an A4-high page) or a CSS
  `@page { size: … }` in its CSS or HTML (a page name, two lengths in mm / cm / in, `landscape`)
  is now handed to wkhtmltopdf. Chrome already reads it itself.
- **"Keep the sent file on the document"** on each notification (`attach_to_document`, off by
  default, a switch under the print format in the editor): off, a notification's print is no
  longer attached to the document it is about — it is kept with the sent message only, so an
  invoice's attachments no longer grow with every send. A one-page print is turned into its PNG
  before it is stored (`attachments.as_sent`, also used by campaigns and template sends), so a
  message keeps one file, not a PDF beside its picture.
- **A one-page PDF goes out as an image** (WhatsApp Settings → Policy → "Send a one-page PDF as
  an image", on by default): `dispatch.create_outbound` stores a one-page PDF document again as a
  PNG (`attachments.pdf_as_image`, PyMuPDF) and sends it as an Image, so the recipient sees the
  invoice in the chat. Longer PDFs, any the conversion cannot read, and a report alert's PDF (the alert
  has its own PDF / PNG choice) go out as PDFs. PyMuPDF is
  now a declared dependency. The old app did this always; the helper had been ported but never
  called.
- **Standard content, shipped as fixtures** (`fixtures/standard_*.json`, declared in
  `hooks.py → fixtures`): 12 Arabic message templates, 10 notifications on ERPNext documents (sales
  invoice, receipt, full payment, due and overdue reminders, sales order, delivery reminder,
  delivery note, quotation, purchase order) and 4 report alerts (receivables, payables, daily
  sales, yesterday's ledger). Notifications and alerts arrive switched off, with no device and no
  phone number; recipients are document fields and roles.
- `services/standards.py`: the rules of a fixture sync for that content. What the site owns
  (on/off, device, recipients, print format, letter head, an alert's report filters, counters and
  timestamps) always survives a migrate. Shipped text and rules are updated only while the owner
  has not edited the record; a record he edited is never overwritten. `standards.restore` brings
  the shipped content back on request, `standards.overview` lists the state of every record.
- `developer-docs/standard-content.md`.
- **"Send message" on every business document's form** (`public/js/desk/form_send.js`, under the
  "WhatsApp" button group): opens QuickSend with the document as the message's reference, the
  recipient pre-filled from the document's contact number when it has one. Offered to Agents and
  Managers, never on the app's own, single or child DocTypes. A message sent with a reference is
  a `Form` message (`api.v1.quick_send.send`), which the platform files under the ERP.

### Fixed

- A message the queue gave up on (rejected at hand-over, a file that could not be built, the
  retries used up — `dispatch._dead_letter`) now writes its "could not be sent" line on the
  timeline of the document it was about, as a failure reported by the platform already did. So
  does a message `reconcile.assert_coherence(fix=True)` moves to `Failed`.

### Changed

- **A PDF is sent on a server as it is** (owner, 2026-11-09). When a format's PDF engine is not
  wkhtmltopdf and fails (Chromium not installed, or "Chromium took too long to start"), the
  document is rendered again with wkhtmltopdf; and a CSS `@import` without a full `https://` link
  is completed before wkhtmltopdf sees it (it stopped there with "ProtocolUnknownError").
  `attachments.pdf_engine`, `attachments.complete_css_imports`.
- **Phone fields open on the site's own country** (owner, 2026-11-09). The default region is
  Global Defaults → Country, else System Settings → Country, and reaches the page with the boot
  (`frappe.boot.whatsapp_next.region`). WhatsApp Settings no longer has a «Default Country» of its
  own (a copy taken at the first save went stale), the kit setup no longer pins `SA`, and a field
  takes the site's region once the country list loads unless the user chose another. The alert
  editor's test number is the kit's phone field too. Yemen's placeholder is `771 234 567`.
- **The last test number is remembered** (owner, 2026-11-09): a test run, a notification's or an
  alert's "Send a test", a campaign's test message and a template sent from its window offer the
  number last tested first (`sanad.ui.test_phone`, kept in the browser per user).
- **Ready-made content comes only from the platform's hub** (owner, 2026-11-09). The app no
  longer ships its 12 templates, 10 notifications and 4 alerts as fixtures
  (`fixtures/standard_*.json`, `services/standards.py`, `tests/test_standards.py` and
  `developer-docs/standard-content.md` are gone; see `developer-docs/ready-made-content.md`). A
  site keeps what it already has, and the hub offers each such record as an update. A hub alert
  that names its company as `__default_company__` gets the site's default company when it is
  installed, or when it runs on a site that had none then (`alerts.COMPANY_TOKEN`,
  `alerts.installed_filters`).
- The custom field `Contact Phone.wa_phone_e164` moved from `fixtures/custom_field.json` to
  `whatsapp_next/custom/contact_phone.json`, the file Frappe's *Export Customizations* writes and
  `sync_customizations` applies on install and migrate. The field, its index and its data are
  unchanged.
- `before_uninstall` removes the standard-content fingerprints the app keeps in `tabDefaultValue`.
- **`install.py` no longer creates what Frappe syncs from files.**
  - The desktop tile is `whatsapp_next/desktop_icon/whatsapp.json` (a standard Desktop Icon).
    `ensure_desktop_icons` is gone: it made the rows in code on every install and migrate, and a
    standard icon without a file is deleted by each migrate's orphan sweep. One tile is shown; the
    separate "WhatsApp Next" app tile is gone (`add_to_apps_screen` is not declared).
  - Composite indexes moved to `on_doctype_update()` in the seven controllers they belong to;
    `add_indexes` is gone.
  - `ensure_roles` is gone: every product role is named in a DocType's permissions, so Frappe
    creates it with the DocType; `fixtures/role.json` sets the properties.
  - Number Cards and Dashboard Charts are standard module documents
    (`whatsapp_next/{number_card,dashboard_chart}/`) instead of fixtures.
  - `after_install` creates the disabled command service user and names it in Settings;
    `after_migrate` only prints the Contact warning. The default country is no longer copied
    into WhatsApp Settings (the phone service already falls back to System Settings).

## [0.1.0] — 2026-09-28

First release. A WhatsApp integration for ERPNext on Frappe v16, built on a provider abstraction.
The SND WhatsApp Platform is the first provider, and a Meta Cloud skeleton shows how another provider plugs in.

### Added

**Provider layer**
- `BaseProvider` contract, normalised dataclasses, provider exceptions and a registry resolved
  from the `whatsapp_providers` hook. Nothing outside `providers/` imports a provider module.
- `snd_platform` provider: batch enqueue with `client_ref`, status lookup, device lifecycle
  (QR code and 8-digit pairing code), account, plan, wallet and usage, and webhook-endpoint management.
  It sends `X-SND-API-Secret` with the link's own secret (D-130).
- `meta_cloud` skeleton that raises `NotImplementedError` and proves the contract.

**Data model** (module *WhatsApp Next*)
- `WhatsApp Log` (outbound) and `WhatsApp Queue Item`, split 1:1 like Frappe's `Communication`
  and `Email Queue` (D-027). The queue is driven by status, with backoff and a dead-letter state.
  Deleting a message only changes its state.
- `WhatsApp Inbound Message`, `WhatsApp Webhook Event` (dedupe on `(event_name, event_id)`),
  `WhatsApp Device`, `WhatsApp Template`, `WhatsApp Number` (a materialised distinct view),
  `WhatsApp Audit Log`, `WhatsApp Contact Group`, `WhatsApp Campaign`, `WhatsApp Function`,
  `WhatsApp Command`, `WhatsApp Notification`, `WhatsApp Notification Alert`, and the single
  `WhatsApp Settings`.
- The only custom field on a core DocType: `Contact Phone.wa_phone_e164`, with a backfill patch (D-028).

**Services**
- E.164 normalisation in a single service, applied on every write and every comparison.
- A unified read layer, which holds the codebase's only `UNION`, used for conversations, duplicate
  detection and the Numbers job.
- Every send runs in a background job and none runs in a request (D-010). Dispatch claims rows with
  `SKIP LOCKED`, can pause globally or per campaign, and reconciles every five minutes.
- Campaign runner and a contact picker with six sources: groups, contacts, any configured DocType,
  Excel, vCard/CSV and manual entry.
- Doc-event notifications and report digests (alerts) ported from the legacy app. They go through
  the queue (D-016).
- Inbound commands map to a registry of allow-listed functions and run as a dedicated service user.
  Commands can never run a dotted path (D-012).
- A contextual permission layer for WhatsApp Contact Users, with declared field sets and `EXISTS`
  filters. Every read is audited (D-044).
- Nightly Numbers materialisation driven by a watermark, plus an incremental upsert. Also usage sync,
  retention and webhook setup.
- Realtime events: `wa:device:status`, `wa:message:status`, `wa:queue:progress`,
  `wa:campaign:status`, `wa:inbound:received`, `wa:pairing:status`, `wa:import:progress`.

**API and webhooks**
- Versioned API `whatsapp_next.api.v1.<area>.<fn>` (D-031), about 165 endpoints across 20 areas.
  Every endpoint uses the `api_endpoint` decorator, which enforces roles, HTTP methods and a schema.
- Guest webhook receiver `whatsapp_next.webhooks.v1.receiver.receive`. It verifies an HMAC-SHA256
  over `<timestamp>.<raw body>`, rejects requests outside a time window, and deduplicates events.
  It is the only guest endpoint.

**User interface**
- Portable component kit `sanad.ui` (`public/js/ui/`): about 34 components. The kit never imports
  app code, and a test enforces this.
- Desk pages: Home, Devices, Onboarding Wizard, Functions Center, Simulator, Contacts, Settings.
- Native lists built on the prototype's design (D-064) for Outbound, Inbound, Queue, Campaigns,
  Contact Groups, Commands, Numbers, Templates, Notifications and Notification Alerts.
- Windows ported from the prototype: Command Editor (D-132), Function Detail (D-133), bulk send
  (D-136), the composer's "+" menu (D-137), the combined subscription, usage and settings window
  (D-138) and the alert editor (D-139).
- The "WhatsApp" workspace with its own sidebar and a desktop tile (D-110, D-131). Full Arabic
  translation and RTL.

**Documentation**
- `developer-docs/`: architecture, install and configure, *Add a new provider*, API reference,
  events and hooks, kit reference, permission model, troubleshooting, and contributing guidelines.

### Changed
- Home sends a System Manager on a site not yet registered with its platform to the Onboarding
  Wizard, once per browser session. The redirect is switched on by default: `WhatsApp Settings.redirect_unregistered_to_wizard`
  now defaults to 1, and patch `v0_1.enable_wizard_redirect` sets it on existing sites (D-140).

### Fixed
- Leaving the Onboarding Wizard raised `this.stop_pairing_watch is not a function`, which stopped
  the next page from rendering.
- Home's "Setup is not finished" band no longer shows once every setup step is done. No screen
  sets `setup_completed` yet, so the band now checks the steps themselves.
- `PhoneField` never redrew once the server's full country list arrived. It checked a `$el` that
  is never set. It also called an undefined `groups_for` when no country was resolved.

### Security
- Every secret is a `Password` field. Only a System Manager can write Settings (D-014).
- The command service user is created disabled with no roles, and the router refuses Administrator
  or a System Manager as the service user (D-029).
- The platform's raw webhook payload is logged only behind a time-boxed flag (R-013).
- A template preview with no record chosen (`templates.preview`, the quick-send composer)
  rendered the newest record of the DocType whatever the user's permissions. It now uses the newest
  record the user can read.

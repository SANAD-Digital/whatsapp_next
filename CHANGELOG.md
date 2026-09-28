# Changelog

All notable changes to `whatsapp_next`. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versions follow [Semantic Versioning](https://semver.org/). Decision numbers (`D-nnn`) point to
`plan/decisions.md`, which holds the reasoning behind each change.

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

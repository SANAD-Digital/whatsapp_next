---
paths:
  - "**/*.py"
  - "plan/backend-plan*.md"
---

# Architecture — whatsapp_next

## Provider abstraction (the core of the product)
```
whatsapp_next/providers/
  base.py          # BaseProvider ABC — the contract
  registry.py      # resolve provider by name, from hooks
  snd_platform.py  # first concrete provider
  meta_cloud.py    # skeleton only — proves the abstraction, raises NotImplementedError
  exceptions.py    # ProviderError, AuthError, RateLimitError, DeviceOfflineError, ...
  schemas.py       # normalized dataclasses: NormalizedMessage, DeviceState, WebhookEvent, ...
```
`BaseProvider` covers at minimum: account/tenant linkage; device lifecycle (create, pair via QR
**and** 8-digit code, disconnect, status); send text / media / template / interactive; message
status lookup; contact and group lookup; webhook signature verification; webhook payload →
`WebhookEvent`; balance/usage read; health check.

Registration through a hook — nothing outside `providers/` imports a provider module directly:
```python
# hooks.py
whatsapp_providers = {"snd_platform": "whatsapp_next.providers.snd_platform.SndPlatformProvider"}
```

## Layering
```
DocType controllers → thin: validation + lifecycle only
services/           → business logic (dispatch, campaign runner, command router, read layer, ...)
providers/          → outbound I/O only
api/v<N>/           → @frappe.whitelist endpoints, versioned package per API version (D-031); thin, permission-checked, schema-validated
webhooks/v<N>/      → inbound endpoint, signature verify, idempotency, enqueue
public/js/ui/       → portable component kit (see ui.md)
```
- No business logic in `api/`. No HTTP calls in controllers.
- No `frappe.db.sql` unless the query cannot be expressed with `frappe.qb` / `get_all` — document
  every exception in `plan/decisions.md`.
- Every public function has a docstring; every module a header comment stating its role.

## Cross-cutting services (mandatory)
- **Unified message read layer** — the *only* place Outbound and Inbound are read together (the only
  `UNION` in the codebase). Consumers: the nightly WhatsApp Numbers job, duplicate detection in the
  ContactPicker, the conversation drawer, any cross-direction report. Outbound and Inbound are
  separate DocTypes by design (different fields and lifecycles), which makes this layer mandatory.
- **E.164 phone normalization** — one central service, applied on write into both message tables
  and everywhere numbers are compared.

## WhatsApp Numbers materialization
A real DocType, one row per normalized number — a stored `DISTINCT`, not the source of truth.
- Nightly scheduled job processes only rows newer than a stored **watermark**. Never full rebuilds.
- Normalize before comparing, then upsert (insert new; update counters, last seen, last direction).
- Plus a lightweight incremental upsert on message insert, enqueued — never in the request path.
- The job must be idempotent: re-running it changes nothing.

## Jobs, realtime, resilience
- `frappe.enqueue` for every outbound call — named queues: `short` for sends, `long` for
  campaigns and imports.
- Retry with exponential backoff; dead-letter state on the Queue DocType.
- Queue is a real DocType driven by status (`Queued` / `Sending` / `Paused` / `Deleted`) —
  deletion is a state change, never a row removal.
- `frappe.publish_realtime` for device status, message status ticks, queue progress.
- Scheduler events for reconciliation, usage sync, the nightly Numbers job, retention cleanup.

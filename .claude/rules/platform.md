---
paths:
  - "../snd_whatsapp_platform/**"
  - "plan/*platform*.md"
---

# snd_whatsapp_platform — compatible changes; fix debt (D-018, D-022)

- Work only on branch `whatsapp-next-integration` (off `feat/link-webhook-secret`, which is `main` + 8 commits).
- New DocTypes, fields and whitelisted methods are free. Security gaps and technical debt listed in
  `plan/05-platform-summary.md` are **fixed**, not preserved.
- **No renames, no removals, no breaking changes** to existing API contracts or payload shapes
  without raising them at a gate first. Existing consumers must keep working untouched.
  Exception decided by the owner: webhook endpoint states may be changed to match the spec
  (`Active / Disabled / Locked`, plus `Revoked`) — D-018.
- The platform is **not** the system of record for message data; the client stores it (D-021).
  Do not add retention or history features on the platform for the client's sake.
- Every new external endpoint is versioned, permission-checked, and documented as you build it.

## Documentation audience
`../snd_whatsapp_platform/docs/` serves an external developer integrating from **any** stack,
not only Frappe: authentication and credentials · base URL and versioning · every endpoint with
request/response examples in **curl, Python and JavaScript** · webhook contract (payload schema,
signature verification, retry and idempotency semantics) · device pairing (QR + 8-digit code) ·
error-code table · rate limits and quotas · sandbox guide · a 10-minute quickstart.

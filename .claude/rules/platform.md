---
paths:
  - "../snd_whatsapp_platform/**"
  - "plan/*platform*.md"
---

# snd_whatsapp_platform — additive changes only

- New DocTypes, new fields, new whitelisted methods only.
- **No renames, no removals, no breaking changes** to existing API contracts or payload shapes
  without raising them at a gate first. Existing consumers must keep working untouched.
- Every new external endpoint is versioned, permission-checked, and documented as you build it.

## Documentation audience
`../snd_whatsapp_platform/docs/` serves an external developer integrating from **any** stack,
not only Frappe: authentication and credentials · base URL and versioning · every endpoint with
request/response examples in **curl, Python and JavaScript** · webhook contract (payload schema,
signature verification, retry and idempotency semantics) · device pairing (QR + 8-digit code) ·
error-code table · rate limits and quotas · sandbox guide · a 10-minute quickstart.

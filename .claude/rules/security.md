---
paths:
  - "**/*.py"
  - "**/doctype/**/*.json"
  - "../snd_whatsapp_platform/**/*.py"
  - "../snd_whatsapp_platform/**/doctype/**/*.json"
---

# Security & permissions — acceptance criteria, not advice

## Baseline
- Secrets (API keys, tokens, webhook secrets) → `Password` fieldtype or site config. Never plain
  `Data`, never logged, never returned by an API, masked in the UI.
- Every `@frappe.whitelist()` method: explicit `frappe.has_permission(...)` or
  `frappe.only_for(...)`, typed argument validation, `allow_guest=False`.
- The webhook receiver is the **only** guest endpoint. It must verify an HMAC/shared secret,
  enforce idempotency on the provider's message ID, and rate-limit.
- Roles: at least `WhatsApp Manager`, `WhatsApp Agent`, `WhatsApp Viewer`, plus the contextual
  role below. A permission matrix per DocType; per-account isolation through User Permissions so
  one tenant never sees another's data.
- Message bodies and phone numbers are PII: no full payloads in error logs; a retention setting
  enforced by a scheduled cleanup job.
- Audit DocType records: connect/disconnect, credential change, bulk send, campaign start/stop,
  and every elevated write.

## Contextual permission layer
**Problem.** A user may manage contacts *inside this product* without permission on core `Contact`,
and vice versa. Frappe grants permission by role, not by the screen the user came from.

**Solution.** A dedicated role (e.g. `WhatsApp Contact User`) with **no permission on `Contact` in
the permission matrix**. Product screens read and write only through whitelisted functions that
check the role, then operate internally on an explicit, limited field set. Such a user is blocked
from `/app/contact` and from generic client APIs on `Contact`. Page permissions are independent of
DocType permissions, so the reverse direction needs no work.

**Three conditions — non-negotiable:**
1. **Scoped elevation.** Each function declares in advance the fields it reads and writes. Never
   accept a field name from the client. Never return the whole document.
2. **Filtering in the query**, never only in the view. UI filtering is not a permission.
3. **Audit every elevated write** under the real user — never anonymously as the system.

Used by: the custom Contacts page, the WhatsApp Numbers link/convert action, and ContactPicker
source 3 (filtering system DocTypes the user may not fully own).

# UI Strategy Matrix — `whatsapp_next`

Source of truth: `plan/00-screens-spec.md` (binding). This file is filled in phase 2 by
`ui-matrix-planner`; phase 0 records only the screen inventory below.

## Screen inventory (phase 0 — screens only)

| # | Screen | Spec § | Implementation | Create | Prototype file (`docs/screen/`) |
|---|---|---|---|---|---|
| 1 | Onboarding Wizard | 2 | Custom Page | — | — (not in prototype; Wizard component in `docs/component/`) |
| 2 | Home / Dashboard | 2 | Custom Page | — | `Hub Screen - Home` |
| 3 | Devices | 2 | Custom Page | yes | `Hub Screen - Devices` |
| 4 | Outbound (الصادر) | 2, 5.3 | Frappe list + form + Drawer | no | `Hub Screen - Outbound` |
| 5 | Inbound (الوارد) | 2, 5.3 | Frappe list + form + Drawer | no | `Hub Screen - Inbound` |
| 6 | Campaigns | 2, 5.4 | Frappe DocType + stats card + ContactPicker | yes | `Hub Screen - Campaigns` |
| 7 | Functions Center | 2, 5.6 | Custom Page (storefront over Functions DocType) | — | `Hub Screen - Functions` |
| 8 | Commands | 2, 5.5 | Frappe list, create/edit in modal | modal only | `Hub Screen - Commands` |
| 9 | Queue | 2, 5.1 | Frappe DocType, status-driven | no | `Hub Screen - Queue` |
| 10 | Templates | 2 | Frappe list + form (modelled on Email Template) | yes | `Hub Screen - Message Templates`, `Hub Screen - Notification Templates` |
| 11 | WhatsApp Simulator | 2 | Custom Page | — | `Hub Screen - WhatsApp Simulator` |
| 12 | Contacts (system) | 2, 4 | Custom Page (contextual permission layer) | yes | `Hub Screen - Contacts` |
| 13 | WhatsApp Numbers (أرقام الواتساب) | 2, 5.2 | Frappe list over materialized DocType + Drawer | system only | `Hub Screen - WhatsApp Contacts` |
| 14 | Contact Groups | 2 | Frappe DocType + ContactPicker | yes | `Hub Screen - Contact Groups` |
| 15 | Subscription, Usage & Settings | 2, 5.7 | Custom Page over existing settings Single | — | `Hub Screen - Settings`, `Hub Screen - Billing` |

Prototype screens with **no spec entry** (spec §2 default applies — native list/form unless
justified in writing at Gate 1): `Hub Screen - All Messages` (covered by the conversation drawer +
unified read layer, spec says a standalone Conversations screen is deliberately not built),
`Hub Screen - Demo` (prototype-only data showcase, not a product screen).

Prototype also contains the full app shell `WhatsApp Hub App-pro` (header + sidebar + navigation)
— in Desk this role is played by the Workspace and the Desk navbar, not by a custom shell.

**Deliberately not built:** standalone Conversations screen (spec §2).

## Per-screen strategy

_Filled in phase 2 by `ui-matrix-planner`._

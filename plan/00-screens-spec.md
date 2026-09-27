# Screen Specification — `whatsapp_next`

**Status: BINDING.** This file records decisions already made and approved by the product owner. It
**overrides agent judgement**. An agent may fill a gap this file does not cover, but may not
contradict anything it does. To deviate, raise it as a question at the nearest gate — never
silently.

Location: `plan/00-screens-spec.md`. Protected by a hook — only the product owner edits it, by hand.

---

## 1. UI platform decision (applies to everything below)

This product is built on the **Frappe Desk**, not on a Frappe UI / Vue SPA.

Rationale: the product is embedded in ERPNext — it links Contacts to Customers and Suppliers, and
selects recipients from system DocTypes using Frappe's own filters. The user is already in Desk.
Frappe UI supplies components but not the Desk machinery (meta-driven forms, list views, filters,
report view, bulk edit, permissions, print, export, workspaces); rebuilding that machinery would
contradict the project's founding principle of inheriting Frappe's future improvements.

Consequences, all mandatory:

- **Custom Pages are styled with the prototype's palette, held as CSS custom properties**
  (`--wa-*` in `public/scss/_tokens.scss`, light and dark: the `:root` block every
  `docs/screen/*.dc.html` opens with), never hard-coded colours. On this product's own surfaces
  those tokens re-point Desk's Espresso variables (`--surface-*`, `--ink-*`, `--outline-*`), so
  Desk components placed there follow the prototype and still switch with Desk's dark mode. The
  finished Desk lists stay on Desk's own palette. *(Amended 2026-09-27 per D-100 / D-129; was
  "styled with Desk's Espresso CSS custom properties".)*
- **Never mix the two UI worlds inside one screen.** Do not mount Vue + frappe-ui Tailwind inside a
  Desk page.
- **Every custom Page takes all of its data from an independently callable API layer.** No business
  logic and no data assembly inside page JS. This keeps a future alternative front-end additive and
  cheap, and is not a plan to rewrite anything.

---

## 2. Screen inventory

| # | Screen | Implementation | Create allowed | Key interactions |
|---|---|---|---|---|
| 1 | Onboarding Wizard (sign-up / sign-in / forgot password) | **Custom Page** | — | Unregistered users are redirected here from Home. **Enable this redirect only as the last step, after the build is complete** — during development Home stays directly reachable |
| 2 | Home / Dashboard | **Custom Page** | — | Must earn its place over a Workspace: live device status, campaigns sending now, queue health, click-through to detail |
| 3 | Devices | **Custom Page** | yes | Pairing by QR **and** 8-digit code, live status |
| 4 | Outbound (الصادر) | Frappe list + form | **no** | Monitoring view. Drawer for inspecting a record without leaving the list |
| 5 | Inbound (الوارد) | Frappe list + form | **no** | Monitoring view. Same drawer |
| 6 | Campaigns | Frappe DocType | yes | Stats card above list; Data tab + Contacts tab; ContactPicker; multiple messages |
| 7 | Functions Center | **Custom Page** | — | Catalog read from a JSON file; preview modal before install/update |
| 8 | Commands | Frappe list | yes, **modal only** | Edit only after stopping; restore defaults from the source function |
| 9 | Queue | Frappe DocType, status-driven — see §5.1 | no | Pause / resume; "deleted" is a state, never a row deletion |
| 10 | Templates | Frappe list + form | yes | Modelled on core `Email Template` |
| 11 | WhatsApp Simulator | **Custom Page** | — | Testing tool; also the target of the quick-send action |
| 12 | Contacts (system) | **Custom Page** | yes | Required by the contextual permission layer — see §4 |
| 13 | WhatsApp Numbers (أرقام الواتساب) | Frappe list over a **materialized DocType** | **system only** | Read-only; drawer with merged timeline; row action to create/link a Contact |
| 14 | Contact Groups | Frappe DocType | yes | A group of contacts (not a WhatsApp group). Members chosen with the same ContactPicker |
| 15 | Subscription, Usage & Settings | **Custom Page** | — | A view over the existing settings Single DocType. claude.ai-style: left section nav, right content pane |

**Default for anything not listed:** native Frappe list/form enhanced by the shared component kit.
Custom UI requires written justification.

**Deliberately not built:** a standalone Conversations screen. The need is met by the conversation
drawer (§3.1) opened from a WhatsApp Number or a Contact.

---

## 3. Shared components this spec requires

### 3.1 Drawer (side panel)
Inspect or preview a record from a list without opening its form. Used by Outbound, Inbound and
WhatsApp Numbers. Meta-driven and portable to any DocType.

Its most important variant is the **conversation drawer**: opened from a WhatsApp Number row (and
from a Contact), it shows outbound and inbound merged into one chronological thread, read through
the unified read layer (§6.1). This is what replaces a separate Conversations screen.

### 3.2 ContactPicker — the largest single component in the product
Used by Campaigns and Contact Groups, for **adding and for removing** recipients. One operation
handles one source type only.

Sources, all reachable from one modal:

1. **Contact Groups** — searchable with filters
2. **Contacts** — the system's contacts
3. **A system screen** — a whitelist of DocTypes exposed by app settings, then Frappe-style
   filtering on the chosen DocType. Reuse Frappe's own filter UI inside the modal; do not
   reimplement it. Reads here go through the contextual permission layer (§4)
4. **Excel** — upload, parse, preview before commit
5. **Phone export file** — import a contacts file exported from a phone: **vCard (.vcf)** primarily,
   CSV secondarily. This is a file import, not live reading of the device's address book
6. **Manual entry** — free-text field

Plus a **Selected tab**: chosen numbers and names with a live counter; a number already present in
the target table is flagged in red as a duplicate; the tab shows both *already added* and *still
available* counts. A confirmation step states the exact count before the add or the remove runs.

Duplicate detection compares **normalized E.164 values** (§6.2), never raw strings.

Treat this component as a sub-system with its own plan entry, not one item in a component list.

### 3.3 List stats card
Campaigns: one card above the list showing how many campaigns are currently sending; clicking it
opens a modal with the details. The pattern is available to any other list.

### 3.4 Quick send
**Decision:** a `QuickSend` composer component opened as a dialog — not a hand-off to the Simulator
as the primary path. It is reachable from the Outbound list, from Home, and from the WhatsApp
Numbers drawer; when opened from a context that already knows the number, it arrives pre-filled.
The dialog carries an "Open in Simulator" link for anything beyond a quick message.

Rationale: Outbound has no create permission, and sending one message must not require building a
campaign. Jumping to the Simulator for a one-line message loses the user's place; a dialog keeps
them where they were. The Simulator stays the full tool.

---

## 4. Contextual permission layer (architectural, applies in several places)

**The problem.** A user may be allowed to manage contacts *inside this product* without holding
permission on the core `Contact` DocType, and the reverse: an accountant with full `Contact` access
has no business in the WhatsApp product. Frappe grants permission by role, not by the screen the
user arrived from.

**The solution.** A dedicated role — e.g. `WhatsApp Contact User` — that holds **no permission on
`Contact` in the permission matrix at all**. The custom Contacts page reads and writes only through
whitelisted functions that check the *role*, then perform the operation internally on an explicit,
limited set of fields.

Result: such a user manages contacts from this product's screen, and is blocked if they open
`/app/contact` directly or call a generic client API on `Contact`. The reverse direction is free:
Page permissions are independent of DocType permissions.

**Three conditions, non-negotiable:**

1. **Elevation is scoped, never open.** Each function declares in advance which fields it reads and
   which it writes. Never accept a field name from the client and write to it. Never return the
   whole document — a user with contextual access to a name and a number must not receive the tax
   ID or linked bank details.
2. **Filtering happens in the query, not in the view.** If a user may only see certain contacts, the
   condition lives inside the query. UI filtering is not a permission.
3. **Audit every elevated write.** Records are created and modified under the real user, never
   anonymously as "the system". Losing attribution is the worst failure mode of elevation.

This same layer is reused by: the WhatsApp Numbers link/convert action (§5.2), and ContactPicker
source 3 (§3.2), where the user filters DocTypes they may not fully own.

---

## 5. Per-screen behaviour that affects the backend

### 5.1 Queue
Shows scheduled outbound messages, messages in state `Queued`, and messages in state `Sending`
(already inside a job). Pause and resume required. Deletion is a **state change**, never a row
removal.

**Decision: a real DocType driven by status** (`Queued` / `Sending` / `Paused` / `Deleted`), with a
list view customised to behave like a queue — not a Virtual DocType. Rationale: the Queue needs
filtering, sorting, row actions and bulk operations, all of which are cheaper and more reliable on
a real table. The agent verifies current Virtual DocType filtering behaviour on the installed
Frappe version and presents the evidence at Gate 1 before this is locked.

### 5.2 WhatsApp Numbers — materialized table
One row per unique number. **This table is not the source of truth**; Outbound and Inbound are. It
is a pre-computed, stored result of a `DISTINCT` across both, so the screen becomes an ordinary
indexed read instead of a full scan of two large tables on every page view. Storage cost is
negligible — numbers, not messages.

Fields: normalized E.164 number (unique key), display name if known, first seen, last seen,
outbound count, inbound count, direction of last interaction, link to `Contact`, and **link status
(linked / not linked)** — which is the **first column the user sees**, with a colour indicator.

Population:
- A **nightly scheduled job** processes only messages newer than a stored watermark (last processed
  timestamp). Never rebuild the whole table; full rebuilds work for the first month and become
  unmanageable afterwards.
- It normalizes every number (§6.2) *before* comparison, then upserts: insert new rows, update
  counters, last seen and last direction on existing ones.
- **Plus a lightweight incremental update on message insert** — bump the counter and last seen, or
  create the row if the number is new — executed in the background, never in the request path. Without
  this, a number messaged this morning would not appear until tomorrow. The nightly job then serves as
  reconciliation and repair.

Read-only: creation and deletion are blocked at the **DocType permission level**, not merely hidden
in the UI. A manually added row would be a lie — the table claims to represent numbers actually
messaged.

Row action — link or convert: a modal offering either linking to an existing Contact via search, or
creating a new Contact (name plus the linked party: Customer, Supplier or other) and linking it.
Executed by one whitelisted function that checks permission to create `Contact` before any write,
creates the Contact with the number in its phone table, then updates the link field and link status.

### 5.3 Outbound and Inbound — two separate DocTypes
Deliberately separate. Rationale is **different fields and different lifecycles**, not table size:
inbound arrives complete from the webhook with no send states, retries or scheduling; outbound
carries a queue, errors and retry logic. Both screens exist for **operational monitoring**, not for
reading conversations.

This separation makes §6.1 mandatory.

### 5.4 Campaigns
- A campaign may carry **more than one message**: model messages as a child table, rendered through
  a component if the UI needs it.
- Recipients are an ordinary child table; the ContactPicker writes into it.

### 5.5 Commands
Editing is blocked while a command is active — the user stops it first. A "restore defaults" action
re-reads defaults from the originating function. Create and edit happen in a modal, because the
input is complex.

### 5.6 Functions Center
Two parts with distinct roles: a **Functions DocType** holds the functions actually installed on
this site, and the **Functions Center page** is opened from it and acts as the storefront. The
Center reads its catalog from a JSON file. A preview modal shows what will change before install or
update. Treat it as a small catalog/versioning subsystem: versions, diff-before-update, and a record
of what is installed.

### 5.7 Subscription, Usage & Settings
Storage is the **existing settings Single DocType** — this page adds no new storage. The page is a
presentation layer over it, in claude.ai style: left-hand section navigation, right-hand content
pane.

---

## 6. Cross-cutting services

### 6.1 Unified message read layer
A single service that reads across Outbound and Inbound. It is the only place a `UNION` of the two
is written. Consumers: the nightly distinct job, duplicate detection in the ContactPicker, the
conversation drawer, and any report spanning both directions. Without it, the same union query ends
up duplicated in six places.

### 6.2 Phone number normalization (E.164)
One central service, applied on **write** into both message tables and everywhere a number is
compared. Everything depends on it: the distinct job, red duplicate flags in the picker, linking a
message to a contact, and grouping a conversation. Without it the same number is stored in several
formats and "no duplicates" silently stops being true.

---

## 7. Open decisions — resolve at Gate 1, never silently

1. **Virtual DocType filtering limits** on the installed Frappe version — investigate once, present
   evidence, then confirm §5.1 and decide whether the Functions Center could become a Virtual
   DocType instead of a custom Page.
2. **Post-build review, explicitly deferred, not forgotten:** whether the Wizard should become a
   modal rather than a Page, and whether Home should move to Insights components. Record the outcome
   in `plan/decisions.md`. Nothing in the build may assume these changes, and nothing may block them.

---

## 8. Out of scope here

`snd_whatsapp_platform` may later need a customer-facing portal for subscribers who never open
Desk. That is the one place where a Frappe UI SPA would be the right choice. It is a separate
decision and must not be generalized back onto `whatsapp_next`.

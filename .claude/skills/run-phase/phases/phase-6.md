# Phase 6 — Custom Desk pages

Build these pages: **Onboarding Wizard · Home · Devices · Functions Center · WhatsApp Simulator ·
Contacts · Subscription, Usage & Settings** — plus anything approved at Gate 1.

Every page meets the requirements in `.claude/rules/ui.md` (Espresso tokens, mobile-first, Arabic
+ English with RTL, loading/empty/error states, keyboard access, realtime where live) and takes all
data from the isolated API layer.

Page-specific points from the spec:
- Home must earn its place over a Workspace: live device status, campaigns sending now, queue
  health, click-through to detail.
- The redirect from Home to the Wizard for unregistered users is **not** enabled in this phase —
  it is the very last step of the build (phase 10).
- Settings is a presentation layer over the existing settings Single DocType; no new storage.

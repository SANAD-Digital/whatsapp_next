# Phase 4 — Backend & provider layer

Prerequisite: phase 3 complete, migrate clean.

Implement `plan/backend-plan.md` and `plan/backend-plan-platform.md`, in the build order they give:
providers (`BaseProvider`, registry, `snd_platform`, `meta_cloud` skeleton), services, the unified
message read layer, E.164 normalization, the contextual permission layer, API, webhooks
(verification, idempotency, rate limit), queue and retry, scheduler (including the nightly
WhatsApp Numbers job and its incremental companion), realtime.

Port legacy logic improved, typed, documented and tested — never copied.
The architecture and security rules load automatically as you touch those files; follow them.

# Repository layout — paths are relative to this app

The Claude project root is `apps/whatsapp_next` (this repo), **not** the bench.

| What | Path from here | Site |
|---|---|---|
| This app (whatsapp_next) | `.` | `whatsapp.dev.sanad.digital` |
| Legacy app (read-only, reference) | `../snd_whatsapp` | `acc.dev.sanad.digital` |
| Platform (additive changes only) | `../snd_whatsapp_platform` | `w-platform.dev.sanad.digital` |
| Bench root (`bench` commands) | `../..` | — |
| Design prototype (read-only input) | `docs/` — `screen/`, `component/`, `shared/` | — |
| Binding screen spec | `plan/00-screens-spec.md` | — |
| Developer docs written in phase 10 | `developer-docs/` | — |

There is no `CLAUDE.md`; app metadata comes from `hooks.py`. Run `bench` from `../..`
(`cd /home/snd/frappe-bench && bench --site whatsapp.dev.sanad.digital …`).

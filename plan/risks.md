# Risks register — `whatsapp_next`

| # | Date | Risk | Impact | Mitigation / owner | Status |
|---|---|---|---|---|---|
| R-001 | 2026-09-22 | `../snd_whatsapp` has 29 uncommitted changes on `redesgin-integration-ui` (hooks, patches, campaign DocType, webhook logs). Analysis in phase 1 reads the working tree, which may differ from any deployed version. | Legacy summary could describe unreleased behaviour. | `legacy-analyst` notes which findings come from uncommitted files; phase 8 auditor already receives `git status --porcelain`. | open |
| R-002 | 2026-09-22 | `../snd_whatsapp_platform` has 1 uncommitted change (`api/__init__.py`) on `feat/link-webhook-secret`. | Platform API contract may be mid-change. | `platform-analyst` records the diff; additive-only rule stays. | open |
| R-003 | 2026-09-22 | Bench Python is 3.14.7 — newer than what most Frappe 16 deployments run. | Library or syntax incompatibilities in production. | Write code compatible with 3.10+; avoid 3.12+-only syntax; note in developer docs. | open |
| R-004 | 2026-09-22 | `.claude/rules` globs with `../` (platform rules) may not be supported by the rules loader. | Platform rules not auto-applied when editing platform files. | Read `rules/platform.md` and `rules/security.md` manually at the start of any platform work. | open |
| R-005 | 2026-09-22 | `docs/README.md` said the prototype is flat and must not be split. | Agents reading the README could "fix" the layout back. | README rewritten to describe `screen/ component/ shared/` (commit 13a7a0f). | closed |
| R-006 | 2026-09-22 | Prototype palette (`--pri`, `--ok`, IBM Plex) differs from Desk Espresso tokens the spec mandates. | Temptation to copy prototype CSS verbatim. | Conventions: map to Espresso at build time; UI rule forbids hard-coded colours. | open |
| R-007 | 2026-09-22 | Spec §7 OD-1 (Virtual DocType behaviour) unresolved. | Queue / Functions Center design could change after Gate 1. | Investigate once in phase 2 with evidence on Frappe 16.28. | open |

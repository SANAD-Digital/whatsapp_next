# Contributing

This page is drawn from `plan/00-conventions.md` and `.claude/rules/*.md` (architecture, security,
ui, platform, layout). Where the two disagree, the rules win. Record every design decision in
`plan/decisions.md` as a new `D-###` row, and every open risk in `plan/risks.md`.

## Branches and commits

- Phase work ran on `phase-<n>-<slug>` branches cut from `version-16`, the app's working branch,
  and merged back at the end of the phase. Keep one topic per branch.
- Commit format: `<type>(<scope>): <summary>` in English, imperative mood, ≤ 72 characters.
  - Types: `feat`, `fix`, `refactor`, `test`, `docs`, `chore`, `plan`
  - Scope is the area: `providers`, `queue`, `contacts`, `kit`, `page/devices`, `plan`, `platform`, …
  - The body explains *why* when that is not obvious. Commits often cite the decision, e.g.
    `feat(alerts): … (D-139)`.
- Every bug fix gets a regression test **in the same commit**.
- Work on the platform (`../snd_whatsapp_platform`) happens only on branch
  `whatsapp-next-integration`. Changes there must be additive: no renames, no removals, no
  breaking changes to existing API contracts (`.claude/rules/platform.md`).

## Code layout rules

| Rule | Where it is enforced |
|---|---|
| Controllers are thin (validation and lifecycle only), with no HTTP calls | review |
| Business logic lives in `services/`. Every document write, state change and audit row goes through a service (D-128) | review |
| `api/v<N>/` only holds endpoints wrapped with `api._common.api_endpoint`: a role check, typed arguments, the list of writable fields, bulk orchestration and response shaping. **No business logic** | `tests/test_api_common.py` and `tests/test_guest_surface.py` fail on a bare `@frappe.whitelist` under `api/` |
| The webhook receiver is the **only** `allow_guest` endpoint | `tests/test_guest_surface.py` |
| Nothing outside `providers/` imports a provider module. Resolve it with `providers.registry.get_provider()` | review |
| No raw `requests` exception leaves `providers/`. Wrap every error in a `providers.exceptions.*` type | `tests/test_snd_platform.py` (error mapping), `tests/test_providers_base.py` (the contract every provider must pass) |
| **No `frappe.db.sql`** unless `frappe.qb` or `get_all` cannot express the query, and then with a `plan/decisions.md` entry. The codebase currently has none | review |
| Only `services/read_layer.py` reads outbound and inbound together (the only `UNION`) | review |
| Every phone goes through `services/phone.normalize`. Phone fields are named `phone` (raw) and `phone_e164` (normalised) | review |
| Status fields change only inside `services.guards.status_writer()` | controller `validate` guards (D-038) |
| No HTTP call, PDF render or `frappe.db.commit()` inside a web request or document hook. Background work uses `frappe.enqueue` with an explicit `queue` (`short` / `long`) and `job_id` (D-010) | review |
| Secrets live in `Password` fields, are read with `get_password()`, and are never logged or returned. Message bodies and phones stay out of error logs | review, `services/errors._strip_pii` |
| Every elevated write is audited under the real user (`services/audit.py`) | review |
| Public functions have type hints and a docstring. Every module starts with a `# Module role: …` header comment | review |
| Names: DocTypes are `WhatsApp <Noun>`; fieldnames are `snake_case` with no `wa_` prefix inside our own DocTypes; custom fields on core DocTypes get the `wa_` prefix and ship as fixtures; pages are `wa-<name>`; realtime events are `wa:<entity>:<event>` | review |

## Lint and format

Python: ruff (`pyproject.toml`) with line length 110, **tabs**, double quotes, target `py310`. Keep
code runnable on Python 3.10 even though the dev bench runs 3.14 (R-003). JS and SCSS: ESLint and
Prettier. All of these run through pre-commit (`.pre-commit-config.yaml`):

```bash
cd apps/whatsapp_next
pre-commit install
pre-commit run --all-files
```

## Tests

```bash
cd /path/to/frappe-bench
bench --site <site> run-tests --app whatsapp_next                                  # full suite
bench --site <site> run-tests --app whatsapp_next --module whatsapp_next.tests.test_phone
```

- **Never run two full suites on the same site at the same time.** Concurrent runs deadlock and
  fail at random (R-034). Single `--module` runs are usually safe. Put a timeout on long runs
  (`timeout 1200 bench …`, plan/12-test-report.md).
- No test calls the real platform. Swap the provider with the `conftest_frappe.fake_provider()`
  context manager, which wraps `providers.registry.override_for_tests` around
  `tests/fake_provider.FakeProvider`.
- Tests leave site data alone (D-126). Fixture devices must have platform ids starting with
  `WAD-TEST-` / `WAD-APITEST-` (checked in `conftest_frappe.ensure_device`). Clean up with
  `conftest_frappe.delete_test_rows(doctype, filters)`, never a whole-table delete.
  `ensure_settings` restores any Settings field it changes.
- `ensure_settings` also sets `default_country = Saudi Arabia`. Code must never assume a region
  (D-037).
- Five tests need `wkhtmltopdf` (PDF rendering). Without it they fail with `OSError`, which is an
  environment problem, not a code failure.
- Browser checks: `scripts/browser_smoke.mjs` renders the screens headlessly. After touching the
  kit's `DataList` or `FilterBar`, run `scripts/list_checks.mjs` (D-076).

## Translations

- Python strings use `frappe._()`, JS strings use `__()`. Use `{0}` placeholders and never join
  translated fragments. DocType labels and Select options stay in English in the JSON.
- Arabic lives in `whatsapp_next/translations/ar.csv` and is updated **in the same commit** as the
  string. Regenerate it the way D-040 describes:
  ```bash
  bench --site <site> get-untranslated --app whatsapp_next ar /tmp/ar-untranslated.txt
  # translate, then
  bench --site <site> update-translations --app whatsapp_next ar /tmp/ar-untranslated.txt /tmp/ar-translated.txt
  ```
- `ar.csv` applies to the whole site. Translate **product words only**. A generic word such as
  "Start" or "Notifications" would change Frappe's own UI, so give the product label a specific
  source string instead (D-109).
- RTL: use CSS logical properties (`padding-inline`, `inset-inline`, …), never `left`/`right` for
  layout.

## The portable kit (`public/js/ui/`)

The kit must be copy-pasteable into any Frappe app (`.claude/rules/ui.md`, D-056):

- **No reference to `whatsapp_next`** anywhere under `public/js/ui/`. Components call
  `sanad.ui.call("<area>.<fn>")`, and the host app maps the keys in
  `public/js/whatsapp_next_setup.js` with `sanad.ui.configure({api, defaults})`.
- Every label goes through `__()`. Behaviour comes from DocType meta (`frappe.get_meta`), never
  from hard-coded field lists.
- Colours come only from tokens. `public/scss/_tokens.scss` (`--wa-*`) is the one place a colour
  value is written (D-100). Use logical CSS properties only.
- One folder per component with `index.js`, `style.scss` and `README.md` (a usage snippet, live
  use and design-gate notes). The component must also be imported in `ui/index.js` and the kit
  stylesheet.
- `tests/test_kit_portability.py` enforces all of the above. See [kit/README.md](kit/README.md).

## Building assets

```bash
cd /path/to/frappe-bench
bench build --app whatsapp_next      # whatsapp_next.bundle.js / .bundle.css
```

After changing `hooks.py` or adding a Python module, reload the web server and workers
(`bench restart`, or `kill -HUP` the gunicorn master) (R-039). Clear stale caches with
`bench --site <site> clear-cache` (see [troubleshooting.md](troubleshooting.md)).

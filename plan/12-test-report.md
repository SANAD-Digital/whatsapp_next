# 12 — Test report (phase 9)

## Purpose

Record what the phase 9 test runs show for `whatsapp_next` and `snd_whatsapp_platform`, what was
fixed on the way, and what is still open. Written 2026-09-27 in the Claude Cloud session.

## Environment

| Item | whatsapp_next | snd_whatsapp_platform |
|---|---|---|
| Site | `whatsapp.localhost` (the dev site, seeded demo data) | `platform-test.localhost` (created for this run) |
| Database | MariaDB | PostgreSQL 16 |
| Why this site | R-041 is closed (D-126): a run no longer touches site data, proven below | The platform's own clean-ups were not reviewed; the dev tenant the send path depends on lives on `platform.localhost`, so the suite ran on a separate site |
| Scheduler / workers | off / none | off / none |
| Missing tool | `wkhtmltopdf` (PDF rendering) is not installed in this container | — |

## Results

| Suite | Tests | Pass | Fail | Skipped | Notes |
|---|---|---|---|---|---|
| whatsapp_next, run 1 | 352 | 345 | 5 | 2 | all 5 need `wkhtmltopdf` |
| whatsapp_next, run 2 (back to back) | 352 | 345 | 5 | 2 | identical: runs are repeatable |
| snd_whatsapp_platform | 163 (155 + 8) | 163 | 0 | 0 | includes `test_patches.py` (P-12 idempotency) |

The five environment failures: `test_attachments.test_render_print_pdf_and_png`,
`test_alerts.test_render`, `test_alerts.test_run_preview_and_real`,
`test_command_router.test_render_outputs_and_send_test`, `test_api_alerts.test_preview_and_run_now`.
Each fails with `OSError: No wkhtmltopdf executable found`; the same tests passed before in
environments with the tool. They are not code failures.

### Site data before and after two full runs (whatsapp_next)

| Measure | Before | After |
|---|---|---|
| Inbound (demo devices / all) | 148 / 148 | 148 / 148 |
| Queue rows `DEMOQ-` | 205 | 205 |
| Demo campaigns | 11 | 11 |
| Contact groups / commands / numbers | 3 / 3 / 6 | 3 / 3 / 6 |
| E2E device `WA-DEV-010` | Connected | Connected |
| Platform credentials, webhook secret | set | unchanged (hashes compared) |
| `enable_commands` | 1 | 1 |

Outbound log grows by a few rows per run (rows a test creates on a non-test device, e.g. through
the default device); nothing is deleted.

## Fixed in phase 9

| Item | What | Where |
|---|---|---|
| R-041 | Test clean-ups scoped to test devices (`WAD-TEST-*` / `WAD-APITEST-*`) and the tests' own event ids; Settings restored per module; webhook tests off the real `WAD-00001` | D-126, `tests/conftest_frappe.py` |
| Settings restore | A link whose target a test deleted is restored empty (restoring it dangling broke 26 later tests) | `conftest_frappe._restore_settings` |
| Seeds | Demo seeds use only `DEMO` devices / campaigns; no future `creation` | `scripts/seed_demo_*.py` |
| Test scoping | `test_read_layer` and `test_smoke` no longer read site-wide state | D-126 |
| A-1 | Webhook header names behind the provider contract | commit `533ac59` |
| A-2 | Write paths moved to services | D-128 |
| A-3 | Home period read through `home.get_activity` | D-127 |
| Platform, PostgreSQL | Duplicate-insert test inside a savepoint (12 cascaded errors); JSON `details` read as dict or string (4 failures) | platform commit `1a944c9` |

## Gaps

| # | Gap | Impact | Next step |
|---|---|---|---|
| G-1 | `wkhtmltopdf` absent in the cloud container | 5 PDF tests cannot run here | Run them where the tool is installed (production / staging bench), or add it to the environment setup |
| G-2 | Settings `default_device` can end on a test device's value and then empty after a run | Dev-site convenience only; quick send picks a device explicitly | Reset with the seed or in Settings after a run |
| G-3 | The first full platform run did not exit after its second group (no output for 30 min); the rerun finished in 11 s | Unexplained hang | Watch for it in CI; run with a timeout |
| G-4 | Platform clean-ups not reviewed for whole-table deletes | Running the platform suite on a site with data may erase it | Keep running it on a dedicated site |

## Recommendations

1. Keep `platform-test.localhost` for platform runs; never run the platform suite on `platform.localhost`.
2. Before release (phase 10), run the five PDF tests on a bench with `wkhtmltopdf`.
3. Run both suites with a timeout (`timeout 1200 bench … run-tests`).

## Addendum 2026-09-27 (after D-129 / D-130)

| Suite | Tests | Pass | Fail | Notes |
|---|---|---|---|---|
| whatsapp_next | 353 | 344 → 346 after the fixes below | 5 (PDF) | new: G-06 / G-07 / D-130 tests |
| snd_whatsapp_platform | 164 (156 + 8) | 164 | 0 | new: link secret handed out, user secret refused |

Two tests failed once on the seeded site and were fixed, not retried: `test_api_queue.test_throughput_buckets`
counted the site's own send in the last five minutes (now measures its own difference, R-041), and
`test_notifications.test_hook_short_circuit_and_new_event` saved one document twice without reloading it
(a timing race; now reloads). After a run the cached `connection_status` may read `Failed` (a test
checks the connection against a failing fake); the next connection test corrects it.

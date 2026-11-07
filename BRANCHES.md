# Branches and Frappe versions

| Branch | Frappe / ERPNext | Python | Node | What it is |
|---|---|---|---|---|
| `main` | 16 | 3.14 | 24 | Where all work happens. |
| `version-16` | 16 | 3.14 | 24 | What Frappe 16 sites install. Follows `main`. |
| `version-15` | 15 | 3.10–3.14 (tested on 3.12) | 18+ (tested on 22) | What Frappe 15 sites install. Takes `main` by merge. |

## How a change travels

1. Commit to `main`, whatever the change is, unless it exists only because of Frappe 15.
2. Move `version-16` to `main`: `git push origin main:version-16`.
3. Merge into `version-15`: `git checkout version-15 && git merge main`.
4. On a Frappe 15 site run `bench --site <site> run-tests --app whatsapp_next` and open the screens the
   change touched. Tests alone do not catch layout differences.
5. Never merge `version-15` back into `main`.

A fix that works on both versions goes on `main`. A fix only Frappe 15 needs goes in
`whatsapp_next/compat_v15.py`, on `version-15`, so the rest of the code stays identical and merges stay
clean.

## What exists only on `version-15`

- `whatsapp_next/compat_v15.py`, and the line in `whatsapp_next/__init__.py` that loads it.
- `pyproject.toml`: `frappe = ">=15.0.0,<16.0.0"`.
- This file's "known gaps" below are kept current on both branches.

`compat_v15.py` makes Frappe 15 behave like 16 in these places. Each replaces Frappe's behaviour for
the whole process, so it affects other apps on the same site; each one is a bug fix or an addition that
Frappe 16 already has.

| Frappe 15 behaviour | Effect without the fix |
|---|---|
| `set_value` with an expiry skips the request's local copy | A read later in the same request or job returns the old value or nothing: command sessions, throttles, "once" flags |
| Any field whose name contains `_seen` is dropped from list reads, silently | `last_seen` and `first_seen` vanish from numbers and conversations; numbers look changed on every refresh |
| `get_list` has no `{"COUNT": "name", "as": "n"}` | Counts raise an error |
| `frappe.utils.jinja._get_jenv` does not exist | No template renders, so no templated message can be sent |
| `frappe.tests.IntegrationTestCase` does not exist | The test suite cannot load (tests only) |

## What to watch when writing code for `main`

- **Cache:** a new `frappe.cache` call is safe. `frappe.client_cache` does not exist on 15. `frappe.cache.exists`
  makes the key again on both versions, so never pass it a key from `make_key`.
- **Queries:** new `{"FUNC": ...}` fields only work through the shim for simple `COUNT`, `SUM`, `MAX`-style
  aggregates. Nested expressions need an addition to `_aggregate_field`.
- **Addresses:** on a server not run by supervisor or systemd Frappe 15's `get_url` adds the bench's port.
  Whatever the platform must reach goes through `webhook_setup._public_address`; outside a request `get_url`
  cannot know the public address at all, so a job never registers one (it keeps the endpoint's own).
- **Dates:** Frappe 15's `pretty_date` refuses a date string with a `T` in it. Pass it a `datetime`.
- **Scrolling:** on 16 `.main-section` scrolls; on 15 the window does. Do not measure `.main-section` without
  checking its `overflow`.
- **Desk files:** `workspace_sidebar/`, `whatsapp_next/sidebar/` and the `Workspace Sidebar` link in
  `desktop_icon/whatsapp.json` mean nothing on 15.

## Known gaps on Frappe 15

- The app's own sidebar does not exist there. The Pages have no side navigation; users get back through the
  breadcrumb to the WhatsApp workspace, which links to every screen.
- Desk lists show Frappe's "Filter By" column, which 16 does not.
- At phone width the template list overflows the window by a few pixels.
- Not yet tried on 15 with a real WhatsApp device: sending, receiving and pairing.

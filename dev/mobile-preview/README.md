# Mobile preview: the local Frappe sites on your phone (development only)

Public HTTPS URLs for the development sites of a Claude Cloud session, through a
**Microsoft Dev Tunnel**, so they can be opened from a phone. Everything keeps running inside the
session's VM. No production system, credential or configuration is involved, and no Frappe site
data or configuration is changed for the public hostname.

```
phone --HTTPS--> https://<id>-8101.<region>.devtunnels.ms --> devtunnel host (outbound connection)
      --> 127.0.0.1:8101 site_proxy.py (pins platform.localhost) --> 127.0.0.1:8001 gunicorn
phone --HTTPS--> https://<id>-8102.<region>.devtunnels.ms --> devtunnel host
      --> 127.0.0.1:8102 site_proxy.py (pins whatsapp.localhost) --> 127.0.0.1:8002 gunicorn
```

## Commands

Run as root (or as `frappe`) from the repository root, after the databases and Redis are up:

```bash
sudo dev/cloud-state/bootstrap-cloud.sh --session-start   # services (never exposes anything)
sudo dev/mobile-preview/start.sh                           # prints the two URLs
sudo dev/mobile-preview/status.sh                          # what runs, login, URLs
sudo dev/mobile-preview/verify.sh                          # all checks again (read-only)
sudo dev/mobile-preview/stop.sh                            # URLs go offline, tunnel kept
```

Or in one go: `sudo dev/cloud-state/bootstrap-cloud.sh --session-start --mobile-preview`.
Bootstrap never starts the preview without that flag, and the SessionStart hook never passes it.

`start.sh` output ends with:

```
PLATFORM MOBILE URL: https://....devtunnels.ms
WHATSAPP MOBILE URL: https://....devtunnels.ms
```

| Option | Effect |
|---|---|
| `start.sh --wait-login` | if a Microsoft login is needed, wait for it instead of exiting |
| `start.sh --local-only` | web servers and proxies only, no tunnel |
| `start.sh --no-verify` | skip the final verification |
| `stop.sh --tunnel-only` | stop only the tunnel host; the local sites keep running |
| `stop.sh --delete-tunnel` | also delete the tunnel at Microsoft (the next start gets NEW URLs) |
| `verify.sh --local-only` / `--safety-only` | subsets of the checks |

Exit codes of `start.sh`: `0` ok; `1` error or a verification FAIL; `3` Microsoft login needed.

## First run in a new session: Microsoft login

A new Claude Cloud session has no devtunnel login. `start.sh` then starts a device-code login and
stops cleanly with exit code 3:

```
MICROSOFT DEVICE LOGIN REQUIRED
  1. Open:  https://login.microsoft.com/device
  2. Enter: ABCD12345
  3. Sign in with the Microsoft account that owns the tunnel (the code expires after ~15 minutes).
Then run this command again: dev/mobile-preview/start.sh
```

Sign in on any device, then run `start.sh` again. Running it again before signing in shows the same
code, it does not create a new one. A GitHub login does not work in Claude Cloud: the session's
GitHub proxy blocks the device-login endpoint, so the tool uses a Microsoft account.

The login token is stored by the devtunnel CLI itself under `~frappe/.local/share/DevTunnels/`,
never in this repository and never in a dev-state snapshot.

## Same URLs across sessions

The tunnel is a resource of the Microsoft account, not of the VM. `start.sh` selects it in this order:

1. `MOBILE_PREVIEW_TUNNEL_ID` (environment), to adopt a specific existing tunnel;
2. the id remembered in `runtime/mobile-preview.tunnel-id` (same session);
3. the tunnel carrying the label `whatsapp-next-mobile-preview` (a new session, same account);
4. otherwise a new tunnel with that label, anonymous connect, 30-day expiry.

It then makes sure the tunnel has the label, HTTP ports 8101 and 8102, and anonymous connect.
The URLs stay the same for as long as the tunnel exists. Dev Tunnels deletes a tunnel after 30 days
without use; the next `start.sh` then creates a new one, with new URLs.

## What each piece does

| Behaviour | Where |
|---|---|
| gunicorn per site on `127.0.0.1:<web_port>`, `frappe.app:application_with_statics()` (serves `/assets` and `/files`) | `start.sh` |
| `X-Frappe-Site-Name: <site>` on every request, so Frappe serves the right site whatever the public hostname | `site_proxy.py` |
| `/files/` requests: Host rewritten to the site, because Frappe's static-file middleware (`frappe/middlewares.py`) picks `sites/<Host>/public/files` from Host only | `site_proxy.py` |
| `X-Forwarded-Proto: https` when missing: TLS ends at the tunnel, and Frappe must know the browser is on HTTPS (session cookies come back `Secure`) | `site_proxy.py` |
| Safety gate before the tunnel starts; nothing is hosted if it fails | `start.sh` -> `verify.sh --safety-only` |
| Tunnel login, selection, ports, anonymous access, host | `start.sh` |
| PID + command-line checks, so stale PIDs after a VM restart are never trusted or killed | `common.sh` |

### Verification (`verify.sh`, read-only)

- **Safety.** These listen on loopback only:
  - PostgreSQL, MariaDB (the Docker-published port), and every Redis port in `common_site_config.json`;
  - both gunicorn ports and both proxy ports.

  The scheduler must be disabled on every preview site, and no worker or scheduler process may run.
- **Per site, locally.** Requests go to the proxy with an arbitrary Host header (`mobile-preview.invalid`),
  which proves routing does not depend on the hostname. They check:
  - `/login` returns 200 and a Frappe page;
  - the first CSS and JS bundle that page references return 200 with the right content type;
  - `/api/method/ping` returns `pong`;
  - **correct site:** a public file unique to that site is served byte-identical, and the other
    site's unique file is not served.
- **Per site, publicly.** The same checks run through the tunnel URL, plus `/login` with an
  iPhone browser User-Agent.

The site-identity check uses files that already exist in `sites/<site>/public/files/`. It creates
none. A site without a public file gets a WARN for that one check.

## Runtime files

Everything generated at run time goes in `/home/frappe/.dev-state/runtime/`:
- the directory is 0700 and the files 0600, owned by `frappe`;
- it is outside every repository and is not part of a dev-state snapshot.

| File | Content |
|---|---|
| `mobile-preview-<site key>-web.{pid,log}` | gunicorn |
| `mobile-preview-<site key>-proxy.{pid,log}` | site proxy |
| `mobile-preview-site_proxy.py` | private copy of `site_proxy.py` (the checkout may not be readable by `frappe`) |
| `mobile-preview-tunnel.{pid,log}` | `devtunnel host` |
| `mobile-preview-login.{pid,log}` | pending device login |
| `mobile-preview.tunnel-id`, `mobile-preview.urls` | selected tunnel and its public URLs |

**Never committed:** Microsoft credentials, tunnel tokens, tunnel URLs or IDs, PIDs, logs, and secrets.
This directory's `.gitignore` also guards against runtime files being written here by mistake.

## Configuration (environment variables, all optional)

| Variable | Default |
|---|---|
| `MOBILE_PREVIEW_SITES` | `platform:platform.localhost:8001:8101 whatsapp:whatsapp.localhost:8002:8102` (`key:site:web_port:proxy_port`) |
| `MOBILE_PREVIEW_LABEL` | `whatsapp-next-mobile-preview` |
| `MOBILE_PREVIEW_TUNNEL_ID` | unset (adopt a specific tunnel) |
| `MOBILE_PREVIEW_TUNNEL_EXPIRATION` | `30d` |
| `MOBILE_PREVIEW_NAME` | `mobile-preview` (prefix of runtime files; a second instance needs its own) |
| `MOBILE_PREVIEW_RUNTIME_DIR` | `/home/frappe/.dev-state/runtime` |
| `MOBILE_PREVIEW_WEB_WORKERS` | `2` |
| `BENCH_DIR`, `FRAPPE_USER` | `/home/frappe/frappe-bench`, `frappe` |

A test instance beside the real one, with its own ports, tunnel and runtime files:

```bash
export MOBILE_PREVIEW_NAME=mp-test MOBILE_PREVIEW_LABEL=whatsapp-next-mp-test MOBILE_PREVIEW_TUNNEL_EXPIRATION=1d \
       MOBILE_PREVIEW_SITES="platform:platform.localhost:8011:8111 whatsapp:whatsapp.localhost:8012:8112"
sudo -E dev/mobile-preview/start.sh && sudo -E dev/mobile-preview/stop.sh --delete-tunnel
```

## Requirements

- **The devtunnel CLI.** `dev/cloud-state/cloud-environment-setup.sh` installs it to `/usr/local/bin`:
  - it downloads from `https://aka.ms/TunnelsCliDownload/linux-x64`, checks the file is an ELF
    binary that runs, and checks `DEVTUNNEL_SHA256` if you set it;
  - it installs the binary only, with no login;
  - it is optional for `--check`, so a session without it still starts.
- **Network access** to `*.devtunnels.ms`, `global.rel.tunnels.api.visualstudio.com`,
  `login.microsoftonline.com` and `login.microsoft.com` over HTTPS (port 443). The CLI uses the
  session's `HTTPS_PROXY`; local traffic never goes through it.
- **The sites and their data:** `bootstrap-cloud.sh` plus a dev-state restore.
- **Not provided:** realtime (socket.io) is not started, so live updates in the desk need a page
  refresh. The first visit from a phone browser may show a Dev Tunnels "Continue" page.

## Security notes

- **Who can open the URLs.** Anonymous connect means anyone with a URL can reach the login page
  (as with any public site), so development accounts must not share passwords with real systems.
  To take the sites offline, run `stop.sh`. `stop.sh --delete-tunnel` also removes the tunnel.
- **What is exposed.** Only the two proxy ports are, and only through the outbound tunnel
  connection. `start.sh` refuses to host the tunnel if any database, Redis, web or proxy port
  listens on a non-loopback address, or if a scheduler is enabled.

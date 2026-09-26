# wa-admin mock (development only)

A local stand-in for the wa-admin WhatsApp gateway that `snd_whatsapp_platform` calls. It lets the
platform's device, pairing, sending and webhook flows run in a development session without ever
reaching the production gateway or a real WhatsApp account.

- Standard library only (`http.server`); in-memory, deterministic state (counter-based ids).
- Binds to loopback only and rejects non-loopback clients; refuses to start without an admin secret.
- Never opens an outbound connection (no HTTP client, no callbacks to the platform).
- Implements only the 22 endpoints the platform actually calls, with the `{"ok": true, "data": ...}`
  envelope and the error texts the platform matches on (`not connected`, `device limit reached`, ...).

## How bootstrap starts it

```bash
sudo dev/cloud-state/bootstrap-cloud.sh --start-mock
```

1. **Discovery.** `WA_ADMIN_MOCK_DIR` from `dev/cloud-state/config/defaults.env`
   (`/home/user/whatsapp_next/dev/wa_admin_mock`); if `wa_admin_mock.py` is not there,
   `dev/wa_admin_mock` next to the bootstrap script, so any clone location works.
2. **Secret.** The mock must accept the `X-Admin-Secret` the platform sends. Bootstrap reads
   `wa_admin_secret` from the site whose `wa_admin_api_url` points at the mock port, which is correct
   after a restore too, and writes it to `~frappe/.dev-secrets/wa-admin-mock.secret` (0600). If no site
   has one yet, it generates a development secret there. The secret is never in Git.
3. **Start.** As the `frappe` user, detached: `wa_admin_mock.py --host 127.0.0.1 --port 18080`
   (`WA_ADMIN_MOCK_PORT`), log in `~frappe/wa-admin-mock.log`. If it is already running, it is left alone.

The platform site points at it with site config (development values, never production):

```
wa_admin_api_url = http://127.0.0.1:18080/api
wa_admin_secret  = <same value the mock uses>
```

## Development controls

Admin secret required: `GET /__mock/state`, `GET /__mock/requests` (request log without secrets),
`POST /__mock/reset`, and `POST /__mock/devices/<id>/state {"status": "connected"}` to simulate the
phone completing pairing. `disconnected` and `logged_out` are the other states.

## Tests

```bash
cd dev/wa_admin_mock
/home/frappe/frappe-bench/env/bin/python -m unittest test_wa_admin_mock -v
```

They drive the mock through the platform's real client (`gaide_whatsapp_api.py`, path overridable
with `WA_ADMIN_CLIENT_PATH`; skipped if absent) and fail on any non-loopback connection attempt.

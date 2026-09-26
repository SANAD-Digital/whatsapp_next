# Cloud dev-state: reproducible Frappe development across Claude Cloud sessions

Development only. Nothing here talks to a production server, database, API, WhatsApp service or
credential. Every service it starts listens on `127.0.0.1` only.

Every Claude Cloud session is a **new VM**: no process, database or file survives it. Continuity comes
from exactly two things:

| What | Comes from | Tool |
|---|---|---|
| Code (every app) | **Git** | the repositories, at the branch you work on |
| Data and state (databases, attachments, site config) | a **dev-state snapshot** | `save-dev-state.sh` / `restore-dev-state.sh` |

A snapshot never replaces Git: it records which commit each app was at, and warns loudly if code was
uncommitted or unpushed, but it does not carry code.

## The two layers

| Layer | File | Runs | Does |
|---|---|---|---|
| 1. Base image | `cloud-environment-setup.sh` | once, when Claude Cloud builds/caches the environment | Ubuntu packages, PostgreSQL 16, Redis, MariaDB client + dev libs, Docker CLI, `age`, `acl`, uv, Python 3.14, Node 24, Yarn 1.x, the `frappe` user, CA/TLS trust, Bench CLI, pre-pulled `mariadb:11.8` |
| 2. Session | `bootstrap-cloud.sh` | every session (or the SessionStart hook in its safe mode) | starts PostgreSQL, dockerd, MariaDB (reusing its volume), Redis; ensures repositories, bench and app links; restores only when asked; verifies |

Layer 1 never creates databases or sites, never leaves a service running, and holds no secret. Layer 2
never re-runs `bench init` on an existing bench, never recreates an existing MariaDB volume, never
switches a repository's branch and never restores unless asked.

### What goes where

| | Where it lives |
|---|---|
| Base packages and runtimes | Cloud environment setup script = contents of `cloud-environment-setup.sh` |
| Services, repositories, bench links, restore, verify | every session: `bootstrap-cloud.sh` (this directory, in Git) |
| Application code | Git (`config/repos.json` lists what bootstrap clones) |
| Databases, attachments, site configs, installed apps | the snapshot (local store, later R2, encrypted) |
| Infra secrets: DB root passwords (`~frappe/.dev-secrets/`) | generated per session by bootstrap; never in Git, never in a snapshot |
| Site secrets (`site_config.json`, `encryption_key`, app secrets) | only inside snapshots, which are private (0600) and encrypted before any upload |
| R2 credentials, age identity (private key) | Claude Cloud environment secrets / environment variables only |

**Copy into the Cloud environment settings** (environment menu in the session title bar, then Edit):
1. *Setup script:* the full contents of `cloud-environment-setup.sh`.
2. *Environment variables / secrets* (only when you enable remote storage):
   `DEV_STATE_BACKEND=r2`, `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`,
   `DEV_STATE_AGE_RECIPIENTS` (public key), `DEV_STATE_AGE_IDENTITY` (private key; needed only to restore).
3. *Repository access:* attach every private app repository (e.g. `snd_whatsapp_platform`) to the session.

## Commands

All run as root from this directory.

```bash
./bootstrap-cloud.sh [--restore-latest | --restore <id>] [--start-mock] [--start-web] [--with-r2] [-- <restore args>]
./bootstrap-cloud.sh --session-start      # fast and safe: services + verify + "snapshot available", never restores
./save-dev-state.sh [--label TEXT] [--include-dirty-patches] [--backend local|r2] [--no-publish]
./restore-dev-state.sh latest|<id>|<dir>|<package> [--dry-run] [--site S] [--as OLD=NEW]
                       [--force] [--yes] [--migrate|--no-migrate] [--keep-scheduler] [--no-pre-backup]
./verify-dev-state.sh                     # exit 1 when any FAIL line
./list-dev-states.sh [--backend local|r2]
```

Exit codes: `0` ok; `1` error; `2` restore not confirmed; `3` save kept locally but the remote upload was
blocked (no encryption configured).

## Workflows

**A. Save before leaving a session**
```bash
./save-dev-state.sh --label "what I was doing"
git -C /home/user/whatsapp_next status   # commit AND push code; the snapshot does not carry code
```
The save warns about dirty or unpushed repositories and lists the files. `--include-dirty-patches` also
stores the diffs inside the (private) snapshot, as a safety net, not as a substitute for Git.

**B. Open a new Claude Cloud session**
```bash
sudo dev/cloud-state/bootstrap-cloud.sh --start-mock --start-web
```
Repositories, bench and services come back. Data does not, until you restore it (C).

**C. Restore the latest state**
```bash
sudo ./restore-dev-state.sh latest --dry-run     # verify checksums, tools, apps, engines; print the plan
sudo ./restore-dev-state.sh latest --yes         # creates sites that do not exist yet
sudo ./restore-dev-state.sh latest --force --yes # also replaces sites that exist (a backup is taken first)
# or in one go: sudo ./bootstrap-cloud.sh --restore-latest -- --force --yes
```

**D. Restore a specific older state:** `./list-dev-states.sh`, then `./restore-dev-state.sh <id> ...`.
One site only: `--site whatsapp.localhost`. Beside the current one, without touching it:
`--as whatsapp.localhost=whatsapp-old.localhost`.

**E. Add a new app** (e.g. `hrms`, `payments`, `crm`, your own)
1. Add it to `config/repos.json` (`install: bench` for public apps, `soft-link` for a working copy you edit).
2. `sudo ./bootstrap-cloud.sh` (it adds missing apps; it never touches existing ones), then
   `bench --site <site> install-app <app>`.
3. `./save-dev-state.sh`. Apps are discovered automatically; nothing in the scripts names an app.
Restoring a snapshot that uses an app the bench lacks STOPS and names the app, repository, branch and commit.

**F. Add a new Frappe site:** create it as usual (`bench new-site x.localhost --db-type postgres|mariadb
--db-host 127.0.0.1 ...`). Every directory in `sites/` with a `site_config.json` is a site; each keeps its
own engine, so any mix of PostgreSQL and MariaDB sites works without changing a script.

**G. Save after adding the site:** `./save-dev-state.sh`, and check `dev-state-summary.md`.

**H. Recover after a broken migration**
```bash
sudo ./restore-dev-state.sh latest --site whatsapp.localhost --force --yes
```
The broken site is backed up to `~frappe/.dev-state/pre-restore/` first. If the code moved on since
the snapshot, restore migrates that site automatically. `--no-migrate` restores the data as-is.

**I. Multiple Claude sessions:** two sessions that restore the same snapshot get **independent copies**.
Changes in session A do not appear in session B. To hand data over: A runs `save-dev-state.sh`, B runs
`restore-dev-state.sh latest --force --yes`. Code moves through Git as usual.

**J. Another developer:** the same as I, plus access to the snapshot storage (R2 bucket) and to the
private age identity for decryption. Give each developer their own age key pair, and add every public
key to `DEV_STATE_AGE_RECIPIENTS`, so access can be revoked per person.

**K. Configure Cloudflare R2 later**
1. Create a bucket and an API token scoped to it (Object Read & Write) in Cloudflare.
2. Generate a key pair: `age-keygen -o dev-state.agekey`. Store the whole file as the secret
   `DEV_STATE_AGE_IDENTITY`, and its `# public key: age1...` line as `DEV_STATE_AGE_RECIPIENTS`.
3. Set `DEV_STATE_BACKEND=r2` and the four `R2_*` variables as Cloud environment secrets.
4. `sudo ./bootstrap-cloud.sh --with-r2` (creates the boto3 helper venv), then `./save-dev-state.sh`.
Object layout: `frappe-dev-state/snapshots/<ID>.tar.age`, `<ID>.meta.json`, and `latest.json`, which moves
only after the upload is verified (size + sha256). Nothing is ever deleted.

## Snapshot format

```
<ID>/                               e.g. 20260926T002112Z
  manifest.json                     no secrets: sites, engines, apps, versions, repos, warnings
  dev-state-summary.md              no secrets: human handoff
  checksums.sha256                  sha256 of every other file (sha256sum -c compatible)
  databases/<site>.postgres.dump    pg_dump custom format (restored with pg_restore)
  databases/<site>.mariadb.sql.gz   mariadb-dump (restored with mariadb)
  sites/<site>/site_config.json     SENSITIVE
  sites/<site>/{public,private}-files.tar.gz
  sites/<site>/row_counts.json      per-table row counts, used to verify a restore
  bench/common_site_config.json     SENSITIVE (kept for reference; not applied on restore)
  bench/apps.txt, apps.json, versions.json
  git/repositories.json             url / branch / commit / dirty files per app
  git/patches/                      only with --include-dirty-patches
```
Locally: snapshots in `~frappe/.dev-state/snapshots/`, published packages in `~frappe/.dev-state/store/`,
logs in `.../logs/`, pre-restore backups in `.../pre-restore/`. Everything is 0700/0600.

### Snapshot state vs. current-session infrastructure (on restore)

| Setting | Source on restore |
|---|---|
| `db_host`, `db_port`, `db_socket` | **this session** (`config/defaults.env`: PostgreSQL 127.0.0.1:5432, MariaDB 127.0.0.1:3306) |
| `db_name`, `db_user`, `db_password` | snapshot for a same-name restore; freshly generated for `--as` targets |
| `encryption_key` and every other key | snapshot (encrypted Password fields depend on the key) |
| `common_site_config.json` | not changed: Redis ports and the like belong to the bench |
| DB root passwords, MariaDB container/volume | this session's `~frappe/.dev-secrets/` |
| Scheduler | disabled after restore when the snapshot had it enabled (`--keep-scheduler` keeps it) |

## Security model

- Snapshots contain database dumps and site secrets: directories 0700, files 0600, owner `frappe`,
  never in Git (`.gitignore`), never printed. `manifest.json`, `dev-state-summary.md` and the
  backend `.meta.json` carry redacted config only, and are checked for leaks in testing.
- Encryption: [age](https://age-encryption.org) to X25519 recipients. Saving needs only the public
  key, so unattended saves hold no secret. Restoring needs the private identity from the environment.
- A remote upload of an unencrypted snapshot is refused (exit 3); the local snapshot is kept.
- Database passwords go through 0600 temp files (`PGPASSFILE`, `--defaults-extra-file`) or stdin,
  never through a command line.
- Restore verifies every checksum and every precondition before it touches anything, needs `--force`
  to overwrite, needs `--yes` or a typed confirmation, and backs up what it replaces.
- `verify-dev-state.sh` FAILs when a production URL (`PRODUCTION_URL_MARKERS`) appears in any site
  config, or when a site with `snd_whatsapp_platform` has no `wa_admin_api_url` (the platform
  would otherwise fall back to the production gateway).

## SessionStart hook (proposed, not installed)

`session-start-hook.sh` runs `bootstrap-cloud.sh --session-start` (about 5 s when the base image is
ready): it starts services, verifies, prints whether a snapshot exists, and always exits 0. It never
restores. It only acts in remote sessions (`CLAUDE_CODE_REMOTE=true`) running as root. To enable it,
merge this into `.claude/settings.json`:

```json
{"hooks": {"SessionStart": [{"hooks": [{"type": "command",
  "command": "\"$CLAUDE_PROJECT_DIR\"/dev/cloud-state/session-start-hook.sh", "timeout": 300}]}]}}
```

## Known limitations

- A snapshot is consistent per site, not across sites: the sites are dumped one after another.
- frappe/erpnext come from their branch head when a new bench is created; if that is newer than the
  snapshot's commit, restore migrates (see the plan). Exact old commits are not checked out automatically.
- `--as` renames a site, but URLs stored inside the data (e.g. another site's address) are not rewritten.
- The wa-admin mock (`WA_ADMIN_MOCK_DIR`) is not in Git yet; `--start-mock` skips it when absent.
- `cloud-environment-setup.sh` was verified idempotent on this image (`--check` and install mode);
  a from-scratch run happens only when Claude Cloud builds a fresh environment.

## Tests

```bash
sudo env PYTHONPATH=lib python3 -m unittest discover -s tests -v   # offline unit tests
```

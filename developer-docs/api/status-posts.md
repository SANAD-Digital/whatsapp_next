# status_posts

Module `whatsapp_next/api/v1/status_posts.py`. These endpoints are the actions of a
`WhatsApp Status Post` form: a WhatsApp status (story) posted from a device now or at a set time,
repeated daily or weekly, taken down, and its views read while it is up (24 hours). They are thin
wrappers over `services/status_posts.py`. Status posts are the plan feature `allow_status`.

Every endpoint also checks the **document permission** on the post: `write` for the actions,
`read` for `refresh_views`. A missing one raises Frappe's `PermissionError` (403).

| Endpoint | Roles | Document permission |
|---|---|---|
| `post_now`, `schedule`, `unschedule`, `delete_post` | `MANAGER` | write |
| `refresh_views` | `VIEWER_UP` | read |

Conventions are in [README.md](README.md). File name of this page: `status-posts.md`. Python
module: `status_posts`. Kit keys: `"status_posts.<fn>"`. Provider exceptions are mapped as
described in README §5.

### Post states

`Draft`, `Scheduled`, `Posting`, `Posted`, `Failed`, `Deleted`. A post's `kind` is `Text`, `Image`
or `Video`. An image or video is read from its `media` file and may be at most 16 MB.

The minute job (`post_due`) posts every `Scheduled` post whose `scheduled_at` has come, 20 at a
time. A failure there is kept on the post (`state = Failed`, `error`). Views of posts that are up,
or that expired in the last hour, are read every half hour.

A post with `repeat` (`Daily` or `Weekly`) queues its next copy when it is posted: a new
`Scheduled` post one day or one week after this one's time (moved forward past now), with
`repeated_from` set.

### Realtime

None of these endpoints publishes a realtime event.

---

## post_now

Posts the status now from its device. On success the post becomes `Posted`, with `status_id`,
`posted_at`, `expires_at` (24 hours later) and `view_count = 0`. Audited as `Status Posted`. A
repeating post queues its next copy.

- **Path:** `whatsapp_next.api.v1.status_posts.post_now`
- **Methods:** POST
- **Roles:** `MANAGER`

| Argument | Type | Required / default | Meaning |
|---|---|---|---|
| `name` | str | required | `WhatsApp Status Post` name |

The post must be `Draft`, `Scheduled`, `Failed` or `Posting`. Over this endpoint, a failure raises
and the request is rolled back, so the post keeps the state it had before the call.

**Returns:** `{"status_id": "3EB0A1B2C3D4E5F6"}`

**Errors:**

| Exception | HTTP | When |
|---|---|---|
| `WANotSupportedError` | 422 | The plan doesn't include status posts |
| `WAStateConflictError` | 409 | The post is already `Posted` or `Deleted`, or its device isn't `Connected` |
| `WANotFoundError` | 404 | The post's device doesn't exist |
| `WADeviceOfflineError` | 409 | The device isn't registered on the platform |
| `WAValidationError` | 417 | The image or video file is missing, or larger than 16 MB |
| Provider errors (mapped, README §5) | 4xx/5xx | The platform refused the post |

**Realtime:** none.

```js
const { status_id } = await sanad.ui.call("status_posts.post_now", { name: frm.doc.name });
```

---

## schedule

Sets the post to be posted at a time in the future by the minute job. The post becomes
`Scheduled`, with `scheduled_at` set and `error` cleared.

- **Path:** `whatsapp_next.api.v1.status_posts.schedule`
- **Methods:** POST
- **Roles:** `MANAGER`

| Argument | Type | Required / default | Meaning |
|---|---|---|---|
| `name` | str | required | `WhatsApp Status Post` name |
| `scheduled_at` | str | optional | A datetime (`2026-11-10 09:00:00`). Defaults to the post's own `scheduled_at`. |

**Returns:** `{"ok": true}`

**Errors:**

| Exception | HTTP | When |
|---|---|---|
| `WANotSupportedError` | 422 | The plan doesn't include status posts |
| `WAValidationError` | 417 | No time, or a time not in the future ("Choose a time in the future") |
| `WAStateConflictError` | 409 | The post isn't `Draft`, `Scheduled` or `Failed` |

**Realtime:** none.

```js
await sanad.ui.call("status_posts.schedule", { name: frm.doc.name, scheduled_at: "2026-11-10 09:00:00" });
```

---

## unschedule

Takes a `Scheduled` post back to `Draft`. A post in any other state is left as it is, and the
call still answers `ok`. The plan isn't checked.

- **Path:** `whatsapp_next.api.v1.status_posts.unschedule`
- **Methods:** POST
- **Roles:** `MANAGER`

| Argument | Type | Required / default | Meaning |
|---|---|---|---|
| `name` | str | required | `WhatsApp Status Post` name |

**Returns:** `{"ok": true}`

**Errors:** `PermissionError` (403) without write permission on the post.
**Realtime:** none.

```js
await sanad.ui.call("status_posts.unschedule", { name: frm.doc.name });
```

---

## delete_post  *(destructive)*

Takes a posted status down from WhatsApp. Its views are read one last time first. The post stays
here as `Deleted`, with its views, and `expires_at` set to now. Audited as `Status Deleted`. The
plan isn't checked.

- **Path:** `whatsapp_next.api.v1.status_posts.delete_post`
- **Methods:** POST
- **Roles:** `MANAGER`

| Argument | Type | Required / default | Meaning |
|---|---|---|---|
| `name` | str | required | `WhatsApp Status Post` name |

**Returns:** `{"ok": true}`

**Errors:**

| Exception | HTTP | When |
|---|---|---|
| `WAStateConflictError` | 409 | The post isn't `Posted` or has no `status_id` ("Only a posted status can be deleted from WhatsApp"), or its device isn't `Connected` |
| `WANotFoundError` | 404 | The post's device doesn't exist |
| `WADeviceOfflineError` | 409 | The device isn't registered on the platform |
| Provider errors (mapped, README §5) | 4xx/5xx | The platform refused the deletion |

**Realtime:** none.

```js
await sanad.ui.call("status_posts.delete_post", { name: frm.doc.name }, { freeze: true });
```

---

## refresh_views

Reads the post's views from the platform now and stores `view_count`, `viewers` and
`views_synced_at` on it. It is POST only, because it writes the counts.

- **Path:** `whatsapp_next.api.v1.status_posts.refresh_views`
- **Methods:** POST
- **Roles:** `VIEWER_UP`

| Argument | Type | Required / default | Meaning |
|---|---|---|---|
| `name` | str | required | `WhatsApp Status Post` name |

A post without `status_id` isn't asked about. A platform failure is logged, not raised. In both
cases the stored values are returned.

**Returns.** The post's stored counts after the read. Each viewer is the platform's
`{jid, number, viewed_at}`: `number` is digits without `+`, and `viewed_at` is a Unix time in
seconds (the form reads it with `moment.unix`).

```json
{"view_count": 2,
 "viewers": [{"jid": "966501234567@s.whatsapp.net", "number": "966501234567",
              "viewed_at": 1762683302},
             {"jid": "966507654321@s.whatsapp.net", "number": "966507654321",
              "viewed_at": 1762688444}]}
```

**Errors:** `PermissionError` (403) without read permission on the post.
**Realtime:** none.

```js
const { view_count, viewers } = await sanad.ui.call("status_posts.refresh_views", { name: frm.doc.name });
```

# Ready-made content: from the platform's hub

The app ships **no** ready-made message templates, notifications, report alerts, commands or
functions. A site takes them from the **hub** that the WhatsappNext platform publishes (owner,
2026-11-09). Until then the app shipped 12 templates, 10 notifications and 4 alerts as fixtures;
the hub holds all of them, and more.

## Where the entries live

On the platform, as `WhatsApp Hub` records: one per entry, with its type (`Function`,
`Template`, `Command`, `Alert`, `Notification`), its data (`payload`) and a checksum of that data.
They ship with the platform app (`snd_whatsapp_platform/fixtures/whatsapp_hub.json`), so every
platform offers the same set. To change or add one, edit it on a platform site and run
`bench export-fixtures` there, or edit the file; the checksum is recomputed when the record is
saved.

## On a site

Each screen of those five kinds has a **Hub** button (`services/hub.py`, `api/v1/hub.py`). It lists
the entries of its kind with a state:

| State | Meaning |
|---|---|
| Not installed | The site has no record for this entry. |
| Installed | The record was installed from this entry, and the entry has not changed since. |
| Update available | The entry changed since it was installed, or the site has a record of the same name that did not come from the hub. |

Installing:

- **Nothing sends by itself.** A notification or an alert arrives switched off; a command arrives
  stopped, because who may use it belongs to the site. A function (code) is installed only by a
  System Manager.
- **What an entry needs comes first.** A notification's template, a command's function
  (`payload.requires`) are installed with it when the site has neither the entry nor a record of
  that name.
- **The default company.** A report alert names its company as `__default_company__`
  (`alerts.COMPANY_TOKEN`). Installed, that becomes the site's default company (or its only one),
  so the alert's editor shows a real company. A site with no company yet keeps the marker, and
  the alert fills it in each time it runs (`alerts.resolve_filters`).
- **Updating** brings the hub's version of the record's set-up; what the site switched on or off
  stays as it was.

## Sites that had the old shipped content

Removing the fixtures removes nothing from a site: a migrate does not delete records whose
fixture file is gone. The records stay, as the site's own, and the hub offers each of them as an
**update** (a record of the same name). The four alerts the app used to ship still run for the
default company when their filters name none: their fingerprints in `tabDefaultValue` (parent
`__whatsapp_next_standards`) mark them, and `before_uninstall` deletes those rows.

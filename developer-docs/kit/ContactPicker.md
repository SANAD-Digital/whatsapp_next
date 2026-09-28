# `sanad.ui.ContactPicker`

The recipient / member picker: one extra-large `frappe.ui.Dialog` (a full-height `.sanad-sheet`
on phones) with a pill strip of **sources**, the active source's pane, and an always-visible
**tray** (the Selected tab) that the server classifies live. It adds rows to, or removes rows
from, a target document's child table (`picker.commit_add` / `picker.commit_remove`), or — in
**local mode** (`on_pick`) — hands the picked rows back to the caller and writes nothing. Every
source produces rows in one shape `{phone, phone_e164, display_name, contact, source_type,
source_doctype, source_name, valid, error}`; the server, never the client, decides what is
already in the target, invalid or duplicated.

**Portability:** tied to this app's backend. Every call goes through the `picker.*` keys (plus
`campaigns.get_recipients_page` as the remove-mode default for non-group targets), and it relies
on their return shapes, on source keys the server defines (`Contact Group`, `Contact`,
`DocType`, `Excel`, `vCard`, `Manual`), on the `wa:import:progress` realtime event, on the
`WAStateConflictError` / `WAValidationError` exception names, on a target child table named
`recipients` or `members` with a `source_type` Select, and on a group DocType with a `kind`
Select (a `"Blacklist"` kind gets a warn badge). Keys can be remapped with `opts.api`.

## Sources — the code has seven source classes, not six

`ContactPicker.sources` registers **six** selectable sources; a **seventh**, `CurrentSource`, is
added only in remove mode as the first tab. The **Selected** tray (`selected.js`) is not a source.
Tabs come from `picker.list_sources(target_doctype)` (cached per target, see `sources_for`),
filtered to `enabled !== false`, to `opts.sources` if given, and to keys with a registered class.

| # | File | Key (`entry.key`) | Tab label | Aliases for `sources` / `preselect.source` |
|---|---|---|---|---|
| 1 | `sources/groups.js` | `Contact Group` | Contact groups | `groups`, `group` |
| 2 | `sources/contacts.js` | `Contact` | Contacts | `contacts`, `contact` |
| 3 | `sources/doctype.js` | `DocType` | System screen | `doctype`, `system` |
| 4 | `sources/excel.js` | `Excel` | Excel file | `excel` |
| 5 | `sources/phonebook.js` | `vCard` | Phone export | `phonebook`, `vcard`, `vcf`, `csv` |
| 6 | `sources/manual.js` | `Manual` | Manual entry | `manual` |
| 7 | `sources/current.js` | `__current` (remove mode only) | Current members / Current recipients | `current` |

The server entry's `label` overrides the class label. All sources extend `BaseSource`
(`sources/_base.js`), which provides `search_box`, `chips`, `select_field` (dropdown with search
past 7 options), `candidate_table` (row = `role="checkbox"`, "Select all on page" header,
`selected_rows()` / `select_all(on)`, fires `selection-change`), `add_selected_button` ("Add N"),
`pager` ("a–b of N", Previous / Next), `invalid_list` (collapsible, first 100) and `state_for`
(EmptyState). Default `page_length` is 20.

### 1 · Contact groups
Lists groups of `opts.group_doctype` (the server entry's `doctype` wins if present). A **Kind**
dropdown appears when that DocType has a `kind` Select. Rows show name, member count and kind;
"Show members" opens a separate `large` dialog; the whole row toggles a checkbox.
- `picker.search_groups {txt, kind, exclude, page, page_length}` → `{rows, total}` on every
  search / kind / page change. `exclude` = the target name when the target is a group.
- **Add members of N groups** (`add_members`): for each ticked group, pages
  `picker.get_group_members {group, page, page_length: 200}` until `page*200 >= total`, adding
  each page quietly; `source_ref` = the group only when exactly one was ticked. No row cap.
- **Show members** window: loads every page of `get_group_members` (200/page), then offers
  search, Select all, Select the matches, Clear selection, Show selected, and "Add N"
  (`source_ref` = that group). Renders 300 rows at a time.
- Empty result offers "New contact group" when `frappe.model.can_create` allows it.
- `preselect({ref})` ticks the group and immediately runs `add_members`.

### 2 · Contacts
Search by name / phone plus a **Linked to** dropdown from `entry.link_doctypes` (server: the
installed ones of Customer, Supplier, Employee, Sales Partner, Lead), else
`opts.contact_link_doctypes`. Rows without a valid phone are shown disabled.
- `picker.search_contacts {txt, link_doctype, page, page_length}` → `{rows, total}`.
- Footer: "Add N" for the ticked rows.

### 3 · System screen (`DocType`)
A **Screen** `<select>` over `entry.doctypes[{document_type, label}]` (the enabled rows of
*WhatsApp Settings › Picker Sources*; the server disables this source when there are none).
Auto-selects when there is only one. Then Frappe's own `frappe.ui.FilterGroup` for that DocType
(after `ui.meta.with_doctype`), changes debounced 300 ms. `page_length` 50. Stale responses are
dropped by a sequence counter.
- `picker.list_doctype_rows {document_type, filters, page, page_length}` → `{rows, total}`;
  rows show a "Record" badge (`source_name`).
- **Add all N matching**: pages the same call at 200/page, adding quietly, stopping at the
  total or at **20,000** rows (warning toast). `source_ref` = the DocType.
- `preselect({ref})` selects that DocType if it is listed.

### 4 · Excel file and 5 · Phone export (`UploadSource`)
`PhonebookSource` extends `UploadSource` (exported from `excel.js`; `ExcelSource` is an empty
subclass). Both run a three-step `sanad.ui.Stepper` in the pane:
1. **Upload** — `frappe.ui.FileUploader` (private, `Home/Attachments`, one file, 5 MB; no web
   link or camera). Types by kind: `excel` → `.xlsx .xls .csv`, `csv` → `.csv`, `vcf` → `.vcf`.
   Kinds come from `entry.kinds`, default `["excel"]` (Excel) / `["vcf","csv"]` (Phone export);
   more than one kind shows **File type** chips. On upload success it parses at once.
2. **Map columns** — phone / name `<select>`s over the returned `columns` (free-text inputs if
   none). Mandatory only when the server says `needs_mapping`; otherwise `can_skip`. vCard shows
   "vCard files need no column mapping." Next re-parses with `mapping: {phone, name}`.
3. **Preview** — counts (valid / invalid / rows in file), first 100 valid rows, the invalid list.
   Finish ("Add N rows") pushes the valid rows (`source_ref` = file name) and relabels "Added N rows".
- `picker.parse_upload {file_url, kind, mapping}` → `{rows, invalid, columns, total,
  needs_mapping?, error?}`. `needs_mapping` → jump to Map with the message. A thrown
  `WAValidationError` (non-vcf) also goes to Map; any other error returns to Upload with the
  message inline.
- `accept_file(file)` (drop target) switches kind by extension and feeds the uploader.
- `preselect({kind})` clicks that kind's chip.

### 6 · Manual entry
A `dir="ltr"` textarea, one number per line; input is filtered to digits, `+`, whitespace, `,`
and `;` (`ManualSource.numbers_only`). Placeholder / hint use `sanad.ui.PhoneField.example()`
when PhoneField is loaded. "Add numbers" or Ctrl/⌘+Enter parses.
- `picker.parse_manual {text}` → `{rows, invalid}`. Valid rows are added; the textarea is
  cleared; each invalid line becomes an editable **fix row** with its reason.
- Fix row: Enter or **Fix** re-sends that one line (`parse_manual {text: line}`) and removes it
  once it reads; × ignores it. **Fix all** sends every remaining line in one call; **Ignore all**
  clears them.

### 7 · Current members / recipients (remove mode)
Pages the target's own rows via `picker.current_config()` (`page_length` 50), with search, a
**Source** dropdown from `cfg.source_types`, a Status badge column when `cfg.status_field`, and
rows with `status === "Removed"` disabled. Footer: "Mark N for removal".
- Group target: `picker.get_group_members {group, page, page_length}`, client-side filtering.
- Other targets: `campaigns.get_recipients_page {name, page, page_length, search, source_type}`,
  server-side filtering, `status_field: "status"`, colour from `ui.indicator_for(child_doctype)`.
- `opts.current.method` overrides both (`args` default: `{name: target_name, ...state}`).

## Options

| Option | Type | Default | Meaning |
|---|---|---|---|
| `target_doctype` | string | — | Document holding the child table. Omit in local mode. |
| `target_name` | string | — | That document's name. |
| `operation` | `"add"` \| `"remove"` | `"add"` | Remove mode adds tab 7 and commits with `commit_remove`. |
| `sources` | string[] | all enabled | Restrict tabs to these keys or aliases. |
| `preselect` | `{source, ref?, kind?}` | — | Open on this source and call its `preselect(pre)`. |
| `on_commit` | `(result, picker) => void` | — | After a successful commit. `result` = `{added, skipped_duplicates, skipped_invalid}` or the `commit_remove` response (`removed`). |
| `on_close` | `(committed: boolean) => void` | — | On dialog hide (`destroy`). |
| `on_pick` | `(rows, picker) => void` | — | Local mode: Continue hands the `available` rows back; nothing is written. |
| `existing` | string[] | `[]` | Local mode: E.164 keys already held (classified as already added). |
| `title` | string | per mode | Default "Add recipients to {t}" / "Remove members from {t}" / … / "Choose recipients" (local). |
| `target_label` | string | `target_name` | Name used in titles and the confirm message. |
| `group_doctype` | string | `config.defaults.group_doctype` or `"Contact Group"` | Group DocType; decides `target_is_group()` and source 1's kind options. |
| `contact_link_doctypes` | string[] | `config.defaults.contact_link_doctypes` | Source 2 dropdown when the server entry has none. |
| `current` | `{method, args(state), server_filters?, source_types?, status_field?, status_colour?(row)}` | per target | Remove-mode paging of the target's rows. |
| `api` | `{[key]: key}` | `{}` | API key overrides, applied by `picker.call` and `sources_for`. |

## Methods

Instance (mostly for sources):
- `add_rows(rows, {source_type, source_ref=null, quiet=false})` → number of new keys; toasts unless `quiet`.
- `notify_added(added, merged=0)` — the "Added N to the selection" toast.
- `remove_rows(keys)`, `clear_selection()`.
- `source_groups()` → `[{source, label, rows: [[key, row]]}]` — the selection split by source.
- `activate(key, {force})` → `Promise<boolean>` — switch tab (mounts the pane lazily).
- `accept_file(file)` — route a dropped file to a source (see Notes: currently broken).
- `set_progress(text)`, `call(key, args, opts)`, `target_is_group()`, `is_local()`,
  `current_config()`, `child_doctype()`, `source_type_options()`, `row_key(row)`.

Static:
- `ContactPicker.open(opts)` — same as `new`.
- `ContactPicker.sources_for(target_doctype, {api})` → cached `picker.list_sources` promise (cache dropped on error).
- `ContactPicker.prefetch(target_doctype)` — warm that cache, never rejects.
- `ContactPicker.sources` — registry `{key: SourceClass}`; add or replace classes before opening.
- `ContactPicker.SOURCE_ICON`, `ContactPicker.numbers_in(text)`, `ContactPicker.stage_label(stage)`.

## Selection model

- `picker.selection` is a `Map`. Key (`row_key`): `phone_e164`, else `raw:<phone>`, else
  `invalid:<source_name|contact|display_name|uid>`. Adding an existing key is a no-op
  (counted as "already selected" in the toast).
- Each stored row gets `source_type` / `source_ref` (the row's own, else the caller's; `null`
  for `__current`) and `__source` = the active tab key. Sources mix freely.
- Every change bumps `revision` and runs `on_selection_change`: tray badge, per-tab counts in
  the strip, footer counter ("N selected"), Continue enabled iff non-empty, tray re-render,
  debounced preview (250 ms), debounced `ui.announce("N selected")` (600 ms).
- With two or more sources the tray shows a chip per source with an × that removes that source's rows.

## Confirm and commit flow (`continue_` → `commit`)

1. **Continue** (or Ctrl/⌘+Enter) — ignored if the selection is empty; disables the button.
2. `selected.ensure_preview()` — reuses the last preview if it matches the current size and
   `revision`, otherwise calls:
   - target mode: `picker.preview {target_doctype, target_name, rows}`,
   - local mode: `picker.classify {rows, existing}`;
   → `{available, already_added, invalid, duplicates_in_selection, known_count}`. After 300 ms
   the counts strip becomes a skeleton and the footer says "Checking N numbers…". A stale
   response (older `revision`) is discarded. On error the alert shows in the tray and the flow stops.
3. `selected.counts()` → add: `action = available`, `skipped = already_added`; remove:
   `action = already_added`, `skipped = available`, `keys = already_added[].phone_e164`;
   plus `invalid`, `duplicates`, `known`.
4. **Local add**: no `available` rows → inline alert; else `on_pick(available, picker)`, mark
   committed, hide. No ConfirmDialog.
5. `action === 0` → inline alert ("nothing to add" / "nothing to remove"), stop.
6. `sanad.ui.ConfirmDialog.ask({title: "Add N numbers?" | "Remove N numbers?", message: "Changes
   apply to {doctype} {label}.", impact, danger: remove, confirm_label: "Add N" | "Remove N"})`.
   Impact rows — add: Will be added (green), Already added (skipped), Invalid (skipped), With a
   conversation; remove: Will be removed (red), Not in the list (ignored); both add "Duplicates
   in selection (merged)" when non-zero. Cancel does nothing.
7. **Commit**, footer shows "Adding N…" / "Removing N…":
   - remove: one `picker.commit_remove {target_doctype, target_name, phone_e164s: keys}`;
   - add: `source_groups()` chained sequentially, one `picker.commit_add {target_doctype,
     target_name, rows, source_type: first.source_type || "Manual", source_ref:
     first.source_ref || null}` per source, summing `added`, `skipped_duplicates`, `skipped_invalid`.
     Note: the whole group's rows are sent, not only the `available` ones — the server skips the rest.
8. Success → toast ("Added N" / "Added N. Skipped …" / "Removed N"), `on_commit(result, picker)`,
   hide. Failure → inline alert in the tray; `WAStateConflictError` gets "The list changed while
   you were choosing…". Button re-enabled in `finally`.

## Events and callbacks

- `on_commit`, `on_pick`, `on_close` (above).
- Realtime: `frappe.realtime.on("wa:import:progress", …)` on open, `off` on close; payload
  `{kind, stage, total, valid, invalid}` → footer progress text (`parsing`, `parsed`, other stages via `stage_label`).
- Dialog wrapper listens (namespace `.picker`): `keydown` (Ctrl/⌘+Enter), `paste` (2+ phone-like
  tokens → "N numbers in what you pasted. Add them / Ignore" bar → `picker.parse_manual`),
  `dragenter`/`dragover`/`dragleave`/`drop` (adds `sanad-picker-dialog--drop`, then `accept_file`).
- `candidate_table` triggers jQuery `selection-change` on its element.

## Server calls

| Key | Args | When |
|---|---|---|
| `picker.list_sources` | `{target_doctype}` | Open (cached per target per page load). |
| `picker.search_groups` | `{txt, kind, exclude, page, page_length}` | Source 1 search / page. |
| `picker.get_group_members` | `{group, page, page_length}` | Source 1 add / Show members (200/page); remove-mode tab for group targets. |
| `picker.search_contacts` | `{txt, link_doctype, page, page_length}` | Source 2. |
| `picker.list_doctype_rows` | `{document_type, filters, page, page_length}` | Source 3 page; "Add all matching" (200/page). |
| `picker.parse_upload` | `{file_url, kind, mapping}` | Sources 4/5 after upload and after mapping. |
| `picker.parse_manual` | `{text}` | Source 6 add / Fix / Fix all; paste bar. |
| `picker.preview` | `{target_doctype, target_name, rows}` | Every selection change (debounced) and Continue. |
| `picker.classify` | `{rows, existing}` | Same, in local mode. |
| `picker.commit_add` | `{target_doctype, target_name, rows, source_type, source_ref}` | Confirm, once per source. |
| `picker.commit_remove` | `{target_doctype, target_name, phone_e164s}` | Confirm in remove mode. |
| `campaigns.get_recipients_page` | `{name, page, page_length, search, source_type}` | Remove-mode tab, non-group targets (default). |

All with `{silent: true}`. Source 1 also reads DocType meta (`ui.meta.with_doctype`), source 3
loads the chosen DocType's meta.

## Usage

```js
new sanad.ui.ContactPicker({
  target_doctype: frm.doctype,
  target_name: frm.doc.name,
  target_label: frm.doc.group_name,
  operation: "add",                                // or "remove"
  preselect: { source: "groups", ref: "VIP" },     // optional
  on_commit: () => frm.reload_doc(),
});

// Local mode: nothing is written
new sanad.ui.ContactPicker({
  title: __("Choose who gets the alert"),
  existing: ["+966501234567"],
  on_pick: (rows) => keep(rows),
  on_close: (committed) => committed || cancel(),
});
```

## CSS hooks

- Dialog wrapper: `.sanad-kit.sanad-sheet.sanad-picker-dialog`, `--remove` (danger primary
  button), `--drop` (while dragging a file). Members window adds `.sanad-picker-members`.
- Root `.sanad-picker`, `--zone-selected`; `__tabs` / `__tab` (`data-key`, `aria-selected`),
  `__tab-count` (`--on`); `__zones` / `__zone` (`data-zone="pick|selected"`); `__work`,
  `__paste`, `__panes` / `__pane`; tray `__tray`, `__tray-head`, `__badge` (`--empty`),
  `__tray-sources` / `__srcchip`, `__tray-body`, `__counts`, `__alert`, `__clear`.
- Footer: `__footer-info`, `__counter`, `__progress`.
- Panes: `__head`, `__search` (`--sm`), `__dd` / `__dd-btn` (`--active`) / `__dd-pop` /
  `__dd-opt`, `__field`, `__filters`, `__results`, `__foot`, `__pager`, `__note`, `__uploader`,
  `__mapping-grid`, `__invalid`, `__manual`, `__fixes` / `__fix` (`--busy`, `--still`).
- Rows: `__list`, `__all`, `__rows`, `__row` (`--disabled`, `--chosen`, `--danger`, `--ok`,
  `--warn`, `--flagged`), `__av` (`--on`, `--manual`), `__row-name`, `__row-sub`, `__row-error`,
  `__row-badge` (`--warn`, `--danger`, `--ok`, `--muted`), `__mark` (`--x`), `__peek`, `__group`,
  `__members*`, `__more`, `__remove`.

## Notes

- **States:** the shell shows an EmptyState skeleton until sources load (error → Retry); every
  source pane has loading / empty / error (Retry). No enabled source → warning toast.
- **Tray:** searchable (200 ms), "Clear all", renders 200 rows per step ("Show N more"). In the
  tray (`compact`) rows are avatars with a badge: Already in the list / Will be removed (remove),
  Invalid (reason), Duplicate in the selection, Not in the list (remove).
- **ARIA / keyboard:** source strip is `role="tablist"` with roving `tabindex` via
  `ui.roving_index` (RTL-aware arrows, Home/End); panes are `role="tabpanel"`. Candidate rows are
  `role="checkbox"` toggled by Space/Enter. One live channel for the count (`ui.announce`).
  Dropdowns close on Escape / outside click.
- **Stale header comment:** `index.js`'s header says switching source with a non-empty selection
  asks to discard; the code does not (`activate` switches directly; sources mix).
- **Bug — file drop:** `accept_file` maps extensions to `"phonebook"` / `"excel"` and looks for
  tabs with those keys, but tabs are keyed by server keys `vCard` / `Excel`, so a dropped file
  always ends in the "not one this list can read" toast.
- **Remove-mode tab** instance is not stored in `picker.instances`, so its `on_show`, `preselect`
  and `destroy` are never called by the shell.
- **Limits:** "Add all matching" stops at 20,000; uploads 5 MB (the uploader note says 20,000 rows,
  enforced server-side).
- **Live use:** `public/js/form/whatsapp_contact_group.js` (Add / Remove members),
  `public/js/screens/campaign/audience.js` (add / remove recipients, `sources_for` to draw the
  source buttons), `public/js/screens/campaign/builder.js` (`prefetch`), `public/js/screens/alerts.js`
  (local mode, `pick_recipients`).

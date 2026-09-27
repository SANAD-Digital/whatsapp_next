# ContactPicker

The recipient / member picker sub-system: one `frappe.ui.Dialog` (extra-large on desktop, a
full-height `100dvh` sheet under 768 px) in three zones — **where numbers come from** (a rail of
sources, each with its icon and how many of the selection it contributed), **where they are picked**
(the source's own pane) and **what has been picked** (a tray that is always in sight: the live
buckets from `picker.preview`, a chip per source with an × that drops that source's rows, a search
and the rows themselves). The same shell serves **add** and **remove**.

Sources mix freely — a campaign is built from a group *and* a handful of typed numbers — because
every row keeps its own `source_type` / `source_ref`, and the commit makes one `picker.commit_add`
call per source so the audit says where each batch came from. Sources come from
`picker.list_sources(target_doctype)` (disabled ones are hidden); every source returns rows in one
shape `{phone, phone_e164, display_name, contact, source_type, source_doctype, source_name, valid,
error}`; the selection is a `Map` keyed by `phone_e164` (fallback: the raw phone) and the server —
never the client — decides what is already in the target, invalid or duplicated.

Three things a reader tries without being told now work: **pasting a list of numbers** anywhere in
the dialog offers to add them (`picker.parse_manual`), **dropping a file** on the dialog opens the
source that reads it and uploads it, and **Ctrl / ⌘ + Enter** finishes. Portable: DocType names
arrive as options / server entries; kind chips and `source_type` chips come from meta.

## Usage

```js
new sanad.ui.ContactPicker({
  target_doctype: frm.doctype,          // a picker target (holds the child table)
  target_name: frm.doc.name,
  operation: "add",                     // or "remove"
  on_commit: (result) => frm.reload_doc(),   // {added, skipped_duplicates, skipped_invalid} | {removed}
});

// Open straight on one source and pre-fill it
new sanad.ui.ContactPicker({ target_doctype, target_name, preselect: { source: "groups", ref: "VIP customers" }, on_commit });
new sanad.ui.ContactPicker({ target_doctype, target_name, preselect: { source: "phonebook", kind: "csv" }, on_commit });
```

**Local mode** — a host that keeps its own list (an alert's recipients, a draft) passes
`on_pick(rows)` instead of a target: the tray classifies against the keys it passes as `existing`
(`picker.classify`, nothing written), and "Continue" hands back the available rows:

```js
new sanad.ui.ContactPicker({ title: __("Choose recipients"), existing: ["+9665…"], on_pick: (rows) => keep(rows) });
```

Options: `on_pick?(rows, picker)` and `existing?: string[]` (local mode), `target_doctype`, `target_name`, `operation` (`"add"` | `"remove"`), `sources?`
(keys or aliases: `groups`, `contacts`, `doctype`, `excel`, `phonebook`, `manual`),
`preselect?: {source, ref?, kind?}`, `on_commit(result, picker)`, `on_close?(committed)`,
`title?`, `group_doctype?` (default `sanad.ui.config.defaults.group_doctype`; kind chips from its `kind` Select; excluded as a source when it is
the target), `contact_link_doctypes?` (chips for source 2, default `config.defaults.contact_link_doctypes`; the server entry's `link_doctypes`
wins), `current?: {method, args(state), server_filters?, source_types?, status_field?}` (remove
mode paging of the target's rows — defaults per target), `api?` (key overrides).
Methods on the instance (used by sources): `add_rows(rows, {source_type, source_ref, quiet})`,
`source_groups()` (the selection split by the source it came from), `accept_file(file)`,
`remove_rows(keys)`, `clear_selection()`, `activate(key)`, `set_progress(text)`, `call(key, args)`.
`sanad.ui.ContactPicker.sources` is the registry (`{apiKey: SourceClass}`) — a host may replace or
add a source class before opening.

Realtime: `wa:import:progress` `{kind, stage, total, valid, invalid}` (user room) drives the
progress text under the footer counter during parsing; subscribed on open, off on close.

## Sub-plan — one section per tab

### Source 1 · Contact groups (`sources/groups.js`) — built
Search box + a `kind` dropdown field (`select_field`: the button says `Kind: value`, the popover
lists the options with a search box once they pass a handful — options may be many, and a row of
chips does not scale; options from the group DocType's Select meta) → `picker.search_groups
{txt, kind, exclude, page, page_length}`; the target group is excluded when the target is a group.
Each group row: checkbox, `group_name`, kind badge (Blacklist red), member count, "Show members" (first 10
via `picker.get_group_members`). "Add members of N groups" pages through `get_group_members`
(200 per page, progress note) and adds every member; `source_ref` = the group when exactly one.

### Source 2 · Contacts (`sources/contacts.js`) — built
Search by name / phone, a `link_doctype` dropdown field (the entry's `link_doctypes` = installed party
DocTypes, or `contact_link_doctypes`) → `picker.search_contacts {txt, link_doctype, page,
page_length}` → `{rows, total}`; checkbox rows, contacts without a phone are listed disabled
with the reason; "Select all on page"; "Add N"; pager "1–20 of N".

### Source 3 · System screen (`sources/doctype.js`) — built
DocType select from the entry's `doctypes[{document_type, label}]`, then **Frappe's own
`frappe.ui.FilterGroup({parent, doctype, on_change})`** (after `frappe.model.with_doctype`) →
`picker.list_doctype_rows {document_type, filters: filter_group.get_filters(), page,
page_length}` → `{rows, total}` ("N matching records"); table (name, record, phone) with
checkboxes, "Select all on page", "Add all N matching" (200 per page with "x of N" progress,
capped at 20,000 with a warning).

### Source 4 · Excel (`sources/excel.js`) — built (Stepper flow)
A three-step `sanad.ui.Stepper` ("Step n of 3"): **1 Upload** — `frappe.ui.FileUploader` inside
the pane (private, `.xlsx / .xls / .csv`, 5 MB) → `picker.parse_upload {file_url, kind, mapping}`
runs on upload; **2 Map columns** — phone / name `<select>`s over the returned `columns`; when the
server answers `needs_mapping: true` (phone column not detected) the step is mandatory and opens
with the server's message, otherwise it is skipped automatically and marked `can_skip`; Next
re-parses with `mapping: {phone, name}`;
**3 Preview** — counts strip, first 100 valid rows, invalid rows with reasons (collapsible); the
Finish button "Add N rows" pushes the valid rows into the selection and then reads "Added".
`WAFileError` messages (too large, public, unreadable) return the flow to Upload with the message
inline (`role="alert"`).

### Source 5 · Phone export (`sources/phonebook.js`) — built (Stepper flow)
Same three steps with `kind` chips `vcf` (primary) / `csv` from the entry's `kinds` in the Upload
step; the note states this reads the uploaded file, not the device address book. vCard skips the
mapping step ("vCard files need no column mapping").

### Source 6 · Manual entry (`sources/manual.js`) — built
Textarea, one per line (`phone` or `name;phone`), hint text with the country-code rule (no
dependency on PhoneField), line counter, Ctrl/⌘+Enter → `picker.parse_manual {text}`; valid rows
go to the selection. A line the server refused does **not** go back into the textarea: it becomes
a row of its own under the box — the text in an input, the reason beside it, **Fix** (or Enter)
sends that one line back to `parse_manual` and it leaves the list the moment it reads, × ignores
it; **Fix all** / **Ignore all** act on the whole list. The textarea is empty after every parse,
so what is left on screen is exactly what still needs the reader.

### Selected (`selected.js`) — built
Debounced `picker.preview {target_doctype, target_name, rows}` on every change → chips per row:
red "Already added" (`already_added`), red "Duplicate in selection", amber invalid reason; counts
strip "Will be added N · Already added M · Invalid K · With a conversation C". Remove mode:
"Will be removed N · Not in the list M" (rows in `already_added` are the ones removed). Search
within the selection, per-row remove, "Clear all", incremental rendering (200 rows a step).

### Confirm — built
"Continue" refreshes the preview, then `ConfirmDialog.ask({impact: exact counts, confirm_label:
"Add N" / "Remove N" (danger)})` → `picker.commit_add {rows, source_type, source_ref}` /
`picker.commit_remove {phone_e164s}` → toast with `added / skipped` or `removed`, `on_commit`,
close. A 409 `WAStateConflictError` (or any commit error) is shown inline in the Selected tab.

### Remove mode (`sources/current.js`) — built
A first tab "Current recipients / members" pages the target's rows (`campaigns.get_recipients_page`
for campaigns with server search / `source_type` filter and a status badge; `picker.get_group_members`
for groups with client-side narrowing), a `source_type` dropdown field (from the child meta), "Select all
shown", "Choose N" → Selected tab → confirm → `commit_remove`.

## Live use
`WhatsApp Campaign` form — `public/js/form/whatsapp_campaign.js` ("Add recipients" / "Remove
recipients"; `frappe.flags.wa_picker_group` (set by the Contact Group screens) preselects a group); `WhatsApp Contact Group`
form — `public/js/form/whatsapp_contact_group.js` ("Add members" / "Remove members";
`?import=csv` opens source 5 with CSV preselected).

## Height and scrolling
The dialog keeps **one height** on desktop (`clamp(420px, 100vh − 230px, 680px)`): the three zones
fill it, a long result table scrolls inside its own area with a sticky header, the tray's rows
scroll inside the tray, and the search box, the chips, the pager and the "Add N" button stay
where the hand left them. A stepper flow taller than its pane scrolls as a pane. Under 768 px the
sheet scrolls as a whole, as before. A contact without a number says so in the number's own cell,
so every candidate row is one line. Desk's `.form-control` and `.btn` inside the dialog take the
kit's shape (one border, one radius, one focus halo — no outline ring on top of a border), so a
field in the picker and a field on the page behind it read as the same control.

## The prototype's picking pane (`docs/component/Bulk Send.dc.html`)
The dialog draws what the prototype draws: the sources as **one pill strip** over the pane (a
sunken track, the chosen source filled, the count each source contributed inside its pill); a
**rounded search field** with the glass inside it; every candidate as **a row** — a round avatar
with the initials, the name over the number, a small badge for what else is known (kind, record,
status, source) and a round **mark** at the end that fills when the row is chosen (the whole row
is the control, `role="checkbox"`); the tray as the same rows with a `#` avatar for a typed
number and a round × that takes the row out, under "Selected · N · Clear all". Groups are the
same rows with "Show members" folding the first ten under them.

## Design gate
- Tabs are a real `role="tablist"` (a horizontal pill strip; it scrolls sideways on phones) with roving
  `tabindex`, RTL-aware arrow keys via `ui.roving_index` (Home / End too), `aria-selected` and
  `aria-controls`; panes are focusable `role="tabpanel"`.
- One live channel: the selection count is announced only through the debounced `ui.announce`
  ("12 selected"); the footer counter, the counts strip and result tables carry no `aria-live`;
  group searches announce "N groups found".
- Never colour alone: every flag is a StatusBadge with a label and icon (red = already added /
  duplicate, amber = invalid, gray = not in the list); disabled rows keep `--ink-gray-6` contrast.
- Every async pane renders skeleton / empty (with a next step — "New contact group" when the user
  can create one) / error (with Retry) through EmptyState; results areas reserve height.
- Errors next to their control: upload errors in the Upload step, parse errors under the
  textarea (`role="alert"`), commit conflicts inline in the Selected tab and focused, each with
  what happened and how to fix it.
- Decisions go through ConfirmDialog with the exact counts ("Add 12" / "Remove 12", "Changes apply
  to {target}."); toasts only report results in one full sentence.
- One "select all" control per table (the header checkbox, labelled "Select all on page").
- Plurals through `ui.plural` (Arabic dual and 3–10 forms); counts lead the strips ("12 will be
  added"); no list joins with ", " in code.
- Long loops (group members, "Add all matching") show "x of N" progress and stop at 20,000 with a
  clear message; `Continue` is disabled while nothing is selected (no dead button).
- Chips and tables are the shared `.sanad-chip` / `.sanad-table`; the dialog is a `.sanad-sheet`
  on phones (`100dvh`, sticky footer, `scroll-padding-block-end`); ≥ 32 px targets; focus ring
  from the kit's global rule.
- The manual-entry example comes from `sanad.ui.PhoneField.example()` when the kit ships it.

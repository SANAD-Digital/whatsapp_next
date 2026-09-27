# FunctionDetail

The prototype's function window (`docs/component/Function Detail.dc.html`), value for value: a
full-height modal with the function's name, category and two badges (active / stopped, installed /
not installed), the tabs Details · Version log · Preview, the current and the latest version, and a
footer (Update to … · Install / Uninstall · Linked commands · More · Close).

- **Details** (340 | 1fr | 1fr): what it does, when exactly to use it, the party types it serves,
  four figures (calls in 30 days, average run time, linked commands, active of them), suggested
  words and the linked commands · the variables and the options it takes · the outputs it produces,
  each text and file name with a copy button and its fields as chips that copy `{{ field }}`.
- **Version log**: one card per version, newest first, the latest and the installed one marked;
  the newest opens by itself, the others on click.
- **Preview** (320 | 1fr | 400): assumptions (party type, contact, account, variables with "Fill
  with examples" from the manifest's example) · options and texts for this preview only · the reply
  after rendering, from the host's `preview` (a real dry run: nothing saved, nothing sent).

It is drawn on `CommandEditor`'s shell (the two prototypes share it), so both styles must load —
the kit's `style.scss` imports both.

## Usage

```js
const detail = new sanad.ui.FunctionDetail({
  entry,                                   // catalog row + install state + linked_commands[]
  manifest,                                // {inputs[], settings[], outputs[], suggested_commands[], example}
  party_types: [{ key: "Customer", label: __("Customer") }],
  preview: ({ code, settings, outputs, values, sender }) => call_the_dry_run(...),
  search_contacts: (txt, party_type) => search(...),     // → [{name, label, phone, links[]}]
  on_update: (entry) => {},                // shown when an update is available
  on_toggle_install: (entry) => {},        // Install / Uninstall
  on_open_commands: (entry) => {},
  more: [{ label: __("Deactivate"), handler: (entry) => {} }],
  on_close: () => {},
}).show();

detail.hide();                             // e.g. when another overlay takes the screen
```

`preview` omitted (a viewer) or a function that is not installed → the Preview tab says why
instead of running.

## Live use
The host app's Functions screen: clicking a function opens it; its forms (update diff, settings,
another version) take the screen and the window comes back after them.

## Design gate
- `role="dialog"` + `aria-modal`, focus kept inside, Esc closes the open dropdown / menu first and
  the window last, focus returns to the opener. Registered with `sanad.ui.overlay`, so one overlay
  shows at a time.
- Tabs are `role="tab"` with `aria-selected`; version cards are buttons with `aria-expanded`; the
  "More" button has `aria-haspopup="menu"`.
- Status is never colour alone: each badge carries its word. Copy buttons have an `aria-label`.
- Colours are product tokens only; offsets are logical, so Arabic and English need nothing extra.

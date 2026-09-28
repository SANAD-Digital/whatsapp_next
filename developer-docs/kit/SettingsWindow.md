# `sanad.ui.SettingsWindow`

A settings window in the shape of claude.ai's: one large modal over a dimmed backdrop, a rail on
the inline-start (a search field, then sections in labelled groups) and one content pane that
scrolls on its own, with the close button in its top corner. Under 720 px it fills the screen and
works in two steps — the section list, then one section with a back button. The window draws
nothing inside a section: the host renders each one through `render(key, $pane)`, optionally with
the static content helpers (`head_html`, `section_html`, `row_html`) for the same rows and headings.
Constructing it builds the DOM but does not open it — call `show_window()`.

**Portability:** no server calls, no app keys. The stylesheet uses the app's `--wa-*` palette
tokens (`public/scss/_tokens.scss`), which live outside the kit; the host's `cls` is where a palette
scope goes.

## Options

| Option | Type | Default | Meaning |
|---|---|---|---|
| `title` | string | `__("Settings")` | Accessible name of the dialog and nav, and the back label on the list step. |
| `groups` | `Array<{label?, items[]}>` | `[]` | Rail groups; a group without `label` is unlabelled. |
| `groups[].items[]` | `{key, label, icon?, keywords?}` | — | One section. `icon` is a `_kit` `ico()` name; `keywords` widen the search. |
| `render` | `(key, $pane, win) => Promise\|void` | — | Draws one section into the (emptied) pane. |
| `active` | string | first item | Section to open on the first `show_window()` without a key. |
| `cls` | string | — | Extra class on the window root (host palette scope). |
| `on_show` | `(key, win) => void` | — | After a section's `render` resolves. |
| `on_close` | `(win) => void` | — | On every `hide()`. |

## Methods

- `show_window(key?)` — open the window on `key` (else the current, `active`, or first section);
  if already open, only switches section. Returns the section's render promise.
- `show(key)` — open a section (unknown key → first); marks it in the rail and calls `render`.
- `refresh()` — draw the current section again (after a save, sync or realtime event).
- `hide()` — close, restore focus to the opener, call `on_close`; returns `this`.
- `filter(text)` — filter the rail as the search field does.
- `draw_nav()` — rebuild the rail from `opts.groups`.
- Static `SettingsWindow.head_html(title, description?)` — pane title and the line under it.
- Static `SettingsWindow.section_html(title, note?)` — a heading inside the pane.
- Static `SettingsWindow.row_html(title, description?, control_html = "")` — one setting row:
  text on the start side, the (unescaped) `control_html` on the end side. `title`/`description`
  are escaped.

Instance fields a host may read: `current` (open key), `open` (boolean), `$root`, `$pane`.

## Events and callbacks

- `render`, `on_show`, `on_close` as above.
- Registers with `sanad.ui.overlay.open/close`; focus is trapped with `ui.trap_focus`; opening is
  announced ("Settings opened.") with `ui.announce`.
- No custom DOM events; no realtime subscriptions (the live host binds its own).

## Server calls

None.

## Usage

```js
const SW = sanad.ui.SettingsWindow;
const win = new SW({
  title: __("Settings"),
  cls: "my-palette-scope",
  groups: [
    { label: __("Account"), items: [{ key: "usage", label: __("Usage"), icon: "chart", keywords: "quota" }] },
    { label: __("Settings"), items: [{ key: "general", label: __("General"), icon: "gear" }] },
  ],
  render: (key, $pane) => {
    $pane.append(SW.head_html(__("General"), __("How the app behaves.")));
    $pane.append(SW.section_html(__("Notifications")));
    $pane.append(SW.row_html(__("Email me"), __("A daily summary."), toggle_html));
  },
});
win.show_window("usage");
```

## CSS hooks

- `.sanad-sw-backdrop` and root `.sanad-kit.sanad-sw[role=dialog]` (plus `cls`), both appended to
  `body`; `body.sanad-sw-open` while open.
- State modifiers: `.sanad-sw--in` (entered, for the transition), `.sanad-sw--pane` (a section is
  shown — on phones this switches from list to pane).
- Rail: `__rail`, `__search`, `__search-icon`, `__nav`, `__group`, `__group-label`,
  `__item[data-key]` (`.is-on`, `aria-current="page"`), `__item-icon`, `__item-label`, `__none`.
- Main: `__main`, `__bar`, `__back`, `__back-label`, `__close`, `__pane[role=region]`.
- Content helpers: `__head`, `__title`, `__desc`, `__h`, `__row`, `__row-text`, `__row-title`,
  `__row-desc`, `__row-control`.
- Phone layout at `max-width: 719px`.

## Notes

- **Loading/empty:** the window has no skeleton of its own — the host's `render` owns the pane's
  loading/error state. A search with no hits shows "No setting matches" and hides empty groups.
- **Keyboard:** Esc closes unless a Frappe `.modal.show` is on top; Tab is trapped; in the search,
  Enter opens the first visible match and ArrowDown moves to the list; arrow keys rove the rail
  (`ui.roving_index`). On open, focus goes to the search (or the close button when hidden).
- On a phone, `show_window()` without a key opens on the list step.
- `hide()` detaches the DOM after 160 ms; the instance can be reopened with `show_window()`.
- RTL via logical properties; the back button uses the `caret` icon.
- **Live use:** `public/js/screens/settings.js` (the settings, subscription and usage window —
  also uses `head_html`, `section_html`, `row_html`).

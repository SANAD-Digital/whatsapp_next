# SettingsWindow

A settings window in the shape of claude.ai's own settings: one large modal (16 px radius, at most
1280 × 880) over the dimmed page, a rail on the inline-start — a search field, then the sections
in labelled groups — and one content pane that scrolls by itself, with the close button in its
top corner. Under 720 px it takes the whole screen and works in two steps: the list of sections,
then one section with a back button.

The window draws nothing inside a section: the host renders each one through `render(key,
$pane)`. The content helpers give it Claude's look — a pane title, section headings, and rows with
the title and description on the start side and the control on the end side.

## Usage

```js
const win = new sanad.ui.SettingsWindow({
  title: __("Settings"),
  cls: "my-palette-scope",                       // optional: the host's colour scope
  groups: [
    { label: __("Account"), items: [
      { key: "billing", label: __("Billing"), icon: "card" },
      { key: "usage",   label: __("Usage"),   icon: "chart", keywords: "quota messages" },
    ] },
    { label: __("Settings"), items: [{ key: "general", label: __("General"), icon: "gear" }] },
  ],
  render: (key, $pane) => {
    $pane.append(sanad.ui.SettingsWindow.head_html(__("General"), __("How the app behaves.")));
    $pane.append(sanad.ui.SettingsWindow.section_html(__("Notifications")));
    $pane.append(sanad.ui.SettingsWindow.row_html(__("Email me"), __("A daily summary."), toggle_html));
    return load_more_into($pane);               // a promise is fine
  },
});
win.show_window("usage");   // open on a section; a second call only switches it
win.refresh();              // draw the open section again
win.hide();
```

## Live use
The host app's settings, subscription and usage window — opened from the sidebar's "Settings"
item and from every link that used to route to the settings page.

## Design gate
- A labelled `role="dialog"` with `aria-modal`; Tab stays inside it; Esc closes it (unless a
  Frappe dialog opened from a section is on top) and focus returns to what opened it.
- The rail is a set of labelled groups of buttons; the open section carries `aria-current`;
  arrow keys move between sections; the search filters by label and keywords, Enter opens the
  first match, and "No setting matches" says when nothing does.
- The pane is a named region that scrolls on its own, so the rail and the close button never move.
- It sits under Frappe's dialogs, so a confirmation opened from a section appears on top.
- Product tokens only; logical properties; on a phone it is the whole screen with a back button.

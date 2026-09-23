# Stepper

A multi-step flow (wizard) with a spoken progress line ("Step 2 of 4"), a step list where the
current step carries `aria-current="step"`, lazily rendered panes owned by the caller, and a
footer with Back / Next / Finish (plus Skip for optional steps and Cancel when `on_cancel` is
given). Validation runs per step; a failed `validate` shows its message inline above the pane
(`role="alert"`, focused) instead of a toast. Portable: the component never looks at the content
of a step — `render`, `validate` and `on_finish` are the caller's.

## Usage

```js
const stepper = new sanad.ui.Stepper({
  wrapper: $panel,
  ctx: { device: null },
  steps: [
    { key: "choose", label: __("Choose a device"),
      render($body, ctx, stepper) { /* build controls; call stepper.set_step_valid(!!ctx.device) */ },
      validate: (ctx) => !!ctx.device || __("Choose a device to continue") },
    { key: "pair", label: __("Pair"), render($body, ctx) { /* ... */ },
      validate: (ctx) => sanad.ui.call("devices.poll_status", { name: ctx.device }).then((s) => s.status === "Connected" || __("Pairing is not complete yet")) },
    { key: "done", label: __("Finish"), can_skip: false, render($body) { $body.text(__("All set.")); } },
  ],
  on_finish: (ctx) => sanad.ui.call("onboarding.complete_setup", { device: ctx.device }),
  on_cancel: () => frappe.set_route("wa-home"),
  finish_label: __("Complete setup"),
});
```

Options: `wrapper`, `steps[{key, label, render($body, ctx, stepper), validate?(ctx) →
true|false|string|Promise, can_skip?, on_show?($body, ctx, stepper)}]`, `on_finish(ctx)`,
`on_cancel?`, `ctx?`, `finish_label`, `next_label`, `back_label`, `cancel_label`, `start_index`,
`linear` (default `true`: only visited steps are clickable in the header).
Methods: `go(index)`, `next()`, `back()`, `skip()`, `set_step_valid(bool)`, `show_error(text)`,
`clear_error()`, `destroy()`. `validate` returning `false` shows a generic message; returning a
string shows that string; a rejected promise shows its `message`.

## Live use
ContactPicker file sources — `ui/ContactPicker/sources/excel.js` (Excel) and
`sources/phonebook.js` (phone export): Upload → Map columns (auto-skipped when the phone column
was detected, skippable by hand) → Preview, whose Finish button is "Add N rows". Also intended for
the onboarding wizard page and the pairing modal on the Devices page.

## Design gate
- Progress as text ("Step 2 of 4"), not only a bar; announced through `aria-live`.
- Errors placed next to the content (`role="alert"`, focusable) and announced assertively;
  "Something went wrong. Try again." house style (no "please").
- Future steps are not clickable in linear mode (no dead navigation); visited steps are.
- ≥ 32 px targets for step pills and footer buttons; step labels collapse to numbers on phones
  so the list never scrolls the page horizontally.
- Focus ring from the kit's one global `:focus-visible` rule (no per-component copy).
- Contrast: small labels ("Optional", to-do steps) use `--ink-gray-6` (≥ 4.5:1), never
  `--ink-gray-5`.
- Public `set_finish_label(text)` so callers never mutate options ("Add 12 rows" → "Added 12 rows").

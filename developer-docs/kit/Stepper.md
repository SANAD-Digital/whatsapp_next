# `sanad.ui.Stepper`

A multi-step flow (wizard): a spoken "Step 2 of 4" progress line, a step list whose current step
carries `aria-current="step"`, one lazily rendered pane per step, and a footer with Back /
Next / Finish plus Skip (optional steps) and Cancel (when `on_cancel` is given). Each step may
validate before Next; a failure shows inline in the pane (`role="alert"`, focused, announced).
Fully portable: the component never looks at step content — `render`, `validate` and
`on_finish` belong to the caller. No server calls.

## Options

| Option | Type | Default | Meaning |
|---|---|---|---|
| `wrapper` | jQuery \| HTMLElement | — | Container; it is emptied and the stepper appended. |
| `steps` | `Array<Step>` | `[]` | See the step spec below. |
| `on_finish` | `(ctx, stepper) => Promise\|void` | — | Run by Next on the last step (after its `validate`). A rejection shows its `message` inline and keeps the step open. |
| `on_cancel` | `(ctx) => void` | — | When set, a Cancel button is rendered at footer start. |
| `ctx` | object | `{}` | Shared context passed to every callback; also exposed as `stepper.ctx`. |
| `finish_label` | string | "Finish" | Next-button text on the last step. |
| `next_label` | string | "Next" | Next-button text elsewhere. |
| `back_label` | string | "Back" | Back-button text. |
| `cancel_label` | string | "Cancel" | Cancel-button text. |
| `start_index` | number | `0` | Step shown first. |
| `linear` | boolean | `true` | When true only visited steps are clickable in the header; when false every step is. |

**Step spec**

| Key | Type | Meaning |
|---|---|---|
| `key` | string | Identifier (for the caller; not read by the component). |
| `label` | string | Header label. |
| `render($body, ctx, stepper)` | function | Called once, the first time the step is shown. |
| `on_show($body, ctx, stepper)` | function | Optional; called every time the step is shown (after `valid` resets to true). |
| `validate(ctx, stepper)` | function | Optional; return `true`/`undefined` (pass), `false` (generic message), a string (that message), or a promise of one. |
| `can_skip` | boolean | Shows an "Optional" tag and a Skip button (not on the last step). |

## Methods

- `go(index)` — show a step without validation (Back and header clicks use it).
- `next()` — validate the current step, then advance or finish; returns `Promise<boolean>`.
- `back()`, `skip()` — previous step; next step when `can_skip`.
- `set_step_valid(bool)` — enable/disable Next for the current step.
- `set_finish_label(text)` — change the Finish text and re-render the footer.
- `show_error(message)`, `clear_error()` — inline error in the current pane.
- `busy(on)` — disable Next/Back while work runs (used by `next()`).
- `destroy()` — remove the markup.
- Getters: `current` (current step spec), `steps`; properties `index`, `ctx`.

## Events and callbacks

`render`, `on_show`, `validate` per step; `on_finish`, `on_cancel`. No DOM or realtime events.

## Server calls

None.

## Usage

```js
const stepper = new sanad.ui.Stepper({
  wrapper: $panel,
  ctx: { device: null },
  steps: [
    { key: "choose", label: __("Choose a device"),
      render($body, ctx, s) { /* build controls; s.set_step_valid(!!ctx.device) on change */ },
      validate: (ctx) => !!ctx.device || __("Choose a device to continue") },
    { key: "map", label: __("Map columns"), can_skip: true, render($body, ctx) { /* … */ } },
    { key: "done", label: __("Review"), render($body) { $body.text(__("All set.")); } },
  ],
  on_finish: (ctx) => frappe.xcall("my_app.api.finish", { device: ctx.device }),
  on_cancel: () => frappe.set_route("app"),
  finish_label: __("Complete setup"),
});
```

## CSS hooks

- Root `sanad-kit sanad-stepper` (with a generated `id`).
- `__header`, `__progress` (`aria-live="polite"`), `__list` (`<ol role="list">`), `__step`
  (`data-index`) with modifiers `--current`, `--done`, `--todo`; `__step-btn`, `__num`,
  `__check`, `__label`, `__optional`.
- `__body`, `__pane` (`data-index`, `hidden`), `__error`, `__content`, `__footer`,
  `__footer-start`, `__footer-end`.

## Notes

- Done steps swap the number for a check icon; on narrow screens the list stops wrapping,
  scrolls horizontally inside itself and hides to-do labels.
- Step buttons have `aria-describedby` pointing at the progress line; the current step's button
  is disabled. Errors are focused and announced assertively (`ui.announce`); a validate/finish
  exception without a message shows "Something went wrong. Try again."
- Next is disabled while `valid` is false or while busy.
- Live use: `whatsapp_next/page/wa_devices/wa_devices.js` (pairing flow) and, inside the kit,
  `public/js/ui/ContactPicker/sources/excel.js` (Upload → Map → Preview).

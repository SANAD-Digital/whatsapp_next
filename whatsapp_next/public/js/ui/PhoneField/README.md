# PhoneField

The design prototype's phone field (`docs/component/Phone Field.dc.html`), ported as a real
component — because Frappe has no phone field, and a Data control with a hint underneath could not
mask a number, could not say "nine digits after +966", and could not tell a Saudi number from a
Kuwaiti one.

A country trigger carrying the ISO code and the dial code opens a popup that searches by country
name, by ISO prefix or by dial code. The input takes digits only and masks them into that country's
own groups (`559021177` → `559 021 177`, Kuwait `12345678` → `1234 5678`). A tick appears the
moment the number is complete; the hint line turns into the exact reason when it is not ("A mobile
number in Saudi Arabia starts with 5"). An optional `!` bubble beside the label explains what the
number is for, and starts enlarged with a ring until it has been opened once.

Two modes:

- **`wrapper`** — the full field above. This is the prototype's control.
- **`control`** — wraps a Frappe Data control that already exists (a dialog field) and gives it the
  country hint and the loose E.164 normalisation only: spaces, dashes and brackets stripped,
  Arabic-Indic digits mapped, a leading `00` turned into `+`, a local number given the hinted
  country's dial code. Unchanged from before the port, so `QuickSend`'s dialog keeps working.

Validation is guidance. The server's `phone.normalize` stays authoritative and nothing here blocks
a save. No external libraries, and no flag images — a picture per country for a dial code is a
payload and a politics.

## Usage

```js
// The full field (pages, wizards, forms)
const phone = new sanad.ui.PhoneField({
  wrapper: $slot,
  label: __("Mobile number (WhatsApp)"),
  required: true,
  tip: __("This is the account's own contact number, not the device your customers write to."),
  on_change: ({ phone_e164, valid, iso, national }) => (state.phone = valid ? phone_e164 : null),
});
phone.get_value();   // → { phone, phone_e164, valid, empty, country, iso, dial, national, e164 }
phone.set_value("+966559021177");   // resolves the country from the dial code
phone.set_country("AE");
phone.example();     // → "+971 501 234 567"

// Wrapping a Frappe control (the hint renders under Frappe's own input)
new sanad.ui.PhoneField({ control: frm.get_field("mobile_no"), on_change: ({ valid }) => … });

// Helpers
sanad.ui.PhoneField.normalize("00966 50 123 4567");   // → { phone_e164: "+966501234567", valid: true }
sanad.ui.PhoneField.format_display("+966559021177");  // → "+966 559 021 177"
sanad.ui.PhoneField.mask("559021177", country);       // → "559 021 177"
sanad.ui.PhoneField.example("AE");                    // → "+971 501 234 567"
sanad.ui.PhoneField.example(null, { format: false }); // → "+966501234567"
sanad.ui.PhoneField.countries;                        // [{iso, name, dial, len, starts, groups}, …]
```

Options: `wrapper` | `control`, `label` (`""` renders none), `tip`, `hint`, `placeholder`,
`value`, `required`, `invalid`, `country_default`, `show_country`, `on_change`.
Methods: `get_value()`, `set_value(v)`, `set_country(iso|name)`, `focus()`, `example()`,
`destroy()`. Statics: `normalize`, `format_display`, `mask`, `resolve_country`,
`example(country?, {format})`, `countries`.

### The country default

`country_default` → `sanad.ui.config.defaults.country` → `frappe.boot.sysdefaults.country` → `SA`.
The prototype's default is Saudi Arabia, and a host that wants that regardless of the site's own
country setting says so once:

```js
sanad.ui.configure({ defaults: { country: "SA" } });
```

### The country table

`{iso, name, dial, len, starts, groups}` for ~68 countries. `len` is how many digits a mobile has
after the dial code and `starts` which digits it may begin with, both from the prototype; `groups`
is derived from `len` the way the prototype derives it (8 → `4 4`, 9 → `3 3 3`, 10 → `3 3 4`,
otherwise `3 3 3 3`) and drives both the mask and the placeholder — Saudi Arabia's is
`5XX XXX XXX`. A country with `len: 0` is the prototype's generic case: six digits or more, and
the hint says so instead of naming a length.

## Live use
`QuickSend`'s recipient input (`control` mode) and the ContactPicker manual entry hint
(`ContactPicker/sources/manual.js` derives its example from `PhoneField.example()`); the Devices
screen's pairing form and the Contacts screen's contact form both mount the full field.

## Design gate
- Colour is never the only signal: the complete state adds a tick, the error state changes the
  hint line to the reason and sets `aria-invalid`, and the ring around the box changes with it.
- `aria-invalid` and the error wording arrive on blur, not mid-typing — a half-typed number is not
  yet wrong. `opts.invalid` lets a form's own submit-time validation force the state.
- The caret survives the mask: the digits before it are counted, the value rewritten, and the
  caret put back after the same digit, so a space the mask inserts never throws the cursor.
- Keyboard throughout: the trigger opens on Enter, Space or ArrowDown, focus moves into the search
  box, Arrow keys walk the list, Enter takes the row under the cursor, Escape closes and hands
  focus back to the trigger. The `!` bubble opens on focus as well as hover and closes on Escape.
- `type="tel"`, `inputmode="numeric"`, `dir="ltr"` and a monospace face, so the number reads the
  same way inside an Arabic form as inside an English one; every offset is a logical property, so
  the trigger sits at the inline-start in both scripts.
- The hint slot keeps a reserved height, so the field does not jump as its state changes.
- Contrast measured in the browser against the product's palette: the hint, the ISO code, the dial
  code, the list rows and the tip bubble all clear WCAG AA at their own size.
- The component draws its own caret, search and tick as inline SVG rather than icon-font glyphs:
  Frappe's global icon rule carries `margin: 0 auto`, which inside a flex row hands the icon the
  free space and parks it in the middle of its line.

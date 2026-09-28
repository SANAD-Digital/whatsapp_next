# `sanad.ui.PhoneField`

A phone input ported from the design prototype (`docs/component/Phone Field.dc.html`). It has
two modes. **Wrapper mode** renders the full field: a country trigger showing ISO code and dial
code, a searchable country popup (by name, ISO prefix or dial code), a digit-only input masked
into the country's own groups, a tick once the number is complete and valid, a hint line that
turns into the reason on error, and an optional `!` tip bubble. **Control mode** wraps an
existing Frappe Data control and adds only a country hint line and loose E.164 normalisation.
Validation is guidance only; the server's phone normaliser stays authoritative.

**Portability:** the country catalogue comes from `phone.get_countries` → `{countries:
[{iso, main, dial, example, international, trunk, len, mobile?}], default?}` (built from
libphonenumber on this app's server). Without it the field falls back to an 11-region seed (SA,
AE, KW, QA, BH, OM, YE, EG, JO, US, GB). The hint copy mentions WhatsApp. Region names come from
`Intl.DisplayNames`, not the server.

## Options

| Option | Type | Default | Meaning |
|---|---|---|---|
| `wrapper` | jQuery \| HTMLElement | — | Render the full field here (wrapper mode). |
| `control` | Frappe control | — | Wrap this Data control instead (control mode; takes precedence). |
| `country_default` | string | resolved | ISO-2 or country name. Resolution order: this → server `default` (`site_region`) → `config.defaults.country` → `frappe.boot.sysdefaults.country` → `SA` → first catalogue row. |
| `on_change` | `(value) => void` | — | Called with `get_value()` on every input / country pick (control mode: debounced 200 ms, and on blur). |
| `label` | string | "Mobile number (WhatsApp)" | `""` renders no label. Wrapper mode. |
| `tip` | string | — | Text of the `!` bubble; no bubble when omitted. |
| `hint` | string | — | Replaces the default hint while there is no error. |
| `placeholder` | string | region sample | Overrides the mask-derived placeholder (wrapper mode only). |
| `value` | string | — | Initial value (E.164 or national) via `set_value`. |
| `required` | boolean | `false` | Adds `*`, `required`, `aria-required`. |
| `invalid` | boolean | `false` | Forces the error state from outside. |
| `show_country` | boolean | `true` | `false` removes the country trigger. |

## Methods

- `get_value()` → wrapper: `{phone (masked), phone_e164 (null unless valid), valid, empty, country, iso, dial ("+966"), national, e164}`; control: `normalize(input, country)` = `{phone, phone_e164, valid, country, empty}`.
- `set_value(value)` — `+…` / `00…` picks the country by longest dial code (main region first on ties); otherwise digits as national. Truncates to the country's `len` (or 14).
- `set_country(iso_or_name)`, `focus()`, `example()` (formatted example for the current country), `render()`, `destroy()` (removes document listeners and the DOM / hint).

Static:
- `PhoneField.countries` — the current catalogue (decorated with `name`, string `dial`, `groups`).
- `PhoneField.site_region` — server default region once loaded.
- `PhoneField.resolve_country(hint)` — catalogue row (see resolution order above).
- `PhoneField.normalize(raw, country)` — maps Arabic-Indic digits, strips spaces / `-()`. `00` → `+`; national numbers get the country dial code (leading zeros dropped). Valid when `^\+[1-9]\d{7,14}$`.
- `PhoneField.format_display(e164, country?)` — `+966 50 123 4567` style, country grouping when the length matches, else groups of 3.
- `PhoneField.mask(digits, country)` — groups by `country.groups`.
- `PhoneField.example(country?, {format=true})` — from the region's own sample; `format:false` gives bare E.164.
- `PhoneField.mobile_ok(digits, pattern)` — tests the region's `mobile` regex (unparsable = pass).

## Events and callbacks

- `on_change(value)` only. No custom DOM events, no realtime.
- Wrapper mode adds document-level `mousedown` (close popup / tip on outside click) and a
  capturing `keydown` (Escape closes popup, then tip, with `stopPropagation`). `destroy()` removes both.

## Server calls

| Key | Args | When |
|---|---|---|
| `phone.get_countries` | `{}` | First construction per page (shared promise; failure keeps the seed). |

## Usage

```js
const phone = new sanad.ui.PhoneField({
  wrapper: $slot,
  required: true,
  tip: __("The number customers write to."),
  on_change: ({ valid, phone_e164 }) => (state.phone = valid ? phone_e164 : null),
});
phone.set_value("+966501234567");

// Hint-only over a dialog field
new sanad.ui.PhoneField({ control: dialog.fields_dict.phone });

sanad.ui.PhoneField.format_display("+966501234567");
```

## CSS hooks

- Root `.sanad-kit.sanad-phone` (`id` = uid); `data-slot` attributes: `labelrow`, `box`,
  `trigger`, `iso`, `dial`, `caret`, `tick`, `msg`.
- `__label`, `__req`, `__tip-btn` (`--seen`), `__tip-pop`; `__box` (`--focus`, `--error`,
  `--ok`); `__country`, `__iso`, `__dial`, `__caret` (`--open`); `__input`; `__tick`.
- Popup: `__pop`, `__search`, `__q`, `__list`, `__opt` (`--on`, `--cursor`), `__opt-iso`,
  `__opt-name`, `__opt-dial`, `__empty`; `__svg` for the inline SVGs.
- Hint: `.sanad-phone__hint` (`--ok`, `--error`) — also used in control mode, appended to the
  control's `.control-input-wrapper`.

## Notes

- **Validity (wrapper):** complete when digits = `country.len` (≥ 6 if no `len`), and the region's
  `mobile` regex matches when one is sent. Errors show only after blur with digits present, or
  when `invalid` is set: "Not a mobile number in {country}…" or "The number must be N digits after +C".
- **Masking** keeps the caret after the same digit; Arabic-Indic digits are accepted.
- **Control mode hint:** empty → "Numbers without a country code are sent as +C (country)";
  valid → "Will be sent to …"; invalid → example, error class after blur.
- **Keyboard / ARIA:** trigger opens on Enter / Space / ArrowDown (`aria-haspopup="listbox"`,
  `aria-expanded`); the search is a `role="combobox"`; ArrowUp/Down move a cursor, Enter picks;
  Escape closes and refocuses the trigger. Tip opens on hover, focus or click. Input is
  `type="tel"`, `inputmode="numeric"`, `dir="ltr"`; `aria-invalid` on error; hint is `aria-live`.
- **Bug — catalogue redraw never runs:** after `phone.get_countries` resolves, the constructor
  checks `this.$el`, which is never assigned (the widget uses `$root`), so the field keeps the
  seed-resolved country and never re-resolves to the server `default` or a non-seed
  `country_default`. `countries` itself is updated.
- **Bug — `mask` fallback:** `mask()` calls an undefined `groups_for(0)` when the country has no
  `groups` (e.g. `mask(d, null)`); catalogue rows always have `groups`, so it only bites direct callers.
- **Live use:** `public/js/ui/QuickSend/index.js` (control mode), `public/js/ui/OverlayPanel/index.js`
  (`phone` field type), `public/js/screens/campaign/messages.js`,
  `whatsapp_next/page/wa_onboarding/wa_onboarding.js`, `whatsapp_next/page/wa_devices/wa_devices.js`
  (field + `format_display`), `whatsapp_next/page/wa_simulator/wa_simulator.js` (`normalize`),
  and `ContactPicker/sources/manual.js` (`example()`).

# PhoneField

A phone input with a country hint and loose client-side E.164 normalisation: spaces, dashes and
brackets are stripped, Arabic-Indic digits mapped, a leading `00` becomes `+`, and a local number
gets the dial code of the hinted country (`country_default`, else
`frappe.boot.sysdefaults.country`, matched against an embedded table of ~65 common countries).
The hint under the field says what will be sent ("Will be sent to +966 501 234 567") or what is
missing, and is wired with `aria-describedby`; the field validates while typing (soft) and on blur
(firm, `aria-invalid`). The server's `phone.normalize` stays authoritative — this is guidance.
Standalone (`wrapper`) or wrapped around an existing Frappe Data control (`control`). No
external libraries.

## Usage

```js
// Standalone (dialogs, pages, ContactPicker manual entry)
const phone = new sanad.ui.PhoneField({
  wrapper: $slot,
  label: __("WhatsApp number"),
  required: true,
  on_change: ({ phone, phone_e164, valid }) => (state.phone = phone_e164),
});
phone.get_value();          // → { phone, phone_e164, valid, country }
phone.set_value("0501234567");
phone.set_country("AE");
phone.example();            // → "+966 501 234 567" (concrete example for the field's country)

// Wrapping a form control (the hint renders under Frappe's own input)
new sanad.ui.PhoneField({ control: frm.get_field("mobile_no"), on_change: ({ valid }) => …});

// Helpers
sanad.ui.PhoneField.normalize("00966 50 123 4567");          // → { phone_e164: "+966501234567", valid: true }
sanad.ui.PhoneField.format_display("+966501234567");         // → "+966 501 234 567"
sanad.ui.PhoneField.example("AE");                           // → "+971 501 234 567" (site country when omitted)
sanad.ui.PhoneField.example(null, { format: false });        // → "+966501234567"
sanad.ui.PhoneField.countries;                               // [{iso, name, dial}, …]
```

Options: `wrapper` | `control`, `country_default` (Country name or ISO-2), `on_change`, `label`,
`placeholder`, `value`, `required`, `show_country` (standalone country select, default `true`).
Methods: `get_value()`, `set_value(v)`, `set_country(iso|name)`, `focus()`, `example()`,
`destroy()`. Statics: `normalize`, `format_display`, `resolve_country`, `example(country?,
{format})`, `countries`.

## Live use
QuickSend recipient input (`ui/QuickSend` wraps its `phone` control) and the ContactPicker manual
entry hint (`ui/ContactPicker/sources/manual.js` derives its example from `PhoneField.example()`);
the Onboarding wizard and Simulator sender in phase 6.

## Design gate
- Error placed next to the field and linked with `aria-describedby`; `aria-invalid` only after
  blur (validate-on-blur), so the user is not shouted at mid-typing.
- The hint slot has a reserved height; icon + text for each state (never colour alone); the copy
  says what happens ("Numbers without a country code are sent as +966 (Saudi Arabia)").
- `type="tel"`, `inputmode="tel"`, `autocomplete="tel"`, `dir="ltr"` for correct keyboards and
  bidi rendering inside RTL forms; tabular numerals.
- Country select and input are ≥ 32 px targets; the row wraps on phones; the focus ring comes
  from the kit's global rule.
- Examples in copy come from `example()` for the resolved country ("e.g. +966 501 234 567"),
  never a hard-coded number — other components reuse the same helper.

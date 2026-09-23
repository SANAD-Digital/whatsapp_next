// sanad.ui.PhoneField — a phone input with a country hint and loose client-side E.164
// normalisation: strips spaces / dashes / brackets, maps Arabic-Indic digits, turns a leading
// `00` into `+`, and prefixes a local number with the dial code of the hinted country
// (`country_default` → `frappe.boot.sysdefaults.country`). The hint under the field says what
// will be sent and is wired with `aria-describedby`; validation runs on blur and while typing.
// The server's `phone.normalize` remains authoritative — this is guidance, not validation.
// Standalone (`wrapper`) or wrapping an existing Frappe Data control (`control`). No external libs.

import ui from "../_core/index.js";

// ISO | Frappe Country name | dial — the most common ~60 countries (server table is complete).
const COUNTRIES = [
	["SA", "Saudi Arabia", "966"],
	["AE", "United Arab Emirates", "971"],
	["KW", "Kuwait", "965"],
	["QA", "Qatar", "974"],
	["BH", "Bahrain", "973"],
	["OM", "Oman", "968"],
	["YE", "Yemen", "967"],
	["JO", "Jordan", "962"],
	["EG", "Egypt", "20"],
	["IQ", "Iraq", "964"],
	["SY", "Syria", "963"],
	["LB", "Lebanon", "961"],
	["PS", "Palestine", "970"],
	["SD", "Sudan", "249"],
	["LY", "Libya", "218"],
	["TN", "Tunisia", "216"],
	["DZ", "Algeria", "213"],
	["MA", "Morocco", "212"],
	["MR", "Mauritania", "222"],
	["SO", "Somalia", "252"],
	["DJ", "Djibouti", "253"],
	["KM", "Comoros", "269"],
	["TR", "Turkey", "90"],
	["IR", "Iran", "98"],
	["PK", "Pakistan", "92"],
	["IN", "India", "91"],
	["BD", "Bangladesh", "880"],
	["LK", "Sri Lanka", "94"],
	["NP", "Nepal", "977"],
	["AF", "Afghanistan", "93"],
	["ID", "Indonesia", "62"],
	["MY", "Malaysia", "60"],
	["PH", "Philippines", "63"],
	["SG", "Singapore", "65"],
	["CN", "China", "86"],
	["JP", "Japan", "81"],
	["KR", "South Korea", "82"],
	["HK", "Hong Kong", "852"],
	["US", "United States", "1"],
	["CA", "Canada", "1"],
	["MX", "Mexico", "52"],
	["BR", "Brazil", "55"],
	["AR", "Argentina", "54"],
	["GB", "United Kingdom", "44"],
	["IE", "Ireland", "353"],
	["FR", "France", "33"],
	["DE", "Germany", "49"],
	["IT", "Italy", "39"],
	["ES", "Spain", "34"],
	["PT", "Portugal", "351"],
	["NL", "Netherlands", "31"],
	["BE", "Belgium", "32"],
	["CH", "Switzerland", "41"],
	["AT", "Austria", "43"],
	["SE", "Sweden", "46"],
	["NO", "Norway", "47"],
	["DK", "Denmark", "45"],
	["PL", "Poland", "48"],
	["GR", "Greece", "30"],
	["RU", "Russia", "7"],
	["UA", "Ukraine", "380"],
	["AU", "Australia", "61"],
	["NZ", "New Zealand", "64"],
	["ZA", "South Africa", "27"],
	["NG", "Nigeria", "234"],
	["KE", "Kenya", "254"],
	["ET", "Ethiopia", "251"],
	["GH", "Ghana", "233"],
].map(([iso, name, dial]) => ({ iso, name, dial }));

const E164 = /^\+[1-9]\d{7,14}$/; // 8–15 digits: loose, the server is authoritative

// National sample numbers for examples in copy (fictional ranges); others use a generic pattern.
const SAMPLE_NATIONAL = { SA: "501234567", AE: "501234567", KW: "51234567", QA: "33123456", BH: "36001234", OM: "92123456", YE: "712345678", JO: "791234567", EG: "1001234567", IQ: "7901234567", LB: "71123456", TR: "5321234567", PK: "3001234567", IN: "9876543210", US: "4155552671", CA: "4165550123", GB: "7911123456", DE: "15123456789", FR: "612345678" };
const ARABIC_DIGITS = { "٠": "0", "١": "1", "٢": "2", "٣": "3", "٤": "4", "٥": "5", "٦": "6", "٧": "7", "٨": "8", "٩": "9", "۰": "0", "۱": "1", "۲": "2", "۳": "3", "۴": "4", "۵": "5", "۶": "6", "۷": "7", "۸": "8", "۹": "9" };

sanad.ui.PhoneField = class PhoneField {
	/**
	 * @param {Object} opts
	 * @param {jQuery|HTMLElement} [opts.wrapper] — render a standalone field here
	 * @param {Object} [opts.control] — or wrap an existing Frappe Data control (`frm.get_field("phone")`)
	 * @param {string} [opts.country_default] — Country name or ISO-2; default `frappe.boot.sysdefaults.country`
	 * @param {Function} [opts.on_change] — `({phone, phone_e164, valid, country}) => void`
	 * @param {string} [opts.label] — standalone label (default "Phone")
	 * @param {string} [opts.placeholder]
	 * @param {string} [opts.value] — initial value
	 * @param {boolean} [opts.required=false]
	 * @param {boolean} [opts.show_country=true] — the country select (standalone only)
	 */
	constructor(opts = {}) {
		this.opts = Object.assign({ label: __("Phone"), show_country: true, required: false }, opts);
		this.id = ui.uid("phone");
		this.country = sanad.ui.PhoneField.resolve_country(this.opts.country_default);
		this.make();
		if (this.opts.value != null) this.set_value(this.opts.value);
		else this.render_hint();
	}

	static get countries() {
		return COUNTRIES;
	}

	/** Country record from an ISO-2 code or a Country name; falls back to `sysdefaults.country`. */
	static resolve_country(hint) {
		const wanted = cstr(hint || (frappe.boot && frappe.boot.sysdefaults && frappe.boot.sysdefaults.country) || "").trim().toLowerCase();
		if (!wanted) return null;
		return (
			COUNTRIES.find((c) => c.iso.toLowerCase() === wanted) ||
			COUNTRIES.find((c) => c.name.toLowerCase() === wanted) ||
			COUNTRIES.find((c) => wanted.startsWith(c.name.toLowerCase().slice(0, 6))) ||
			null
		);
	}

	/**
	 * Loose E.164 normalisation → `{phone, phone_e164, valid, country}`.
	 * `phone_e164` is null when the result is not `+` followed by 7–15 digits.
	 */
	static normalize(raw, country) {
		const phone = cstr(raw);
		let s = phone.replace(/[٠-٩۰-۹]/g, (d) => ARABIC_DIGITS[d] || d);
		s = s.replace(/[\s\-().]/g, "");
		if (!s) return { phone, phone_e164: null, valid: false, country, empty: true };
		let e164 = null;
		if (s.startsWith("00")) s = `+${s.slice(2)}`;
		if (s.startsWith("+")) {
			e164 = s;
		} else if (/^\d+$/.test(s)) {
			if (country) {
				if (s.startsWith("0")) e164 = `+${country.dial}${s.replace(/^0+/, "")}`;
				else if (s.startsWith(country.dial) && s.length >= country.dial.length + 9) e164 = `+${s}`;
				else e164 = `+${country.dial}${s}`;
			} else if (s.length >= 10) {
				e164 = `+${s}`;
			}
		}
		const valid = !!e164 && E164.test(e164);
		return { phone, phone_e164: valid ? e164 : null, valid, country, empty: false };
	}

	/** `+966 50 123 4567` style grouping for display only. */
	static format_display(e164, country) {
		if (!e164) return "";
		const dial = country && e164.startsWith(`+${country.dial}`) ? country.dial : COUNTRIES.map((c) => c.dial).sort((a, b) => b.length - a.length).find((d) => e164.startsWith(`+${d}`)) || "";
		const rest = e164.slice(1 + dial.length);
		const groups = rest.match(/.{1,3}/g) || [];
		if (groups.length > 1 && groups[groups.length - 1].length < 2) {
			const last = groups.pop();
			groups[groups.length - 1] += last;
		}
		return `+${dial} ${groups.join(" ")}`.trim();
	}

	make() {
		const hint_id = `${this.id}-hint`;
		if (this.opts.control) {
			this.control = this.opts.control;
			this.$input = this.control.$input;
			this.$hint = $(`<div class="sanad-kit sanad-phone__hint" id="${hint_id}" aria-live="polite"></div>`);
			this.control.$wrapper.find(".control-input-wrapper").append(this.$hint);
			this.$input.attr({ inputmode: "tel", autocomplete: "tel", dir: "ltr" });
		} else {
			const input_id = `${this.id}-input`;
			this.$root = $(`
				<div class="sanad-kit sanad-phone" id="${this.id}">
					<label class="sanad-phone__label" for="${input_id}">${ui.escape(this.opts.label)}${this.opts.required ? ' <span class="sanad-phone__req" aria-hidden="true">*</span>' : ""}</label>
					<div class="sanad-phone__row">
						<select class="form-control sanad-phone__country" aria-label="${ui.escape(__("Country"))}"></select>
						<input class="form-control sanad-phone__input" id="${input_id}" type="tel" inputmode="tel" autocomplete="tel" dir="ltr" placeholder="${ui.escape(this.opts.placeholder || this.example())}"${this.opts.required ? ' required aria-required="true"' : ""}>
					</div>
					<div class="sanad-phone__hint" id="${hint_id}" aria-live="polite"></div>
				</div>`);
			$(this.opts.wrapper).append(this.$root);
			this.$input = this.$root.find(".sanad-phone__input");
			this.$hint = this.$root.find(".sanad-phone__hint");
			this.$country = this.$root.find(".sanad-phone__country");
			if (this.opts.show_country) this.make_country_select();
			else this.$country.remove();
		}
		this.$input.attr("aria-describedby", [this.$input.attr("aria-describedby"), hint_id].filter(Boolean).join(" "));
		const on_input = ui.debounce(() => this.on_input(), 200);
		this.$input.on("input", on_input);
		this.$input.on("blur", () => {
			on_input.cancel && on_input.cancel();
			this.on_input(true);
		});
	}

	/** A concrete, formatted example for the field's country, e.g. `+966 501 234 567`. */
	example() {
		return sanad.ui.PhoneField.example(this.country);
	}

	/**
	 * Static example for a country record, ISO-2 or Country name (default: the site's country);
	 * `{format: false}` returns the bare E.164 (`+966501234567`).
	 */
	static example(country, { format = true } = {}) {
		const c = country && typeof country === "object" ? country : sanad.ui.PhoneField.resolve_country(country);
		const dial = c ? c.dial : "966";
		const national = (c && SAMPLE_NATIONAL[c.iso]) || "123456789";
		const e164 = `+${dial}${national}`;
		return format ? sanad.ui.PhoneField.format_display(e164, c) : e164;
	}

	make_country_select() {
		const options = [`<option value="">${ui.escape(__("Country code"))}</option>`].concat(
			COUNTRIES.map((c) => `<option value="${c.iso}"${this.country && this.country.iso === c.iso ? " selected" : ""}>${ui.escape(`${__(c.name)} (+${c.dial})`)}</option>`)
		);
		this.$country.html(options.join("")).on("change", () => {
			this.country = COUNTRIES.find((c) => c.iso === this.$country.val()) || null;
			this.on_input(true);
		});
	}

	set_country(iso_or_name) {
		this.country = sanad.ui.PhoneField.resolve_country(iso_or_name);
		if (this.$country) this.$country.val(this.country ? this.country.iso : "");
		this.render_hint();
		return this;
	}

	on_input(blurred = false) {
		this.touched = this.touched || blurred;
		const result = this.render_hint();
		if (this.opts.on_change) this.opts.on_change(result);
		return result;
	}

	render_hint() {
		const result = this.get_value();
		const $i = this.$input;
		this.$hint.removeClass("sanad-phone__hint--ok sanad-phone__hint--error");
		if (result.empty) {
			$i.removeAttr("aria-invalid");
			this.$hint.html(
				this.country
					? `${ui.icon("es-line-globe", "xs")} <span>${ui.escape(__("Numbers without a country code are sent as +{0} ({1})", [this.country.dial, __(this.country.name)]))}</span>`
					: `${ui.icon("es-line-globe", "xs")} <span>${ui.escape(__("Start with the country code, e.g. {0}", [this.example()]))}</span>`
			);
			return result;
		}
		if (result.valid) {
			$i.removeAttr("aria-invalid");
			this.$hint.addClass("sanad-phone__hint--ok").html(`${ui.icon("es-line-success", "xs")} <span>${ui.escape(__("Will be sent to {0}", [sanad.ui.PhoneField.format_display(result.phone_e164, this.country)]))}</span>`);
			return result;
		}
		// invalid: soft while typing, firm after blur (validate-on-blur finding)
		if (this.touched) $i.attr("aria-invalid", "true");
		this.$hint.addClass(this.touched ? "sanad-phone__hint--error" : "").html(
			`${ui.icon("es-line-alert-triangle", "xs")} <span>${ui.escape(__("Enter a number with its country code, e.g. {0}", [this.example()]))}</span>`
		);
		return result;
	}

	/** `{phone, phone_e164, valid, country}` for the current input. */
	get_value() {
		return sanad.ui.PhoneField.normalize(this.$input.val(), this.country);
	}

	set_value(value) {
		if (this.control && typeof this.control.set_value === "function") this.control.set_value(cstr(value));
		else this.$input.val(cstr(value));
		this.render_hint();
		return this;
	}

	focus() {
		this.$input.trigger("focus");
		return this;
	}

	destroy() {
		this.$input.off("input blur");
		if (this.$root) this.$root.remove();
		else this.$hint.remove();
	}
};

export default sanad.ui.PhoneField;

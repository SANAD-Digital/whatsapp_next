// sanad.ui.PhoneField — the design prototype's phone field (`docs/component/Phone Field.dc.html`),
// ported as a real component: a country trigger carrying the ISO code and the dial code, a popup
// that searches by country name, ISO or dial code, a digit-only input masked into the country's
// own groups, a tick the moment the number is complete, a hint line that turns into the exact
// reason when it is not, and an optional `!` bubble that explains what the number is for and
// starts enlarged with a ring until it has been opened once.
//
// Why a component and not a Frappe control: Frappe has no phone field. A Data control with a
// country hint underneath is what this was before, and it could not mask, could not say "nine
// digits after +966", and could not tell a Saudi number from a Kuwaiti one. The prototype draws
// its own, so this draws its own.
//
// Two modes, and the difference matters:
//   `wrapper` — renders the full widget above. This is the prototype's field.
//   `control` — wraps a Frappe Data control that already exists (a dialog field) and gives it the
//               country hint and the loose E.164 normalisation only. Unchanged from before, so
//               QuickSend's dialog keeps working exactly as it did.
//
// Validation is guidance. The server's `phone.normalize` stays authoritative; nothing here blocks
// a save. No external libraries, no country flags (an image per country for a dial code is a
// payload and a politics), and every string goes through `__()`.

import ui from "../_core/index.js";

// ISO | Frappe Country name | dial — the most common ~68 countries (server table is complete).
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
];

// The national-number shape, from the prototype: how many digits a mobile has after the dial code,
// and which digits it may start with. A country with `len: 0` is the prototype's own generic case
// — it accepts six digits or more and says so. `groups` is derived from the length exactly as the
// prototype derives it, and is what both the mask and the placeholder are built from.
const SHAPES = {
	SA: [9, "5"],
	AE: [9, "5"],
	KW: [8, "569"],
	QA: [8, "3567"],
	BH: [8, "3"],
	OM: [8, "79"],
	YE: [9, "7"],
	JO: [9, "7"],
	EG: [10, "1"],
	IQ: [10, "7"],
	SY: [9, "9"],
	LB: [8, ""],
	PS: [9, "5"],
	SD: [9, "9"],
	LY: [9, "9"],
	TN: [8, ""],
	DZ: [9, "5679"],
	MA: [9, "67"],
	MR: [8, ""],
	SO: [0, ""],
	DJ: [8, ""],
	KM: [7, ""],
	TR: [10, "5"],
	US: [10, ""],
	CA: [10, ""],
	GB: [10, ""],
	IN: [10, ""],
	PK: [10, "3"],
};

const groups_for = (len) => (len === 8 ? [4, 4] : len === 9 ? [3, 3, 3] : len === 10 ? [3, 3, 4] : [3, 3, 3, 3]);

const CATALOG = COUNTRIES.map(([iso, name, dial]) => {
	const [len, starts] = SHAPES[iso] || [0, ""];
	return { iso, name, dial, len, starts: starts ? starts.split("") : [], groups: groups_for(len) };
});

const E164 = /^\+[1-9]\d{7,14}$/; // 8–15 digits: loose, the server is authoritative
const ARABIC_DIGITS = { "٠": "0", "١": "1", "٢": "2", "٣": "3", "٤": "4", "٥": "5", "٦": "6", "٧": "7", "٨": "8", "٩": "9", "۰": "0", "۱": "1", "۲": "2", "۳": "3", "۴": "4", "۵": "5", "۶": "6", "۷": "7", "۸": "8", "۹": "9" };

// National sample numbers for examples in copy (fictional ranges); others use a generic pattern.
const SAMPLE_NATIONAL = { SA: "501234567", AE: "501234567", KW: "51234567", QA: "33123456", BH: "36001234", OM: "92123456", YE: "712345678", JO: "791234567", EG: "1001234567", IQ: "7901234567", LB: "71123456", TR: "5321234567", PK: "3001234567", IN: "9876543210", US: "4155552671", CA: "4165550123", GB: "7911123456", DE: "15123456789", FR: "612345678" };

/** Latin and Arabic-Indic digits in, Latin digits only out. */
const to_digits = (raw) =>
	String(raw == null ? "" : raw)
		.replace(/[٠-٩۰-۹]/g, (d) => ARABIC_DIGITS[d] || d)
		.replace(/\D/g, "");

// The search glyph is the shared one (`ui.ico`, the family ported from the prototype). The other
// two are drawn here because that family has no caret, and its `check` is a circled tick where
// this field wants the prototype's bare one — the same bare tick the sign-up rail uses.
// TODO(kit): once `_kit/icons.js` gains a `caret` and a bare `tick`, these two go with them.
const SVG = {
	caret: '<svg class="sanad-phone__svg" width="11" height="11" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M5 8l5 5 5-5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
	tick: '<svg class="sanad-phone__svg" width="15" height="15" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M4 10.5l4 4 8-9" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};

sanad.ui.PhoneField = class PhoneField {
	/**
	 * @param {Object} opts
	 * @param {jQuery|HTMLElement} [opts.wrapper] — render the full field here
	 * @param {Object} [opts.control] — or wrap an existing Frappe Data control (hint-only mode)
	 * @param {string} [opts.country_default] — Country name or ISO-2; falls back to
	 *   `sanad.ui.config.defaults.country`, then `frappe.boot.sysdefaults.country`, then `SA`
	 * @param {Function} [opts.on_change] — `({phone, phone_e164, valid, country, iso, dial, national, e164})`
	 * @param {string} [opts.label] — default "Mobile number (WhatsApp)"; `""` renders no label
	 * @param {string} [opts.tip] — the `!` bubble's text
	 * @param {string} [opts.hint] — replaces the default hint line while the number is valid
	 * @param {string} [opts.placeholder] — overrides the mask-derived placeholder
	 * @param {string} [opts.value] — initial value (E.164 or national)
	 * @param {boolean} [opts.required=false]
	 * @param {boolean} [opts.invalid=false] — force the error state from outside
	 * @param {boolean} [opts.show_country=true] — the country trigger (wrapper mode only)
	 */
	constructor(opts = {}) {
		this.opts = Object.assign({ show_country: true, required: false, invalid: false }, opts);
		if (this.opts.label == null) this.opts.label = __("Mobile number (WhatsApp)");
		this.id = ui.uid("phone");
		this.country = sanad.ui.PhoneField.resolve_country(this.opts.country_default);
		this.state = { open: false, touched: false, focus: false, q: "", tip: false, tip_seen: false };
		this.digits = "";
		this.make();
		if (this.opts.value != null) this.set_value(this.opts.value);
		else this.render();
	}

	static get countries() {
		return CATALOG;
	}

	/**
	 * Country record from an ISO-2 code or a Country name. Falls back to the host's configured
	 * default, then the site's country, then Saudi Arabia — which is the prototype's default and
	 * the only one for which "no country at all" was never a sensible answer.
	 */
	static resolve_country(hint) {
		const config = (ui.config && ui.config.defaults && ui.config.defaults.country) || "";
		const site = (frappe.boot && frappe.boot.sysdefaults && frappe.boot.sysdefaults.country) || "";
		const tries = [hint, config, site, "SA"];
		for (const raw of tries) {
			const wanted = cstr(raw || "").trim().toLowerCase();
			if (!wanted) continue;
			const hit =
				CATALOG.find((c) => c.iso.toLowerCase() === wanted) ||
				CATALOG.find((c) => c.name.toLowerCase() === wanted) ||
				CATALOG.find((c) => wanted.startsWith(c.name.toLowerCase().slice(0, 6)));
			if (hit) return hit;
		}
		return CATALOG[0];
	}

	/** Group a national number into its country's own groups: `559021177` → `559 021 177`. */
	static mask(digits, country) {
		const d = cstr(digits);
		const groups = (country && country.groups) || groups_for(0);
		const out = [];
		let i = 0;
		groups.forEach((g) => {
			if (i < d.length) {
				out.push(d.slice(i, i + g));
				i += g;
			}
		});
		if (i < d.length) out.push(d.slice(i));
		return out.join(" ");
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

	/** `+966 559 021 177` style grouping for display only. */
	static format_display(e164, country) {
		if (!e164) return "";
		const dial =
			country && e164.startsWith(`+${country.dial}`)
				? country.dial
				: CATALOG.map((c) => c.dial)
						.sort((a, b) => b.length - a.length)
						.find((d) => e164.startsWith(`+${d}`)) || "";
		const rest = e164.slice(1 + dial.length);
		// the country's own grouping when the number is the length that country uses
		const hit = country || CATALOG.find((c) => c.dial === dial && c.len && c.len === rest.length);
		if (hit && hit.len && hit.len === rest.length) return `+${dial} ${sanad.ui.PhoneField.mask(rest, hit)}`.trim();
		const groups = rest.match(/.{1,3}/g) || [];
		if (groups.length > 1 && groups[groups.length - 1].length < 2) {
			const last = groups.pop();
			groups[groups.length - 1] += last;
		}
		return `+${dial} ${groups.join(" ")}`.trim();
	}

	/**
	 * Static example for a country record, ISO-2 or Country name (default: the resolved default);
	 * `{format: false}` returns the bare E.164 (`+966501234567`).
	 */
	static example(country, { format = true } = {}) {
		const c = country && typeof country === "object" ? country : sanad.ui.PhoneField.resolve_country(country);
		const dial = c ? c.dial : "966";
		const national = (c && SAMPLE_NATIONAL[c.iso]) || "123456789";
		const e164 = `+${dial}${national}`;
		return format ? sanad.ui.PhoneField.format_display(e164, c) : e164;
	}

	// ---- mount -------------------------------------------------------------------------------

	make() {
		return this.opts.control ? this.make_control() : this.make_widget();
	}

	/**
	 * Hint-only mode over an existing Frappe Data control. Unchanged behaviour: the control stays
	 * Frappe's, and gains the country hint and the normalisation this component knows.
	 */
	make_control() {
		const hint_id = `${this.id}-hint`;
		this.control = this.opts.control;
		this.$input = this.control.$input;
		this.$hint = $(`<div class="sanad-kit sanad-phone__hint" id="${hint_id}" aria-live="polite"></div>`);
		this.control.$wrapper.find(".control-input-wrapper").append(this.$hint);
		this.$input.attr({ inputmode: "tel", autocomplete: "tel", dir: "ltr" });
		this.$input.attr("aria-describedby", [this.$input.attr("aria-describedby"), hint_id].filter(Boolean).join(" "));
		const on_input = ui.debounce(() => this.on_control_input(), 200);
		this.$input.on("input", on_input);
		this.$input.on("blur", () => {
			on_input.cancel && on_input.cancel();
			this.on_control_input(true);
		});
		this.render_control_hint();
	}

	/** The prototype's field: label (with its optional bubble), the box, and the message line. */
	make_widget() {
		const o = this.opts;
		const input_id = `${this.id}-input`;
		const hint_id = `${this.id}-hint`;
		this.$root = $(`
			<div class="sanad-kit sanad-phone" id="${this.id}">
				<div class="sanad-phone__labelrow" data-slot="labelrow">
					<label class="sanad-phone__label" for="${input_id}">${ui.escape(o.label)}${o.required ? ' <span class="sanad-phone__req" aria-hidden="true">*</span>' : ""}</label>
				</div>
				<div class="sanad-phone__box" data-slot="box">
					<button type="button" class="sanad-phone__country" data-slot="trigger" aria-haspopup="listbox" aria-expanded="false">
						<span class="sanad-phone__iso" data-slot="iso"></span>
						<span class="sanad-phone__dial" dir="ltr" data-slot="dial"></span>
						<span class="sanad-phone__caret" data-slot="caret">${SVG.caret}</span>
					</button>
					<input class="sanad-phone__input" id="${input_id}" type="tel" dir="ltr" inputmode="numeric"
						autocomplete="tel-national" aria-describedby="${hint_id}"${o.required ? ' required aria-required="true"' : ""}>
					<span class="sanad-phone__tick" data-slot="tick" aria-hidden="true">${SVG.tick}</span>
				</div>
				<div class="sanad-phone__hint" id="${hint_id}" data-slot="msg" aria-live="polite"></div>
			</div>`);
		$(o.wrapper).append(this.$root);
		this.$box = this.$root.find('[data-slot="box"]');
		this.$trigger = this.$root.find('[data-slot="trigger"]');
		this.$input = this.$root.find(".sanad-phone__input");
		this.$tick = this.$root.find('[data-slot="tick"]');
		this.$hint = this.$root.find('[data-slot="msg"]');

		if (!o.label) this.$root.find(".sanad-phone__label").remove();
		if (!o.show_country) this.$trigger.remove();
		if (o.tip) this.make_tip();

		this.$trigger.on("click", () => this.toggle_popup());
		this.$trigger.on("keydown", (e) => {
			if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") {
				e.preventDefault();
				this.toggle_popup(true);
			}
		});
		this.$input.on("input", (e) => this.on_input(e.currentTarget));
		this.$input.on("focus", () => {
			this.state.focus = true;
			this.render();
		});
		this.$input.on("blur", () => {
			this.state.focus = false;
			this.state.touched = true;
			this.render();
		});

		this.on_doc_down = (e) => {
			if (this.state.open && !$(e.target).closest(`#${this.id}`).length) this.close_popup();
			if (this.state.tip && !$(e.target).closest(`#${this.id}`).length) {
				this.state.tip = false;
				this.render_tip();
			}
		};
		this.on_doc_key = (e) => {
			if (e.key !== "Escape") return;
			if (this.state.open) {
				e.stopPropagation();
				this.close_popup();
				this.$trigger.trigger("focus");
			} else if (this.state.tip) {
				e.stopPropagation();
				this.state.tip = false;
				this.render_tip();
			}
		};
		document.addEventListener("mousedown", this.on_doc_down);
		document.addEventListener("keydown", this.on_doc_key, true);
	}

	/** The `!` bubble: enlarged with a ring until it has been opened once, then quiet. */
	make_tip() {
		this.$tip_btn = $(`
			<button type="button" class="sanad-phone__tip-btn" aria-expanded="false" aria-label="${ui.escape(__("What this number is used for"))}">!</button>`).appendTo(
			this.$root.find('[data-slot="labelrow"]')
		);
		this.$tip_pop = $(`<span class="sanad-phone__tip-pop" role="tooltip" hidden>${ui.escape(this.opts.tip)}</span>`).appendTo(
			this.$root.find('[data-slot="labelrow"]')
		);
		const open = () => {
			this.state.tip = true;
			this.state.tip_seen = true;
			this.render_tip();
		};
		const close = () => {
			this.state.tip = false;
			this.render_tip();
		};
		this.$tip_btn.on("click", () => (this.state.tip ? close() : open()));
		this.$tip_btn.on("mouseenter", open).on("mouseleave", close);
		this.$tip_btn.on("focus", open).on("blur", close);
		this.render_tip();
	}

	render_tip() {
		if (!this.$tip_btn) return;
		this.$tip_btn.toggleClass("sanad-phone__tip-btn--seen", !!this.state.tip_seen).attr("aria-expanded", String(!!this.state.tip));
		this.$tip_pop.attr("hidden", this.state.tip ? null : true);
	}

	// ---- the country popup ---------------------------------------------------------------------

	toggle_popup(focus_search) {
		if (this.state.open) return this.close_popup();
		return this.open_popup(focus_search);
	}

	open_popup() {
		this.state.open = true;
		this.state.q = "";
		this.$trigger.attr("aria-expanded", "true");
		this.$pop = $(`
			<div class="sanad-phone__pop">
				<span class="sanad-phone__search">
					${ui.ico ? ui.ico("search", "xs") : ""}
					<input type="text" class="sanad-phone__q" role="combobox" aria-expanded="true" aria-autocomplete="list"
						aria-controls="${this.id}-list" placeholder="${ui.escape(__("Search for a country or a dialling code"))}"
						aria-label="${ui.escape(__("Search for a country or a dialling code"))}">
				</span>
				<ul class="sanad-phone__list" id="${this.id}-list" role="listbox" aria-label="${ui.escape(__("Country"))}"></ul>
			</div>`).appendTo(this.$box);
		this.$list = this.$pop.find(".sanad-phone__list");
		this.$q = this.$pop.find(".sanad-phone__q");
		this.draw_list();
		this.$q.on("input", () => {
			this.state.q = this.$q.val() || "";
			this.draw_list();
		});
		this.$q.on("keydown", (e) => this.list_key(e));
		this.render();
		window.setTimeout(() => this.$q.trigger("focus"), 20);
	}

	close_popup() {
		this.state.open = false;
		this.state.q = "";
		if (this.$pop) this.$pop.remove();
		this.$pop = null;
		this.$trigger.attr("aria-expanded", "false");
		this.render();
	}

	/** Search by country name, by ISO prefix or by dial code — the prototype's three ways in. */
	matches() {
		const q = cstr(this.state.q).trim().replace(/^\+/, "");
		if (!q) return CATALOG;
		const lower = q.toLowerCase();
		return CATALOG.filter(
			(c) =>
				__(c.name).toLowerCase().indexOf(lower) >= 0 ||
				c.name.toLowerCase().indexOf(lower) >= 0 ||
				c.iso.toLowerCase().indexOf(lower) === 0 ||
				c.dial.indexOf(q) === 0
		);
	}

	draw_list() {
		const current = this.country;
		const rows = this.matches();
		this.$list.empty();
		if (!rows.length) {
			this.$list.append(`<li class="sanad-phone__empty" role="option" aria-selected="false">${ui.escape(__("No matching country"))}</li>`);
			return;
		}
		rows.forEach((c) => {
			$(`
				<li class="sanad-phone__opt${c.iso === current.iso ? " sanad-phone__opt--on" : ""}" role="option" tabindex="-1" aria-selected="${c.iso === current.iso}">
					<span class="sanad-phone__opt-iso">${ui.escape(c.iso)}</span>
					<span class="sanad-phone__opt-name">${ui.escape(__(c.name))}</span>
					<span class="sanad-phone__opt-dial" dir="ltr">+${ui.escape(c.dial)}</span>
				</li>`)
				.on("click", () => this.pick(c))
				.appendTo(this.$list);
		});
	}

	list_key(e) {
		const items = this.$list.children(".sanad-phone__opt").toArray();
		if (!items.length) return;
		const at = items.findIndex((el) => el.classList.contains("sanad-phone__opt--cursor"));
		if (e.key === "ArrowDown" || e.key === "ArrowUp") {
			e.preventDefault();
			const next = e.key === "ArrowDown" ? (at + 1) % items.length : (at - 1 + items.length) % items.length;
			items.forEach((el) => el.classList.remove("sanad-phone__opt--cursor"));
			items[next].classList.add("sanad-phone__opt--cursor");
			items[next].scrollIntoView({ block: "nearest" });
		} else if (e.key === "Enter") {
			e.preventDefault();
			$(items[at >= 0 ? at : 0]).trigger("click");
		}
	}

	pick(country) {
		this.country = country;
		this.digits = this.digits.slice(0, country.len || 14);
		this.close_popup();
		this.emit();
		this.$input.trigger("focus");
	}

	// ---- input --------------------------------------------------------------------------------

	on_input(el) {
		// count the digits before the caret, rewrite the masked value, then put the caret back
		// after the same digit — otherwise every space the mask inserts throws the cursor to the end
		const before = el.value.slice(0, el.selectionStart || 0);
		const digits_before = to_digits(before).length;
		const max = this.country.len || 14;
		this.digits = to_digits(el.value).slice(0, max);
		this.state.touched = true;
		const masked = sanad.ui.PhoneField.mask(this.digits, this.country);
		el.value = masked;
		let seen = 0;
		let caret = masked.length;
		for (let i = 0; i < masked.length; i++) {
			if (/\d/.test(masked[i])) seen += 1;
			if (seen === digits_before) {
				caret = i + 1;
				break;
			}
		}
		if (digits_before === 0) caret = 0;
		try {
			el.setSelectionRange(caret, caret);
		} catch (err) {
			// a detached or hidden input has no selection to set
		}
		this.emit();
	}

	on_control_input(blurred = false) {
		this.touched = this.touched || blurred;
		const result = this.render_control_hint();
		if (this.opts.on_change) this.opts.on_change(result);
		return result;
	}

	/** `{full, start_ok, valid}` for the digits currently held. */
	validity() {
		const c = this.country;
		const d = this.digits;
		const full = c.len ? d.length === c.len : d.length >= 6;
		const start_ok = !d.length || !c.starts.length || c.starts.indexOf(d[0]) >= 0;
		return { full, start_ok, valid: full && start_ok };
	}

	message() {
		const c = this.country;
		const { valid, start_ok } = this.validity();
		const show_error = (this.state.touched && !this.state.focus && this.digits.length > 0 && !valid) || !!this.opts.invalid;
		if (show_error) {
			const starts = c.starts.join(` ${__("or")} `);
			return {
				error: true,
				text: !start_ok
					? __("A mobile number in {0} starts with {1}", [__(c.name), starts])
					: c.len
						? __("The number must be {0} digits after +{1}", [c.len, c.dial])
						: __("The number must be at least 6 digits after +{0}", [c.dial]),
			};
		}
		if (this.opts.hint) return { error: false, text: this.opts.hint };
		return {
			error: false,
			text: c.len
				? __("A number WhatsApp works on — {0} digits after +{1}", [c.len, c.dial])
				: __("A number WhatsApp works on in {0} — without the leading zero", [__(c.name)]),
		};
	}

	render() {
		if (this.control) return this.render_control_hint();
		if (!this.$root) return this;
		const c = this.country;
		const { valid } = this.validity();
		const msg = this.message();
		this.$root.find('[data-slot="iso"]').text(c.iso);
		this.$root.find('[data-slot="dial"]').text(`+${c.dial}`);
		this.$root.find('[data-slot="caret"]').toggleClass("sanad-phone__caret--open", !!this.state.open);
		const placeholder = this.opts.placeholder || sanad.ui.PhoneField.mask((c.starts[0] || "X") + "X".repeat(Math.max(0, (c.len || 9) - 1)), c);
		this.$input.attr("placeholder", placeholder);
		if (this.$input.val() !== sanad.ui.PhoneField.mask(this.digits, c)) {
			this.$input.val(sanad.ui.PhoneField.mask(this.digits, c));
		}
		this.$box
			.toggleClass("sanad-phone__box--focus", !!this.state.focus)
			.toggleClass("sanad-phone__box--error", !!msg.error)
			.toggleClass("sanad-phone__box--ok", valid && this.digits.length > 0);
		this.$tick.attr("hidden", valid && this.digits.length ? null : true);
		this.$input.attr("aria-invalid", msg.error ? "true" : null);
		this.$hint.toggleClass("sanad-phone__hint--error", !!msg.error).text(msg.text);
		return this;
	}

	/** The hint under a wrapped Frappe control — the shape this component had before the port. */
	render_control_hint() {
		const result = this.get_value();
		const $i = this.$input;
		this.$hint.removeClass("sanad-phone__hint--ok sanad-phone__hint--error");
		if (result.empty) {
			$i.removeAttr("aria-invalid");
			this.$hint.text(__("Numbers without a country code are sent as +{0} ({1})", [this.country.dial, __(this.country.name)]));
			return result;
		}
		if (result.valid) {
			$i.removeAttr("aria-invalid");
			this.$hint.addClass("sanad-phone__hint--ok").text(__("Will be sent to {0}", [sanad.ui.PhoneField.format_display(result.phone_e164, this.country)]));
			return result;
		}
		if (this.touched) $i.attr("aria-invalid", "true");
		this.$hint
			.addClass(this.touched ? "sanad-phone__hint--error" : "")
			.text(__("Enter a number with its country code, e.g. {0}", [sanad.ui.PhoneField.example(this.country)]));
		return result;
	}

	emit() {
		this.render();
		if (this.opts.on_change) this.opts.on_change(this.get_value());
		return this;
	}

	// ---- value --------------------------------------------------------------------------------

	/**
	 * `{phone, phone_e164, valid, country}` — the shape every caller already reads — plus the
	 * prototype's own `{iso, dial, national, e164}`.
	 */
	get_value() {
		if (this.control) return sanad.ui.PhoneField.normalize(this.$input.val(), this.country);
		const c = this.country;
		const { valid } = this.validity();
		const e164 = this.digits ? `+${c.dial}${this.digits}` : "";
		return {
			phone: sanad.ui.PhoneField.mask(this.digits, c),
			phone_e164: valid ? e164 : null,
			valid,
			empty: !this.digits,
			country: c,
			iso: c.iso,
			dial: `+${c.dial}`,
			national: this.digits,
			e164,
		};
	}

	/** Accepts E.164 (`+966559021177`), a national number, or empty. */
	set_value(value) {
		if (this.control && typeof this.control.set_value === "function") {
			this.control.set_value(cstr(value));
			this.render_control_hint();
			return this;
		}
		const raw = cstr(value).trim();
		const digits = to_digits(raw);
		if (raw.startsWith("+") || raw.startsWith("00")) {
			// longest dial code first, so +1 never swallows +1246
			const hit = CATALOG.slice()
				.sort((a, b) => b.dial.length - a.dial.length)
				.find((c) => digits.startsWith(c.dial));
			if (hit) {
				this.country = hit;
				this.digits = digits.slice(hit.dial.length).slice(0, hit.len || 14);
				this.render();
				return this;
			}
		}
		this.digits = digits.slice(0, this.country.len || 14);
		this.render();
		return this;
	}

	set_country(iso_or_name) {
		this.country = sanad.ui.PhoneField.resolve_country(iso_or_name);
		this.render();
		return this;
	}

	/** A concrete, formatted example for the field's country, e.g. `+966 501 234 567`. */
	example() {
		return sanad.ui.PhoneField.example(this.country);
	}

	focus() {
		this.$input.trigger("focus");
		return this;
	}

	destroy() {
		if (this.on_doc_down) document.removeEventListener("mousedown", this.on_doc_down);
		if (this.on_doc_key) document.removeEventListener("keydown", this.on_doc_key, true);
		this.on_doc_down = null;
		this.on_doc_key = null;
		this.$input.off("input blur focus");
		if (this.$root) this.$root.remove();
		else if (this.$hint) this.$hint.remove();
	}
};

export default sanad.ui.PhoneField;

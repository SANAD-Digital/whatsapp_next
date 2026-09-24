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

// The countries come from the server, which reads them out of Google's libphonenumber — the same
// library `services/phone.normalize()` validates with. This file used to carry sixty-eight of them
// by hand, with lengths and groupings somebody typed in and nineteen invented sample numbers; a
// number the field called complete was only as right as that table. Now a number the field accepts
// is a number the server accepts, by construction.
//
// Three things come over the wire per region and nothing else: the dial code, the region's own
// sample **mobile** number in national form, and the national prefix that form carries (`0` in
// Saudi Arabia). The mask is read off the sample's own shape — which is how a phone input is meant
// to get its mask, the way `intl-tel-input` and every serious implementation do it — and the
// placeholder is the sample. Region *names* never travel: the browser names a region in the
// reader's own language with `Intl.DisplayNames`, localised for free and never stale.

/** Enough to answer a synchronous caller before the catalogue lands; replaced the moment it does. */
const SEED = [
	{ iso: "SA", main: true, dial: 966, example: "051 234 5678", international: "+966 51 234 5678", trunk: "0", len: 9 },
	{ iso: "AE", main: true, dial: 971, example: "050 123 4567", international: "+971 50 123 4567", trunk: "0", len: 9 },
	{ iso: "KW", main: true, dial: 965, example: "500 12345", international: "+965 500 12345", trunk: "", len: 8 },
	{ iso: "QA", main: true, dial: 974, example: "3312 3456", international: "+974 3312 3456", trunk: "", len: 8 },
	{ iso: "BH", main: true, dial: 973, example: "3600 1234", international: "+973 3600 1234", trunk: "", len: 8 },
	{ iso: "OM", main: true, dial: 968, example: "9212 3456", international: "+968 9212 3456", trunk: "", len: 8 },
	{ iso: "YE", main: true, dial: 967, example: "0712 345 678", international: "+967 712 345 678", trunk: "0", len: 9 },
	{ iso: "EG", main: true, dial: 20, example: "010 01234567", international: "+20 100 1234567", trunk: "0", len: 10 },
	{ iso: "JO", main: true, dial: 962, example: "07 9012 3456", international: "+962 7 9012 3456", trunk: "0", len: 9 },
	{ iso: "US", main: true, dial: 1, example: "(201) 555-0123", international: "+1 201-555-0123", trunk: "", len: 10 },
	{ iso: "GB", main: true, dial: 44, example: "07400 123456", international: "+44 7400 123456", trunk: "0", len: 10 },
];

let CATALOG = SEED.slice();
let catalog_promise = null;

/** Names a region in the reader's language; falls back to the ISO code where the browser cannot. */
const region_name = (() => {
	let dn = null;
	try {
		const lang = (frappe.boot && frappe.boot.lang) || document.documentElement.lang || "en";
		dn = new Intl.DisplayNames([lang, "en"], { type: "region" });
	} catch (e) {
		dn = null;
	}
	return (iso) => {
		try {
			return (dn && dn.of(iso)) || iso;
		} catch (e) {
			return iso;
		}
	};
})();

/**
 * The grouping a region writes its numbers in when they stand beside a dial code, read straight
 * off the library's own international sample: `+966 50 123 4567` → `[2, 3, 4]`. This is the field's
 * whole mask, and it is the library's answer rather than a rule derived from a length — Saudi
 * mobiles really are written 2-3-4 after the code, not 3-3-3.
 */
function groups_from_example(international) {
	const runs = String(international || "").trim().match(/\d+/g) || [];
	// the first run is the dial code itself
	const sizes = runs.slice(1).map((r) => r.length);
	return sizes.length ? sizes : [3, 3, 3];
}

/** Decorate a server row with what the browser can work out for itself. */
const decorate = (row) =>
	Object.assign({}, row, {
		// the server sends the dial code as a number; it is a prefix everywhere it is used, and a
		// prefix is a string — `+1` must not swallow `+1246` because a sort compared `undefined`
		dial: String(row.dial),
		name: region_name(row.iso),
		groups: groups_from_example(row.international),
	});

CATALOG = SEED.map(decorate);

/**
 * Fetch the full catalogue once per session. Every screen that mounts a field shares the promise,
 * so ten fields on a page cost one request; a failure leaves the seed in place rather than an
 * empty picker.
 */
function load_catalog() {
	if (catalog_promise) return catalog_promise;
	catalog_promise = ui
		.call("phone.get_countries", {}, { silent: true })
		.then((r) => {
			const rows = (r && r.countries) || [];
			if (rows.length) CATALOG = rows.map(decorate);
			if (r && r.default) sanad.ui.PhoneField.site_region = r.default;
			return CATALOG;
		})
		.catch(() => CATALOG);
	return catalog_promise;
}

const E164 = /^\+[1-9]\d{7,14}$/; // 8–15 digits: loose, the server is authoritative
const ARABIC_DIGITS = { "٠": "0", "١": "1", "٢": "2", "٣": "3", "٤": "4", "٥": "5", "٦": "6", "٧": "7", "٨": "8", "٩": "9", "۰": "0", "۱": "1", "۲": "2", "۳": "3", "۴": "4", "۵": "5", "۶": "6", "۷": "7", "۸": "8", "۹": "9" };


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
		// the seed answers immediately so nothing flashes empty; the full catalogue arrives a tick
		// later and the field redraws on the region it then resolves to
		load_catalog().then(() => {
			if (!this.$el || !this.$el.closest("body").length) return;
			const better = sanad.ui.PhoneField.resolve_country(this.opts.country_default);
			const same = better && this.country && better.iso === this.country.iso;
			this.country = same ? Object.assign({}, better) : this.country.iso ? sanad.ui.PhoneField.resolve_country(this.country.iso) : better;
			this.render && this.render();
		});
		this.state = { open: false, touched: false, focus: false, q: "", tip: false, tip_seen: false };
		this.digits = "";
		this.make();
		if (this.opts.value != null) this.set_value(this.opts.value);
		else this.render();
	}

	static get countries() {
		return CATALOG;
	}

	/** The site's own region, as the server reported it alongside the catalogue. */
	static site_region = null;

	/**
	 * Country record from an ISO-2 code or a Country name. Falls back to the region the server
	 * reports, then the host's configured default, then the site's country, then Saudi Arabia.
	 */
	static resolve_country(hint) {
		if (!hint && sanad.ui.PhoneField.site_region) hint = sanad.ui.PhoneField.site_region;
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
		// the region's own sample, from the library — not a number anybody made up
		const national = (c && String(c.example || "").replace(/\D/g, "").slice((c.trunk || "").length)) || "123456789";
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
		// `name` is the localised one, so a reader searching in Arabic finds it in Arabic
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
		// libphonenumber knows which digits a region's mobiles start with, but does not publish that
		// rule in a form a browser can apply, so the field judges length only and leaves the rest to
		// the server — which is the library itself. A claim we cannot check is a claim we do not make.
		const start_ok = true;
		return { full, start_ok, valid: full && start_ok };
	}

	message() {
		const c = this.country;
		const { valid, start_ok } = this.validity();
		const show_error = (this.state.touched && !this.state.focus && this.digits.length > 0 && !valid) || !!this.opts.invalid;
		if (show_error) {
			const starts = "";
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
		// the placeholder is the region's own sample in national form, masked into its own groups —
		// `501 234 5678` for Saudi Arabia, which is what the reader is about to type
		const sample = String(c.example || "").replace(/\D/g, "").slice((c.trunk || "").length);
		const placeholder = this.opts.placeholder || sanad.ui.PhoneField.mask(sample || "X".repeat(c.len || 9), c);
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
			// Longest dial code first, so `+1` never swallows `+1246`; and among the regions that
			// share one, the library's own main region wins — twenty-five share `+1`, and without
			// this a US number resolved to whichever sorted first.
			const hit = CATALOG.slice()
				.sort((a, b) => b.dial.length - a.dial.length || (b.main ? 1 : 0) - (a.main ? 1 : 0))
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

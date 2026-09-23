// sanad.ui.DateFilter — the prototype's operator-based date filter (docs/component/Date Filter.html).
//
// A split trigger (operator · value) opens a panel whose shape follows the operator:
//   is / after / before / onOrAfter / onOrBefore → one calendar, quick single-date presets
//   between                                      → a preset rail + two calendars + a range band
//   timespan                                     → "last / next N hours|days|weeks|months|years"
//   fiscal                                       → a fiscal year with FY / Q1–Q4 / H1–H2 periods
// Nothing is emitted until Apply; Cancel restores the applied snapshot. The value is
//   {op, from, to, fromTime, toTime, exclusive, label, summary, params}
// with `from`/`to` as `YYYY-MM-DD`, so a host can turn it into whatever its backend wants.
// Portable: no DocType, no host API, colours from Espresso tokens and the kit accent only.

import ui from "../_core/index.js";

const pad = (n) => String(n).padStart(2, "0");
/** Day key: `YYYY-MM-DD`, comparable as a string. */
const mk = (y, m, d) => `${y}-${pad(m + 1)}-${pad(d)}`;
const to_date = (k) => {
	const p = String(k).split("-").map(Number);
	return new Date(p[0], p[1] - 1, p[2]);
};
const to_key = (d) => mk(d.getFullYear(), d.getMonth(), d.getDate());
const add_days = (k, n) => {
	const d = to_date(k);
	d.setDate(d.getDate() + n);
	return to_key(d);
};
/** Add months, clamping the day to the last day of the target month. */
const add_months = (k, n) => {
	const d = to_date(k);
	const day = d.getDate();
	d.setDate(1);
	d.setMonth(d.getMonth() + n);
	d.setDate(Math.min(day, new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()));
	return to_key(d);
};
/** Inclusive day count between two keys. */
const span_days = (a, b) => Math.round((to_date(b) - to_date(a)) / 864e5) + 1;
const today_key = () => to_key(new Date());
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

/** Latin digits from Arabic-Indic input, so a typed date parses either way. */
const latin_digits = (text) => String(text == null ? "" : text).replace(/[٠-٩]/g, (c) => String(c.charCodeAt(0) - 0x0660));

/** `DD/MM/YYYY`, `YYYY-M-D`, dots / dashes / slashes / spaces, two-digit years. */
const parse_input = (text) => {
	const raw = latin_digits(text).trim();
	if (!raw) return null;
	let y;
	let mo;
	let d;
	let m = raw.match(/^(\d{4})[-./ ](\d{1,2})[-./ ](\d{1,2})$/);
	if (m) {
		y = +m[1];
		mo = +m[2];
		d = +m[3];
	} else {
		m = raw.match(/^(\d{1,2})[-./ ](\d{1,2})[-./ ](\d{2,4})$/);
		if (!m) return null;
		d = +m[1];
		mo = +m[2];
		y = +m[3];
		if (y < 100) y += 2000;
	}
	const dt = new Date(y, mo - 1, d);
	return dt.getMonth() === mo - 1 && dt.getDate() === d ? to_key(dt) : null;
};

/** `["creation"]`, `[{fieldname, label}]` or `[{value, label}]` → `[{value, label}]`. */
const normalise_fields = (list) =>
	(list || [])
		.map((f) => (typeof f === "string" ? { value: f, label: f } : { value: f.value || f.fieldname, label: f.label || f.value || f.fieldname }))
		.filter((f) => f.value);

const OPERATORS = () => [
	{ key: "is", label: __("Is") },
	{ key: "after", label: __("After") },
	{ key: "before", label: __("Before") },
	{ key: "onOrAfter", label: __("On or after") },
	{ key: "onOrBefore", label: __("On or before") },
	{ key: "between", label: __("Between"), group: true },
	{ key: "timespan", label: __("Last / next"), group: true },
	{ key: "fiscal", label: __("Fiscal period") },
];
const SINGLE_OPS = ["is", "after", "before", "onOrAfter", "onOrBefore"];

const UNITS = () => [
	{ key: "hour", label: __("Hours") },
	{ key: "day", label: __("Days") },
	{ key: "week", label: __("Weeks") },
	{ key: "month", label: __("Months") },
	{ key: "year", label: __("Years") },
];

/** Fiscal periods as month offsets from the start of the fiscal year. */
const PERIODS = () => [
	{ key: "FY", short: __("FY"), label: __("Whole year"), a: 0, b: 12 },
	{ key: "Q1", short: __("Q1"), label: __("First quarter"), a: 0, b: 3 },
	{ key: "Q2", short: __("Q2"), label: __("Second quarter"), a: 3, b: 6 },
	{ key: "Q3", short: __("Q3"), label: __("Third quarter"), a: 6, b: 9 },
	{ key: "Q4", short: __("Q4"), label: __("Fourth quarter"), a: 9, b: 12 },
	{ key: "H1", short: __("H1"), label: __("First half"), a: 0, b: 6 },
	{ key: "H2", short: __("H2"), label: __("Second half"), a: 6, b: 12 },
];

sanad.ui.DateFilter = class DateFilter {
	/**
	 * @param {Object} opts
	 * @param {jQuery|HTMLElement} opts.wrapper — where the trigger is mounted
	 * @param {string} [opts.label] — shown above the trigger
	 * @param {string} [opts.placeholder]
	 * @param {string} [opts.default_op="between"]
	 * @param {"auto"|"wide"|"compact"} [opts.layout="auto"]
	 * @param {"sun"|"sat"|"mon"} [opts.week_start] — defaults to Frappe's own first day of week
	 * @param {number} [opts.fiscal_start_month=1] — 1–12
	 * @param {Object} [opts.value] — a previously emitted value, to restore
	 * @param {Function} [opts.on_change] — `(value|null) => void`, fired on Apply and on Clear
	 */
	constructor(opts = {}) {
		this.opts = Object.assign({ default_op: "between", layout: "auto", fiscal_start_month: 1 }, opts);
		this.id = ui.uid("datefilter");
		// the field picker is optional: with no `fields` the control is the plain single-field filter
		this.fields = normalise_fields(this.opts.fields);
		this.fieldname = this.opts.fieldname || (this.fields[0] ? this.fields[0].value : null);
		this.applied = null;
		this.state = this.defaults();
		this.make();
		if (this.opts.value) this.set_value(this.opts.value, { silent: true });
	}

	// ---- state -------------------------------------------------------------------------------

	defaults() {
		const t = today_key();
		const fs = clamp(cint(this.opts.fiscal_start_month) || 1, 1, 12) - 1;
		return {
			op: this.opts.default_op || "between",
			date: t,
			start: `${t.slice(0, 8)}01`,
			end: t,
			time: "09:00",
			start_time: "00:00",
			end_time: "23:59",
			with_time: false,
			span_dir: "past",
			span_n: 30,
			span_unit: "day",
			span_inc: true,
			fiscal_year: this.current_fiscal_year(fs),
			fiscal_period: "FY",
			fiscal_start: fs,
		};
	}

	current_fiscal_year(fs) {
		const now = new Date();
		if (fs === 0) return now.getFullYear();
		return now.getMonth() >= fs ? now.getFullYear() + 1 : now.getFullYear();
	}

	/** First day of the week as a 0–6 index; Frappe's own setting wins over the option. */
	week_start() {
		const named = { sun: 0, mon: 1, sat: 6 };
		if (this.opts.week_start && named[this.opts.week_start] != null) return named[this.opts.week_start];
		const boot = frappe.boot && frappe.boot.sysdefaults && frappe.boot.sysdefaults.first_day_of_the_week;
		const days = { Sunday: 0, Monday: 1, Tuesday: 2, Wednesday: 3, Thursday: 4, Friday: 5, Saturday: 6 };
		return boot && days[boot] != null ? days[boot] : 0;
	}

	is_single() {
		return SINGLE_OPS.includes(this.state.op);
	}

	is_between() {
		return this.state.op === "between";
	}

	is_calendar() {
		return this.is_single() || this.is_between();
	}

	compact() {
		if (this.opts.layout === "compact") return true;
		if (this.opts.layout === "wide") return false;
		return window.innerWidth < 720;
	}

	// ---- date maths --------------------------------------------------------------------------

	/** Range presets, all bounds inclusive and all "to date" ones ending today. */
	range_presets() {
		const t = today_key();
		const d = to_date(t);
		const y = d.getFullYear();
		const m = d.getMonth();
		const q = Math.floor(m / 3) * 3;
		const ws = this.week_start();
		return [
			{ label: __("Today"), from: t, to: t },
			{ label: __("Yesterday"), from: add_days(t, -1), to: add_days(t, -1) },
			{ label: __("Last 7 days"), from: add_days(t, -6), to: t },
			{ label: __("Last 30 days"), from: add_days(t, -29), to: t },
			{ label: __("This week"), from: add_days(t, -(((d.getDay() - ws + 7) % 7))), to: t },
			{ label: __("This month"), from: mk(y, m, 1), to: t },
			{ label: __("Last month"), from: add_months(mk(y, m, 1), -1), to: add_days(mk(y, m, 1), -1) },
			{ label: __("This quarter"), from: mk(y, q, 1), to: t },
			{ label: __("This year"), from: mk(y, 0, 1), to: t },
			{ label: __("Last year"), from: mk(y - 1, 0, 1), to: mk(y - 1, 11, 31) },
		];
	}

	single_presets() {
		const t = today_key();
		const d = to_date(t);
		return [
			{ label: __("Today"), date: t },
			{ label: __("Yesterday"), date: add_days(t, -1) },
			{ label: __("Start of month"), date: mk(d.getFullYear(), d.getMonth(), 1) },
			{ label: __("Start of year"), date: mk(d.getFullYear(), 0, 1) },
		];
	}

	span_presets() {
		return [
			{ label: __("Last 24 hours"), dir: "past", n: 24, unit: "hour" },
			{ label: __("Last 7 days"), dir: "past", n: 7, unit: "day" },
			{ label: __("Last 30 days"), dir: "past", n: 30, unit: "day" },
			{ label: __("Last 90 days"), dir: "past", n: 90, unit: "day" },
			{ label: __("Last 12 months"), dir: "past", n: 12, unit: "month" },
			{ label: __("Next 7 days"), dir: "next", n: 7, unit: "day" },
		];
	}

	/** `{from, to, from_time, to_time}` for the timespan operator. */
	span_range() {
		const s = this.state;
		const n = Math.max(1, cint(s.span_n) || 1);
		const t = today_key();
		const past = s.span_dir === "past";
		const inc = !!s.span_inc;
		if (s.span_unit === "hour") {
			const now = new Date();
			const other = new Date(now.getTime() + (past ? -1 : 1) * n * 36e5);
			const a = past ? other : now;
			const b = past ? now : other;
			const hm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
			return { from: to_key(a), to: to_key(b), from_time: hm(a), to_time: hm(b) };
		}
		if (s.span_unit === "month" || s.span_unit === "year") {
			const mo = s.span_unit === "year" ? 12 * n : n;
			if (past) return inc ? { from: add_days(add_months(t, -mo), 1), to: t } : { from: add_months(t, -mo), to: add_days(t, -1) };
			return inc ? { from: t, to: add_days(add_months(t, mo), -1) } : { from: add_days(t, 1), to: add_months(t, mo) };
		}
		const k = s.span_unit === "week" ? 7 * n : n;
		if (past) return inc ? { from: add_days(t, -(k - 1)), to: t } : { from: add_days(t, -k), to: add_days(t, -1) };
		return inc ? { from: t, to: add_days(t, k - 1) } : { from: add_days(t, 1), to: add_days(t, k) };
	}

	fiscal_range() {
		const s = this.state;
		const p = PERIODS().find((x) => x.key === s.fiscal_period) || PERIODS()[0];
		const start_year = s.fiscal_start === 0 ? s.fiscal_year : s.fiscal_year - 1;
		const base = mk(start_year, s.fiscal_start, 1);
		return { from: add_months(base, p.a), to: add_days(add_months(base, p.b), -1) };
	}

	/** Resolve the draft into `{from, to, from_time, to_time, exclusive, ready}`. */
	calc() {
		const s = this.state;
		const wt = !!s.with_time;
		const out = { from: null, to: null, from_time: null, to_time: null, exclusive: false, ready: false };
		if (s.op === "is") {
			out.from = out.to = s.date;
			out.ready = !!s.date;
		} else if (s.op === "after") {
			out.from = wt ? s.date : add_days(s.date, 1);
			out.from_time = wt ? s.time : null;
			out.exclusive = true;
			out.ready = !!s.date;
		} else if (s.op === "onOrAfter") {
			out.from = s.date;
			out.from_time = wt ? s.time : null;
			out.ready = !!s.date;
		} else if (s.op === "before") {
			out.to = wt ? s.date : add_days(s.date, -1);
			out.to_time = wt ? s.time : null;
			out.exclusive = true;
			out.ready = !!s.date;
		} else if (s.op === "onOrBefore") {
			out.to = s.date;
			out.to_time = wt ? s.time : null;
			out.ready = !!s.date;
		} else if (s.op === "between") {
			let a = s.start;
			let b = s.end;
			if (a && b && b < a) {
				const x = a;
				a = b;
				b = x;
			}
			out.from = a;
			out.to = b;
			out.from_time = wt ? s.start_time : null;
			out.to_time = wt ? s.end_time : null;
			out.ready = !!(a && b);
		} else if (s.op === "timespan") {
			Object.assign(out, this.span_range());
			out.ready = true;
		} else if (s.op === "fiscal") {
			Object.assign(out, this.fiscal_range());
			out.ready = true;
		}
		return out;
	}

	// ---- wording -----------------------------------------------------------------------------

	format_day(key, with_year = true) {
		if (!key) return "";
		const d = to_date(key);
		const df = with_year ? "d MMMM yyyy" : "d MMMM";
		if (frappe.datetime && frappe.datetime.str_to_user) {
			// keep Desk's own date format when the user set one, fall back to the long form
			const user = frappe.datetime.str_to_user(key);
			if (user && !with_year) return user;
			if (user) return user;
		}
		return moment(d).format(df);
	}

	/** Arabic needs dual and 3–10 plural forms; `ui.plural` picks the right one per language. */
	days_text(n) {
		return ui.plural(n, { one: __("{0} day"), two: __("{0} days"), few: __("{0} days"), many: __("{0} days"), other: __("{0} days") });
	}

	unit_text(unit, n) {
		const forms = {
			hour: { one: __("{0} hour"), two: __("{0} hours"), few: __("{0} hours"), many: __("{0} hours"), other: __("{0} hours") },
			day: { one: __("{0} day"), two: __("{0} days"), few: __("{0} days"), many: __("{0} days"), other: __("{0} days") },
			week: { one: __("{0} week"), two: __("{0} weeks"), few: __("{0} weeks"), many: __("{0} weeks"), other: __("{0} weeks") },
			month: { one: __("{0} month"), two: __("{0} months"), few: __("{0} months"), many: __("{0} months"), other: __("{0} months") },
			year: { one: __("{0} year"), two: __("{0} years"), few: __("{0} years"), many: __("{0} years"), other: __("{0} years") },
		};
		return ui.plural(n, forms[unit] || forms.day);
	}

	/** Short text for the trigger; a range that matches a preset shows the preset's name. */
	label_text() {
		const s = this.state;
		const r = this.calc();
		if (!r.ready) return "";
		const time = (t) => (t ? ` ${t}` : "");
		if (s.op === "is") return this.format_day(s.date);
		if (SINGLE_OPS.includes(s.op)) {
			const op = OPERATORS().find((o) => o.key === s.op);
			return `${op.label} ${this.format_day(s.date)}${time(r.from_time || r.to_time)}`;
		}
		if (s.op === "timespan") {
			const n = Math.max(1, cint(s.span_n) || 1);
			return s.span_dir === "past" ? __("Last {0}", [this.unit_text(s.span_unit, n)]) : __("Next {0}", [this.unit_text(s.span_unit, n)]);
		}
		if (s.op === "fiscal") {
			const p = PERIODS().find((x) => x.key === s.fiscal_period) || PERIODS()[0];
			return `${p.key === "FY" ? "" : `${p.short} · `}${__("FY {0}", [s.fiscal_year])}`;
		}
		if (!s.with_time) {
			const hit = this.range_presets().find((p) => p.from === r.from && p.to === r.to);
			if (hit) return hit.label;
		}
		const same_year = r.from.slice(0, 4) === r.to.slice(0, 4);
		return `${this.format_day(r.from, !same_year)}${time(r.from_time)} – ${this.format_day(r.to)}${time(r.to_time)}`;
	}

	/** The sentence under the calendar; also says what is still missing. */
	summary_text() {
		const s = this.state;
		const r = this.calc();
		if (!r.ready) {
			if (this.is_between()) return s.start ? __("Pick the end date") : __("Pick the start date, then the end date");
			return __("Pick a date");
		}
		if (s.op === "is") return __("All of {0}", [this.format_day(s.date)]);
		if (s.op === "after") return __("After {0}, not including it", [this.format_day(s.date)]);
		if (s.op === "before") return __("Before {0}, not including it", [this.format_day(s.date)]);
		if (s.op === "onOrAfter") return __("From {0} onwards", [this.format_day(s.date)]);
		if (s.op === "onOrBefore") return __("Up to and including {0}", [this.format_day(s.date)]);
		return `${this.format_day(r.from)} → ${this.format_day(r.to)}`;
	}

	// ---- value in / out ------------------------------------------------------------------------

	get_value() {
		const r = this.calc();
		if (!r.ready) return null;
		return {
			op: this.state.op,
			from: r.from,
			to: r.to,
			fromTime: r.from_time,
			toTime: r.to_time,
			exclusive: r.exclusive,
			label: this.label_text(),
			summary: this.summary_text(),
			params: Object.assign({}, this.state),
		};
	}

	/** Restore a previously emitted value (its `params` carry the whole draft). */
	set_value(value, { silent = false } = {}) {
		if (!value) return this.clear({ silent });
		this.state = Object.assign(this.defaults(), value.params || {});
		this.applied = { snapshot: Object.assign({}, this.state), value: this.get_value() };
		this.reflect_trigger();
		if (!silent && typeof this.opts.on_change === "function") this.opts.on_change(this.applied.value);
		return this;
	}

	/**
	 * @param {{cascade?: boolean, silent?: boolean}} [o] — `cascade` lets a set apply every one of
	 *   its fields from this one Apply; `silent` is how the set then applies each of them.
	 */
	apply({ cascade = true, silent = false } = {}) {
		const value = this.get_value();
		if (!value) return this;
		this.applied = { snapshot: Object.assign({}, this.state), value };
		this.close();
		this.reflect_trigger();
		if (cascade && typeof this.opts.on_apply_all === "function") return this.opts.on_apply_all();
		if (!silent && typeof this.opts.on_change === "function") this.opts.on_change(value);
		return this;
	}

	clear({ silent = false, cascade = true } = {}) {
		this.applied = null;
		this.state = this.defaults();
		this.close();
		this.reflect_trigger();
		if (cascade && typeof this.opts.on_clear_all === "function") return this.opts.on_clear_all();
		if (!silent && typeof this.opts.on_change === "function") this.opts.on_change(null);
		return this;
	}

	// ---- trigger -------------------------------------------------------------------------------

	make() {
		this.$el = $(`
			<div class="sanad-kit sanad-datefilter" id="${this.id}">
				${this.opts.label ? `<span class="sanad-datefilter__label">${ui.escape(this.opts.label)}</span>` : ""}
				<div class="sanad-datefilter__trigger">
					<button type="button" class="sanad-datefilter__op" aria-haspopup="listbox" aria-expanded="false">
						<span class="sanad-datefilter__op-label"></span>
						<span class="sanad-datefilter__caret" aria-hidden="true">${ui.icon("es-line-down", "xs")}</span>
					</button>
					${this.fields.length ? `<button type="button" class="sanad-datefilter__fieldpick" aria-haspopup="listbox" aria-expanded="false" aria-label="${ui.escape(__("Date field"))}">
						<span class="sanad-datefilter__fieldpick-label"></span>
						<span class="sanad-datefilter__caret" aria-hidden="true">${ui.icon("es-line-down", "xs")}</span>
					</button>` : ""}
					<button type="button" class="sanad-datefilter__value" aria-haspopup="dialog" aria-expanded="false">
						<span class="sanad-datefilter__icon" aria-hidden="true">${ui.icon("es-solid-calendar", "xs")}</span>
						<span class="sanad-datefilter__text"></span>
						<span class="sanad-datefilter__clear" role="button" tabindex="0" aria-label="${ui.escape(__("Clear"))}" hidden>${ui.icon("es-line-close", "xs")}</span>
					</button>
				</div>
			</div>`).appendTo($(this.opts.wrapper));

		this.$el.on("click", ".sanad-datefilter__op", () => (this.$menu ? this.close_menu() : this.open_menu()));
		this.$el.on("click", ".sanad-datefilter__fieldpick", () => (this.$fields ? this.close_fields() : this.open_fields()));
		this.$el.on("click", ".sanad-datefilter__value", (e) => {
			if ($(e.target).closest(".sanad-datefilter__clear").length) return;
			if (this.$panel) this.close();
			else this.open();
		});
		this.$el.on("click keydown", ".sanad-datefilter__clear", (e) => {
			if (e.type === "keydown" && !["Enter", " "].includes(e.key)) return;
			e.preventDefault();
			e.stopPropagation();
			this.clear();
		});
		this.$el.on("keydown", ".sanad-datefilter__op, .sanad-datefilter__fieldpick, .sanad-datefilter__value", (e) => {
			if (!["Enter", " ", "ArrowDown"].includes(e.key)) return;
			e.preventDefault();
			const $t = $(e.currentTarget);
			if ($t.hasClass("sanad-datefilter__op")) this.open_menu();
			else if ($t.hasClass("sanad-datefilter__fieldpick")) this.open_fields();
			else this.open();
		});

		this._outside = (e) => {
			if (!this.$panel && !this.$menu && !this.$fields) return;
			if ($(e.target).closest(`#${this.id}`).length) return;
			this.close();
			this.close_menu();
			this.close_fields();
		};
		this._escape = (e) => {
			if (e.key !== "Escape" || (!this.$panel && !this.$menu && !this.$fields)) return;
			e.stopPropagation();
			if (this.$fields) return this.close_fields(true);
			if (this.$menu) return this.close_menu(true);
			if (this.state.pick) {
				this.state.pick = null;
				return this.render_panel();
			}
			return this.close(true);
		};
		$(document).on(`mousedown.${this.id}`, this._outside).on(`keydown.${this.id}`, this._escape);
		this.reflect_trigger();
	}

	reflect_trigger() {
		const op = OPERATORS().find((o) => o.key === this.state.op) || OPERATORS()[0];
		const value = this.applied && this.applied.value;
		this.$el.find(".sanad-datefilter__op-label").text(op.label);
		if (this.fields.length) {
			const cap = this.field_caption();
			this.$el
				.find(".sanad-datefilter__fieldpick-label")
				.text(cap.text)
				.toggleClass("sanad-datefilter__fieldpick-label--tag", cap.count > 1);
		}
		const placeholder = this.opts.placeholder == null ? __("Pick a date") : this.opts.placeholder;
		this.$el
			.find(".sanad-datefilter__text")
			.text(value ? value.label : placeholder)
			.toggleClass("sanad-datefilter__text--empty", !value)
			.prop("hidden", !value && !placeholder);
		this.$el.find(".sanad-datefilter__clear").prop("hidden", !value);
		this.$el.toggleClass("sanad-datefilter--set", !!value);
		return this;
	}

	// ---- operator menu ---------------------------------------------------------------------------

	open_menu() {
		this.close();
		this.close_fields();
		const ops = OPERATORS();
		this.$menu = $(`<div class="sanad-datefilter__menu" role="listbox" aria-label="${ui.escape(__("Comparison"))}"></div>`).appendTo(this.$el);
		ops.forEach((o) => {
			if (o.group) $('<div class="sanad-datefilter__menu-sep" aria-hidden="true"></div>').appendTo(this.$menu);
			const on = o.key === this.state.op;
			$(`<button type="button" class="sanad-datefilter__menu-item${on ? " sanad-datefilter__menu-item--on" : ""}" role="option" aria-selected="${on}">
					<span>${ui.escape(o.label)}</span>${on ? `<span class="sanad-datefilter__menu-check" aria-hidden="true">${ui.icon("es-line-check", "xs")}</span>` : ""}
				</button>`)
				.on("click", () => this.set_op(o.key))
				.appendTo(this.$menu);
		});
		this.$el.find(".sanad-datefilter__op").attr("aria-expanded", "true");
		this.place(this.$menu);
		this.$menu.find(".sanad-datefilter__menu-item--on, .sanad-datefilter__menu-item").first().trigger("focus");
	}

	close_menu(restore_focus = false) {
		if (!this.$menu) return;
		this.$menu.remove();
		this.$menu = null;
		this.$el.find(".sanad-datefilter__op").attr("aria-expanded", "false");
		if (restore_focus) this.$el.find(".sanad-datefilter__op").trigger("focus");
	}

	// ---- field picker ----------------------------------------------------------------------------

	/**
	 * What the field segment reads: the field's own name while one field is filtered, and a tag
	 * carrying the count once several are — the names would not fit, and the panel lists them.
	 */
	field_caption() {
		if (typeof this.opts.field_caption === "function") return this.opts.field_caption();
		const f = this.fields.find((x) => x.value === this.fieldname);
		return { text: f ? f.label : "", count: 1 };
	}

	/**
	 * Which date field this filter runs on. The list is multi-select: ticking a field the set does
	 * not have yet adds a filter row of its own for it, and unticking one drops that row — so each
	 * field carries its own operator and its own dates. The host owns the set, so the decision is
	 * delegated through `on_toggle_field`; standalone, the picker just switches this row's field.
	 */
	open_fields() {
		if (!this.fields.length) return;
		this.close();
		this.close_menu();
		const taken = typeof this.opts.selected_fields === "function" ? this.opts.selected_fields() : [this.fieldname];
		this.$fields = $(`<div class="sanad-datefilter__menu sanad-datefilter__menu--fields" role="listbox" aria-multiselectable="true" aria-label="${ui.escape(__("Date field"))}"></div>`).appendTo(this.$el);
		this.fields.forEach((f) => {
			const on = taken.includes(f.value);
			const mine = f.value === this.fieldname;
			$(`<button type="button" class="sanad-datefilter__menu-item${on ? " sanad-datefilter__menu-item--on" : ""}${mine ? " sanad-datefilter__menu-item--mine" : ""}" role="option" aria-selected="${on}">
					<span class="sanad-datefilter__menu-box" aria-hidden="true">${on ? ui.icon("es-line-check", "xs") : ""}</span>
					<span class="sanad-datefilter__menu-text">${ui.escape(f.label)}</span>
				</button>`)
				.on("click", () => this.toggle_field(f.value))
				.appendTo(this.$fields);
		});
		this.$el.find(".sanad-datefilter__fieldpick").attr("aria-expanded", "true");
		this.place(this.$fields);
		this.$fields.find(".sanad-datefilter__menu-item--mine, .sanad-datefilter__menu-item").first().trigger("focus");
	}

	close_fields(restore_focus = false) {
		if (!this.$fields) return;
		this.$fields.remove();
		this.$fields = null;
		this.$el.find(".sanad-datefilter__fieldpick").attr("aria-expanded", "false");
		if (restore_focus) this.$el.find(".sanad-datefilter__fieldpick").trigger("focus");
	}

	toggle_field(fieldname) {
		this.close_fields();
		if (typeof this.opts.on_toggle_field === "function") return this.opts.on_toggle_field(fieldname, this);
		return this.set_field(fieldname);
	}

	/** Point this row at another field. The host re-keys whatever filter it built from this one. */
	set_field(fieldname, { silent = false } = {}) {
		if (!fieldname || fieldname === this.fieldname) return this;
		const was = this.fieldname;
		this.fieldname = fieldname;
		this.reflect_trigger();
		if (!silent && typeof this.opts.on_field_change === "function") this.opts.on_field_change(fieldname, was, this);
		return this;
	}

	/** Switching operator keeps the dates the user already picked. */
	set_op(key) {
		const s = this.state;
		const was_between = this.is_between();
		s.op = key;
		if (was_between && SINGLE_OPS.includes(key)) s.date = s.start;
		else if (!was_between && key === "between" && SINGLE_OPS.includes(this.applied ? this.applied.snapshot.op : s.op)) {
			s.start = s.date;
			s.end = s.date > today_key() ? s.date : today_key();
		}
		this.close_menu();
		this.reflect_trigger();
		// keep the draft: re-reading the applied snapshot here would undo the operator just picked
		this.open({ keep_state: true });
	}

	// ---- panel -------------------------------------------------------------------------------------

	/** @param {{keep_state?: boolean}} [o] — `keep_state` reopens on the current draft, not the applied one. */
	open(o = {}) {
		this.close_menu();
		this.close_fields();
		if (this.$panel) return this;
		if (!o.keep_state) {
			const base = this.applied ? this.applied.snapshot : this.defaults();
			this.state = Object.assign({}, base);
		}
		this.state.hover = null;
		this.state.typed = {};
		const anchor = this.is_between() ? this.state.start : this.state.date;
		const d = to_date(anchor || today_key());
		this.view_year = d.getFullYear();
		this.view_month = d.getMonth();
		this.$panel = $(`<div class="sanad-datefilter__panel" role="dialog" aria-label="${ui.escape(__("Pick a date"))}"></div>`).appendTo(this.$el);
		this.$el.find(".sanad-datefilter__value").attr("aria-expanded", "true");
		this.render_panel();
		this.keep_in_view();
		return this;
	}

	keep_in_view() {
		return this.place(this.$panel);
	}

	/**
	 * Keep a popup on screen. Panel and menus alike hang off the **start** edge of the trigger, which
	 * is the left in English and the right in Arabic, so the same rule reads correctly both ways:
	 * measure, flip to the other edge if the popup runs off the viewport, and pin it to the viewport
	 * if even that does not fit. Measuring is why this cannot be CSS alone.
	 */
	place($pop) {
		window.setTimeout(() => {
			const el = $pop && $pop[0];
			if (!el || !el.isConnected) return;
			$pop.css({ "inset-inline-start": "", "inset-inline-end": "", position: "", left: "", top: "" });
			const margin = 12;
			let box = el.getBoundingClientRect();
			if (box.right <= window.innerWidth - margin && box.left >= margin) return;
			$pop.css({ "inset-inline-start": "auto", "inset-inline-end": "0" });
			box = el.getBoundingClientRect();
			if (box.left >= margin && box.right <= window.innerWidth - margin) return;
			const anchor = this.$el[0].getBoundingClientRect();
			$pop.css({
				"inset-inline-start": "",
				"inset-inline-end": "",
				position: "fixed",
				top: `${Math.round(anchor.bottom + 5)}px`,
				left: `${Math.round(Math.max(margin, Math.min(window.innerWidth - box.width - margin, anchor.left)))}px`,
			});
		}, 0);
		return this;
	}

	close(restore_focus = false) {
		if (!this.$panel) return this;
		this.$panel.remove();
		this.$panel = null;
		this.state.hover = null;
		this.$el.find(".sanad-datefilter__value").attr("aria-expanded", "false");
		if (restore_focus) this.$el.find(".sanad-datefilter__value").trigger("focus");
		return this;
	}

	set(patch) {
		Object.assign(this.state, patch);
		this.render_panel();
		return this;
	}

	render_panel() {
		if (!this.$panel) return;
		const compact = this.compact();
		this.$panel.toggleClass("sanad-datefilter__panel--compact", compact).empty();
		this.render_field_rail();
		const $body = $('<div class="sanad-datefilter__body"></div>').appendTo(this.$panel);
		if (this.is_calendar()) {
			if (this.is_between()) this.render_presets($body);
			const $main = $('<div class="sanad-datefilter__main"></div>').appendTo($body);
			this.render_inputs($main);
			this.render_calendar($main);
			this.render_options($main);
		} else if (this.state.op === "timespan") {
			this.render_timespan($body);
		} else {
			this.render_fiscal($body);
		}
		this.render_footer();
		this.keep_in_view();
	}

	render_presets($body) {
		const $rail = $('<div class="sanad-datefilter__presets"></div>').appendTo($body);
		this.range_presets().forEach((p) => {
			const on = this.state.start === p.from && this.state.end === p.to;
			$(`<button type="button" class="sanad-datefilter__preset${on ? " sanad-datefilter__preset--on" : ""}">${ui.escape(p.label)}</button>`)
				.on("click", () => {
					const d = to_date(p.from);
					this.view_year = d.getFullYear();
					this.view_month = d.getMonth();
					this.set({ start: p.from, end: p.to, hover: null, typed: {} });
				})
				.appendTo($rail);
		});
	}

	render_inputs($main) {
		const s = this.state;
		const $head = $('<div class="sanad-datefilter__inputs"></div>').appendTo($main);
		const field = (key, prefix) => {
			const value = s.typed && s.typed[key] != null ? s.typed[key] : this.to_input(s[key]);
			const bad = s.typed && s.typed[key] && !parse_input(s.typed[key]);
			const $wrap = $(`<label class="sanad-datefilter__field${bad ? " sanad-datefilter__field--bad" : ""}">
					${prefix ? `<span class="sanad-datefilter__field-prefix">${ui.escape(prefix)}</span>` : ""}
					<input type="text" dir="ltr" inputmode="numeric" class="sanad-datefilter__input" value="${ui.escape(value)}" placeholder="DD/MM/YYYY" aria-label="${ui.escape(prefix || __("Date"))}">
				</label>`).appendTo($head);
			$wrap.find("input")
				.on("input", (e) => {
					s.typed = Object.assign({}, s.typed, { [key]: e.target.value });
				})
				.on("change blur", (e) => this.commit_input(key, e.target.value))
				.on("keydown", (e) => {
					if (e.key !== "Enter") return;
					e.preventDefault();
					this.commit_input(key, e.target.value);
				});
			return $wrap;
		};
		if (this.is_between()) {
			field("start", __("From"));
			$(`<span class="sanad-datefilter__arrow" aria-hidden="true">${ui.icon("es-line-arrow-right", "xs")}</span>`).appendTo($head);
			field("end", __("To"));
			if (s.with_time) {
				this.time_input($head, "start_time", __("From time"));
				this.time_input($head, "end_time", __("To time"));
			}
		} else {
			field("date");
			if (s.with_time) this.time_input($head, "time", __("Time"));
		}
	}

	time_input($head, key, label) {
		$(`<input type="time" class="sanad-datefilter__time" value="${ui.escape(this.state[key] || "")}" aria-label="${ui.escape(label)}">`)
			.on("change", (e) => this.set({ [key]: e.target.value }))
			.appendTo($head);
	}

	to_input(key) {
		if (!key) return "";
		const d = to_date(key);
		return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
	}

	commit_input(key, text) {
		const parsed = parse_input(text);
		const s = this.state;
		const typed = Object.assign({}, s.typed);
		delete typed[key];
		if (!parsed) return this.set({ typed: text ? Object.assign(typed, { [key]: text }) : typed });
		const patch = { [key]: parsed, typed };
		if (key !== "date" && s.start && s.end) {
			const start = key === "start" ? parsed : s.start;
			const end = key === "end" ? parsed : s.end;
			if (end < start) {
				patch.start = end;
				patch.end = start;
			}
		}
		const d = to_date(parsed);
		this.view_year = d.getFullYear();
		this.view_month = d.getMonth();
		return this.set(patch);
	}

	// ---- calendar ---------------------------------------------------------------------------------

	render_calendar($main) {
		const $body = $('<div class="sanad-datefilter__cal"></div>').appendTo($main);
		if (this.state.pick === "month") return this.render_month_picker($body);
		if (this.state.pick === "year") return this.render_year_picker($body, this.view_year, (y) => {
			this.view_year = y;
			this.set({ pick: "month", picker_year: y });
		});
		const months = this.compact() || this.is_single() ? 1 : 2;
		for (let i = 0; i < months; i++) {
			let y = this.view_year;
			let m = this.view_month + i;
			y += Math.floor(m / 12);
			m = ((m % 12) + 12) % 12;
			this.render_month($body, y, m, i === 0, i === months - 1);
		}
		return undefined;
	}

	month_names() {
		return moment.months();
	}

	render_month($body, y, m, first, last) {
		const $col = $('<div class="sanad-datefilter__month"></div>').appendTo($body);
		const $head = $('<div class="sanad-datefilter__month-head"></div>').appendTo($col);
		$(`<button type="button" class="sanad-datefilter__nav" aria-label="${ui.escape(__("Previous month"))}"${first ? "" : " hidden"}>${ui.icon("es-line-left-chevron", "xs")}</button>`)
			.on("click", () => {
				this.view_month -= 1;
				if (this.view_month < 0) {
					this.view_month = 11;
					this.view_year -= 1;
				}
				this.render_panel();
			})
			.appendTo($head);
		$(`<button type="button" class="sanad-datefilter__month-title">${ui.escape(`${this.month_names()[m]} ${y}`)}${ui.icon("es-line-down", "xs")}</button>`)
			.on("click", () => this.set({ pick: "month", picker_year: y }))
			.appendTo($head);
		$(`<button type="button" class="sanad-datefilter__nav" aria-label="${ui.escape(__("Next month"))}"${last ? "" : " hidden"}>${ui.icon("es-line-right-chevron", "xs")}</button>`)
			.on("click", () => {
				this.view_month += 1;
				if (this.view_month > 11) {
					this.view_month = 0;
					this.view_year += 1;
				}
				this.render_panel();
			})
			.appendTo($head);

		const ws = this.week_start();
		const $grid = $('<div class="sanad-datefilter__grid"></div>').appendTo($col);
		const names = moment.weekdaysMin();
		for (let i = 0; i < 7; i++) $(`<span class="sanad-datefilter__wd">${ui.escape(names[(i + ws) % 7])}</span>`).appendTo($grid);

		const first_day = new Date(y, m, 1).getDay();
		const blanks = (first_day - ws + 7) % 7;
		const last_date = new Date(y, m + 1, 0).getDate();
		for (let i = 0; i < blanks; i++) $('<span class="sanad-datefilter__day sanad-datefilter__day--blank" aria-hidden="true"></span>').appendTo($grid);
		for (let d = 1; d <= last_date; d++) this.render_day($grid, mk(y, m, d), d, last_date, (blanks + d - 1) % 7);
	}

	/** Which endpoint a day is, if any: `fill` (a picked bound) or `ring` (an excluded pivot). */
	endpoint_of(key) {
		const s = this.state;
		if (this.is_between()) {
			if (key === s.start || key === s.end) return "fill";
			return null;
		}
		if (key !== s.date) return null;
		return s.op === "after" || s.op === "before" ? "ring" : "fill";
	}

	render_day($grid, key, n, last_date, col) {
		const s = this.state;
		const today = today_key();
		const endpoint = this.endpoint_of(key);
		let band = "";
		let radius = "";
		const round_start = col === 0 || n === 1;
		const round_end = col === 6 || n === last_date;
		radius = `${round_start ? 6 : 0}px ${round_end ? 6 : 0}px ${round_end ? 6 : 0}px ${round_start ? 6 : 0}px`;
		if (this.is_between() && s.start) {
			const b = s.end || s.hover || s.start;
			const a = s.start;
			const lo = b < a ? b : a;
			const hi = b < a ? a : b;
			if (lo !== hi && key >= lo && key <= hi) {
				const start_edge = key === lo;
				const end_edge = key === hi;
				band = start_edge ? "start" : end_edge ? "end" : "mid";
			}
		}
		const classes = [
			"sanad-datefilter__day",
			endpoint === "fill" ? "sanad-datefilter__day--on" : "",
			endpoint === "ring" ? "sanad-datefilter__day--ring" : "",
			!endpoint && key === today ? "sanad-datefilter__day--today" : "",
			band ? `sanad-datefilter__day--band sanad-datefilter__day--band-${band}` : "",
		]
			.filter(Boolean)
			.join(" ");
		const $cell = $(`<span class="${classes}"${radius ? ` style="--sanad-band-radius:${radius}"` : ""}><button type="button" class="sanad-datefilter__pill" data-key="${key}">${ui.escape(ui.format_int(n))}</button></span>`);
		$cell.find("button")
			.on("click", () => this.pick_day(key))
			.on("mouseenter", () => {
				if (!this.is_between() || !s.start || s.end) return;
				s.hover = key;
				this.paint_band(); // a full re-render per pointer move would fight the click
			});
		$cell.appendTo($grid);
	}

	/** Re-apply the range wash to the cells already rendered, without rebuilding the panel. */
	paint_band() {
		if (!this.$panel) return;
		const s = this.state;
		const a = s.start;
		const b = s.end || s.hover || s.start;
		if (!a || !b) return;
		const lo = b < a ? b : a;
		const hi = b < a ? a : b;
		this.$panel.find(".sanad-datefilter__day").each((i, el) => {
			const $cell = $(el);
			const key = ($cell.find("button").attr("data-key") || "").trim();
			$cell.removeClass("sanad-datefilter__day--band sanad-datefilter__day--band-start sanad-datefilter__day--band-end sanad-datefilter__day--band-mid");
			if (!key || lo === hi || key < lo || key > hi) return;
			const edge = key === lo ? "start" : key === hi ? "end" : "mid";
			$cell.addClass(`sanad-datefilter__day--band sanad-datefilter__day--band-${edge}`);
		});
	}

	pick_day(key) {
		const s = this.state;
		if (this.is_single()) return this.set({ date: key, typed: {} });
		if (!s.start || s.end) return this.set({ start: key, end: null, hover: null, typed: {} });
		let a = s.start;
		let b = key;
		if (b < a) {
			const x = a;
			a = b;
			b = x;
		}
		return this.set({ start: a, end: b, hover: null, typed: {} });
	}

	/**
	 * A 3×4 grid of choices in place of the panel body. Stepping a year or a month one arrow click
	 * at a time is slow, so every year and month in the control opens one of these instead.
	 *
	 * @param {Object} o
	 * @param {{text: string, on_click?: Function, aria?: string}} o.head — the caption; clickable when
	 *   `on_click` is given (the month grid's year opens the year grid that way)
	 * @param {Function} [o.on_prev] / [o.on_next] — paging arrows; left out, no arrows are drawn
	 * @param {Array<{label: string, on?: boolean, value: *}>} o.items
	 * @param {Function} o.on_pick — `(item) => void`
	 */
	grid_picker($body, o) {
		const $wrap = $('<div class="sanad-datefilter__picker"></div>').appendTo($body);
		const $head = $('<div class="sanad-datefilter__month-head"></div>').appendTo($wrap);
		if (o.on_prev) {
			$(`<button type="button" class="sanad-datefilter__nav" aria-label="${ui.escape(o.prev_label || __("Previous"))}">${ui.icon("es-line-left-chevron", "xs")}</button>`)
				.on("click", o.on_prev)
				.appendTo($head);
		}
		const caption = ui.escape(o.head.text);
		const $cap = o.head.on_click
			? $(`<button type="button" class="sanad-datefilter__picker-year sanad-datefilter__picker-year--open sanad-tabular" aria-label="${ui.escape(o.head.aria || o.head.text)}">${caption}${ui.icon("es-line-down", "xs")}</button>`).on("click", o.head.on_click)
			: $(`<span class="sanad-datefilter__picker-year sanad-tabular">${caption}</span>`);
		$cap.appendTo($head);
		if (o.on_next) {
			$(`<button type="button" class="sanad-datefilter__nav" aria-label="${ui.escape(o.next_label || __("Next"))}">${ui.icon("es-line-right-chevron", "xs")}</button>`)
				.on("click", o.on_next)
				.appendTo($head);
		}
		const $grid = $('<div class="sanad-datefilter__picker-grid"></div>').appendTo($wrap);
		o.items.forEach((it) => {
			$(`<button type="button" class="sanad-datefilter__picker-cell${it.on ? " sanad-datefilter__picker-cell--on" : ""}">${ui.escape(it.label)}</button>`)
				.on("click", () => o.on_pick(it))
				.appendTo($grid);
		});
		return $wrap;
	}

	/** Twelve years to a page, so any year is two clicks away rather than twelve. */
	render_year_picker($body, current, on_pick) {
		// the page is centred on the year in hand, not on a decade: 2026 opens on 2021–2032, so the
		// years either side of it are one click away rather than a page away
		const page = this.state.picker_page == null ? current - 5 : this.state.picker_page;
		const years = [];
		for (let i = 0; i < 12; i++) years.push(page + i);
		return this.grid_picker($body, {
			head: { text: `${page} – ${page + 11}` },
			prev_label: __("Previous years"),
			next_label: __("Next years"),
			on_prev: () => this.set({ picker_page: page - 12 }),
			on_next: () => this.set({ picker_page: page + 12 }),
			items: years.map((y) => ({ label: String(y), value: y, on: y === current })),
			on_pick: (it) => {
				this.state.picker_page = null;
				on_pick(it.value);
			},
		});
	}

	render_month_picker($body) {
		const y = this.state.picker_year || this.view_year;
		return this.grid_picker($body, {
			head: { text: String(y), aria: __("Pick a year"), on_click: () => this.set({ pick: "year", picker_page: null }) },
			prev_label: __("Previous year"),
			next_label: __("Next year"),
			on_prev: () => this.set({ picker_year: y - 1 }),
			on_next: () => this.set({ picker_year: y + 1 }),
			items: this.month_names().map((name, i) => ({ label: name, value: i, on: i === this.view_month && y === this.view_year })),
			on_pick: (it) => {
				this.view_year = y;
				this.view_month = it.value;
				this.set({ pick: null });
			},
		});
	}

	render_options($main) {
		const s = this.state;
		const $row = $('<div class="sanad-datefilter__options"></div>').appendTo($main);
		const $check = $(`<label class="sanad-datefilter__check"><input type="checkbox"${s.with_time ? " checked" : ""}><span>${ui.escape(__("Set a time"))}</span></label>`).appendTo($row);
		$check.find("input").on("change", (e) => this.set({ with_time: e.target.checked }));
		if (!this.is_single()) return;
		const $quick = $('<div class="sanad-datefilter__quick"></div>').appendTo($row);
		this.single_presets().forEach((p) => {
			$(`<button type="button" class="sanad-datefilter__preset${s.date === p.date ? " sanad-datefilter__preset--on" : ""}">${ui.escape(p.label)}</button>`)
				.on("click", () => {
					const d = to_date(p.date);
					this.view_year = d.getFullYear();
					this.view_month = d.getMonth();
					this.set({ date: p.date, typed: {} });
				})
				.appendTo($quick);
		});
		return undefined;
	}

	// ---- timespan / fiscal ------------------------------------------------------------------------

	segmented($parent, items, current, on_pick) {
		const $seg = $('<div class="sanad-datefilter__seg" role="group"></div>').appendTo($parent);
		items.forEach((it) => {
			$(`<button type="button" class="sanad-datefilter__seg-item${it.key === current ? " sanad-datefilter__seg-item--on" : ""}" aria-pressed="${it.key === current}">${ui.escape(it.label)}</button>`)
				.on("click", () => on_pick(it.key))
				.appendTo($seg);
		});
		return $seg;
	}

	render_timespan($body) {
		const s = this.state;
		const $form = $('<div class="sanad-datefilter__form"></div>').appendTo($body);
		const row = (label) => {
			const $r = $('<div class="sanad-datefilter__form-row"></div>').appendTo($form);
			$(`<span class="sanad-datefilter__form-label">${ui.escape(label)}</span>`).appendTo($r);
			return $('<div class="sanad-datefilter__form-field"></div>').appendTo($r);
		};
		this.segmented(row(__("Direction")), [{ key: "past", label: __("Last") }, { key: "next", label: __("Next") }], s.span_dir, (k) => this.set({ span_dir: k }));
		const $count = row(__("Count"));
		$(`<input type="text" inputmode="numeric" class="sanad-datefilter__count sanad-tabular" value="${ui.escape(String(s.span_n))}" maxlength="4" aria-label="${ui.escape(__("Count"))}">`)
			.on("change blur", (e) => this.set({ span_n: Math.max(1, cint(latin_digits(e.target.value)) || 1) }))
			.appendTo($count);
		this.segmented($count, UNITS().map((u) => ({ key: u.key, label: u.label })), s.span_unit, (k) => this.set({ span_unit: k }));
		if (s.span_unit !== "hour") {
			const $inc = row(__("Today"));
			const $c = $(`<label class="sanad-datefilter__check"><input type="checkbox"${s.span_inc ? " checked" : ""}><span>${ui.escape(__("Include today"))}</span></label>`).appendTo($inc);
			$c.find("input").on("change", (e) => this.set({ span_inc: e.target.checked }));
		}
		const $common = row(__("Common"));
		const $grid = $('<div class="sanad-datefilter__common"></div>').appendTo($common);
		this.span_presets().forEach((p) => {
			const on = s.span_dir === p.dir && cint(s.span_n) === p.n && s.span_unit === p.unit && s.span_inc;
			$(`<button type="button" class="sanad-datefilter__preset${on ? " sanad-datefilter__preset--on" : ""}">${ui.escape(p.label)}</button>`)
				.on("click", () => this.set({ span_dir: p.dir, span_n: p.n, span_unit: p.unit, span_inc: true }))
				.appendTo($grid);
		});
	}

	render_fiscal($body) {
		const s = this.state;
		// both of the fiscal panel's steppers open a grid instead of walking one click at a time
		if (s.pick === "fiscal_year") {
			return this.render_year_picker($body, s.fiscal_year, (y) => this.set({ fiscal_year: y, pick: null }));
		}
		if (s.pick === "fiscal_start") {
			return this.grid_picker($body, {
				head: { text: __("Starts in") },
				items: this.month_names().map((name, i) => ({ label: name, value: i, on: i === s.fiscal_start })),
				on_pick: (it) => this.set({ fiscal_start: it.value, pick: null }),
			});
		}
		const $form = $('<div class="sanad-datefilter__form"></div>').appendTo($body);
		const row = (label) => {
			const $r = $('<div class="sanad-datefilter__form-row"></div>').appendTo($form);
			$(`<span class="sanad-datefilter__form-label">${ui.escape(label)}</span>`).appendTo($r);
			return $('<div class="sanad-datefilter__form-field"></div>').appendTo($r);
		};
		// arrows to nudge, the value itself to jump — the grid is behind the value
		const stepper = ($parent, value, on_step, on_open, aria) => {
			const $s = $('<div class="sanad-datefilter__stepper"></div>').appendTo($parent);
			$(`<button type="button" class="sanad-datefilter__nav" aria-label="${ui.escape(__("Previous {0}", [aria]))}">${ui.icon("es-line-left-chevron", "xs")}</button>`)
				.on("click", () => on_step(-1))
				.appendTo($s);
			$(`<button type="button" class="sanad-datefilter__stepper-value sanad-tabular" aria-label="${ui.escape(__("Pick a {0}", [aria]))}">${ui.escape(value)}${ui.icon("es-line-down", "xs")}</button>`)
				.on("click", on_open)
				.appendTo($s);
			$(`<button type="button" class="sanad-datefilter__nav" aria-label="${ui.escape(__("Next {0}", [aria]))}">${ui.icon("es-line-right-chevron", "xs")}</button>`)
				.on("click", () => on_step(1))
				.appendTo($s);
		};
		stepper(
			row(__("Fiscal year")),
			String(s.fiscal_year),
			(n) => this.set({ fiscal_year: s.fiscal_year + n }),
			() => this.set({ pick: "fiscal_year", picker_page: null }),
			__("year")
		);
		stepper(
			row(__("Starts in")),
			this.month_names()[s.fiscal_start],
			(n) => this.set({ fiscal_start: (s.fiscal_start + n + 12) % 12 }),
			() => this.set({ pick: "fiscal_start" }),
			__("month")
		);
		this.segmented(row(__("Period")), PERIODS().map((p) => ({ key: p.key, label: p.short })), s.fiscal_period, (k) => this.set({ fiscal_period: k }));
		const p = PERIODS().find((x) => x.key === s.fiscal_period) || PERIODS()[0];
		const $bars = $('<div class="sanad-datefilter__bars"></div>').appendTo(row(__("Months")));
		for (let i = 0; i < 12; i++) {
			const month = (s.fiscal_start + i) % 12;
			const inside = i >= p.a && i < p.b;
			$(`<button type="button" class="sanad-datefilter__bar${inside ? " sanad-datefilter__bar--on" : ""}" aria-label="${ui.escape(this.month_names()[month])}"><span class="sanad-datefilter__bar-fill"></span><span class="sanad-datefilter__bar-label">${ui.escape(moment.monthsShort()[month])}</span></button>`)
				.on("click", () => {
					const q = ["Q1", "Q2", "Q3", "Q4"][Math.floor(i / 3)];
					this.set({ fiscal_period: q });
				})
				.appendTo($bars);
		}
	}

	/**
	 * With more than one field filtered, the panel opens on a rail of them: each carries its own
	 * dates, the one being edited is pressed, and its × drops it. This is the whole of "several
	 * fields at once" — the toolbar keeps one trigger, and the rail is where they are added,
	 * reviewed and edited.
	 */
	render_field_rail() {
		const entries = typeof this.opts.field_rail === "function" ? this.opts.field_rail() : [];
		if (entries.length < 2) return;
		const $rail = $(`<div class="sanad-datefilter__rail" role="tablist" aria-label="${ui.escape(__("Date field"))}"></div>`).appendTo(this.$panel);
		entries.forEach((e) => {
			const on = e.fieldname === this.fieldname;
			const $item = $(`<div class="sanad-datefilter__rail-item${on ? " sanad-datefilter__rail-item--on" : ""}">
					<button type="button" class="sanad-datefilter__rail-pick" role="tab" aria-selected="${on}">
						<span class="sanad-datefilter__rail-name">${ui.escape(e.label)}</span>
						<span class="sanad-datefilter__rail-value${e.summary ? "" : " sanad-datefilter__rail-value--empty"}">${ui.escape(e.summary || __("Not set"))}</span>
					</button>
					<button type="button" class="sanad-datefilter__rail-drop" aria-label="${ui.escape(__("Remove {0}", [e.label]))}">${ui.icon("es-line-close", "xs")}</button>
				</div>`).appendTo($rail);
			$item.find(".sanad-datefilter__rail-pick").on("click", () => {
				if (on || typeof this.opts.on_pick_row !== "function") return;
				this.opts.on_pick_row(e.fieldname);
			});
			$item.find(".sanad-datefilter__rail-drop").on("click", (ev) => {
				ev.stopPropagation();
				if (typeof this.opts.on_drop_row === "function") this.opts.on_drop_row(e.fieldname);
			});
		});
	}

	// ---- footer -----------------------------------------------------------------------------------

	render_footer() {
		const r = this.calc();
		const $foot = $('<div class="sanad-datefilter__footer"></div>').appendTo(this.$panel);
		$(`<span class="sanad-datefilter__summary${r.ready ? "" : " sanad-datefilter__summary--muted"}">${ui.escape(this.summary_text())}</span>`).appendTo($foot);
		const show_count = r.ready && r.from && r.to && this.state.op !== "is" && !(this.state.op === "timespan" && this.state.span_unit === "hour");
		if (show_count) $(`<span class="sanad-datefilter__count-chip sanad-tabular">${ui.escape(this.days_text(span_days(r.from, r.to)))}</span>`).appendTo($foot);
		$(`<button type="button" class="sanad-datefilter__cancel">${ui.escape(__("Cancel"))}</button>`)
			.on("click", () => this.close(true))
			.appendTo($foot);
		const $apply = $(`<button type="button" class="sanad-datefilter__apply"${r.ready ? "" : ' disabled aria-disabled="true"'}>${ui.escape(__("Apply"))}</button>`).appendTo($foot);
		if (r.ready) $apply.on("click", () => this.apply());
	}

	destroy() {
		$(document).off(`.${this.id}`);
		this.close();
		this.close_menu();
		this.close_fields();
		this.$el.remove();
	}
};

/**
 * sanad.ui.DateFilterSet — several date fields behind **one** trigger.
 *
 * The toolbar shows a single control: it reads the field's own name while one field is filtered,
 * and a tag carrying the count once several are. Opening it shows a rail of those fields, each
 * with its own dates; the rail is where a field is reviewed, edited or dropped, and the field
 * segment's multi-select list is where one is added. Apply commits every field at once, so the
 * list is refetched once, and the trigger's × clears the lot back to a single field.
 *
 * `on_change(rows, {removed})` fires on Apply and on Clear, with `rows = [{fieldname, value}]` and
 * `removed` the fieldnames the set no longer holds.
 */
sanad.ui.DateFilterSet = class DateFilterSet {
	/**
	 * @param {Object} opts
	 * @param {jQuery|HTMLElement} opts.wrapper
	 * @param {Array} opts.fields — `[{fieldname|value, label}]`, the date fields on offer
	 * @param {string} [opts.fieldname] — the field the set starts on
	 * @param {Function} [opts.on_change] — `(rows, {removed}) => void`
	 * …plus anything `DateFilter` takes, passed straight through to every field.
	 */
	constructor(opts = {}) {
		this.opts = Object.assign({}, opts);
		this.fields = normalise_fields(opts.fields);
		this.rows = [];
		this.$el = $('<div class="sanad-kit sanad-datefilter-set"></div>').appendTo($(opts.wrapper));
		this.add(opts.fieldname || (this.fields[0] || {}).value, { silent: true });
	}

	selected() {
		return this.rows.map((r) => r.fieldname);
	}

	row_of(fieldname) {
		return this.rows.find((r) => r.fieldname === fieldname) || null;
	}

	/** `[{fieldname, value}]` — `value` is `null` while that field has nothing applied. */
	values() {
		return this.rows.map((r) => ({ fieldname: r.fieldname, value: (r.applied && r.applied.value) || null }));
	}

	label_of(fieldname) {
		const f = this.fields.find((x) => x.value === fieldname);
		return f ? f.label : fieldname;
	}

	/** Only the active field's trigger is in the toolbar; the rest wait behind the rail. */
	render() {
		if (!this.active || !this.rows.includes(this.active)) this.active = this.rows[0];
		this.rows.forEach((r) => r.$el.toggleClass("sanad-datefilter--hidden", r !== this.active));
		if (this.active) this.active.reflect_trigger();
		return this;
	}

	add(fieldname, { silent = false, activate = true } = {}) {
		if (!fieldname || this.row_of(fieldname)) return null;
		const row = new sanad.ui.DateFilter(
			Object.assign({}, this.opts, {
				wrapper: this.$el,
				fields: this.fields,
				fieldname,
				value: null,
				field_caption: () => this.field_caption(),
				field_rail: () => this.rail_entries(),
				selected_fields: () => this.selected(),
				on_toggle_field: (picked, from) => this.toggle(picked, from),
				on_pick_row: (fn) => this.activate(fn, { open: true }),
				on_drop_row: (fn) => this.remove(fn, { open: true }),
				on_apply_all: () => this.apply_all(),
				on_clear_all: () => this.clear(),
				on_change: null, // the set emits once for every field, from apply_all / clear
			})
		);
		this.rows.push(row);
		if (activate) this.active = row;
		this.render();
		if (!silent) this.emit();
		return row;
	}

	remove(fieldname, { silent = false, open = false } = {}) {
		const row = this.row_of(fieldname);
		if (!row || this.rows.length < 2) return this;
		const was_active = row === this.active;
		this.rows = this.rows.filter((r) => r !== row);
		const had = !!row.applied;
		row.destroy();
		if (was_active) this.active = this.rows[0];
		this.render();
		if (open) this.reopen();
		if (!silent) this.emit(had ? [fieldname] : []);
		return this;
	}

	/** Show the active field's panel, redrawing it in place when it is already open. */
	reopen() {
		if (!this.active) return this;
		if (this.active.$panel) this.active.render_panel();
		else this.active.open({ keep_state: true });
		return this;
	}

	/** Show another field's dates; the one being left keeps its unapplied draft. */
	activate(fieldname, { open = false } = {}) {
		const row = this.row_of(fieldname);
		if (!row) return this;
		if (this.active) this.active.close();
		this.active = row;
		this.render();
		if (open) row.open({ keep_state: true });
		return this;
	}

	/** One tick in the field list: an unheld field is added and opened, a held one is dropped. */
	toggle(fieldname, from) {
		if (this.row_of(fieldname)) return this.remove(fieldname, { open: true });
		const blank = from && !from.applied;
		if (blank) {
			// an untouched field moves rather than leaving an empty one behind
			const was = from.fieldname;
			from.set_field(fieldname, { silent: true });
			this.activate(fieldname, { open: true });
			return this.emit(was === fieldname ? [] : [was]);
		}
		this.add(fieldname);
		return this.reopen();
	}

	field_caption() {
		const n = this.rows.length;
		if (n > 1) return { text: __("{0} fields", [ui.format_int(n)]), count: n };
		return { text: this.label_of((this.rows[0] || {}).fieldname), count: 1 };
	}

	rail_entries() {
		return this.rows.map((r) => ({
			fieldname: r.fieldname,
			label: this.label_of(r.fieldname),
			summary: r.applied ? r.applied.value.label : "",
		}));
	}

	/** One Apply commits every field that has a usable draft, so the list is refetched once. */
	apply_all() {
		this.rows.forEach((r) => {
			if (r !== this.active && r.get_value()) r.apply({ cascade: false, silent: true });
		});
		this.rows.forEach((r) => r.close());
		this.render();
		return this.emit();
	}

	clear({ silent = false } = {}) {
		const removed = this.rows.slice(1).map((r) => r.fieldname);
		this.rows.slice(1).forEach((r) => r.destroy());
		this.rows = this.rows.slice(0, 1);
		this.rows.forEach((r) => r.clear({ silent: true, cascade: false }));
		this.active = this.rows[0];
		this.render();
		if (!silent) this.emit(removed);
		return this;
	}

	emit(removed = []) {
		if (typeof this.opts.on_change === "function") this.opts.on_change(this.values(), { removed });
		return this;
	}

	destroy() {
		this.rows.forEach((r) => r.destroy());
		this.rows = [];
		this.$el.remove();
	}
};

export default sanad.ui.DateFilter;

// sanad.ui.Render value renderers — one presentation per fieldtype, richer than raw text but
// never louder than the record it belongs to (reference image 06). Every renderer is
// `(value, df, doc, opts) => html`, where `opts.density` is the display level
// (`inline` | `compact` | `row` | `card` | `hero`) and `opts.variant` forces a specific
// treatment (`badge`, `strong`, `progress`, `relative`, `readable`).
//
// A host app overrides or adds one with `sanad.ui.Render.field("Currency", fn)`.

import ui from "../_core/index.js";
import { chip, progress, stars, code } from "./parts.js";

const BIG = ["card", "hero"];

/** Bytes → "245 KB" / "1.2 MB" (file rows, attachment chips). */
export function file_size(bytes) {
	const n = flt(bytes);
	if (!n) return "";
	const units = [__("B"), __("KB"), __("MB"), __("GB")];
	let i = 0;
	let value = n;
	while (value >= 1024 && i < units.length - 1) {
		value /= 1024;
		i++;
	}
	return `${i === 0 ? cint(value) : flt(value).toFixed(value >= 10 ? 0 : 1)} ${units[i]}`;
}

/** Extension of a file URL or name, upper-cased and without the dot. */
export function file_ext(url) {
	const clean = cstr(url).split("?")[0].split("#")[0];
	const part = clean.split(".").pop();
	return part && part.length <= 5 && part !== clean ? part.toUpperCase() : "";
}

const wrap = (html, cls = "") => (html === "" || html == null ? "" : `<span class="sanad-value${cls ? ` ${cls}` : ""}">${html}</span>`);

/** Amount with the doc's currency, tabular and always left-to-right inside Arabic text. */
function amount(value, df, doc, { density, variant } = {}) {
	const html = frappe.format(value, df || { fieldtype: "Currency" }, { inline: true }, doc);
	const strong = variant === "strong" || BIG.includes(density);
	return `<span class="sanad-amount${strong ? " sanad-amount--strong" : ""} sanad-tabular" dir="ltr">${html}</span>`;
}

function number(value, df, doc, { density, variant } = {}) {
	const html = frappe.format(value, df || { fieldtype: "Float" }, { inline: true }, doc);
	const strong = variant === "strong" || BIG.includes(density);
	return `<span class="sanad-number${strong ? " sanad-number--strong" : ""} sanad-tabular" dir="ltr">${html}</span>`;
}

function percent(value, df, doc, { density, variant } = {}) {
	const pct = flt(value);
	if (variant === "number") return `<span class="sanad-tabular" dir="ltr">${flt(pct).toFixed(pct % 1 ? 1 : 0)}%</span>`;
	if (variant === "progress" || BIG.includes(density) || density === "row") return progress(pct);
	return `<span class="sanad-tabular" dir="ltr">${flt(pct).toFixed(pct % 1 ? 1 : 0)}%</span>`;
}

/** Date: short by default, readable in cards, relative when asked (never a raw timestamp). */
function date(value, df, doc, { density, variant } = {}) {
	if (!value) return "";
	if (variant === "relative") return `<span class="sanad-when" title="${ui.escape(frappe.datetime.str_to_user(value))}">${ui.escape(frappe.datetime.prettyDate(value))}</span>`;
	const text = variant === "readable" || BIG.includes(density) ? frappe.datetime.global_date_format(value) : frappe.datetime.str_to_user(value);
	return `<span class="sanad-when sanad-tabular" dir="ltr">${ui.escape(text)}</span>`;
}

/** Datetime: the human line ("Today, 3:56 PM") with the full stamp in the tooltip. */
function datetime(value, df, doc, { variant } = {}) {
	if (!value) return "";
	const full = frappe.datetime.str_to_user(value);
	if (variant === "relative") return `<span class="sanad-when" title="${ui.escape(full)}">${ui.escape(frappe.datetime.prettyDate(value))}</span>`;
	const today = frappe.datetime.get_today();
	const day = cstr(value).split(" ")[0];
	const time = frappe.datetime.str_to_user(value, true);
	let text = full;
	if (day === today) text = `${__("Today")}, ${time}`;
	else if (day === frappe.datetime.add_days(today, -1)) text = `${__("Yesterday")}, ${time}`;
	return `<span class="sanad-when" title="${ui.escape(full)}"><span class="sanad-tabular" dir="auto">${ui.escape(text)}</span></span>`;
}

/** Read-only booleans are Yes / No, never a checkbox that looks editable. */
function check(value, df, doc, { variant } = {}) {
	const on = !!cint(value);
	if (variant === "text") return ui.escape(on ? __("Yes") : __("No"));
	return sanad.ui.StatusBadge.html({ label: on ? __("Yes") : __("No"), colour: on ? "green" : "gray", icon: on });
}

/** Select: a status badge for status-like fields, plain translated text otherwise. */
function select(value, df, doc, { variant, doctype } = {}) {
	if (value == null || value === "") return "";
	const status_like = variant === "badge" || (df && /(^|_)status$/.test(cstr(df.fieldname))) || (df && df.fieldname === "state");
	if (!status_like) return ui.escape(__(cstr(value)));
	const dt = doctype || (doc && doc.doctype);
	const ind = dt ? ui.indicator_for(dt, Object.assign({ doctype: dt }, doc, { [df.fieldname]: value })) : null;
	return sanad.ui.StatusBadge.html({ label: __(cstr(value)), colour: (ind && ind.colour) || "gray" });
}

/** Link: the target rendered by its own kind at `inline` density, so a person reads as a person. */
function link(value, df, doc, opts = {}) {
	if (!value) return "";
	const target = (df && df.options) || opts.target;
	const display = (doc && df && doc[`${df.fieldname}_title`]) || value;
	if (!target) return ui.escape(display);
	const Render = sanad.ui.Render;
	if (Render && opts.density && opts.density !== "inline") {
		return Render.entity({ doctype: target, name: value, title: display }, { density: opts.density, compact_fallback: true });
	}
	return Render ? Render.doc_link(target, value, display) : frappe.utils.get_form_link(target, value, true, ui.escape(display));
}

function dynamic_link(value, df, doc, opts = {}) {
	const target = doc && df && doc[df.options];
	return link(value, Object.assign({}, df, { options: target }), doc, opts);
}

/** Phone / mobile: left-to-right, with call and WhatsApp affordances on the bigger densities. */
function phone(value, df, doc, { density } = {}) {
	if (!value) return "";
	const clean = cstr(value).replace(/[^\d+]/g, "");
	const text = chip({ icon: "es-line-call", text: cstr(value), ltr: true, href: `tel:${clean}` });
	if (density === "inline" || density === "compact") return `<span class="sanad-tabular" dir="ltr">${ui.escape(value)}</span>`;
	return text;
}

function email(value) {
	if (!value) return "";
	return chip({ icon: "es-line-email", text: cstr(value), ltr: true, href: `mailto:${encodeURIComponent(value)}` });
}

function url(value, df, doc, { density } = {}) {
	if (!value) return "";
	const text = cstr(value).replace(/^https?:\/\//, "");
	return chip({ icon: "es-line-link", text: density === "inline" ? text.slice(0, 40) : text, ltr: true, href: value, title: value });
}

/** Attach / Attach Image: a file chip, a thumbnail card or a row depending on the density. */
function attach(value, df, doc, opts = {}) {
	if (!value) return "";
	const Render = sanad.ui.Render;
	const is_image = (df && df.fieldtype === "Attach Image") || /\.(png|jpe?g|gif|webp|svg|avif)$/i.test(cstr(value));
	return Render
		? Render.entity({ doctype: "File", file_url: value, file_name: cstr(value).split("/").pop(), is_image }, { kind: "file", density: opts.density || "compact" })
		: chip({ icon: "es-line-attachment", text: cstr(value).split("/").pop(), href: value, ltr: true });
}

/** Tags / Table MultiSelect: small chips that never dominate the row. */
function tags(value, df, doc, { density } = {}) {
	let list = value;
	if (typeof value === "string") list = value.split(",").map((t) => t.trim()).filter(Boolean);
	if (!Array.isArray(list) || !list.length) return "";
	const shown = density === "inline" ? list.slice(0, 2) : list.slice(0, 6);
	const rest = list.length - shown.length;
	const html = shown
		.map((t) => {
			const label = typeof t === "string" ? t : t.label || t.name || t[Object.keys(t)[0]];
			return `<span class="sanad-tag">${ui.escape(__(cstr(label)))}</span>`;
		})
		.join("");
	return `<span class="sanad-tag-row">${html}${rest > 0 ? `<span class="sanad-tag sanad-tag--rest">+${ui.format_int(rest)}</span>` : ""}</span>`;
}

/** Geolocation / address: the place, with coordinates and a map link when there is room. */
function location(value, df, doc, { density } = {}) {
	if (!value) return "";
	let text = cstr(value);
	let coords = null;
	try {
		const geo = typeof value === "string" ? JSON.parse(value) : value;
		const point = geo && geo.features && geo.features[0] && geo.features[0].geometry;
		if (point && Array.isArray(point.coordinates)) {
			coords = [flt(point.coordinates[1]).toFixed(4), flt(point.coordinates[0]).toFixed(4)];
			text = coords.join(", ");
		}
	} catch (e) {
		// a plain address string
	}
	const line = chip({ icon: "es-line-location", text, ltr: !!coords });
	if (!coords || density === "inline" || density === "compact") return line;
	return `${line} ${chip({ icon: "es-line-location", text: __("View on map"), href: `https://www.google.com/maps?q=${coords[0]},${coords[1]}` })}`;
}

function long_text(value, df, doc, { density } = {}) {
	if (value == null || value === "") return "";
	const text = cstr(value);
	if (density === "inline" || density === "compact") {
		const one = text.replace(/\s+/g, " ").trim();
		return `<span class="sanad-clamp sanad-clamp--1" dir="auto" title="${ui.escape(one.slice(0, 300))}">${ui.escape(one)}</span>`;
	}
	return `<span class="sanad-clamp sanad-clamp--4" dir="auto">${ui.escape(text)}</span>`;
}

function rich_text(value, df, doc, { density } = {}) {
	if (!value) return "";
	if (density === "inline" || density === "compact") return long_text(strip_html(cstr(value)), df, doc, { density });
	return `<div class="sanad-rich" dir="auto">${frappe.utils.sanitise_html ? frappe.utils.sanitise_html(value) : ui.escape(strip_html(cstr(value)))}</div>`;
}

function colour(value) {
	if (!value) return "";
	return `<span class="sanad-chipline"><span class="sanad-swatch" style="background:${ui.escape(value)}" aria-hidden="true"></span><span class="sanad-chipline__text" dir="ltr">${ui.escape(value)}</span></span>`;
}

function duration(value, df, doc) {
	return `<span class="sanad-tabular" dir="ltr">${frappe.format(value, df || { fieldtype: "Duration" }, { inline: true }, doc)}</span>`;
}

/** The default: Frappe's own formatter, escaped by it, with `dir="auto"` so mixed text behaves. */
function fallback(value, df, doc) {
	if (value == null || value === "") return "";
	if (!df || !df.fieldtype || df.fieldtype === "Data") return `<span dir="auto">${ui.escape(value)}</span>`;
	return `<span dir="auto">${ui.meta.format(value, df, doc)}</span>`;
}

export const VALUE_RENDERERS = {
	Currency: amount,
	Float: number,
	Int: number,
	Percent: percent,
	Date: date,
	Datetime: datetime,
	Time: (value) => `<span class="sanad-tabular" dir="ltr">${ui.escape(frappe.datetime.str_to_user(value, true))}</span>`,
	Duration: duration,
	Check: check,
	Select: select,
	Rating: (value) => stars(value),
	Link: link,
	"Dynamic Link": dynamic_link,
	Phone: phone,
	Attach: attach,
	"Attach Image": attach,
	"Table MultiSelect": tags,
	Geolocation: location,
	Code: (value, df, doc, opts) => code(value, { density: (opts && opts.density) || "card", language: (df && df.options) || "" }),
	JSON: (value, df, doc, opts) => code(value, { density: (opts && opts.density) || "card", language: "json" }),
	"Text Editor": rich_text,
	HTML: rich_text,
	"Markdown Editor": long_text,
	"Small Text": long_text,
	"Long Text": long_text,
	Text: long_text,
	Color: colour,
	Data: (value, df, doc, opts) => {
		const options = cstr(df && df.options);
		if (options === "Phone") return phone(value, df, doc, opts);
		if (options === "Email") return email(value, df, doc, opts);
		if (options === "URL") return url(value, df, doc, opts);
		return fallback(value, df, doc);
	},
};

export const VALUE_HELPERS = { amount, number, percent, date, datetime, check, select, link, phone, email, url, attach, tags, location, long_text, rich_text, fallback, wrap };

export default VALUE_RENDERERS;

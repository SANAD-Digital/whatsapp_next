// sanad.kit — the design prototype's own control layer, ported.
//
// `docs/shared/ui-kit.js` is the prototype's "one source for the design of fields and buttons".
// Most of what it holds has no equivalent in Frappe — a segmented control, a tonal button, a
// tone-aware badge, a field with attached add-ons, a density switch — which is why it is ported
// rather than approximated. The geometry and the colours live in `_kit/style.scss`; this file is
// the small amount of JavaScript that goes with them: the icon set, and builders that return the
// markup so a screen never has to remember a class name.
//
// Nothing here reads anything outside the kit, so `public/js/ui/` stays copy-pasteable.

import ui from "../_core/index.js";
import ICONS, { ico, ICON_NAMES } from "./icons.js";

const esc = (v) => ui.escape(v == null ? "" : v);

/** The five tones the prototype gives a badge, a dot or a tinted surface. */
export const TONES = ["ok", "warn", "danger", "info", "muted"];

/** The five button variants, each with the job the prototype assigns it. */
export const VARIANTS = ["primary", "secondary", "danger", "ghost", "tonal"];

/**
 * A button.
 * @param {object} o
 * @param {string} [o.label]
 * @param {string} [o.icon] — a key of the icon set; alone, it makes an icon-only square
 * @param {"primary"|"secondary"|"danger"|"ghost"|"tonal"} [o.variant="secondary"]
 * @param {"sm"|"md"|"lg"} [o.size="md"]
 * @param {boolean} [o.block] — full width
 * @param {boolean} [o.disabled]
 * @param {string} [o.title] — also the accessible name of an icon-only button
 * @param {object} [o.attrs] — extra attributes, e.g. `{"data-key": "save"}`
 */
export function btn(o = {}) {
	const label = o.label ? `<span>${esc(o.label)}</span>` : "";
	const only = !o.label && o.icon;
	const cls = [
		"wa-btn",
		`wa-btn--${VARIANTS.includes(o.variant) ? o.variant : "secondary"}`,
		o.size && o.size !== "md" ? `wa-btn--${o.size}` : "",
		only ? "wa-btn--icon" : "",
		o.block ? "wa-btn--block" : "",
		o.cls || "",
	]
		.filter(Boolean)
		.join(" ");
	const name = o.title || o.label || "";
	const attrs = Object.entries(o.attrs || {})
		.map(([k, v]) => ` ${k}="${esc(v)}"`)
		.join("");
	return `<button type="button" class="${cls}"${o.disabled ? " disabled" : ""}${name ? ` title="${esc(name)}"` : ""}${only && name ? ` aria-label="${esc(name)}"` : ""}${attrs}>${o.icon ? ico(o.icon, o.size === "lg" ? "md" : "sm") : ""}${label}</button>`;
}

/**
 * A status badge: a dot and a word, in one of the five tones.
 * @param {string} label
 * @param {"ok"|"warn"|"danger"|"info"|"muted"|"pri"} [tone="muted"]
 * @param {{dot?: boolean, icon?: string}} [o]
 */
export function badge(label, tone = "muted", o = {}) {
	const cls = `wa-badge wa-badge--${tone}${o.dot === false ? " wa-badge--nodot" : ""}`;
	return `<span class="${cls}">${o.icon ? ico(o.icon, "xs") : ""}${esc(label)}</span>`;
}

/**
 * A segmented control — two to four short options side by side, which is what a select becomes
 * when the options are few.
 * @param {Array<{value: string, label: string, icon?: string, disabled?: boolean}>} options
 * @param {string} value — the chosen one
 * @param {{label?: string, name?: string}} [o]
 */
export function segmented(options, value, o = {}) {
	const opts = (options || [])
		.map(
			(opt) =>
				`<button type="button" class="wa-seg__opt" role="radio" aria-checked="${opt.value === value}" tabindex="${opt.value === value ? 0 : -1}" data-value="${esc(opt.value)}"${opt.disabled ? " disabled" : ""}>${opt.icon ? ico(opt.icon, "xs") : ""}<span>${esc(opt.label)}</span></button>`
		)
		.join("");
	return `<div class="wa-seg" role="radiogroup"${o.label ? ` aria-label="${esc(o.label)}"` : ""}>${opts}</div>`;
}

/** The rule that titles a form section: its name at the start, what it costs at the end. */
export function rule(label, note) {
	return `<div class="wa-rule"><span class="wa-rule__label">${esc(label)}</span><span class="wa-rule__line"></span>${note ? `<span class="wa-rule__note">${esc(note)}</span>` : ""}</div>`;
}

/** Two letters for an avatar: one per word, or the first two of a single word. */
export function initials(name) {
	const words = String(name || "").trim().split(/\s+/).filter(Boolean);
	if (!words.length) return "";
	if (words.length === 1) return words[0].slice(0, 2);
	return words[0][0] + words[1][0];
}

/** @param {{name?: string, text?: string, src?: string, size?: "sm"|"md"|"lg", square?: boolean}} o */
export function avatar(o = {}) {
	const cls = `wa-avatar${o.size ? ` wa-avatar--${o.size}` : ""}${o.square ? " wa-avatar--sq" : ""}`;
	const body = o.src ? `<img src="${esc(o.src)}" alt="" loading="lazy">` : esc(o.text || initials(o.name));
	return `<span class="${cls}" aria-hidden="true">${body}</span>`;
}

/**
 * Bind a segmented control: arrow keys move and choose, as a radio group must (WCAG 2.1.1).
 * @param {jQuery|HTMLElement} el — the `.wa-seg`
 * @param {(value: string) => void} on_pick
 */
export function bind_segmented(el, on_pick) {
	const $el = $(el);
	const pick = ($opt) => {
		const value = $opt.attr("data-value");
		$el.find(".wa-seg__opt").attr("aria-checked", "false").attr("tabindex", "-1");
		$opt.attr("aria-checked", "true").attr("tabindex", "0");
		on_pick && on_pick(value);
	};
	$el.on("click", ".wa-seg__opt", (e) => pick($(e.currentTarget)));
	$el.on("keydown", ".wa-seg__opt", (e) => {
		const items = $el.find(".wa-seg__opt:not([disabled])").toArray();
		const i = ui.roving_index(e, items, items.indexOf(e.currentTarget));
		if (i < 0) return;
		e.preventDefault();
		items[i].focus();
		pick($(items[i]));
	});
	return $el;
}

const kit = { ICONS, ICON_NAMES, ico, btn, badge, segmented, rule, avatar, initials, bind_segmented, TONES, VARIANTS };

// the kit hangs off the same namespace as the components, so a screen writes `ui.ico(…)`
Object.assign(sanad.ui, kit);
sanad.kit = kit;

export default kit;

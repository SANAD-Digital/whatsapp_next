// whatsapp.ui.Render building blocks — the small pieces every renderer is assembled from: avatar,
// thumbnail, chip, fact tile, progress bar, stars, code preview. They are plain HTML builders
// (no state, no DOM), so a renderer is a pure function of its view model and every caller —
// drawer, list cell, card, timeline — gets the same piece at the same size.
//
// Colours are Espresso tokens only, layout is logical (RTL for free), every label is escaped.

import ui from "../_core/index.js";

/** Avatar: the record's image when there is one, else its initials, else a fieldtype icon. */
export function avatar({ image, initials, icon, tone = "gray", size = "md", alt = "" } = {}) {
	const cls = `whatsapp-kit-avatar whatsapp-kit-avatar--${size} whatsapp-kit-tone--${ui.tone_for_colour(tone)}`;
	if (image) {
		return `<span class="${cls} whatsapp-kit-avatar--image"><img src="${ui.escape(image)}" alt="${ui.escape(alt)}" loading="lazy"></span>`;
	}
	if (initials) {
		return `<span class="${cls}" aria-hidden="true">${ui.escape(initials)}</span>`;
	}
	return `<span class="${cls} whatsapp-kit-avatar--icon" aria-hidden="true">${ui.icon(icon || "es-line-filetype", size === "sm" ? "sm" : "md")}</span>`;
}

/** Image thumbnail with a fixed box (gallery, item cards, attachment previews). */
export function thumb({ src, alt = "", size = "md", icon = "es-line-image" } = {}) {
	const cls = `whatsapp-kit-thumb whatsapp-kit-thumb--${size}`;
	if (!src) return `<span class="${cls} whatsapp-kit-thumb--empty" aria-hidden="true">${ui.icon(icon, "md")}</span>`;
	return `<span class="${cls}"><img src="${ui.escape(src)}" alt="${ui.escape(alt)}" loading="lazy"></span>`;
}

/** Small icon + text pair used for secondary facts (phone, branch, group, date). */
export function icon_text_chip_html({ icon, text, title, ltr = false, tone, href, cls = "" } = {}) {
	if (text == null || text === "") return "";
	const body = `${icon ? `<span class="whatsapp-kit-chipline__icon" aria-hidden="true">${ui.icon(icon, "xs")}</span>` : ""}<span class="whatsapp-kit-chipline__text"${ltr ? ' dir="ltr"' : ' dir="auto"'}>${ui.escape(text)}</span>`;
	const classes = `whatsapp-kit-chipline${tone ? ` whatsapp-kit-tone--${ui.tone_for_colour(tone)}` : ""}${cls ? ` ${cls}` : ""}`;
	const attrs = title ? ` title="${ui.escape(title)}"` : "";
	if (href) return `<a class="${classes}" href="${ui.escape(ui.safe_url(href))}"${attrs}>${body}</a>`;
	return `<span class="${classes}"${attrs}>${body}</span>`;
}

/** A row of chips, empty ones dropped. */
export function chips(list = []) {
	const html = list.map((c) => (typeof c === "string" ? c : icon_text_chip_html(c))).filter(Boolean).join("");
	return html ? `<span class="whatsapp-kit-chipline-row">${html}</span>` : "";
}

/**
 * Fact tile — label above, value below, icon in the corner. The "quick facts" grid of the
 * document drawer (reference image 01) is a list of these.
 */
export function fact_tile_html({ label, value, icon, ltr = false, tone, text = false } = {}) {
	if (value == null || value === "") return "";
	const is_html = !text && typeof value === "string" && /^\s*</.test(value);
	return `<div class="whatsapp-kit-fact${tone ? ` whatsapp-kit-fact--${ui.tone_for_colour(tone)}` : ""}">
		<div class="whatsapp-kit-fact__head">${icon ? `<span class="whatsapp-kit-fact__icon" aria-hidden="true">${ui.icon(icon, "sm")}</span>` : ""}<span class="whatsapp-kit-fact__label">${ui.escape(label || "")}</span></div>
		<div class="whatsapp-kit-fact__value"${ltr ? ' dir="ltr"' : ' dir="auto"'}>${is_html ? value : ui.escape(value)}</div>
	</div>`;
}

/** Progress bar with the percentage beside it (never colour alone — the number is always there). */
export function progress(percent, { tone, label } = {}) {
	const pct = Math.max(0, Math.min(100, cint(percent)));
	const t = ui.tone_for_colour(tone || (pct >= 100 ? "green" : pct >= 50 ? "blue" : pct > 0 ? "amber" : "gray"));
	return `<span class="whatsapp-kit-progress" role="img" aria-label="${ui.escape(label || __("{0}%", [pct]))}">
		<span class="whatsapp-kit-progress__track"><span class="whatsapp-kit-progress__bar whatsapp-kit-progress--${t}" style="inline-size:${pct}%"></span></span>
		<span class="whatsapp-kit-progress__value whatsapp-kit-tabular" dir="ltr">${pct}%</span>
	</span>`;
}

/** Star rating (Frappe stores 0–1) rendered as filled / empty stars plus the number. */
export function stars(value, { max = 5 } = {}) {
	const score = Math.round(flt(value) * max * 2) / 2;
	let html = "";
	for (let i = 1; i <= max; i++) {
		const state = score >= i ? "full" : score >= i - 0.5 ? "half" : "empty";
		html += `<span class="whatsapp-kit-stars__star whatsapp-kit-stars__star--${state}" aria-hidden="true">${ui.icon("es-line-star", "sm")}</span>`;
	}
	const text = flt(score).toFixed(1);
	return `<span class="whatsapp-kit-stars" role="img" aria-label="${ui.escape(__("{0} out of {1}", [text, max]))}">${html}<span class="whatsapp-kit-stars__value whatsapp-kit-tabular" dir="ltr">${ui.escape(text)}</span></span>`;
}

/** Key/value description list — the "additional details" block. A value starting with "<" is
 *  taken as markup the caller built; `text: true` marks one that is data (a message, an error)
 *  and is always escaped — what a sender wrote may well start with "<". */
export function definition_list_html(rows = [], { columns = 2 } = {}) {
	const body = rows
		.map((r) => {
			if (!r || r.value == null || r.value === "") return "";
			const is_html = !r.text && typeof r.value === "string" && /^\s*</.test(r.value);
			return `<div class="whatsapp-kit-definition-list__row${r.wide ? " whatsapp-kit-definition-list__row--wide" : ""}"><dt>${ui.escape(r.label || "")}</dt><dd>${is_html ? r.value : `<span dir="${r.ltr ? "ltr" : "auto"}">${ui.escape(r.value)}</span>`}</dd></div>`;
		})
		.filter(Boolean)
		.join("");
	return body ? `<dl class="whatsapp-kit-definition-list whatsapp-kit-definition-list--cols-${columns}">${body}</dl>` : "";
}

/**
 * Key / value rows — the drawer's data, one field per row: the key in a fixed column at the
 * start, its value beside it, a hairline between rows. A long value (`wide`) takes the row's
 * whole width under its key instead of squeezing into the value column.
 */
export function key_value_rows_html(rows = []) {
	const body = rows
		.map((r) => {
			if (!r || r.value == null || r.value === "") return "";
			const is_html = !r.text && typeof r.value === "string" && /^\s*</.test(r.value);
			const icon = r.icon ? `<span class="whatsapp-kit-key-value__icon" aria-hidden="true">${ui.icon(r.icon, "sm")}</span>` : "";
			const value = is_html ? r.value : `<span dir="${r.ltr ? "ltr" : "auto"}">${ui.escape(r.value)}</span>`;
			return `<div class="whatsapp-kit-key-value__row${r.wide ? " whatsapp-kit-key-value__row--wide" : ""}"><dt>${icon}<span>${ui.escape(r.label || "")}</span></dt><dd>${value}</dd></div>`;
		})
		.filter(Boolean)
		.join("");
	return body ? `<dl class="whatsapp-kit-key-value">${body}</dl>` : "";
}

/** Code / JSON preview with a copy button (`inline` truncates to one line). */
export function code_preview_html(value, { density = "card", language = "" } = {}) {
	let text = cstr(value);
	if (typeof value === "object") text = JSON.stringify(value, null, 2);
	if (!text) return "";
	if (density === "inline" || density === "compact") {
		const one = text.replace(/\s+/g, " ").trim();
		const cut = one.length > 60 ? `${one.slice(0, 60)}…` : one;
		return `<code class="whatsapp-kit-code whatsapp-kit-code--inline" dir="ltr" title="${ui.escape(one.slice(0, 400))}">${ui.escape(cut)}</code>`;
	}
	const id = ui.unique_dom_id("code");
	return `<div class="whatsapp-kit-code-block">
		<button type="button" class="whatsapp-kit-code-block__copy" data-copy="${id}" aria-label="${ui.escape(__("Copy"))}" title="${ui.escape(__("Copy"))}">${ui.icon("es-line-copy", "xs")}</button>
		<pre class="whatsapp-kit-code-block__pre" id="${id}" dir="ltr"${language ? ` data-language="${ui.escape(language)}"` : ""}><code>${ui.escape(text)}</code></pre>
	</div>`;
}

/** Delegated handler for every `whatsapp-kit-code-block` copy button on the page (bound once). */
export function bind_copy() {
	if (bind_copy.done) return;
	bind_copy.done = true;
	$(document).on("click", ".whatsapp-kit-code-block__copy", function () {
		const text = $(`#${$(this).data("copy")}`).text();
		const done = () => {
			whatsapp.ui.Toast && whatsapp.ui.Toast.success(__("Copied"));
			ui.announce(__("Copied"));
		};
		if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done);
		else frappe.utils.copy_to_clipboard(text) && done();
	});
}

/** Icon-only quick action buttons (call, WhatsApp, open, download) shown on entity rows/cards. */
export function actions(list = [], { size = "sm" } = {}) {
	const buttons = (list || [])
		.map((a, i) => {
			if (!a) return "";
			const label = a.label || a.title || "";
			const body = `${a.icon ? ui.icon(a.icon, size === "sm" ? "xs" : "sm") : ""}${a.show_label && label ? `<span class="whatsapp-kit-icon-button__label">${ui.escape(label)}</span>` : ""}`;
			const attrs = `class="whatsapp-kit-icon-button whatsapp-kit-icon-button--${size}${a.tone ? ` whatsapp-kit-tone--${ui.tone_for_colour(a.tone)}` : ""}" title="${ui.escape(label)}" aria-label="${ui.escape(label)}" data-action-index="${i}"`;
			if (a.href) return `<a ${attrs} href="${ui.escape(ui.safe_url(a.href))}"${a.target ? ` target="${ui.escape(a.target)}" rel="noopener"` : ""}>${body}</a>`;
			return `<button type="button" ${attrs}>${body}</button>`;
		})
		.filter(Boolean)
		.join("");
	return buttons ? `<span class="whatsapp-kit-icon-button-row">${buttons}</span>` : "";
}

/** Bind the handlers of `actions()` inside `$root` against the same spec list. */
export function bind_actions($root, list = [], doc) {
	$root.find("[data-action-index]").each(function () {
		const spec = list[cint($(this).data("action-index"))];
		if (!spec || typeof spec.on_click !== "function") return;
		$(this).on("click", (e) => {
			e.preventDefault();
			e.stopPropagation();
			spec.on_click(doc, e);
		});
	});
}

export default { avatar, thumb, icon_text_chip_html, chips, fact_tile_html, progress, stars, definition_list_html, code_preview_html, bind_copy, actions, bind_actions };

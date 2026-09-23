// sanad.ui.Render building blocks — the small pieces every renderer is assembled from: avatar,
// thumbnail, chip, fact tile, progress bar, stars, code preview. They are plain HTML builders
// (no state, no DOM), so a renderer is a pure function of its view model and every caller —
// drawer, list cell, card, timeline — gets the same piece at the same size.
//
// Colours are Espresso tokens only, layout is logical (RTL for free), every label is escaped.

import ui from "../_core/index.js";

/** Avatar: the record's image when there is one, else its initials, else a fieldtype icon. */
export function avatar({ image, initials, icon, tone = "gray", size = "md", alt = "" } = {}) {
	const cls = `sanad-avatar sanad-avatar--${size} sanad-tone--${ui.tone(tone)}`;
	if (image) {
		return `<span class="${cls} sanad-avatar--image"><img src="${ui.escape(image)}" alt="${ui.escape(alt)}" loading="lazy"></span>`;
	}
	if (initials) {
		return `<span class="${cls}" aria-hidden="true">${ui.escape(initials)}</span>`;
	}
	return `<span class="${cls} sanad-avatar--icon" aria-hidden="true">${ui.icon(icon || "es-line-filetype", size === "sm" ? "sm" : "md")}</span>`;
}

/** Image thumbnail with a fixed box (gallery, item cards, attachment previews). */
export function thumb({ src, alt = "", size = "md", icon = "es-line-image" } = {}) {
	const cls = `sanad-thumb sanad-thumb--${size}`;
	if (!src) return `<span class="${cls} sanad-thumb--empty" aria-hidden="true">${ui.icon(icon, "md")}</span>`;
	return `<span class="${cls}"><img src="${ui.escape(src)}" alt="${ui.escape(alt)}" loading="lazy"></span>`;
}

/** Small icon + text pair used for secondary facts (phone, branch, group, date). */
export function chip({ icon, text, title, ltr = false, tone, href, cls = "" } = {}) {
	if (text == null || text === "") return "";
	const body = `${icon ? `<span class="sanad-chipline__icon" aria-hidden="true">${ui.icon(icon, "xs")}</span>` : ""}<span class="sanad-chipline__text"${ltr ? ' dir="ltr"' : ' dir="auto"'}>${ui.escape(text)}</span>`;
	const classes = `sanad-chipline${tone ? ` sanad-tone--${ui.tone(tone)}` : ""}${cls ? ` ${cls}` : ""}`;
	const attrs = title ? ` title="${ui.escape(title)}"` : "";
	if (href) return `<a class="${classes}" href="${ui.escape(href)}"${attrs}>${body}</a>`;
	return `<span class="${classes}"${attrs}>${body}</span>`;
}

/** A row of chips, empty ones dropped. */
export function chips(list = []) {
	const html = list.map((c) => (typeof c === "string" ? c : chip(c))).filter(Boolean).join("");
	return html ? `<span class="sanad-chipline-row">${html}</span>` : "";
}

/**
 * Fact tile — label above, value below, icon in the corner. The "quick facts" grid of the
 * document drawer (reference image 01) is a list of these.
 */
export function fact({ label, value, icon, ltr = false, tone } = {}) {
	if (value == null || value === "") return "";
	const is_html = typeof value === "string" && /^\s*</.test(value);
	return `<div class="sanad-fact${tone ? ` sanad-fact--${ui.tone(tone)}` : ""}">
		<div class="sanad-fact__head">${icon ? `<span class="sanad-fact__icon" aria-hidden="true">${ui.icon(icon, "sm")}</span>` : ""}<span class="sanad-fact__label">${ui.escape(label || "")}</span></div>
		<div class="sanad-fact__value"${ltr ? ' dir="ltr"' : ' dir="auto"'}>${is_html ? value : ui.escape(value)}</div>
	</div>`;
}

/** Progress bar with the percentage beside it (never colour alone — the number is always there). */
export function progress(percent, { tone, label } = {}) {
	const pct = Math.max(0, Math.min(100, cint(percent)));
	const t = ui.tone(tone || (pct >= 100 ? "green" : pct >= 50 ? "blue" : pct > 0 ? "amber" : "gray"));
	return `<span class="sanad-progress" role="img" aria-label="${ui.escape(label || __("{0}%", [pct]))}">
		<span class="sanad-progress__track"><span class="sanad-progress__bar sanad-progress--${t}" style="inline-size:${pct}%"></span></span>
		<span class="sanad-progress__value sanad-tabular" dir="ltr">${pct}%</span>
	</span>`;
}

/** Star rating (Frappe stores 0–1) rendered as filled / empty stars plus the number. */
export function stars(value, { max = 5 } = {}) {
	const score = Math.round(flt(value) * max * 2) / 2;
	let html = "";
	for (let i = 1; i <= max; i++) {
		const state = score >= i ? "full" : score >= i - 0.5 ? "half" : "empty";
		html += `<span class="sanad-stars__star sanad-stars__star--${state}" aria-hidden="true">${ui.icon("es-line-star", "sm")}</span>`;
	}
	const text = flt(score).toFixed(1);
	return `<span class="sanad-stars" role="img" aria-label="${ui.escape(__("{0} out of {1}", [text, max]))}">${html}<span class="sanad-stars__value sanad-tabular" dir="ltr">${ui.escape(text)}</span></span>`;
}

/** Key/value description list — the "additional details" block. */
export function dl(rows = [], { columns = 2 } = {}) {
	const body = rows
		.map((r) => {
			if (!r || r.value == null || r.value === "") return "";
			const is_html = typeof r.value === "string" && /^\s*</.test(r.value);
			return `<div class="sanad-dl__row${r.wide ? " sanad-dl__row--wide" : ""}"><dt>${ui.escape(r.label || "")}</dt><dd${r.ltr ? ' dir="ltr"' : ' dir="auto"'}>${is_html ? r.value : ui.escape(r.value)}</dd></div>`;
		})
		.filter(Boolean)
		.join("");
	return body ? `<dl class="sanad-dl sanad-dl--cols-${columns}">${body}</dl>` : "";
}

/** Code / JSON preview with a copy button (`inline` truncates to one line). */
export function code(value, { density = "card", language = "" } = {}) {
	let text = cstr(value);
	if (typeof value === "object") text = JSON.stringify(value, null, 2);
	if (!text) return "";
	if (density === "inline" || density === "compact") {
		const one = text.replace(/\s+/g, " ").trim();
		const cut = one.length > 60 ? `${one.slice(0, 60)}…` : one;
		return `<code class="sanad-code sanad-code--inline" dir="ltr" title="${ui.escape(one.slice(0, 400))}">${ui.escape(cut)}</code>`;
	}
	const id = ui.uid("code");
	return `<div class="sanad-code-block">
		<button type="button" class="sanad-code-block__copy" data-copy="${id}" aria-label="${ui.escape(__("Copy"))}" title="${ui.escape(__("Copy"))}">${ui.icon("es-line-copy", "xs")}</button>
		<pre class="sanad-code-block__pre" id="${id}" dir="ltr"${language ? ` data-language="${ui.escape(language)}"` : ""}><code>${ui.escape(text)}</code></pre>
	</div>`;
}

/** Delegated handler for every `sanad-code-block` copy button on the page (bound once). */
export function bind_copy() {
	if (bind_copy.done) return;
	bind_copy.done = true;
	$(document).on("click", ".sanad-code-block__copy", function () {
		const text = $(`#${$(this).data("copy")}`).text();
		const done = () => {
			sanad.ui.Toast && sanad.ui.Toast.success(__("Copied"));
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
			const body = `${a.icon ? ui.icon(a.icon, size === "sm" ? "xs" : "sm") : ""}${a.show_label && label ? `<span class="sanad-iconbtn__label">${ui.escape(label)}</span>` : ""}`;
			const attrs = `class="sanad-iconbtn sanad-iconbtn--${size}${a.tone ? ` sanad-tone--${ui.tone(a.tone)}` : ""}" title="${ui.escape(label)}" aria-label="${ui.escape(label)}" data-action-index="${i}"`;
			if (a.href) return `<a ${attrs} href="${ui.escape(a.href)}"${a.target ? ` target="${ui.escape(a.target)}" rel="noopener"` : ""}>${body}</a>`;
			return `<button type="button" ${attrs}>${body}</button>`;
		})
		.filter(Boolean)
		.join("");
	return buttons ? `<span class="sanad-iconbtn-row">${buttons}</span>` : "";
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

export default { avatar, thumb, chip, chips, fact, progress, stars, dl, code, bind_copy, actions, bind_actions };

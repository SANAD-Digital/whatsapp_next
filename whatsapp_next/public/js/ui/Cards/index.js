// sanad.ui.Cards — the design prototype's card vocabulary (`docs/component/Cards.dc.html`),
// ported as a real component.
//
// The prototype does not draw a screen full of numbers by inventing a layout for it. It composes
// one out of a fixed set of card kinds, and every screen that shows numbers — the home console,
// the queue, the functions centre — is the same four or five kinds arranged differently. That is
// what makes them look like one product. This is that set:
//
//   `stat`   a reading on one line: a dot, a label, the figure, a note, an icon tile at the end.
//   `kpi`    a reading with room: the label and its tile on top, a large figure, a note and an
//            optional sparkline at the foot.
//   `panel`  a titled surface holding rows — each row a label, an optional second line, a figure
//            and an optional badge. What a list of stages, devices or campaigns is drawn with.
//   `alert`  a tinted strip: what is wrong, what it costs, and the verb that ends it.
//
// Sections carry the grid. `min` is the narrowest a card in that section may be, and the columns
// fall out of `repeat(auto-fit, minmax(min(100%, min), 1fr))` — the prototype's own rule, which is
// why a section of six readings becomes three and three on a laptop and one column on a phone
// without a media query per screen.
//
// Geometry and density are the prototype's two scales, value for value. Colour comes from the
// palette, so a card takes the product's colours wherever the palette applies.

import ui from "../_core/index.js";
import { ico } from "../_kit/icons.js";

const esc = (v) => ui.escape(v == null ? "" : v);
const TONES = ["ok", "warn", "danger", "info", "muted", "pri"];
const tone_of = (t) => (TONES.includes(t) ? t : "muted");

/** A sparkline over a small series, on the prototype's own 60×18 box. */
function spark(series) {
	const values = (series || []).map((n) => Number(n) || 0);
	if (values.length < 2) return "";
	const min = Math.min(...values);
	const max = Math.max(...values);
	const span = max - min || 1;
	const points = values
		.map((v, i) => `${((i / (values.length - 1)) * 58 + 1).toFixed(1)},${(17 - ((v - min) / span) * 16).toFixed(1)}`)
		.join(" ");
	return `<svg class="wa-card__spark" width="56" height="18" viewBox="0 0 60 18" fill="none" aria-hidden="true"><polyline points="${points}" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" stroke-linecap="round"/></svg>`;
}

sanad.ui.Cards = class Cards {
	/**
	 * @param {object} opts
	 * @param {jQuery|HTMLElement} opts.wrapper
	 * @param {Array<Section>} opts.sections
	 * @param {"comfortable"|"compact"} [opts.density="comfortable"]
	 * @param {Object<string, Function>} [opts.handlers] — a card's `action` names one of these
	 *
	 * A Section is `{title?, sub?, min?, columns?, cards: Card[]}`.
	 * A Card is `{kind, key?, label, value?, note?, tone?, icon?, span?, series?, action?, args?,
	 * onClick?}`, plus per kind: `panel` takes `rows[]` and `foot?`; `alert` takes `cta?`.
	 */
	constructor(opts = {}) {
		this.opts = Object.assign({ density: "comfortable", sections: [], handlers: {} }, opts);
		this.$wrapper = $(this.opts.wrapper);
		this.render();
	}

	set_sections(sections) {
		this.opts.sections = sections || [];
		return this.render();
	}

	render() {
		this.$wrapper.empty().addClass("sanad-kit wa");
		this.$wrapper.toggleClass("wa--compact", this.opts.density === "compact");
		this.$el = $(`<div class="wa-cards wa-cards--${this.opts.density}"></div>`).appendTo(this.$wrapper);
		(this.opts.sections || []).forEach((section) => this.render_section(section));
		this.bind();
		return this;
	}

	render_section(section) {
		const min = cint(section.min) || 240;
		const $sec = $(`<section class="wa-cards__section"></section>`).appendTo(this.$el);
		if (section.title || section.sub) {
			$sec.append(`
				<header class="wa-cards__head">
					${section.title ? `<h3 class="wa-cards__title">${esc(section.title)}</h3>` : ""}
					${section.sub ? `<p class="wa-cards__sub">${esc(section.sub)}</p>` : ""}
				</header>`);
		}
		const $grid = $(`<div class="wa-cards__grid" style="--wa-cards-min:${min}px"></div>`).appendTo($sec);
		(section.cards || []).forEach((card) => $grid.append(this.card_html(card)));
	}

	card_html(card) {
		const kind = card.kind || "stat";
		const fn = this[`${kind}_html`];
		const body = typeof fn === "function" ? fn.call(this, card) : "";
		return body;
	}

	/** Common attributes: what makes a card clickable, and how wide it is. */
	shell(card, cls) {
		const clickable = !!(card.action || card.onClick);
		const span = cint(card.span) > 1 ? ` style="--wa-card-span:${cint(card.span)}"` : "";
		const tag = clickable ? "button" : "div";
		const attrs = clickable
			? ` type="button" data-action="${esc(card.action || "")}" data-key="${esc(card.key || "")}"`
			: "";
		return { tag, open: `<${tag} class="${cls}${clickable ? " wa-card--click" : ""}"${span}${attrs}>`, close: `</${tag}>` };
	}

	/** The icon tile a `stat` and a `kpi` wear at the end of their label. */
	tile(card) {
		if (!card.icon) return "";
		return `<span class="wa-card__tile wa-card__tile--${tone_of(card.tone)}" aria-hidden="true">${ico(card.icon, "sm")}</span>`;
	}

	stat_html(card) {
		const s = this.shell(card, `wa-card wa-card--stat wa-card--${tone_of(card.tone)}`);
		return `${s.open}
			<span class="wa-card__body">
				<span class="wa-card__line">
					${card.dot === false ? "" : `<span class="wa-card__dot" aria-hidden="true"></span>`}
					<span class="wa-card__label">${esc(card.label)}</span>
				</span>
				<span class="wa-card__value sanad-tabular" dir="${card.rtl ? "auto" : "ltr"}">${esc(card.value)}</span>
				${card.note ? `<span class="wa-card__note">${esc(card.note)}</span>` : ""}
			</span>
			${this.tile(card)}
		${s.close}`;
	}

	kpi_html(card) {
		const s = this.shell(card, `wa-card wa-card--kpi wa-card--${tone_of(card.tone)}`);
		return `${s.open}
			<span class="wa-card__top">
				<span class="wa-card__label">${esc(card.label)}</span>
				${this.tile(card)}
			</span>
			<span class="wa-card__figure sanad-tabular" dir="ltr">${esc(card.value)}</span>
			<span class="wa-card__foot">
				<span class="wa-card__note">${esc(card.note || "")}</span>
				${card.series ? spark(card.series) : ""}
			</span>
		${s.close}`;
	}

	panel_html(card) {
		const rows = (card.rows || [])
			.map((r) => {
				const click = r.action || r.onClick ? ` data-action="${esc(r.action || "")}" data-key="${esc(r.key || "")}"` : "";
				const tag = r.action || r.onClick ? "button" : "div";
				return `<${tag} type="button" class="wa-card__row${r.action || r.onClick ? " wa-card__row--click" : ""}"${click}>
					<span class="wa-card__row-main">
						${r.dot === false || !r.tone ? "" : `<span class="wa-card__dot wa-card__dot--${tone_of(r.tone)}" aria-hidden="true"></span>`}
						${r.avatar ? `<span class="wa-card__av" aria-hidden="true">${esc(r.avatar)}</span>` : ""}
						<span class="wa-card__row-text">
							<span class="wa-card__row-label">${esc(r.label)}</span>
							${r.sub ? `<span class="wa-card__row-sub">${esc(r.sub)}</span>` : ""}
						</span>
					</span>
					${r.bar != null ? `<span class="wa-card__bar"><span class="wa-card__bar-fill wa-card__bar-fill--${tone_of(r.tone)}" style="inline-size:${Math.max(0, Math.min(100, Number(r.bar) || 0)).toFixed(2)}%"></span></span>` : ""}
					${r.value != null ? `<span class="wa-card__row-value sanad-tabular" dir="ltr">${esc(r.value)}</span>` : ""}
					${r.badge ? `<span class="wa-badge wa-badge--${tone_of(r.badgeTone || r.tone)}">${esc(r.badge)}</span>` : ""}
				</${tag}>`;
			})
			.join("");
		const span = cint(card.span) > 1 ? ` style="--wa-card-span:${cint(card.span)}"` : "";
		return `<div class="wa-card wa-card--panel"${span}>
			${card.label || card.note ? `<div class="wa-card__phead"><span class="wa-card__ptitle">${esc(card.label)}</span>${card.note ? `<span class="wa-card__note">${esc(card.note)}</span>` : ""}</div>` : ""}
			<div class="wa-card__rows">${rows}</div>
			${card.foot ? `<div class="wa-card__pfoot">${esc(card.foot)}</div>` : ""}
		</div>`;
	}

	alert_html(card) {
		const tone = tone_of(card.tone || "warn");
		const cta =
			card.cta && (card.action || card.onClick)
				? `<button type="button" class="wa-btn wa-btn--${card.ctaStyle === "solid" ? "primary" : "secondary"} wa-btn--sm wa-card__cta" data-action="${esc(card.action || "")}" data-key="${esc(card.key || "")}">${esc(card.cta)}</button>`
				: "";
		const span = cint(card.span) > 1 ? ` style="--wa-card-span:${cint(card.span)}"` : "";
		return `<div class="wa-card wa-card--alert wa-card--${tone}" role="${tone === "danger" ? "alert" : "status"}"${span}>
			<span class="wa-card__tile wa-card__tile--${tone}" aria-hidden="true">${ico(card.icon || (tone === "danger" ? "error" : tone === "ok" ? "check" : "warn"), "sm")}</span>
			<span class="wa-card__body">
				<b class="wa-card__alert-label">${esc(card.label)}</b>
				${card.note ? `<span class="wa-card__note">${esc(card.note)}</span>` : ""}
			</span>
			${cta}
		</div>`;
	}

	/** A card or a row names its handler; the component never holds a closure per card. */
	bind() {
		const run = (e) => {
			const $t = $(e.currentTarget);
			const name = $t.attr("data-action");
			const fn = name && (this.opts.handlers || {})[name];
			if (typeof fn === "function") fn($t.attr("data-key") || null, e);
		};
		this.$el.on("click", "[data-action]", run);
	}

	destroy() {
		this.$el && this.$el.off("click");
		this.$wrapper && this.$wrapper.empty();
	}
};

export default sanad.ui.Cards;

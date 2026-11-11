// whatsapp.ui.Cards — the design prototype's card vocabulary (`docs/component/Cards.dc.html`),
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
import { inline_icon_html } from "../_kit/icons.js";

const escape_html = (v) => ui.escape(v == null ? "" : v);
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
	return `<svg class="whatsapp-card__spark" width="56" height="18" viewBox="0 0 60 18" fill="none" aria-hidden="true"><polyline points="${points}" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" stroke-linecap="round"/></svg>`;
}

whatsapp.ui.Cards = class Cards {
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
		this.$wrapper.empty().addClass("whatsapp-kit whatsapp");
		this.$wrapper.toggleClass("whatsapp--compact", this.opts.density === "compact");
		this.$el = $(`<div class="whatsapp-cards whatsapp-cards--${this.opts.density}"></div>`).appendTo(this.$wrapper);
		(this.opts.sections || []).forEach((section) => this.render_section(section));
		this.bind_card_actions();
		return this;
	}

	render_section(section) {
		const min = cint(section.min) || 240;
		const $sec = $(`<section class="whatsapp-cards__section"></section>`).appendTo(this.$el);
		if (section.title || section.sub) {
			$sec.append(`
				<header class="whatsapp-cards__head">
					${section.title ? `<h3 class="whatsapp-cards__title">${escape_html(section.title)}</h3>` : ""}
					${section.sub ? `<p class="whatsapp-cards__sub">${escape_html(section.sub)}</p>` : ""}
				</header>`);
		}
		const $grid = $(`<div class="whatsapp-cards__grid" style="--whatsapp-cards-min:${min}px"></div>`).appendTo($sec);
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
		const span = cint(card.span) > 1 ? ` style="--whatsapp-card-span:${cint(card.span)}"` : "";
		const tag = clickable ? "button" : "div";
		const attrs = clickable
			? ` type="button" data-action="${escape_html(card.action || "")}" data-key="${escape_html(card.key || "")}"`
			: "";
		return { tag, open: `<${tag} class="${cls}${clickable ? " whatsapp-card--click" : ""}"${span}${attrs}>`, close: `</${tag}>` };
	}

	/** The icon tile a `stat` and a `kpi` wear at the end of their label. */
	render_icon_tile(card) {
		if (!card.icon) return "";
		return `<span class="whatsapp-card__tile whatsapp-card__tile--${tone_of(card.tone)}" aria-hidden="true">${inline_icon_html(card.icon, "sm")}</span>`;
	}

	stat_html(card) {
		const s = this.shell(card, `whatsapp-card whatsapp-card--stat whatsapp-card--${tone_of(card.tone)}`);
		return `${s.open}
			<span class="whatsapp-card__body">
				<span class="whatsapp-card__line">
					${card.dot === false ? "" : `<span class="whatsapp-card__dot" aria-hidden="true"></span>`}
					<span class="whatsapp-card__label">${escape_html(card.label)}</span>
				</span>
				<span class="whatsapp-card__value whatsapp-kit-tabular" dir="${card.rtl ? "auto" : "ltr"}">${escape_html(card.value)}</span>
				${card.note ? `<span class="whatsapp-card__note">${escape_html(card.note)}</span>` : ""}
			</span>
			${this.render_icon_tile(card)}
		${s.close}`;
	}

	kpi_html(card) {
		const s = this.shell(card, `whatsapp-card whatsapp-card--kpi whatsapp-card--${tone_of(card.tone)}`);
		return `${s.open}
			<span class="whatsapp-card__top">
				<span class="whatsapp-card__label">${escape_html(card.label)}</span>
				${this.render_icon_tile(card)}
			</span>
			<span class="whatsapp-card__figure whatsapp-kit-tabular" dir="ltr">${escape_html(card.value)}</span>
			<span class="whatsapp-card__foot">
				<span class="whatsapp-card__note">${escape_html(card.note || "")}</span>
				${card.series ? spark(card.series) : ""}
			</span>
		${s.close}`;
	}

	panel_html(card) {
		const rows = (card.rows || [])
			.map((r) => {
				const click = r.action || r.onClick ? ` data-action="${escape_html(r.action || "")}" data-key="${escape_html(r.key || "")}"` : "";
				const tag = r.action || r.onClick ? "button" : "div";
				return `<${tag} type="button" class="whatsapp-card__row${r.action || r.onClick ? " whatsapp-card__row--click" : ""}"${click}>
					<span class="whatsapp-card__row-main">
						${r.dot === false || !r.tone ? "" : `<span class="whatsapp-card__dot whatsapp-card__dot--${tone_of(r.tone)}" aria-hidden="true"></span>`}
						${r.avatar ? `<span class="whatsapp-card__av" aria-hidden="true">${escape_html(r.avatar)}</span>` : ""}
						<span class="whatsapp-card__row-text">
							<span class="whatsapp-card__row-label">${escape_html(r.label)}</span>
							${r.sub ? `<span class="whatsapp-card__row-sub">${escape_html(r.sub)}</span>` : ""}
						</span>
					</span>
					${r.bar != null ? `<span class="whatsapp-card__bar"><span class="whatsapp-card__bar-fill whatsapp-card__bar-fill--${tone_of(r.tone)}" style="inline-size:${Math.max(0, Math.min(100, Number(r.bar) || 0)).toFixed(2)}%"></span></span>` : ""}
					${r.value != null ? `<span class="whatsapp-card__row-value whatsapp-kit-tabular" dir="ltr">${escape_html(r.value)}</span>` : ""}
					${r.badge ? `<span class="whatsapp-badge whatsapp-badge--${tone_of(r.badgeTone || r.tone)}">${escape_html(r.badge)}</span>` : ""}
				</${tag}>`;
			})
			.join("");
		const span = cint(card.span) > 1 ? ` style="--whatsapp-card-span:${cint(card.span)}"` : "";
		return `<div class="whatsapp-card whatsapp-card--panel"${span}>
			${card.label || card.note ? `<div class="whatsapp-card__phead"><span class="whatsapp-card__ptitle">${escape_html(card.label)}</span>${card.note ? `<span class="whatsapp-card__note">${escape_html(card.note)}</span>` : ""}</div>` : ""}
			<div class="whatsapp-card__rows">${rows}</div>
			${card.foot ? `<div class="whatsapp-card__pfoot">${escape_html(card.foot)}</div>` : ""}
		</div>`;
	}

	/**
	 * `html` — the prototype's own escape hatch (`kind: 'html'`). A screen that needs one
	 * composition the vocabulary does not have puts it in a card surface rather than inventing a
	 * surface of its own, so it still sits in the same grid, at the same radius, on the same
	 * border. Markup is the caller's and is not escaped: it is the caller's own, never a value.
	 */
	html_html(card) {
		const span = cint(card.span) > 1 ? ` style="--whatsapp-card-span:${cint(card.span)}"` : "";
		return `<div class="whatsapp-card whatsapp-card--html whatsapp-card--${tone_of(card.tone)}"${span}>${card.html || ""}</div>`;
	}

	alert_html(card) {
		const tone = tone_of(card.tone || "warn");
		const cta =
			card.cta && (card.action || card.onClick)
				? `<button type="button" class="whatsapp-button whatsapp-button--${card.ctaStyle === "solid" ? "primary" : "secondary"} whatsapp-button--sm whatsapp-card__cta" data-action="${escape_html(card.action || "")}" data-key="${escape_html(card.key || "")}">${escape_html(card.cta)}</button>`
				: "";
		const span = cint(card.span) > 1 ? ` style="--whatsapp-card-span:${cint(card.span)}"` : "";
		return `<div class="whatsapp-card whatsapp-card--alert whatsapp-card--${tone}" role="${tone === "danger" ? "alert" : "status"}"${span}>
			<span class="whatsapp-card__tile whatsapp-card__tile--${tone}" aria-hidden="true">${inline_icon_html(card.icon || (tone === "danger" ? "error" : tone === "ok" ? "check" : "warn"), "sm")}</span>
			<span class="whatsapp-card__body">
				<b class="whatsapp-card__alert-label">${escape_html(card.label)}</b>
				${card.note ? `<span class="whatsapp-card__note">${escape_html(card.note)}</span>` : ""}
			</span>
			${cta}
		</div>`;
	}

	/** A card or a row names its handler; the component never holds a closure per card. */
	bind_card_actions() {
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

export default whatsapp.ui.Cards;

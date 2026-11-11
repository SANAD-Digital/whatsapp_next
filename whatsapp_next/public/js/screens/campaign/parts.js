// The campaign builder's own vocabulary.
//
// A campaign is judged by four numbers before it has sent anything — how many people, how many
// messages, how fast they leave and how long that takes — and by five checks that say whether it
// can leave at all. Those numbers are worked out in one place here, so the header, the summary
// aside, the review step and the sticky bar can never disagree about them.
//
// Under the numbers are the four shapes every step is drawn with: a titled card, a labelled
// field, a reading and a check. They are the prototype's own (`docs/component/Wizard.dc.html`,
// `docs/component/Cards.dc.html`) and they are built from the kit's controls (`whatsapp-button`,
// `whatsapp-badge`, `whatsapp-segmented`), so the builder takes the product's palette wherever it is mounted.

frappe.provide("whatsapp_next.campaign");

(function () {
	const ui = whatsapp.ui;
	const campaign_builder = whatsapp_next.campaign;
	const escape_html = (v) => ui.escape(v);
	const format_integer = (v) => ui.format_integer(v);

	campaign_builder.escape_html = escape_html;
	campaign_builder.format_integer = format_integer;

	/** What the queue falls back to when neither the campaign nor Settings names a rate. */
	campaign_builder.DEFAULT_RATE = 20;

	// ---- the numbers ---------------------------------------------------------------------------

	campaign_builder.messages_of = (doc) => ((doc && doc.messages) || []).length;

	/** The rate this campaign will actually send at. */
	campaign_builder.rate_of = (doc, cap) => cint((doc || {}).messages_per_minute) || cint(cap) || campaign_builder.DEFAULT_RATE;

	/**
	 * `WhatsApp Settings.messages_per_minute` is the ceiling a campaign may not exceed
	 * (`whatsapp_campaign.check_rate_limit`), so the slider has to know it before it can be drawn.
	 * Asked once per session; a reader without the queue screen's permission simply gets the
	 * fallback ceiling and the server still enforces the real one.
	 */
	campaign_builder.limits = () => {
		if (!campaign_builder._limits) {
			campaign_builder._limits = ui
				.call("queue.get_limits", {}, { silent: true })
				.then((s) => ({ rate: cint(s && s.rate) || 60, plan_rate: cint(s && s.plan_rate) || 0 }))
				.catch(() => ({ rate: 60, plan_rate: 0 }));
		}
		return campaign_builder._limits;
	};

	/**
	 * What starting the campaign would cost and how long it would take.
	 *
	 * Every recipient receives every message, so the work is `recipients × messages`. The queue
	 * drains that at the rate — but the campaign also staggers each message by its own delay
	 * (`services/campaign_runner._materialize_recipients`), and a sequence whose delays add up to
	 * more than the queue needs is the slower of the two. The estimate says the later of them,
	 * which is why it can exceed "messages ÷ rate".
	 */
	campaign_builder.estimate = (doc, cap) => {
		const recipients = cint((doc || {}).total_recipients);
		const per = Math.max(1, campaign_builder.messages_of(doc));
		const rate = campaign_builder.rate_of(doc, cap);
		const total = recipients * per;
		const delay = ((doc || {}).messages || []).reduce((sum, m) => sum + cint(m.delay_seconds), 0);
		const by_rate = total && rate ? total / rate : 0;
		const by_delay = delay / 60;
		return {
			recipients,
			per_recipient: per,
			total,
			rate,
			minutes: total ? Math.max(1, Math.ceil(Math.max(by_rate, by_delay))) : 0,
		};
	};

	/** "49 min" · "2 h 10 min" — a span said the way a person says it. */
	campaign_builder.duration_text = (minutes) => {
		const n = cint(minutes);
		if (!n) return "—";
		if (n < 60) return __("{0} min", [format_integer(n)]);
		const hours = Math.floor(n / 60);
		const rest = n % 60;
		return rest ? __("{0} h {1} min", [format_integer(hours), format_integer(rest)]) : __("{0} h", [format_integer(hours)]);
	};

	/**
	 * The two counts every part of the screen says the same way.
	 *
	 * Arabic counts in six categories, not two, and `ui.plural` asks `Intl.PluralRules` for the
	 * right one — so "4 رسائل" and "220 رسالة" are both correct rather than both "رسائل". The
	 * forms are one English source string per category, told apart by the translation context, so
	 * the source stays one sentence and the translator fills the grammar.
	 */
	// A language without a "one" form of its own (English) takes the plain singular: the
	// untranslated context form is the plural source and read "1 recipients".
	const counted = (source, singular) => (n) =>
		ui.plural(cint(n), {
			one: (frappe._messages || {})[`${source}:one`] ? __(source, null, "one") : __(singular),
			two: __(source, null, "two"),
			few: __(source, null, "few"),
			many: __(source, null, "many"),
			other: __(source),
		});

	campaign_builder.recipients_text = counted("{0} recipients", "{0} recipient");
	campaign_builder.messages_text = counted("{0} messages", "{0} message");

	/**
	 * A stored datetime (system time zone) as the reader reads a moment: their date format, the
	 * hour and minute, in their own zone — "30-09-2026 · 14:05".
	 */
	campaign_builder.when_text = (value) => {
		if (!value) return "";
		const local = frappe.datetime.convert_to_user_tz(String(value));
		// isolated left to right: inside an Arabic sentence the date's dashes otherwise reorder it
		return `\u2066${frappe.datetime.str_to_user(local.slice(0, 10))} · ${local.slice(11, 16)}\u2069`;
	};

	/** "20 messages/minute" — the rate, said in full where there is room for it. */
	campaign_builder.rate_text = (rate) => __("{0} messages/minute", [format_integer(rate)]);

	// ---- the shapes ----------------------------------------------------------------------------

	/**
	 * A titled card: the icon that stands for the subject, the title, an optional note at the end
	 * of the rule, and the body. `collapsible` folds it — the advanced options are the one thing on
	 * the setup step a reader should be able to leave closed.
	 */
	campaign_builder.card_html = ({ key, icon, title, note, body = "", collapsible = false, open = true, cls = "" }) => `
		<section class="whatsapp-campaign-builder__card${collapsible ? " whatsapp-campaign-builder__card--fold" : ""}${cls ? ` ${cls}` : ""}" data-card="${escape_html(key || "")}"${collapsible ? ` data-open="${open ? 1 : 0}"` : ""}>
			<${collapsible ? "button type=\"button\"" : "header"} class="whatsapp-campaign-builder__card-head"${collapsible ? ` aria-expanded="${open}"` : ""}>
				${icon ? `<span class="whatsapp-campaign-builder__card-icon" aria-hidden="true">${ui.inline_icon_html(icon, "sm")}</span>` : ""}
				<span class="whatsapp-campaign-builder__card-title">${escape_html(title)}</span>
				${note ? `<span class="whatsapp-campaign-builder__card-note">${escape_html(note)}</span>` : ""}
				${collapsible ? `<span class="whatsapp-campaign-builder__card-caret" aria-hidden="true">${ui.inline_icon_html("caret", "sm")}</span>` : ""}
			</${collapsible ? "button" : "header"}>
			<div class="whatsapp-campaign-builder__card-body"${collapsible && !open ? " hidden" : ""}>${body}</div>
		</section>`;

	/**
	 * A labelled control, with the rule that explains it under the control and never beside it.
	 * The shell is the kit's own field (`whatsapp-field`), so a campaign's inputs are the same inputs
	 * every other screen of the product draws.
	 */
	campaign_builder.field_html = ({ id, label, required, control, hint, counter, wide }) => `
		<div class="whatsapp-field${wide ? " whatsapp-field--wide" : ""}">
			<label class="whatsapp-field__label" for="${escape_html(id)}">${escape_html(label)}${required ? ` <b class="whatsapp-field__req" aria-hidden="true">*</b>` : ""}</label>
			${control}
			${counter !== undefined ? `<span class="whatsapp-field__hint whatsapp-campaign-builder__counter whatsapp-kit-tabular" dir="ltr" data-counter="${escape_html(id)}">${escape_html(counter)}</span>` : ""}
			${hint ? `<span class="whatsapp-field__hint">${escape_html(hint)}</span>` : ""}
		</div>`;

	/** One reading of the campaign: an icon tile, what it is, and the figure. */
	campaign_builder.reading_tile_html = ({ icon, tone = "muted", label, value, sub }) => `
		<div class="whatsapp-campaign-builder__reading">
			<span class="whatsapp-campaign-builder__reading-icon whatsapp-campaign-builder__reading-icon--${escape_html(tone)}" aria-hidden="true">${ui.inline_icon_html(icon, "sm")}</span>
			<span class="whatsapp-campaign-builder__reading-text">
				<span class="whatsapp-campaign-builder__reading-label">${escape_html(label)}</span>
				<span class="whatsapp-campaign-builder__reading-value whatsapp-kit-tabular">${escape_html(value)}</span>
			</span>
			${sub ? `<span class="whatsapp-campaign-builder__reading-sub">${escape_html(sub)}</span>` : ""}
		</div>`;

	/**
	 * One check: the mark, what was checked, and — when it failed — what to do about it. A check
	 * that has not been run yet (an unsaved campaign) is a third state, not a silent pass.
	 */
	campaign_builder.check_row_html = ({ state = "todo", label, note, action, key }) => `
		<div class="whatsapp-campaign-builder__check whatsapp-campaign-builder__check--${escape_html(state)}" data-check="${escape_html(key || "")}">
			<span class="whatsapp-campaign-builder__check-mark" aria-hidden="true">${ui.inline_icon_html(state === "ok" ? "tick" : state === "bad" ? "x" : "clock", "xs")}</span>
			<span class="whatsapp-campaign-builder__check-text">
				<span class="whatsapp-campaign-builder__check-label">${escape_html(label)}</span>
				${note ? `<span class="whatsapp-campaign-builder__check-note">${escape_html(note)}</span>` : ""}
			</span>
			${action ? `<button type="button" class="whatsapp-campaign-builder__check-fix" data-fix="${escape_html(action.key)}">${escape_html(action.label)}</button>` : ""}
			<span class="whatsapp-kit-visually-hidden">${escape_html(state === "ok" ? __("Ready") : state === "bad" ? __("Needs attention") : __("Not checked yet"))}</span>
		</div>`;

	/** A tinted note — the prototype's one way of saying something the reader has not asked for. */
	campaign_builder.note_html = ({ tone = "info", icon = "info", title, text, cta }) => `
		<div class="whatsapp-campaign-builder__note whatsapp-campaign-builder__note--${escape_html(tone)}">
			<span class="whatsapp-campaign-builder__note-icon" aria-hidden="true">${ui.inline_icon_html(icon, "sm")}</span>
			<span class="whatsapp-campaign-builder__note-text">${title ? `<b class="whatsapp-campaign-builder__note-title">${escape_html(title)}</b>` : ""}${escape_html(text)}</span>
			${cta ? `<button type="button" class="whatsapp-campaign-builder__note-cta" data-note-cta="${escape_html(cta.key)}">${escape_html(cta.label)}</button>` : ""}
		</div>`;

	/** A key and its value, on one line — what a review and a recap are made of. */
	campaign_builder.key_value_line_html = ({ label, value, ltr, tone }) => `
		<div class="whatsapp-campaign-builder__pair">
			<span class="whatsapp-campaign-builder__pair-label">${escape_html(label)}</span>
			<span class="whatsapp-campaign-builder__pair-value${ltr ? " whatsapp-kit-tabular" : ""}${tone ? ` whatsapp-kit-tone--${escape_html(tone)}` : ""}"${ltr ? ' dir="ltr"' : ""}>${escape_html(value)}</span>
		</div>`;
})();

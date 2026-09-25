// The campaign builder's own vocabulary.
//
// A campaign is judged by four numbers before it has sent anything — how many people, how many
// messages, how fast they leave and how long that takes — and by five checks that say whether it
// can leave at all. Those numbers are worked out in one place here, so the header, the summary
// aside, the review step and the sticky bar can never disagree about them.
//
// Under the numbers are the four shapes every step is drawn with: a titled card, a labelled
// field, a reading and a check. They are the prototype's own (`docs/component/Wizard.dc.html`,
// `docs/component/Cards.dc.html`) and they are built from the kit's controls (`wa-btn`,
// `wa-badge`, `wa-seg`), so the builder takes the product's palette wherever it is mounted.

frappe.provide("whatsapp_next.campaign");

(function () {
	const ui = sanad.ui;
	const C = whatsapp_next.campaign;
	const esc = (v) => ui.escape(v);
	const fmt_int = (v) => ui.format_int(v);

	C.esc = esc;
	C.fmt_int = fmt_int;

	/** What the queue falls back to when neither the campaign nor Settings names a rate. */
	C.DEFAULT_RATE = 20;

	// ---- the numbers ---------------------------------------------------------------------------

	C.messages_of = (doc) => ((doc && doc.messages) || []).length;

	/** The rate this campaign will actually send at. */
	C.rate_of = (doc, cap) => cint((doc || {}).messages_per_minute) || cint(cap) || C.DEFAULT_RATE;

	/**
	 * `WhatsApp Settings.messages_per_minute` is the ceiling a campaign may not exceed
	 * (`whatsapp_campaign.check_rate_limit`), so the slider has to know it before it can be drawn.
	 * Asked once per session; a reader without the queue screen's permission simply gets the
	 * fallback ceiling and the server still enforces the real one.
	 */
	C.limits = () => {
		if (!C._limits) {
			C._limits = ui
				.call("queue.get_limits", {}, { silent: true })
				.then((s) => ({ rate: cint(s && s.rate) || 60, plan_rate: cint(s && s.plan_rate) || 0 }))
				.catch(() => ({ rate: 60, plan_rate: 0 }));
		}
		return C._limits;
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
	C.estimate = (doc, cap) => {
		const recipients = cint((doc || {}).total_recipients);
		const per = Math.max(1, C.messages_of(doc));
		const rate = C.rate_of(doc, cap);
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
	C.dur_text = (minutes) => {
		const n = cint(minutes);
		if (!n) return "—";
		if (n < 60) return __("{0} min", [fmt_int(n)]);
		const hours = Math.floor(n / 60);
		const rest = n % 60;
		return rest ? __("{0} h {1} min", [fmt_int(hours), fmt_int(rest)]) : __("{0} h", [fmt_int(hours)]);
	};

	/**
	 * The two counts every part of the screen says the same way.
	 *
	 * Arabic counts in six categories, not two, and `ui.plural` asks `Intl.PluralRules` for the
	 * right one — so "4 رسائل" and "220 رسالة" are both correct rather than both "رسائل". The
	 * forms are one English source string per category, told apart by the translation context, so
	 * the source stays one sentence and the translator fills the grammar.
	 */
	const counted = (source) => (n) =>
		ui.plural(cint(n), {
			one: __(source, null, "one"),
			two: __(source, null, "two"),
			few: __(source, null, "few"),
			many: __(source, null, "many"),
			other: __(source),
		});

	C.recipients_text = counted("{0} recipients");
	C.messages_text = counted("{0} messages");

	/** "20 messages/minute" — the rate, said in full where there is room for it. */
	C.rate_text = (rate) => __("{0} messages/minute", [fmt_int(rate)]);

	// ---- the shapes ----------------------------------------------------------------------------

	/**
	 * A titled card: the icon that stands for the subject, the title, an optional note at the end
	 * of the rule, and the body. `collapsible` folds it — the advanced options are the one thing on
	 * the setup step a reader should be able to leave closed.
	 */
	C.card = ({ key, icon, title, note, body = "", collapsible = false, open = true, cls = "" }) => `
		<section class="wa-cb__card${collapsible ? " wa-cb__card--fold" : ""}${cls ? ` ${cls}` : ""}" data-card="${esc(key || "")}"${collapsible ? ` data-open="${open ? 1 : 0}"` : ""}>
			<${collapsible ? "button type=\"button\"" : "header"} class="wa-cb__card-head"${collapsible ? ` aria-expanded="${open}"` : ""}>
				${icon ? `<span class="wa-cb__card-icon" aria-hidden="true">${ui.ico(icon, "sm")}</span>` : ""}
				<span class="wa-cb__card-title">${esc(title)}</span>
				${note ? `<span class="wa-cb__card-note">${esc(note)}</span>` : ""}
				${collapsible ? `<span class="wa-cb__card-caret" aria-hidden="true">${ui.ico("caret", "sm")}</span>` : ""}
			</${collapsible ? "button" : "header"}>
			<div class="wa-cb__card-body"${collapsible && !open ? " hidden" : ""}>${body}</div>
		</section>`;

	/**
	 * A labelled control, with the rule that explains it under the control and never beside it.
	 * The shell is the kit's own field (`wa-field`), so a campaign's inputs are the same inputs
	 * every other screen of the product draws.
	 */
	C.field = ({ id, label, required, control, hint, counter, wide }) => `
		<div class="wa-field${wide ? " wa-field--wide" : ""}">
			<label class="wa-field__label" for="${esc(id)}">${esc(label)}${required ? ` <b class="wa-field__req" aria-hidden="true">*</b>` : ""}</label>
			${control}
			${counter !== undefined ? `<span class="wa-field__hint wa-cb__counter sanad-tabular" dir="ltr" data-counter="${esc(id)}">${esc(counter)}</span>` : ""}
			${hint ? `<span class="wa-field__hint">${esc(hint)}</span>` : ""}
		</div>`;

	/** One reading of the campaign: an icon tile, what it is, and the figure. */
	C.reading = ({ icon, tone = "muted", label, value, sub }) => `
		<div class="wa-cb__reading">
			<span class="wa-cb__reading-icon wa-cb__reading-icon--${esc(tone)}" aria-hidden="true">${ui.ico(icon, "sm")}</span>
			<span class="wa-cb__reading-text">
				<span class="wa-cb__reading-label">${esc(label)}</span>
				<span class="wa-cb__reading-value sanad-tabular">${esc(value)}</span>
			</span>
			${sub ? `<span class="wa-cb__reading-sub">${esc(sub)}</span>` : ""}
		</div>`;

	/**
	 * One check: the mark, what was checked, and — when it failed — what to do about it. A check
	 * that has not been run yet (an unsaved campaign) is a third state, not a silent pass.
	 */
	C.check = ({ state = "todo", label, note, action, key }) => `
		<div class="wa-cb__check wa-cb__check--${esc(state)}" data-check="${esc(key || "")}">
			<span class="wa-cb__check-mark" aria-hidden="true">${ui.ico(state === "ok" ? "tick" : state === "bad" ? "x" : "clock", "xs")}</span>
			<span class="wa-cb__check-text">
				<span class="wa-cb__check-label">${esc(label)}</span>
				${note ? `<span class="wa-cb__check-note">${esc(note)}</span>` : ""}
			</span>
			${action ? `<button type="button" class="wa-cb__check-fix" data-fix="${esc(action.key)}">${esc(action.label)}</button>` : ""}
			<span class="sanad-visually-hidden">${esc(state === "ok" ? __("Ready") : state === "bad" ? __("Needs attention") : __("Not checked yet"))}</span>
		</div>`;

	/** A tinted note — the prototype's one way of saying something the reader has not asked for. */
	C.note = ({ tone = "info", icon = "info", title, text, cta }) => `
		<div class="wa-cb__note wa-cb__note--${esc(tone)}">
			<span class="wa-cb__note-icon" aria-hidden="true">${ui.ico(icon, "sm")}</span>
			<span class="wa-cb__note-text">${title ? `<b class="wa-cb__note-title">${esc(title)}</b>` : ""}${esc(text)}</span>
			${cta ? `<button type="button" class="wa-cb__note-cta" data-note-cta="${esc(cta.key)}">${esc(cta.label)}</button>` : ""}
		</div>`;

	/** A key and its value, on one line — what a review and a recap are made of. */
	C.pair = ({ label, value, ltr, tone }) => `
		<div class="wa-cb__pair">
			<span class="wa-cb__pair-label">${esc(label)}</span>
			<span class="wa-cb__pair-value${ltr ? " sanad-tabular" : ""}${tone ? ` sanad-tone--${esc(tone)}` : ""}"${ltr ? ' dir="ltr"' : ""}>${esc(value)}</span>
		</div>`;
})();

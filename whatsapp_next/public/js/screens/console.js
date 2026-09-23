// The operations console — the one visual language for every screen that watches something
// running (Queue, Campaigns, the campaign form). The card and its grid live in
// `public/scss/screens/_console.scss`; this file is the markup those screens share, so a metric
// cell is written once and every console reads the same: a small capital label, the number that
// answers the question, and the line that qualifies it.

frappe.provide("whatsapp_next.console");

(function () {
	const ui = sanad.ui;
	const K = whatsapp_next.console;

	/**
	 * One cell of the metric row. `value` and `sub` are HTML (the caller escapes them, because a
	 * cell may carry a button or a bar); `label` is plain text.
	 */
	K.metric = (label, value, sub, opts = {}) => `
		<div class="wa-ops__metric${opts.wide ? " wa-ops__metric--wide" : ""}${opts.modifier ? ` wa-ops__metric--${opts.modifier}` : ""}">
			<span class="wa-ops__label">${ui.escape(label)}</span>
			<span class="wa-ops__value${opts.tone ? ` sanad-tone--${opts.tone}` : ""} sanad-tabular">${value}</span>
			<span class="wa-ops__sub">${sub || "&nbsp;"}</span>
		</div>`;

	/**
	 * The first cell of every console: what the screen is doing right now, stated as a word and
	 * not as a colour, with the verb that changes it beside it — never floating above the screen.
	 */
	K.state_metric = ({ label, state, tone = "gray", pulse = false, sub = "", verbs = "" }) => `
		<div class="wa-ops__metric wa-ops__metric--state">
			<span class="wa-ops__label">${ui.escape(label)}</span>
			<div class="wa-ops__state-row">
				<span class="wa-ops__state sanad-tone--${tone}">
					${pulse ? '<span class="wa-ops__pulse" aria-hidden="true"></span>' : ""}${ui.escape(state)}
				</span>
				${verbs}
			</div>
			<span class="wa-ops__sub">${sub || "&nbsp;"}</span>
		</div>`;
})();

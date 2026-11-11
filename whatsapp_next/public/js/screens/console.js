// The operations console — the one visual language for every screen that watches something
// running (Queue, Campaigns, the campaign form). The card and its grid live in
// `public/scss/screens/_console.scss`; this file is the markup those screens share, so a metric
// cell is written once and every console reads the same: a small capital label, the number that
// answers the question, and the line that qualifies it.

frappe.provide("whatsapp_next.console");

(function () {
	const ui = whatsapp.ui;
	const K = whatsapp_next.console;

	/**
	 * One cell of the metric row. `value` and `sub` are HTML (the caller escapes them, because a
	 * cell may carry a button or a bar); `label` is plain text.
	 */
	K.metric = (label, value, sub, opts = {}) => `
		<div class="whatsapp-operations-console__metric${opts.wide ? " whatsapp-operations-console__metric--wide" : ""}${opts.modifier ? ` whatsapp-operations-console__metric--${opts.modifier}` : ""}">
			<span class="whatsapp-operations-console__label">${ui.escape(label)}</span>
			<span class="whatsapp-operations-console__value${opts.tone ? ` whatsapp-kit-tone--${opts.tone}` : ""} whatsapp-kit-tabular">${value}</span>
			<span class="whatsapp-operations-console__sub">${sub || "&nbsp;"}</span>
		</div>`;

	/**
	 * The first cell of every console: what the screen is doing right now, stated as a word and
	 * not as a colour, with the verb that changes it beside it — never floating above the screen.
	 */
	K.state_metric = ({ label, state, tone = "gray", pulse = false, sub = "", verbs = "" }) => `
		<div class="whatsapp-operations-console__metric whatsapp-operations-console__metric--state">
			<span class="whatsapp-operations-console__label">${ui.escape(label)}</span>
			<div class="whatsapp-operations-console__state-row">
				<span class="whatsapp-operations-console__state whatsapp-kit-tone--${tone}">
					${pulse ? '<span class="whatsapp-operations-console__pulse" aria-hidden="true"></span>' : ""}${ui.escape(state)}
				</span>
				${verbs}
			</div>
			<span class="whatsapp-operations-console__sub">${sub || "&nbsp;"}</span>
		</div>`;
})();

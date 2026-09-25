// CampaignStepper — the four stages of building a campaign, drawn as the prototype's top bar
// (`docs/component/Wizard.dc.html`, the `topline` variant): a numbered disc per stage, the label
// beside it, and the rule between two discs filled as far as the reader has got.
//
// A stage that has been reached is a button; one that has not is not, because a wizard that lets
// you jump to "Review" from an empty campaign is offering a dead step. The spoken progress line
// ("Step 2 of 4") is announced for a reader who cannot see the discs.

frappe.provide("whatsapp_next.campaign");

(function () {
	const ui = sanad.ui;
	const C = whatsapp_next.campaign;
	const esc = C.esc;

	C.STEPS = [
		{ key: "setup", label: () => __("Campaign setup") },
		{ key: "messages", label: () => __("Messages", null, "campaign") },
		{ key: "audience", label: () => __("Audience") },
		{ key: "review", label: () => __("Review and send") },
	];

	C.Stepper = class CampaignStepper {
		constructor({ wrapper, ctx }) {
			this.$wrapper = $(wrapper);
			this.ctx = ctx;
			this.render();
			this.$wrapper.on("click", ".wa-cb__wtab", (e) => {
				const index = cint($(e.currentTarget).attr("data-index"));
				this.ctx.go(index);
			});
		}

		render() {
			const current = this.ctx.step;
			const items = C.STEPS.map((step, i) => {
				const state = i < current ? "done" : i === current ? "current" : "todo";
				const errors = this.ctx.step_errors(i);
				return `
					<button type="button" class="wa-seg__opt wa-cb__wtab wa-cb__wtab--${state}" role="tab" id="wa-cb-tab-${i}" data-index="${i}" aria-selected="${state === "current"}" tabindex="${state === "current" ? 0 : -1}">
						<span class="wa-cb__wtab-mark" aria-hidden="true">${state === "done" && !errors ? ui.ico("tick", "xs") : `<span class="sanad-tabular" dir="ltr">${i + 1}</span>`}</span>
						<span class="wa-cb__wtab-label">${esc(step.label())}</span>
						${errors ? `<span class="wa-cb__step-flag sanad-tabular" dir="ltr" title="${esc(__("{0} to fix", [C.fmt_int(errors)]))}">${esc(C.fmt_int(errors))}</span>` : ""}
					</button>`;
			}).join("");

			// the kit's segmented control as a tab list: one track, one filled tab, arrow keys
			// between them — the four parts of a campaign are places to go, not stages to pass
			this.$wrapper.html(`
				<div class="wa-cb__wtabs">
					<div class="wa-seg wa-cb__wseg" role="tablist" aria-label="${esc(__("Campaign"))}">${items}</div>
				</div>`);
			this.$wrapper.off("keydown.wtabs").on("keydown.wtabs", ".wa-cb__wtab", (e) => {
				const keys = C.STEPS.map((_s, i) => i);
				const next = ui.roving_index(e, keys, cint($(e.currentTarget).attr("data-index")));
				if (next < 0) return;
				e.preventDefault();
				this.ctx.go(next);
				this.$wrapper.find(`[data-index="${next}"]`).trigger("focus");
			});
			return this;
		}
	};
})();

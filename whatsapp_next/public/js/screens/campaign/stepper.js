// CampaignStepper — the four stages of building a campaign, drawn as the prototype's top bar
// (`docs/component/Wizard.dc.html`, the `topline` variant): a numbered disc per stage, the label
// beside it, and the rule between two discs filled as far as the reader has got.
//
// A stage that has been reached is a button; one that has not is not, because a wizard that lets
// you jump to "Review" from an empty campaign is offering a dead step. The spoken progress line
// ("Step 2 of 4") is announced for a reader who cannot see the discs.

frappe.provide("whatsapp_next.campaign");

(function () {
	const ui = whatsapp.ui;
	const campaign_builder = whatsapp_next.campaign;
	const escape_html = campaign_builder.esc;

	campaign_builder.STEPS = [
		{ key: "setup", label: () => __("Campaign setup") },
		{ key: "messages", label: () => __("Messages", null, "campaign") },
		{ key: "audience", label: () => __("Audience") },
		{ key: "review", label: () => __("Review and send") },
	];

	campaign_builder.Stepper = class CampaignStepper {
		constructor({ wrapper, ctx }) {
			this.$wrapper = $(wrapper);
			this.ctx = ctx;
			this.render();
			this.$wrapper.on("click", ".whatsapp-campaign-builder__wtab", (e) => {
				const index = cint($(e.currentTarget).attr("data-index"));
				this.ctx.go_to_step(index);
			});
		}

		render() {
			const current = this.ctx.step;
			const items = campaign_builder.STEPS.map((step, i) => {
				const state = i < current ? "done" : i === current ? "current" : "todo";
				const errors = this.ctx.step_errors(i);
				return `
					<button type="button" class="whatsapp-segmented__opt whatsapp-campaign-builder__wtab whatsapp-campaign-builder__wtab--${state}" role="tab" id="whatsapp-campaign-builder-tab-${i}" data-index="${i}" aria-selected="${state === "current"}" tabindex="${state === "current" ? 0 : -1}">
						<span class="whatsapp-campaign-builder__wtab-mark" aria-hidden="true">${state === "done" && !errors ? ui.ico("tick", "xs") : `<span class="whatsapp-kit-tabular" dir="ltr">${i + 1}</span>`}</span>
						<span class="whatsapp-campaign-builder__wtab-label">${escape_html(step.label())}</span>
						${errors ? `<span class="whatsapp-campaign-builder__step-flag whatsapp-kit-tabular" dir="ltr" title="${escape_html(__("{0} to fix", [campaign_builder.fmt_int(errors)]))}">${escape_html(campaign_builder.fmt_int(errors))}</span>` : ""}
					</button>`;
			}).join("");

			// the kit's segmented control as a tab list: one track, one filled tab, arrow keys
			// between them — the four parts of a campaign are places to go, not stages to pass
			this.$wrapper.html(`
				<div class="whatsapp-campaign-builder__wtabs">
					<div class="whatsapp-segmented whatsapp-campaign-builder__wseg" role="tablist" aria-label="${escape_html(__("Campaign"))}">${items}</div>
				</div>`);
			this.$wrapper.off("keydown.wtabs").on("keydown.wtabs", ".whatsapp-campaign-builder__wtab", (e) => {
				const keys = campaign_builder.STEPS.map((_s, i) => i);
				const next = ui.roving_index(e, keys, cint($(e.currentTarget).attr("data-index")));
				if (next < 0) return;
				e.preventDefault();
				this.ctx.go_to_step(next);
				this.$wrapper.find(`[data-index="${next}"]`).trigger("focus");
			});
			return this;
		}
	};
})();

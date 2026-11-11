// ReadinessCheck — "can this campaign start?", answered before the reader presses.
//
// The list is the server's own answer (`campaigns.get_readiness`): the same five checks `start()`
// would apply, asked ahead of time rather than thrown back afterwards. On the building steps it
// is a row of four under the step's fields; on the review step it is the full list. The server returns facts — a device
// status, the index of a message and the code of what is wrong with it — and the sentence is
// written here, so it is written once and in the reader's language.
//
// A check the server has not been asked yet (an unsaved or edited campaign) is drawn as its own
// third state. A passed check and an unknown one must never look alike.

frappe.provide("whatsapp_next.campaign");

(function () {
	const campaign_builder = whatsapp_next.campaign;
	const campaign_helpers = whatsapp_next.campaigns;
	const escape_html = campaign_builder.escape_html;

	/** What is wrong with a message row, in the words of the person who wrote it. */
	const PROBLEM = {
		empty_body: () => __("no text"),
		no_attachment: () => __("no file"),
		no_question: () => __("no question"),
		few_options: () => __("needs at least two answers"),
	};

	/** The step each check belongs to — a failed check offers the way to fix it. */
	const STEP_OF = { device: 0, messages: 1, attachments: 1, variables: 1, audience: 2 };

	campaign_builder.Readiness = class ReadinessCheck {
		constructor({ wrapper, ctx, title, compact = false }) {
			this.$wrapper = $(wrapper);
			this.ctx = ctx;
			this.title = title || __("Readiness check");
			this.compact = compact;
			this.$wrapper.on("click", "[data-fix]", (e) => this.ctx.go_to_step(cint($(e.currentTarget).attr("data-fix"))));
			this.render();
		}

		/** One check, turned from the server's facts into a line a reader can act on. */
		render_check_line(check) {
			const fresh = this.ctx.readiness_is_fresh();
			const state = !fresh ? "todo" : check.ok ? "ok" : "bad";
			const label = {
				device: __("Device connection"),
				messages: __("Messages complete"),
				attachments: __("Attachments available"),
				variables: __("Variables valid"),
				audience: __("Audience ready"),
			}[check.key];
			return campaign_builder.check_row_html({
				key: check.key,
				state,
				label,
				note: state === "todo" ? __("Checked once the campaign is saved.") : this.describe_check_result(check),
				action: state === "bad" ? { key: STEP_OF[check.key], label: __("Fix") } : null,
			});
		}

		describe_check_result(check) {
			const name = (idx) => __("Message {0}", [campaign_builder.format_integer(idx)]);
			if (check.key === "device") {
				if (!check.device) return __("No device chosen.");
				const title = campaign_helpers.device_title(check.device) || check.device_name || check.device;
				if (check.disabled) return __("{0} is disabled.", [title]);
				return check.ok ? __("{0} is connected and ready to send.", [title]) : __("{0} is {1}.", [title, __(check.status || "")]);
			}
			if (check.key === "messages") {
				if (!cint(check.count)) return __("No message yet.");
				const first = (check.incomplete || [])[0];
				if (first) {
					const why = (PROBLEM[first.problem] || (() => first.problem))();
					const more = (check.incomplete || []).length - 1;
					return more > 0
						? __("{0}: {1}, and {2} more.", [name(first.idx), why, campaign_builder.format_integer(more)])
						: __("{0}: {1}.", [name(first.idx), why]);
				}
				return campaign_builder.messages_text(check.count);
			}
			if (check.key === "attachments") {
				const first = (check.missing || [])[0];
				return first ? __("{0}: the file is no longer there.", [name(first.idx)]) : __("All attachments are available.");
			}
			if (check.key === "variables") {
				const first = (check.invalid || [])[0];
				return first ? __("{0}: {1}", [name(first.idx), (first.errors || [])[0] || ""]) : __("No variable errors found.");
			}
			if (check.key === "audience") {
				if (!cint(check.count)) return __("No recipient yet.");
				const excluded = cint(check.excluded_unknown);
				return excluded
					? __("{0} chosen — {1} excluded as unknown numbers.", [campaign_builder.recipients_text(check.count), campaign_builder.format_integer(excluded)])
					: __("{0} chosen for sending.", [campaign_builder.recipients_text(check.count)]);
			}
			return "";
		}

		render() {
			const readiness = this.ctx.readiness;
			const all = (readiness && readiness.checks) || campaign_builder.Readiness.blank();
			// The four the design lists. Whether every message carries what its type needs is the
			// fifth thing the server checks, and it is shown only when it fails — a list that is
			// four ticks long when everything is right, and never silent when something is not.
			const checks = all.filter((c) => c.key !== "messages" || (this.ctx.readiness_is_fresh() && !c.ok));
			this.$wrapper.html(
				campaign_builder.card_html({
					key: "readiness",
					icon: "gear",
					title: this.title,
					body: `<div class="whatsapp-campaign-builder__checks${this.compact ? " whatsapp-campaign-builder__checks--row" : ""}">${checks.map((c) => this.render_check_line(c)).join("")}</div>`,
				})
			);
			return this;
		}

		/** Before the first answer: the five checks, all unknown — never all green. */
		static blank() {
			return ["device", "messages", "attachments", "variables", "audience"].map((key) => ({ key, ok: false }));
		}
	};
})();

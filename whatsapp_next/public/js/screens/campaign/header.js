// CampaignHeader — the card the campaign opens with: what this record is, what state it is in,
// and the four numbers that decide everything else (which device, how many messages, how many
// people, how long it takes). It is the same band in every mode, so the reader never loses the
// campaign's identity when the body below it changes from a wizard to a monitor.

frappe.provide("whatsapp_next.campaign");

(function () {
	const ui = sanad.ui;
	const C = whatsapp_next.campaign;
	const K = whatsapp_next.campaigns;
	const esc = C.esc;

	const TONE = { gray: "muted", blue: "info", green: "ok", orange: "warn", red: "danger" };

	C.Header = class CampaignHeader {
		constructor({ wrapper, ctx }) {
			this.$wrapper = $(wrapper);
			this.ctx = ctx;
			this.render();
		}

		/** The four readings, in the order the reader asks for them. */
		metrics() {
			const doc = this.ctx.doc;
			const e = this.ctx.estimate();
			return [
				{ icon: "device", label: __("Sending device"), value: K.device_title(doc.device) || __("Not chosen"), muted: !doc.device },
				{ icon: "chat", label: __("Message count"), value: C.messages_text(C.messages_of(doc)) },
				{ icon: "users", label: __("Recipient count"), value: C.recipients_text(doc.total_recipients) },
				{ icon: "clock", label: __("Estimated duration"), value: C.dur_text(e.minutes) },
			];
		}

		render() {
			const doc = this.ctx.doc;
			const tone = TONE[K.INDICATOR[doc.status]] || "muted";
			const cells = this.metrics()
				.map(
					(m) => `
					<div class="wa-cb__metric${m.muted ? " wa-cb__metric--muted" : ""}">
						<span class="wa-cb__metric-text">
							<span class="wa-cb__metric-label">${esc(m.label)}</span>
							<span class="wa-cb__metric-value">${esc(m.value)}</span>
						</span>
						<span class="wa-cb__metric-icon" aria-hidden="true">${ui.ico(m.icon, "sm")}</span>
					</div>`
				)
				.join("");

			this.$wrapper.html(`
				<header class="wa-cb__header">
					<div class="wa-cb__identity">
						<div class="wa-cb__identity-line">
							<h2 class="wa-cb__kicker">${esc(__("WhatsApp Campaign"))}</h2>
							${ui.badge(__(doc.status, null, "campaign"), tone)}
						</div>
						<p class="wa-cb__name" dir="auto">${esc(doc.campaign_name || doc.name || __("New campaign"))}</p>
					</div>
					<div class="wa-cb__metrics">${cells}</div>
				</header>`);
			return this;
		}
	};
})();

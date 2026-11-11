// CampaignHeader — the card the campaign opens with: what this record is, what state it is in,
// and the four numbers that decide everything else (which device, how many messages, how many
// people, how long it takes). It is the same band in every mode, so the reader never loses the
// campaign's identity when the body below it changes from a wizard to a monitor.

frappe.provide("whatsapp_next.campaign");

(function () {
	const ui = whatsapp.ui;
	const campaign_builder = whatsapp_next.campaign;
	const campaign_helpers = whatsapp_next.campaigns;
	const escape_html = campaign_builder.esc;

	const TONE = { gray: "muted", blue: "info", green: "ok", orange: "warn", red: "danger" };

	campaign_builder.Header = class CampaignHeader {
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
				{ icon: "device", label: __("Sending device"), value: campaign_helpers.device_title(doc.device) || __("Not chosen"), muted: !doc.device },
				{ icon: "chat", label: __("Message count"), value: campaign_builder.messages_text(campaign_builder.messages_of(doc)) },
				{ icon: "users", label: __("Recipient count"), value: campaign_builder.recipients_text(doc.total_recipients) },
				{ icon: "clock", label: __("Estimated duration"), value: campaign_builder.dur_text(e.minutes) },
			];
		}

		render() {
			const doc = this.ctx.doc;
			const tone = TONE[campaign_helpers.INDICATOR[doc.status]] || "muted";
			const cells = this.metrics()
				.map(
					(m) => `
					<div class="whatsapp-campaign-builder__metric${m.muted ? " whatsapp-campaign-builder__metric--muted" : ""}">
						<span class="whatsapp-campaign-builder__metric-text">
							<span class="whatsapp-campaign-builder__metric-label">${escape_html(m.label)}</span>
							<span class="whatsapp-campaign-builder__metric-value">${escape_html(m.value)}</span>
						</span>
						<span class="whatsapp-campaign-builder__metric-icon" aria-hidden="true">${ui.ico(m.icon, "sm")}</span>
					</div>`
				)
				.join("");

			this.$wrapper.html(`
				<header class="whatsapp-campaign-builder__header">
					<div class="whatsapp-campaign-builder__identity">
						<div class="whatsapp-campaign-builder__identity-line">
							<h2 class="whatsapp-campaign-builder__kicker">${escape_html(__("WhatsApp Campaign"))}</h2>
							${ui.badge(__(doc.status, null, "campaign"), tone)}
						</div>
						<p class="whatsapp-campaign-builder__name" dir="auto">${escape_html(doc.campaign_name || doc.name || __("New campaign"))}</p>
					</div>
					<div class="whatsapp-campaign-builder__metrics">${cells}</div>
				</header>`);
			return this;
		}
	};
})();

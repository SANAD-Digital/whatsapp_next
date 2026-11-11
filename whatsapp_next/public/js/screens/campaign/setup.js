// CampaignSetup — step 1. Who sends it, how fast, and when.
//
// Every control here writes straight to the document through `frm.set_value`, so Frappe's dirty
// state, validation and save are the ones doing the work; the step owns no copy of the campaign.
// Two of the four groups are not fields at all in Desk's sense:
//
//   The rate is a **slider with its cost beside it**. "Messages per Minute: 20" says nothing until
//   the reader knows what it buys, so the estimate is computed as the slider moves and the cap the
//   server enforces (`WhatsApp Settings.messages_per_minute`) is the slider's own maximum.
//
//   The send time is a **choice**, not a datetime field left empty. "Now" and "Schedule" are the
//   two things a campaign can do, and the date and time only exist inside the second of them.
//
// Advanced options are the design's three switches. Only the first of them — excluding unknown
// numbers — is a field of the campaign today; the other two are **shape only** and marked
// `data-design-only` here, because the screen was ported before the logic behind them was
// decided. They write nothing and are never read back. Nothing else on this step is decorative:
// every other control writes its own field.

frappe.provide("whatsapp_next.campaign");

(function () {
	const ui = whatsapp.ui;
	const campaign_builder = whatsapp_next.campaign;
	const escape_html = campaign_builder.escape_html;
	const NAME_MAX = 140;

	campaign_builder.Setup = class CampaignSetup {
		constructor({ wrapper, ctx }) {
			this.$wrapper = $(wrapper);
			this.ctx = ctx;
			this.render();
		}

		get frm() {
			return this.ctx.frm;
		}

		get doc() {
			return this.ctx.doc;
		}

		render() {
			// full width, every field in sight: the three identity fields share a row, the rate and
			// the send time stand side by side, and the switches make one row under them
			this.$wrapper.html(`<div class="whatsapp-campaign-builder__stack">${this.basic()}<div class="whatsapp-campaign-builder__two">${this.sending_rate_card_html()}${this.send_time_card_html()}</div>${this.advanced()}</div>`);
			this.mount_controls();
			this.bind_setup_controls();
			return this;
		}

		/**
		 * The device is a select of the devices the product knows (few, named, one of them the
		 * default); the date and the time are Frappe's own pickers — its calendar and its clock,
		 * which the reader knows from every other form — wearing the kit's field. The value reaches
		 * the document through `frm.set_value`, the same as every other control on this screen.
		 */
		mount_controls() {
			const frm = this.frm;
			const editable = this.ctx.can_edit_content();
			const $wrapper = this.$wrapper;
			this.$device = $wrapper.find('[data-field="device"]');

			this.fill_devices();
			this.$device.on("change", () => {
				const value = this.$device.val() || null;
				this.$device.attr("data-empty", value ? "false" : "true");
				if ((value || "") !== (this.doc.device || "")) frm.set_value("device", value);
			});

			// the date and the time are Frappe's own pickers (its calendar, its clock, its locale),
			// built unbound so drawing them never marks the form dirty, and dressed in the kit's field
			let ready = false;
			const control = (key, df) =>
				frappe.ui.form.make_control({
					parent: $wrapper.find(`[data-control="${key}"]`),
					df: Object.assign({ fieldname: `wa_cb_${key}`, read_only: editable ? 0 : 1 }, df),
					render_input: true,
					only_input: true,
				});
			// `scheduled_at` is stored in system time; the date and the clock show the reader's own
			const at = this.doc.scheduled_at ? frappe.datetime.convert_to_user_tz(this.doc.scheduled_at) : null;
			this.date = control("date", { fieldtype: "Date", placeholder: __("Choose the date"), change: () => ready && this.commit_when() });
			this.time = control("time", { fieldtype: "Time", placeholder: __("Choose the time"), change: () => ready && this.commit_when() });
			if (at) {
				this.date.set_value(String(at).slice(0, 10));
				this.time.set_value(String(at).slice(11, 19));
			}
			this.set_when_enabled(!!at && editable);
			window.setTimeout(() => (ready = true), 0);
		}

		/** The devices, by their own names — the chosen one stays listed even if it was disabled since. */
		fill_devices() {
			const $device_select = this.$device;
			const current = this.doc.device || "";
			$device_select.empty().append(`<option value="">${escape_html(__("Choose a device"))}</option>`);
			$device_select.attr("data-empty", current ? "false" : "true");
			if (current) $device_select.append(`<option value="${escape_html(current)}" selected>${escape_html(current)}</option>`);
			this.ctx.devices().then((rows) => {
				if (!$device_select.closest("body").length) return;
				$device_select.find("option[value!='']").remove();
				rows.filter((d) => !cint(d.disabled) || d.name === current).forEach((d) => {
					const label = `${d.device_name || d.name}${d.status && d.status !== "Connected" ? ` — ${__(d.status)}` : ""}`;
					$device_select.append(`<option value="${escape_html(d.name)}"${d.name === current ? " selected" : ""}>${escape_html(label)}</option>`);
				});
				if (current && !$device_select.find(`option[value="${current.replace(/"/g, '\\"')}"]`).length) {
					$device_select.append(`<option value="${escape_html(current)}" selected>${escape_html(current)}</option>`);
				}
				$device_select.val(current);
			});
		}

		set_when_enabled(on) {
			[this.date, this.time].forEach((c) => c && c.$input && c.$input.prop("disabled", !on));
			this.$wrapper.find(".whatsapp-campaign-builder__when-at").toggleClass("whatsapp-campaign-builder__when-at--off", !on);
		}

		// ---- the four groups -------------------------------------------------------------------

		basic() {
			const doc = this.doc;
			const name = doc.campaign_name || "";
			return campaign_builder.card_html({
				key: "basic",
				icon: "doc",
				title: __("Basic information"),
				body: `
					<div class="whatsapp-campaign-builder__grid">
						${campaign_builder.field_html({
							id: "whatsapp-campaign-builder-name",
							label: __("Campaign name"),
							required: true,
							counter: `${name.length}/${NAME_MAX}`,
							control: `<input id="whatsapp-campaign-builder-name" type="text" class="whatsapp-input" maxlength="${NAME_MAX}" value="${escape_html(name)}" data-field="campaign_name" placeholder="${escape_html(__("What is this campaign called?"))}">`,
						})}
						${campaign_builder.field_html({
							id: "whatsapp-campaign-builder-device",
							label: __("Sending device"),
							required: true,
							control: `
								<span class="whatsapp-affix whatsapp-affix--has-start">
									<span class="whatsapp-affix__in whatsapp-affix__in--start" aria-hidden="true">${ui.inline_icon_html("device", "sm")}</span>
									<select id="whatsapp-campaign-builder-device" class="whatsapp-input whatsapp-select" data-field="device" required></select>
								</span>`,
						})}
						${campaign_builder.field_html({
							id: "whatsapp-campaign-builder-description",
							label: __("Description"),
							control: `<textarea id="whatsapp-campaign-builder-description" class="whatsapp-textarea" rows="1" data-field="description" placeholder="${escape_html(__("For whoever opens the campaign later. It is never sent."))}">${escape_html(doc.description || "")}</textarea>`,
						})}
					</div>`,
			});
		}

		sending_rate_card_html() {
			const rate = campaign_builder.rate_of(this.doc, this.ctx.cap);
			return campaign_builder.card_html({
				key: "rate",
				icon: "bolt",
				title: __("Sending rate"),
				body: `
					<div class="whatsapp-campaign-builder__rate">
						<div class="whatsapp-campaign-builder__rate-input">
							<input type="number" class="whatsapp-input whatsapp-input--mono" id="whatsapp-campaign-builder-rate-n" min="1" max="${cint(this.ctx.cap) || 60}" value="${cint(rate)}" data-rate="number" aria-label="${escape_html(__("Messages per minute"))}">
							<span class="whatsapp-campaign-builder__rate-unit">${escape_html(__("messages/minute"))}</span>
						</div>
						<input type="range" class="whatsapp-campaign-builder__slider" min="1" max="${cint(this.ctx.cap) || 60}" value="${cint(rate)}" data-rate="slider" aria-label="${escape_html(__("Messages per minute"))}">
						<div class="whatsapp-campaign-builder__estimate" data-estimate>
							<span class="whatsapp-campaign-builder__estimate-icon" aria-hidden="true">${ui.inline_icon_html("clock", "sm")}</span>
							<span class="whatsapp-campaign-builder__estimate-text">
								<span class="whatsapp-campaign-builder__estimate-label">${escape_html(__("Estimated duration"))}</span>
								<span class="whatsapp-campaign-builder__estimate-value whatsapp-kit-tabular">${escape_html(campaign_builder.duration_text(this.ctx.estimate().minutes))}</span>
							</span>
						</div>
						<p class="whatsapp-campaign-builder__rate-hint" data-rate-hint>${escape_html(this.rate_hint(rate))}</p>
					</div>`,
			});
		}

		rate_hint(rate) {
			const cap = cint(this.ctx.cap);
			return cap
				? __("The slower the rate, the steadier the sending. The queue allows {0}/min at most.", [campaign_builder.format_integer(cap)])
				: __("The slower the rate, the steadier the sending.");
		}

		send_time_card_html() {
			const scheduled = !!this.doc.scheduled_at;
			const choice = (value, label, note) => `
				<label class="whatsapp-campaign-builder__choice">
					<input type="radio" name="whatsapp-campaign-builder-when" value="${value}"${(value === "scheduled") === scheduled ? " checked" : ""}>
					<span class="whatsapp-campaign-builder__choice-text">
						<span class="whatsapp-campaign-builder__choice-label">${escape_html(label)}</span>
						<span class="whatsapp-campaign-builder__choice-note">${escape_html(note)}</span>
					</span>
				</label>`;
			// the date and the time are Frappe's own pickers, in the kit's field with its icon
			const when_input = (kind, icon, label) => `
				<span class="whatsapp-affix whatsapp-affix--has-start whatsapp-campaign-builder__when-field" aria-label="${escape_html(label)}">
					<span class="whatsapp-affix__in whatsapp-affix__in--start" aria-hidden="true">${ui.inline_icon_html(icon, "sm")}</span>
					<span data-control="${kind}"></span>
				</span>`;
			return campaign_builder.card_html({
				key: "when",
				icon: "clock",
				title: __("Send time"),
				body: `
					<div class="whatsapp-campaign-builder__when">
						<div class="whatsapp-campaign-builder__when-choices" role="radiogroup" aria-label="${escape_html(__("Send time"))}">
							${choice("now", __("Now"), __("Sending starts as soon as you save and start the campaign."))}
							${choice("scheduled", __("Schedule", null, "campaign"), __("Set the date and time the sending begins."))}
						</div>
						<div class="whatsapp-campaign-builder__when-at">
							${when_input("date", "calendar", __("Choose the date"))}
							${when_input("time", "clock", __("Choose the time"))}
						</div>
						<p class="whatsapp-campaign-builder__when-error" role="alert" data-when-error hidden></p>
					</div>`,
			});
		}

		advanced() {
			const option = ({ field, design_only, on, label, note }) => `
				<div class="whatsapp-campaign-builder__option">
					<span class="whatsapp-campaign-builder__option-text">
						<span class="whatsapp-campaign-builder__option-label">${escape_html(label)}</span>
						<span class="whatsapp-campaign-builder__option-note">${escape_html(note)}</span>
					</span>
					<label class="whatsapp-toggle">
						<input type="checkbox"${field ? ` data-field="${escape_html(field)}"` : ' data-design-only="1"'}${on ? " checked" : ""}>
						<span class="whatsapp-toggle__track"></span>
						<span class="whatsapp-kit-visually-hidden">${escape_html(label)}</span>
					</label>
				</div>`;
			return campaign_builder.card_html({
				key: "advanced",
				icon: "gear",
				title: __("Advanced options"),
				collapsible: true,
				open: true,
				body: `
					<div class="whatsapp-campaign-builder__options">
						${option({
							field: "exclude_unknown_numbers",
							on: !!cint(this.doc.exclude_unknown_numbers),
							label: __("Exclude unknown numbers"),
							note: __("Do not send to numbers that are not in the WhatsApp account's contacts."),
						})}
						${option({
							field: "exclude_not_on_whatsapp",
							on: !!cint(this.doc.exclude_not_on_whatsapp),
							label: __("Skip numbers not on WhatsApp"),
							note: __("Check every recipient's number with WhatsApp before sending; numbers that are not on it are marked and skipped."),
						})}
						${option({
							design_only: true,
							on: false,
							label: __("Stop the campaign when errors rise"),
							note: __("Stop sending automatically once the error rate passes 10%."),
						})}
						${option({
							design_only: true,
							on: true,
							label: __("Retry messages that failed for a passing reason"),
							note: __("Send the messages that failed temporarily again after a short wait."),
						})}
					</div>`,
			});
		}

		// ---- what the controls do ---------------------------------------------------------------

		bind_setup_controls() {
			const frm = this.frm;
			const $wrapper = this.$wrapper;
			const editable = this.ctx.can_edit();
			if (!editable) $wrapper.find("input, select, textarea").prop("disabled", true);
			// a paused campaign keeps its device and its send time (see `can_edit_content`)
			else if (!this.ctx.can_edit_content()) $wrapper.find('[data-field="device"], input[name="whatsapp-campaign-builder-when"]').prop("disabled", true);


			$wrapper.on("click", ".whatsapp-campaign-builder__card--fold .whatsapp-campaign-builder__card-head", (e) => {
				const $card = $(e.currentTarget).closest(".whatsapp-campaign-builder__card");
				const open = $card.attr("data-open") !== "1";
				$card.attr("data-open", open ? 1 : 0).find(".whatsapp-campaign-builder__card-body").attr("hidden", !open ? "hidden" : null);
				$(e.currentTarget).attr("aria-expanded", open);
			});

			// name — the counter answers every keystroke, the document once the typing settles
			const $name = $wrapper.find('[data-field="campaign_name"]');
			const commit_name = ui.debounce(() => frm.set_value("campaign_name", $name.val()), 400);
			$name.on("input", () => {
				$wrapper.find('[data-counter="whatsapp-campaign-builder-name"]').text(`${($name.val() || "").length}/${NAME_MAX}`);
				commit_name();
			});
			$name.on("blur", () => frm.set_value("campaign_name", $name.val()));

			$wrapper.on("change", '[data-field="description"]', (e) => frm.set_value("description", $(e.currentTarget).val()));
			$wrapper.on("change", '[data-field="exclude_unknown_numbers"]', (e) => frm.set_value("exclude_unknown_numbers", e.currentTarget.checked ? 1 : 0));
			$wrapper.on("change", '[data-field="exclude_not_on_whatsapp"]', (e) => frm.set_value("exclude_not_on_whatsapp", e.currentTarget.checked ? 1 : 0));

			// rate — the two controls are one value; each moves the other, the estimate follows
			const $n = $wrapper.find('[data-rate="number"]');
			const $s = $wrapper.find('[data-rate="slider"]');
			const commit_rate = ui.debounce((v) => frm.set_value("messages_per_minute", v), 300);
			const set_rate = (raw, { from }) => {
				const cap = cint(this.ctx.cap) || 60;
				const value = Math.max(1, Math.min(cint(raw) || 1, cap));
				if (from !== "number") $n.val(value);
				if (from !== "slider") $s.val(value);
				this.show_estimate(value);
				commit_rate(value);
			};
			$s.on("input", (e) => set_rate(e.currentTarget.value, { from: "slider" }));
			$n.on("input", (e) => set_rate(e.currentTarget.value, { from: "number" }));

			$wrapper.on("change", 'input[name="whatsapp-campaign-builder-when"]', () => this.commit_when({ chosen: true }));
		}

		/** The estimate the slider buys, without waiting for the document to come back. */
		show_estimate(rate) {
			const doc = Object.assign({}, this.doc, { messages_per_minute: rate });
			const minutes = campaign_builder.estimate(doc, this.ctx.cap).minutes;
			this.$wrapper.find(".whatsapp-campaign-builder__estimate-value").text(campaign_builder.duration_text(minutes));
			this.ctx.refresh_header_and_stepper();
		}

		/**
		 * "Now" is an empty `scheduled_at`; "Schedule" is a full one. An incomplete or past time is
		 * said here, beside the control, and never written to the document — the server would
		 * refuse it later, and later is the wrong moment to find out.
		 */
		commit_when({ chosen = false } = {}) {
			const $wrapper = this.$wrapper;
			const scheduled = $wrapper.find('input[name="whatsapp-campaign-builder-when"]:checked').val() === "scheduled";
			const $error = $wrapper.find("[data-when-error]");
			this.set_when_enabled(scheduled && this.ctx.can_edit_content());
			const show_schedule_error = (message) => {
				$error.text(message).removeAttr("hidden");
				return false;
			};
			$error.attr("hidden", true).text("");

			if (!scheduled) return this.frm.set_value("scheduled_at", null);
			const date = this.date ? this.date.get_value() : "";
			const time = this.time ? this.time.get_value() : "";
			// "Schedule" was just chosen: the fields open and take focus — an error before the
			// reader has touched them would be scolding them for a choice they have not made yet
			if (!date && !time && chosen) {
				if (this.date && this.date.$input) this.date.$input.trigger("focus");
				return this.doc.scheduled_at ? this.frm.set_value("scheduled_at", null) : true;
			}
			if (!date || !time) return show_schedule_error(__("Choose both the date and the time."));
			const value = `${date} ${String(time).length === 5 ? `${time}:00` : time}`;
			if (frappe.datetime.str_to_obj(value) <= frappe.datetime.str_to_obj(frappe.datetime.now_datetime())) {
				return show_schedule_error(__("The time has already passed. Choose a time in the future."));
			}
			// typed on the reader's clock, stored in system time — the server compares it with its own
			const stored = frappe.datetime.convert_to_system_tz(value);
			// the round trip through the zones must not dirty an unchanged document
			if (this.doc.scheduled_at && String(this.doc.scheduled_at).slice(0, 19) === stored) return true;
			return this.frm.set_value("scheduled_at", stored);
		}

	};
})();

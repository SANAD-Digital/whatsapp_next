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
	const ui = sanad.ui;
	const C = whatsapp_next.campaign;
	const esc = C.esc;
	const NAME_MAX = 140;

	C.Setup = class CampaignSetup {
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
			this.$wrapper.html(`<div class="wa-cb__stack">${this.basic()}<div class="wa-cb__two">${this.rate()}${this.when()}</div>${this.advanced()}</div>`);
			this.mount_controls();
			this.bind();
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
			const editable = this.ctx.can_edit();
			const $el = this.$wrapper;
			this.$device = $el.find('[data-field="device"]');

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
					parent: $el.find(`[data-control="${key}"]`),
					df: Object.assign({ fieldname: `wa_cb_${key}`, read_only: editable ? 0 : 1 }, df),
					render_input: true,
					only_input: true,
				});
			const at = this.doc.scheduled_at;
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
			const $sel = this.$device;
			const current = this.doc.device || "";
			$sel.empty().append(`<option value="">${esc(__("Choose a device"))}</option>`);
			$sel.attr("data-empty", current ? "false" : "true");
			if (current) $sel.append(`<option value="${esc(current)}" selected>${esc(current)}</option>`);
			this.ctx.devices().then((rows) => {
				if (!$sel.closest("body").length) return;
				$sel.find("option[value!='']").remove();
				rows.filter((d) => !cint(d.disabled) || d.name === current).forEach((d) => {
					const label = `${d.device_name || d.name}${d.status && d.status !== "Connected" ? ` — ${__(d.status)}` : ""}`;
					$sel.append(`<option value="${esc(d.name)}"${d.name === current ? " selected" : ""}>${esc(label)}</option>`);
				});
				if (current && !$sel.find(`option[value="${current.replace(/"/g, '\\"')}"]`).length) {
					$sel.append(`<option value="${esc(current)}" selected>${esc(current)}</option>`);
				}
				$sel.val(current);
			});
		}

		set_when_enabled(on) {
			[this.date, this.time].forEach((c) => c && c.$input && c.$input.prop("disabled", !on));
			this.$wrapper.find(".wa-cb__when-at").toggleClass("wa-cb__when-at--off", !on);
		}

		// ---- the four groups -------------------------------------------------------------------

		basic() {
			const doc = this.doc;
			const name = doc.campaign_name || "";
			return C.card({
				key: "basic",
				icon: "doc",
				title: __("Basic information"),
				body: `
					<div class="wa-cb__grid">
						${C.field({
							id: "wa-cb-name",
							label: __("Campaign name"),
							required: true,
							counter: `${name.length}/${NAME_MAX}`,
							control: `<input id="wa-cb-name" type="text" class="wa-input" maxlength="${NAME_MAX}" value="${esc(name)}" data-field="campaign_name" placeholder="${esc(__("What is this campaign called?"))}">`,
						})}
						${C.field({
							id: "wa-cb-device",
							label: __("Sending device"),
							required: true,
							control: `
								<span class="wa-affix wa-affix--has-start">
									<span class="wa-affix__in wa-affix__in--start" aria-hidden="true">${ui.ico("device", "sm")}</span>
									<select id="wa-cb-device" class="wa-input wa-select" data-field="device" required></select>
								</span>`,
						})}
						${C.field({
							id: "wa-cb-description",
							label: __("Description"),
							control: `<textarea id="wa-cb-description" class="wa-textarea" rows="1" data-field="description" placeholder="${esc(__("For whoever opens the campaign later. It is never sent."))}">${esc(doc.description || "")}</textarea>`,
						})}
					</div>`,
			});
		}

		rate() {
			const rate = C.rate_of(this.doc, this.ctx.cap);
			return C.card({
				key: "rate",
				icon: "bolt",
				title: __("Sending rate"),
				body: `
					<div class="wa-cb__rate">
						<div class="wa-cb__rate-input">
							<input type="number" class="wa-input wa-input--mono" id="wa-cb-rate-n" min="1" max="${cint(this.ctx.cap) || 60}" value="${cint(rate)}" data-rate="number" aria-label="${esc(__("Messages per minute"))}">
							<span class="wa-cb__rate-unit">${esc(__("messages/minute"))}</span>
						</div>
						<input type="range" class="wa-cb__slider" min="1" max="${cint(this.ctx.cap) || 60}" value="${cint(rate)}" data-rate="slider" aria-label="${esc(__("Messages per minute"))}">
						<div class="wa-cb__estimate" data-estimate>
							<span class="wa-cb__estimate-icon" aria-hidden="true">${ui.ico("clock", "sm")}</span>
							<span class="wa-cb__estimate-text">
								<span class="wa-cb__estimate-label">${esc(__("Estimated duration"))}</span>
								<span class="wa-cb__estimate-value sanad-tabular">${esc(C.dur_text(this.ctx.estimate().minutes))}</span>
							</span>
						</div>
						<p class="wa-cb__rate-hint" data-rate-hint>${esc(this.rate_hint(rate))}</p>
					</div>`,
			});
		}

		rate_hint(rate) {
			const cap = cint(this.ctx.cap);
			return cap
				? __("The slower the rate, the steadier the sending. The queue allows {0}/min at most.", [C.fmt_int(cap)])
				: __("The slower the rate, the steadier the sending.");
		}

		when() {
			const scheduled = !!this.doc.scheduled_at;
			const choice = (value, label, note) => `
				<label class="wa-cb__choice">
					<input type="radio" name="wa-cb-when" value="${value}"${(value === "scheduled") === scheduled ? " checked" : ""}>
					<span class="wa-cb__choice-text">
						<span class="wa-cb__choice-label">${esc(label)}</span>
						<span class="wa-cb__choice-note">${esc(note)}</span>
					</span>
				</label>`;
			// the date and the time are Frappe's own pickers, in the kit's field with its icon
			const when_input = (kind, icon, label) => `
				<span class="wa-affix wa-affix--has-start wa-cb__when-field" aria-label="${esc(label)}">
					<span class="wa-affix__in wa-affix__in--start" aria-hidden="true">${ui.ico(icon, "sm")}</span>
					<span data-control="${kind}"></span>
				</span>`;
			return C.card({
				key: "when",
				icon: "clock",
				title: __("Send time"),
				body: `
					<div class="wa-cb__when">
						<div class="wa-cb__when-choices" role="radiogroup" aria-label="${esc(__("Send time"))}">
							${choice("now", __("Now"), __("Sending starts as soon as you save and start the campaign."))}
							${choice("scheduled", __("Schedule", null, "campaign"), __("Set the date and time the sending begins."))}
						</div>
						<div class="wa-cb__when-at">
							${when_input("date", "calendar", __("Choose the date"))}
							${when_input("time", "clock", __("Choose the time"))}
						</div>
						<p class="wa-cb__when-error" role="alert" data-when-error hidden></p>
					</div>`,
			});
		}

		advanced() {
			const option = ({ field, design_only, on, label, note }) => `
				<div class="wa-cb__option">
					<span class="wa-cb__option-text">
						<span class="wa-cb__option-label">${esc(label)}</span>
						<span class="wa-cb__option-note">${esc(note)}</span>
					</span>
					<label class="wa-toggle">
						<input type="checkbox"${field ? ` data-field="${esc(field)}"` : ' data-design-only="1"'}${on ? " checked" : ""}>
						<span class="wa-toggle__track"></span>
						<span class="sanad-visually-hidden">${esc(label)}</span>
					</label>
				</div>`;
			return C.card({
				key: "advanced",
				icon: "gear",
				title: __("Advanced options"),
				collapsible: true,
				open: true,
				body: `
					<div class="wa-cb__options">
						${option({
							field: "exclude_unknown_numbers",
							on: !!cint(this.doc.exclude_unknown_numbers),
							label: __("Exclude unknown numbers"),
							note: __("Do not send to numbers that are not in the WhatsApp account's contacts."),
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

		bind() {
			const frm = this.frm;
			const $el = this.$wrapper;
			const editable = this.ctx.can_edit();
			if (!editable) $el.find("input, select, textarea").prop("disabled", true);


			$el.on("click", ".wa-cb__card--fold .wa-cb__card-head", (e) => {
				const $card = $(e.currentTarget).closest(".wa-cb__card");
				const open = $card.attr("data-open") !== "1";
				$card.attr("data-open", open ? 1 : 0).find(".wa-cb__card-body").attr("hidden", !open ? "hidden" : null);
				$(e.currentTarget).attr("aria-expanded", open);
			});

			// name — the counter answers every keystroke, the document once the typing settles
			const $name = $el.find('[data-field="campaign_name"]');
			const commit_name = ui.debounce(() => frm.set_value("campaign_name", $name.val()), 400);
			$name.on("input", () => {
				$el.find('[data-counter="wa-cb-name"]').text(`${($name.val() || "").length}/${NAME_MAX}`);
				commit_name();
			});
			$name.on("blur", () => frm.set_value("campaign_name", $name.val()));

			$el.on("change", '[data-field="description"]', (e) => frm.set_value("description", $(e.currentTarget).val()));
			$el.on("change", '[data-field="exclude_unknown_numbers"]', (e) => frm.set_value("exclude_unknown_numbers", e.currentTarget.checked ? 1 : 0));

			// rate — the two controls are one value; each moves the other, the estimate follows
			const $n = $el.find('[data-rate="number"]');
			const $s = $el.find('[data-rate="slider"]');
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

			$el.on("change", 'input[name="wa-cb-when"]', () => this.commit_when({ chosen: true }));
		}

		/** The estimate the slider buys, without waiting for the document to come back. */
		show_estimate(rate) {
			const doc = Object.assign({}, this.doc, { messages_per_minute: rate });
			const minutes = C.estimate(doc, this.ctx.cap).minutes;
			this.$wrapper.find(".wa-cb__estimate-value").text(C.dur_text(minutes));
			this.ctx.sync();
		}

		/**
		 * "Now" is an empty `scheduled_at`; "Schedule" is a full one. An incomplete or past time is
		 * said here, beside the control, and never written to the document — the server would
		 * refuse it later, and later is the wrong moment to find out.
		 */
		commit_when({ chosen = false } = {}) {
			const $el = this.$wrapper;
			const scheduled = $el.find('input[name="wa-cb-when"]:checked').val() === "scheduled";
			const $error = $el.find("[data-when-error]");
			this.set_when_enabled(scheduled && this.ctx.can_edit());
			const fail = (message) => {
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
			if (!date || !time) return fail(__("Choose both the date and the time."));
			const value = `${date} ${String(time).length === 5 ? `${time}:00` : time}`;
			if (frappe.datetime.str_to_obj(value) <= frappe.datetime.str_to_obj(frappe.datetime.now_datetime())) {
				return fail(__("The time has already passed. Choose a time in the future."));
			}
			return this.frm.set_value("scheduled_at", value);
		}

	};
})();

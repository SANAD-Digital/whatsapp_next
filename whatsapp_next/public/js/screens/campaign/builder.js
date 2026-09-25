// CampaignBuilder — the campaign screen itself, and the one place that knows which of its two
// halves the reader is looking at.
//
// A campaign has two lives. Before it starts it is a thing being decided — four questions in
// order, each with the cost of the answer beside it. After it starts it is a thing being watched,
// and a wizard over a running campaign is nonsense: the steps are no longer choices. So the same
// header and the same sticky bar carry either a wizard or a monitor, and the status decides which.
//
// The document stays the source of truth. Every control writes through `frm.set_value` /
// `frappe.model.set_value`, the native form layout stays in the DOM because it is what saves, and
// this class holds no copy of a field — only the things the document cannot answer by itself: the
// step the reader is on, the rate ceiling, the device list and the server's readiness answer.

frappe.provide("whatsapp_next.campaign");

(function () {
	const ui = sanad.ui;
	const C = whatsapp_next.campaign;
	const K = whatsapp_next.campaigns;

	const FILE_TYPES = ["Image", "Video", "Audio", "Sticker"];

	/** The client's mirror of `campaign_runner._message_problem` — the same rule, said sooner. */
	function message_problem(m) {
		if (m.message_type === "Text") return (m.body || "").trim() || m.template ? null : "empty_body";
		if (m.message_type === "Document") return m.attachment || m.print_format || m.template ? null : "no_attachment";
		if (FILE_TYPES.includes(m.message_type)) return m.attachment || m.template ? null : "no_attachment";
		if (m.message_type === "Poll") {
			if (!(m.poll_question || "").trim()) return "no_question";
			let options = m.poll_options;
			if (typeof options === "string") {
				try {
					options = JSON.parse(options || "[]");
				} catch (e) {
					options = [];
				}
			}
			return (options || []).filter((o) => String(o || "").trim()).length >= 2 ? null : "few_options";
		}
		return null;
	}

	C.Builder = class CampaignBuilder {
		constructor({ frm, wrapper }) {
			this.frm = frm;
			this.$wrapper = $(wrapper);
			this.id = ui.uid("cb");
			this.cap = 0;
			this.retry_policy = null;
			this.readiness = null;
			this.readiness_key = null;
			this.step = cint(frm.wa_step);
			this.make();
			C.limits().then((l) => {
				if (this.cap === cint(l.rate)) return;
				this.cap = cint(l.rate);
				// only the first step draws the cap (the slider's ceiling): nothing else redraws
				if (this.wizard() && this.step === 0) this.render_pane();
			});
			this.refresh();
		}

		get doc() {
			return this.frm.doc;
		}

		make() {
			// `wa wa--compact` is the kit's own density switch: every control the screen draws —
			// input, select, toggle, button, badge — takes the compact scale from it instead of
			// this screen inventing sizes of its own.
			this.$wrapper.addClass("wa wa--compact");
			this.$wrapper.html(`
				<div class="wa-cb__shell">
					<div class="wa-cb__top" data-el="header"></div>
					<div class="wa-cb__body">
						<main class="wa-cb__main">
							<div class="wa-cb__panel">
								<div class="wa-cb__panel-head" data-el="stepper"></div>
								<div class="wa-cb__pane" data-el="pane"></div>
							</div>
						</main>
					</div>
				</div>`);
			this.$ = (key) => this.$wrapper.find(`[data-el="${key}"]`);
			// the audience step's toolbar reads the recipient table's meta and the picker's sources:
			// both are asked for now, so that step opens without waiting on either
			ui.meta.with_doctype("WhatsApp Campaign Recipient").catch(() => {});
			if (ui.ContactPicker) ui.ContactPicker.prefetch(this.frm.doctype);
			this._pin = ui.debounce(() => this.pin(), 150);
			$(window).on(`resize.${this.id}`, this._pin);
		}

		/**
		 * The page scrolls the way every page does; what the reader must never lose sticks. Desk's
		 * navbar and page head are already sticky, so the header band pins just under them and the
		 * step bar (or the tabs) pins just under the band. The offsets are measured,
		 * not guessed — the navbar and the page head are not the same height on every route, and
		 * the band is not drawn at all before the first save.
		 */
		pin() {
			const el = this.$wrapper[0];
			if (!el || !el.isConnected) return;
			const navbar = document.querySelector(".navbar");
			const head = document.querySelector(".page-head");
			const top = (navbar ? navbar.getBoundingClientRect().height : 0) + (head ? head.getBoundingClientRect().height : 0);
			const $header = this.$("header");
			const band = $header.is(":visible") ? $header.outerHeight() : 0;
			this.$wrapper.css("--cb-top", `${Math.round(top)}px`).css("--cb-top-2", `${Math.round(top + band)}px`);
		}

		// ---- what the parts ask the shell ------------------------------------------------------

		wizard() {
			// a boolean, not Desk's `is_new()` integer: jQuery reads a number given to `.toggle()` as
			// an animation duration and flips the element instead of showing it
			return !!this.frm.is_new() || ["Draft", "Scheduled"].includes(this.doc.status) || (this.doc.status === "Paused" && !!this.editing);
		}

		/** A paused campaign opened for editing: the wizard, with a way back to the monitor. */
		edit(on) {
			this.editing = !!on;
			this.step = 0;
			this.frm.wa_step = 0;
			this.render();
		}

		can_edit() {
			return (
				!K.TERMINAL.includes(this.doc.status) &&
				(this.frm.is_new() || K.EDITABLE.includes(this.doc.status) || this.doc.status === "Scheduled") &&
				frappe.model.can_write(this.frm.doctype)
			);
		}

		estimate() {
			return C.estimate(this.doc, this.cap);
		}

		devices() {
			if (!this._devices) {
				this._devices = ui
					.call("devices.list_devices", {}, { silent: true })
					.then((r) => (r && r.rows) || [])
					.catch(() => []);
			}
			return this._devices;
		}

		/** How many recipients the unknown-numbers policy has already set aside. */
		excluded_unknown() {
			const check = ((this.readiness || {}).checks || []).find((c) => c.key === "audience");
			return check ? cint(check.excluded_unknown) : 0;
		}

		readiness_is_fresh() {
			return !!(
				this.readiness &&
				!this.frm.is_new() &&
				!this.frm.is_dirty() &&
				this.readiness_key === this.doc.modified
			);
		}

		/** What stops the reader leaving step `i`, in one sentence, or "" when nothing does. */
		step_problem(i) {
			const doc = this.doc;
			if (i === 0) {
				if (!(doc.campaign_name || "").trim()) return __("Give the campaign a name.");
				if (!doc.device) return __("Choose the device it sends from.");
				return "";
			}
			if (i === 1) {
				const rows = doc.messages || [];
				if (!rows.length) return __("Add at least one message.");
				const bad = rows.find((m) => message_problem(m));
				if (bad) {
					const why = {
						empty_body: __("has no text"),
						no_attachment: __("has no file"),
						no_question: __("has no question"),
						few_options: __("needs at least two answers"),
					}[message_problem(bad)];
					return __("Message {0} {1}.", [C.fmt_int(bad.idx), why]);
				}
				return "";
			}
			if (i === 2) {
				if (!cint(doc.total_recipients)) return __("Add the people who receive this campaign.");
				return "";
			}
			return "";
		}

		step_errors(i) {
			return i < this.step && this.step_problem(i) ? 1 : 0;
		}

		/** Every step may be opened. A step that is not finished says so inside itself. */
		can_go() {
			return true;
		}

		go(i) {
			const next = Math.max(0, Math.min(cint(i), C.STEPS.length - 1));
			if (next === this.step) return;
			this.step = next;
			this.frm.wa_step = next;
			this.render();
			// the new step begins under the pinned bars, not wherever the last one was scrolled to
			window.scrollTo({ top: 0, behavior: "smooth" });
		}

		save() {
			return this.frm.save();
		}

		// ---- drawing ---------------------------------------------------------------------------

		/** The cheap half: everything that only reads the document. */
		sync() {
			if (!this.frm.is_new()) this.header = new C.Header({ wrapper: this.$("header"), ctx: this });
			if (this.wizard()) {
				this.stepper = new C.Stepper({ wrapper: this.$("stepper"), ctx: this });
				if (this.checks) this.checks.render();
			}
		}

		/** The whole screen, including the step's own pane. */
		render() {
			const wizard = this.wizard();
			this.$wrapper.toggleClass("wa-cb--wizard", wizard).toggleClass("wa-cb--monitor", !wizard);
			// until the campaign exists there is no device, no audience and no duration to state:
			// the band would be four dashes over an empty name
			this.$("header").toggle(!this.frm.is_new());
			this.$("stepper").toggle(wizard);
			// Desk's own Save is the screen's save button (the design asks for no second one), so
			// a campaign that can no longer be edited hides it rather than leaving it dead
			if (!this.can_edit() && !this.frm.is_new()) this.frm.disable_save();
			this.render_pane();
			this.sync();
			return this;
		}

		render_pane() {
			const $pane = this.$("pane").empty();
			this.pane && this.pane.destroy && this.pane.destroy();
			if (!this.wizard()) {
				this.pane = new C.Monitor({ wrapper: $pane, ctx: this });
				this.pane.load_progress();
				this.pin();
				return;
			}
			const Step = [C.Setup, C.Messages, C.Audience, C.Review][this.step];
			this.pane = new Step({ wrapper: $pane, ctx: this });
			this.checks = null;
			this.pin();
		}

		/**
		 * The document changed — Desk refreshed the form, a save came back, realtime moved the
		 * counters. Redraw, then ask the server the one question the document cannot answer.
		 */
		refresh() {
			this.render();
			this.load_readiness();
		}

		load_readiness() {
			if (this.frm.is_new() || this.frm.is_dirty()) return;
			const key = this.doc.modified;
			if (this.readiness_key === key) return;
			ui.call("campaigns.get_readiness", { name: this.doc.name }, { silent: true })
				.then((r) => {
					if (this.doc.modified !== key) return;
					this.readiness = r;
					this.readiness_key = key;
					if (this.checks) this.checks.render();
					if (this.pane && this.pane instanceof C.Review) this.pane.refresh();
				})
				.catch(() => {});
		}

		destroy() {
			$(window).off(`resize.${this.id}`);
			this.$wrapper.empty();
		}
	};
})();

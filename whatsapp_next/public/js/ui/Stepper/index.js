// whatsapp.ui.Stepper — a multi-step flow with a visible "Step 2 of 4" progress line, a step list
// (`role="list"`, current step `aria-current="step"`), one pane per step rendered lazily by the
// caller, Back / Next / Finish (and optional Skip / Cancel) in the footer, and per-step validation
// whose message is shown inline in the step body (`role="alert"`). Portable: it knows nothing
// about the steps' content — the caller's `render($body, ctx)` owns each pane.

import ui from "../_core/index.js";

whatsapp.ui.Stepper = class Stepper {
	/**
	 * @param {Object} opts
	 * @param {jQuery|HTMLElement} opts.wrapper
	 * @param {Array<{key: string, label: string, render: Function, validate?: Function, can_skip?: boolean, description?: string}>} opts.steps
	 *   `render($body, ctx)` is called once, when the step is first shown; `validate(ctx)` may return
	 *   `true`, `false`, an error string, or a promise of one of those.
	 * @param {Function} opts.on_finish — `(ctx) => Promise|void`; a rejected promise keeps the last step open
	 * @param {Function} [opts.on_cancel] — when set, a Cancel button is rendered
	 * @param {Object} [opts.ctx={}] — shared context passed to every render / validate / on_finish
	 * @param {string} [opts.finish_label] — default "Finish"
	 * @param {string} [opts.next_label] — default "Next"
	 * @param {string} [opts.back_label] — default "Back"
	 * @param {string} [opts.cancel_label] — default "Cancel"
	 * @param {number} [opts.start_index=0]
	 * @param {boolean} [opts.linear=true] — when false, any step label is clickable
	 */
	constructor(opts = {}) {
		this.opts = Object.assign({ steps: [], ctx: {}, start_index: 0, linear: true }, opts);
		this.ctx = this.opts.ctx;
		this.index = -1;
		this.rendered = new Set();
		this.valid = true;
		this.$wrapper = $(this.opts.wrapper);
		this.build_stepper_markup();
		this.go_to_step(this.opts.start_index);
	}

	get steps() {
		return this.opts.steps;
	}

	get current() {
		return this.steps[this.index];
	}

	build_stepper_markup() {
		const id = ui.unique_dom_id("stepper");
		this.id = id;
		this.$el = $(`
			<div class="whatsapp-kit whatsapp-kit-stepper" id="${id}">
				<div class="whatsapp-kit-stepper__header">
					<div class="whatsapp-kit-stepper__progress" aria-live="polite"></div>
					<ol class="whatsapp-kit-stepper__list" role="list"></ol>
				</div>
				<div class="whatsapp-kit-stepper__body"></div>
				<div class="whatsapp-kit-stepper__footer">
					<div class="whatsapp-kit-stepper__footer-start"></div>
					<div class="whatsapp-kit-stepper__footer-end"></div>
				</div>
			</div>`);
		this.$wrapper.empty().append(this.$el);
		this.$progress = this.$el.find(".whatsapp-kit-stepper__progress");
		this.$list = this.$el.find(".whatsapp-kit-stepper__list");
		this.$body = this.$el.find(".whatsapp-kit-stepper__body");
		const $start = this.$el.find(".whatsapp-kit-stepper__footer-start");
		const $end = this.$el.find(".whatsapp-kit-stepper__footer-end");

		if (this.opts.on_cancel) {
			this.$cancel = $(`<button type="button" class="btn btn-default btn-sm">${ui.escape(this.opts.cancel_label || __("Cancel"))}</button>`)
				.on("click", () => this.opts.on_cancel(this.ctx))
				.appendTo($start);
		}
		this.$back = $(`<button type="button" class="btn btn-default btn-sm">${ui.escape(this.opts.back_label || __("Back"))}</button>`)
			.on("click", () => this.go_to_previous_step())
			.appendTo($start);
		this.$skip = $(`<button type="button" class="btn btn-default btn-sm">${ui.escape(__("Skip"))}</button>`)
			.on("click", () => this.skip_current_step())
			.appendTo($end);
		this.$next = $(`<button type="button" class="btn btn-primary btn-sm"></button>`)
			.on("click", () => this.go_to_next_step())
			.appendTo($end);

		this.steps.forEach((step, i) => {
			const $li = $(`<li class="whatsapp-kit-stepper__step" data-index="${i}"></li>`);
			const $btn = $(`<button type="button" class="whatsapp-kit-stepper__step-button" aria-describedby="${id}-progress"></button>`);
			$btn.append(`<span class="whatsapp-kit-stepper__number" aria-hidden="true">${i + 1}</span><span class="whatsapp-kit-stepper__check" aria-hidden="true">${ui.icon("es-line-check", "xs")}</span>`);
			$btn.append(`<span class="whatsapp-kit-stepper__label">${ui.escape(step.label)}</span>`);
			if (step.can_skip) $btn.append(`<span class="whatsapp-kit-stepper__optional">${ui.escape(__("Optional"))}</span>`);
			$btn.on("click", () => {
				if (!$btn.prop("disabled")) this.go_to_step(i);
			});
			$li.append($btn);
			this.$list.append($li);
			this.$body.append(`<div class="whatsapp-kit-stepper__pane" data-index="${i}" hidden></div>`);
		});
		this.$progress.attr("id", `${id}-progress`);
	}

	find_step_pane(i) {
		return this.$body.find(`.whatsapp-kit-stepper__pane[data-index="${i}"]`);
	}

	/** Jump to a step (no validation — used by Back and by header clicks on visited steps). */
	go_to_step(index) {
		if (index < 0 || index >= this.steps.length) return this;
		const step = this.steps[index];
		this.clear_error();
		if (this.index >= 0) this.find_step_pane(this.index).attr("hidden", true);
		this.index = index;
		this.max_visited = Math.max(this.max_visited || 0, index);
		const $pane = this.find_step_pane(index);
		if (!this.rendered.has(index)) {
			this.rendered.add(index);
			$pane.html(`<div class="whatsapp-kit-stepper__error" role="alert" tabindex="-1" hidden></div><div class="whatsapp-kit-stepper__content"></div>`);
			step.render($pane.find(".whatsapp-kit-stepper__content"), this.ctx, this);
		}
		$pane.removeAttr("hidden");
		this.valid = true; // on_show may call set_step_valid(false)
		step.on_show && step.on_show($pane.find(".whatsapp-kit-stepper__content"), this.ctx, this);
		this.render_state();
		this.$progress.text(__("Step {0} of {1}", [index + 1, this.steps.length]));
		return this;
	}

	render_state() {
		const last = this.index === this.steps.length - 1;
		this.$list.find(".whatsapp-kit-stepper__step").each((i, li) => {
			const $li = $(li);
			const $btn = $li.find(".whatsapp-kit-stepper__step-button");
			$li.toggleClass("whatsapp-kit-stepper__step--current", i === this.index)
				.toggleClass("whatsapp-kit-stepper__step--done", i < this.index)
				.toggleClass("whatsapp-kit-stepper__step--todo", i > this.index);
			if (i === this.index) $btn.attr("aria-current", "step");
			else $btn.removeAttr("aria-current");
			const reachable = !this.opts.linear || i <= (this.max_visited || 0);
			$btn.prop("disabled", !reachable || i === this.index);
		});
		this.$back.toggle(this.index > 0);
		this.$skip.toggle(!!(this.current && this.current.can_skip && !last));
		this.$next.text(last ? this.opts.finish_label || __("Finish") : this.opts.next_label || __("Next"));
		this.$next.prop("disabled", !this.valid);
	}

	/** Change the Finish label (e.g. "Add 12 rows") — re-renders the footer. */
	set_finish_label(text) {
		this.opts.finish_label = text;
		this.render_state();
		return this;
	}

	/** Enable / disable Next (or Finish) for the current step, e.g. after a required choice. */
	set_step_valid(valid) {
		this.valid = !!valid;
		this.$next.prop("disabled", !this.valid);
		return this;
	}

	show_error(message) {
		const $err = this.find_step_pane(this.index).find(".whatsapp-kit-stepper__error");
		$err.html(`${ui.icon("es-line-alert-circle", "xs")} <span>${ui.escape(message)}</span>`).removeAttr("hidden");
		$err[0] && $err[0].focus();
		ui.announce(message, { assertive: true });
	}

	clear_error() {
		if (this.index < 0) return;
		this.find_step_pane(this.index).find(".whatsapp-kit-stepper__error").attr("hidden", true).empty();
	}

	validate_current() {
		const current = this.current;
		if (!current || !current.validate) return Promise.resolve(true);
		return Promise.resolve(current.validate(this.ctx, this)).then((result) => {
			if (result === true || result === undefined) return true;
			this.show_error(typeof result === "string" && result ? result : __("Complete this step before continuing"));
			return false;
		});
	}

	go_to_next_step() {
		if (!this.valid) return Promise.resolve(false);
		this.clear_error();
		this.set_footer_busy(true);
		return this.validate_current()
			.then((ok) => {
				if (!ok) return false;
				if (this.index === this.steps.length - 1) return this.run_finish_callback();
				this.go_to_step(this.index + 1);
				return true;
			})
			.catch((err) => {
				this.show_error((err && err.message) || __("Something went wrong. Try again."));
				return false;
			})
			.finally(() => this.set_footer_busy(false));
	}

	skip_current_step() {
		if (!this.current || !this.current.can_skip) return;
		this.clear_error();
		if (this.index < this.steps.length - 1) this.go_to_step(this.index + 1);
	}

	go_to_previous_step() {
		if (this.index > 0) this.go_to_step(this.index - 1);
		return this;
	}

	run_finish_callback() {
		return Promise.resolve(this.opts.on_finish && this.opts.on_finish(this.ctx, this)).then(() => true);
	}

	set_footer_busy(on) {
		this.$next.prop("disabled", on || !this.valid).toggleClass("disabled", !!on);
		this.$back.prop("disabled", !!on);
	}

	destroy() {
		this.$el.remove();
	}
};

export default whatsapp.ui.Stepper;

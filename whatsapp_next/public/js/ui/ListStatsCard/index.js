// sanad.ui.ListStatsCard — a row of live number cards above a Desk list (or inside any wrapper).
// Each card gets its value from a configured API key, a `frappe.db.count`, or a `sum` aggregate
// through `frappe.db.get_list`; it shows a skeleton while loading, an inline error on failure, and
// on click either runs `onclick` or opens a `frappe.ui.Dialog` listing the method's rows with
// per-row action buttons. Optional interval refresh and realtime `events` (subscribed on mount,
// unsubscribed on destroy / page hide). Portable: no DocType or field names live in here.

import ui from "../_core/index.js";

sanad.ui.ListStatsCard = class ListStatsCard {
	/**
	 * @param {Object} opts
	 * @param {Object} [opts.listview] — a Desk ListView; cards are inserted above the result rows
	 * @param {jQuery|HTMLElement} [opts.wrapper] — alternative mount point
	 * @param {Array<Object>} opts.cards — `{key, label, icon?, tone?, method?, args?, count?: {doctype, filters},
	 *   sum?: {doctype, field, filters}, format?(value), onclick?(card, value), modal?: {title, method, args?,
	 *   columns: [{fieldname, label, format?(value, row)}], row_actions?: [{label, icon?, method?, args?(row),
	 *   handler?(row), confirm?: true|ConfirmDialog opts, condition?(row)}], empty_text?}}`
	 *   A `method` may resolve to a number, `{value, tone}`, or an array (its length is the value).
	 * @param {number} [opts.refresh_seconds] — interval refresh (paused while the page is hidden)
	 * @param {Object<string, Function>} [opts.events] — realtime event name → handler (`this` = card set)
	 */
	constructor(opts = {}) {
		this.opts = Object.assign({ cards: [], events: {} }, opts);
		this.values = {};
		this.handlers = {};
		this.make();
		this.bind_events();
		this.refresh();
	}

	make() {
		this.$el = $('<div class="sanad-kit sanad-stats" role="group"></div>').attr("aria-label", __("Summary"));
		this.opts.cards.forEach((card) => this.$el.append(this.card_html(card)));
		const lv = this.opts.listview;
		if (lv && lv.$frappe_list) {
			lv.$frappe_list.prepend(this.$el);
			lv.page && lv.page.wrapper.on("show.sanadstats", () => this.refresh()).on("hide.sanadstats", () => this.stop_timer());
		} else {
			$(this.opts.wrapper).append(this.$el);
		}
		this.$el.on("click", ".sanad-stats__card", (e) => this.on_card_click($(e.currentTarget).data("key")));
		this.$el.on("keydown", ".sanad-stats__card", (e) => {
			if (e.key === "Enter" || e.key === " ") {
				e.preventDefault();
				this.on_card_click($(e.currentTarget).data("key"));
			}
		});
	}

	card_html(card) {
		const interactive = !!(card.onclick || card.modal);
		const attrs = interactive ? ` tabindex="0" role="button"` : "";
		return `
			<div class="sanad-stats__card ${interactive ? "sanad-stats__card--interactive" : ""}" data-key="${ui.escape(card.key)}"${attrs}>
				${card.icon ? `<div class="sanad-stats__icon" aria-hidden="true">${ui.icon(card.icon, "md")}</div>` : ""}
				<div class="sanad-stats__text">
					<div class="sanad-stats__label">${ui.escape(card.label)}</div>
					<div class="sanad-stats__value sanad-tabular">${ui.skeleton(1, { lines: 1 })}</div>
				</div>
				${interactive ? `<span class="sanad-stats__chevron" aria-hidden="true">${ui.icon("es-line-right-chevron", "xs")}</span>` : ""}
			</div>`;
	}

	$card(key) {
		return this.$el.find(`.sanad-stats__card[data-key="${key}"]`);
	}

	/** Fetch the value of one card according to its `method` / `count` / `sum` option. */
	fetch(card) {
		if (card.method) {
			return sanad.ui.call(card.method, typeof card.args === "function" ? card.args() : card.args || {}, { silent: true });
		}
		if (card.count) {
			return frappe.db.count(card.count.doctype, { filters: card.count.filters || {} });
		}
		if (card.sum) {
			const { doctype, field, filters } = card.sum;
			return frappe.db
				.get_list(doctype, { fields: [`sum(${field}) as value`], filters: filters || {}, limit: 1 })
				.then((rows) => (rows && rows.length ? rows[0].value : 0));
		}
		return Promise.resolve(typeof card.value === "function" ? card.value() : card.value);
	}

	refresh() {
		const jobs = this.opts.cards.map((card) => {
			const $value = this.$card(card.key).find(".sanad-stats__value");
			return this.fetch(card)
				.then((raw) => {
					let value = raw;
					let tone = card.tone;
					if (Array.isArray(raw)) value = raw.length;
					else if (raw && typeof raw === "object") {
						value = raw.value;
						tone = raw.tone || tone;
					}
					this.values[card.key] = { raw, value };
					const text = card.format ? card.format(value, raw) : ui.format_int(value || 0);
					$value.html(`<span class="${tone ? `sanad-tone--${ui.tone(tone)}` : ""}">${ui.escape(text)}</span>`);
					this.$card(card.key).removeClass("sanad-stats__card--error");
				})
				.catch((err) => {
					this.values[card.key] = { error: err };
					this.$card(card.key).addClass("sanad-stats__card--error");
					$value.html(`<span class="sanad-stats__error" role="alert">${ui.icon("es-line-alert-circle", "xs")} ${ui.escape(__("Could not load"))}<span class="sanad-visually-hidden">. ${ui.escape(err.message || "")}</span></span>`);
				});
		});
		this.start_timer();
		return Promise.all(jobs);
	}

	start_timer() {
		this.stop_timer();
		const seconds = cint(this.opts.refresh_seconds);
		if (!seconds) return;
		this.timer = window.setInterval(() => {
			if (document.visibilityState === "visible" && this.$el.is(":visible") && !this.modal_open) this.refresh();
		}, seconds * 1000);
	}

	stop_timer() {
		if (this.timer) window.clearInterval(this.timer);
		this.timer = null;
	}

	bind_events() {
		Object.entries(this.opts.events || {}).forEach(([event, handler]) => {
			const bound = (data) => handler.call(this, data);
			this.handlers[event] = bound;
			frappe.realtime.on(event, bound);
		});
	}

	on_card_click(key) {
		const card = this.opts.cards.find((c) => c.key === key);
		if (!card) return;
		const v = this.values[key] || {};
		if (card.onclick) return card.onclick(card, v.value, v.raw);
		if (card.modal) return this.open_modal(card);
	}

	open_modal(card) {
		const modal = card.modal;
		const columns = modal.columns || [];
		const dialog = new frappe.ui.Dialog({
			title: modal.title || card.label,
			size: modal.size || "large",
			fields: [{ fieldtype: "HTML", fieldname: "body" }],
		});
		dialog.$wrapper.addClass("sanad-kit sanad-stats-modal sanad-sheet");
		this.modal_open = true; // auto-refresh pauses while the modal is open
		dialog.$wrapper.on("hidden.bs.modal", () => {
			this.modal_open = false;
			this.refresh();
		});
		const $body = dialog.get_field("body").$wrapper;
		const state = new sanad.ui.EmptyState({ wrapper: $body, state: "loading", rows: 4 });
		const load = () =>
			sanad.ui
				.call(modal.method || card.method, typeof modal.args === "function" ? modal.args() : modal.args || {}, { silent: true })
				.then((data) => {
					const rows = Array.isArray(data) ? data : (data && data.rows) || [];
					if (!rows.length) {
						return state.empty({ title: modal.empty_text || __("Nothing to show right now") });
					}
					state.hide();
					this.render_rows($body, rows, columns, modal, load);
				})
				.catch((err) => state.error(err, { action: { label: __("Retry"), onclick: load } }));
		dialog.show();
		load();
		this.modal = dialog;
		return dialog;
	}

	render_rows($body, rows, columns, modal, reload) {
		const actions = (modal.row_actions || []).filter((a) => a.method || a.handler);
		let html = '<div class="sanad-table-wrap"><table class="sanad-table sanad-stats-modal__table"><thead><tr>';
		columns.forEach((c) => (html += `<th scope="col">${ui.escape(c.label)}</th>`));
		if (actions.length) html += `<th scope="col"><span class="sanad-visually-hidden">${ui.escape(__("Actions"))}</span></th>`;
		html += "</tr></thead><tbody>";
		rows.forEach((row, i) => {
			html += `<tr data-idx="${i}">`;
			columns.forEach((c) => {
				const value = c.format ? c.format(row[c.fieldname], row) : row[c.fieldname];
				html += `<td>${value == null ? "" : ui.escape(value)}</td>`;
			});
			if (actions.length) {
				html += '<td class="sanad-stats-modal__actions">';
				actions.forEach((a, j) => {
					if (a.condition && !a.condition(row)) return;
					html += `<button type="button" class="btn btn-xs btn-default" data-action="${j}" data-idx="${i}">${a.icon ? ui.icon(a.icon, "xs") + " " : ""}${ui.escape(a.label)}</button>`;
				});
				html += "</td>";
			}
			html += "</tr>";
		});
		html += "</tbody></table></div>";
		$body.html(html);
		$body.find("[data-action]").on("click", (e) => {
			const $btn = $(e.currentTarget);
			const action = actions[cint($btn.data("action"))];
			const row = rows[cint($btn.data("idx"))];
			this.run_row_action(action, row).then((done) => {
				if (done) {
					reload();
					this.refresh();
				}
			});
		});
	}

	run_row_action(action, row) {
		const call = (extra = {}) => {
			if (action.handler) return Promise.resolve(action.handler(row, extra)).then(() => true);
			const args = action.args ? action.args(row, extra) : { name: row.name };
			if (extra.reason && !("reason" in args)) args.reason = extra.reason;
			return sanad.ui
				.call(action.method, args)
				.then(() => {
					sanad.ui.Toast.success(action.success_message || __("{0} done", [action.label]));
					return true;
				})
				.catch((err) => {
					sanad.ui.Toast.error(err);
					return false;
				});
		};
		if (!action.confirm) return call();
		const confirm = typeof action.confirm === "object" ? Object.assign({}, action.confirm) : {};
		if (confirm.impact_of) confirm.impact = confirm.impact_of(row);
		delete confirm.impact_of;
		return sanad.ui.ConfirmDialog.ask(
			Object.assign({ title: __("{0} this row?", [action.label]), confirm_label: action.label }, confirm)
		)
			.then(({ reason }) => call({ reason }))
			.catch(() => false);
	}

	destroy() {
		this.stop_timer();
		Object.entries(this.handlers).forEach(([event, handler]) => frappe.realtime.off(event, handler));
		this.handlers = {};
		const lv = this.opts.listview;
		lv && lv.page && lv.page.wrapper.off(".sanadstats");
		this.$el.remove();
	}
};

export default sanad.ui.ListStatsCard;

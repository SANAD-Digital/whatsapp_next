// sanad.ui.BulkActions — actions over the checked rows of a Desk list, registered in the list's
// own "Actions" menu (visible once rows are checked). Native mode calls the API once with
// `{names}`; `per_name` mode loops the names calling the API with `{name}` behind a cancellable
// progress dialog. Labels carry the count ("Resend 12"), the selection is capped (200 by
// default) with a clear message, and every run ends with a result toast + `listview.refresh()`.

import ui from "../_core/index.js";

sanad.ui.BulkActions = class BulkActions {
	/**
	 * @param {Object} opts
	 * @param {Object} opts.listview — a Desk ListView
	 * @param {Array<Object>} opts.actions — `{label: string|Function(count), icon?, method?: apiKey,
	 *   args?: Function(names, {docs, reason}) → extra args, per_name?: boolean, confirm?: Object|Function(names, docs),
	 *   progress?: boolean, condition?: Function(docs), on_done?: Function(result, names), handler?: Function(names, docs),
	 *   cap?: number, roles?: string[], perm?: string, success?: string|Function(result, names)}`
	 * @param {number} [opts.cap=200] — maximum checked rows per run
	 */
	constructor(opts = {}) {
		this.opts = Object.assign({ actions: [], cap: 200 }, opts);
		this.listview = this.opts.listview;
		if (!this.listview) throw new Error("sanad.ui.BulkActions: listview is required");
		this.doctype = this.listview.doctype;
		this.items = [];
		this.mount();
	}

	mount() {
		const lv = this.listview;
		// roles / perm are decided once at mount; `condition(docs)` is re-evaluated per selection
		const allowed = ui.visible_actions(this.opts.actions.map((a) => Object.assign({}, a, { condition: undefined })), null, this.doctype);
		this.opts.actions.filter((a) => allowed.some((x) => x.label === a.label && x.method === a.method)).forEach((action) => {
			const $item = lv.page.add_actions_menu_item(this.label_for(action, 0), () => this.run(action), false);
			$item.addClass("sanad-bulk__item");
			this.items.push({ action, $item });
		});
		// count in the label + condition(docs) whenever the selection changes
		const orig = lv.on_row_checked.bind(lv);
		lv.on_row_checked = (...a) => {
			const r = orig(...a);
			this.update();
			return r;
		};
	}

	label_for(action, count) {
		if (typeof action.label === "function") return action.label(count);
		return count ? __("{0} ({1})", [action.label, ui.format_int(count)]) : action.label;
	}

	update() {
		const docs = this.listview.get_checked_items();
		const count = docs.length;
		this.items.forEach(({ action, $item }) => {
			const $label = $item.find(".menu-item-label");
			($label.length ? $label : $item).text(this.label_for(action, count));
			let show = true;
			if (typeof action.condition === "function") {
				try { show = !!action.condition(docs); } catch (e) { show = false; }
			}
			$item.parent().toggle(show);
		});
		if (count && count !== this._last_count) ui.announce(__("{0} selected", [ui.format_int(count)]));
		this._last_count = count;
	}

	// ---- run -------------------------------------------------------------------------------

	async run(action) {
		const lv = this.listview;
		const docs = lv.get_checked_items();
		const names = docs.map((d) => d.name);
		if (!names.length) {
			sanad.ui.Toast.info(__("Select at least one row first."));
			return;
		}
		const cap = action.cap || this.opts.cap;
		if (names.length > cap) {
			sanad.ui.Toast.warning(__("Select at most {0} rows at a time ({1} selected).", [ui.format_int(cap), ui.format_int(names.length)]));
			return;
		}
		let payload = { reason: null };
		if (action.confirm) {
			const spec = typeof action.confirm === "function" ? action.confirm(names, docs) : action.confirm;
			if (spec) {
				try {
					payload = await sanad.ui.ConfirmDialog.ask(spec);
				} catch (e) {
					return; // cancelled
				}
			}
		}
		lv.disable_list_update = true;
		let result;
		try {
			if (typeof action.handler === "function") {
				result = await action.handler(names, docs, payload);
			} else if (action.per_name) {
				result = await this.run_per_name(action, names, docs, payload);
			} else {
				result = await this.run_native(action, names, docs, payload);
			}
		} catch (err) {
			lv.disable_list_update = false;
			if (err && err.message !== "cancelled") sanad.ui.Toast.error(err);
			return;
		}
		lv.disable_list_update = false;
		if (result !== undefined) this.report(action, result, names);
		lv.clear_checked_items();
		lv.refresh();
		if (typeof action.on_done === "function") action.on_done(result, names);
	}

	run_native(action, names, docs, payload) {
		const extra = typeof action.args === "function" ? action.args(names, { docs, reason: payload.reason }) : {};
		const args = Object.assign({ names }, payload.reason ? { reason: payload.reason } : {}, extra || {});
		return ui.call(action.method, args, { freeze: true, freeze_message: __("Working on {0} rows…", [ui.format_int(names.length)]) });
	}

	/** Sequential loop with a progress dialog: `{count, done[], failed[], cancelled}`. */
	run_per_name(action, names, docs, payload) {
		const total = names.length;
		const result = { count: 0, done: [], failed: [], skipped: [], cancelled: false };
		const label = typeof action.label === "function" ? action.label(total) : action.label;
		let cancelled = false;
		const dialog = new frappe.ui.Dialog({
			title: label,
			fields: [{ fieldtype: "HTML", fieldname: "progress" }],
			size: "small",
			static: true,
			secondary_action_label: __("Stop"),
			secondary_action: () => {
				cancelled = true;
				dialog.set_secondary_action_label(__("Stopping…"));
			},
		});
		dialog.$wrapper.addClass("sanad-kit sanad-bulk__dialog");
		const $p = dialog.get_field("progress").$wrapper;
		// the live region is rendered once; each tick only updates its text and aria-valuenow
		$p.html(`
			<div class="sanad-bulk__progress" role="progressbar" aria-valuemin="0" aria-valuemax="${total}" aria-valuenow="0" aria-label="${ui.escape(label)}">
				<div class="sanad-bulk__bar" style="width:0%"></div>
			</div>
			<div class="sanad-bulk__status" aria-live="polite" aria-atomic="true"></div>`);
		const $bar = $p.find(".sanad-bulk__bar");
		const $meter = $p.find(".sanad-bulk__progress");
		const $status = $p.find(".sanad-bulk__status");
		const render = (i) => {
			$bar.css("width", `${Math.round((i / total) * 100)}%`);
			$meter.attr("aria-valuenow", i);
			$status.text(
				result.failed.length
					? __("{0} of {1} done, {2} failed", [ui.format_int(i), ui.format_int(total), ui.format_int(result.failed.length)])
					: __("{0} of {1} done", [ui.format_int(i), ui.format_int(total)])
			);
		};
		render(0);
		dialog.show();
		const extra = (name, doc) => (typeof action.args === "function" ? action.args([name], { docs: doc ? [doc] : [], reason: payload.reason }) : {});
		const loop = async () => {
			for (let i = 0; i < total; i++) {
				if (cancelled) {
					result.cancelled = true;
					break;
				}
				const name = names[i];
				const doc = docs.find((d) => d.name === name);
				const args = Object.assign({ name }, payload.reason ? { reason: payload.reason } : {}, extra(name, doc) || {});
				try {
					await ui.call(action.method, args, { silent: true });
					result.done.push(name);
					result.count += 1;
				} catch (err) {
					result.failed.push({ name, error: err.message });
				}
				render(i + 1);
			}
			dialog.hide();
			return result;
		};
		return loop();
	}

	report(action, result, names) {
		if (typeof action.success === "function") {
			const msg = action.success(result, names);
			if (msg) sanad.ui.Toast.success(msg);
			return;
		}
		const r = result && typeof result === "object" ? result : {};
		const count = r.count != null ? cint(r.count) : names.length;
		const failed = Array.isArray(r.failed) ? r.failed.length : 0;
		const skipped = Array.isArray(r.skipped) ? r.skipped.length : 0;
		if (failed) {
			sanad.ui.Toast.warning(__("{0} done, {1} failed", [ui.format_int(count), ui.format_int(failed)]));
		} else if (r.cancelled) {
			sanad.ui.Toast.info(__("Stopped after {0} of {1}", [ui.format_int(count), ui.format_int(names.length)]));
		} else {
			const text = typeof action.success === "string" ? action.success : __("{0} of {1} done", [ui.format_int(count), ui.format_int(names.length)]);
			sanad.ui.Toast.success(skipped ? __("{0} ({1} skipped)", [text, ui.format_int(skipped)]) : text);
		}
	}

	destroy() {
		this.items.forEach(({ $item }) => $item.parent().remove());
		this.items = [];
	}
};

export default sanad.ui.BulkActions;

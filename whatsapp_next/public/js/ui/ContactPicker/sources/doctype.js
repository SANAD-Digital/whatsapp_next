// ContactPicker source 3 — a system screen: a DocType from the enabled Picker Sources (the
// `doctypes` of the `list_sources` entry), then **Frappe's own `frappe.ui.FilterGroup`** for that
// DocType (never a re-implementation), then rows through `picker.list_doctype_rows` (server merges
// the mandatory filters and applies the contextual permission layer). "Select all on page" or
// "Add all matching" (page by page with a progress note, capped at MAX_MATCHING rows).

import ui from "../../_core/index.js";
import BaseSource from "./_base.js";

const MAX_MATCHING = 20000;
const BULK_PAGE = 200;

export class DoctypeSource extends BaseSource {
	static get key() {
		return "DocType";
	}

	static label() {
		return __("System screen");
	}

	render() {
		this.page_length = 50;
		this.doctypes = this.entry.doctypes || [];
		const $head = $('<div class="sanad-picker__head"></div>');
		const select_id = ui.uid("dt");
		const $row = $(`<div class="sanad-picker__field"><label for="${select_id}">${ui.escape(__("Screen"))}</label></div>`);
		this.$select = $(`<select class="form-control" id="${select_id}"><option value="">${ui.escape(__("Choose a screen"))}</option></select>`);
		this.doctypes.forEach((d) => this.$select.append(`<option value="${ui.escape(d.document_type)}">${ui.escape(__(d.label || d.document_type))}</option>`));
		this.$select.on("change", () => this.set_doctype(this.$select.val()));
		$row.append(this.$select);
		$head.append($row);
		this.$filters = $('<div class="sanad-picker__filters"></div>');
		this.$results = $('<div class="sanad-picker__results"></div>');
		this.$pager = this.pager((p) => this.reload(p));
		this.$foot = $('<div class="sanad-picker__foot"></div>');
		this.$progress = $('<span class="sanad-picker__note" aria-live="polite"></span>');
		this.$pane.append($head, this.$filters, this.$results, this.$pager, this.$foot, this.$progress);
		this.state = this.state_for(this.$results);
		this.state.empty({ title: __("Choose a screen"), description: __("Then filter its records like any list and add the matching ones.") });
		if (this.doctypes.length === 1) {
			this.$select.val(this.doctypes[0].document_type);
			this.set_doctype(this.doctypes[0].document_type);
		}
	}

	set_doctype(document_type) {
		this.document_type = document_type || null;
		this.$filters.empty();
		this.filter_group = null;
		this.$foot.empty();
		if (!document_type) {
			this.$results.empty();
			this.state = this.state_for(this.$results);
			this.state.empty({ title: __("Choose a screen") });
			return;
		}
		this.state.loading();
		ui.meta.with_doctype(document_type).then(() => {
			if (this.document_type !== document_type) return;
			this.filter_group = new frappe.ui.FilterGroup({
				parent: this.$filters,
				doctype: document_type,
				on_change: ui.debounce(() => this.reload(1), 300),
			});
			this.reload(1);
		});
	}

	get_filters() {
		return this.filter_group ? this.filter_group.get_filters() : [];
	}

	reload(page) {
		if (!this.document_type) return Promise.resolve();
		this.page = page || this.page;
		this.state.loading();
		this.$foot.empty();
		const seq = (this._seq = (this._seq || 0) + 1);
		return this.call("picker.list_doctype_rows", { document_type: this.document_type, filters: this.get_filters(), page: this.page, page_length: this.page_length }, { silent: true })
			.then((r) => {
				if (seq !== this._seq) return;
				this.rows = (r && r.rows) || [];
				this.total = r && r.total != null ? cint(r.total) : null;
				this.$pager.update(this.rows.length, this.total);
				if (!this.rows.length) {
					this.state.empty({ title: __("No matching records"), description: __("Change the filters to widen the search.") });
					return;
				}
				this.state.hide();
				const $table = this.candidate_table(this.rows, { extra_columns: [{ label: __("Record"), format: (row) => ui.escape(row.source_name || "") }] });
				this.$results.html($table);
				const matching_label = this.total != null ? __("Add all {0} matching", [ui.format_int(this.total)]) : __("Add all matching");
				const $matching = $(`<button type="button" class="btn btn-default btn-sm">${ui.escape(matching_label)}</button>`).on("click", () => this.add_all_matching());
				this.$progress.text(this.total != null ? __("{0} matching records", [ui.format_int(this.total)]) : "");
				this.$foot.append($matching, this.add_selected_button($table, { source_type: this.key, source_ref: this.document_type }));
			})
			.catch((err) => {
				if (seq !== this._seq) return;
				this.state.error(err, { action: { label: __("Retry"), onclick: () => this.reload() } });
			});
	}

	async add_all_matching() {
		if (!this.document_type || this.busy) return;
		this.busy = true;
		this.$foot.find(".btn").prop("disabled", true);
		const filters = this.get_filters();
		let page = 1;
		let added = 0;
		let seen = 0;
		try {
			for (;;) {
				this.$progress.text(this.total != null ? __("Loading matching records… {0} of {1}", [ui.format_int(seen), ui.format_int(this.total)]) : __("Loading matching records… {0}", [ui.format_int(seen)]));
				const r = await this.call("picker.list_doctype_rows", { document_type: this.document_type, filters, page, page_length: BULK_PAGE }, { silent: true });
				const rows = (r && r.rows) || [];
				if (r && r.total != null) this.total = cint(r.total);
				seen += rows.length;
				added += this.picker.add_rows(rows, { source_type: this.key, source_ref: this.document_type, quiet: true });
				if (rows.length < BULK_PAGE || (this.total != null && seen >= this.total)) break;
				if (seen >= MAX_MATCHING) {
					sanad.ui.Toast.warning(__("Stopped at {0} records. Narrow the filters to add the rest.", [ui.format_int(MAX_MATCHING)]));
					break;
				}
				page += 1;
			}
			this.$progress.text(__("Added {0} records", [ui.format_int(added)]));
			this.picker.notify_added(added);
		} catch (err) {
			this.$progress.text("");
			sanad.ui.Toast.error(err);
		}
		this.busy = false;
		this.$foot.find(".btn").prop("disabled", false);
	}

	preselect(pre) {
		if (pre && pre.ref && this.doctypes.some((d) => d.document_type === pre.ref)) {
			this.$select.val(pre.ref);
			this.set_doctype(pre.ref);
		}
	}
}

export default DoctypeSource;

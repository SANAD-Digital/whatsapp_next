// ContactPicker remove-mode tab — "Current members / recipients": pages through the target's
// own rows (the picker's `current.method` + `current.args(state)`, defaulting per target), shows
// chips by `source_type`, a search box, checkbox rows and "Select all shown"; the chosen rows go
// to the Selected tab, where the server preview confirms which ones will be removed.

import ui from "../../_core/index.js";
import BaseSource from "./_base.js";

export class CurrentSource extends BaseSource {
	static get key() {
		return "__current";
	}

	static label() {
		return __("Current members");
	}

	render() {
		this.page_length = 50;
		this.source_type = "";
		this.txt = "";
		const cfg = this.picker.current_config();
		this.cfg = cfg;
		const $head = $('<div class="sanad-picker__head"></div>');
		$head.append(this.search_box(__("Search by name or phone"), (txt) => this.reload({ txt })));
		const types = cfg.source_types || [];
		if (types.length) $head.append(this.select_field(__("Source"), types, (v) => this.reload({ source_type: v })));
		this.$results = $('<div class="sanad-picker__results"></div>');
		this.$pager = this.pager((p) => this.reload({ page: p }));
		this.$foot = $('<div class="sanad-picker__foot"></div>');
		this.$pane.append($head, this.$results, this.$pager, this.$foot);
		this.state = this.state_for(this.$results);
		this.reload();
	}

	reload({ txt, source_type, page } = {}) {
		if (txt !== undefined) this.txt = txt;
		if (source_type !== undefined) this.source_type = source_type;
		this.page = page || (txt !== undefined || source_type !== undefined ? 1 : this.page);
		this.state.loading();
		this.$foot.empty();
		const args = this.cfg.args({ page: this.page, page_length: this.page_length, search: this.txt || null, source_type: this.source_type || null });
		return this.call(this.cfg.method, args, { silent: true })
			.then((r) => {
				let rows = (r && r.rows) || [];
				// Client-side narrowing for methods without search / source filters.
				if (!this.cfg.server_filters) {
					const q = this.txt.toLowerCase();
					rows = rows.filter((row) => (!this.source_type || row.source_type === this.source_type) && (!q || String(row.display_name || "").toLowerCase().includes(q) || String(row.phone_e164 || row.phone || "").includes(q)));
				}
				this.rows = rows;
				this.$pager.update(((r && r.rows) || []).length, cint(r && r.total));
				if (!rows.length) {
					const none = this.picker.target_is_group() ? __("No members match") : __("No recipients match");
					this.state.empty({ title: none, description: this.txt || this.source_type ? __("Try a different search or source.") : __("The list is empty.") });
					return;
				}
				this.state.hide();
				const $table = this.candidate_table(rows, { show_source: true, disabled_when: (row) => row.status === "Removed", extra_columns: this.cfg.status_field ? [{ label: __("Status"), format: (row) => (row[this.cfg.status_field] ? sanad.ui.StatusBadge.html({ label: __(row[this.cfg.status_field]), colour: this.cfg.status_colour ? this.cfg.status_colour(row) : "gray" }) : "") }] : [] });
				this.$results.html($table);
				this.$foot.append(this.add_selected_button($table, { source_type: "__current", label: (n) => __("Mark {0} for removal", [ui.format_int(n)]) }));
			})
			.catch((err) => this.state.error(err, { action: { label: __("Retry"), onclick: () => this.reload() } }));
	}
}

export default CurrentSource;

// ContactPicker source — WhatsApp contacts not in the system: numbers the host knows from WhatsApp
// (they messaged, or a device's address book was fetched) that no system Contact carries yet,
// searched by name or number (`picker.search_whatsapp_numbers`) and named as the phone saves them.

import BaseSource from "./_base.js";

export class WhatsAppNumbersSource extends BaseSource {
	static get key() {
		return "WhatsApp Number";
	}

	static label() {
		return __("WhatsApp contacts not in the system");
	}

	render() {
		this.txt = "";
		const $head = $('<div class="sanad-picker__head"></div>');
		$head.append(this.search_box(__("Search by name or phone"), (txt) => this.reload({ txt })));
		this.$results = $('<div class="sanad-picker__results"></div>');
		this.$pager = this.pager((p) => this.reload({ page: p }));
		this.$foot = $('<div class="sanad-picker__foot"></div>');
		this.$pane.append($head, this.$results, this.$pager, this.$foot);
		this.state = this.state_for(this.$results);
		this.reload();
	}

	reload({ txt, page } = {}) {
		if (txt !== undefined) this.txt = txt;
		this.page = page || (txt !== undefined ? 1 : this.page);
		this.state.loading();
		this.$foot.empty();
		return this.call("picker.search_whatsapp_numbers", { txt: this.txt || null, page: this.page, page_length: this.page_length }, { silent: true })
			.then((r) => {
				this.rows = (r && r.rows) || [];
				this.total = r && r.total != null ? cint(r.total) : null;
				this.$pager.update(this.rows.length, this.total);
				if (!this.rows.length) {
					this.state.empty({
						title: __("No WhatsApp contacts outside the system"),
						description: this.txt ? __("Try another name or phone.") : __("Every number known from WhatsApp is already a system contact."),
					});
					return;
				}
				this.state.hide();
				const $table = this.candidate_table(this.rows);
				this.$results.html($table);
				this.$foot.append(this.add_selected_button($table, { source_type: this.key }));
			})
			.catch((err) => this.state.error(err, { action: { label: __("Retry"), onclick: () => this.reload() } }));
	}
}

export default WhatsAppNumbersSource;

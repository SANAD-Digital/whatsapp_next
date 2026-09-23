// ContactPicker source 2 — Contacts: search by name / phone with `link_doctype` chips
// (`picker.search_contacts`, read through the host's contextual permission layer), checkbox rows,
// "Select all on page" and "Add N". Contacts without a phone are listed but not selectable.

import ui from "../../_core/index.js";
import BaseSource from "./_base.js";

export class ContactsSource extends BaseSource {
	static get key() {
		return "Contact";
	}

	static label() {
		return __("Contacts");
	}

	render() {
		this.txt = "";
		this.link_doctype = "";
		const $head = $('<div class="sanad-picker__head"></div>');
		$head.append(this.search_box(__("Search by name or phone"), (txt) => this.reload({ txt })));
		const link_doctypes = this.entry.link_doctypes || this.picker.opts.contact_link_doctypes || [];
		if (link_doctypes.length) {
			$head.append(this.chips(__("Linked to"), link_doctypes.map((d) => ({ value: d, label: __(d) })), (v) => this.reload({ link_doctype: v })));
		}
		this.$results = $('<div class="sanad-picker__results"></div>');
		this.$pager = this.pager((p) => this.reload({ page: p }));
		this.$foot = $('<div class="sanad-picker__foot"></div>');
		this.$pane.append($head, this.$results, this.$pager, this.$foot);
		this.state = this.state_for(this.$results);
		this.reload();
	}

	reload({ txt, link_doctype, page } = {}) {
		if (txt !== undefined) this.txt = txt;
		if (link_doctype !== undefined) this.link_doctype = link_doctype;
		this.page = page || (txt !== undefined || link_doctype !== undefined ? 1 : this.page);
		this.state.loading();
		this.$foot.empty();
		return this.call("picker.search_contacts", { txt: this.txt || null, link_doctype: this.link_doctype || null, page: this.page, page_length: this.page_length }, { silent: true })
			.then((r) => {
				this.rows = (r && r.rows) || [];
				this.total = r && r.total != null ? cint(r.total) : null;
				this.$pager.update(this.rows.length, this.total);
				if (!this.rows.length) {
					this.state.empty({ title: __("No contacts found"), description: this.txt ? __("Try another name or phone.") : __("Type a name or phone to search.") });
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

export default ContactsSource;

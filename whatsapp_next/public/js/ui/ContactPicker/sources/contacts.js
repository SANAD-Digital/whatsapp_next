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
		const link_doctypes = this.entry.link_doctypes || this.picker.opts.contact_link_doctypes || [];
		this.search_pane(
			link_doctypes.length
				? [this.select_field(__("Linked to"), link_doctypes.map((d) => ({ value: d, label: __(d) })), (v) => this.reload({ link_doctype: v }))]
				: []
		);
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

// ContactPicker source 1 — Contact Groups: search box + `kind` chips (options from the group
// DocType's Select meta) → `picker.search_groups`; the user ticks one or more groups and "Add
// members of N groups" loads every page of `picker.get_group_members` (with a progress note) into
// the selection. The target group itself is excluded when the target is a group.

import ui from "../../_core/index.js";
import BaseSource from "./_base.js";

const MEMBER_PAGE = 200;
const PEEK = 10;

export class GroupsSource extends BaseSource {
	static get key() {
		return "Contact Group";
	}

	static label() {
		return __("Contact groups");
	}

	render() {
		this.kind = "";
		this.txt = "";
		this.checked = new Set();
		const $head = $('<div class="sanad-picker__head"></div>');
		$head.append(this.search_box(__("Search groups"), (txt) => this.reload({ txt })));
		this.$kinds = $('<div></div>').appendTo($head);
		this.$results = $('<div class="sanad-picker__results"></div>');
		this.names = {}; // docname → group_name for progress text
		this.$pager = this.pager((p) => this.reload({ page: p }));
		this.$foot = $('<div class="sanad-picker__foot"></div>');
		this.$add = $('<button type="button" class="btn btn-primary btn-sm" disabled></button>').on("click", () => this.add_members());
		this.$progress = $('<span class="sanad-picker__note" aria-live="polite"></span>');
		this.$foot.append(this.$add, this.$progress);
		this.$pane.append($head, this.$results, this.$pager, this.$foot);
		this.state = this.state_for(this.$results);
		this.load_kinds().then(() => this.reload());
		this.update_add();
	}

	load_kinds() {
		const doctype = this.entry.doctype || this.picker.opts.group_doctype;
		if (!doctype) return Promise.resolve();
		return ui.meta
			.with_doctype(doctype)
			.then((meta) => {
				const df = (meta.fields || []).find((f) => f.fieldname === "kind" && f.fieldtype === "Select");
				const kinds = df ? (df.options || "").split("\n").filter(Boolean) : [];
				if (kinds.length) this.$kinds.append(this.chips(__("Kind"), kinds, (kind) => this.reload({ kind })));
			})
			.catch(() => {});
	}

	reload({ txt, kind, page } = {}) {
		if (txt !== undefined) this.txt = txt;
		if (kind !== undefined) this.kind = kind;
		this.page = page || (txt !== undefined || kind !== undefined ? 1 : this.page);
		this.state.loading();
		const exclude = this.picker.target_is_group() ? this.picker.target_name : null;
		return this.call("picker.search_groups", { txt: this.txt || null, kind: this.kind || null, exclude, page: this.page, page_length: this.page_length }, { silent: true })
			.then((r) => {
				this.rows = (r && r.rows) || [];
				this.total = cint(r && r.total);
				this.$pager.update(this.rows.length, this.total);
				this.rows.forEach((g) => (this.names[g.name] = g.group_name || g.name));
				ui.announce(ui.plural(this.rows.length, { one: __("{0} group found"), other: __("{0} groups found") }));
				if (!this.rows.length) {
					const doctype = this.entry.doctype || this.picker.opts.group_doctype;
					const can_create = doctype && frappe.model.can_create(doctype);
					this.state.empty({
						title: __("No groups found"),
						description: this.txt ? __("Try another name.") : __("Create a contact group first."),
						action: !this.txt && can_create ? { label: __("New contact group"), onclick: () => frappe.new_doc(doctype) } : undefined,
					});
					return;
				}
				this.state.hide();
				this.render_rows();
			})
			.catch((err) => this.state.error(err, { action: { label: __("Retry"), onclick: () => this.reload() } }));
	}

	render_rows() {
		const $list = $('<ul class="sanad-picker__groups" role="list"></ul>');
		this.rows.forEach((g) => {
			const name = g.group_name || g.name;
			const peek_id = ui.uid("peek");
			const $li = $(`
				<li class="sanad-picker__group" data-name="${ui.escape(g.name)}">
					<label class="sanad-picker__group-main">
						<input type="checkbox" class="sanad-picker__check" ${this.checked.has(g.name) ? "checked" : ""}>
						<span class="sanad-picker__group-name">${ui.escape(name)}</span>
						${g.kind ? sanad.ui.StatusBadge.html({ label: __(g.kind), colour: g.kind === "Blacklist" ? "red" : "gray", icon: false }) : ""}
						<span class="sanad-picker__group-count sanad-tabular">${ui.escape(__("{0} members", [ui.format_int(g.member_count || 0)]))}</span>
					</label>
					<button type="button" class="btn btn-xs btn-default sanad-picker__peek" aria-expanded="false" aria-controls="${peek_id}">${ui.escape(__("Show members"))}</button>
					<div class="sanad-picker__peek-body" id="${peek_id}" hidden></div>
				</li>`);
			$li.find(".sanad-picker__check").on("change", (e) => {
				if (e.target.checked) this.checked.add(g.name);
				else this.checked.delete(g.name);
				this.update_add();
			});
			$li.find(".sanad-picker__peek").on("click", (e) => this.peek(g, $(e.currentTarget), $li.find(".sanad-picker__peek-body")));
			$list.append($li);
		});
		this.$results.html($list);
	}

	peek(group, $btn, $body) {
		const open = $btn.attr("aria-expanded") === "true";
		if (open) {
			$btn.attr("aria-expanded", "false").text(__("Show members"));
			$body.attr("hidden", true);
			return;
		}
		$btn.attr("aria-expanded", "true").text(__("Hide members"));
		$body.removeAttr("hidden");
		const st = this.state_for($body);
		this.call("picker.get_group_members", { group: group.name, page: 1, page_length: PEEK }, { silent: true })
			.then((r) => {
				const rows = (r && r.rows) || [];
				if (!rows.length) return st.empty({ title: __("This group has no members") });
				st.hide();
				$body.html(this.candidate_table(rows, { selectable: false }));
				if (r.total > PEEK) $body.append(`<div class="sanad-picker__note">${ui.escape(__("Showing {0} of {1}", [PEEK, ui.format_int(r.total)]))}</div>`);
			})
			.catch((err) => st.error(err));
	}

	update_add() {
		const n = this.checked.size;
		this.$add.prop("disabled", !n).text(ui.plural(n, { one: __("Add members of {0} group"), two: __("Add members of {0} groups"), few: __("Add members of {0} groups"), many: __("Add members of {0} groups"), other: __("Add members of {0} groups") }));
	}

	async add_members() {
		const groups = Array.from(this.checked);
		if (!groups.length) return;
		this.$add.prop("disabled", true);
		let added = 0;
		try {
			for (const group of groups) {
				let page = 1;
				let total = null;
				for (;;) {
					this.$progress.text(__("Loading members of {0}: {1} of {2}", [this.names[group] || group, ui.format_int(total != null ? Math.min((page - 1) * MEMBER_PAGE, total) : 0), total != null ? ui.format_int(total) : "…"]));
					const r = await this.call("picker.get_group_members", { group, page, page_length: MEMBER_PAGE }, { silent: true });
					const rows = (r && r.rows) || [];
					total = cint(r && r.total);
					added += this.picker.add_rows(rows, { source_type: this.key, source_ref: groups.length === 1 ? group : null, quiet: true });
					if (!rows.length || page * MEMBER_PAGE >= total) break;
					page += 1;
				}
			}
			this.$progress.text(__("Added {0} members", [ui.format_int(added)]));
			this.picker.notify_added(added);
			this.checked.clear();
			this.$results.find(".sanad-picker__check").prop("checked", false);
		} catch (err) {
			this.$progress.text("");
			sanad.ui.Toast.error(err);
		}
		this.update_add();
	}

	preselect(pre) {
		if (!pre || !pre.ref) return;
		this.checked.add(pre.ref);
		this.update_add();
		return this.add_members();
	}
}

export default GroupsSource;

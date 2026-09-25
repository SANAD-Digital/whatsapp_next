// ContactPicker source 1 — Contact Groups: search box + a `kind` dropdown (options from the group
// DocType's Select meta) → `picker.search_groups`; the user ticks one or more groups and "Add
// members of N groups" loads every page of `picker.get_group_members` (with a progress note) into
// the selection. "Show members" opens the group in a window of its own: every member, a search,
// select all / select the matches / show the chosen, and "Add N" for the ones ticked — so a group
// can also be taken in part. The target group itself is excluded when the target is a group.

import ui from "../../_core/index.js";
import BaseSource from "./_base.js";

const MEMBER_PAGE = 200;
const RENDER_STEP = 300;

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
		this.$kinds = $('<div class="sanad-picker__head-dd"></div>').appendTo($head);
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
				if (kinds.length) this.$kinds.append(this.select_field(__("Kind"), kinds, (kind) => this.reload({ kind })));
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
		const $list = $('<div class="sanad-picker__list sanad-picker__groups" role="group"></div>');
		const $rows = $('<div class="sanad-picker__rows"></div>').appendTo($list);
		this.rows.forEach((g) => {
			const name = g.group_name || g.name;
			const on = this.checked.has(g.name);
			const blacklist = g.kind === "Blacklist";
			const $li = $(`
				<div class="sanad-picker__group" data-name="${ui.escape(g.name)}">
					<div class="sanad-picker__row" role="checkbox" aria-checked="${on}" tabindex="0">
						<span class="sanad-picker__av" aria-hidden="true">${ui.escape(ui.initials(name) || "#")}</span>
						<span class="sanad-picker__row-text">
							<span class="sanad-picker__row-name" dir="auto">${ui.escape(name)}</span>
							<span class="sanad-picker__row-sub">${ui.escape(ui.plural(cint(g.member_count), { one: __("{0} member"), two: __("{0} members"), few: __("{0} members"), many: __("{0} members"), other: __("{0} members") }))}</span>
						</span>
						${g.kind ? `<span class="sanad-picker__row-badge${blacklist ? " sanad-picker__row-badge--warn" : ""}">${ui.escape(__(g.kind))}</span>` : ""}
						<button type="button" class="sanad-picker__peek">${ui.escape(__("Show members"))}</button>
						<span class="sanad-picker__mark" aria-hidden="true">${ui.icon("es-line-check", "xs")}</span>
					</div>
				</div>`);
			const $row = $li.find(".sanad-picker__row");
			const toggle = () => {
				if (this.checked.has(g.name)) this.checked.delete(g.name);
				else this.checked.add(g.name);
				$row.attr("aria-checked", this.checked.has(g.name));
				this.update_add();
			};
			$row.on("click", (e) => {
				if ($(e.target).closest(".sanad-picker__peek").length) return;
				toggle();
			});
			$row.on("keydown", (e) => {
				if ((e.key === " " || e.key === "Enter") && e.target === $row[0]) {
					e.preventDefault();
					toggle();
				}
			});
			$li.find(".sanad-picker__peek").on("click", () => this.open_members(g));
			$rows.append($li);
		});
		this.$results.html($list);
	}

	/**
	 * The group in a window of its own: every member, searchable, each row a choice; "Select all",
	 * "Select the matches" (what the search shows), "Show selected"; "Add N" hands the ticked
	 * members to the picker under this group's name.
	 */
	open_members(group) {
		const name = group.group_name || group.name;
		const rows = [];
		const chosen = new Map(); // key → row
		let query = "";
		let only_chosen = false;
		let limit = RENDER_STEP;
		let loaded = false;
		const key_of = (r) => r.phone_e164 || (r.phone ? `raw:${String(r.phone).trim()}` : null) || r.source_name || r.contact || "";
		const dialog = new frappe.ui.Dialog({
			title: __("Members of {0}", [name]),
			size: "large",
			fields: [{ fieldtype: "HTML", fieldname: "body" }],
			primary_action_label: __("Add"),
			primary_action: () => {
				const picked = Array.from(chosen.values());
				if (!picked.length) return;
				this.picker.add_rows(picked, { source_type: this.key, source_ref: group.name });
				dialog.hide();
			},
			secondary_action_label: __("Close"),
			secondary_action: () => dialog.hide(),
		});
		dialog.$wrapper.removeClass("fade").addClass("sanad-kit sanad-picker-dialog sanad-picker-members");
		const $primary = dialog.get_primary_btn().prop("disabled", true);
		const $body = dialog.get_field("body").$wrapper;
		$body.html(`
			<div class="sanad-picker__members">
				<div class="sanad-picker__head">
					<label class="sanad-picker__search"><span class="sanad-picker__search-icon" aria-hidden="true">${ui.icon("es-line-search", "sm")}</span><input type="search" class="sanad-picker__search-input" placeholder="${ui.escape(__("Search by name or phone"))}" aria-label="${ui.escape(__("Search by name or phone"))}"></label>
				</div>
				<div class="sanad-picker__members-bar">
					<button type="button" class="btn btn-default btn-xs" data-act="all">${ui.escape(__("Select all"))}</button>
					<button type="button" class="btn btn-default btn-xs" data-act="matches" hidden>${ui.escape(__("Select the matches"))}</button>
					<button type="button" class="btn btn-default btn-xs" data-act="none" hidden>${ui.escape(__("Clear selection"))}</button>
					<button type="button" class="btn btn-default btn-xs sanad-picker__members-show" data-act="show" aria-pressed="false" hidden>${ui.escape(__("Show selected"))} <span class="sanad-tabular" data-n></span></button>
					<span class="sanad-picker__note sanad-picker__members-count" aria-live="polite"></span>
				</div>
				<div class="sanad-picker__results sanad-picker__members-list"></div>
			</div>`);
		const $search = $body.find("input");
		const $list = $body.find(".sanad-picker__members-list");
		const $count = $body.find(".sanad-picker__members-count");
		const $show = $body.find('[data-act="show"]');
		const state = this.state_for($list);

		const matches = (r) => {
			if (!query) return true;
			const q = query.toLowerCase();
			return String(r.display_name || "").toLowerCase().includes(q) || String(r.phone_e164 || r.phone || "").includes(q);
		};
		const visible = () => rows.filter((r) => (!only_chosen || chosen.has(key_of(r))) && matches(r));
		const reflect = () => {
			const n = chosen.size;
			$primary.text(n ? __("Add {0}", [ui.format_int(n)]) : __("Add")).prop("disabled", !n);
			$show.prop("hidden", !n && !only_chosen).attr("aria-pressed", only_chosen).find("[data-n]").text(n ? ui.format_int(n) : "");
			$body.find('[data-act="none"]').prop("hidden", !n);
			$body.find('[data-act="matches"]').prop("hidden", !query);
			$count.text(n ? __("{0} selected", [ui.format_int(n)]) : "");
		};
		const render = () => {
			if (!loaded) return;
			const shown = visible();
			if (!rows.length) {
				$list.empty();
				return state.empty({ title: __("This group has no members") });
			}
			if (!shown.length) {
				$list.empty();
				return state.empty({ title: only_chosen ? __("Nothing selected yet") : __("No match for {0}", [query]), description: only_chosen ? __("Tick members to choose them.") : "" });
			}
			state.hide();
			let html = '<div class="sanad-picker__list" role="group"><div class="sanad-picker__rows">';
			shown.slice(0, limit).forEach((r) => {
				const key = key_of(r);
				const person = r.display_name || r.source_name || r.contact || "";
				const phone = r.phone_e164 || r.phone || "";
				const on = chosen.has(key);
				html += `<div class="sanad-picker__row" role="checkbox" aria-checked="${on}" tabindex="0" data-key="${ui.escape(key)}">
					<span class="sanad-picker__av" aria-hidden="true">${ui.escape(ui.initials(person || phone) || "#")}</span>
					<span class="sanad-picker__row-text">
						<span class="sanad-picker__row-name" dir="auto">${ui.escape(person || phone)}</span>
						${person && phone ? `<span class="sanad-picker__row-sub sanad-tabular" dir="ltr">${ui.escape(phone)}</span>` : ""}
					</span>
					<span class="sanad-picker__mark" aria-hidden="true">${ui.icon("es-line-check", "xs")}</span>
				</div>`;
			});
			html += "</div></div>";
			$list.html(html);
			if (shown.length > limit) {
				$(`<button type="button" class="btn btn-default btn-sm sanad-picker__more">${ui.escape(__("Show {0} more", [ui.format_int(Math.min(RENDER_STEP, shown.length - limit))]))}</button>`)
					.on("click", () => {
						limit += RENDER_STEP;
						render();
					})
					.appendTo($list);
			}
			reflect();
		};
		const toggle = (el) => {
			const key = el.dataset.key;
			const row = rows.find((r) => key_of(r) === key);
			if (!row) return;
			if (chosen.has(key)) chosen.delete(key);
			else chosen.set(key, row);
			el.setAttribute("aria-checked", chosen.has(key) ? "true" : "false");
			reflect();
		};
		$list.on("click", ".sanad-picker__row", (e) => toggle(e.currentTarget));
		$list.on("keydown", ".sanad-picker__row", (e) => {
			if (e.key === " " || e.key === "Enter") {
				e.preventDefault();
				toggle(e.currentTarget);
			}
		});
		$search.on("input", ui.debounce(() => {
			query = $search.val().trim();
			limit = RENDER_STEP;
			render();
		}, 200));
		$body.on("click", "[data-act]", (e) => {
			const act = e.currentTarget.dataset.act;
			if (act === "all") rows.forEach((r) => chosen.set(key_of(r), r));
			else if (act === "matches") visible().forEach((r) => chosen.set(key_of(r), r));
			else if (act === "none") chosen.clear();
			else if (act === "show") only_chosen = !only_chosen;
			render();
		});
		dialog.show();
		$search.trigger("focus");

		// every member, page by page, with the count growing as they arrive
		(async () => {
			let page = 1;
			let total = null;
			try {
				for (;;) {
					$count.text(__("Loading members of {0}: {1} of {2}", [name, ui.format_int(rows.length), total != null ? ui.format_int(total) : "…"]));
					const r = await this.call("picker.get_group_members", { group: group.name, page, page_length: MEMBER_PAGE }, { silent: true });
					const got = (r && r.rows) || [];
					total = cint(r && r.total);
					rows.push(...got);
					if (!got.length || page * MEMBER_PAGE >= total) break;
					page += 1;
				}
				loaded = true;
				$count.text("");
				render();
			} catch (err) {
				state.error(err);
			}
		})();
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
			this.$results.find(".sanad-picker__row").attr("aria-checked", "false");
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

// Contact groups — the quick create / edit window, the port of `docs/component/Group Editor.dc.html`.
// `whatsapp_next.groups.open(name)` opens a saved group, `open()` a new one. An OverlayPanel modal
// in the prototype's two columns: the group's own fields and a members summary at the start; the
// members themselves at the end — "add from" buttons that open the ContactPicker in local mode on
// one of its sources, a search, and one row per number (new ones tagged, removed ones struck out
// with an undo). Nothing is written until Save: `groups.save_editor` creates or updates the group
// and applies the removals and additions in one request.

frappe.provide("whatsapp_next.groups");

(function () {
	const DOCTYPE = "WhatsApp Contact Group";
	const PAGE = 100;
	const esc = (v) => sanad.ui.escape(v == null ? "" : v);
	const fmt = (n) => sanad.ui.format_int(n);
	const key_of = (row) => row.phone_e164 || row.phone || "";
	const call = (method, args) => sanad.ui.call(`groups.${method}`, args || {}, { silent: true });

	// the picker's sources, as the prototype's "add from" tabs; "More" opens the picker on its rail
	const SOURCES = [
		{ source: "contacts", label: __("Contacts"), icon: "users" },
		{ source: "groups", label: __("Another group"), icon: "cards" },
		{ source: "excel", label: __("Excel or CSV file"), icon: "attach" },
		{ source: "manual", label: __("Type numbers"), icon: "note" },
	];

	whatsapp_next.groups.open = function (name, { on_saved, preselect } = {}) {
		return call("get_editor", name ? { name } : {}).then(
			(r) => new GroupEditor(r, { on_saved, preselect }),
			(err) => sanad.ui.Toast.error(err)
		);
	};

	class GroupEditor {
		constructor(data, { on_saved, preselect }) {
			this.group = data.group;
			this.kinds = data.kinds || [];
			this.can_write = data.can_write !== false;
			this.editing = !!this.group.name;
			this.on_saved = on_saved;
			this.existing = []; // saved members loaded so far (paged)
			this.total = this.editing ? cint(this.group.member_count) : 0;
			this.page = 0;
			this.added = new Map(); // key → picker row, not saved yet
			this.removed = new Set(); // saved keys marked for removal
			this.query = "";
			this.make();
			if (this.editing && this.total) this.load_more();
			else this.render_members();
			if (preselect && this.can_write) this.pick(preselect);
		}

		make() {
			const g = this.group;
			const kind_options = this.kinds.map((k) => ({ value: k, label: __(k) }));
			this.panel = new sanad.ui.OverlayPanel({
				type: "modal",
				width: "1080px",
				title: this.editing ? __("Edit «{0}»", [g.group_name || g.name]) : __("New contact group"),
				subtitle: __("Add members from contacts, another group, a file or typed numbers."),
				badge: this.badge(g.kind, g.disabled),
				sections: [
					{
						fields: [
							{ key: "group_name", label: __("Group name"), required: true, value: g.group_name, placeholder: __("Example: Riyadh customers") },
							{ key: "kind", label: __("Group kind"), type: "select", required: true, value: g.kind, options: kind_options, on_change: (v, p) => this.on_kind(v, p) },
							{ key: "description", label: __("Note (optional)"), type: "textarea", rows: 3, value: g.description, placeholder: __("Why this group exists and when it is used.") },
							this.editing ? { key: "disabled", label: __("Disabled — not offered when choosing recipients"), type: "toggle", value: !!cint(g.disabled), on_change: (v, p) => p.set_badge(this.badge(p.get_value("kind"), v)) } : null,
							{ key: "summary", type: "html", render: ($el) => (this.$summary = $el) },
						].filter(Boolean),
						cols: 1,
					},
					{ fields: [{ key: "members", type: "html", render: ($el) => this.make_members($el) }], cols: 1 },
				],
				actions: [
					this.editing ? { key: "form", label: __("Open full form"), variant: "ghost", align: "start", handler: () => frappe.set_route("Form", DOCTYPE, g.name), validate: false } : null,
					{ key: "cancel", label: __("Cancel"), close: true },
					this.can_write ? { key: "save", label: this.editing ? __("Save") : __("Create group"), variant: "primary", requires_dirty: this.editing, handler: (values) => this.save(values) } : null,
				].filter(Boolean),
			});
			this.panel.$root.addClass("wa-ge");
			this.$blacklist = $(`<div class="sanad-op__note sanad-op__note--warn" hidden>${esc(__("A blacklist blocks its members from every command, campaign and quick send."))}</div>`).appendTo(
				this.panel.field("kind").$el
			);
			this.$blacklist.prop("hidden", g.kind !== "Blacklist");
			if (!this.can_write) this.panel.$root.find(".sanad-op__body :input").prop("disabled", true);
			this.panel.show();
		}

		badge(kind, disabled) {
			if (cint(disabled)) return { text: __("Disabled"), tone: "muted" };
			return kind === "Blacklist" ? { text: __("Blacklist"), tone: "danger" } : null;
		}

		on_kind(kind, panel) {
			this.$blacklist.prop("hidden", kind !== "Blacklist");
			panel.set_badge(this.badge(kind, panel.get_value("disabled")));
		}

		// ---- members pane ----------------------------------------------------------------------

		make_members($el) {
			$el.addClass("wa-ge__members").html(`
				<div class="wa-ge__bar">
					<span class="wa-ge__bar-label">${esc(__("Add from"))}</span>
					<div class="wa-ge__sources"></div>
				</div>
				<div class="wa-ge__tools">
					<input type="search" class="wa-input wa-ge__search" placeholder="${esc(__("Search the members by name or number…"))}" aria-label="${esc(__("Search the members"))}">
				</div>
				<div class="wa-ge__list" role="list" aria-live="polite"></div>
				<div class="wa-ge__foot">
					<span class="wa-ge__foot-label">${esc(__("Members"))} <span class="wa-ge__foot-count sanad-tabular"></span></span>
					<span class="wa-ge__foot-note"></span>
					<span class="wa-ge__foot-actions"></span>
				</div>`);
			const $sources = $el.find(".wa-ge__sources");
			SOURCES.forEach((s) => {
				$(sanad.kit.btn({ label: s.label, icon: s.icon, variant: "tonal", size: "sm", disabled: !this.can_write }))
					.on("click", () => this.pick({ source: s.source }))
					.appendTo($sources);
			});
			$(sanad.kit.btn({ label: __("More sources"), variant: "ghost", size: "sm", disabled: !this.can_write }))
				.on("click", () => this.pick())
				.appendTo($sources);
			this.$list = $el.find(".wa-ge__list");
			this.$count = $el.find(".wa-ge__foot-count");
			this.$note = $el.find(".wa-ge__foot-note");
			this.$foot_actions = $el.find(".wa-ge__foot-actions");
			$el.find(".wa-ge__search").on(
				"input",
				frappe.utils.debounce((e) => {
					this.query = String(e.target.value || "").trim().toLowerCase();
					this.render_members();
				}, 150)
			);
			this.$list.on("click", "[data-act]", (e) => {
				const $b = $(e.currentTarget);
				this.act($b.attr("data-act"), $b.closest("[data-key]").attr("data-key"));
			});
		}

		load_more() {
			this.loading = true;
			this.render_members();
			return sanad.ui
				.call("picker.get_group_members", { group: this.group.name, page: this.page + 1, page_length: PAGE }, { silent: true })
				.then((r) => {
					this.page += 1;
					this.existing = this.existing.concat((r && r.rows) || []);
					this.total = cint(r && r.total);
				})
				.catch((err) => (this.load_error = err))
				.finally(() => {
					this.loading = false;
					this.render_members();
				});
		}

		/** Open the ContactPicker in local mode; what it hands back joins the unsaved additions. */
		pick(preselect) {
			const existing = this.existing.map(key_of).filter((k) => !this.removed.has(k)).concat(Array.from(this.added.keys()));
			new sanad.ui.ContactPicker({
				title: __("Add members"),
				existing,
				preselect,
				on_pick: (rows) => {
					rows.forEach((row) => {
						const k = key_of(row);
						if (!k) return;
						// a saved member marked for removal and picked again simply stays
						if (this.removed.delete(k)) return;
						if (!this.existing.some((m) => key_of(m) === k)) this.added.set(k, row);
					});
					this.changed();
				},
			});
		}

		act(action, k) {
			if (action === "drop") this.added.delete(k);
			else if (action === "remove") this.removed.add(k);
			else if (action === "undo") this.removed.delete(k);
			this.changed();
		}

		clear_all() {
			this.added.clear();
			this.existing.forEach((m) => this.removed.add(key_of(m)));
			this.changed();
		}

		changed() {
			// member changes count as unsaved changes: a value no field shows, compared by the panel
			const sig = this.added.size || this.removed.size ? `${Array.from(this.added.keys()).sort()}|${Array.from(this.removed).sort()}` : "";
			this.panel.set_value("_members", sig);
			this.render_members();
		}

		row_html(m, state) {
			// a number with no name reads as the number itself, under a person icon, not "No name"
			const name = m.display_name || "";
			const phone = sanad.ui.phone(key_of(m));
			const tag =
				state === "new"
					? sanad.kit.badge(__("New"), "ok", { dot: false })
					: state === "removed"
						? sanad.kit.badge(__("Will be removed"), "danger", { dot: false })
						: m.contact
							? sanad.kit.badge(__("Contact"), "info", { dot: false })
							: "";
			const act =
				state === "new"
					? { act: "drop", icon: "x", title: __("Do not add") }
					: state === "removed"
						? { act: "undo", label: __("Undo"), title: __("Keep this member") }
						: { act: "remove", icon: "trash", title: __("Remove from the group") };
			return `<div class="wa-ge__row wa-ge__row--${state}" role="listitem" data-key="${esc(key_of(m))}">
				${name ? sanad.kit.avatar({ name, size: "sm", square: true }) : `<span class="wa-avatar wa-avatar--sm wa-avatar--sq" aria-hidden="true">${sanad.kit.ico("user", "sm")}</span>`}
				<span class="wa-ge__row-main">
					${name ? `<span class="wa-ge__row-name">${esc(name)}${sanad.ui.group_tag(key_of(m))}</span>` : ""}
					<span class="wa-ge__row-phone${name ? "" : " wa-ge__row-phone--main"} sanad-tabular" dir="ltr">${esc(phone)}${name ? "" : sanad.ui.group_tag(key_of(m))}</span>
				</span>
				${tag}
				${this.can_write ? sanad.kit.btn({ label: act.label, icon: act.icon, title: act.title, variant: "ghost", size: "sm", attrs: { "data-act": act.act } }) : ""}
			</div>`;
		}

		render_members() {
			if (!this.$list) return;
			const q = this.query;
			const match = (m) => !q || String(m.display_name || "").toLowerCase().includes(q) || key_of(m).includes(q.replace(/[\s\-()]/g, ""));
			const added = Array.from(this.added.values()).filter(match);
			const saved = this.existing.filter(match);
			let html = added.map((m) => this.row_html(m, "new")).join("");
			html += saved.map((m) => this.row_html(m, this.removed.has(key_of(m)) ? "removed" : "saved")).join("");
			this.$list.html(html);

			if (this.loading) {
				this.$list.append(`<div class="wa-ge__more">${sanad.ui.skeleton(3)}</div>`);
			} else if (this.load_error) {
				new sanad.ui.EmptyState({ wrapper: $('<div class="wa-ge__more"></div>').appendTo(this.$list), state: "error", size: "sm", description: this.load_error.message, action: { label: __("Retry"), onclick: () => ((this.load_error = null), this.load_more()) } });
			} else if (this.existing.length < this.total) {
				$(`<div class="wa-ge__more">${sanad.kit.btn({ label: __("Show more members ({0} of {1})", [fmt(this.existing.length), fmt(this.total)]), variant: "secondary", size: "sm" })}</div>`)
					.on("click", "button", () => this.load_more())
					.appendTo(this.$list);
			} else if (!added.length && !saved.length) {
				this.$list.html(
					`<div class="wa-ge__empty">${esc(q ? __("No member matches this search.") : __("No members yet. Add them from contacts, another group, a file or typed numbers."))}</div>`
				);
			}
			this.render_summary();
		}

		render_summary() {
			const adding = this.added.size;
			const removing = this.removed.size;
			const after = this.total + adding - removing;
			this.$count.text(fmt(after));
			const parts = [];
			if (adding) parts.push(__("{0} to add", [fmt(adding)]));
			if (removing) parts.push(__("{0} to remove", [fmt(removing)]));
			this.$note.text(parts.join(" · "));
			this.$foot_actions.empty();
			if (this.can_write && after > 0 && this.existing.length >= this.total) {
				$(sanad.kit.btn({ label: __("Remove all"), variant: "ghost", size: "sm", cls: "wa-ge__clear" }))
					.on("click", () => this.clear_all())
					.appendTo(this.$foot_actions);
			}
			if (!this.$summary) return;
			const line = (k, v, cls = "") => `<div class="wa-ge__sum-row ${cls}"><dt>${esc(k)}</dt><dd class="sanad-tabular" dir="ltr">${esc(v)}</dd></div>`;
			this.$summary.html(`<section class="wa-ge__sum" aria-label="${esc(__("Members summary"))}">
				<span class="wa-ge__sum-title">${esc(__("Members summary"))}</span>
				<dl>
					${this.editing ? line(__("Members now"), fmt(this.total)) : ""}
					${line(__("To add"), adding ? `+${fmt(adding)}` : "0", adding ? "wa-ge__sum-row--ok" : "")}
					${this.editing ? line(__("To remove"), removing ? `−${fmt(removing)}` : "0", removing ? "wa-ge__sum-row--dg" : "") : ""}
					${line(__("After saving"), fmt(after), "wa-ge__sum-row--total")}
				</dl>
			</section>`);
		}

		// ---- save ------------------------------------------------------------------------------

		save(values) {
			const payload = {
				group_name: values.group_name,
				kind: values.kind,
				description: values.description,
				add: Array.from(this.added.values()),
				remove: Array.from(this.removed),
			};
			if (this.editing) Object.assign(payload, { name: this.group.name, modified: this.group.modified, disabled: values.disabled ? 1 : 0 });
			return call("save_editor", { payload }).then((r) => {
				const bits = [];
				if (r.added) bits.push(__("{0} added", [fmt(r.added)]));
				if (r.removed) bits.push(__("{0} removed", [fmt(r.removed)]));
				if (r.skipped) bits.push(__("{0} skipped (already in the group or invalid)", [fmt(r.skipped)]));
				sanad.ui.Toast.success(bits.join(" · ") || __(values.group_name), { title: this.editing ? __("Group saved") : __("Group created") });
				if (typeof this.on_saved === "function") this.on_saved(r);
				const list = typeof cur_list !== "undefined" && cur_list && cur_list.doctype === DOCTYPE ? cur_list : null;
				if (list) {
					list.refresh();
					list.sanad_header && list.sanad_header.refresh(true);
				}
			});
		}
	}

	whatsapp_next.groups.GroupEditor = GroupEditor;
})();

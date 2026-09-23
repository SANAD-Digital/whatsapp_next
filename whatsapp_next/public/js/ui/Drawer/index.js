// sanad.ui.Drawer — an inline-end side panel to inspect (`record`), edit (`form`) or pick
// (`choice`) without leaving the list. Meta-driven: the header badge comes from the DocType's
// indicator rules, `record` fields default to `sanad.ui.meta.preview_fields(meta)` and values
// go through `sanad.ui.meta.format`; `form` fields are real Frappe controls. Payload from a
// configured API key (`method`) or `frappe.client.get_value` with the explicit field list.
// Built on the shared `.sanad-panel` shell; one overlay at a time through `sanad.ui.overlay`;
// Escape closes, focus is trapped inside and restored to the opener (or the list row).

import ui from "../_core/index.js";

const LONG_TYPES = ["Text", "Small Text", "Long Text", "Text Editor", "Markdown Editor", "Code", "JSON", "HTML Editor"];

sanad.ui.Drawer = class Drawer {
	/**
	 * @param {Object} opts
	 * @param {string} opts.doctype
	 * @param {string} [opts.name] — record name (`record` / `form` edit)
	 * @param {"record"|"form"|"choice"} [opts.mode="record"]
	 * @param {Array<string|Object>} [opts.fields] — fieldnames or docfield-like objects (default: preview fields from meta)
	 * @param {string} [opts.method] — api key returning the record payload (default: `frappe.client.get_value`)
	 * @param {Function|Object} [opts.args] — args for `method` (default `{name}`)
	 * @param {Object} [opts.doc] — a payload to render without fetching
	 * @param {string} [opts.title] — default: the doc's title field / name
	 * @param {string} [opts.subtitle]
	 * @param {Array<{label: string, icon?: string, handler: Function, primary?: boolean, danger?: boolean, condition?: Function, perm?: string, roles?: string[]}>} [opts.actions]
	 * @param {Array<{label: string, render: Function($el, doc), condition?: Function}>} [opts.sections] — extra blocks under the fields (`record`)
	 * @param {Function} [opts.on_save] — `form` mode: `(values, doc) => Promise` (the drawer closes on resolve)
	 * @param {string} [opts.save_label]
	 * @param {Array<{label: string, description?: string, value: any, icon?: string}>} [opts.choices] — `choice` mode
	 * @param {Function} [opts.on_choose] — `(value, choice) => void`
	 * @param {Function} [opts.on_close]
	 * @param {number|string} [opts.width] — panel width (default 520px)
	 * @param {boolean} [opts.open_link=true] — header link to the form when `name` is set
	 * @param {Object} [opts.listview] — the list the drawer was opened from (focus falls back to its row)
	 */
	constructor(opts = {}) {
		this.opts = Object.assign({ mode: "record", actions: [], sections: [], choices: [], open_link: true }, opts);
		if (!this.opts.doctype && this.opts.mode !== "choice") throw new Error("sanad.ui.Drawer: doctype is required");
		this.doctype = this.opts.doctype;
		this.doc = this.opts.doc || null;
		this.id = ui.uid("drawer");
		this.controls = {};
		this.make();
	}

	// ---- shell -----------------------------------------------------------------------------

	make() {
		const width = this.opts.width ? (typeof this.opts.width === "number" ? `${this.opts.width}px` : this.opts.width) : "";
		this.$backdrop = $(`<div class="sanad-backdrop sanad-drawer__backdrop" hidden></div>`).appendTo(document.body);
		this.$root = $(`
			<aside class="sanad-kit sanad-panel sanad-drawer sanad-drawer--${this.opts.mode}" role="dialog" aria-modal="true" aria-labelledby="${this.id}-title" hidden${width ? ` style="--sanad-panel-width:${ui.escape(width)}"` : ""}>
				<header class="sanad-panel__header">
					<div class="sanad-panel__title sanad-drawer__heading">
						<h2 class="sanad-drawer__title" id="${this.id}-title"></h2>
						<div class="sanad-drawer__meta"></div>
					</div>
					<div class="sanad-drawer__tools">
						<a class="btn btn-sm btn-default sanad-drawer__open" hidden>${ui.icon(ui.icons.open, "xs")} <span>${ui.escape(__("Open"))}</span></a>
						<button type="button" class="btn btn-sm btn-default sanad-drawer__close" aria-label="${ui.escape(__("Close"))}">${ui.icon("es-line-close", "sm")}</button>
					</div>
				</header>
				<div class="sanad-panel__body sanad-drawer__body"></div>
				<footer class="sanad-panel__footer sanad-drawer__footer" hidden></footer>
			</aside>`).appendTo(document.body);
		this.$title = this.$root.find(".sanad-drawer__title");
		this.$meta = this.$root.find(".sanad-drawer__meta");
		this.$body = this.$root.find(".sanad-drawer__body");
		this.$footer = this.$root.find(".sanad-drawer__footer");
		this.$root.find(".sanad-drawer__close").on("click", () => this.hide());
		this.$backdrop.on("click", () => this.hide());
		this.$root.on("keydown", (e) => {
			if (e.key === "Escape") {
				e.stopPropagation();
				this.hide();
			}
		});
		this.set_title(this.opts.title || (this.opts.mode === "choice" ? __("Choose an option") : __(this.doctype)));
	}

	set_title(title, subtitle) {
		this.$title.text(title || "");
		this.$meta.find(".sanad-panel__subtitle").remove();
		if (subtitle || this.opts.subtitle) this.$meta.append(`<span class="sanad-panel__subtitle">${ui.escape(subtitle || this.opts.subtitle)}</span>`);
	}

	show() {
		// capture the opener before another panel is hidden (its focus would be inside that panel)
		this.opener = document.activeElement;
		ui.overlay.open(this);
		this.$backdrop.prop("hidden", false);
		this.$root.prop("hidden", false);
		$(document.body).addClass("sanad-drawer-open");
		window.requestAnimationFrame(() => this.$root.addClass("sanad-panel--open"));
		this.untrap = ui.trap_focus(this.$root);
		this.$root.find(".sanad-drawer__close").trigger("focus");
		if (this.opts.mode === "choice") {
			this.render_choice();
		} else if (this.doc) {
			this.state = new sanad.ui.EmptyState({ wrapper: this.$body, state: "loading", rows: 4 });
			ui.meta.with_doctype(this.doctype).then((meta) => {
				this.meta = meta;
				this.render();
			});
		} else {
			this.refresh();
		}
		return this;
	}

	hide({ silent = false } = {}) {
		if (this.$root.prop("hidden")) return this;
		this.untrap && this.untrap();
		ui.overlay.close(this);
		this.$root.removeClass("sanad-panel--open");
		window.setTimeout(() => {
			this.$root.prop("hidden", true);
			this.$backdrop.prop("hidden", true);
			if (!ui.overlay.current) $(document.body).removeClass("sanad-drawer-open");
		}, 160);
		this.restore_focus();
		if (!silent && typeof this.opts.on_close === "function") this.opts.on_close(this);
		return this;
	}

	/** Opener if still in the DOM, else the list row of the same docname, else the list. */
	restore_focus() {
		const opener = this.opener;
		if (opener && document.contains(opener) && typeof opener.focus === "function" && !this.$root[0].contains(opener)) {
			opener.focus();
			return;
		}
		const lv = this.opts.listview || (typeof cur_list !== "undefined" && cur_list && cur_list.$result ? cur_list : null);
		if (!lv || !lv.$result) return;
		const name = (this.doc && this.doc.name) || this.opts.name;
		const $row = name ? lv.$result.find(`.list-row-checkbox[data-name="${String(name).replace(/"/g, '\\"')}"]`).closest(".list-row-container") : $();
		const $target = $row.length ? $row : lv.$result.find(".list-row-container").first();
		if ($target.length) $target.trigger("focus");
	}

	destroy() {
		this.hide({ silent: true });
		window.setTimeout(() => {
			this.$root.remove();
			this.$backdrop.remove();
		}, 200);
	}

	// ---- data ------------------------------------------------------------------------------

	fetch() {
		const o = this.opts;
		return ui.meta.with_doctype(this.doctype).then((meta) => {
			this.meta = meta;
			if (o.method) {
				const args = typeof o.args === "function" ? o.args() : o.args || { name: o.name };
				return ui.call(o.method, args);
			}
			if (!o.name) return {};
			const fields = this.field_list().map((df) => df.fieldname);
			if (meta.title_field && !fields.includes(meta.title_field)) fields.push(meta.title_field);
			const extra = ["name", "modified"];
			if ((meta.fields || []).some((f) => f.fieldname === "status")) extra.push("status");
			if (meta.is_submittable) extra.push("docstatus");
			extra.forEach((f) => !fields.includes(f) && fields.push(f));
			return frappe.db.get_value(this.doctype, o.name, fields).then((r) => r.message || {});
		});
	}

	refresh() {
		this.state = new sanad.ui.EmptyState({ wrapper: this.$body, state: "loading", rows: 4 });
		this.$footer.prop("hidden", true).empty();
		return this.fetch()
			.then((doc) => {
				this.doc = doc && typeof doc === "object" ? doc : {};
				this.render();
			})
			.catch((err) => {
				this.state.error(err, { action: { label: __("Retry"), onclick: () => this.refresh() } });
			});
	}

	set_doc(doc) {
		this.doc = doc;
		if (!this.$root.prop("hidden")) this.render();
		return this;
	}

	/** Resolved docfields for the field list (meta-driven). */
	field_list() {
		const meta = this.meta || frappe.get_meta(this.doctype) || { fields: [] };
		const wanted = this.opts.fields;
		if (!wanted || !wanted.length) return ui.meta.preview_fields(meta);
		return wanted
			.map((f) => {
				if (typeof f === "string") return (meta.fields || []).find((df) => df.fieldname === f) || (f === "name" ? { fieldname: "name", label: __("ID"), fieldtype: "Data" } : null);
				const base = (meta.fields || []).find((df) => df.fieldname === f.fieldname) || {};
				return Object.assign({}, base, f);
			})
			.filter((df) => df && !ui.meta.is_layout(df));
	}

	// ---- render ----------------------------------------------------------------------------

	render() {
		const doc = this.doc || {};
		const meta = this.meta || frappe.get_meta(this.doctype) || {};
		const title = this.opts.title || (meta.title_field && doc[meta.title_field]) || doc.name || this.opts.name || __(this.doctype);
		this.set_title(title);
		this.render_badge(doc);
		const $open = this.$root.find(".sanad-drawer__open");
		const name = doc.name || this.opts.name;
		if (this.opts.open_link && name && this.doctype) {
			$open.attr("href", frappe.utils.get_form_link(this.doctype, name)).prop("hidden", false);
		} else $open.prop("hidden", true);
		this.$body.empty();
		if (this.opts.mode === "form") this.render_form(doc);
		else this.render_record(doc);
		this.render_actions(doc);
		ui.announce(__("{0} details opened.", [title]));
	}

	render_badge(doc) {
		this.$meta.find(".sanad-badge").remove();
		if (!this.doctype || !doc || (!doc.status && doc.docstatus == null)) return;
		const ind = ui.indicator_for(this.doctype, Object.assign({ doctype: this.doctype }, doc));
		if (ind.label) this.$meta.prepend(sanad.ui.StatusBadge.html({ label: __(ind.label), colour: ind.colour, size: "md" }));
	}

	render_record(doc) {
		const fields = this.field_list();
		const rows = fields
			.map((df) => {
				const value = doc[df.fieldname];
				if (value == null || value === "") return "";
				const html = ui.meta.format(value, df, doc);
				const long = LONG_TYPES.includes(df.fieldtype);
				return `<div class="sanad-drawer__field${long ? " sanad-drawer__field--wide" : ""}"><dt>${ui.escape(__(df.label || df.fieldname))}</dt><dd>${html}</dd></div>`;
			})
			.filter(Boolean);
		if (rows.length) this.$body.append(`<dl class="sanad-drawer__dl">${rows.join("")}</dl>`);
		const sections = (this.opts.sections || []).filter((s) => !s.condition || s.condition(doc));
		sections.forEach((s) => {
			const $sec = $(`<section class="sanad-drawer__section"><h3 class="sanad-drawer__section-title">${ui.escape(s.label)}</h3><div class="sanad-drawer__section-body"></div></section>`);
			this.$body.append($sec);
			try {
				s.render($sec.find(".sanad-drawer__section-body"), doc, this);
			} catch (e) {
				console.error(e); // eslint-disable-line no-console
				new sanad.ui.EmptyState({ wrapper: $sec.find(".sanad-drawer__section-body"), state: "error", description: e.message, size: "sm" });
			}
		});
		if (!rows.length && !sections.length) {
			new sanad.ui.EmptyState({ wrapper: this.$body, state: "empty", title: __("Nothing to show"), description: __("This record has no fields marked for preview.") });
		}
	}

	render_form(doc) {
		this.controls = {};
		this.$body.append(`<div class="sanad-drawer__summary" role="alert" tabindex="-1" hidden></div>`);
		const $form = $('<div class="sanad-drawer__form"></div>').appendTo(this.$body);
		this.field_list().forEach((df) => {
			const field = Object.assign({}, df, { read_only: df.read_only ? 1 : 0 });
			delete field.depends_on;
			const control = frappe.ui.form.make_control({ df: field, parent: $form, render_input: true });
			control.set_value(doc[df.fieldname] == null ? "" : doc[df.fieldname]);
			control.refresh();
			this.controls[df.fieldname] = control;
		});
		if (typeof this.opts.on_save === "function") {
			this.opts.actions = (this.opts.actions || []).filter((a) => !a._save).concat([
				{ _save: true, label: this.opts.save_label || __("Save"), primary: true, handler: () => this.save() },
			]);
		}
	}

	get_values() {
		const values = {};
		Object.entries(this.controls).forEach(([fieldname, control]) => (values[fieldname] = control.get_value()));
		return values;
	}

	save() {
		const values = this.get_values();
		const missing = this.field_list().filter((df) => df.reqd && (values[df.fieldname] == null || values[df.fieldname] === ""));
		const $summary = this.$body.find(".sanad-drawer__summary");
		if (missing.length) {
			$summary.prop("hidden", false).html(`${ui.escape(__("Fill in the required fields:"))} ${missing.map((df) => `<a href="#" data-field="${ui.escape(df.fieldname)}">${ui.escape(__(df.label))}</a>`).join(", ")}`);
			$summary.find("a").on("click", (e) => {
				e.preventDefault();
				const c = this.controls[$(e.currentTarget).data("field")];
				c && c.set_focus && c.set_focus();
			});
			$summary.trigger("focus");
			return Promise.reject(new Error("cancelled"));
		}
		$summary.prop("hidden", true).empty();
		return Promise.resolve(this.opts.on_save(values, this.doc, this)).then((r) => {
			this.hide();
			return r;
		});
	}

	render_choice() {
		this.render_badge({});
		this.$body.empty();
		const choices = this.opts.choices || [];
		if (!choices.length) {
			new sanad.ui.EmptyState({ wrapper: this.$body, state: "empty", title: __("No options available"), size: "sm" });
			return;
		}
		const $list = $(`<div class="sanad-drawer__choices" role="list" aria-labelledby="${this.id}-title"></div>`).appendTo(this.$body);
		choices.forEach((c, i) => {
			$(`<button type="button" class="sanad-drawer__choice" role="listitem" tabindex="${i === 0 ? 0 : -1}">
				${c.icon ? `<span class="sanad-drawer__choice-icon" aria-hidden="true">${ui.icon(c.icon, "md")}</span>` : ""}
				<span class="sanad-drawer__choice-text"><span class="sanad-drawer__choice-label">${ui.escape(c.label)}</span>${c.description ? `<span class="sanad-drawer__choice-desc">${ui.escape(c.description)}</span>` : ""}</span>
			</button>`)
				.on("click", () => {
					this.hide();
					typeof this.opts.on_choose === "function" && this.opts.on_choose(c.value, c);
				})
				.appendTo($list);
		});
		$list.on("keydown", (e) => {
			const items = $list.find(".sanad-drawer__choice").toArray();
			const idx = ui.roving_index(e, items, items.indexOf(document.activeElement));
			if (idx < 0) return;
			e.preventDefault();
			items.forEach((el) => el.setAttribute("tabindex", "-1"));
			items[idx].setAttribute("tabindex", "0");
			items[idx].focus();
		});
		this.render_actions({});
	}

	render_actions(doc) {
		this.$footer.empty();
		const actions = ui.visible_actions(this.opts.actions, doc, this.doctype);
		if (!actions.length) {
			this.$footer.prop("hidden", true);
			return;
		}
		actions.forEach((a) => {
			const cls = a.primary ? "btn-primary" : a.danger ? "btn-danger" : "btn-default";
			const $btn = $(`<button type="button" class="btn btn-sm ${cls} sanad-drawer__action">${a.icon ? ui.icon(a.icon, "xs") + " " : ""}${ui.escape(a.label)}</button>`);
			$btn.on("click", () => {
				$btn.prop("disabled", true);
				Promise.resolve(a.handler(this.doc, this))
					.catch((err) => {
						if (err && err.message && err.message !== "cancelled") sanad.ui.Toast.error(err);
					})
					.finally(() => $btn.prop("disabled", false));
			});
			this.$footer.append($btn);
		});
		this.$footer.prop("hidden", false);
	}

	/** The open drawer, if the current overlay is one. */
	static get current() {
		return ui.overlay.current instanceof Drawer ? ui.overlay.current : null;
	}

	/** Open a record drawer in one call. */
	static open(opts) {
		return new Drawer(opts).show();
	}
};

export default sanad.ui.Drawer;

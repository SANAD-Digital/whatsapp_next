// sanad.ui.MetaDialog — a `frappe.ui.Dialog` whose fields come from the DocType meta. The caller
// names fieldnames per tab (plain names, `{fieldname, ...overrides}` or HTML panes with a
// `render`); label, fieldtype, options, reqd, description and depends_on come from
// `frappe.get_meta`, child tables render as a Table control over the child meta. It loads a
// document by name, validates required fields with an inline, focusable summary, submits through
// a configured API key (or a handler) and shows server errors inline. Portable to any DocType.

import ui from "../_core/index.js";

// Keys copied from a meta docfield must not carry the docfield's own document identity
// (`parent` stays: Frappe's Tab uses `df.parent` as the doctype when there is no form).
const DF_INTERNAL = ["name", "doctype", "parentfield", "parenttype", "idx", "owner", "creation", "modified", "modified_by", "docstatus"];
// Keys a grid adds to child rows that no API payload wants back.
const ROW_INTERNAL = ["doctype", "parent", "parentfield", "parenttype", "owner", "creation", "modified", "modified_by", "docstatus", "__islocal", "__unsaved", "__unedited", "__last_sync_on", "__checked"];

const strip = (obj, keys) => {
	const out = Object.assign({}, obj);
	keys.forEach((k) => delete out[k]);
	return out;
};

sanad.ui.MetaDialog = class MetaDialog {
	/**
	 * @param {Object} opts
	 * @param {string} opts.doctype
	 * @param {string} [opts.name] — load this document (`frappe.db.get_doc`) into the fields
	 * @param {Object} [opts.values] — initial values (alone for a new document, merged over the loaded one)
	 * @param {string} [opts.title] — default "New {DocType}" / "Edit {DocType}"
	 * @param {Array<{label: string, fields: Array}>} [opts.tabs] — entries: `"fieldname"`,
	 *   `{fieldname, ...df overrides}` or `{fieldtype: "HTML", fieldname, label?, render($wrapper, dialog)}`
	 * @param {Array} [opts.fields] — single-pane alternative to `tabs` (same entries)
	 * @param {{label: string, method?: string, args?: Function, handler?: Function, on_success?: Function, keep_open?: boolean}} [opts.primary_action]
	 *   — `method` is an API key resolved by `sanad.ui.call`; `args(values, dialog)` shapes the payload;
	 *   `handler(values, dialog)` replaces the call (return a promise); `on_success(result, dialog)`
	 * @param {Array<{label: string, handler: Function, css_class?: string}>} [opts.extra_actions] — footer buttons, `handler(values, dialog)`
	 * @param {boolean} [opts.read_only=false] — every field read-only, no primary button
	 * @param {"small"|"large"|"extra-large"} [opts.size] — default "large" with tabs
	 * @param {Function} [opts.on_change] — `(fieldname, value, dialog)` after a field changes
	 * @param {Function} [opts.on_load] — `(doc, dialog)` once values are in place
	 * @param {Function} [opts.on_hide]
	 */
	constructor(opts = {}) {
		if (!opts.doctype) throw new Error("sanad.ui.MetaDialog: doctype is required");
		this.opts = Object.assign({ read_only: false, extra_actions: [], values: null }, opts);
		this.doctype = this.opts.doctype;
		this.name = this.opts.name || null;
		this.doc = null;
		this.dialog = null;
		this.result = undefined;
		this.uid = ui.uid("sanad-metadialog");
		this.html_panes = [];
		/** Resolves with the dialog once meta is loaded and the `frappe.ui.Dialog` exists. */
		this.ready = ui.meta.with_doctype(this.doctype).then((meta) => {
			this.meta = meta;
			this.make();
			return this;
		});
	}

	default_title() {
		return this.name ? __("Edit {0}", [__(this.doctype)]) : __("New {0}", [__(this.doctype)]);
	}

	make() {
		const o = this.opts;
		const fields = this.build_fields();
		this.dialog = new frappe.ui.Dialog({
			title: o.title || this.default_title(),
			fields,
			size: o.size || (o.tabs && o.tabs.length ? "large" : undefined),
			on_hide: () => o.on_hide && o.on_hide(this),
		});
		this.dialog.$wrapper.addClass("sanad-kit sanad-sheet sanad-metadialog");
		this.$alert = $('<div class="sanad-metadialog__alert" hidden></div>').prependTo(this.dialog.$body);

		this.html_panes.forEach((pane) => {
			const field = this.dialog.get_field(pane.fieldname);
			if (field && typeof pane.render === "function") pane.render(field.$wrapper, this);
		});

		if (o.primary_action && !o.read_only) {
			// Label only: the click is bound here so validation renders inline instead of Frappe's msgprint.
			this.$primary = this.dialog.set_primary_action(ui.escape(o.primary_action.label || __("Save")));
			this.$primary.on("click", () => this.submit());
		}
		(o.extra_actions || []).forEach((action) => {
			if (typeof action.handler !== "function") return;
			this.dialog.add_custom_action(ui.escape(action.label), () => action.handler(this.get_values({ clean: true }), this), action.css_class);
		});

		// Validate required fields on blur (design gate: errors next to the field, not only on submit).
		this.dialog.fields_list.forEach((field) => {
			if (field.df.reqd && field.$input) field.$input.on("blur", () => this.validate_field(field));
		});

		if (o.read_only) this.set_read_only();
	}

	build_fields() {
		const o = this.opts;
		const tabbed = !!(o.tabs && o.tabs.length);
		const groups = tabbed ? o.tabs : [{ fields: o.fields || [] }];
		const out = [];
		groups.forEach((tab, i) => {
			if (tabbed) {
				// `hidden: 0` matters: Frappe only treats an explicitly visible Tab Break as the first tab.
				out.push({
					fieldtype: "Tab Break",
					fieldname: `tab_${i}`,
					label: tab.label || __("Details"),
					parent: this.doctype, // Tab.make() slugs `df.parent` when the layout has no form
					hidden: 0,
				});
			}
			(tab.fields || []).forEach((entry) => {
				const df = this.make_df(entry);
				if (df) out.push(df);
			});
		});
		return out;
	}

	/** One dialog docfield from a tab entry — meta first, caller overrides on top. */
	make_df(entry) {
		const spec = typeof entry === "string" ? { fieldname: entry } : Object.assign({}, entry);
		if (spec.fieldtype === "HTML" && typeof spec.render === "function") {
			this.html_panes.push({ fieldname: spec.fieldname, render: spec.render });
			return { fieldtype: "HTML", fieldname: spec.fieldname, label: spec.label, parent: this.doctype, hidden: 0 };
		}
		const meta_df = (this.meta.fields || []).find((f) => f.fieldname === spec.fieldname);
		if (!meta_df && !spec.fieldtype) {
			console.warn(`sanad.ui.MetaDialog: ${this.doctype} has no field '${spec.fieldname}'`); // eslint-disable-line no-console
			return null;
		}
		const df = Object.assign(meta_df ? strip(meta_df, DF_INTERNAL) : { parent: this.doctype }, spec);
		if (df.fieldtype === "Table") this.prepare_table_df(df);
		if (!ui.meta.is_layout(df) && df.fieldtype !== "Table") {
			df.change = () => this.handle_change(df.fieldname);
		}
		return df;
	}

	/** Child-table fields from the child meta; rows live on `df.data` (grid without a form). */
	prepare_table_df(df) {
		const child = df.options ? frappe.get_meta(df.options) : null;
		df.fields = child ? (child.fields || []).filter((f) => !ui.meta.is_layout(f)).map((f) => strip(f, DF_INTERNAL)) : df.fields || [];
		df.data = [];
		df.get_data = () => df.data;
		df.editable_grid = 1;
		if (this.opts.read_only) {
			df.cannot_add_rows = 1;
			df.cannot_delete_rows = 1;
		}
	}

	handle_change(fieldname) {
		if (!this.dialog) return;
		const field = this.dialog.get_field(fieldname);
		if (field && field.df.reqd) this.validate_field(field);
		this.opts.on_change && this.opts.on_change(fieldname, this.dialog.get_value(fieldname), this);
	}

	/** Show the dialog, then load the document (or the initial values). Resolves with the dialog. */
	async show() {
		await this.ready;
		this.dialog.show();
		await this.load();
		return this;
	}

	async load() {
		const o = this.opts;
		this.set_busy(true);
		try {
			let doc = {};
			if (this.name) doc = await frappe.db.get_doc(this.doctype, this.name);
			if (o.values) doc = Object.assign({}, doc, o.values);
			this.doc = doc;
			await this.set_values(doc);
			this.clear_errors();
			o.on_load && o.on_load(doc, this);
		} catch (err) {
			this.show_error(err, { retry: () => this.load() });
		} finally {
			this.set_busy(false);
		}
	}

	set_busy(busy) {
		this.dialog.$wrapper.toggleClass("sanad-metadialog--loading", !!busy);
		this.dialog.$body.attr("aria-busy", busy ? "true" : "false");
		this.$primary && this.$primary.prop("disabled", !!busy);
	}

	hide() {
		this.dialog && this.dialog.hide();
		return this;
	}

	set_title(title) {
		this.dialog && this.dialog.set_title(ui.escape(title));
		return this;
	}

	get_field(fieldname) {
		return this.dialog ? this.dialog.get_field(fieldname) : null;
	}

	/**
	 * Values of every field. `clean: true` strips grid bookkeeping from child rows and keeps only
	 * child-meta fieldnames (+ `idx`), which is what an API payload wants.
	 */
	get_values({ clean = false } = {}) {
		if (!this.dialog) return {};
		const values = this.dialog.get_values(true) || {};
		this.dialog.fields_list.forEach((field) => {
			if (field.df.fieldtype !== "Table") return;
			const rows = (field.grid ? field.grid.get_data() : field.df.data) || [];
			values[field.df.fieldname] = clean ? sanad.ui.MetaDialog.clean_rows(rows, field.df.options) : rows;
		});
		return values;
	}

	/** Set values by fieldname; child tables take an array of row objects. */
	set_values(values = {}) {
		if (!this.dialog) return Promise.resolve();
		const promises = [];
		Object.keys(values).forEach((key) => {
			const field = this.dialog.get_field(key);
			if (!field) return;
			if (field.df.fieldtype === "Table") {
				const rows = Array.isArray(values[key]) ? values[key] : [];
				field.df.data = rows.map((row, i) => Object.assign({}, row, { idx: row.idx || i + 1 }));
				field.grid && field.grid.refresh();
			} else {
				promises.push(this.dialog.set_value(key, values[key]));
			}
		});
		return Promise.all(promises);
	}

	/** Make every field read-only and hide the primary button (used for locked records). */
	set_read_only() {
		this.read_only = true;
		if (!this.dialog) return this;
		this.dialog.fields_list.forEach((field) => {
			const df = field.df;
			if (ui.meta.is_layout(df) || df.fieldtype === "HTML") return;
			df.read_only = 1;
			if (df.fieldtype === "Table") {
				df.cannot_add_rows = 1;
				df.cannot_delete_rows = 1;
			}
			field.refresh();
		});
		this.dialog.get_primary_btn().addClass("hide");
		this.dialog.$wrapper.addClass("sanad-metadialog--readonly");
		return this;
	}

	// ---- validation --------------------------------------------------------------------------

	validate() {
		const missing = this.dialog.fields_list.filter((field) => !this.validate_field(field));
		if (missing.length) {
			this.render_summary(missing);
			return false;
		}
		this.clear_errors();
		return true;
	}

	/** One field: `reqd` and empty → inline error + aria-describedby; returns validity. */
	validate_field(field) {
		const df = field.df;
		if (!df.reqd || df.hidden || df.hidden_due_to_dependency || ui.meta.is_layout(df) || df.fieldtype === "HTML") {
			this.mark(field, null);
			return true;
		}
		let value = field.get_value ? field.get_value() : null;
		if (Array.isArray(value)) value = value.length ? value : null;
		if (typeof value === "string") value = strip_html(value).trim();
		const ok = !is_null(value);
		this.mark(field, ok ? null : __("{0} is required", [__(df.label)]));
		return ok;
	}

	mark(field, message) {
		const id = `${this.uid}-err-${field.df.fieldname}`;
		field.$wrapper.find(`#${id}`).remove();
		field.$wrapper.toggleClass("has-error sanad-metadialog__field--invalid", !!message);
		const $input = field.$input || field.$wrapper.find("input, select, textarea").first();
		if (message) {
			$(`<div class="sanad-metadialog__field-error" id="${id}" role="alert">${ui.escape(message)}</div>`).appendTo(field.$wrapper);
			$input.attr("aria-invalid", "true").attr("aria-describedby", id);
		} else {
			$input.removeAttr("aria-invalid").removeAttr("aria-describedby");
		}
	}

	render_summary(fields) {
		const items = fields
			.map((f) => `<li><a href="#" data-fieldname="${ui.escape(f.df.fieldname)}">${ui.escape(__(f.df.label))}</a></li>`)
			.join("");
		this.$alert
			.html(
				`<div class="sanad-metadialog__summary" role="alert" tabindex="-1">
					<div class="sanad-metadialog__summary-title">${ui.escape(__("Fill in the required fields"))}</div>
					<ul>${items}</ul>
				</div>`
			)
			.prop("hidden", false);
		this.$alert.find("a").on("click", (e) => {
			e.preventDefault();
			this.focus_field($(e.currentTarget).data("fieldname"));
		});
		this.activate_tab_of(fields[0]);
		this.$alert.children().trigger("focus");
	}

	focus_field(fieldname) {
		const field = this.get_field(fieldname);
		if (!field) return;
		this.activate_tab_of(field);
		if (field.set_focus) field.set_focus();
		else if (field.$input) field.$input.trigger("focus");
	}

	activate_tab_of(field) {
		const tab = field.tab || (this.dialog.tabs || []).find((t) => (t.fields_list || []).includes(field));
		tab && tab.set_active && tab.set_active();
	}

	clear_errors() {
		this.$alert.empty().prop("hidden", true);
	}

	/** Inline error (server message or load failure); Frappe's own msgprint, when any, stays. */
	show_error(err, { retry } = {}) {
		if (err && err.message === "cancelled") return;
		const error = err instanceof Error ? err : ui.error_from(err);
		const message = error.message || __("Something went wrong. Try again.");
		const $box = $(`<div class="sanad-metadialog__error" role="alert" tabindex="-1">${ui.escape(message)}</div>`);
		if (retry) {
			$(`<button type="button" class="btn btn-xs btn-default">${ui.escape(__("Retry"))}</button>`)
				.on("click", () => retry())
				.appendTo($box);
		}
		this.$alert.html($box).prop("hidden", false);
		$box.trigger("focus");
	}

	// ---- submit ------------------------------------------------------------------------------

	async submit() {
		const action = this.opts.primary_action;
		if (!action || this._submitting || !this.validate()) return;
		const values = this.get_values({ clean: true });
		this._submitting = true;
		this.$primary.prop("disabled", true).addClass("disabled");
		try {
			let result;
			if (typeof action.handler === "function") {
				result = await action.handler(values, this);
			} else if (action.method) {
				const args = typeof action.args === "function" ? action.args(values, this) : values;
				result = await ui.call(action.method, args);
			}
			this.result = result;
			this.clear_errors();
			action.on_success && action.on_success(result, this);
			if (!action.keep_open) this.hide();
		} catch (err) {
			this.show_error(err);
		} finally {
			this._submitting = false;
			this.$primary.prop("disabled", false).removeClass("disabled");
		}
	}

	/** Child rows → plain objects with the child meta's own fieldnames (+ `idx`) only. */
	static clean_rows(rows = [], child_doctype) {
		const meta = child_doctype ? frappe.get_meta(child_doctype) : null;
		const allowed = meta ? new Set((meta.fields || []).filter((f) => !ui.meta.is_layout(f)).map((f) => f.fieldname)) : null;
		return (rows || []).map((row, i) => {
			const clean = strip(row, ROW_INTERNAL);
			const out = { idx: row.idx || i + 1 };
			Object.keys(clean).forEach((k) => {
				if (k === "idx" || k === "name") return;
				if (!allowed || allowed.has(k)) out[k] = clean[k];
			});
			return out;
		});
	}
};

export default sanad.ui.MetaDialog;

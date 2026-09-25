// sanad.ui.Drawer — an inline-end side panel to inspect (`record`), edit (`form`) or pick
// (`choice`) without leaving the list. Meta-driven: the header badge comes from the DocType's
// indicator rules, `record` fields default to `sanad.ui.meta.preview_fields(meta)` and values
// go through `sanad.ui.meta.format`; `form` fields are real Frappe controls. Payload from a
// configured API key (`method`) or `frappe.client.get_value` with the explicit field list.
// Built on the shared `.sanad-panel` shell; one overlay at a time through `sanad.ui.overlay`;
// Escape closes, focus is trapped inside and restored to the opener (or the list row).

import ui from "../_core/index.js";
import Render from "../Render/index.js";
import { fact, dl, avatar } from "../Render/parts.js";

const LONG_TYPES = ["Text", "Small Text", "Long Text", "Text Editor", "Markdown Editor", "Code", "JSON", "HTML Editor"];
// Fieldtypes that belong in the quick-facts grid: short enough to read at a glance.
const FACT_TYPES = ["Data", "Select", "Link", "Dynamic Link", "Int", "Float", "Currency", "Percent", "Date", "Datetime", "Time", "Check", "Rating", "Duration", "Phone"];

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
	 * @param {Array<{label: string, icon?: string, handler: Function, primary?: boolean, danger?: boolean, menu?: boolean, condition?: Function, perm?: string, roles?: string[]}>} [opts.actions]
	 *   — `menu: true` puts the action behind the footer's one "More" button
	 * @param {Array<{label: string, render: Function($el, doc), condition?: Function}>} [opts.sections] — extra blocks under the fields (`record`)
	 * @param {"document"|"fields"} [opts.layout="document"] — `record` mode: the document layout
	 *   (identity · highlight · quick facts · related · details · activity) or the plain field list
	 * @param {Object} [opts.profile] — `sanad.ui.Render` profile overrides for the identity block
	 * @param {string|Object|Function} [opts.highlight] — the record's primary content (fieldname,
	 *   `{field, label, icon, tone}` or `(doc) => html`); default: its first long text field
	 * @param {Array<string|Object>} [opts.facts] — fieldnames for the quick-facts grid (default: the
	 *   short fields of `fields`, `opts.facts_max` of them)
	 * @param {number} [opts.facts_max=6]
	 * @param {Array<string|Object>} [opts.relations] — link fields shown as entity rows
	 *   (`{field, label?, doctype?, actions?}`); default: the link fields pointing at a person
	 * @param {Array<string|Object>} [opts.details] — fieldnames for the collapsible details block
	 * @param {Array|Function} [opts.activity] — activity rows, or `(doc) => rows | Promise<rows>`;
	 *   each row is `{title, description?, time, user?, icon?, tone?}`
	 * @param {string} [opts.activity_label]
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
		this.opts = Object.assign({ mode: "record", layout: "document", facts_max: 6, actions: [], sections: [], choices: [], open_link: true }, opts);
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
		this.close_menu();
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
		const remove = () => {
			this.$root.remove();
			this.$backdrop.remove();
		};
		// a drawer that is already closed leaves at once, so its content never shadows a new one's
		if (this.$root.prop("hidden")) return remove();
		this.hide({ silent: true });
		window.setTimeout(remove, 200);
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
			// the document layout introduces the record, so it needs its picture, its identifying
			// line and its timestamp even when the caller listed only the fields it cares about
			if (this.opts.mode === "record" && this.opts.layout !== "fields") extra.push(...Render.identity_fields(this.doctype));
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
		const record_title = this.opts.title || (meta.title_field && doc[meta.title_field]) || doc.name || this.opts.name || __(this.doctype);
		const as_document = this.opts.mode === "record" && this.opts.layout !== "fields";
		// In the document layout the panel header names the kind of document and the record
		// introduces itself in the identity block, so the title is never printed twice.
		this.set_title(as_document ? this.opts.title || __(this.doctype) : record_title);
		if (!as_document) this.render_badge(doc);
		else this.$meta.find(".sanad-badge").remove();
		const $open = this.$root.find(".sanad-drawer__open");
		const name = doc.name || this.opts.name;
		if (this.opts.open_link && name && this.doctype) {
			$open.attr("href", frappe.utils.get_form_link(this.doctype, name)).prop("hidden", false);
		} else $open.prop("hidden", true);
		this.$body.empty();
		if (this.opts.mode === "form") this.render_form(doc);
		else if (as_document) this.render_document(doc);
		else this.render_record(doc);
		this.render_actions(doc);
		ui.announce(__("{0} details opened.", [record_title]));
	}

	render_badge(doc) {
		this.$meta.find(".sanad-badge").remove();
		if (!this.doctype || !doc || (!doc.status && doc.docstatus == null)) return;
		const ind = ui.indicator_for(this.doctype, Object.assign({ doctype: this.doctype }, doc));
		if (ind.label) this.$meta.prepend(sanad.ui.StatusBadge.html({ label: __(ind.label), colour: ind.colour, size: "md" }));
	}

	// ---- document layout (reference image 01) ------------------------------------------------

	/**
	 * The record read as a document, not as a form: who it is (identity), what it says
	 * (highlight), its key facts, what it is linked to, the rest of its fields, and what happened
	 * to it. Every field of `field_list()` lands in exactly one block, so no data is hidden.
	 */
	render_document(doc) {
		const plan = this.plan_document(doc);
		this.render_identity(doc, plan.vm, plan.time);
		if (plan.highlight) this.render_highlight(doc, plan.highlight);
		if (plan.facts.length) this.render_facts(doc, plan.facts);
		plan.relations.forEach((rel) => this.render_relation(doc, rel));
		this.render_sections(doc);
		if (plan.details.length) this.render_details(doc, plan.details);
		if (this.opts.activity) this.render_activity(doc);
	}

	/** Decide which block each field belongs to. Explicit options always win over the defaults. */
	plan_document(doc) {
		const o = this.opts;
		const fields = this.field_list();
		const vm = Render.vm(doc, { doctype: this.doctype, density: "hero", profile: Object.assign({ facts: [] }, o.profile || {}) });
		const used = new Set(vm.used || []);
		const find = (spec) => {
			const name = typeof spec === "string" ? spec : spec.field || spec.fieldname;
			const df = fields.find((d) => d.fieldname === name) || (this.meta && (this.meta.fields || []).find((d) => d.fieldname === name)) || { fieldname: name, fieldtype: "Data", label: frappe.unscrub(cstr(name)) };
			return Object.assign({ df, field: name, label: __(df.label || name) }, typeof spec === "string" ? {} : spec);
		};

		// the timestamp beside the status: the caller's field, else when it was sent / created
		const time_field = o.time_field || ["sent_at", "received_at", "creation"].find((f) => doc[f]) || "modified";
		used.add(time_field);

		// primary content: the caller's, else the first long text field that has something in it
		let highlight = null;
		if (typeof o.highlight === "function") highlight = { render: o.highlight, label: o.highlight_label || __("Content") };
		else if (o.highlight) highlight = find(o.highlight);
		else {
			const df = fields.find((d) => LONG_TYPES.includes(d.fieldtype) && !used.has(d.fieldname) && doc[d.fieldname]);
			if (df) highlight = { df, field: df.fieldname, label: __(df.label || df.fieldname) };
		}
		if (highlight && highlight.field) used.add(highlight.field);

		// related entities: the caller's, else the link fields that point at a person
		const relations = (o.relations || fields.filter((d) => d.fieldtype === "Link" && doc[d.fieldname] && !used.has(d.fieldname) && Render.doctype_kinds[d.options] === "person").map((d) => d.fieldname)).map(find).filter((r) => doc[r.field]);
		relations.forEach((r) => used.add(r.field));

		// quick facts, then everything that is left
		const rest = fields.filter((d) => !used.has(d.fieldname) && doc[d.fieldname] != null && doc[d.fieldname] !== "");
		let facts;
		let details;
		if (o.facts) {
			facts = o.facts.map(find);
			facts.forEach((f) => used.add(f.field));
			details = (o.details || rest.filter((d) => !used.has(d.fieldname)).map((d) => d.fieldname)).map(find);
		} else {
			const short = rest.filter((d) => FACT_TYPES.includes(d.fieldtype));
			facts = short.slice(0, o.facts_max).map((d) => find(d.fieldname));
			facts.forEach((f) => used.add(f.field));
			details = (o.details || rest.filter((d) => !used.has(d.fieldname)).map((d) => d.fieldname)).map(find);
		}
		return { vm, facts, details, relations, highlight, time: time_field };
	}

	/** A titled block with the reference's icon-then-label heading. */
	block({ label, icon, cls = "" } = {}) {
		const $sec = $(`<section class="sanad-doc__block${cls ? ` ${cls}` : ""}">
			${label ? `<h3 class="sanad-doc__block-title">${icon ? `<span class="sanad-doc__block-icon" aria-hidden="true">${ui.icon(icon, "sm")}</span>` : ""}<span>${ui.escape(label)}</span></h3>` : ""}
			<div class="sanad-doc__block-body"></div>
		</section>`).appendTo(this.$body);
		return $sec.find(".sanad-doc__block-body");
	}

	/** Who this record is: picture, title, the one or two lines that identify it, status, time. */
	render_identity(doc, vm, time_field) {
		const time = doc[time_field];
		const lines = (vm.lines || []).map((l) => `<div class="sanad-doc__identity-sub"${l.ltr ? ' dir="ltr"' : ' dir="auto"'}>${l.html || ui.escape(l.text || "")}</div>`).join("");
		const name = doc.name || this.opts.name || "";
		const $id = $(`<section class="sanad-doc__identity">
			<div class="sanad-doc__identity-main">
				${avatar({ image: vm.image, initials: vm.initials, icon: vm.icon, tone: vm.tone, size: "lg", alt: vm.title })}
				<div class="sanad-doc__identity-text">
					<h3 class="sanad-doc__identity-title" dir="auto">${ui.escape(vm.title || name)}</h3>
					${lines}
					${name ? `<div class="sanad-doc__identity-ref"><span>${ui.escape(__(this.doctype))}</span><span aria-hidden="true">·</span><code dir="ltr">${ui.escape(name)}</code></div>` : ""}
				</div>
			</div>
			<div class="sanad-doc__identity-side">
				${vm.status && vm.status.label ? sanad.ui.StatusBadge.html({ label: vm.status.label, colour: vm.status.colour, size: "md" }) : ""}
				${time ? `<span class="sanad-doc__identity-time">${ui.icon("es-line-time", "xs")}${Render.value(time, { fieldtype: "Datetime", fieldname: time_field }, doc, { density: "inline" })}</span>` : ""}
				${vm.value && vm.value.html ? `<span class="sanad-doc__identity-value">${vm.value.html}</span>` : ""}
			</div>
		</section>`).appendTo(this.$body);
		return $id;
	}

	/** The record's own content — the message, the note, the description — given room to breathe. */
	render_highlight(doc, spec) {
		const $body = this.block({ label: spec.label, icon: spec.icon || "es-line-chat", cls: "sanad-doc__block--highlight" });
		if (typeof spec.render === "function") {
			spec.render($body, doc, this);
			return;
		}
		const html = Render.value(doc[spec.field], spec.df, doc, { density: "card", doctype: this.doctype });
		$body.html(`<div class="sanad-doc__highlight" dir="auto">${html}</div>`);
	}

	/** Quick facts: the short fields as a grid of tiles, label above and value below. */
	render_facts(doc, facts) {
		const $body = this.block({ label: __("Key facts"), icon: "es-line-details" });
		const html = facts
			.map((f) =>
				fact({
					label: f.label,
					// inline density inside a tile: a link stays a chip, a percent still gets its bar
					value: Render.value(doc[f.field], f.df, doc, { density: "inline", icon: false, doctype: this.doctype, variant: f.variant || (f.df && f.df.fieldtype === "Percent" ? "progress" : undefined) }),
					icon: f.icon || Render.field_icon(f.df),
					ltr: f.ltr,
				})
			)
			.join("");
		$body.html(`<div class="sanad-fact-grid">${html}</div>`);
	}

	/** A linked record as itself — a person reads as a person, with their own quick actions. */
	render_relation(doc, rel) {
		const target = rel.doctype || (rel.df && rel.df.options);
		const value = doc[rel.field];
		if (!target || !value) return;
		const $body = this.block({ label: rel.label || __(rel.df ? rel.df.label : target), icon: rel.icon || Render.icon_for(target) });
		Render.load_into($body, target, value, { density: "row", actions: rel.actions, on_click: rel.on_click });
	}

	/** Everything that did not earn a tile, in a block the reader can fold away. */
	render_details(doc, details) {
		const rows = details.map((d) => {
			const long = LONG_TYPES.includes(d.df && d.df.fieldtype);
			return {
				label: d.label,
				// only the long fields get room; everything else stays one line, like its neighbours
				value: Render.value(doc[d.field], d.df, doc, { density: long ? "card" : "inline", doctype: this.doctype }),
				wide: long,
				ltr: d.ltr,
			};
		});
		const html = dl(rows);
		if (!html) return;
		$(`<details class="sanad-doc__details" open>
			<summary class="sanad-doc__block-title"><span class="sanad-doc__block-icon" aria-hidden="true">${ui.icon("es-line-article", "sm")}</span><span>${ui.escape(__("More details"))}</span></summary>
			<div class="sanad-doc__details-body">${html}</div>
		</details>`).appendTo(this.$body);
	}

	/** What happened to this record, as a timeline: time and sequence are the information. */
	render_activity(doc) {
		const $body = this.block({ label: this.opts.activity_label || __("Activity"), icon: "es-line-time" });
		const source = this.opts.activity;
		const mount = (rows) => {
			if (!rows || !rows.length) {
				new sanad.ui.EmptyState({ wrapper: $body, state: "empty", title: __("No activity yet"), size: "sm" });
				return;
			}
			new sanad.ui.Collection({ wrapper: $body, rows, views: ["timeline"], view: "timeline", timeline: this.opts.timeline });
		};
		if (typeof source === "function") {
			const out = source(doc, this);
			if (out && typeof out.then === "function") {
				const state = new sanad.ui.EmptyState({ wrapper: $body, state: "loading", rows: 2, size: "sm" });
				out.then((rows) => {
					$body.empty();
					mount(rows);
				}).catch((err) => state.error(err));
				return;
			}
			mount(out);
			return;
		}
		mount(source);
	}

	/** The caller's own blocks (`opts.sections`) — same contract in both layouts. */
	render_sections(doc) {
		(this.opts.sections || [])
			.filter((s) => !s.condition || s.condition(doc))
			.forEach((s) => {
				const $body = this.block({ label: s.label, icon: s.icon });
				try {
					s.render($body, doc, this);
				} catch (e) {
					console.error(e); // eslint-disable-line no-console
					new sanad.ui.EmptyState({ wrapper: $body, state: "error", description: e.message, size: "sm" });
				}
			});
	}

	/** `layout: "fields"` — the plain two-column field list, kept for callers that want it. */
	render_record(doc) {
		const fields = this.field_list();
		const rows = fields
			.map((df) => {
				const value = doc[df.fieldname];
				if (value == null || value === "") return "";
				const html = Render.value(value, df, doc, { density: "row", doctype: this.doctype });
				const long = LONG_TYPES.includes(df.fieldtype);
				return `<div class="sanad-drawer__field${long ? " sanad-drawer__field--wide" : ""}"><dt>${ui.escape(__(df.label || df.fieldname))}</dt><dd>${html}</dd></div>`;
			})
			.filter(Boolean);
		if (rows.length) this.$body.append(`<dl class="sanad-drawer__dl">${rows.join("")}</dl>`);
		const sections = (this.opts.sections || []).filter((s) => !s.condition || s.condition(doc));
		this.render_sections(doc);
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

	/**
	 * The footer holds the verbs the reference draws there: two or three. An action marked
	 * `menu: true` goes behind one "More" button instead, so a record with seven things to do
	 * does not end in three ragged rows of buttons.
	 */
	render_actions(doc) {
		this.$footer.empty();
		this.close_menu();
		const actions = ui.visible_actions(this.opts.actions, doc, this.doctype);
		if (!actions.length) {
			this.$footer.prop("hidden", true);
			return;
		}
		const run = (a, $btn) => {
			$btn && $btn.prop("disabled", true);
			Promise.resolve(a.handler(this.doc, this))
				.catch((err) => {
					if (err && err.message && err.message !== "cancelled") sanad.ui.Toast.error(err);
				})
				.finally(() => $btn && $btn.prop("disabled", false));
		};
		const inline = actions.filter((a) => !a.menu);
		const more = actions.filter((a) => a.menu);
		if (more.length) {
			const $more = $(`<button type="button" class="btn btn-sm btn-default sanad-drawer__action sanad-drawer__more" aria-haspopup="menu" aria-expanded="false" aria-label="${ui.escape(__("More actions"))}" title="${ui.escape(__("More actions"))}">${ui.icon(ui.icons.more, "sm")}</button>`);
			$more.on("click", () => (this.$menu ? this.close_menu(true) : this.open_menu($more, more, run)));
			this.$footer.append($more);
		}
		inline.forEach((a) => {
			const cls = a.primary ? "btn-primary" : a.danger ? "btn-danger" : "btn-default";
			const $btn = $(`<button type="button" class="btn btn-sm ${cls} sanad-drawer__action">${a.icon ? ui.icon(a.icon, "xs") + " " : ""}${ui.escape(a.label)}</button>`);
			$btn.on("click", () => run(a, $btn));
			this.$footer.append($btn);
		});
		this.$footer.prop("hidden", false);
	}

	/** The "More" menu — the same menu RowActions draws on a list row, anchored to the button. */
	open_menu($btn, actions, run) {
		const id = ui.uid("drawermenu");
		// the list's menu sits under an open panel; this one belongs to the panel, so it sits above it
		const $menu = $(`<div class="sanad-kit sanad-rowactions__menu sanad-drawer__menu" id="${id}" role="menu" aria-label="${ui.escape(__("More actions"))}"></div>`);
		actions.forEach((a) => {
			$(`<button type="button" class="sanad-rowactions__item${a.danger ? " sanad-rowactions__item--danger" : ""}" role="menuitem" tabindex="-1">${a.icon ? `<span class="sanad-rowactions__icon" aria-hidden="true">${ui.icon(a.icon, "sm")}</span>` : ""}<span>${ui.escape(a.label)}</span></button>`)
				.on("click", (e) => {
					e.preventDefault();
					this.close_menu(true);
					run(a, null);
				})
				.appendTo($menu);
		});
		$menu.on("keydown", (e) => {
			const items = $menu.find('[role="menuitem"]').toArray();
			if (e.key === "Escape") {
				e.preventDefault();
				e.stopPropagation();
				return this.close_menu(true);
			}
			if (e.key === "Tab") return this.close_menu();
			const i = ui.roving_index(e, items, items.indexOf(document.activeElement));
			if (i < 0) return;
			e.preventDefault();
			items.forEach((el) => el.setAttribute("tabindex", "-1"));
			items[i].setAttribute("tabindex", "0");
			items[i].focus();
		});
		$menu.appendTo(document.body);
		// above the button, inside the panel's own column
		const rect = $btn[0].getBoundingClientRect();
		const w = $menu.outerWidth();
		const h = $menu.outerHeight();
		let x = ui.is_rtl() ? rect.right - w : rect.left;
		x = Math.max(8, Math.min(x, window.innerWidth - w - 8));
		let y = rect.top - h - 4;
		if (y < 8) y = rect.bottom + 4;
		const tx = ui.is_rtl() ? -(window.innerWidth - (x + w)) : x;
		$menu[0].style.setProperty("--sanad-menu-x", `${Math.round(tx)}px`);
		$menu[0].style.setProperty("--sanad-menu-y", `${Math.round(y)}px`);
		$btn.attr("aria-expanded", "true").attr("aria-controls", id);
		this.$menu = $menu;
		this.$menu_opener = $btn;
		this._outside = (e) => {
			if (!$(e.target).closest(".sanad-rowactions__menu, .sanad-drawer__more").length) this.close_menu();
		};
		window.setTimeout(() => $(document).on("mousedown.sanaddrawermenu touchstart.sanaddrawermenu", this._outside), 0);
		$menu.find('[role="menuitem"]').first().attr("tabindex", "0").trigger("focus");
	}

	close_menu(restore_focus = false) {
		if (!this.$menu) return;
		this.$menu.remove();
		this.$menu = null;
		$(document).off(".sanaddrawermenu");
		if (this.$menu_opener) {
			this.$menu_opener.attr("aria-expanded", "false").removeAttr("aria-controls");
			if (restore_focus) this.$menu_opener.trigger("focus");
		}
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

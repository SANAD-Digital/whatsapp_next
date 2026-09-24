// MessageComposer — an editor for the ordered messages a record sends. It is an *input*: the
// writing surface is the screen, the list of messages is a rail beside it, and the preview is a
// small panel the writer may fold away.
//
// A child-table grid cannot do this: a message has a type, and the type decides which fields
// exist, which is why the rail/editor split beats a row of inputs. Which fields a type offers is
// read from the child DocType's own `depends_on` rules and its Select options, so a host app adds
// a type by adding it to the field and the component follows.

import ui from "../_core/index.js";

// What each type is: the icon that stands for it, the shelf it belongs on, and the one line that
// tells it from its neighbours. A type the host adds to the child DocType's Select and does not
// name here still works — it takes the default icon and lands on the last shelf.
const TYPES = {
	Text: { icon: "es-line-chat-alt", group: "say", hint: () => __("A written message.") },
	Image: { icon: "es-line-image", group: "send", hint: () => __("A picture, with a caption under it if you want one.") },
	Video: { icon: "es-line-video", group: "send", hint: () => __("A video clip, with an optional caption.") },
	Audio: { icon: "es-line-call", group: "send", hint: () => __("A voice note or an audio file.") },
	Document: { icon: "es-line-filetype", group: "send", hint: () => __("A file to download, or a document printed to PDF.") },
	Sticker: { icon: "es-line-emoji", group: "send", hint: () => __("A sticker, sent on its own.") },
	Location: { icon: "es-line-location", group: "ask", hint: () => __("A point on the map.") },
	Poll: { icon: "es-line-bullet-list", group: "ask", hint: () => __("A question with answers to choose from.") },
	Template: { icon: "es-line-copy", group: "ask", hint: () => __("A message written and approved beforehand.") },
};
const TYPE_ICON_FALLBACK = "es-line-chat-alt";
const GROUPS = [
	{ key: "say", label: () => __("Write") },
	{ key: "send", label: () => __("Send a file") },
	{ key: "ask", label: () => __("Ask something") },
];

/** WhatsApp's own text marks, offered as a toolbar over the body field. */
const MARKS = [
	{ key: "bold", mark: "*", icon: "es-line-bold", label: () => __("Bold") },
	{ key: "italic", mark: "_", icon: "es-line-italic", label: () => __("Italic") },
	{ key: "strike", mark: "~", icon: "es-line-strike-through", label: () => __("Strikethrough") },
	{ key: "mono", mark: "```", icon: "es-line-code", label: () => __("Monospace") },
];

const icon_of = (type) => (TYPES[type] && TYPES[type].icon) || TYPE_ICON_FALLBACK;

sanad.ui.MessageComposer = class MessageComposer {
	/**
	 * @param {object} opts
	 * @param {object} opts.frm — the host form
	 * @param {string} opts.fieldname — the Table field holding the messages
	 * @param {string} [opts.type_field="message_type"]
	 * @param {string} [opts.body_field="body"]
	 * @param {string} [opts.delay_field] — Int seconds, edited under the editor
	 * @param {Object<string,string[]>} [opts.primary_fields] — per type, the fields that lead the
	 *   editor; everything else the type allows goes under "More options"
	 * @param {Array<string>} [opts.fields] — the fields the editor may offer at all
	 * @param {{method: string, args: Function}} [opts.preview] — `args(row, frm)` → `{body,
	 *   attachment_name, message_type, errors[]}`
	 * @param {Array<{name, label}>|{method: string, args: Function}} [opts.variables]
	 * @param {Function} [opts.can_edit] — `() => boolean`
	 * @param {string} [opts.empty_text]
	 * @param {number} [opts.max]
	 */
	constructor(opts = {}) {
		this.opts = Object.assign({ type_field: "message_type", body_field: "body", debounce: 400 }, opts);
		this.frm = this.opts.frm;
		this.fieldname = this.opts.fieldname;
		this.id = ui.uid("mc");
		this.active = null; // the message being written
		this.show_preview = true;
		this.controls = new Map();
		this.resolve_meta();
		this.mount();
		this.load_variables();
	}

	// ---- meta ---------------------------------------------------------------------------------

	resolve_meta() {
		const df = frappe.meta.get_docfield(this.frm.doctype, this.fieldname);
		this.child_doctype = df && df.options;
		this.label = df && df.label ? __(df.label) : this.fieldname;
		this.child_meta = this.child_doctype ? frappe.get_meta(this.child_doctype) : null;
		const fields = (this.child_meta && this.child_meta.fields) || [];
		this.field_map = {};
		fields.forEach((f) => (this.field_map[f.fieldname] = f));
		this.editable_fields = (this.opts.fields || fields.filter((f) => !ui.meta.is_layout(f) && !f.read_only).map((f) => f.fieldname)).filter(
			(f) => this.field_map[f] && f !== this.opts.type_field && f !== this.opts.delay_field
		);
		this.types = ((this.field_map[this.opts.type_field] || {}).options || "").split("\n").filter(Boolean);
	}

	rows() {
		return (this.frm.doc[this.fieldname] || []).slice().sort((a, b) => cint(a.idx) - cint(b.idx));
	}

	row_of(name) {
		return this.rows().find((r) => r.name === name) || null;
	}

	can_edit() {
		if (typeof this.opts.can_edit === "function") return !!this.opts.can_edit();
		// `frm.read_only` is the flag Desk sets (workflow, `set_read_only()`); there is no
		// `frm.is_read_only()` on a Form, and calling one threw the moment a host left `can_edit`
		// to its default
		return !this.frm.read_only && !cint(this.frm.doc.docstatus) && frappe.model.can_write(this.frm.doctype);
	}

	// ---- mount --------------------------------------------------------------------------------

	mount() {
		const field = this.frm.get_field(this.fieldname);
		this.$host = field && field.grid && field.grid.wrapper ? field.grid.wrapper : field && field.$wrapper;
		this.$el = $(`
			<div class="sanad-kit sanad-mc" id="${this.id}" data-fieldname="${ui.escape(this.fieldname)}">
				<div class="sanad-mc__head">
					<h4 class="sanad-mc__title">${ui.escape(this.label)}</h4>
					<span class="sanad-mc__count sanad-tabular" aria-live="polite"></span>
					<div class="sanad-mc__head-actions"></div>
				</div>
				<div class="sanad-mc__split">
					<nav class="sanad-mc__rail" aria-label="${ui.escape(this.label)}"></nav>
					<section class="sanad-mc__editor" aria-live="polite"></section>
				</div>
			</div>`);
		const $existing = this.frm.$wrapper.find(`.sanad-mc[data-fieldname="${this.fieldname}"]`);
		if ($existing.length) $existing.replaceWith(this.$el);
		else if (this.$host && this.$host.length) this.$host.append(this.$el);
		else this.frm.$wrapper.find(".form-page").first().append(this.$el);
		if (this.$host) this.$host.addClass("sanad-mc-host");
		this.$rail = this.$el.find(".sanad-mc__rail");
		this.$editor = this.$el.find(".sanad-mc__editor");
		this.$actions = this.$el.find(".sanad-mc__head-actions");
		const first = this.rows()[0];
		this.active = first ? first.name : null;
		this.render();
	}

	// ---- the rail: which message is being written ---------------------------------------------

	render() {
		const rows = this.rows();
		if (!rows.some((r) => r.name === this.active)) this.active = rows.length ? rows[0].name : null;
		this.$el.find(".sanad-mc__count").text(ui.plural(rows.length, { one: __("{0} message"), other: __("{0} messages") }));
		this.render_head_actions();
		this.render_rail(rows);
		this.render_editor();
		return this;
	}

	render_head_actions() {
		this.$actions.empty();
		if (!this.can_edit()) return;
		this.add_button(this.$actions, "btn btn-sm btn-primary sanad-mc__add");
	}

	/**
	 * "Add message" does not add a message: it asks what kind of message, and adds that. The type
	 * is the one thing about a message that cannot be typed into a field, so it is asked at the
	 * only moment the writer is thinking about it — and the same list answers "change this one".
	 */
	add_button($host, cls) {
		const full = this.opts.max && this.rows().length >= cint(this.opts.max);
		const $wrap = $('<span class="sanad-mc__addwrap"></span>').appendTo($host);
		const $btn = $(`<button type="button" class="${cls}" aria-haspopup="menu" aria-expanded="false">${ui.icon("es-line-add", "xs")}<span>${ui.escape(__("Add message"))}</span>${ui.icon("es-line-down", "xs")}</button>`)
			.prop("disabled", !!full)
			.attr("title", full ? __("This record may carry {0} messages.", [ui.format_int(this.opts.max)]) : __("Choose what the next message is"))
			.on("click", (e) => {
				e.stopPropagation();
				this.open_type_menu($wrap, $btn, null, (type) => this.add(type));
			})
			.appendTo($wrap);
		return $btn;
	}

	render_rail(rows) {
		this.$rail.empty();
		if (!rows.length) {
			new sanad.ui.EmptyState({
				wrapper: this.$rail,
				state: "empty",
				size: "sm",
				title: this.opts.empty_text || __("No message yet"),
				action: this.can_edit() ? { label: __("Add the first message"), onclick: () => this.add() } : undefined,
			});
			return;
		}
		const $list = $('<ol class="sanad-mc__raillist"></ol>').appendTo(this.$rail);
		rows.forEach((row, index) => {
			const type = row[this.opts.type_field] || this.types[0];
			const on = row.name === this.active;
			const problem = this.problem_of(row);
			const $item = $(`
				<li class="sanad-mc__railitem${on ? " sanad-mc__railitem--on" : ""}${problem ? " sanad-mc__railitem--problem" : ""}">
					<button type="button" class="sanad-mc__railbtn" aria-current="${on}" data-name="${ui.escape(row.name)}">
						<span class="sanad-mc__order sanad-tabular">${ui.escape(ui.format_int(index + 1))}</span>
						<span class="sanad-mc__railmain">
							<span class="sanad-mc__railtype">${ui.icon(icon_of(type), "xs")} ${ui.escape(__(type || ""))}</span>
							<span class="sanad-mc__railline" dir="auto">${ui.escape(this.summary_of(row))}</span>
						</span>
						${problem ? `<span class="sanad-mc__raildot" title="${ui.escape(problem)}" aria-label="${ui.escape(problem)}"></span>` : ""}
					</button>
					<span class="sanad-mc__railactions"></span>
				</li>`);
			$item.find(".sanad-mc__railbtn").on("click", () => this.select(row.name));
			const $acts = $item.find(".sanad-mc__railactions");
			if (this.can_edit()) {
				const btn = (icon, label, disabled, handler) =>
					$(`<button type="button" class="sanad-mc__icon-btn" title="${ui.escape(label)}" aria-label="${ui.escape(label)}">${ui.icon(icon, "xs")}</button>`)
						.prop("disabled", !!disabled)
						.on("click", (e) => {
							e.stopPropagation();
							handler();
						})
						.appendTo($acts);
				btn("es-line-up", __("Move up"), index === 0, () => this.move(row, -1));
				btn("es-line-down", __("Move down"), index === rows.length - 1, () => this.move(row, 1));
				btn("es-line-duplicate", __("Duplicate"), false, () => this.duplicate(row));
				btn("es-line-delete", __("Delete"), false, () => this.remove(row));
			}
			$list.append($item);
			if (this.opts.delay_field && index < rows.length - 1) $list.append(this.rail_delay(rows[index + 1]));
		});
		// the verb again at the foot of the list, where the eye already is once it has read it
		if (this.can_edit()) this.add_button($('<div class="sanad-mc__railadd"></div>').appendTo(this.$rail), "sanad-mc__railaddbtn");
	}

	/** Between two rail items: how long the campaign waits before the next message. */
	rail_delay(next_row) {
		const seconds = cint(next_row[this.opts.delay_field]);
		const label = seconds ? __("wait {0}", [this.duration(seconds)]) : __("no wait");
		const $li = $(`<li class="sanad-mc__railwait">
			<button type="button" class="sanad-mc__delay">${ui.icon("es-line-time", "xs")} <span>${ui.escape(label)}</span></button>
		</li>`);
		$li.find("button").on("click", () => this.ask_delay(next_row));
		return $li;
	}

	select(name) {
		this.active = name;
		this.render_rail(this.rows());
		this.render_editor();
		window.setTimeout(() => this.$editor.find("textarea, input, select").first().trigger("focus"), 30);
	}

	// ---- the editor ---------------------------------------------------------------------------

	render_editor() {
		this.$editor.empty();
		const row = this.row_of(this.active);
		if (!row) return;
		const type = row[this.opts.type_field] || this.types[0];
		const $head = $(`<div class="sanad-mc__etop"></div>`).appendTo(this.$editor);
		this.render_type_control($head, row);
		$(`<button type="button" class="sanad-mc__toggle-preview" aria-pressed="${this.show_preview}">${ui.icon("es-line-preview", "xs")} <span>${ui.escape(this.show_preview ? __("Hide preview") : __("Show preview"))}</span></button>`)
			.on("click", () => {
				this.show_preview = !this.show_preview;
				this.render_editor();
			})
			.appendTo($head);

		const $grid = $(`<div class="sanad-mc__egrid${this.show_preview ? "" : " sanad-mc__egrid--nopreview"}"></div>`).appendTo(this.$editor);
		const $form = $('<div class="sanad-mc__eform"></div>').appendTo($grid);
		if (this.show_preview) {
			$(`<aside class="sanad-mc__epreview">
					<span class="sanad-mc__pane-label">${ui.escape(__("As the recipient will see it"))}</span>
					<div class="sanad-mc__chat"></div>
					<div class="sanad-mc__errors" role="alert"></div>
				</aside>`).appendTo($grid);
		}
		this.render_fields($form, row, type);
		this.render_delay($form, row);
		this.preview(row);
	}

	/**
	 * The type, as one control instead of nine. A button per type spent a whole band of the editor
	 * on a choice that is made once per message and never looked at again, and read as a toolbar
	 * rather than as an answer to "what is this?". One pill says what the message is; it opens the
	 * list of what else it could be, grouped, each with the line that tells it from its neighbours.
	 */
	render_type_control($host, row) {
		const current = row[this.opts.type_field] || this.types[0];
		const type_label = __((this.field_map[this.opts.type_field] || {}).label || "Type");
		const $wrap = $('<div class="sanad-mc__typewrap"></div>').appendTo($host);
		const $btn = $(`
			<button type="button" class="sanad-mc__typepick" aria-haspopup="menu" aria-expanded="false">
				<span class="sanad-mc__typepick-icon" aria-hidden="true">${ui.icon(icon_of(current), "sm")}</span>
				<span class="sanad-mc__typepick-text">
					<span class="sanad-mc__typepick-caption">${ui.escape(type_label)}</span>
					<span class="sanad-mc__typepick-name">${ui.escape(__(current || ""))}</span>
				</span>
				<span class="sanad-mc__typepick-caret" aria-hidden="true">${ui.icon("es-line-down", "xs")}</span>
			</button>`).appendTo($wrap);
		if (!this.can_edit()) {
			$btn.prop("disabled", true).find(".sanad-mc__typepick-caret").remove();
			return;
		}
		$btn.attr("aria-label", __("{0}: {1}. Change it.", [type_label, __(current || "")])).on("click", (e) => {
			e.stopPropagation();
			this.open_type_menu($wrap, $btn, current, (type) => {
				frappe.model.set_value(row.doctype, row.name, this.opts.type_field, type);
				this.render();
			});
		});
	}

	/**
	 * The list of what a message can be. `current` is the type to tick, or null when the list is
	 * being used to add a message rather than to change one.
	 */
	open_type_menu($host, $btn, current, on_pick) {
		if (this.close_type_menu(true)) return; // a second click on the same button closes it
		const $menu = $(`<div class="sanad-mc__typemenu" role="menu" aria-label="${ui.escape(__("Message type"))}"></div>`).appendTo($host);
		const shelves = GROUPS.map((g) => [g, this.types.filter((t) => ((TYPES[t] || {}).group || GROUPS[GROUPS.length - 1].key) === g.key)]);
		shelves.forEach(([group, types]) => {
			if (!types.length) return;
			$(`<p class="sanad-mc__typegroup">${ui.escape(group.label())}</p>`).appendTo($menu);
			types.forEach((type) => {
				const meta = TYPES[type] || {};
				const on = type === current;
				$(`
					<button type="button" class="sanad-mc__typeopt${on ? " sanad-mc__typeopt--on" : ""}" role="menuitemradio" aria-checked="${on}" tabindex="-1">
						<span class="sanad-mc__typeopt-icon" aria-hidden="true">${ui.icon(icon_of(type), "sm")}</span>
						<span class="sanad-mc__typeopt-text">
							<span class="sanad-mc__typeopt-name">${ui.escape(__(type))}</span>
							${meta.hint ? `<span class="sanad-mc__typeopt-hint">${ui.escape(meta.hint())}</span>` : ""}
						</span>
						<span class="sanad-mc__typeopt-tick" aria-hidden="true">${on ? ui.icon("es-line-check", "xs") : ""}</span>
					</button>`)
					.on("click", (e) => {
						e.stopPropagation();
						this.close_type_menu();
						if (type !== current) on_pick(type);
					})
					.appendTo($menu);
			});
		});
		$btn.attr("aria-expanded", "true");
		this.type_menu = { $menu, $btn };
		$menu.on("keydown", (e) => {
			if (e.key === "Escape") {
				e.preventDefault();
				this.close_type_menu(true);
				return;
			}
			const items = $menu.find('[role="menuitemradio"]').toArray();
			const idx = ui.roving_index(e, items, items.indexOf(document.activeElement));
			if (idx < 0) return;
			e.preventDefault();
			items[idx].focus();
		});
		window.setTimeout(() => {
			$(document).on(`click.${this.id}-types`, () => this.close_type_menu());
			const items = $menu.find('[role="menuitemradio"]').toArray();
			const start = items.find((el) => el.getAttribute("aria-checked") === "true") || items[0];
			start && start.focus();
		}, 0);
	}

	close_type_menu(restore_focus) {
		$(document).off(`click.${this.id}-types`);
		const open = this.type_menu;
		if (!open) return false;
		open.$menu.remove();
		open.$btn.attr("aria-expanded", "false");
		if (restore_focus) open.$btn.trigger("focus");
		this.type_menu = null;
		return true;
	}

	/** The fields this type uses: the ones that lead it first, the rest behind "More options". */
	render_fields($form, row, type) {
		const allowed = this.editable_fields.filter((f) => this.shows(this.field_map[f], row));
		const lead = (this.opts.primary_fields || {})[type] || allowed;
		const primary = allowed.filter((f) => lead.includes(f));
		const rest = allowed.filter((f) => !lead.includes(f));
		const controls = {};
		this.controls.set(row.name, controls);

		primary.forEach((fieldname) => this.field(  $form, row, fieldname, controls));
		if (!rest.length) return;
		const $more = $(`<details class="sanad-mc__more"><summary>${ui.escape(__("More options"))}</summary></details>`).appendTo($form);
		rest.forEach((fieldname) => this.field($more, row, fieldname, controls));
	}

	field($host, row, fieldname, controls) {
		const df = this.field_map[fieldname];
		const is_body = fieldname === this.opts.body_field || (df.fieldtype === "Small Text" && fieldname === "caption");
		const $wrap = $(`<div class="sanad-mc__field sanad-mc__field--${ui.escape(df.fieldtype.toLowerCase().replace(/\s+/g, "-"))}"></div>`).appendTo($host);
		let ready = false;
		const control = frappe.ui.form.make_control({
			df: Object.assign({}, df, {
				read_only: this.can_edit() ? df.read_only : 1,
				// no doctype/docname on purpose: a bound control writes on render and the form
				// would be "Not saved" before the writer typed anything
				change: () => {
					if (!ready) return;
					const value = control.get_value();
					if (String(value == null ? "" : value) === String(row[fieldname] == null ? "" : row[fieldname])) return;
					frappe.model.set_value(row.doctype, row.name, fieldname, value);
					this.touch(row);
				},
			}),
			parent: $wrap,
			render_input: true,
			only_input: false,
		});
		control.set_value(row[fieldname] == null ? "" : row[fieldname]);
		window.setTimeout(() => (ready = true), 0);
		controls[fieldname] = control;
		if (is_body && control.$input) {
			control.$input.attr("rows", 7);
			this.render_toolbar($wrap, row, fieldname, control);
		}
	}

	/** The writing toolbar: WhatsApp's marks, and the variables, over the field they act on. */
	render_toolbar($wrap, row, fieldname, control) {
		if (!this.can_edit()) return;
		const $bar = $('<div class="sanad-mc__toolbar"></div>').insertAfter($wrap.find(".control-input-wrapper").first().length ? $wrap.find(".control-input-wrapper").first() : $wrap.children().first());
		MARKS.forEach((m) => {
			$(`<button type="button" class="sanad-mc__mark" title="${ui.escape(m.label())}" aria-label="${ui.escape(m.label())}">${ui.icon(m.icon, "xs")}</button>`)
				.on("click", () => this.wrap_selection(row, fieldname, control, m.mark))
				.appendTo($bar);
		});
		const $vars = $(`<div class="sanad-mc__varpick"></div>`).appendTo($bar);
		$(`<button type="button" class="sanad-mc__varbtn" aria-haspopup="listbox" aria-expanded="false">${ui.icon("es-line-add", "xs")} ${ui.escape(__("Variable"))}</button>`)
			.on("click", (e) => {
				e.stopPropagation();
				this.toggle_vars($vars, row, fieldname, control);
			})
			.appendTo($vars);
	}

	toggle_vars($host, row, fieldname, control) {
		const open = $host.find(".sanad-mc__varmenu").length;
		$(document).off(`click.${this.id}-vars`);
		$host.find(".sanad-mc__varmenu").remove();
		$host.find(".sanad-mc__varbtn").attr("aria-expanded", open ? "false" : "true");
		if (open) return;
		const list = this.variables || [];
		const $menu = $('<div class="sanad-mc__varmenu" role="listbox"></div>').appendTo($host);
		if (!list.length) $menu.append(`<p class="sanad-mc__hint">${ui.escape(__("No variable is offered for this record."))}</p>`);
		list.forEach((v) => {
			$(`<button type="button" class="sanad-mc__varopt" role="option">
					<span class="sanad-mc__var-label">${ui.escape(__(v.label || v.name))}</span>
					<span class="sanad-mc__var-name">${ui.escape(v.name)}</span>
				</button>`)
				.on("click", () => {
					this.insert_at_caret(row, fieldname, control, `{{ ${v.name} }}`);
					this.toggle_vars($host, row, fieldname, control);
				})
				.appendTo($menu);
		});
		window.setTimeout(() => $(document).on(`click.${this.id}-vars`, () => this.toggle_vars($host, row, fieldname, control)), 0);
	}

	/** Put marks around what is selected, or at the caret when nothing is selected. */
	wrap_selection(row, fieldname, control, mark) {
		const input = control.$input && control.$input[0];
		const value = String(control.get_value() || "");
		if (!input || typeof input.selectionStart !== "number") return this.insert_at_caret(row, fieldname, control, `${mark}${mark}`);
		const start = input.selectionStart;
		const end = input.selectionEnd;
		const chosen = value.slice(start, end) || __("text");
		const next = `${value.slice(0, start)}${mark}${chosen}${mark}${value.slice(end)}`;
		control.set_value(next);
		frappe.model.set_value(row.doctype, row.name, fieldname, next);
		this.touch(row);
		window.setTimeout(() => {
			input.focus();
			input.setSelectionRange(start + mark.length, start + mark.length + chosen.length);
		}, 0);
	}

	insert_at_caret(row, fieldname, control, token) {
		const input = control.$input && control.$input[0];
		const value = String(control.get_value() || "");
		let next = value + token;
		let caret = next.length;
		if (input && typeof input.selectionStart === "number") {
			const start = input.selectionStart;
			next = value.slice(0, start) + token + value.slice(input.selectionEnd);
			caret = start + token.length;
		}
		control.set_value(next);
		frappe.model.set_value(row.doctype, row.name, fieldname, next);
		this.touch(row);
		window.setTimeout(() => {
			if (!input) return;
			input.focus();
			input.setSelectionRange(caret, caret);
		}, 0);
		ui.announce(__("{0} inserted", [token]));
	}

	/** The wait before this message, written as a sentence under the editor. */
	render_delay($form, row) {
		if (!this.opts.delay_field) return;
		const rows = this.rows();
		if (rows.findIndex((r) => r.name === row.name) === 0) return; // the first message waits for nothing
		const seconds = cint(row[this.opts.delay_field]);
		const $line = $(`<div class="sanad-mc__delayline">
				<span>${ui.escape(__("Send it"))}</span>
				<button type="button" class="sanad-mc__delay">${ui.icon("es-line-time", "xs")} <span>${ui.escape(seconds ? this.duration(seconds) : __("immediately"))}</span></button>
				<span>${ui.escape(__("after the message before it."))}</span>
			</div>`).appendTo($form);
		$line.find("button").on("click", () => this.ask_delay(row));
	}

	// ---- reading a message --------------------------------------------------------------------

	shows(df, row) {
		if (!df) return false;
		if (!df.depends_on) return true;
		try {
			return !!frappe.utils.eval(String(df.depends_on).replace(/^eval:/, ""), { doc: row, parent: this.frm.doc });
		} catch (e) {
			return true;
		}
	}

	/** In the rail a variable reads as what it stands for, not as its path in braces. */
	plain(text) {
		const labels = {};
		(this.variables || []).forEach((v) => (labels[v.name] = __(v.label || v.name)));
		return String(text || "").replace(/\{\{\s*([^}]+?)\s*\}\}/g, (m, name) => labels[name] || name.split(".").pop());
	}

	summary_of(row) {
		const type = row[this.opts.type_field];
		if (type === "Poll") return row.poll_question || __("No question yet");
		if (type === "Location") return __("A location");
		const body = this.plain((row[this.opts.body_field] || row.caption || "").trim());
		if (body) return body.length > 60 ? `${body.slice(0, 60)}…` : body;
		if (row.attachment) return decodeURIComponent(String(row.attachment).split("/").pop());
		if (row.print_format) return __("The document, as {0}", [row.print_format]);
		return __("Nothing to send yet");
	}

	problem_of(row) {
		const type = row[this.opts.type_field];
		if (!type) return __("Pick a type");
		if (type === "Poll") {
			if (!row.poll_question) return __("The question is missing");
			if (this.poll_options(row).length < 2) return __("At least two answers");
			return "";
		}
		if (["Document", "Image", "Video", "Audio", "Sticker"].includes(type)) {
			if (!row.attachment && !(type === "Document" && row.print_format)) return __("No file yet");
			return "";
		}
		if (type === "Text" && !(row[this.opts.body_field] || "").trim()) return __("The text is empty");
		return "";
	}

	poll_options(row) {
		try {
			const parsed = typeof row.poll_options === "string" ? JSON.parse(row.poll_options || "[]") : row.poll_options || [];
			return Array.isArray(parsed) ? parsed.filter((o) => String(o || "").trim()) : [];
		} catch (e) {
			return [];
		}
	}

	duration(seconds) {
		const n = cint(seconds);
		if (n < 60) return __("{0} s", [ui.format_int(n)]);
		if (n < 3600) return __("{0} min", [ui.format_int(Math.round(n / 60))]);
		return __("{0} h", [ui.format_int(Math.round(n / 360) / 10)]);
	}

	touch(row) {
		this.render_rail(this.rows());
		this.debounced_preview = this.debounced_preview || ui.debounce((r) => this.preview(r), this.opts.debounce);
		this.debounced_preview(row);
	}

	// ---- the preview --------------------------------------------------------------------------

	preview(row) {
		const $chat = this.$editor.find(".sanad-mc__chat");
		if (!$chat.length) return;
		this.draw_bubble($chat, this.local_preview(row));
		if (!this.opts.preview || this.frm.is_new() || this.frm.is_dirty()) return;
		ui.call(this.opts.preview.method, this.opts.preview.args(row, this.frm), { silent: true })
			.then((p) => {
				if (this.active !== row.name) return;
				this.draw_bubble($chat, { type: p.message_type || row[this.opts.type_field], body: p.body, attachment: p.attachment_name, image: this.local_preview(row).image, poll: this.poll_of(row) });
				const errors = p.errors || [];
				this.$editor.find(".sanad-mc__errors").html(errors.length ? `<ul>${errors.map((e) => `<li>${ui.escape(e)}</li>`).join("")}</ul>` : "");
			})
			.catch(() => {});
	}

	local_preview(row) {
		const type = row[this.opts.type_field];
		const file = row.attachment ? decodeURIComponent(String(row.attachment).split("/").pop()) : "";
		const media = ["Document", "Image", "Video", "Audio", "Sticker"].includes(type);
		return {
			type,
			body: media ? row.caption || "" : row[this.opts.body_field] || "",
			attachment: file || (row.print_format ? __("{0} (PDF)", [row.print_format]) : ""),
			image: ["Image", "Sticker"].includes(type) && row.attachment ? row.attachment : null,
			poll: this.poll_of(row),
		};
	}

	poll_of(row) {
		if (row[this.opts.type_field] !== "Poll") return null;
		return { question: row.poll_question || __("No question yet"), options: this.poll_options(row), multiple: !!cint(row.poll_allow_multiple) };
	}

	draw_bubble($chat, message) {
		const now = frappe.datetime.now_datetime().slice(11, 16);
		const body = (message.body || "").trim();
		let inner = "";
		if (message.image) inner += `<span class="sanad-mc__thumb" data-file="${ui.escape(message.attachment || "")}"><img src="${ui.escape(message.image)}" alt="${ui.escape(message.attachment || __("Image"))}" loading="lazy"></span>`;
		else if (message.attachment) inner += `<span class="sanad-mc__file">${ui.icon("es-line-filetype", "xs")} <span dir="auto">${ui.escape(message.attachment)}</span></span>`;
		if (message.poll) {
			inner += `<span class="sanad-mc__poll">
				<span class="sanad-mc__poll-q" dir="auto">${ui.escape(message.poll.question)}</span>
				${(message.poll.options.length ? message.poll.options : [__("No answer yet")]).map((o) => `<span class="sanad-mc__poll-o" dir="auto">${ui.escape(o)}</span>`).join("")}
				<span class="sanad-mc__poll-note">${ui.escape(message.poll.multiple ? __("More than one answer allowed") : __("One answer"))}</span>
			</span>`;
		}
		if (body) inner += `<span class="sanad-mc__text" dir="auto">${this.format_body(body)}</span>`;
		if (!inner) inner = `<span class="sanad-mc__text sanad-mc__text--empty">${ui.escape(__("Nothing to send yet"))}</span>`;
		$chat.html(`<div class="sanad-mc__bubble">${inner}<span class="sanad-mc__meta"><span class="sanad-tabular">${ui.escape(now)}</span>${ui.icon("es-line-double-check", "xs")}</span></div>`);
		$chat.find(".sanad-mc__thumb img").on("error", (e) => {
			const $thumb = $(e.currentTarget).closest(".sanad-mc__thumb");
			const file = $thumb.attr("data-file") || __("The file is missing");
			$thumb.replaceWith(`<span class="sanad-mc__file">${ui.icon("es-line-filetype", "xs")} <span dir="auto">${ui.escape(file)}</span></span>`);
		});
	}

	/**
	 * WhatsApp's own marks, and a variable that has not been filled in yet as a chip. The
	 * variables are lifted out before the marks run: an underscore inside
	 * `{{ recipient.display_name }}` is part of a name, not a request for italics.
	 */
	format_body(text) {
		const vars = [];
		let html = ui.escape(text).replace(/\{\{([^}]+)\}\}/g, (m, name) => {
			vars.push(name.trim());
			return `\u0000${vars.length - 1}\u0000`;
		});
		html = html.replace(/\*([^*\n]+)\*/g, "<b>$1</b>");
		html = html.replace(/_([^_\n]+)_/g, "<i>$1</i>");
		html = html.replace(/~([^~\n]+)~/g, "<s>$1</s>");
		html = html.replace(/```([^`]+)```/g, "<code>$1</code>");
		html = html.replace(/\u0000(\d+)\u0000/g, (m, i) => `<span class="sanad-mc__var">${vars[cint(i)]}</span>`);
		return html.replace(/\n/g, "<br>");
	}

	// ---- variables ----------------------------------------------------------------------------

	load_variables() {
		if (!this.opts.variables) return Promise.resolve([]);
		if (Array.isArray(this.opts.variables)) {
			this.variables = this.opts.variables;
			return Promise.resolve(this.variables);
		}
		return ui
			.call(this.opts.variables.method, this.opts.variables.args ? this.opts.variables.args(this.frm) : {}, { silent: true })
			.then((list) => {
				this.variables = list || [];
				this.render_rail(this.rows()); // the labels the rail prints arrive with them
				return this.variables;
			})
			.catch(() => []);
	}

	// ---- the set ------------------------------------------------------------------------------

	ask_delay(row) {
		if (!this.can_edit()) return;
		const d = new frappe.ui.Dialog({
			title: __("Wait before this message"),
			fields: [{ fieldtype: "Int", fieldname: "seconds", label: __("Seconds"), default: cint(row[this.opts.delay_field]), description: __("0 sends it as soon as the one before it has left.") }],
			primary_action_label: __("Set"),
			primary_action: ({ seconds }) => {
				frappe.model.set_value(row.doctype, row.name, this.opts.delay_field, Math.max(0, cint(seconds)));
				d.hide();
				this.render();
			},
		});
		d.show();
	}

	add(type) {
		if (!this.can_edit()) return;
		if (this.opts.max && this.rows().length >= cint(this.opts.max)) return;
		const row = this.frm.add_child(this.fieldname, { [this.opts.type_field]: type || this.types[0] || "Text" });
		this.frm.refresh_field(this.fieldname);
		this.active = row.name;
		this.render();
		window.setTimeout(() => this.$editor.find("textarea, input").first().trigger("focus"), 50);
	}

	duplicate(row) {
		if (!this.can_edit()) return;
		const copy = Object.assign({}, row);
		["name", "idx", "creation", "modified", "owner", "modified_by", "parent", "parentfield", "parenttype", "docstatus", "__islocal", "__unsaved"].forEach((k) => delete copy[k]);
		const made = this.frm.add_child(this.fieldname, copy);
		this.frm.refresh_field(this.fieldname);
		this.active = made.name;
		this.render();
		ui.announce(__("Message duplicated"));
	}

	remove(row) {
		if (!this.can_edit()) return;
		const rows = this.rows();
		const doit = () => {
			this.frm.doc[this.fieldname] = rows.filter((r) => r.name !== row.name);
			this.frm.doc[this.fieldname].forEach((r, i) => (r.idx = i + 1));
			if (this.active === row.name) this.active = null;
			this.frm.refresh_field(this.fieldname);
			this.frm.dirty();
			this.render();
			ui.announce(__("Message removed"));
		};
		if (this.problem_of(row) === __("The text is empty") || this.summary_of(row) === __("Nothing to send yet")) return doit();
		sanad.ui.ConfirmDialog.ask({
			title: __("Remove message {0}?", [ui.format_int(rows.findIndex((r) => r.name === row.name) + 1)]),
			message: this.summary_of(row),
			danger: true,
			confirm_label: __("Remove"),
			on_confirm: () => Promise.resolve(),
		})
			.then(doit)
			.catch(() => {});
	}

	move(row, delta) {
		if (!this.can_edit()) return;
		const rows = this.rows();
		const from = rows.findIndex((r) => r.name === row.name);
		const to = from + delta;
		if (to < 0 || to >= rows.length) return;
		rows.splice(to, 0, rows.splice(from, 1)[0]);
		rows.forEach((r, i) => (r.idx = i + 1));
		this.frm.doc[this.fieldname] = rows;
		this.frm.refresh_field(this.fieldname);
		this.frm.dirty();
		this.render();
		ui.announce(__("Message moved to position {0}", [ui.format_int(to + 1)]));
	}

	refresh() {
		this.resolve_meta();
		this.render();
		return this;
	}

	destroy() {
		this.close_type_menu();
		$(document).off(`click.${this.id}-vars`);
		this.$el && this.$el.remove();
		this.$host && this.$host.removeClass("sanad-mc-host");
	}
};

export default sanad.ui.MessageComposer;

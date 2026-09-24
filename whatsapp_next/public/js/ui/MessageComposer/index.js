// MessageComposer — the ordered messages a record will send, drawn as the conversation they will
// produce instead of as a child-table grid.
//
// A grid asks the reader to imagine the result from a row of inputs. This component shows it: each
// message is a card that opens into its own editor beside a live bubble, and the gap between two
// cards *is* the delay between them. Which fields a message shows is read from the child DocType's
// own `depends_on` rules, so a host app adds a message type by adding it to the Select and the
// component follows.

import ui from "../_core/index.js";

const TYPE_ICON = {
	Text: "es-line-chat-alt",
	Document: "es-line-file",
	Image: "es-line-image",
	Video: "es-line-video",
	Audio: "es-line-sound",
	Sticker: "es-line-emoji",
	Location: "es-line-location",
	Poll: "es-line-list",
	Template: "es-line-copy",
};

sanad.ui.MessageComposer = class MessageComposer {
	/**
	 * @param {object} opts
	 * @param {object} opts.frm — the host form
	 * @param {string} opts.fieldname — the Table field holding the messages
	 * @param {string} [opts.type_field="message_type"]
	 * @param {string} [opts.body_field="body"]
	 * @param {string} [opts.delay_field] — Int seconds; drawn as the connector between two cards
	 * @param {Array<string>} [opts.fields] — the fields the editor offers (default: every field of
	 *   the child DocType that is not a layout break, in meta order)
	 * @param {{method: string, args: Function}} [opts.preview] — `args(row, frm)`; the reply is
	 *   `{body, attachment_name, message_type, errors[]}` and is drawn inside the bubble
	 * @param {{method: string, args: Function}} [opts.variables] — `[{name, label, fieldtype}]`
	 * @param {Function} [opts.can_edit] — `() => boolean` (default: the form is editable)
	 * @param {string} [opts.empty_text]
	 * @param {number} [opts.max] — refuse to add beyond this many messages
	 */
	constructor(opts = {}) {
		this.opts = Object.assign({ type_field: "message_type", body_field: "body", debounce: 500 }, opts);
		this.frm = this.opts.frm;
		this.fieldname = this.opts.fieldname;
		this.id = ui.uid("mc");
		this.open = new Set(); // the rows the reader has expanded
		this.previews = new Map(); // row name → last preview payload
		this.controls = new Map(); // row name → {fieldname: control}
		this.resolve_meta();
		this.mount();
		this.load_variables();
	}

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
		const type_df = this.field_map[this.opts.type_field] || {};
		this.types = (type_df.options || "").split("\n").filter(Boolean);
	}

	rows() {
		return (this.frm.doc[this.fieldname] || []).slice().sort((a, b) => cint(a.idx) - cint(b.idx));
	}

	can_edit() {
		if (typeof this.opts.can_edit === "function") return !!this.opts.can_edit();
		return !this.frm.doc.__islocal ? !this.frm.is_read_only() : true;
	}

	// ---- mounting ---------------------------------------------------------------------------

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
				<div class="sanad-mc__list" role="list"></div>
				<p class="sanad-mc__foot"></p>
			</div>`);
		const $existing = this.frm.$wrapper.find(`.sanad-mc[data-fieldname="${this.fieldname}"]`);
		if ($existing.length) $existing.replaceWith(this.$el);
		else if (this.$host && this.$host.length) this.$host.append(this.$el);
		else this.frm.$wrapper.find(".form-page").first().append(this.$el);
		// the native grid stays in the DOM (Frappe saves from it) but never shows: this component is
		// the way in, and a second, different editor of the same rows is how data goes out of step
		if (this.$host) this.$host.addClass("sanad-mc-host");
		this.$list = this.$el.find(".sanad-mc__list");
		this.$actions = this.$el.find(".sanad-mc__head-actions");
		this.render();
	}

	// ---- the list ---------------------------------------------------------------------------

	render() {
		const rows = this.rows();
		this.$list.empty();
		this.$el.find(".sanad-mc__count").text(ui.plural(rows.length, { one: __("{0} message"), other: __("{0} messages") }));
		if (!rows.length) {
			new sanad.ui.EmptyState({
				wrapper: this.$list,
				state: "empty",
				size: "sm",
				title: this.opts.empty_text || __("No message yet"),
				description: __("A campaign sends every message below, in order, to every recipient."),
				action: this.can_edit() ? { label: __("Add the first message"), onclick: () => this.add() } : undefined,
			});
		} else {
			rows.forEach((row, i) => {
				if (i && this.opts.delay_field) this.$list.append(this.connector(row));
				this.$list.append(this.card(row, i));
			});
		}
		this.render_head_actions();
		this.$el.find(".sanad-mc__foot").text(
			rows.length > 1 ? __("Every recipient receives all {0} messages, in this order.", [ui.format_int(rows.length)]) : ""
		);
		this.open.forEach((name) => this.mount_editor(name));
		return this;
	}

	render_head_actions() {
		this.$actions.empty();
		if (!this.can_edit()) return;
		const full = this.opts.max && this.rows().length >= cint(this.opts.max);
		const $add = $(`<button type="button" class="btn btn-sm btn-default sanad-mc__add">${ui.icon("es-line-add", "xs")} ${ui.escape(__("Add message"))}</button>`)
			.prop("disabled", !!full)
			.on("click", () => this.add());
		this.$actions.append($add);
		if (full) this.$actions.append(`<span class="sanad-mc__hint">${ui.escape(__("A campaign may carry {0} messages.", [ui.format_int(this.opts.max)]))}</span>`);
	}

	/** The gap between two messages, which is also where their delay is set. */
	connector(row) {
		const seconds = cint(row[this.opts.delay_field]);
		const label = seconds ? __("after {0}", [this.duration(seconds)]) : __("immediately after");
		const $c = $(`
			<div class="sanad-mc__connector" role="listitem">
				<span class="sanad-mc__connector-line" aria-hidden="true"></span>
				<button type="button" class="sanad-mc__delay" aria-label="${ui.escape(__("Delay before message {0}", [row.idx]))}">${ui.icon("es-line-time", "xs")} <span>${ui.escape(label)}</span></button>
				<span class="sanad-mc__connector-line" aria-hidden="true"></span>
			</div>`);
		$c.find(".sanad-mc__delay").on("click", () => this.ask_delay(row));
		return $c;
	}

	duration(seconds) {
		const n = cint(seconds);
		if (n < 60) return __("{0} s", [ui.format_int(n)]);
		if (n < 3600) return __("{0} min", [ui.format_int(Math.round(n / 60))]);
		return __("{0} h", [ui.format_int(Math.round(n / 360) / 10)]);
	}

	ask_delay(row) {
		if (!this.can_edit()) return;
		const d = new frappe.ui.Dialog({
			title: __("Wait before this message"),
			fields: [
				{
					fieldtype: "Int",
					fieldname: "seconds",
					label: __("Seconds"),
					default: cint(row[this.opts.delay_field]),
					description: __("0 sends it as soon as the one before it has left."),
				},
			],
			primary_action_label: __("Set"),
			primary_action: ({ seconds }) => {
				frappe.model.set_value(row.doctype, row.name, this.opts.delay_field, Math.max(0, cint(seconds)));
				d.hide();
				this.render();
			},
		});
		d.show();
	}

	/** One message: a summary line that opens into its editor. */
	card(row, index) {
		const type = row[this.opts.type_field] || this.types[0] || "Text";
		const open = this.open.has(row.name);
		const problem = this.problem_of(row);
		const $card = $(`
			<section class="sanad-mc__card${open ? " sanad-mc__card--open" : ""}${problem ? " sanad-mc__card--problem" : ""}" role="listitem" data-name="${ui.escape(row.name)}">
				<header class="sanad-mc__card-head">
					<button type="button" class="sanad-mc__disclose" aria-expanded="${open}" aria-controls="${this.id}-${index}">
						<span class="sanad-mc__order sanad-tabular">${ui.escape(ui.format_int(index + 1))}</span>
						<span class="sanad-mc__type">${ui.icon(TYPE_ICON[type] || "es-line-chat-alt", "xs")} ${ui.escape(__(type))}</span>
						<span class="sanad-mc__summary" dir="auto">${ui.escape(this.summary_of(row))}</span>
						${problem ? `<span class="sanad-mc__problem">${ui.icon("es-line-alert-triangle", "xs")} ${ui.escape(problem)}</span>` : ""}
						<span class="sanad-mc__chevron" aria-hidden="true">${ui.icon(open ? "es-line-up" : "es-line-down", "xs")}</span>
					</button>
					<div class="sanad-mc__card-actions"></div>
				</header>
				<div class="sanad-mc__body" id="${this.id}-${index}"${open ? "" : " hidden"}></div>
			</section>`);

		$card.find(".sanad-mc__disclose").on("click", () => this.toggle(row.name));
		const $actions = $card.find(".sanad-mc__card-actions");
		if (this.can_edit()) {
			const rows = this.rows();
			const btn = (icon, label, disabled, handler) =>
				$(`<button type="button" class="sanad-mc__icon-btn" title="${ui.escape(label)}" aria-label="${ui.escape(label)}">${ui.icon(icon, "xs")}</button>`)
					.prop("disabled", !!disabled)
					.on("click", (e) => {
						e.stopPropagation();
						handler();
					})
					.appendTo($actions);
			btn("es-line-up", __("Move up"), index === 0, () => this.move(row, -1));
			btn("es-line-down", __("Move down"), index === rows.length - 1, () => this.move(row, 1));
			btn("es-line-duplicate", __("Duplicate"), false, () => this.duplicate(row));
			btn("es-line-delete", __("Delete"), false, () => this.remove(row));
		}
		return $card;
	}

	summary_of(row) {
		const type = row[this.opts.type_field];
		if (type === "Poll") return row.poll_question || __("No question yet");
		if (type === "Location") return __("A location");
		const body = (row[this.opts.body_field] || "").trim();
		if (body) return body.length > 90 ? `${body.slice(0, 90)}…` : body;
		if (row.attachment) return String(row.attachment).split("/").pop();
		if (row.print_format) return __("The document, as {0}", [row.print_format]);
		return __("Nothing to send yet");
	}

	/** What stops this message from going out, said in the reader's words. */
	problem_of(row) {
		const type = row[this.opts.type_field];
		if (!type) return __("Pick a type");
		if (type === "Poll") {
			const options = this.poll_options(row);
			if (!row.poll_question) return __("The question is missing");
			if (options.length < 2) return __("At least two answers");
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

	// ---- the editor -------------------------------------------------------------------------

	toggle(name) {
		if (this.open.has(name)) this.open.delete(name);
		else this.open.add(name);
		this.render();
	}

	mount_editor(name) {
		const row = this.rows().find((r) => r.name === name);
		const $card = this.$list.find(`.sanad-mc__card[data-name="${name}"]`);
		if (!row || !$card.length) return;
		const $body = $card.find(".sanad-mc__body").removeAttr("hidden").empty();
		$body.append(`
			<div class="sanad-mc__edit">
				<div class="sanad-mc__pane sanad-mc__pane--form"></div>
				<div class="sanad-mc__pane sanad-mc__pane--preview">
					<span class="sanad-mc__pane-label">${ui.escape(__("As the recipient will see it"))}</span>
					<div class="sanad-mc__chat"></div>
					<div class="sanad-mc__errors" role="alert"></div>
				</div>
			</div>`);
		const $form = $body.find(".sanad-mc__pane--form");
		this.render_types($form, row);
		this.render_fields($form, row);
		// the variables sit under the field they write into, not in a column of their own: the form
		// column of a Desk form is ~700 px and a third pane leaves the editor unusable
		const $vars = $(`<div class="sanad-mc__varsrow">
				<span class="sanad-mc__pane-label">${ui.escape(__("Insert a variable"))}</span>
				<div class="sanad-mc__vars"></div>
			</div>`).appendTo($form);
		this.render_vars($vars.find(".sanad-mc__vars"), row);
		this.preview(row);
	}

	render_types($pane, row) {
		const current = row[this.opts.type_field] || this.types[0];
		const $group = $(`<div class="sanad-mc__types" role="radiogroup" aria-label="${ui.escape(__(this.field_map[this.opts.type_field].label || "Type"))}"></div>`).appendTo($pane);
		this.types.forEach((type) => {
			const on = type === current;
			const $b = $(`<button type="button" class="sanad-mc__type-btn${on ? " sanad-mc__type-btn--on" : ""}" role="radio" aria-checked="${on}" tabindex="${on ? 0 : -1}">${ui.icon(TYPE_ICON[type] || "es-line-chat-alt", "xs")}<span>${ui.escape(__(type))}</span></button>`);
			$b.on("click", () => {
				if (!this.can_edit()) return;
				frappe.model.set_value(row.doctype, row.name, this.opts.type_field, type);
				this.render();
			});
			$group.append($b);
		});
		$group.on("keydown", (e) => {
			const items = $group.find('[role="radio"]').toArray();
			const idx = ui.roving_index(e, items, items.findIndex((el) => el.getAttribute("aria-checked") === "true"));
			if (idx < 0) return;
			e.preventDefault();
			items[idx].focus();
			items[idx].click();
		});
	}

	/** The fields this type actually uses, read from the child DocType's own `depends_on`. */
	render_fields($pane, row) {
		const $form = $('<div class="sanad-mc__fields"></div>').appendTo($pane);
		const controls = {};
		this.editable_fields.forEach((fieldname) => {
			const df = this.field_map[fieldname];
			if (!this.shows(df, row)) return;
			const $wrap = $('<div class="sanad-mc__field"></div>').appendTo($form);
			let ready = false;
			const control = frappe.ui.form.make_control({
				df: Object.assign({}, df, {
					read_only: this.can_edit() ? df.read_only : 1,
					// no `doctype`/`docname` on purpose: a control bound to the row writes to it as
					// soon as it is rendered, and the form was "Not saved" before the reader typed
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
			if (control.$input && ["Text", "Small Text", "Code"].includes(df.fieldtype)) {
				control.$input.attr("rows", df.fieldname === this.opts.body_field ? 6 : 3);
			}
			controls[fieldname] = control;
		});
		this.controls.set(row.name, controls);
	}

	shows(df, row) {
		if (!df.depends_on) return true;
		try {
			return !!frappe.utils.eval(String(df.depends_on).replace(/^eval:/, ""), { doc: row, parent: this.frm.doc });
		} catch (e) {
			return true;
		}
	}

	/** A change to a field the summary or the preview depends on. */
	touch(row) {
		const $card = this.$list.find(`.sanad-mc__card[data-name="${row.name}"]`);
		$card.find(".sanad-mc__summary").text(this.summary_of(row));
		const problem = this.problem_of(row);
		$card.toggleClass("sanad-mc__card--problem", !!problem);
		this.debounced_preview = this.debounced_preview || ui.debounce((r) => this.preview(r), this.opts.debounce);
		this.debounced_preview(row);
	}

	// ---- the bubble -------------------------------------------------------------------------

	/**
	 * The message as it will arrive. The server renders it when the record is saved (variables and
	 * all); before that, the text is shown as typed so the reader is never looking at an empty pane.
	 */
	preview(row) {
		const $card = this.$list.find(`.sanad-mc__card[data-name="${row.name}"]`);
		const $chat = $card.find(".sanad-mc__chat");
		if (!$chat.length) return;
		this.draw_bubble($chat, this.local_preview(row));
		if (!this.opts.preview || this.frm.is_new() || this.frm.is_dirty()) return;
		const args = this.opts.preview.args(row, this.frm);
		ui.call(this.opts.preview.method, args, { silent: true })
			.then((p) => {
				this.previews.set(row.name, p);
				this.draw_bubble($chat, {
					type: p.message_type || row[this.opts.type_field],
					body: p.body,
					attachment: p.attachment_name,
					poll: this.poll_of(row),
				});
				const $errors = $card.find(".sanad-mc__errors");
				const errors = p.errors || [];
				$errors.html(errors.length ? `<ul>${errors.map((e) => `<li>${ui.escape(e)}</li>`).join("")}</ul>` : "");
			})
			.catch(() => {});
	}

	local_preview(row) {
		return {
			type: row[this.opts.type_field],
			body: row[this.opts.body_field] || row.caption || "",
			attachment: row.attachment ? String(row.attachment).split("/").pop() : row.print_format ? __("{0} (PDF)", [row.print_format]) : "",
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
		if (message.attachment) {
			inner += `<span class="sanad-mc__file">${ui.icon("es-line-file", "xs")} <span dir="auto">${ui.escape(message.attachment)}</span></span>`;
		}
		if (message.poll) {
			inner += `<span class="sanad-mc__poll">
				<span class="sanad-mc__poll-q" dir="auto">${ui.escape(message.poll.question)}</span>
				${(message.poll.options.length ? message.poll.options : [__("No answer yet")])
					.map((o) => `<span class="sanad-mc__poll-o" dir="auto">${ui.escape(o)}</span>`)
					.join("")}
				<span class="sanad-mc__poll-note">${ui.escape(message.poll.multiple ? __("More than one answer allowed") : __("One answer"))}</span>
			</span>`;
		}
		if (body) inner += `<span class="sanad-mc__text" dir="auto">${this.format_body(body)}</span>`;
		if (!inner) inner = `<span class="sanad-mc__text sanad-mc__text--empty">${ui.escape(__("Nothing to send yet"))}</span>`;
		$chat.html(`
			<div class="sanad-mc__bubble">
				${inner}
				<span class="sanad-mc__meta"><span class="sanad-tabular">${ui.escape(now)}</span>${ui.icon("es-line-double-check", "xs")}</span>
			</div>`);
	}

	/** WhatsApp's own emphasis, and a variable that has not been filled in yet reads as a chip. */
	format_body(text) {
		let html = ui.escape(text);
		html = html.replace(/\{\{([^}]+)\}\}/g, (m, name) => `<span class="sanad-mc__var">${ui.escape(name.trim())}</span>`);
		html = html.replace(/\*([^*\n]+)\*/g, "<b>$1</b>");
		html = html.replace(/_([^_\n]+)_/g, "<i>$1</i>");
		html = html.replace(/~([^~\n]+)~/g, "<s>$1</s>");
		html = html.replace(/```([^`]+)```/g, "<code>$1</code>");
		return html.replace(/\n/g, "<br>");
	}

	// ---- variables --------------------------------------------------------------------------

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
				this.open.forEach((name) => {
					const $card = this.$list.find(`.sanad-mc__card[data-name="${name}"]`);
					const row = this.rows().find((r) => r.name === name);
					if (row && $card.length) this.render_vars($card.find(".sanad-mc__vars"), row);
				});
				return this.variables;
			})
			.catch(() => []);
	}

	render_vars($wrap, row) {
		if (!$wrap.length) return;
		const list = this.variables || [];
		if (!list.length) {
			$wrap.html(`<p class="sanad-mc__hint">${ui.escape(__("No variable is offered for this record."))}</p>`);
			return;
		}
		$wrap.empty();
		list.forEach((v) => {
			$(`<button type="button" class="sanad-mc__var-btn" title="{{ ${ui.escape(v.name)} }}">
					<span class="sanad-mc__var-label">${ui.escape(__(v.label || v.name))}</span>
					<span class="sanad-mc__var-name">${ui.escape(v.name)}</span>
				</button>`)
				.on("click", () => this.insert_variable(row, v.name))
				.appendTo($wrap);
		});
	}

	insert_variable(row, name) {
		if (!this.can_edit()) return;
		const controls = this.controls.get(row.name) || {};
		const control = controls[this.opts.body_field] || controls.caption || controls.poll_question;
		const token = `{{ ${name} }}`;
		if (!control) return;
		const input = control.$input && control.$input[0];
		const value = String(control.get_value() || "");
		let next = value + token;
		if (input && typeof input.selectionStart === "number") {
			const start = input.selectionStart;
			const end = input.selectionEnd;
			next = value.slice(0, start) + token + value.slice(end);
			control.set_value(next);
			window.setTimeout(() => {
				input.focus();
				input.setSelectionRange(start + token.length, start + token.length);
			}, 0);
		} else control.set_value(next);
		frappe.model.set_value(row.doctype, row.name, control.df.fieldname, next);
		this.touch(row);
		ui.announce(__("{0} inserted", [token]));
	}

	// ---- the set ----------------------------------------------------------------------------

	add() {
		if (!this.can_edit()) return;
		if (this.opts.max && this.rows().length >= cint(this.opts.max)) return;
		const row = this.frm.add_child(this.fieldname, { [this.opts.type_field]: this.types[0] || "Text" });
		this.frm.refresh_field(this.fieldname);
		this.open.add(row.name);
		this.render();
		window.setTimeout(() => {
			const $card = this.$list.find(`.sanad-mc__card[data-name="${row.name}"]`);
			$card[0] && $card[0].scrollIntoView({ block: "nearest", behavior: "smooth" });
			$card.find("textarea, input").first().trigger("focus");
		}, 50);
	}

	duplicate(row) {
		if (!this.can_edit()) return;
		const copy = Object.assign({}, row);
		["name", "idx", "creation", "modified", "owner", "modified_by", "parent", "parentfield", "parenttype", "docstatus", "__islocal", "__unsaved"].forEach((k) => delete copy[k]);
		const made = this.frm.add_child(this.fieldname, copy);
		this.frm.refresh_field(this.fieldname);
		this.open.add(made.name);
		this.render();
		ui.announce(__("Message duplicated"));
	}

	remove(row) {
		if (!this.can_edit()) return;
		const rows = this.rows();
		const doit = () => {
			this.frm.doc[this.fieldname] = rows.filter((r) => r.name !== row.name);
			this.frm.doc[this.fieldname].forEach((r, i) => (r.idx = i + 1));
			this.open.delete(row.name);
			this.frm.refresh_field(this.fieldname);
			this.frm.dirty();
			this.render();
			ui.announce(__("Message removed"));
		};
		const empty = !this.summary_of(row) || this.problem_of(row) === __("Nothing to send yet");
		if (empty) return doit();
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
		this.$el && this.$el.remove();
		this.$host && this.$host.removeClass("sanad-mc-host");
	}
};

export default sanad.ui.MessageComposer;

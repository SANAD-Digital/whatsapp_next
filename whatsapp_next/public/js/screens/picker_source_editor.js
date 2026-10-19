// The picker-source editor (owner, 2026-10-19: the old form "does not sense the fields or their
// types"). One window for the settings window's "Picker sources" section and for the rows of the
// `picker_sources` table on the WhatsApp Settings form.
//
// It does the knowing for the person (`services.picker_sources`):
// - the screen is chosen from those that can give numbers at all, each saying what it has;
// - choosing one reads its fields: the number fields with how many records fill each, the fields
//   that name a record, the links to a Contact — and fills every choice with the best guess;
// - each list offers only fields of the right kind, with their type and how full they are;
// - the server filters are Frappe's own filter builder, not JSON;
// - a live preview says how many records the source reaches and how many have a usable number,
//   with the first few of them.
// It writes nothing: `on_save(values)` gets the row and the caller stores it its own way.

frappe.provide("whatsapp_next");

(function () {
	const esc = (v) => frappe.utils.escape_html(v == null ? "" : String(v));
	const fmt = (n) => (sanad.ui.format_int ? sanad.ui.format_int(n) : String(n));
	let candidates_promise = null;

	const candidates = () =>
		(candidates_promise =
			candidates_promise ||
			sanad.ui.call("settings.list_picker_candidates", {}, { silent: true }).catch(() => {
				candidates_promise = null;
				return [];
			}));

	/** What a candidate screen offers, in a few words, for the screen list. */
	function describe(c) {
		const parts = [];
		if (c.phone_fields) parts.push(__("{0} number fields", [c.phone_fields]));
		if (c.contact_link) parts.push(__("linked contact"));
		return parts.join(" · ");
	}

	class PickerSourceEditor {
		/**
		 * @param {Object} opts
		 * @param {Object} [opts.row] — the row being edited; empty for a new one
		 * @param {string[]} [opts.taken] — screens other rows already use
		 * @param {Function} opts.on_save — `(values)`; values carry the row's fields
		 */
		constructor(opts) {
			this.opts = opts || {};
			this.row = Object.assign({}, this.opts.row || {});
			this.is_new = !this.row.document_type;
			this.info = null;
			this.make();
		}

		make() {
			const row = this.row;
			const d = (this.dialog = new frappe.ui.Dialog({
				title: this.is_new ? __("Add a picker source") : __("Edit the picker source"),
				size: "large",
				fields: [
					{
						fieldname: "document_type",
						label: __("Screen to pick from"),
						fieldtype: "Autocomplete",
						reqd: 1,
						options: [],
						description: __("Only the screens that hold a number or a link to a contact are listed."),
						onchange: () => this.on_screen(),
					},
					{ fieldname: "summary", fieldtype: "HTML" },
					{ fieldtype: "Section Break", fieldname: "how", label: __("How a person is reached"), hidden: 1 },
					{
						fieldname: "phone_source",
						label: __("Where the number comes from"),
						fieldtype: "Select",
						options: [
							{ value: "Field", label: __("A number field on the record") },
							{ value: "Linked Contact", label: __("The contact linked to the record") },
						],
						default: "Field",
						onchange: () => this.changed(),
					},
					{
						fieldname: "phone_fieldname",
						label: __("Number field"),
						fieldtype: "Select",
						depends_on: "eval:doc.phone_source=='Field'",
						onchange: () => this.changed(),
					},
					{
						fieldname: "contact_fieldname",
						label: __("Contact field"),
						fieldtype: "Select",
						depends_on: "eval:doc.phone_source=='Linked Contact'",
						onchange: () => this.changed(),
					},
					{ fieldtype: "Column Break" },
					{ fieldname: "label", label: __("Name in the picker"), fieldtype: "Data", description: __("The tab's title in the contact picker.") },
					{
						fieldname: "name_fieldname",
						label: __("Field that names each record"),
						fieldtype: "Select",
						onchange: () => this.changed(),
					},
					{ fieldname: "enabled", label: __("Offer it in the picker"), fieldtype: "Check", default: 1 },
					{ fieldtype: "Section Break", fieldname: "limits", label: __("Which records"), hidden: 1 },
					{ fieldname: "filters", fieldtype: "HTML" },
					{ fieldtype: "Section Break", fieldname: "check", label: __("Preview"), hidden: 1 },
					{ fieldname: "preview", fieldtype: "HTML" },
				],
				primary_action_label: this.is_new ? __("Add") : __("Save"),
				primary_action: (values) => this.save(values),
			}));
			d.$wrapper.addClass("sanad-kit sanad-sheet wa-pse");
			this._preview = sanad.ui.debounce ? sanad.ui.debounce(() => this.preview(), 350) : () => this.preview();

			candidates().then((list) => {
				const taken = new Set((this.opts.taken || []).filter((t) => t !== row.document_type));
				const options = (list || [])
					.filter((c) => !taken.has(c.document_type))
					.map((c) => ({ value: c.document_type, label: c.label, description: describe(c) }));
				if (row.document_type && !options.find((o) => o.value === row.document_type)) {
					options.unshift({ value: row.document_type, label: __(row.document_type) });
				}
				const field = d.get_field("document_type");
				field.df.options = options;
				field.set_data ? field.set_data(options) : field.refresh();
				if (row.document_type) {
					this.silent = true;
					d.set_values({
						document_type: row.document_type,
						label: row.label || "",
						phone_source: row.phone_source || "Field",
						enabled: row.enabled == null ? 1 : cint(row.enabled),
					}).then(() => {
						this.silent = false;
						this.on_screen(true);
					});
				} else {
					this.draw_summary();
				}
			});
			d.show();
		}

		/** A screen was chosen: read it and fill every choice (keeping the row's own, when editing). */
		on_screen(keep_row) {
			if (this.silent) return;
			const d = this.dialog;
			const doctype = d.get_value("document_type");
			if (!doctype) {
				this.info = null;
				return this.draw_summary();
			}
			if (this.info && this.info.document_type === doctype) return;
			this.draw_summary("loading");
			return sanad.ui
				.call("settings.analyze_picker_doctype", { document_type: doctype }, { silent: true })
				.then((info) => {
					if (d.get_value("document_type") !== doctype) return;
					this.info = info;
					const keep = keep_row === true && this.row.document_type === doctype;
					const pick = keep ? this.row : info.suggestion;
					this.fill_selects(info);
					this.silent = true;
					return d
						.set_values({
							label: keep ? this.row.label || info.label : d.get_value("label") && !this.is_new ? d.get_value("label") : info.label,
							phone_source: pick.phone_source || "Field",
							phone_fieldname: pick.phone_fieldname || "",
							contact_fieldname: pick.contact_fieldname || "",
							name_fieldname: pick.name_fieldname || info.suggestion.name_fieldname || "",
						})
						.then(() => {
							this.silent = false;
							["how", "limits", "check"].forEach((s) => d.set_df_property(s, "hidden", 0));
							this.draw_summary();
							this.draw_filters(doctype, keep ? this.row.filters_json : null);
							this.preview();
						});
				})
				.catch((err) => this.draw_summary("error", err));
		}

		/** Only fields of the right kind in each list, with their type and how full they are. */
		fill_selects(info) {
			const d = this.dialog;
			const filled = (f) => (info.total ? __("{0} of {1} filled", [fmt(f.filled), fmt(info.total)]) : __("no records yet"));
			const set = (fieldname, options) => {
				const f = d.get_field(fieldname);
				f.df.options = options;
				f.refresh();
			};
			set(
				"phone_fieldname",
				info.phone_fields.length
					? info.phone_fields.map((f) => ({ value: f.fieldname, label: `${f.label} — ${filled(f)}` }))
					: [{ value: "", label: __("This screen has no number field") }]
			);
			set(
				"contact_fieldname",
				info.contact_fields.length
					? info.contact_fields.map((f) => ({ value: f.fieldname, label: `${f.label} — ${filled(f)}` }))
					: [{ value: "", label: __("This screen has no link to a contact") }]
			);
			set(
				"name_fieldname",
				info.name_fields.map((f) => ({ value: f.fieldname, label: f.title ? `${f.label} (${__("the screen's title")})` : f.label }))
			);
			// a way of reaching people the screen does not have is not offered
			const ways = [];
			if (info.phone_fields.length) ways.push({ value: "Field", label: __("A number field on the record") });
			if (info.contact_fields.length) ways.push({ value: "Linked Contact", label: __("The contact linked to the record") });
			set("phone_source", ways.length ? ways : [{ value: "Field", label: __("A number field on the record") }]);
		}

		draw_summary(state, err) {
			const $w = this.dialog.get_field("summary").$wrapper;
			if (state === "loading") return $w.html(`<div class="wa-pse__note">${esc(__("Reading the screen's fields…"))}</div>`);
			if (state === "error") return $w.html(`<div class="wa-pse__note wa-pse__note--bad">${esc((err && err.message) || __("The screen could not be read."))}</div>`);
			const info = this.info;
			if (!info) return $w.html(`<div class="wa-pse__note">${esc(__("Choose a screen: its number, name and contact fields are found for you."))}</div>`);
			const found = [];
			if (info.phone_fields.length) found.push(__("{0} number fields", [info.phone_fields.length]));
			if (info.contact_fields.length) found.push(__("{0} links to a contact", [info.contact_fields.length]));
			$w.html(`<div class="wa-pse__note wa-pse__note--ok">
				<strong>${esc(info.label)}</strong>
				<span>${esc(__("{0} records", [fmt(info.total)]))}</span>
				<span>${esc(found.join(" · ") || __("no number field and no contact link"))}</span>
			</div>`);
		}

		/** Frappe's own filter builder on the chosen screen; it keeps `[[field, op, value]]`. */
		draw_filters(doctype, saved) {
			const $w = this.dialog.get_field("filters").$wrapper;
			$w.html(`<p class="wa-pse__hint">${esc(__("Always applied on top of what the user chooses in the picker. Leave empty to offer every record."))}</p><div class="wa-pse__fg"></div>`);
			let rows = [];
			try {
				rows = saved ? (typeof saved === "string" ? JSON.parse(saved) : saved) : [];
				if (!Array.isArray(rows)) rows = Object.entries(rows).map(([k, v]) => (Array.isArray(v) ? [k, ...v] : [k, "=", v]));
			} catch (e) {
				rows = [];
			}
			try {
				this.fg = new frappe.ui.FilterGroup({
					parent: $w.find(".wa-pse__fg"),
					doctype,
					on_change: () => this.changed(),
				});
				this.fg.wrapper.find(".apply-filters").hide();
				this.fg.add_filters_to_filter_group(rows.map((r) => [doctype, ...r.slice(-3)]));
			} catch (e) {
				this.fg = null;
				$w.find(".wa-pse__fg").html(`<p class="wa-pse__hint">${esc(__("The filters of this screen could not be shown."))}</p>`);
			}
		}

		filters() {
			if (!this.fg) return this.row.filters_json || null;
			const rows = this.fg.get_filters().map((f) => f.slice(1, 4));
			return rows.length ? JSON.stringify(rows) : null;
		}

		changed() {
			if (!this.silent && this.info) this._preview();
		}

		values() {
			const v = this.dialog.get_values(true) || {};
			return {
				document_type: v.document_type,
				label: (v.label || "").trim() || (this.info && this.info.label) || v.document_type,
				phone_source: v.phone_source || "Field",
				phone_fieldname: v.phone_source === "Field" ? v.phone_fieldname || null : null,
				contact_fieldname: v.phone_source === "Linked Contact" ? v.contact_fieldname || null : null,
				name_fieldname: v.name_fieldname || null,
				filters_json: this.filters(),
				enabled: cint(v.enabled),
			};
		}

		/** How the source as it stands reaches people. */
		preview() {
			const $w = this.dialog.get_field("preview").$wrapper;
			const source = this.values();
			if (!source.document_type) return $w.empty();
			const seq = (this._seq = (this._seq || 0) + 1);
			$w.html(`<div class="wa-pse__note">${esc(__("Counting…"))}</div>`);
			sanad.ui
				.call("settings.preview_picker_source", { source: JSON.stringify(source) }, { silent: true })
				.then((r) => {
					if (seq !== this._seq) return;
					const ok = cint(r.with_number) > 0;
					const sample = (r.sample || [])
						.map((s) => `<li><span>${esc(s.label)}</span><span dir="ltr">${esc(sanad.ui.phone ? sanad.ui.phone(s.phone) : s.phone)}</span></li>`)
						.join("");
					$w.html(`<div class="wa-pse__preview ${ok ? "is-ok" : "is-bad"}">
						<div class="wa-pse__count">
							<strong>${esc(fmt(r.with_number))}</strong>
							<span>${esc(__("of {0} records have a number WhatsApp can use", [fmt(r.total)]))}</span>
						</div>
						${ok ? `<ul class="wa-pse__sample">${sample}</ul>` : `<p class="wa-pse__hint">${esc(
							this.empty_hint(source, r)
						)}</p>`}
					</div>`);
				})
				.catch((err) => {
					if (seq === this._seq) $w.html(`<div class="wa-pse__note wa-pse__note--bad">${esc(err && err.message)}</div>`);
				});
		}

		/** Why the preview reaches no one, and only the ways out this screen really has. */
		empty_hint(source, r) {
			if (!cint(r.total)) {
				return source.filters_json
					? __("No record of this screen matches the filters. Loosen them to reach people.")
					: __("This screen has no records yet. The source works as soon as records are added.");
			}
			const info = this.info || { phone_fields: [], contact_fields: [] };
			const by_contact = source.phone_source === "Linked Contact";
			const more_same = (by_contact ? info.contact_fields : info.phone_fields).length > 1;
			const other_way = (by_contact ? info.phone_fields : info.contact_fields).length > 0;
			const base = by_contact
				? __("None of these records links to a contact with a valid number.")
				: __("None of these records has a valid number in this field.");
			const tries = [];
			if (more_same) tries.push(by_contact ? __("another contact field") : __("another number field"));
			if (other_way) tries.push(by_contact ? __("the number field") : __("the linked contact"));
			return tries.length ? `${base} ${__("Try {0}.", [tries.join(` ${__("or")} `)])}` : base;
		}

		save() {
			const v = this.values();
			if (!v.document_type) return frappe.msgprint(__("Choose a screen."));
			if (v.phone_source === "Field" && !v.phone_fieldname) return frappe.msgprint(__("Choose the field that holds the number."));
			if (v.phone_source === "Linked Contact" && !v.contact_fieldname) return frappe.msgprint(__("Choose the field that links to the contact."));
			this.dialog.hide();
			this.opts.on_save && this.opts.on_save(v);
		}
	}

	whatsapp_next.PickerSourceEditor = PickerSourceEditor;
	whatsapp_next.picker_source_label = (row) =>
		row.phone_source === "Linked Contact" ? __("Linked contact ({0})", [row.contact_fieldname || "—"]) : row.phone_fieldname || "";
})();

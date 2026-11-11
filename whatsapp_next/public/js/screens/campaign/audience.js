// AudienceBuilder — step 3. Who receives the campaign.
//
// A child table is the wrong instrument for an audience: it asks the reader to type numbers into
// rows. The question is where the people come from — a saved group, the contacts, a screen of the
// system with a filter on it, a file, a pasted list — and the product already owns the answer
// (`whatsapp.ui.ContactPicker`, six sources, server-side validation, duplicate and invalid rows
// classified by the server and never by the client). So this step is one working surface:
//
//   a head line — how many, from where, and the sources as the verbs that add more;
//   a bar — search, the statuses the rows hold, the source they came from, and removal;
//   the recipients themselves, paged and searched by the server.
//
// The filtering the design asks for ("247 matching · add to audience") lives inside the picker's
// system-screen source, where it is Frappe's own FilterGroup over the DocType — one filter UI in
// the product, not a second one written here.
//
// Nothing on this step works on an unsaved campaign: the picker commits against a document that
// has to exist. That is said once, with the way out, instead of being discovered per button.

frappe.provide("whatsapp_next.campaign");

(function () {
	const ui = whatsapp.ui;
	const campaign_builder = whatsapp_next.campaign;
	const escape_html = campaign_builder.escape_html;
	const format_integer = campaign_builder.format_integer;

	const SOURCE_TYPES = ["Contact Group", "Contact", "DocType", "Excel", "vCard", "Manual"];

	/** What each source is, in one line, and the icon that stands for it. */
	const SOURCE = {
		"Contact Group": { icon: "users", hint: () => __("A saved list you keep and reuse.") },
		Contact: { icon: "user", hint: () => __("The system's own contacts, by name or number.") },
		DocType: { icon: "table", hint: () => __("A screen of the system — customers, employees — with a filter on it.") },
		Excel: { icon: "doc", hint: () => __("An Excel or CSV file you upload.") },
		vCard: { icon: "device", hint: () => __("An export from a phone (vCard or CSV).") },
		Manual: { icon: "plus", hint: () => __("Numbers you paste or type, one per line.") },
	};

	campaign_builder.Audience = class AudienceBuilder {
		constructor({ wrapper, ctx }) {
			this.$wrapper = $(wrapper);
			this.ctx = ctx;
			this.state = { page: 0, page_length: 10, search: "", filters: {}, order_by: "idx asc" };
			this.counts = {};
			this.render();
		}

		get frm() {
			return this.ctx.frm;
		}

		/** Recipients can only change against a saved, unedited, still-open campaign. */
		can_change() {
			return (
				!this.frm.is_new() &&
				!this.frm.is_dirty() &&
				!whatsapp_next.campaigns.TERMINAL.includes(this.ctx.doc.status) &&
				frappe.perm.has_perm(this.frm.doctype, 0, "write", this.ctx.doc)
			);
		}

		/** After the campaign started the rows carry a message and an error; before, they do not. */
		monitoring() {
			return !this.ctx.wizard();
		}

		render() {
			this.$wrapper.html(`
				<div class="whatsapp-campaign-builder__stack">
					<div data-block="gate"></div>
					<section class="whatsapp-campaign-builder__aud">
						<div class="whatsapp-campaign-builder__aud-head">
							<span class="whatsapp-campaign-builder__card-icon" aria-hidden="true">${ui.inline_icon_html("users", "sm")}</span>
							<span class="whatsapp-campaign-builder__card-title">${escape_html(__("Where the recipients come from"))}</span>
							<span class="whatsapp-campaign-builder__aud-add" data-sources></span>
							<span class="whatsapp-campaign-builder__aud-tags" aria-live="polite">
								<span class="whatsapp-badge whatsapp-badge--pri whatsapp-badge--nodot whatsapp-campaign-builder__aud-total">
									<b class="whatsapp-kit-tabular" data-total>${escape_html(format_integer(cint(this.ctx.doc.total_recipients)))}</b>
									<span data-total-label>${escape_html(campaign_builder.recipients_text(cint(this.ctx.doc.total_recipients)).replace(/^[\d\u0660-\u0669,.\s\u00a0]+/, ""))}</span>
								</span>
								<span class="whatsapp-campaign-builder__aud-parts" data-parts></span>
							</span>
						</div>
						<div class="whatsapp-campaign-builder__aud-bar">
							<div class="whatsapp-campaign-builder__aud-filters" data-bar></div>
							<span class="whatsapp-campaign-builder__aud-verbs" data-verbs></span>
						</div>
						<div class="whatsapp-campaign-builder__aud-table" data-table></div>
					</section>
				</div>`);
			this.$parts = this.$wrapper.find("[data-parts]");
			this.$sources = this.$wrapper.find("[data-sources]");
			this.$verbs = this.$wrapper.find("[data-verbs]");
			this.render_gate();
			this.render_sources();
			this.mount_bar();
			this.mount_table();
			return this;
		}

		// ---- the gate ---------------------------------------------------------------------------

		render_gate() {
			const $gate = this.$wrapper.find('[data-block="gate"]').empty();
			// an empty gate is not a section: hidden, it draws no divider either
			$gate.prop("hidden", this.can_change() || this.monitoring());
			if ($gate.prop("hidden")) return;
			const reason = this.frm.is_new()
				? __("Save the campaign first — recipients are added to a campaign that exists.")
				: this.frm.is_dirty()
					? __("Save your changes first, then add or remove recipients.")
					: whatsapp_next.campaigns.TERMINAL.includes(this.ctx.doc.status)
						? __("The campaign has ended, so its recipients can no longer change.")
						: __("You do not have permission to change this campaign.");
			const savable = (this.frm.is_new() || this.frm.is_dirty()) && this.ctx.can_edit();
			$gate.html(campaign_builder.note_html({ tone: savable ? "warn" : "info", icon: savable ? "warn" : "info", text: reason, cta: savable ? { key: "save", label: __("Save as draft") } : null }));
			$gate.find("[data-note-cta]").on("click", () => this.ctx.save_campaign());
		}

		// ---- where the numbers come from: the sources are the verbs -----------------------------------

		render_sources() {
			const open = this.can_change();
			const terminal = whatsapp_next.campaigns.TERMINAL.includes(this.ctx.doc.status);
			if (terminal || !whatsapp_next.campaigns.is_manager()) return this.$sources.empty();
			// drawn at once from what the product knows; the server's answer (shared with the
			// picker, fetched once per page) only takes away a source that is switched off
			const LABEL = { "Contact Group": () => __("Contact groups"), Contact: () => __("Contacts"), DocType: () => __("System screen"), Excel: () => __("Excel file"), vCard: () => __("Phone export (vCard / CSV)"), Manual: () => __("Manual entry") };
			const draw_source_buttons = (entries) => {
				if (!this.$sources.closest("body").length) return;
				const usable = entries.filter((e) => e.enabled !== false && SOURCE[e.key]);
				this.$sources.html(
					usable
						.map(
							(e) =>
								`<button type="button" class="whatsapp-button whatsapp-button--secondary whatsapp-button--sm whatsapp-campaign-builder__aud-source" data-source="${escape_html(e.key)}" title="${escape_html(SOURCE[e.key].hint())}"${open ? "" : " disabled"}>${ui.inline_icon_html(SOURCE[e.key].icon, "sm")}<span>${escape_html(e.label || LABEL[e.key]())}</span></button>`
						)
						.join("")
				);
				this.$sources.find("[data-source]").on("click", (ev) => this.open_picker("add", { source: $(ev.currentTarget).attr("data-source") }));
			};
			const known = ui.ContactPicker.sources_for(this.frm.doctype);
			if (known.__value) draw_source_buttons(known.__value);
			else draw_source_buttons(SOURCE_TYPES.map((key) => ({ key })));
			known
				.then((entries) => {
					known.__value = entries || [];
					draw_source_buttons(known.__value);
				})
				.catch(() => {});
		}

		open_picker(operation, preselect) {
			new ui.ContactPicker({
				target_doctype: this.frm.doctype,
				target_name: this.ctx.doc.name,
				operation,
				preselect,
				target_label: this.ctx.doc.campaign_name || this.ctx.doc.name,
				on_commit: () => this.frm.reload_doc(),
			});
		}

		// ---- what the audience has become ---------------------------------------------------------

		render_head() {
			// the rows the server counted, once it has; the document's own figure until then
			const status_counts = (this.counts && this.counts.status) || {};
			const filtered = !!this.state.search || (this.state.filters.source_type || []).length > 0;
			// removed rows stay in the table (with status "Removed") but are not in the audience: the
			// head says what `total_recipients` says, never the rows including the removed ones
			const total = status_counts.All !== undefined && !filtered ? cint(status_counts.All) - cint(status_counts.Removed) : cint(this.ctx.doc.total_recipients);
			this.$wrapper.find("[data-total]").text(format_integer(total));
			this.$wrapper.find("[data-total-label]").text(campaign_builder.recipients_text(total).replace(/^[\d٠-٩,.\s ]+/, ""));
			const by_source = (this.counts && this.counts.source_type) || {};
			const parts = SOURCE_TYPES.filter((k) => cint(by_source[k])).map(
				(k) => `<span class="whatsapp-campaign-builder__chip"><b class="whatsapp-kit-tabular">${escape_html(format_integer(by_source[k]))}</b>${escape_html(__(k))}</span>`
			);
			const excluded = this.ctx.excluded_unknown();
			if (excluded) {
				parts.push(
					`<span class="whatsapp-campaign-builder__chip whatsapp-campaign-builder__chip--warn" title="${escape_html(__("They have never had a conversation on WhatsApp and this campaign excludes unknown numbers."))}">${ui.inline_icon_html("warn", "xs")}<b class="whatsapp-kit-tabular">${escape_html(format_integer(excluded))}</b>${escape_html(__("will not be sent to"))}</span>`
				);
			}
			// one source and nothing excluded says nothing the total does not
			this.$parts.html(parts.length > 1 || excluded ? parts.join("") : "");
		}

		// ---- the bar: the product's own toolbar over the recipients child table ------------------------

		/**
		 * `whatsapp.ui.FilterBar` in page mode — the same search box, dropdown filters with checkboxes
		 * and "Group by" as every list of the product, read from the child DocType's meta. The bar
		 * says what to ask for; the server answers; the table groups the page it holds.
		 */
		mount_bar() {
			this.bar = new ui.FilterBar({
				wrapper: this.$wrapper.find("[data-bar]"),
				doctype: "WhatsApp Campaign Recipient",
				presets: [
					{ fieldname: "phone_e164", type: "search", fields: ["phone_e164", "display_name"], placeholder: __("Search a name or a number") },
					{ fieldname: "status", type: "select" },
					{ fieldname: "source_type", type: "select" },
				],
				actions: ["group_by"],
				datalist: () => this.table,
				on_change: (_filters, { values, search }) => {
					this.state.search = search || "";
					this.state.filters.status = values.status || null;
					this.state.filters.source_type = values.source_type || null;
					this.state.page = 0;
					if (this.table && !this.frm.is_new()) this.load_recipients_page(this.table);
				},
			});
		}

		// ---- the recipients themselves --------------------------------------------------------------

		mount_table() {
			const monitoring = this.monitoring();
			const columns = [
				{
					fieldname: "display_name",
					label: __("Name"),
					sortable: true,
					format: (v, row) => {
						const name = escape_html(v || __("Unknown"));
						return row.contact ? frappe.utils.get_form_link("Contact", row.contact, true, name) : name;
					},
				},
				{ fieldname: "phone_e164", label: __("Phone"), sortable: true, width: 160, format: (v, row) => `<span class="whatsapp-kit-tabular" dir="ltr">${escape_html(ui.phone(v || row.phone || ""))}</span>${ui.group_tag(v || row.phone)}` },
				{ fieldname: "source_type", label: __("Source"), sortable: true, groupable: true, width: 140, format: (v) => escape_html(v ? __(v) : "—") },
				{ fieldname: "status", label: __("Status"), type: "status", sortable: true, groupable: true, width: 120 },
			];
			if (monitoring) {
				columns.push({ fieldname: "error_code", label: __("Error"), width: 150, format: (v) => (v ? `<span class="whatsapp-kit-tone--red">${escape_html(v)}</span>` : "—") });
			}
			this.table = new ui.DataList({
				wrapper: this.$wrapper.find("[data-table]"),
				doctype: "WhatsApp Campaign Recipient",
				page_length: this.state.page_length,
				selectable: this.can_change() && whatsapp_next.campaigns.is_manager(),
				pinnable: false,
				columns,
				on_page: (page, t) => {
					this.state.page = page;
					this.load_recipients_page(t);
				},
				on_sort: (fieldname, order, t) => {
					this.state.order_by = `${fieldname} ${order}`;
					this.state.page = 0;
					this.load_recipients_page(t);
				},
				// in the wizard a row is a person to keep or remove; once messages exist it opens its message
				on_row_click: monitoring ? (row) => row.outbound_message && frappe.set_route("Form", "WhatsApp Log", row.outbound_message) : null,
				on_select: () => this.render_verbs(),
				empty: {
					title: __("No recipient yet"),
					description: __("Add recipients from a group, the contacts, a screen of the system, a file or a list you paste."),
				},
			});
			this.render_verbs();
			if (!this.frm.is_new()) this.load_recipients_page(this.table);
			else this.render_head();
		}

		load_recipients_page(table) {
			return ui
				.call(
					"campaigns.get_recipients_page",
					{
						name: this.ctx.doc.name,
						page: this.state.page + 1,
						// the table's own length: the footer's page size and "Load more" change it
						page_length: (table && table.page_length) || this.state.page_length,
						search: this.state.search || undefined,
						status: this.state.filters.status && this.state.filters.status.length ? this.state.filters.status : undefined,
						source_type: this.state.filters.source_type && this.state.filters.source_type.length ? this.state.filters.source_type : undefined,
						order_by: this.state.order_by,
					},
					{ silent: true }
				)
				.then((r) => {
					table.set_rows(r.rows || [], r.total, this.state.page);
					this.counts = r.counts || {};
					this.render_head();
					this.render_verbs();
					return r;
				})
				.catch((err) => ui.Toast.error(err));
		}

		// ---- removal ------------------------------------------------------------------------------

		render_verbs() {
			this.$verbs.empty();
			if (!whatsapp_next.campaigns.is_manager() || whatsapp_next.campaigns.TERMINAL.includes(this.ctx.doc.status)) return;
			const open = this.can_change();
			const selected = this.table ? this.table.get_selected() : [];
			if (selected.length && open) {
				$(ui.button_html({ label: __("Remove {0}", [format_integer(selected.length)]), icon: "trash", variant: "danger", size: "sm" }))
					.on("click", () => this.remove_selected(selected))
					.appendTo(this.$verbs);
				return;
			}
			$(ui.button_html({ label: __("Remove recipients"), icon: "trash", variant: "secondary", size: "sm", disabled: !open || !cint(this.ctx.doc.total_recipients) }))
				.on("click", () => this.open_picker("remove"))
				.appendTo(this.$verbs);
		}

		remove_selected(rows) {
			// a row already removed is not removed twice, and the count says what will actually go
			const keys = [...new Set(rows.filter((r) => r.status !== "Removed").map((r) => r.phone_e164).filter(Boolean))];
			if (!keys.length) return ui.Toast.info(__("Nothing to remove: the selected recipients are already removed."));
			ui.ConfirmDialog.ask_for_confirmation({
				title: __("Remove {0} recipients?", [format_integer(keys.length)]),
				message: __("They stop receiving this campaign. Nothing else changes."),
				impact: [{ label: __("Recipients to remove"), value: format_integer(keys.length), tone: "red" }],
				danger: true,
				confirm_label: __("Remove {0}", [format_integer(keys.length)]),
				on_confirm: () => ui.call("picker.commit_remove", { target_doctype: this.frm.doctype, target_name: this.ctx.doc.name, phone_e164s: keys }),
			})
				.then(() => {
					ui.Toast.success(__("Removed {0}", [format_integer(keys.length)]));
					this.frm.reload_doc();
				})
				.catch(() => {});
		}

		destroy() {
			this.bar && this.bar.destroy && this.bar.destroy();
			this.table && this.table.destroy && this.table.destroy();
		}

		/** The builder calls this when the document changed under the step. */
		refresh() {
			this.render_gate();
			this.render_sources();
			this.render_verbs();
			if (!this.frm.is_new()) this.load_recipients_page(this.table);
			else this.render_head();
		}
	};
})();

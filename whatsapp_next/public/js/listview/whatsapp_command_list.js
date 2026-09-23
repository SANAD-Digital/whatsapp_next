// whatsapp_command list settings — the Commands screen (matrix row 8, spec §5.5, D-064 prototype
// anatomy): PageHeader (title, "+ New command" → the CommandModal, "Functions Center N" with the
// installed-functions count, KPIs Commands · Active · Runs (30d) · Inbound without a match),
// FilterBar, DataList (Command word · Function · Synonyms · Allowed parties · Status · Runs (30d) ·
// View → MetaDialog), row actions (edit with the "stop to edit" guard, start / stop, restore
// defaults, dry-run test) and bulk start / stop through `commands.set_status_many`. PageHeader and
// DataList are guarded: until they land the list keeps Desk's own header and rows.

frappe.provide("whatsapp_next");

(function () {
	const ui = sanad.ui;
	const DT = "WhatsApp Command";
	const MANAGER = "WhatsApp Manager";
	const FUNCTIONS_ROUTE = "wa-functions-center";

	const is_manager = () => frappe.user.has_role(MANAGER);
	const synonyms_of = (text) => cstr(text).split(/[\n,،]/).map((s) => s.trim()).filter(Boolean);

	/** The form script holds the modal; lists do not load it, so evaluate it from the meta once. */
	function ensure_modal_loaded() {
		if (typeof whatsapp_next.command_modal === "function") return true;
		const meta = frappe.get_meta(DT);
		if (meta && meta.__js) {
			new Function(meta.__js)();
		}
		return typeof whatsapp_next.command_modal === "function";
	}

	function open_modal(listview, name, opts = {}) {
		if (!ensure_modal_loaded()) {
			ui.Toast.info(__("The editor could not be loaded; opening the form instead."));
			frappe.set_route("Form", DT, name || "new");
			return;
		}
		whatsapp_next.command_modal(name || null, Object.assign({ on_saved: () => refresh_all(listview) }, opts));
	}

	function refresh_all(listview) {
		if (!listview) return;
		listview.refresh();
		listview._sanad_header && listview._sanad_header.refresh();
	}

	function set_primary(listview) {
		if (listview._sanad_header || !listview.can_create || frappe.boot.read_only) return;
		listview.page.set_primary_action(__("New command"), () => open_modal(listview), "add");
	}

	async function set_status(listview, name, status) {
		try {
			await ui.call("commands.set_status", { name, status });
			ui.Toast.success(status === "Active" ? __("Command started") : __("Command stopped"));
			refresh_all(listview);
		} catch (err) {
			ui.Toast.error(err);
		}
	}

	async function edit_command(listview, doc) {
		if (doc.status === "Active") {
			try {
				await ui.ConfirmDialog.ask({
					title: __("Stop the command to edit it?"),
					message: __("Active commands are locked. Stopping this command pauses its replies until you start it again."),
					impact: [{ label: __("Command"), value: doc.code || doc.name }],
					confirm_label: __("Stop and edit"),
					on_confirm: () => ui.call("commands.set_status", { name: doc.name, status: "Inactive" }),
				});
			} catch (e) {
				return; // cancelled
			}
			refresh_all(listview);
		}
		open_modal(listview, doc.name);
	}

	async function restore_defaults(listview, doc) {
		try {
			await ui.ConfirmDialog.ask({
				title: __("Restore defaults for {0}?", [doc.code || doc.name]),
				message: __("Outputs are re-copied from the function and the settings overrides are cleared."),
				impact: [{ label: __("Function"), value: doc.function || "—" }],
				confirm_label: __("Restore defaults"),
				on_confirm: () => ui.call("commands.restore_defaults", { name: doc.name }),
			});
			ui.Toast.success(__("Defaults restored"));
			refresh_all(listview);
		} catch (e) {
			// cancelled or already toasted
		}
	}

	function test_command(doc) {
		if (ensure_modal_loaded()) {
			whatsapp_next.command_test_dialog(doc);
			return;
		}
		ui.Toast.info(__("Open the command to test it."));
		frappe.set_route("Form", DT, doc.name);
	}

	/** View: read-only for Active commands and non-managers, editable otherwise. */
	const view_command = (listview, doc) => open_modal(listview, doc.name, { read_only: doc.status === "Active" || !is_manager() });

	// ---- header ------------------------------------------------------------------------------

	const synonyms_registered = () =>
		frappe.db.get_list(DT, { fields: ["synonyms"], limit: 500 }).then((rows) => (rows || []).reduce((n, row) => n + synonyms_of(row.synonyms).length, 0));

	const make_header = (listview) => {
		if (typeof ui.PageHeader !== "function") return null;
		// Sub-texts that need a second query: fetched on the side, then the KPI row re-renders.
		const extra = { synonyms: null, stopped: null };
		const load_extra = () =>
			Promise.all([synonyms_registered().catch(() => 0), frappe.db.count(DT, { filters: { status: "Inactive" } }).catch(() => 0)]).then(([synonyms, stopped]) => {
				const changed = extra.synonyms !== synonyms || extra.stopped !== stopped;
				extra.synonyms = synonyms;
				extra.stopped = stopped;
				if (changed && header.stats) header.stats.refresh();
			});
		const header = new ui.PageHeader({
			listview,
			title: __("Commands"),
			description: __("A command is a word the customer types. The function is what runs behind it and reads from the ledger."),
			primary: is_manager() ? { label: __("New command"), icon: "es-line-add", roles: [MANAGER], handler: () => open_modal(listview) } : undefined,
			secondary: [
				{
					label: __("Functions Center"),
					icon: "es-line-settings",
					count: () => frappe.db.count("WhatsApp Function"),
					handler: () => frappe.set_route(FUNCTIONS_ROUTE),
				},
			],
			stats: [
				{ key: "total", label: __("Commands"), icon: "es-line-code", count: { doctype: DT }, sub: () => (extra.synonyms == null ? "" : ui.plural(extra.synonyms, { one: __("{0} synonym registered"), other: __("{0} synonyms registered") })) },
				{ key: "active", label: __("Active"), icon: "es-line-check", tone: "green", count: { doctype: DT, filters: { status: "Active" } }, sub: () => (extra.stopped == null ? "" : __("{0} stopped", [ui.format_int(extra.stopped)])) },
				{ key: "runs", label: __("Runs (30d)"), icon: "es-line-chart", tone: "blue", method: "commands.list_commands", args: { filters: {}, page: 1, page_length: 200 }, format: (v, r) => ui.format_int((r.rows || []).reduce((n, row) => n + cint(row.run_count_30d), 0)), sub: __("Function calls from an inbound command") },
				{
					key: "unmatched",
					label: __("Inbound without a match"),
					icon: "es-line-alert-triangle",
					tone: "amber",
					count: { doctype: "WhatsApp Inbound Message", filters: { command_status: "Not Matched" } },
					sub: (v) => (cint(v) ? __("Add a synonym to match automatically") : __("Every inbound message matched a command")),
					onclick: () => frappe.set_route("List", "WhatsApp Inbound Message", { command_status: "Not Matched" }),
				},
			],
		});
		load_extra();
		const original_refresh = header.refresh.bind(header);
		header.refresh = (...a) => {
			load_extra();
			return original_refresh(...a);
		};
		return header;
	};

	// ---- rows: function name / runs (30d) / allowed parties come from the API and the child table --

	const enrich_rows = (listview, datalist) => {
		const rows = (listview.data || []).filter((d) => d._extra === undefined);
		if (!rows.length) return;
		rows.forEach((d) => (d._extra = null));
		const names = rows.map((d) => d.name);
		Promise.all([
			ui.call("commands.list_commands", { filters: {}, page: 1, page_length: 200 }, { silent: true }).catch(() => ({ rows: [] })),
			frappe.db.get_list("WhatsApp Command Party Type", { parent: DT, fields: ["parent", "party_type"], filters: { parent: ["in", names] }, limit: 500 }).catch(() => []),
		]).then(([api, parties]) => {
			const by_name = {};
			(api.rows || []).forEach((r) => (by_name[r.name] = r));
			const party_map = {};
			(parties || []).forEach((p) => (party_map[p.parent] = party_map[p.parent] || []).push(__(p.party_type)));
			rows.forEach((d) => {
				const r = by_name[d.name] || {};
				d._extra = { function_name: r.function_name || d.function, function_status: r.function_status, run_count_30d: cint(r.run_count_30d), parties: party_map[d.name] || [] };
			});
			datalist && datalist.refresh && datalist.refresh();
		});
	};

	const make_datalist = (listview) => {
		if (typeof ui.DataList !== "function") return null;
		return new ui.DataList({
			listview,
			selectable: true,
			columns: [
				{ fieldname: "code", label: __("Command word"), sortable: true, format: (v) => `<strong class="sanad-tabular">${ui.escape(v || "")}</strong>` },
				{
					fieldname: "function",
					label: __("Function"),
					sortable: true,
					format: (v, doc) => {
						const x = doc._extra || {};
						const name = ui.escape(x.function_name || v || "—");
						return x.function_status && x.function_status !== "Active" ? `${name} <span class="text-muted">· ${ui.escape(__("stopped"))}</span>` : name;
					},
				},
				{ fieldname: "synonyms", label: __("Synonyms"), sortable: false, format: (v) => `<span class="text-muted">${ui.escape(synonyms_of(v).join(__(", ")) || "—")}</span>` },
				{ fieldname: "_parties", label: __("Allowed parties"), sortable: false, format: (v, doc) => `<span class="text-muted">${ui.escape(doc._extra && doc._extra.parties.length ? doc._extra.parties.join(__(", ")) : __("Everyone"))}</span>` },
				{ fieldname: "status", label: __("Status"), type: "status", sortable: true },
				{ fieldname: "_runs", label: __("Runs (30d)"), type: "number", align: "end", sortable: false, format: (v, doc) => ui.format_int(doc._extra ? doc._extra.run_count_30d : 0) },
			],
			row_action: { label: __("View"), handler: (doc) => view_command(listview, doc) },
			on_row_click: (doc) => view_command(listview, doc),
			footer: { count: (total) => ui.plural(total, { one: __("{0} command"), other: __("{0} commands") }) },
			empty: { title: __("No commands yet"), description: __("A command is a word the customer types; pick a function and give it a word."), action: is_manager() ? { label: __("New command"), onclick: () => open_modal(listview) } : undefined },
		});
	};

	function setup_row_actions(listview) {
		if (typeof ui.RowActions !== "function" || listview._sanad_datalist) return;
		new ui.RowActions({
			listview,
			actions: [
				{ label: __("Edit"), icon: ui.icons.edit, roles: [MANAGER], handler: (doc) => edit_command(listview, doc) },
				{ label: __("Start"), icon: "es-line-check", roles: [MANAGER], condition: (doc) => doc.status !== "Active", handler: (doc) => set_status(listview, doc.name, "Active") },
				{ label: __("Stop"), icon: "es-line-close", roles: [MANAGER], condition: (doc) => doc.status === "Active", handler: (doc) => set_status(listview, doc.name, "Inactive") },
				{ label: __("Restore defaults"), icon: ui.icons.resend, roles: [MANAGER], condition: (doc) => doc.status !== "Active", handler: (doc) => restore_defaults(listview, doc) },
				{ label: __("Test"), icon: ui.icons.quick_send, roles: [MANAGER], handler: (doc) => test_command(doc) },
			],
			on_row_click: (doc) => view_command(listview, doc),
		});
	}

	function setup_bulk_actions(listview) {
		if (typeof ui.BulkActions !== "function") return;
		new ui.BulkActions({
			listview,
			actions: [
				{ label: __("Start selected"), method: "commands.set_status_many", args: () => ({ status: "Active" }), roles: [MANAGER] },
				{ label: __("Stop selected"), method: "commands.set_status_many", args: () => ({ status: "Inactive" }), roles: [MANAGER] },
			],
		});
	}

	frappe.listview_settings[DT] = {
		hide_name_column: true,
		add_fields: ["status", "code", "title", "function", "synonyms", "reply_device", "run_count", "last_run_at"],
		get_indicator(doc) {
			return doc.status === "Active" ? [__("Active"), "green", "status,=,Active"] : [__("Inactive"), "gray", "status,=,Inactive"];
		},
		// Frappe calls this instead of `make_new_doc` for the Add button and Ctrl+B.
		primary_action() {
			open_modal(window.cur_list && window.cur_list.doctype === DT ? window.cur_list : null);
		},
		onload(listview) {
			ensure_modal_loaded();
			listview._sanad_header = make_header(listview);
			set_primary(listview);
			if (typeof ui.FilterBar === "function") {
				listview._sanad_filterbar = new ui.FilterBar({
					listview,
					presets: [
						{ type: "search", fieldname: "search", fields: ["code", "synonyms", "title", "function"], placeholder: __("Command word, synonym or function…") },
						{ fieldname: "function", type: "select" },
						{ fieldname: "status", type: "select" },
					],
					actions: ["group_by", "export"],
				});
			}
			listview._sanad_datalist = make_datalist(listview);
			ui.on_list_render(listview, () => enrich_rows(listview, listview._sanad_datalist));
			setup_row_actions(listview);
			setup_bulk_actions(listview);
			// The list re-sets "Add …" whenever the selection is cleared — restore the label after it.
			listview.$result.on("change.wacmd", "input[type=checkbox]", () => window.setTimeout(() => set_primary(listview), 0));
		},
		refresh(listview) {
			set_primary(listview);
		},
	};
})();

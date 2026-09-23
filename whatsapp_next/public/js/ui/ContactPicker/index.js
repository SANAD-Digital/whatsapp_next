// sanad.ui.ContactPicker — the shell of the recipient / member picker sub-system: one
// `frappe.ui.Dialog` (extra-large; a full-height sheet under 768 px), source tabs on the
// inline-start side built from `picker.list_sources(target_doctype)` (disabled sources hidden),
// a **Selected** tab always last with a live count badge, and a footer counter + "Continue" that
// leads to the ConfirmDialog stating exact counts before `picker.commit_add` / `commit_remove`.
// The selection is a Map keyed by `phone_e164` (fallback: raw phone) of rows in the common shape.
// One source per operation: switching source with a non-empty selection asks to discard. The
// same shell serves add and remove; remove mode adds a first tab with the target's current rows.

import ui from "../_core/index.js";
import GroupsSource from "./sources/groups.js";
import ContactsSource from "./sources/contacts.js";
import DoctypeSource from "./sources/doctype.js";
import ExcelSource from "./sources/excel.js";
import PhonebookSource from "./sources/phonebook.js";
import ManualSource from "./sources/manual.js";
import CurrentSource from "./sources/current.js";
import SelectedTab from "./selected.js";

const SELECTED = "__selected";
const CURRENT = "__current";
const ALIASES = {
	groups: "Contact Group",
	group: "Contact Group",
	contacts: "Contact",
	contact: "Contact",
	doctype: "DocType",
	system: "DocType",
	excel: "Excel",
	phonebook: "vCard",
	vcard: "vCard",
	vcf: "vCard",
	csv: "vCard",
	manual: "Manual",
	selected: SELECTED,
	current: CURRENT,
};

sanad.ui.ContactPicker = class ContactPicker {
	/** Registry of source classes by API key — add or replace a source before opening. */
	static get sources() {
		if (!this._sources) {
			this._sources = {};
			[GroupsSource, ContactsSource, DoctypeSource, ExcelSource, PhonebookSource, ManualSource].forEach((S) => (this._sources[S.key] = S));
		}
		return this._sources;
	}

	/**
	 * @param {Object} opts
	 * @param {string} opts.target_doctype — the document holding the child table (a picker target)
	 * @param {string} opts.target_name
	 * @param {"add"|"remove"} [opts.operation="add"]
	 * @param {string[]} [opts.sources] — restrict to these source keys (API keys or aliases)
	 * @param {{source: string, ref?: string, kind?: string}} [opts.preselect] — open on a source and pre-fill it
	 * @param {Function} opts.on_commit — `(result) => void` after a successful commit
	 * @param {string} [opts.title] — default "Add recipients to {target}" / "Remove members from {target}"
	 * @param {string} [opts.target_label] — display name of the target used in titles (default: target_name)
	 * @param {string} [opts.group_doctype] — the Contact Group DocType (kind chips from its meta; excluded as a source when it is the target)
	 * @param {string[]} [opts.contact_link_doctypes] — chips for source 2 (default from the server entry, else none)
	 * @param {{method: string, args: Function, server_filters?: boolean, source_types?: string[], status_field?: string}} [opts.current]
	 *   — remove mode: how to page the target's current rows (defaults by target)
	 * @param {Object<string,string>} [opts.api] — API key overrides, e.g. `{"picker.preview": "my.app.preview"}`
	 */
	constructor(opts = {}) {
		const defaults = ui.config.defaults || {};
		this.opts = Object.assign(
			{
				operation: "add",
				group_doctype: defaults.group_doctype || "Contact Group",
				contact_link_doctypes: defaults.contact_link_doctypes,
				api: {},
			},
			opts
		);
		this.target_doctype = this.opts.target_doctype;
		this.target_name = this.opts.target_name;
		this.operation = this.opts.operation === "remove" ? "remove" : "add";
		this.selection = new Map();
		this.selection_source = null;
		this.source_type = null;
		this.source_ref = null;
		this.revision = 0;
		this.tabs = [];
		this.instances = {};
		this.selected = new SelectedTab(this);
		this.announce_count = ui.debounce((n) => ui.announce(__("{0} selected", [ui.format_int(n)])), 600);
		this.open();
	}

	// ---- API plumbing ---------------------------------------------------------------------

	call(key, args = {}, opts = {}) {
		return sanad.ui.call((this.opts.api || {})[key] || key, args, opts);
	}

	target_is_group() {
		return this.target_doctype === this.opts.group_doctype;
	}

	/** Remove mode: paging config for the target's current rows. */
	current_config() {
		const cfg = this.opts.current || {};
		if (cfg.method) return Object.assign({ args: (s) => Object.assign({ name: this.target_name }, s) }, cfg);
		if (this.target_is_group()) {
			return {
				method: "picker.get_group_members",
				args: (s) => ({ group: this.target_name, page: s.page, page_length: s.page_length }),
				server_filters: false,
				source_types: [],
			};
		}
		return {
			method: "campaigns.get_recipients_page",
			args: (s) => ({ name: this.target_name, page: s.page, page_length: s.page_length, search: s.search || undefined, source_type: s.source_type || undefined }),
			server_filters: true,
			source_types: cfg.source_types || this.source_type_options(),
			status_field: "status",
			status_colour: (row) => ui.indicator_for(this.child_doctype(), Object.assign({ doctype: this.child_doctype() }, row)).colour,
		};
	}

	/** The target's child DocType (recipients / members table), from meta when loaded. */
	child_doctype() {
		try {
			const meta = frappe.get_meta(this.target_doctype);
			const table = (meta.fields || []).find((f) => f.fieldtype === "Table" && (f.fieldname === "recipients" || f.fieldname === "members"));
			return table ? table.options : null;
		} catch (e) {
			return null;
		}
	}

	/** `source_type` Select options of the target's child table, from meta when loaded. */
	source_type_options() {
		try {
			const child = this.child_doctype() && frappe.get_meta(this.child_doctype());
			const df = child && (child.fields || []).find((f) => f.fieldname === "source_type");
			return df ? (df.options || "").split("\n").filter(Boolean) : [];
		} catch (e) {
			return [];
		}
	}

	default_title() {
		const target = this.opts.target_label || this.target_name;
		const remove = this.operation === "remove";
		if (this.target_is_group()) return remove ? __("Remove members from {0}", [target]) : __("Add members to {0}", [target]);
		return remove ? __("Remove recipients from {0}", [target]) : __("Add recipients to {0}", [target]);
	}

	row_key(row) {
		if (row.phone_e164) return row.phone_e164;
		if (row.phone) return `raw:${String(row.phone).trim()}`;
		return `invalid:${row.source_name || row.contact || row.display_name || ui.uid("row")}`;
	}

	// ---- selection ------------------------------------------------------------------------

	/** Add rows in the common shape; returns how many new keys were added. */
	add_rows(rows, { source_type, source_ref = null, quiet = false } = {}) {
		const was_empty = this.selection.size === 0;
		let added = 0;
		(rows || []).forEach((row) => {
			const key = this.row_key(row);
			if (this.selection.has(key)) return;
			this.selection.set(key, Object.assign({}, row, { source_type: row.source_type || (source_type === CURRENT ? null : source_type) }));
			added += 1;
		});
		if (source_type && source_type !== CURRENT) {
			if (was_empty || !this.source_type) {
				this.source_type = source_type;
				this.source_ref = source_ref;
			} else if (this.source_ref !== source_ref) {
				this.source_ref = null;
			}
		}
		if (this.active && this.active !== SELECTED) this.selection_source = this.active;
		this.on_selection_change();
		if (!quiet) this.notify_added(added, rows ? rows.length - added : 0);
		return added;
	}

	notify_added(added, merged = 0) {
		const msg = merged ? __("Added {0} to the selection. {1} were already selected.", [ui.format_int(added), ui.format_int(merged)]) : __("Added {0} to the selection", [ui.format_int(added)]);
		sanad.ui.Toast.success(msg, { seconds: 3 });
	}

	remove_rows(keys) {
		keys.forEach((k) => this.selection.delete(k));
		this.on_selection_change();
	}

	clear_selection() {
		this.selection.clear();
		this.source_type = null;
		this.source_ref = null;
		this.selection_source = null;
		this.on_selection_change();
	}

	on_selection_change() {
		this.revision += 1;
		const n = this.selection.size;
		this.$badge.text(ui.format_int(n)).toggleClass("sanad-picker__badge--empty", !n);
		this.$counter.text(n ? __("{0} selected", [ui.format_int(n)]) : __("Nothing selected"));
		this.dialog.get_primary_btn().prop("disabled", !n);
		this.selected.clear_alert();
		this.selected.render();
		this.selected.schedule_preview();
		this.announce_count(n);
	}

	set_progress(text) {
		this.$progress.text(text || "");
	}

	// ---- dialog ---------------------------------------------------------------------------

	open() {
		const remove = this.operation === "remove";
		this.dialog = new frappe.ui.Dialog({
			title: this.opts.title || this.default_title(),
			size: "extra-large",
			fields: [{ fieldtype: "HTML", fieldname: "body" }],
			primary_action_label: __("Continue"),
			primary_action: () => this.continue_(),
			secondary_action_label: __("Cancel"),
			secondary_action: () => this.dialog.hide(),
		});
		this.dialog.$wrapper.addClass("sanad-kit sanad-sheet sanad-picker-dialog").toggleClass("sanad-picker-dialog--remove", remove);
		this.dialog.get_primary_btn().prop("disabled", true);
		// One live channel only: the selection count is announced through the debounced `ui.announce`.
		this.$counter = $('<span class="sanad-picker__counter sanad-tabular"></span>').text(__("Nothing selected"));
		this.$progress = $('<span class="sanad-picker__progress" aria-live="polite"></span>');
		this.dialog.footer.prepend($('<div class="sanad-picker__footer-info"></div>').append(this.$counter, this.$progress));
		const $body = this.dialog.get_field("body").$wrapper;
		this.$root = $(`
			<div class="sanad-picker">
				<div class="sanad-picker__tabs" role="tablist" aria-orientation="vertical" aria-label="${ui.escape(__("Sources"))}"></div>
				<div class="sanad-picker__panes"></div>
			</div>`);
		$body.html(this.$root);
		this.$tabs = this.$root.find(".sanad-picker__tabs");
		this.$panes = this.$root.find(".sanad-picker__panes");
		this.$badge = $('<span class="sanad-picker__badge sanad-picker__badge--empty sanad-tabular" aria-hidden="true">0</span>');
		this.state = new sanad.ui.EmptyState({ wrapper: this.$panes, state: "loading", rows: 4 });
		this.dialog.$wrapper.on("hidden.bs.modal", () => this.destroy());
		this.dialog.show();
		this.realtime = (data) => this.on_import_progress(data);
		frappe.realtime.on("wa:import:progress", this.realtime);
		this.load_sources();
	}

	load_sources() {
		return this.call("picker.list_sources", { target_doctype: this.target_doctype }, { silent: true })
			.then((entries) => {
				const wanted = (this.opts.sources || []).map((k) => ALIASES[String(k).toLowerCase()] || k);
				const list = (entries || []).filter((e) => e.enabled !== false && (!wanted.length || wanted.includes(e.key)) && sanad.ui.ContactPicker.sources[e.key]);
				this.state.hide();
				this.build_tabs(list);
			})
			.catch((err) => this.state.error(err, { action: { label: __("Retry"), onclick: () => this.load_sources() } }));
	}

	build_tabs(entries) {
		this.$tabs.empty();
		this.$panes.empty();
		this.tabs = [];
		if (this.operation === "remove") {
			const label = this.target_is_group() ? __("Current members") : __("Current recipients");
			this.add_tab(CURRENT, label, (pane) => new CurrentSource(this, { key: CURRENT, label }).mount(pane));
		}
		entries.forEach((entry) => {
			const Source = sanad.ui.ContactPicker.sources[entry.key];
			this.add_tab(entry.key, entry.label || Source.label(), (pane) => {
				const inst = new Source(this, entry);
				this.instances[entry.key] = inst;
				inst.mount(pane);
				return inst;
			});
		});
		this.add_tab(SELECTED, __("Selected"), (pane) => this.selected.mount(pane), this.$badge);
		if (!entries.length) {
			sanad.ui.Toast.warning(__("No source is enabled for {0}. Enable one in the WhatsApp settings.", [__(this.target_doctype)]));
		}
		this.$tabs.on("keydown", ".sanad-picker__tab", (e) => this.on_tab_key(e));
		const pre = this.opts.preselect;
		const first = pre && pre.source ? ALIASES[String(pre.source).toLowerCase()] || pre.source : null;
		this.activate(first && this.tabs.some((t) => t.key === first) ? first : this.tabs[0].key, { force: true }).then(() => {
			if (first && this.instances[first] && pre) this.instances[first].preselect(pre);
		});
	}

	add_tab(key, label, mount, $badge) {
		const id = ui.uid("ptab");
		const $tab = $(`<button type="button" class="sanad-picker__tab" role="tab" id="${id}" data-key="${ui.escape(key)}" aria-selected="false" aria-controls="${id}-pane" tabindex="-1"><span class="sanad-picker__tab-label">${ui.escape(label)}</span></button>`);
		if ($badge) $tab.append($badge);
		$tab.on("click", () => this.activate(key));
		const $pane = $(`<div class="sanad-picker__pane" role="tabpanel" id="${id}-pane" aria-labelledby="${id}" tabindex="0" hidden></div>`);
		this.$tabs.append($tab);
		this.$panes.append($pane);
		this.tabs.push({ key, label, $tab, $pane, mount, mounted: false });
	}

	on_tab_key(e) {
		const keys = this.tabs.map((t) => t.key);
		const i = keys.indexOf($(e.currentTarget).data("key"));
		const next = ui.roving_index(e, keys, i); // RTL-aware arrows, Home / End
		if (next < 0) return;
		e.preventDefault();
		this.tabs[next].$tab.trigger("focus");
		this.activate(keys[next]);
	}

	/** Switch tabs; a different source with a non-empty selection asks to discard it first. */
	activate(key, { force = false } = {}) {
		const tab = this.tabs.find((t) => t.key === key);
		if (!tab || key === this.active) return Promise.resolve(false);
		const is_source = key !== SELECTED;
		const guard = !force && is_source && this.selection.size && this.selection_source && this.selection_source !== key;
		const proceed = guard
			? sanad.ui.ConfirmDialog.ask({
					title: __("Discard the current selection?"),
					message: __("You can add from one source at a time. Switching to {0} clears the {1} numbers you picked.", [tab.label, ui.format_int(this.selection.size)]),
					impact: [{ label: __("Selected numbers"), value: ui.format_int(this.selection.size), tone: "red" }],
					danger: true,
					confirm_label: __("Discard and switch"),
			  }).then(() => this.clear_selection())
			: Promise.resolve();
		return proceed.then(
			() => {
				this.tabs.forEach((t) => {
					const on = t.key === key;
					t.$tab.attr("aria-selected", on ? "true" : "false").attr("tabindex", on ? "0" : "-1");
					if (on) t.$pane.removeAttr("hidden");
					else t.$pane.attr("hidden", true);
				});
				this.active = key;
				if (!tab.mounted) {
					tab.mounted = true;
					tab.mount(tab.$pane);
				} else if (this.instances[key] && this.instances[key].on_show) {
					this.instances[key].on_show();
				}
				if (key === SELECTED) this.selected.schedule_preview();
				return true;
			},
			() => false
		);
	}

	/** Server stage codes → sentences (unknown stages fall back to "{stage}: {n} rows so far…"). */
	static stage_label(stage) {
		return {
			parsing: __("Reading the file…"),
			parsed: __("File read"),
			normalising: __("Checking numbers…"),
			normalizing: __("Checking numbers…"),
			committing: __("Saving…"),
		}[stage];
	}

	on_import_progress(data) {
		if (!data || !data.stage) return;
		if (data.stage === "parsing") return this.set_progress(__("Reading the {0} file…", [String(data.kind || "").toUpperCase()]));
		if (data.stage === "parsed") return this.set_progress(__("Read {0} rows: {1} valid, {2} invalid", [ui.format_int(data.total), ui.format_int(data.valid || 0), ui.format_int(data.invalid || 0)]));
		const label = ContactPicker.stage_label(data.stage) || data.stage;
		this.set_progress(__("{0}: {1} rows so far…", [label, ui.format_int(data.total || 0)]));
	}

	// ---- confirm + commit ------------------------------------------------------------------

	continue_() {
		if (!this.selection.size) return;
		const remove = this.operation === "remove";
		this.dialog.get_primary_btn().prop("disabled", true);
		return this.activate(SELECTED)
			.then(() => this.selected.ensure_preview())
			.then(() => {
				const c = this.selected.counts();
				if (!c.action) {
					this.selected.show_alert(remove ? __("None of the selected numbers is in the list, so there is nothing to remove.") : __("Every selected number is already in the list or invalid, so there is nothing to add."));
					return;
				}
				const impact = remove
					? [
							{ label: __("Will be removed"), value: ui.format_int(c.action), tone: "red" },
							{ label: __("Not in the list (ignored)"), value: ui.format_int(c.skipped) },
					  ]
					: [
							{ label: __("Will be added"), value: ui.format_int(c.action), tone: "green" },
							{ label: __("Already added (skipped)"), value: ui.format_int(c.skipped), tone: c.skipped ? "red" : undefined },
							{ label: __("Invalid (skipped)"), value: ui.format_int(c.invalid), tone: c.invalid ? "amber" : undefined },
							{ label: __("With a conversation"), value: ui.format_int(c.known) },
					  ];
				if (c.duplicates) impact.push({ label: __("Duplicates in selection (merged)"), value: ui.format_int(c.duplicates) });
				return sanad.ui.ConfirmDialog.ask({
					title: remove ? __("Remove {0} numbers?", [ui.format_int(c.action)]) : __("Add {0} numbers?", [ui.format_int(c.action)]),
					message: __("Changes apply to {0} {1}.", [__(this.target_doctype), this.opts.target_label || this.target_name]),
					impact,
					danger: remove,
					confirm_label: remove ? __("Remove {0}", [ui.format_int(c.action)]) : __("Add {0}", [ui.format_int(c.action)]),
				}).then(
					() => this.commit(c),
					() => {}
				);
			})
			.catch(() => {})
			.finally(() => this.dialog.get_primary_btn().prop("disabled", !this.selection.size));
	}

	commit(counts) {
		const remove = this.operation === "remove";
		this.set_progress(remove ? __("Removing {0}…", [ui.format_int(counts.action)]) : __("Adding {0}…", [ui.format_int(counts.action)]));
		const args = remove
			? { target_doctype: this.target_doctype, target_name: this.target_name, phone_e164s: counts.keys }
			: { target_doctype: this.target_doctype, target_name: this.target_name, rows: Array.from(this.selection.values()), source_type: this.source_type || "Manual", source_ref: this.source_ref || null };
		return this.call(remove ? "picker.commit_remove" : "picker.commit_add", args, { silent: true })
			.then((result) => {
				this.set_progress(null);
				this.committed = true;
				if (remove) sanad.ui.Toast.success(__("Removed {0}", [ui.format_int(result.removed)]));
				else if (result.skipped_duplicates || result.skipped_invalid) {
					sanad.ui.Toast.success(__("Added {0}. Skipped {1} already added and {2} invalid.", [ui.format_int(result.added), ui.format_int(result.skipped_duplicates), ui.format_int(result.skipped_invalid)]));
				} else {
					sanad.ui.Toast.success(__("Added {0}", [ui.format_int(result.added)]));
				}
				this.opts.on_commit && this.opts.on_commit(result, this);
				this.dialog.hide();
			})
			.catch((err) => {
				this.set_progress(null);
				this.selected.show_alert(err.exc_type === "WAStateConflictError" ? __("The list changed while you were choosing. Reopen it and try again. ({0})", [err.message]) : err.message);
			});
	}

	destroy() {
		if (this.realtime) frappe.realtime.off("wa:import:progress", this.realtime);
		this.realtime = null;
		Object.values(this.instances).forEach((s) => s.destroy && s.destroy());
		this.instances = {};
		this.opts.on_close && this.opts.on_close(this.committed || false);
	}

	/** Shortcut: `sanad.ui.ContactPicker.open({...})`. */
	static open(opts) {
		return new ContactPicker(opts);
	}
};

export default sanad.ui.ContactPicker;

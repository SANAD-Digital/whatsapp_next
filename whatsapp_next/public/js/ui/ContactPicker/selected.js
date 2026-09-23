// ContactPicker — the Selected tab: the live selection classified by the server
// (`picker.preview` → available / already added / invalid / duplicates in selection, plus
// `known_count` = numbers with a conversation). Rows already in the target are flagged with a red
// "Already added" chip (in remove mode they are the ones that will be removed); a counts strip
// states the exact numbers the confirm step will repeat; each row can be removed; the list is
// searchable. The preview is debounced whenever the selection changes.

import ui from "../_core/index.js";

const RENDER_STEP = 200;
const PREVIEW_DEBOUNCE = 400;

export class SelectedTab {
	constructor(picker) {
		this.picker = picker;
		this.buckets = new Map();
		this.preview = null;
		this.txt = "";
		this.limit = RENDER_STEP;
		// Debounced background preview never rejects unhandled; `ensure_preview()` keeps the throw.
		this.schedule_preview = ui.debounce(() => this.run_preview().catch(() => {}), PREVIEW_DEBOUNCE);
	}

	mount($pane) {
		this.$pane = $pane;
		const $head = $('<div class="sanad-picker__head"></div>');
		const $search = $(`<input type="search" class="form-control sanad-picker__search" placeholder="${ui.escape(__("Search the selection"))}" aria-label="${ui.escape(__("Search the selection"))}">`);
		$search.on("input", ui.debounce(() => {
			this.txt = $search.val().trim().toLowerCase();
			this.limit = RENDER_STEP;
			this.render();
		}, 200));
		this.$clear = $(`<button type="button" class="btn btn-default btn-sm">${ui.escape(__("Clear all"))}</button>`).on("click", () => this.picker.clear_selection());
		$head.append($search, this.$clear);
		this.$counts = $('<div class="sanad-picker__counts"></div>');
		this.$alert = $('<div class="sanad-picker__alert" role="alert" hidden></div>');
		this.$list = $('<div class="sanad-picker__results"></div>');
		this.$pane.append($head, this.$counts, this.$alert, this.$list);
		this.state = new sanad.ui.EmptyState({ wrapper: this.$list, state: "empty", size: "sm" });
		this.render();
	}

	show_alert(message) {
		this.$alert.text(message).removeAttr("hidden");
		this.$alert.attr("tabindex", "-1").trigger("focus");
	}

	clear_alert() {
		this.$alert.attr("hidden", true).empty();
	}

	/** Resolve when the preview matches the current selection. */
	ensure_preview() {
		if (this.preview && this.preview_size === this.picker.selection.size && this.preview_rev === this.picker.revision) return Promise.resolve(this.preview);
		return this.run_preview();
	}

	run_preview() {
		const rows = Array.from(this.picker.selection.values());
		const rev = this.picker.revision;
		if (!rows.length) {
			this.preview = { available: [], already_added: [], invalid: [], duplicates_in_selection: [], known_count: 0 };
			this.preview_size = 0;
			this.preview_rev = rev;
			this.buckets.clear();
			this.render();
			return Promise.resolve(this.preview);
		}
		if (this.$counts) this.$counts.html(ui.skeleton(1, { lines: 1 }));
		this.picker.set_progress(__("Checking {0} numbers against the list…", [ui.format_int(rows.length)]));
		return this.picker
			.call("picker.preview", { target_doctype: this.picker.target_doctype, target_name: this.picker.target_name, rows }, { silent: true })
			.then((p) => {
				if (rev !== this.picker.revision) return this.preview; // stale — a newer preview is on its way
				this.preview = p;
				this.preview_size = rows.length;
				this.preview_rev = rev;
				this.buckets.clear();
				["available", "already_added", "invalid", "duplicates_in_selection"].forEach((bucket) => {
					(p[bucket] || []).forEach((row) => this.buckets.set(this.picker.row_key(row), { bucket, error: row.error }));
				});
				this.picker.set_progress(null);
				this.render();
				return p;
			})
			.catch((err) => {
				this.picker.set_progress(null);
				if (this.$counts) this.$counts.empty();
				if (this.$pane) this.show_alert(err.message);
				throw err;
			});
	}

	/** Counts the confirm step repeats: `{action, skipped, invalid, duplicates, known}`. */
	counts() {
		const p = this.preview || { available: [], already_added: [], invalid: [], duplicates_in_selection: [], known_count: 0 };
		const remove = this.picker.operation === "remove";
		return {
			action: remove ? p.already_added.length : p.available.length,
			skipped: remove ? p.available.length : p.already_added.length,
			invalid: p.invalid.length,
			duplicates: p.duplicates_in_selection.length,
			known: cint(p.known_count),
			keys: remove ? p.already_added.map((r) => r.phone_e164) : null,
		};
	}

	render_counts() {
		if (!this.picker.selection.size) {
			this.$counts.empty();
			return;
		}
		const c = this.counts();
		const remove = this.picker.operation === "remove";
		const parts = [
			{ label: remove ? __("{0} will be removed", [ui.format_int(c.action)]) : __("{0} will be added", [ui.format_int(c.action)]), tone: remove ? "red" : "green" },
			{ label: remove ? __("{0} not in the list", [ui.format_int(c.skipped)]) : __("{0} already added", [ui.format_int(c.skipped)]), tone: remove ? "gray" : "red" },
			{ label: __("{0} invalid", [ui.format_int(c.invalid)]), tone: "amber" },
		];
		if (c.duplicates) parts.push({ label: __("{0} duplicates in selection", [ui.format_int(c.duplicates)]), tone: "red" });
		if (!remove) parts.push({ label: __("{0} with a conversation", [ui.format_int(c.known)]), tone: "blue" });
		this.$counts.html(parts.map((p) => `<span class="sanad-picker__count sanad-tone--${p.tone}">${ui.escape(p.label)}</span>`).join('<span class="sanad-picker__dot" aria-hidden="true">·</span>'));
	}

	chip_for(key, row) {
		const remove = this.picker.operation === "remove";
		const b = this.buckets.get(key);
		if (!b) return row.valid === false ? sanad.ui.StatusBadge.html({ label: row.error || __("Invalid"), colour: "orange" }) : "";
		if (b.bucket === "already_added") return sanad.ui.StatusBadge.html({ label: remove ? __("Will be removed") : __("Already added"), colour: "red" });
		if (b.bucket === "invalid") return sanad.ui.StatusBadge.html({ label: b.error || __("Invalid"), colour: "orange" });
		if (b.bucket === "duplicates_in_selection") return sanad.ui.StatusBadge.html({ label: __("Duplicate in selection"), colour: "red" });
		if (remove) return sanad.ui.StatusBadge.html({ label: __("Not in the list"), colour: "gray", icon: false });
		return "";
	}

	render() {
		if (!this.$pane) return;
		this.render_counts();
		const entries = Array.from(this.picker.selection.entries());
		this.$clear.prop("disabled", !entries.length);
		if (!entries.length) {
			this.$list.empty();
			this.state = new sanad.ui.EmptyState({ wrapper: this.$list, state: "empty", size: "sm", title: __("Nothing selected yet"), description: __("Pick numbers from one of the sources.") });
			return;
		}
		const q = this.txt;
		const visible = q ? entries.filter(([, r]) => String(r.display_name || "").toLowerCase().includes(q) || String(r.phone_e164 || r.phone || "").includes(q)) : entries;
		if (!visible.length) {
			this.$list.empty();
			this.state = new sanad.ui.EmptyState({ wrapper: this.$list, state: "empty", size: "sm", title: __("No selected number matches your search.") });
			return;
		}
		let html = `<div class="sanad-table-wrap sanad-picker__scroll"><table class="sanad-table sanad-picker__table sanad-picker__selected-table"><thead><tr><th scope="col">${ui.escape(__("Name"))}</th><th scope="col">${ui.escape(__("Phone"))}</th><th scope="col">${ui.escape(__("Source"))}</th><th scope="col">${ui.escape(__("Result"))}</th><th scope="col"><span class="sanad-visually-hidden">${ui.escape(__("Remove"))}</span></th></tr></thead><tbody>`;
		visible.slice(0, this.limit).forEach(([key, row]) => {
			const name = row.display_name || row.source_name || row.contact || "";
			const b = this.buckets.get(key);
			html += `<tr class="${b && b.bucket !== "available" && b.bucket !== "already_added" ? "sanad-picker__row--flagged" : ""}" data-key="${ui.escape(key)}">
				<td>${ui.escape(name)}</td>
				<td class="sanad-tabular" dir="ltr">${ui.escape(row.phone_e164 || row.phone || "")}</td>
				<td>${row.source_type ? sanad.ui.StatusBadge.html({ label: __(row.source_type), colour: "gray", icon: false }) : ""}</td>
				<td>${this.chip_for(key, row)}</td>
				<td class="sanad-picker__td-remove"><button type="button" class="btn btn-xs btn-default sanad-picker__remove" data-key="${ui.escape(key)}" aria-label="${ui.escape(__("Remove {0} from the selection", [name || row.phone || ""]))}" title="${ui.escape(__("Remove"))}">${ui.icon("es-line-close", "xs")}</button></td>
			</tr>`;
		});
		html += "</tbody></table></div>";
		this.$list.html(html);
		if (visible.length > this.limit) {
			const $more = $(`<button type="button" class="btn btn-default btn-sm sanad-picker__more">${ui.escape(__("Show {0} more", [ui.format_int(Math.min(RENDER_STEP, visible.length - this.limit))]))}</button>`).on("click", () => {
				this.limit += RENDER_STEP;
				this.render();
			});
			this.$list.append($more);
		}
		this.$list.find(".sanad-picker__remove").on("click", (e) => this.picker.remove_rows([$(e.currentTarget).data("key")]));
	}
}

export default SelectedTab;

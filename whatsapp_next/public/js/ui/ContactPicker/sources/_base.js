// ContactPicker — base class and shared renderers for the source tabs. A source owns one pane:
// it searches / parses candidates through the picker's API keys, shows them as a checkbox table
// (or a preview) and hands rows in the common shape to `picker.add_rows()`. Nothing here knows
// the host app; every label goes through `__()`.

import ui from "../../_core/index.js";

export const PREVIEW_ROWS = 100;

export class BaseSource {
	/**
	 * @param {Object} picker — the ContactPicker shell
	 * @param {Object} entry — the `picker.list_sources` entry `{key, label, enabled, ...}`
	 */
	constructor(picker, entry) {
		this.picker = picker;
		this.entry = entry || {};
		this.key = this.entry.key || this.constructor.key;
		this.label = this.entry.label || this.constructor.label();
		this.page = 1;
		this.page_length = 20;
		this.rows = [];
	}

	static get key() {
		return "";
	}

	static label() {
		return "";
	}

	/** Called once with the pane element. */
	mount($pane) {
		this.$pane = $pane;
		this.render();
	}

	render() {}

	on_show() {}

	/** Optional `preselect` hook: `{source, ref, kind}` from the picker options. */
	preselect() {}

	destroy() {}

	call(key, args, opts) {
		return this.picker.call(key, args, opts);
	}

	/** A search box that debounces into `on_search(text)`. */
	search_box(placeholder, on_search) {
		const $input = $(`<input type="search" class="form-control sanad-picker__search" placeholder="${ui.escape(placeholder)}" aria-label="${ui.escape(placeholder)}">`);
		$input.on("input", ui.debounce(() => on_search($input.val().trim()), 300));
		$input.on("keydown", (e) => {
			if (e.key === "Enter") {
				e.preventDefault();
				on_search($input.val().trim());
			}
		});
		return $input;
	}

	/** Toggle chips (`aria-pressed`) with an "All" entry; `on_change(value)` receives "" for All. */
	chips(label, options, on_change, { all = true } = {}) {
		const $group = $(`<div class="sanad-chip-row sanad-picker__chips" role="group" aria-label="${ui.escape(label)}"></div>`);
		const list = (all ? [{ value: "", label: __("All") }] : []).concat(options.map((o) => (typeof o === "string" ? { value: o, label: __(o) } : o)));
		list.forEach((o, i) => {
			const $chip = $(`<button type="button" class="sanad-chip sanad-picker__chip" data-value="${ui.escape(o.value)}" aria-pressed="${i === 0 ? "true" : "false"}">${ui.escape(o.label)}</button>`);
			$chip.on("click", () => {
				$group.find(".sanad-picker__chip").attr("aria-pressed", "false");
				$chip.attr("aria-pressed", "true");
				on_change(o.value);
			});
			$group.append($chip);
		});
		return $group;
	}

	/** Loading / empty / error host for the pane's result area. */
	state_for($area) {
		return new sanad.ui.EmptyState({ wrapper: $area, state: "loading", size: "sm", rows: 4 });
	}

	/**
	 * Checkbox table of candidate rows in the common shape.
	 * @returns {jQuery} table wrapper; `selected_rows()` reads the checked rows.
	 */
	candidate_table(rows, { selectable = true, show_source = false, extra_columns = [], disabled_when = null } = {}) {
		const id = ui.uid("cands");
		const cols = [{ label: __("Name") }, { label: __("Phone") }].concat(show_source ? [{ label: __("Source") }] : []).concat(extra_columns);
		let html = `<div class="sanad-table-wrap sanad-picker__scroll"><table class="sanad-table sanad-picker__table" id="${id}"><thead><tr>`;
		if (selectable) {
			html += `<th scope="col" class="sanad-picker__th-check"><input type="checkbox" class="sanad-picker__check-all" aria-label="${ui.escape(__("Select all on page"))}"></th>`;
		}
		cols.forEach((c) => (html += `<th scope="col">${ui.escape(c.label)}</th>`));
		html += "</tr></thead><tbody>";
		rows.forEach((row, i) => {
			const disabled = disabled_when ? disabled_when(row) : !row.valid && !row.phone_e164;
			const name = row.display_name || row.source_name || row.contact || "";
			html += `<tr data-idx="${i}" class="${disabled ? "sanad-picker__row--disabled" : ""}">`;
			if (selectable) {
				html += `<td class="sanad-picker__td-check"><input type="checkbox" class="sanad-picker__check" data-idx="${i}" ${disabled ? "disabled" : ""} aria-label="${ui.escape(__("Select {0}", [name || row.phone || ""]))}"></td>`;
			}
			html += `<td>${ui.escape(name)}${row.error ? `<div class="sanad-picker__row-error">${ui.escape(row.error)}</div>` : ""}</td>`;
			html += `<td class="sanad-tabular sanad-table__ltr">${ui.escape(row.phone_e164 || row.phone || "")}</td>`;
			if (show_source) html += `<td>${row.source_type ? sanad.ui.StatusBadge.html({ label: __(row.source_type), colour: "gray", icon: false }) : ""}</td>`;
			extra_columns.forEach((c) => (html += `<td>${c.format ? c.format(row) : ui.escape(row[c.fieldname] == null ? "" : row[c.fieldname])}</td>`));
			html += "</tr>";
		});
		html += "</tbody></table></div>";
		const $el = $(html);
		if (selectable) {
			$el.find(".sanad-picker__check-all").on("change", (e) => {
				$el.find(".sanad-picker__check:not(:disabled)").prop("checked", e.target.checked);
				$el.trigger("selection-change");
			});
			$el.find(".sanad-picker__check").on("change", () => $el.trigger("selection-change"));
			$el.selected_rows = () => $el.find(".sanad-picker__check:checked").toArray().map((el) => rows[cint(el.dataset.idx)]);
			$el.select_all = (on) => {
				$el.find(".sanad-picker__check:not(:disabled)").prop("checked", on);
				$el.find(".sanad-picker__check-all").prop("checked", on);
				$el.trigger("selection-change");
			};
		}
		return $el;
	}

	/** "Add N" button that tracks a candidate table's selection. */
	add_selected_button($table, { source_type, source_ref = null, label = null } = {}) {
		const $btn = $(`<button type="button" class="btn btn-primary btn-sm sanad-picker__add-btn"></button>`);
		const update = () => {
			const n = $table.selected_rows ? $table.selected_rows().length : 0;
			$btn.text(label ? label(n) : __("Add {0}", [ui.format_int(n)])).prop("disabled", !n);
		};
		$table.on("selection-change", update);
		update();
		$btn.on("click", () => {
			const rows = $table.selected_rows();
			this.picker.add_rows(rows, { source_type: source_type || this.key, source_ref });
			$table.select_all(false);
		});
		return $btn;
	}

	/** Prev / next pager for page-length based sources (no total known). */
	pager(on_page) {
		const $pager = $(`
			<div class="sanad-picker__pager">
				<span class="sanad-picker__page-text sanad-tabular" aria-live="polite"></span>
				<div>
					<button type="button" class="btn btn-default btn-sm sanad-picker__prev">${ui.escape(__("Previous"))}</button>
					<button type="button" class="btn btn-default btn-sm sanad-picker__next">${ui.escape(__("Next"))}</button>
				</div>
			</div>`);
		$pager.find(".sanad-picker__prev").on("click", () => on_page(this.page - 1));
		$pager.find(".sanad-picker__next").on("click", () => on_page(this.page + 1));
		$pager.update = (rows_on_page, total) => {
			const start = rows_on_page ? (this.page - 1) * this.page_length + 1 : 0;
			const end = (this.page - 1) * this.page_length + rows_on_page;
			$pager.find(".sanad-picker__page-text").text(total != null ? __("{0}–{1} of {2}", [ui.format_int(start), ui.format_int(end), ui.format_int(total)]) : __("{0}–{1}", [ui.format_int(start), ui.format_int(end)]));
			$pager.find(".sanad-picker__prev").prop("disabled", this.page <= 1);
			$pager.find(".sanad-picker__next").prop("disabled", total != null ? end >= total : rows_on_page < this.page_length);
			$pager.toggle(this.page > 1 || (total != null ? total > this.page_length : rows_on_page >= this.page_length));
		};
		return $pager;
	}

	/** Invalid rows list with reasons (uploads and manual entry). */
	invalid_list(invalid) {
		if (!invalid || !invalid.length) return $("");
		const $box = $(`<details class="sanad-picker__invalid"><summary>${ui.escape(__("{0} invalid rows skipped", [ui.format_int(invalid.length)]))}</summary><ul></ul></details>`);
		const $ul = $box.find("ul");
		invalid.slice(0, PREVIEW_ROWS).forEach((r) => {
			$ul.append(`<li><span dir="ltr" class="sanad-tabular">${ui.escape(r.phone || "")}</span> ${r.display_name ? ui.escape(r.display_name) + " — " : ""}<span class="sanad-picker__reason">${ui.escape(r.error || __("Invalid phone number"))}</span></li>`);
		});
		if (invalid.length > PREVIEW_ROWS) $ul.append(`<li>${ui.escape(__("and {0} more", [ui.format_int(invalid.length - PREVIEW_ROWS)]))}</li>`);
		return $box;
	}
}

export default BaseSource;

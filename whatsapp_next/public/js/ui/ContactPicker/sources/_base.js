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

	/** The prototype's search: a rounded field with the glass inside it, debouncing into `on_search(text)`. */
	search_box(placeholder, on_search) {
		const $field = $(`<label class="sanad-picker__search"><span class="sanad-picker__search-icon" aria-hidden="true">${ui.icon("es-line-search", "sm")}</span></label>`);
		const $input = $(`<input type="search" class="sanad-picker__search-input" placeholder="${ui.escape(placeholder)}" aria-label="${ui.escape(placeholder)}">`).appendTo($field);
		$input.on("input", ui.debounce(() => on_search($input.val().trim()), 300));
		$input.on("keydown", (e) => {
			if (e.key === "Enter") {
				e.preventDefault();
				on_search($input.val().trim());
			}
		});
		$field.val = (...a) => $input.val(...a);
		return $field;
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

	/**
	 * A single choice among options that may be many: a dropdown field — the button says
	 * `Label: value`, the popover lists the options with a search box once they pass a handful —
	 * the same control the product's filter bars use. `on_change(value)` receives "" for All.
	 * A row of chips is kept only for two or three fixed kinds (`chips`).
	 */
	select_field(label, options, on_change, { all = true, searchable = null } = {}) {
		const list = (all ? [{ value: "", label: __("All") }] : []).concat(options.map((o) => (typeof o === "string" ? { value: o, label: __(o) } : o)));
		const id = ui.uid("pdd");
		const with_search = searchable === null ? list.length > 7 : !!searchable;
		const $dd = $(`<div class="sanad-picker__dd"></div>`);
		const $btn = $(`<button type="button" class="sanad-picker__dd-btn" aria-haspopup="listbox" aria-expanded="false" aria-controls="${id}">
			<span class="sanad-picker__dd-label">${ui.escape(label)}</span>
			<span class="sanad-picker__dd-value"></span>
			<span class="sanad-picker__dd-chevron" aria-hidden="true">${ui.icon("es-line-down", "xs")}</span>
		</button>`).appendTo($dd);
		const $pop = $(`<div class="sanad-picker__dd-pop" id="${id}" role="listbox" aria-label="${ui.escape(label)}" hidden></div>`).appendTo($dd);
		const $search = with_search ? $(`<input type="search" class="form-control sanad-picker__dd-search" placeholder="${ui.escape(__("Search…"))}" aria-label="${ui.escape(__("Search {0}", [label]))}">`).appendTo($pop) : null;
		const $list = $(`<div class="sanad-picker__dd-list"></div>`).appendTo($pop);
		let value = "";
		const reflect = () => {
			const chosen = list.find((o) => o.value === value) || list[0];
			$btn.find(".sanad-picker__dd-value").text(chosen ? chosen.label : "").toggleClass("sanad-picker__dd-value--set", !!value);
			$btn.toggleClass("sanad-picker__dd-btn--active", !!value);
			$list.find("[role=option]").each((i, el) => el.setAttribute("aria-selected", el.dataset.value === value ? "true" : "false"));
		};
		const fill = (q = "") => {
			const needle = q.trim().toLowerCase();
			$list.empty();
			const shown = list.filter((o) => !needle || o.label.toLowerCase().includes(needle));
			if (!shown.length) $list.append(`<div class="sanad-picker__dd-empty">${ui.escape(__("No match for {0}", [q]))}</div>`);
			shown.forEach((o) => {
				$(`<button type="button" class="sanad-picker__dd-opt" role="option" data-value="${ui.escape(o.value)}" aria-selected="${o.value === value}">${ui.escape(o.label)}</button>`)
					.on("click", () => {
						value = o.value;
						reflect();
						close();
						on_change(value);
					})
					.appendTo($list);
			});
		};
		const open = () => {
			fill();
			$pop.removeAttr("hidden");
			$btn.attr("aria-expanded", "true");
			$(document).on(`mousedown.${id} touchstart.${id}`, (e) => {
				if (!$dd[0].contains(e.target)) close();
			});
			$dd.on(`keydown.${id}`, (e) => {
				if (e.key === "Escape") {
					e.preventDefault();
					close();
					$btn.trigger("focus");
				}
			});
			if ($search) $search.val("").trigger("focus");
			else $list.find("[aria-selected=true], [role=option]").first().trigger("focus");
		};
		const close = () => {
			$pop.attr("hidden", true);
			$btn.attr("aria-expanded", "false");
			$(document).off(`.${id}`);
			$dd.off(`keydown.${id}`);
		};
		$btn.on("click", () => ($pop.prop("hidden") ? open() : close()));
		if ($search) $search.on("input", () => fill($search.val()));
		$list.on("keydown", "[role=option]", (e) => {
			const opts = $list.find("[role=option]").toArray();
			const i = opts.indexOf(e.currentTarget);
			const next = e.key === "ArrowDown" ? i + 1 : e.key === "ArrowUp" ? i - 1 : e.key === "Home" ? 0 : e.key === "End" ? opts.length - 1 : -1;
			if (next < 0 || next >= opts.length) return;
			e.preventDefault();
			opts[next].focus();
		});
		reflect();
		$dd.get_value = () => value;
		$dd.set_value = (v) => {
			value = v || "";
			reflect();
		};
		return $dd;
	}

	/** Loading / empty / error host for the pane's result area. */
	state_for($area) {
		return new sanad.ui.EmptyState({ wrapper: $area, state: "loading", size: "sm", rows: 4 });
	}

	/**
	 * The candidate rows, drawn the way the prototype draws a person: a round avatar with the
	 * initials, the name over the number, a small badge for what else is known, and a round mark
	 * at the end that fills when the row is chosen. The whole row is the control. The API is the
	 * one the sources already use: `selected_rows()`, `select_all(on)`, the `selection-change` event.
	 */
	candidate_table(rows, { selectable = true, show_source = false, extra_columns = [], disabled_when = null } = {}) {
		const id = ui.uid("cands");
		const $el = $(`<div class="sanad-picker__list" id="${id}" role="${selectable ? "group" : "list"}"></div>`);
		if (selectable && rows.length > 1) {
			$el.append(`<label class="sanad-picker__all"><input type="checkbox" class="sanad-picker__check-all"><span>${ui.escape(__("Select all on page"))}</span></label>`);
		}
		const $rows = $('<div class="sanad-picker__rows"></div>').appendTo($el);
		rows.forEach((row, i) => {
			const disabled = disabled_when ? disabled_when(row) : !row.valid && !row.phone_e164;
			const name = row.display_name || row.source_name || row.contact || "";
			const phone = row.phone_e164 || row.phone || "";
			const badges = [];
			if (show_source && row.source_type) badges.push(ui.escape(__(row.source_type)));
			extra_columns.forEach((c) => {
				const v = c.format ? c.format(row) : ui.escape(row[c.fieldname] == null ? "" : row[c.fieldname]);
				if (v) badges.push(v);
			});
			const $row = $(`
				<div class="sanad-picker__row${disabled ? " sanad-picker__row--disabled" : ""}" data-idx="${i}"${selectable ? ` role="checkbox" aria-checked="false" tabindex="${disabled ? -1 : 0}"${disabled ? ' aria-disabled="true"' : ""}` : ' role="listitem"'}>
					<span class="sanad-picker__av" aria-hidden="true">${ui.escape(ui.initials(name || phone) || "#")}</span>
					<span class="sanad-picker__row-text">
						<span class="sanad-picker__row-name" dir="auto">${ui.escape(name || phone)}</span>
						${name && phone ? `<span class="sanad-picker__row-sub sanad-tabular" dir="ltr">${ui.escape(phone)}</span>` : ""}
						${row.error ? `<span class="sanad-picker__row-error" dir="auto">${ui.escape(row.error)}</span>` : ""}
					</span>
					${badges.map((b) => `<span class="sanad-picker__row-badge">${b}</span>`).join("")}
					${selectable ? `<span class="sanad-picker__mark" aria-hidden="true">${ui.icon("es-line-check", "xs")}</span>` : ""}
				</div>`);
			$rows.append($row);
		});
		if (selectable) {
			const checked = new Set();
			const reflect = () => {
				$rows.find(".sanad-picker__row").each((i, el) => el.setAttribute("aria-checked", checked.has(cint(el.dataset.idx)) ? "true" : "false"));
				const enabled = $rows.find('.sanad-picker__row:not(.sanad-picker__row--disabled)').length;
				$el.find(".sanad-picker__check-all").prop("checked", enabled > 0 && checked.size >= enabled).prop("indeterminate", checked.size > 0 && checked.size < enabled);
			};
			const toggle = (el) => {
				if (el.classList.contains("sanad-picker__row--disabled")) return;
				const i = cint(el.dataset.idx);
				if (checked.has(i)) checked.delete(i);
				else checked.add(i);
				reflect();
				$el.trigger("selection-change");
			};
			$rows.on("click", ".sanad-picker__row", (e) => toggle(e.currentTarget));
			$rows.on("keydown", ".sanad-picker__row", (e) => {
				if (e.key === " " || e.key === "Enter") {
					e.preventDefault();
					toggle(e.currentTarget);
				}
			});
			$el.find(".sanad-picker__check-all").on("change", (e) => $el.select_all(e.target.checked));
			$el.selected_rows = () => Array.from(checked).sort((x, y) => x - y).map((i) => rows[i]);
			$el.select_all = (on) => {
				checked.clear();
				if (on) $rows.find(".sanad-picker__row:not(.sanad-picker__row--disabled)").each((i, el) => checked.add(cint(el.dataset.idx)));
				reflect();
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

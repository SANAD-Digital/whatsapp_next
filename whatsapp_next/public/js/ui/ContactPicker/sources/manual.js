// ContactPicker source 6 — manual entry: a textarea, one entry per line (`phone` or
// `name;phone`), parsed server-side by `picker.parse_manual` (the server's E.164 normalisation is
// authoritative). Valid lines go to the selection. A line the server could not read does not go
// back into the textarea to be hunted for: it becomes a row of its own under the box, with the
// reason beside it and the text editable in place — Enter or "Fix" sends that one line back to
// the server, and it leaves the list the moment it reads. "Fix all" retries every row at once.

import ui from "../../_core/index.js";
import BaseSource from "./_base.js";

export class ManualSource extends BaseSource {
	static get key() {
		return "Manual";
	}

	static label() {
		return __("Manual entry");
	}

	/** What a list of numbers may contain: digits, `+`, spaces and the line / comma between two. */
	static numbers_only(text) {
		return String(text || "").replace(/[^0-9+\s,;]/g, "");
	}

	render() {
		const id = ui.uid("manual");
		const hint_id = `${id}-hint`;
		// The example comes from PhoneField (country default of the host) when the kit ships it.
		const PhoneField = sanad.ui.PhoneField;
		const example = typeof PhoneField === "function" && typeof PhoneField.example === "function" ? PhoneField.example() : "+966 5X XXX XXXX";
		this.pending = []; // lines the server refused, each `{raw, phone, display_name, error}`
		const $field = $(`
			<div class="sanad-picker__field sanad-picker__manual">
				<label for="${id}">${ui.escape(__("Numbers, one per line"))}</label>
				<textarea id="${id}" class="form-control sanad-picker__numbers" rows="6" dir="ltr" inputmode="tel" aria-describedby="${hint_id}" placeholder="${ui.escape(example)}"></textarea>
				<div id="${hint_id}" class="sanad-picker__note">${ui.escape(__("One number per line, with the country code (e.g. {0}). Digits and + only.", [example]))}</div>
			</div>`);
		this.$text = $field.find("textarea");
		this.$error = $('<div class="sanad-picker__alert" role="alert" hidden></div>');
		this.$foot = $('<div class="sanad-picker__foot"></div>');
		this.$add = $(`<button type="button" class="btn btn-primary btn-sm">${ui.escape(__("Add numbers"))}</button>`).on("click", () => this.parse());
		this.$count = $('<span class="sanad-picker__note sanad-tabular"></span>');
		this.$foot.append(this.$add, this.$count);
		this.$fixes = $('<div class="sanad-picker__fixes" hidden></div>');
		// digits, +, and the separators between numbers — a letter or a symbol never reaches the box
		this.$text.on("input", () => {
			const raw = this.$text.val();
			const clean = ManualSource.numbers_only(raw);
			if (clean !== raw) {
				const at = this.$text[0].selectionStart - (raw.length - clean.length);
				this.$text.val(clean);
				try {
					this.$text[0].setSelectionRange(Math.max(0, at), Math.max(0, at));
				} catch (e) {
					// a textarea that lost focus has no caret to put back
				}
			}
			const n = this.$text.val().split(/\r?\n/).filter((l) => l.trim()).length;
			this.$count.text(n ? __("{0} lines", [ui.format_int(n)]) : "");
			this.$add.prop("disabled", !n);
		});
		this.$text.on("keydown", (e) => {
			if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
				e.preventDefault();
				this.parse();
			}
		});
		this.$add.prop("disabled", true);
		this.$pane.append($field, this.$foot, this.$error, this.$fixes);
	}

	parse() {
		const text = this.$text.val();
		if (!text.trim()) return Promise.resolve();
		this.$add.prop("disabled", true);
		this.$error.attr("hidden", true).empty();
		return this.call("picker.parse_manual", { text }, { silent: true })
			.then((r) => {
				const rows = r.rows || [];
				const invalid = r.invalid || [];
				if (rows.length) this.picker.add_rows(rows, { source_type: this.key });
				this.$text.val("").trigger("input");
				if (invalid.length) {
					invalid.forEach((row) => this.pending.push(this.as_pending(row)));
					this.render_fixes();
					ui.announce(__("{0} numbers added, {1} lines need attention", [rows.length, invalid.length]), { assertive: true });
					this.$fixes.find("input").first().trigger("focus");
				} else {
					this.$text.trigger("focus");
				}
			})
			.catch((err) => {
				this.$error.text(err.message).removeAttr("hidden");
				this.$add.prop("disabled", false);
			});
	}

	/** What the server refused, as the line the reader wrote it (name first, as the hint says). */
	as_pending(row) {
		const phone = row.phone || "";
		return { raw: phone, error: row.error || __("Invalid phone number") };
	}

	// ---- the lines that did not read ----------------------------------------------------------

	render_fixes() {
		if (!this.pending.length) {
			this.$fixes.attr("hidden", true).empty();
			return;
		}
		const n = this.pending.length;
		const $head = $(`
			<div class="sanad-picker__fixes-head">
				<span class="sanad-picker__fixes-title">${ui.escape(ui.plural(n, { one: __("{0} line needs a correction", null, "one"), two: __("{0} lines need a correction", null, "two"), few: __("{0} lines need a correction", null, "few"), many: __("{0} lines need a correction", null, "many"), other: __("{0} lines need a correction") }))}</span>
				<span class="sanad-picker__note">${ui.escape(__("Edit the text and press Enter, or Fix."))}</span>
				<button type="button" class="btn btn-default btn-xs" data-act="fix-all">${ui.escape(__("Fix all"))}</button>
				<button type="button" class="btn btn-default btn-xs" data-act="drop-all">${ui.escape(__("Ignore all"))}</button>
			</div>`);
		const $rows = $('<div class="sanad-picker__fixrows" role="list"></div>');
		this.pending.forEach((p, i) => {
			const $row = $(`
				<div class="sanad-picker__fix" role="listitem" data-idx="${i}">
					<input type="text" class="form-control sanad-picker__fix-input sanad-tabular" dir="auto" value="${ui.escape(p.raw)}" aria-label="${ui.escape(__("Line to correct"))}">
					<span class="sanad-picker__fix-reason" role="status">${ui.escape(p.error)}</span>
					<button type="button" class="btn btn-default btn-xs" data-act="fix">${ui.escape(__("Fix"))}</button>
					<button type="button" class="sanad-picker__remove" data-act="drop" aria-label="${ui.escape(__("Ignore this line"))}" title="${ui.escape(__("Ignore"))}">${ui.icon("es-line-close", "xs")}</button>
				</div>`);
			$row.find("input").on("input", (e) => {
				const clean = ManualSource.numbers_only(e.currentTarget.value);
				if (clean !== e.currentTarget.value) e.currentTarget.value = clean;
			});
			$row.find("input").on("keydown", (e) => {
				if (e.key === "Enter") {
					e.preventDefault();
					this.fix_one(i, $row);
				}
			});
			$row.find('[data-act="fix"]').on("click", () => this.fix_one(i, $row));
			$row.find('[data-act="drop"]').on("click", () => this.drop(i));
			$rows.append($row);
		});
		$head.find('[data-act="fix-all"]').on("click", () => this.fix_all());
		$head.find('[data-act="drop-all"]').on("click", () => {
			this.pending = [];
			this.render_fixes();
			this.$text.trigger("focus");
		});
		this.$fixes.removeAttr("hidden").empty().append($head, $rows);
	}

	drop(i) {
		this.pending.splice(i, 1);
		this.render_fixes();
	}

	/** One corrected line back to the server: it leaves the list when it reads, else says why not. */
	fix_one(i, $row) {
		const raw = String($row.find("input").val() || "").trim();
		if (!raw) return this.drop(i);
		$row.addClass("sanad-picker__fix--busy").find("button").prop("disabled", true);
		return this.call("picker.parse_manual", { text: raw }, { silent: true })
			.then((r) => {
				const rows = r.rows || [];
				if (rows.length) {
					this.picker.add_rows(rows, { source_type: this.key });
					this.pending.splice(i, 1);
					this.render_fixes();
					const $next = this.$fixes.find("input").first();
					if ($next.length) $next.trigger("focus");
					else this.$text.trigger("focus");
					return;
				}
				const bad = (r.invalid || [])[0];
				this.pending[i] = Object.assign(this.as_pending(bad || { phone: raw }), { raw });
				$row.removeClass("sanad-picker__fix--busy").find("button").prop("disabled", false);
				$row.find(".sanad-picker__fix-reason").text(this.pending[i].error);
				$row.addClass("sanad-picker__fix--still");
				setTimeout(() => $row.removeClass("sanad-picker__fix--still"), 600);
				$row.find("input").trigger("focus").trigger("select");
			})
			.catch((err) => {
				$row.removeClass("sanad-picker__fix--busy").find("button").prop("disabled", false);
				sanad.ui.Toast.error(err);
			});
	}

	/** Every line as it now stands, in one call; what still does not read stays with its new reason. */
	fix_all() {
		const lines = this.$fixes
			.find("input")
			.toArray()
			.map((el) => String(el.value || "").trim())
			.filter(Boolean);
		if (!lines.length) {
			this.pending = [];
			return this.render_fixes();
		}
		this.$fixes.find("button").prop("disabled", true);
		return this.call("picker.parse_manual", { text: lines.join("\n") }, { silent: true })
			.then((r) => {
				const rows = r.rows || [];
				if (rows.length) this.picker.add_rows(rows, { source_type: this.key });
				this.pending = (r.invalid || []).map((row) => this.as_pending(row));
				this.render_fixes();
				if (this.pending.length) this.$fixes.find("input").first().trigger("focus");
				else this.$text.trigger("focus");
			})
			.catch((err) => {
				this.$fixes.find("button").prop("disabled", false);
				sanad.ui.Toast.error(err);
			});
	}

	on_show() {
		this.$text && this.$text.trigger("focus");
	}
}

export default ManualSource;

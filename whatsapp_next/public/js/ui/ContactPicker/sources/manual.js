// ContactPicker source 6 — manual entry: a textarea, one entry per line (`phone` or
// `name;phone`), parsed server-side by `picker.parse_manual` (the server's E.164 normalisation is
// authoritative). Valid lines go to the selection; invalid lines stay in the textarea and are
// listed with their reason so the user can fix them.

import ui from "../../_core/index.js";
import BaseSource from "./_base.js";

export class ManualSource extends BaseSource {
	static get key() {
		return "Manual";
	}

	static label() {
		return __("Manual entry");
	}

	render() {
		const id = ui.uid("manual");
		const hint_id = `${id}-hint`;
		// The example comes from PhoneField (country default of the host) when the kit ships it.
		const PhoneField = sanad.ui.PhoneField;
		const example = typeof PhoneField === "function" && typeof PhoneField.example === "function" ? PhoneField.example() : "+966 5X XXX XXXX";
		const $field = $(`
			<div class="sanad-picker__field sanad-picker__manual">
				<label for="${id}">${ui.escape(__("Numbers, one per line"))}</label>
				<textarea id="${id}" class="form-control" rows="8" aria-describedby="${hint_id}" placeholder="${ui.escape(__("{0} or Name;{0}", [example]))}"></textarea>
				<div id="${hint_id}" class="sanad-picker__note">${ui.escape(__("One number per line, with the country code (e.g. {0}). To add a name, write it before the number and separate them with a semicolon: Name;Number", [example]))}</div>
			</div>`);
		this.$text = $field.find("textarea");
		this.$error = $('<div class="sanad-picker__alert" role="alert" hidden></div>');
		this.$results = $('<div class="sanad-picker__results"></div>');
		this.$foot = $('<div class="sanad-picker__foot"></div>');
		this.$add = $(`<button type="button" class="btn btn-primary btn-sm">${ui.escape(__("Add numbers"))}</button>`).on("click", () => this.parse());
		this.$count = $('<span class="sanad-picker__note sanad-tabular"></span>');
		this.$foot.append(this.$add, this.$count);
		this.$text.on("input", () => {
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
		this.$pane.append($field, this.$error, this.$results, this.$foot);
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
				this.$results.empty();
				if (rows.length) this.picker.add_rows(rows, { source_type: this.key });
				if (invalid.length) {
					this.$results.append(this.invalid_list(invalid).attr("open", true));
					this.$text.val(invalid.map((r) => (r.display_name ? `${r.display_name};${r.phone || ""}` : r.phone || "")).join("\n")).trigger("input");
					ui.announce(__("{0} numbers added, {1} lines need attention", [rows.length, invalid.length]), { assertive: true });
					this.$text.trigger("focus");
				} else {
					this.$text.val("").trigger("input");
				}
			})
			.catch((err) => {
				this.$error.text(err.message).removeAttr("hidden");
				this.$add.prop("disabled", false);
			});
	}

	on_show() {
		this.$text && this.$text.trigger("focus");
	}
}

export default ManualSource;

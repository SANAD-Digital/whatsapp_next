// ContactPicker source 4 — Excel upload as a three-step `sanad.ui.Stepper` flow: 1 Upload
// (`frappe.ui.FileUploader`, private file, .xlsx / .xls / .csv), 2 Map columns (only when the
// server answers `needs_mapping` — skipped automatically otherwise, skippable by hand),
// 3 Preview (counts strip, first rows, invalid rows with reasons) whose Finish button "Add N rows"
// pushes the valid rows into the selection. Parsing is `picker.parse_upload {file_url, kind,
// mapping}`; `UploadSource` is shared with source 5 (phone export). File limits arrive as
// `WAFileError` messages and are shown inline in the Upload step.

import ui from "../../_core/index.js";
import BaseSource, { PREVIEW_ROWS } from "./_base.js";

const UPLOAD = 0;
const MAP = 1;
const PREVIEW = 2;

export class UploadSource extends BaseSource {
	static get key() {
		return "Excel";
	}

	static label() {
		return __("Excel file");
	}

	/** Upload kinds of this source (`entry.kinds` from the server or the static default). */
	kinds() {
		return this.entry.kinds && this.entry.kinds.length ? this.entry.kinds : ["excel"];
	}

	allowed_types(kind) {
		return { excel: [".xlsx", ".xls", ".csv"], csv: [".csv"], vcf: [".vcf"] }[kind] || [];
	}

	note() {
		return __("The first row must hold the column headers. The phone column is detected from its header; if that fails, choose it in the next step.");
	}

	render() {
		this.kind = this.kinds()[0];
		this.mapping = null;
		this.result = null;
		this.mapping_needed = false;
		this.steps = [
			{ key: "upload", label: __("Upload"), render: ($body) => this.render_upload($body), validate: () => this.validate_upload() },
			{ key: "map", label: __("Map columns"), can_skip: false, render: ($body) => (this.$mapping = $body), on_show: () => this.render_mapping(), validate: () => this.validate_mapping() },
			{ key: "preview", label: __("Preview"), render: ($body) => (this.$preview = $body), on_show: (_$body, _ctx, stepper) => this.render_preview(stepper) },
		];
		this.stepper = new sanad.ui.Stepper({
			wrapper: this.$pane,
			steps: this.steps,
			finish_label: __("Add rows"),
			on_finish: () => this.add_rows(),
		});
	}

	// ---- step 1: upload ----------------------------------------------------------------------

	render_upload($body) {
		if (this.kinds().length > 1) {
			const labels = { vcf: __("vCard (.vcf)"), csv: __("CSV"), excel: __("Excel") };
			$body.append(this.chips(__("File type"), this.kinds().map((k) => ({ value: k, label: labels[k] || k })), (k) => this.set_kind(k), { all: false }));
		}
		$body.append(`<p class="sanad-picker__note">${ui.escape(this.note())}</p>`);
		this.$uploader = $('<div class="sanad-picker__uploader"></div>').appendTo($body);
		this.$file = $('<div class="sanad-picker__note" aria-live="polite"></div>').appendTo($body);
		this.make_uploader();
	}

	set_kind(kind) {
		this.kind = kind;
		this.mapping = null;
		this.result = null;
		this.columns = [];
		this.mapping_needed = false;
		this.file_url = null;
		this.$file.empty();
		this.stepper.go(UPLOAD);
		this.make_uploader();
	}

	make_uploader() {
		this.$uploader.empty();
		try {
			this.uploader = new frappe.ui.FileUploader({
				wrapper: this.$uploader,
				folder: "Home/Attachments",
				make_attachments_public: false,
				// a file comes from this device or from the files the system already holds — not
				// from a web link, not from the camera
				disable_file_browser: false,
				allow_web_link: false,
				allow_take_photo: false,
				allow_multiple: false,
				restrictions: { allowed_file_types: this.allowed_types(this.kind), max_file_size: 5 * 1024 * 1024, max_number_of_files: 1 },
				upload_notes: __("Private upload. Up to 5 MB and 20,000 rows."),
				on_success: (file_doc) => {
					this.file_url = file_doc.file_url;
					this.file_name = file_doc.file_name || file_doc.file_url;
					this.mapping = null;
					this.$file.text(__("Uploaded {0}", [this.file_name]));
					this.parse().catch(() => {});
				},
			});
		} catch (err) {
			const message = err.message || __("The uploader could not be opened. Reload the page and try again.");
			if (this.stepper) this.stepper.show_error(message);
			else this.$uploader.html(`<div class="sanad-picker__alert" role="alert">${ui.escape(message)}</div>`);
		}
	}

	/**
	 * A file dropped on the dialog: the source picks the kind that matches it and hands it to the
	 * uploader it already owns, so the drop follows exactly the path the button does.
	 */
	accept_file(file) {
		const name = String(file.name || "").toLowerCase();
		const kind = /\.(vcf|vcard)$/.test(name) ? "vcf" : /\.csv$/.test(name) ? "csv" : "excel";
		if (this.kinds().includes(kind) && kind !== this.kind) this.set_kind(kind);
		if (!this.uploader || !this.uploader.uploader) {
			return sanad.ui.Toast.warning(__("Choose the file in the panel."));
		}
		try {
			this.uploader.uploader.add_files([file]);
			this.uploader.uploader.upload_files();
		} catch (e) {
			sanad.ui.Toast.warning(__("Choose the file in the panel."));
		}
	}

	read_error() {
		return __("The file could not be read. Check that it is a valid {0} file and try again.", [{ excel: __("Excel"), csv: __("CSV"), vcf: __("vCard") }[this.kind] || this.kind]);
	}

	validate_upload() {
		if (!this.file_url) return __("Upload a file to continue");
		if (!this.result && !this.mapping_needed) return __("The file is still being read. Try again in a moment.");
		this.steps[MAP].can_skip = !!this.result;
		return true;
	}

	/**
	 * Parse the uploaded file. With `navigate` (default) the flow moves on by itself: success →
	 * Preview, missing phone column → Map columns, any other failure → back to Upload with the
	 * message inline. Rejects with the error either way.
	 */
	parse({ navigate = true } = {}) {
		if (!this.file_url) return Promise.reject(new Error(__("Upload a file to continue")));
		this.picker.set_progress(__("Parsing {0}…", [this.file_name]));
		return this.call("picker.parse_upload", { file_url: this.file_url, kind: this.kind, mapping: this.mapping }, { silent: true })
			.then((r) => {
				this.picker.set_progress(null);
				this.columns = r.columns || [];
				if (r.needs_mapping) {
					// Server could not detect the phone column: the mapping step becomes mandatory.
					this.result = null;
					this.mapping_needed = true;
					this.steps[MAP].can_skip = false;
					if (navigate) {
						this.stepper.go(MAP);
						this.stepper.show_error(r.error || __("Choose the column that holds the phone number"));
					}
					const err = new Error(r.error || __("Choose the column that holds the phone number"));
					err.needs_mapping = true;
					throw err;
				}
				this.result = r;
				this.mapping_needed = false;
				this.steps[MAP].can_skip = true;
				if (navigate) this.stepper.go(PREVIEW);
				return r;
			})
			.catch((err) => {
				if (err.needs_mapping) throw err;
				this.picker.set_progress(null);
				this.result = null;
				const needs_mapping = err.exc_type === "WAValidationError" && this.kind !== "vcf";
				this.mapping_needed = needs_mapping;
				this.steps[MAP].can_skip = false;
				if (navigate) {
					this.stepper.go(needs_mapping ? MAP : UPLOAD);
					this.stepper.show_error(err.message || this.read_error());
				}
				throw err;
			});
	}

	// ---- step 2: map columns -------------------------------------------------------------------

	/** Phone / name column selects (or free text when the columns are unknown). */
	render_mapping() {
		const $body = this.$mapping.empty();
		if (this.kind === "vcf") {
			$body.append(`<p class="sanad-picker__note">${ui.escape(__("vCard files need no column mapping."))}</p>`);
			return;
		}
		const columns = (this.result && this.result.columns) || this.columns || [];
		const phone_id = ui.uid("map-phone");
		const name_id = ui.uid("map-name");
		const control = (id) => {
			if (columns.length) {
				const $s = $(`<select class="form-control" id="${id}"><option value="">${ui.escape(__("Detect automatically"))}</option></select>`);
				columns.forEach((c) => $s.append(`<option value="${ui.escape(c)}">${ui.escape(c)}</option>`));
				return $s;
			}
			return $(`<input type="text" class="form-control" id="${id}" placeholder="${ui.escape(__("Column header"))}">`);
		};
		$body.append(`<p class="sanad-picker__note">${ui.escape(this.result ? __("Columns were detected. Change them here or skip this step.") : __("Choose the column that holds the phone number, then continue to re-read the file."))}</p>`);
		const $grid = $('<div class="sanad-picker__mapping-grid"></div>');
		this.$phone_col = control(phone_id);
		this.$name_col = control(name_id);
		if (this.mapping) {
			this.$phone_col.val(this.mapping.phone || "");
			this.$name_col.val(this.mapping.name || "");
		}
		$grid.append($(`<div class="sanad-picker__field"><label for="${phone_id}">${ui.escape(__("Phone column"))}</label></div>`).append(this.$phone_col));
		$grid.append($(`<div class="sanad-picker__field"><label for="${name_id}">${ui.escape(__("Name column"))}</label></div>`).append(this.$name_col));
		$body.append($grid);
	}

	validate_mapping() {
		if (this.kind === "vcf") return this.result ? true : __("Upload a vCard file first");
		if (!this.file_url) return __("Upload a file first");
		const phone = this.$phone_col ? this.$phone_col.val() : "";
		const name = this.$name_col ? this.$name_col.val() : "";
		if (!phone && this.mapping_needed) return __("Choose the column that holds the phone number");
		this.mapping = phone || name ? { phone: phone || null, name: name || null } : null;
		return this.parse({ navigate: false }).then(
			() => true,
			(err) => err.message || this.read_error()
		);
	}

	// ---- step 3: preview -----------------------------------------------------------------------

	render_preview(stepper) {
		const $body = this.$preview.empty();
		const r = this.result;
		const rows = (r && r.rows) || [];
		const invalid = (r && r.invalid) || [];
		const state = this.state_for($body);
		stepper.set_finish_label(rows.length ? __("Add {0} rows", [ui.format_int(rows.length)]) : __("Add rows"));
		if (!r) {
			state.empty({ title: __("Nothing to preview yet"), description: __("Upload a file first."), action: { label: __("Back to upload"), onclick: () => stepper.go(UPLOAD) } });
			stepper.set_step_valid(false);
			return;
		}
		if (!rows.length && !invalid.length) {
			state.empty({ title: __("The file has no rows") });
			stepper.set_step_valid(false);
			return;
		}
		if (!rows.length) {
			state.empty({ title: __("No valid phone numbers in the file"), description: __("Check the invalid rows below or choose another phone column.") });
			$body.append(this.invalid_list(invalid));
			stepper.set_step_valid(false);
			return;
		}
		state.hide();
		$body.append(`<div class="sanad-picker__counts"><span class="sanad-tone--green">${ui.escape(__("{0} valid", [ui.format_int(rows.length)]))}</span><span class="sanad-tone--amber">${ui.escape(__("{0} invalid", [ui.format_int(invalid.length)]))}</span><span>${ui.escape(__("{0} rows in file", [ui.format_int(r.total || rows.length + invalid.length)]))}</span></div>`);
		$body.append(this.candidate_table(rows.slice(0, PREVIEW_ROWS), { selectable: false }));
		if (rows.length > PREVIEW_ROWS) $body.append(`<div class="sanad-picker__note">${ui.escape(__("Showing the first {0} of {1} valid rows", [PREVIEW_ROWS, ui.format_int(rows.length)]))}</div>`);
		$body.append(this.invalid_list(invalid));
	}

	/** Finish: push the valid rows into the selection, then mark the step as done. */
	add_rows() {
		const rows = (this.result && this.result.rows) || [];
		if (!rows.length) return;
		this.picker.add_rows(rows, { source_type: this.key, source_ref: this.file_name });
		this.stepper.set_step_valid(false);
		this.stepper.set_finish_label(__("Added {0} rows", [ui.format_int(rows.length)]));
	}

	preselect(pre) {
		if (pre && pre.kind && this.kinds().includes(pre.kind) && pre.kind !== this.kind) {
			this.$pane.find(`.sanad-picker__chip[data-value="${pre.kind}"]`).trigger("click");
		}
	}

	destroy() {
		this.uploader = null;
		this.stepper && this.stepper.destroy();
	}
}

export class ExcelSource extends UploadSource {}

export default ExcelSource;

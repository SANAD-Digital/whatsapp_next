// ContactPicker source 5 — phone export file: a vCard (.vcf, primary) or CSV exported from a
// phone, parsed by `picker.parse_upload {kind: "vcf" | "csv"}`. Same upload / preview / mapping
// flow as source 4; the pane says plainly that this is a file import, not the device's address
// book.

import { UploadSource } from "./excel.js";

export class PhonebookSource extends UploadSource {
	static get key() {
		return "vCard";
	}

	static label() {
		return __("Phone export");
	}

	kinds() {
		return this.entry.kinds && this.entry.kinds.length ? this.entry.kinds : ["vcf", "csv"];
	}

	note() {
		return __("Import a contacts file exported from a phone (vCard .vcf, or CSV). This reads the file you upload, not the phone's address book.");
	}
}

export default PhonebookSource;

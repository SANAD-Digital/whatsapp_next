// The app's backup file (owner, 2026-10-10), shared by the Settings window and the sign-up
// screen's "Sign in with another account": `download` saves `settings.export_backup` as a JSON
// file, `import_file` reads one the person picks, shows what it would add, replace and switch off
// (`settings.preview_backup`, nothing written), and imports it on confirmation
// (`settings.import_backup`).

frappe.provide("whatsapp_next.backup");

(function () {
	const esc = (s) => frappe.utils.escape_html(s == null ? "" : String(s));

	/**
	 * The button tells what is happening: a spinner and "Preparing the backup…" while it runs,
	 * then a tick and `done_label` for a moment, then its own label again.
	 */
	function busy($btn, promise, { busy_label, done_label } = {}) {
		if (!$btn || !$btn.length) return promise;
		const $label = $btn.find("span").last().length ? $btn.find("span").last() : $btn;
		const before = $label.text();
		$btn.prop("disabled", true).attr("aria-busy", "true").addClass("wa-backup-btn--busy");
		if (busy_label) $label.text(busy_label);
		const restore = () => {
			$btn.prop("disabled", false).removeAttr("aria-busy").removeClass("wa-backup-btn--busy wa-backup-btn--done");
			$label.text(before);
		};
		return promise.then(
			(r) => {
				$btn.removeClass("wa-backup-btn--busy").removeAttr("aria-busy");
				if (done_label) {
					$btn.addClass("wa-backup-btn--done");
					$label.text(done_label);
					window.setTimeout(restore, 2500);
				} else restore();
				return r;
			},
			(err) => {
				restore();
				throw err;
			}
		);
	}

	function file_name() {
		const site = (frappe.boot.sitename || window.location.hostname || "site").replace(/[^\w.-]+/g, "-");
		return `whatsapp-next-backup-${site}-${frappe.datetime.now_date()}.json`;
	}

	/** Fetch the backup and save it; resolves once the browser was handed the file. */
	function download($btn) {
		return busy(
			$btn,
			sanad.ui.call("settings.export_backup", {}).then((data) => {
				const blob = new Blob([JSON.stringify(data, null, 1)], { type: "application/json" });
				const url = URL.createObjectURL(blob);
				const a = document.createElement("a");
				a.href = url;
				a.download = file_name();
				document.body.appendChild(a);
				a.click();
				a.remove();
				window.setTimeout(() => URL.revokeObjectURL(url), 1000);
				sanad.ui.Toast.success(__("The backup was downloaded."));
				return data;
			}),
			{ busy_label: __("Preparing the backup…"), done_label: __("Downloaded") }
		);
	}

	/** The confirmation that states what the file would do before it is imported. */
	function confirm_import(text, preview) {
		const replaced = preview.replace || [];
		const from = [preview.site, preview.exported_at && frappe.datetime.str_to_user(preview.exported_at)].filter(Boolean).join(" · ");
		return sanad.ui.ConfirmDialog.ask({
			title: __("Import this backup?"),
			message: [
				from ? __("Backup of {0}.", [from]) : "",
				replaced.length ? __("Records with the same name are replaced by the file's version.") : "",
				preview.switched_off ? __("Notifications and alerts come in switched off: turn on the ones you want after checking them.") : "",
			]
				.filter(Boolean)
				.join(" "),
			impact: [
				{ label: __("Added"), value: (preview.add || []).length },
				{ label: __("Replaced"), value: replaced.length, tone: replaced.length ? "orange" : undefined },
				{ label: __("Campaigns already here, kept"), value: (preview.keep || []).length },
				{ label: __("Switched off on import"), value: preview.switched_off || 0 },
				{ label: __("Settings fields"), value: preview.settings || 0 },
			],
			confirm_label: __("Import the backup"),
			on_confirm: () => sanad.ui.call("settings.import_backup", { data: text }, { freeze: true }),
		});
	}

	/** Pick a `.json` file, show what it would do, and import it on confirmation; the outcome is
	 * written into `$result` when given. */
	function import_file($btn, $result) {
		const input = document.createElement("input");
		input.type = "file";
		input.accept = "application/json,.json";
		input.onchange = () => {
			const file = input.files && input.files[0];
			if (!file) return;
			file.text().then((text) =>
				busy(
					$btn,
					sanad.ui
						.call("settings.preview_backup", { data: text })
						.then((preview) => confirm_import(text, preview))
						.then((r) => {
							const failed = r.failed || [];
							const line = __("{0} added, {1} replaced, {2} failed.", [r.created || 0, r.updated || 0, failed.length]);
							if (failed.length) sanad.ui.Toast.error(line);
							else sanad.ui.Toast.success(__("The backup was imported.") + " " + line);
							if ($result) {
								$result.html(`
									<p>${esc(line)}</p>
									${
										failed.length
											? `<ul class="wa-settings__backup-failed">${failed
													.map((f) => `<li><b>${esc(__(f.doctype))} · ${esc(f.name)}</b> — ${esc(f.error)}</li>`)
													.join("")}</ul>`
											: ""
									}`);
							}
						})
						// a cancelled confirmation is not an error
						.catch((err) => err && err.message !== "cancelled" && sanad.ui.Toast.error(err)),
					{ busy_label: __("Importing…"), done_label: __("Imported") }
				)
			);
		};
		input.click();
	}

	Object.assign(whatsapp_next.backup, { download, import_file });
})();

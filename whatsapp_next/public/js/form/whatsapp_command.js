// whatsapp_command form script + the shared command editor. `whatsapp_next.command_modal(name)` opens
// `sanad.ui.CommandEditor` (the prototype's Command Editor, D-132) over the `commands.*` editor API:
// Setup · Permissions · Preview, save with status through `commands.save_editor`, a dry run of the
// unsaved draft through `commands.preview_command`. The list view loads this file through the
// DocType meta (`__js`) so both surfaces open the same editor; the small "Test" dialog stays for the
// list's row action.

frappe.provide("whatsapp_next");

/** Definition list of a `commands.test_command` result (dry run — nothing sent). */
whatsapp_next.render_command_test_result = function ($el, result) {
	const esc = sanad.ui.escape;
	const matched = !!result.matched;
	const rows = [
		[__("Matched"), sanad.ui.StatusBadge.html({ label: matched ? __("Yes") : __("No"), colour: matched ? "green" : "gray" })],
		[__("Command"), esc(result.command || "—")],
		[__("Status"), esc(result.status || "—")],
		[__("Block reason"), esc(result.block_reason || "—")],
		[__("Arguments"), `<code>${esc(result.args && Object.keys(result.args).length ? JSON.stringify(result.args) : "—")}</code>`],
		[__("Reply"), result.reply_body ? `<pre class="small mb-0" style="white-space: pre-wrap">${esc(result.reply_body)}</pre>` : esc("—")],
		[__("Function time"), esc(result.function_ms != null ? __("{0} ms", [cint(result.function_ms)]) : "—")],
	];
	if (result.error) rows.push([__("Error"), `<span class="text-danger">${esc(result.error)}</span>`]);
	// Reuses the kit's impact-list layout (ConfirmDialog) for the label / value rows.
	$el.html(
		`<dl class="sanad-confirm__impact wa-command-test" aria-live="polite">${rows
			.map(([label, value]) => `<div class="sanad-confirm__row"><dt>${esc(label)}</dt><dd>${value}</dd></div>`)
			.join("")}</dl>`
	);
};

/**
 * Render the dry-run tester (text, sender phone, device → `commands.test_command`) into `$el`.
 * Returns `{set_text, set_device}` so the caller can prefill the inputs.
 */
whatsapp_next.render_command_tester = function ($el, { note, initial = {} } = {}) {
	$el.empty();
	if (note) $(`<p class="text-muted wa-command-tester__note">${sanad.ui.escape(note)}</p>`).appendTo($el);
	const $form = $('<div class="wa-command-tester__form"></div>').appendTo($el);
	const $result = $('<div class="wa-command-tester__result"></div>').appendTo($el);
	const make = (df) => frappe.ui.form.make_control({ df, parent: $form, render_input: true });
	const text = make({ fieldtype: "Small Text", fieldname: "text", label: __("Incoming text"), reqd: 1 });
	const phone = make({ fieldtype: "Data", fieldname: "sender_phone", label: __("Sender phone"), reqd: 1, description: __("Any format works; it is normalised automatically.") });
	const device = make({ fieldtype: "Link", fieldname: "device", label: __("Device"), options: "WhatsApp Device" });
	[text, phone, device].forEach((c) => c.refresh());
	if (initial.text) text.set_value(initial.text);
	if (initial.sender_phone) phone.set_value(initial.sender_phone);
	if (initial.device) device.set_value(initial.device);
	const $run = $(`<button type="button" class="btn btn-sm btn-primary mt-2 wa-command-tester__run">${sanad.ui.escape(__("Run test"))}</button>`).appendTo($form);
	const state = new sanad.ui.EmptyState({ wrapper: $result, state: "empty", size: "sm", title: __("No test run yet"), description: __("Dry run — nothing is sent and nothing is saved.") });
	$run.on("click", async () => {
		const args = { text: text.get_value(), sender_phone: phone.get_value(), device: device.get_value() || null };
		if (!args.text || !args.sender_phone) {
			state.set("empty", { title: __("Enter the text and the sender phone"), description: "" });
			return;
		}
		$run.prop("disabled", true);
		state.loading({ rows: 3 });
		try {
			const result = await sanad.ui.call("commands.test_command", args);
			state.hide();
			whatsapp_next.render_command_test_result($result, result);
		} catch (err) {
			state.error(err, { action: { label: __("Retry"), onclick: () => $run.trigger("click") } });
		} finally {
			$run.prop("disabled", false);
		}
	});
	return { set_text: (value) => text.set_value(value || ""), set_device: (name) => device.set_value(name || "") };
};

/** Small standalone "Test" dialog (list row action). */
whatsapp_next.command_test_dialog = function (doc = {}) {
	const dialog = new frappe.ui.Dialog({
		title: doc.code ? __("Test {0}", [doc.code]) : __("Test a command"),
		fields: [{ fieldtype: "HTML", fieldname: "tester" }],
		size: "small",
	});
	dialog.$wrapper.addClass("sanad-kit");
	whatsapp_next.render_command_tester(dialog.get_field("tester").$wrapper, {
		initial: { text: doc.code || "", device: doc.reply_device || "" },
	});
	dialog.show();
	return dialog;
};

/**
 * The command editor (`sanad.ui.CommandEditor`, the prototype's `Command Editor`, D-132). `name`
 * empty → new command. `opts.read_only` for viewers, `opts.on_saved(result)` after a save or a
 * delete. Status, per-type lists, variables, options, outputs and the live preview all live in it.
 */
whatsapp_next.command_modal = function (name, opts = {}) {
	const call = (method, args) => sanad.ui.call(`commands.${method}`, args);
	return new sanad.ui.CommandEditor({
		name: name || null,
		read_only: !!opts.read_only || !frappe.user.has_role("WhatsApp Manager"),
		load: (n) => call("get_editor", { name: n }),
		load_function: (fn) => call("get_function_spec", { function: fn }),
		save: (payload) => call("save_editor", { payload }),
		remove: (n) => call("delete_command", { name: n }),
		preview: ({ payload, sender, values }) => call("preview_command", { payload, sender, values }),
		search_groups: (txt) => call("search_groups", { txt }),
		search_contacts: (txt, party_type) => call("search_contacts", { txt, party_type }),
		on_saved: opts.on_saved,
		on_close: opts.on_close,
	});
};

frappe.ui.form.on("WhatsApp Command", {
	refresh(frm) {
		if (frm.is_new()) {
			// A command is created in the command editor only (D-029): `/new` goes back to the list with
			// the editor open, so defaults, suggestions and the allow-listed save always apply.
			frappe.set_route("List", "WhatsApp Command").then(() =>
				whatsapp_next.command_modal(null, { on_saved: () => window.cur_list && cur_list.refresh() })
			);
			return;
		}
		const active = frm.doc.status === "Active";
		const manager = frappe.user.has_role("WhatsApp Manager");
		frm.set_intro(__('Edit this command with "Open editor".'), "blue");
		if (active) frm.disable_form();
		const open = () =>
			whatsapp_next.command_modal(frm.doc.name, {
				on_saved: (r) => (r && r.deleted ? frappe.set_route("List", "WhatsApp Command") : frm.reload_doc()),
			});
		frm.add_custom_button(__("Open editor"), open);
		if (frm.doc.function) {
			frm.add_custom_button(__("Open function"), () => {
				frappe.route_options = { function: frm.doc.function };
				frappe.set_route("wa-functions-center");
			});
		}
		if (!manager) return;
		frm.add_custom_button(active ? __("Stop") : __("Start command"), async () => {
			try {
				await sanad.ui.call("commands.set_status", { name: frm.doc.name, status: active ? "Inactive" : "Active" });
				sanad.ui.Toast.success(active ? __("Command stopped") : __("Command started"));
				frm.reload_doc();
			} catch (err) {
				sanad.ui.Toast.error(err);
			}
		});
		frm.add_custom_button(__("Test"), () => whatsapp_next.command_test_dialog(frm.doc));
		if (!active) {
			frm.add_custom_button(__("Restore defaults"), () =>
				sanad.ui.ConfirmDialog.ask({
					title: __("Restore defaults for {0}?", [frm.doc.code || frm.doc.name]),
					message: __("Outputs are re-copied from the function and the settings overrides are cleared."),
					impact: [{ label: __("Function"), value: frm.doc.function || "—" }],
					confirm_label: __("Restore defaults"),
					on_confirm: () => sanad.ui.call("commands.restore_defaults", { name: frm.doc.name }),
				})
					.then(() => {
						sanad.ui.Toast.success(__("Defaults restored"));
						frm.reload_doc();
					})
					.catch(() => {})
			);
		}
	},
});

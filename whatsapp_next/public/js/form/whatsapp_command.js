// whatsapp_command form script + the shared CommandModal. `whatsapp_next.command_modal(name)` is a
// sanad.ui.MetaDialog over the WhatsApp Command meta (spec §5.5, matrix row 8): tabs Command ·
// Permissions · Preview, defaults pulled from the Function on pick (`commands.get_defaults`), save
// through `commands.save_command`, dry-run test through `commands.test_command`. The list view
// loads this file through the DocType meta (`__js`) so both surfaces open the same dialog; the form
// itself is read-only while the command is Active and points to the editor.

frappe.provide("whatsapp_next");

const COMMAND_FIELDS = ["code", "title", "function", "synonyms", "description", "outputs"];
const PERMISSION_FIELDS = ["requires_linked_contact", "allowed_party_types", "allowed_group", "blocked_group", "reply_device"];

/** Allow-listed `commands.save_command` payload from the dialog values (backend-plan §4.10). */
function command_payload(values, state) {
	const payload = {
		code: values.code || "",
		title: values.title || "",
		function: values.function || "",
		synonyms: values.synonyms || "",
		description: values.description || "",
		requires_linked_contact: cint(values.requires_linked_contact),
		allowed_party_types: (values.allowed_party_types || []).map((row) => row.party_type).filter(Boolean),
		allowed_group: values.allowed_group || null,
		blocked_group: values.blocked_group || null,
		reply_device: values.reply_device || null,
		settings_overrides: state.settings_overrides || {},
		outputs: sanad.ui.MetaDialog.clean_rows(values.outputs || [], "WhatsApp Function Output"),
	};
	if (state.name) payload.name = state.name;
	return payload;
}

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
 * The CommandModal. `name` empty → new command. `opts.read_only` for Active commands,
 * `opts.on_saved(result)` after a successful save, `opts.actions` extra footer buttons
 * (`[{label, handler(values, dialog)}]` — the lifecycle verbs the list offers on a command).
 */
whatsapp_next.command_modal = function (name, opts = {}) {
	const state = { name: name || null, settings_overrides: {}, tester: null };
	const is_new = !name;

	const apply_function_defaults = async (fn, dialog) => {
		try {
			const defaults = await sanad.ui.call("commands.get_defaults", { function: fn });
			state.settings_overrides = {};
			const outputs = (defaults.outputs || []).map((row) => Object.assign({}, row, { template: row.template || row.default_template }));
			await dialog.set_values({ outputs });
			if (defaults.party_types && defaults.party_types.length && !(dialog.get_values().allowed_party_types || []).length) {
				await dialog.set_values({ allowed_party_types: defaults.party_types.map((party_type) => ({ party_type })) });
			}
			render_suggestions(dialog, defaults.suggested_commands || []);
		} catch (err) {
			sanad.ui.Toast.error(err);
		}
	};

	const render_suggestions = (dialog, words) => {
		const field = dialog.get_field("code");
		if (!field) return;
		field.$wrapper.find(".wa-command-suggest").remove();
		if (!words.length) return;
		const $box = $(`<div class="wa-command-suggest d-flex flex-wrap align-items-center mt-1" style="gap: 6px"><span class="text-muted small">${sanad.ui.escape(__("Suggested by the function:"))}</span></div>`);
		words.forEach((word) => {
			$(`<button type="button" class="btn btn-xs btn-default">${sanad.ui.escape(word)}</button>`)
				.on("click", () => dialog.set_values({ code: word }))
				.appendTo($box);
		});
		$box.appendTo(field.$wrapper);
	};

	const dialog = new sanad.ui.MetaDialog({
		doctype: "WhatsApp Command",
		name: state.name,
		title: is_new ? __("New command") : opts.read_only ? __("Command") : __("Edit command"),
		size: "large",
		read_only: !!opts.read_only,
		tabs: [
			{ label: __("Command"), fields: COMMAND_FIELDS },
			{ label: __("Permissions"), fields: PERMISSION_FIELDS },
			{
				label: __("Preview"),
				fields: [
					{
						fieldtype: "HTML",
						fieldname: "preview",
						render: ($el) => {
							state.tester = whatsapp_next.render_command_tester($el, {
								note: is_new
									? __("The test runs against saved commands — save this command first to test it.")
									: __("The test runs against the saved command; save your changes first to test them."),
							});
						},
					},
				],
			},
		],
		primary_action: {
			label: is_new ? __("Create command") : __("Save"),
			method: "commands.save_command",
			args: (values) => ({ payload: command_payload(values, state) }),
			on_success: (result) => {
				sanad.ui.Toast.success(is_new ? __("Command created") : __("Command saved"));
				opts.on_saved && opts.on_saved(result);
			},
		},
		extra_actions: opts.actions || [],
		on_change: (fieldname, value, d) => {
			if (fieldname === "function" && is_new && value) apply_function_defaults(value, d);
		},
		on_load: (doc, d) => {
			try {
				state.settings_overrides = doc.settings_overrides ? JSON.parse(doc.settings_overrides) : {};
			} catch (e) {
				state.settings_overrides = {};
			}
			if (state.tester) {
				state.tester.set_device(doc.reply_device || "");
				state.tester.set_text(doc.code || "");
			}
		},
	});
	dialog.show().catch((err) => sanad.ui.Toast.error(err));
	return dialog;
};

frappe.ui.form.on("WhatsApp Command", {
	refresh(frm) {
		if (frm.is_new()) {
			// A command is created in the CommandModal only (D-029): `/new` goes back to the list with
			// the editor open, so defaults, suggestions and the allow-listed save always apply.
			frappe.set_route("List", "WhatsApp Command").then(() =>
				whatsapp_next.command_modal(null, { on_saved: () => window.cur_list && cur_list.refresh() })
			);
			return;
		}
		const active = frm.doc.status === "Active";
		const manager = frappe.user.has_role("WhatsApp Manager");
		frm.set_intro(
			active
				? __('This command is active and locked. Stop it first, then edit it with "Open editor".')
				: __('Edit this command with "Open editor".'),
			active ? "orange" : "blue"
		);
		if (active) frm.disable_form();
		const open = () => whatsapp_next.command_modal(frm.doc.name, { read_only: active, on_saved: () => frm.reload_doc() });
		frm.add_custom_button(__("Open editor"), open);
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

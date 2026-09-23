// whatsapp_command list settings — the Commands screen (matrix row 8, spec §5.5): status
// indicator, a "New command" primary action opening the CommandModal (sanad.ui.MetaDialog, defined
// in form/whatsapp_command.js and loaded here through the DocType meta), row actions (edit with the
// "stop to edit" guard, start / stop, restore defaults, dry-run test) and bulk start / stop through
// `commands.set_status_many`. Every action calls the API; nothing is rendered without a handler.

frappe.provide("whatsapp_next");

const MANAGER = "WhatsApp Manager";

/** The form script holds the modal; lists do not load it, so evaluate it from the meta once. */
function ensure_modal_loaded() {
	if (typeof whatsapp_next.command_modal === "function") return true;
	const meta = frappe.get_meta("WhatsApp Command");
	if (meta && meta.__js) {
		new Function(meta.__js)();
	}
	return typeof whatsapp_next.command_modal === "function";
}

function open_modal(listview, name, opts = {}) {
	if (!ensure_modal_loaded()) {
		sanad.ui.Toast.info(__("The editor could not be loaded; opening the form instead."));
		frappe.set_route("Form", "WhatsApp Command", name || "new");
		return;
	}
	whatsapp_next.command_modal(name || null, Object.assign({ on_saved: () => listview && listview.refresh() }, opts));
}

function set_primary(listview) {
	if (!listview.can_create || frappe.boot.read_only) return;
	listview.page.set_primary_action(__("New command"), () => open_modal(listview), "add");
}

async function set_status(listview, name, status) {
	try {
		await sanad.ui.call("commands.set_status", { name, status });
		sanad.ui.Toast.success(status === "Active" ? __("Command started") : __("Command stopped"));
		listview.refresh();
	} catch (err) {
		sanad.ui.Toast.error(err);
	}
}

async function edit_command(listview, doc) {
	if (doc.status === "Active") {
		try {
			await sanad.ui.ConfirmDialog.ask({
				title: __("Stop the command to edit it?"),
				message: __("Active commands are locked. Stopping this command pauses its replies until you start it again."),
				impact: [{ label: __("Command"), value: doc.code || doc.name }],
				confirm_label: __("Stop and edit"),
				on_confirm: () => sanad.ui.call("commands.set_status", { name: doc.name, status: "Inactive" }),
			});
		} catch (e) {
			return; // cancelled
		}
		listview.refresh();
	}
	open_modal(listview, doc.name);
}

async function restore_defaults(listview, doc) {
	try {
		await sanad.ui.ConfirmDialog.ask({
			title: __("Restore defaults for {0}?", [doc.code || doc.name]),
			message: __("Outputs are re-copied from the function and the settings overrides are cleared."),
			impact: [{ label: __("Function"), value: doc.function || "—" }],
			confirm_label: __("Restore defaults"),
			on_confirm: () => sanad.ui.call("commands.restore_defaults", { name: doc.name }),
		});
		sanad.ui.Toast.success(__("Defaults restored"));
		listview.refresh();
	} catch (e) {
		// cancelled or already toasted
	}
}

function test_command(doc) {
	if (ensure_modal_loaded()) {
		whatsapp_next.command_test_dialog(doc);
		return;
	}
	sanad.ui.Toast.info(__("Open the command to test it."));
	frappe.set_route("Form", "WhatsApp Command", doc.name);
}

function setup_row_actions(listview) {
	if (typeof sanad.ui.RowActions !== "function") return;
	new sanad.ui.RowActions({
		listview,
		actions: [
			{ label: __("Edit"), icon: "es-line-edit", roles: [MANAGER], handler: (doc) => edit_command(listview, doc) },
			{ label: __("Start"), icon: "es-line-check", roles: [MANAGER], condition: (doc) => doc.status !== "Active", handler: (doc) => set_status(listview, doc.name, "Active") },
			{ label: __("Stop"), icon: "es-line-close", roles: [MANAGER], condition: (doc) => doc.status === "Active", handler: (doc) => set_status(listview, doc.name, "Inactive") },
			{ label: __("Restore defaults"), icon: "es-line-reload", roles: [MANAGER], condition: (doc) => doc.status !== "Active", handler: (doc) => restore_defaults(listview, doc) },
			{ label: __("Test"), icon: "es-line-chat", roles: [MANAGER], handler: (doc) => test_command(doc) },
		],
		on_row_click: (doc) => open_modal(listview, doc.name, { read_only: doc.status === "Active" || !frappe.user.has_role(MANAGER) }),
	});
}

function setup_bulk_actions(listview) {
	if (typeof sanad.ui.BulkActions !== "function") return;
	new sanad.ui.BulkActions({
		listview,
		actions: [
			{ label: __("Start selected"), method: "commands.set_status_many", args: () => ({ status: "Active" }), roles: [MANAGER] },
			{ label: __("Stop selected"), method: "commands.set_status_many", args: () => ({ status: "Inactive" }), roles: [MANAGER] },
		],
	});
}

frappe.listview_settings["WhatsApp Command"] = {
	hide_name_column: true,
	add_fields: ["status", "code", "title", "function", "reply_device"],
	get_indicator(doc) {
		return doc.status === "Active" ? [__("Active"), "green", "status,=,Active"] : [__("Inactive"), "gray", "status,=,Inactive"];
	},
	// Frappe calls this instead of `make_new_doc` for the Add button and Ctrl+B.
	primary_action() {
		open_modal(window.cur_list && window.cur_list.doctype === "WhatsApp Command" ? window.cur_list : null);
	},
	onload(listview) {
		ensure_modal_loaded();
		set_primary(listview);
		setup_row_actions(listview);
		setup_bulk_actions(listview);
		// The list re-sets "Add …" whenever the selection is cleared — restore the label after it.
		listview.$result.on("change.wacmd", "input[type=checkbox]", () => window.setTimeout(() => set_primary(listview), 0));
	},
	refresh(listview) {
		set_primary(listview);
	},
};

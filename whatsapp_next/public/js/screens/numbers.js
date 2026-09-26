// WhatsApp Number actions (09 row 13), shared by the Numbers list and the Number form: the
// conversation drawer with its actions (link / quick send / confirm / unlink), the link-or-convert
// dialog, confirm and unlink. `listview` in every helper is anything with `refresh()` — the list
// passes itself, the form passes `{refresh: () => frm.reload_doc()}` — or nothing.

frappe.provide("whatsapp_next.numbers");

(function () {
	const MANAGER_ROLES = ["WhatsApp Manager", "System Manager"];

	function open_conversation(doc, listview) {
		return sanad.ui.ConversationDrawer.open({
			key: doc.phone_e164 || doc.jid || doc.name,
			device: doc.last_device || undefined,
			on_link: (number) => link_convert_dialog(number || doc, () => listview && listview.refresh()),
			on_close: () => listview && listview.refresh(),
			actions: [
				"link",
				"quick_send",
				"confirm",
				{
					key: "unlink",
					label: __("Unlink"),
					icon: sanad.ui.icons.cancel,
					roles: MANAGER_ROLES,
					condition: (number) => !!(number && number.contact),
					handler: (number, drawer) => unlink_number(number, { refresh: () => drawer.load_number() }).then(() => listview && listview.refresh()),
				},
			],
		});
	}

	function quick_send(doc) {
		if (typeof sanad.ui.QuickSend !== "function") return;
		const args = { device: doc.last_device || undefined };
		if (doc.phone_e164) args.phone = doc.phone_e164;
		else if (doc.jid) args.jid = doc.jid;
		new sanad.ui.QuickSend(args);
	}

	function confirm_conversation(doc, listview) {
		return sanad.ui.ConversationDrawer.confirm_dialog(doc)
			.then(() => listview && listview.refresh())
			.catch(() => {});
	}

	function unlink_number(doc, listview) {
		return sanad.ui.ConfirmDialog.ask({
			title: __("Unlink {0}?", [doc.phone_e164]),
			message: __("The number stays in the list as not linked. The contact is not deleted."),
			impact: [
				{ label: __("Contact"), value: doc.contact },
				{ label: __("Number"), value: doc.phone_e164 },
			],
			danger: true,
			confirm_label: __("Unlink"),
			on_confirm: () => sanad.ui.call("numbers.unlink_number", { phone_e164: doc.phone_e164 }),
		})
			.then(() => {
				sanad.ui.Toast.success(__("Number unlinked"));
				listview && listview.refresh();
			})
			.catch(() => {});
	}

	/** Link / convert dialog: link an existing Contact, or create one from the number. */
	function link_convert_dialog(doc, on_done) {
		const phone_e164 = doc.phone_e164 || doc.name;
		let party_search = null;
		const dialog = new frappe.ui.Dialog({
			title: __("Add {0} as a contact", [doc.display_name || phone_e164]),
			size: "small",
			fields: [
				{ fieldtype: "HTML", fieldname: "error_html" },
				{
					fieldtype: "Select",
					fieldname: "mode",
					label: __("Add by"),
					options: [
						{ label: __("Link an existing contact"), value: "link" },
						{ label: __("Create a new contact"), value: "create" },
					],
					default: "link",
					reqd: 1,
				},
				{ fieldtype: "Data", fieldname: "phone_e164", label: __("WhatsApp number"), default: phone_e164, read_only: 1 },
				{ fieldtype: "Section Break", fieldname: "link_section", depends_on: "eval:doc.mode=='link'" },
				{
					fieldtype: "Link",
					fieldname: "contact",
					label: __("Contact"),
					options: "Contact",
					mandatory_depends_on: "eval:doc.mode=='link'",
					description: __("Search by name, email or company."),
				},
				{ fieldtype: "Section Break", fieldname: "create_section", depends_on: "eval:doc.mode=='create'" },
				{ fieldtype: "Data", fieldname: "first_name", label: __("First name"), default: doc.display_name || "", mandatory_depends_on: "eval:doc.mode=='create'" },
				{ fieldtype: "Data", fieldname: "last_name", label: __("Last name") },
				{ fieldtype: "Column Break", fieldname: "party_column" },
				{
					fieldtype: "Select",
					fieldname: "party_type",
					label: __("Linked to"),
					options: [
						{ label: "", value: "" },
						{ label: __("Customer"), value: "Customer" },
						{ label: __("Supplier"), value: "Supplier" },
						{ label: __("Employee"), value: "Employee" },
					],
					change: () => {
						const party_type = dialog.get_value("party_type");
						dialog.set_value("party_name", "");
						dialog.fields_dict.party_name.set_data([]);
						dialog.set_df_property("party_name", "description", party_type ? __("Type to search {0}.", [__(party_type)]) : "");
					},
				},
				{
					fieldtype: "Autocomplete",
					fieldname: "party_name",
					label: __("Linked record"),
					depends_on: "eval:doc.party_type",
				},
			],
			primary_action_label: __("Add as contact"),
			primary_action: (values) => {
				set_error("");
				const $btn = dialog.get_primary_btn().prop("disabled", true);
				const call =
					values.mode === "link"
						? sanad.ui.call("numbers.link_number", { phone_e164, contact: values.contact })
						: sanad.ui.call("numbers.convert_number", {
								phone_e164,
								first_name: values.first_name,
								last_name: values.last_name || null,
								party_type: values.party_type || null,
								party_name: values.party_type ? values.party_name || null : null,
						  });
				call
					.then((r) => {
						dialog.hide();
						sanad.ui.Toast.success(__("Linked to contact {0}", [r.contact]), {
							action: { label: __("Open contact"), onclick: () => frappe.set_route("Form", "Contact", r.contact) },
						});
						on_done && on_done(r);
					})
					.catch((err) => {
						$btn.prop("disabled", false);
						set_error((err && err.message) || __("Something went wrong. Please try again."));
					});
			},
		});
		dialog.$wrapper.addClass("sanad-kit sanad-sheet");
		// Server errors stay visible inside the dialog (a toast alone disappears after 8 s).
		const $error = dialog.get_field("error_html").$wrapper;
		const set_error = (message) => {
			if (!message) {
				$error.empty();
				return;
			}
			$error.html(`<div class="alert alert-danger sanad-link-dialog__error" role="alert" tabindex="-1">${frappe.utils.escape_html(message)}</div>`);
			$error.find("[role=alert]").trigger("focus");
		};
		// Party search goes through the contextual permission layer, not a direct Link on the party DocType.
		party_search = frappe.utils.debounce((txt) => {
			const party_type = dialog.get_value("party_type");
			if (!party_type) return;
			sanad.ui
				.call("contacts.search_party", { party_type, txt: txt || "" }, { silent: true })
				.then((rows) => dialog.fields_dict.party_name.set_data((rows || []).map((r) => ({ value: r.name, label: r.title || r.name }))))
				.catch((err) => set_error((err && err.message) || __("Could not search {0}.", [__(party_type)])));
		}, 250);
		dialog.fields_dict.party_name.$input.on("input focus", (e) => party_search(e.target.value));
		dialog.show();
		return dialog;
	}

	Object.assign(whatsapp_next.numbers, { open_conversation, quick_send, confirm_conversation, unlink_number, link_convert_dialog });
})();

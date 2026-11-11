// WhatsApp Number actions (09 row 13), shared by the Numbers list and the Number form: the
// conversation drawer with its actions (link / quick send / confirm / unlink), the link-or-convert
// dialog, confirm and unlink. `listview` in every helper is anything with `refresh()` — the list
// passes itself, the form passes `{refresh: () => frm.reload_doc()}` — or nothing.

frappe.provide("whatsapp_next.numbers");

(function () {
	const MANAGER_ROLES = ["WhatsApp Manager", "System Manager"];

	function open_conversation(doc, listview) {
		return whatsapp.ui.ConversationDrawer.open({
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
					icon: whatsapp.ui.icons.cancel,
					roles: MANAGER_ROLES,
					condition: (number) => !!(number && number.contact),
					handler: (number, drawer) => unlink_number(number, { refresh: () => drawer.load_number() }).then(() => listview && listview.refresh()),
				},
			],
		});
	}

	function quick_send(doc) {
		if (typeof whatsapp.ui.QuickSend !== "function") return;
		const args = { device: doc.last_device || undefined };
		if (doc.phone_e164) args.phone = doc.phone_e164;
		else if (doc.jid) args.jid = doc.jid;
		new whatsapp.ui.QuickSend(args);
	}

	function confirm_conversation(doc, listview) {
		return whatsapp.ui.ConversationDrawer.confirm_dialog(doc)
			.then(() => listview && listview.refresh())
			.catch(() => {});
	}

	function unlink_number(doc, listview) {
		return whatsapp.ui.ConfirmDialog.ask_for_confirmation({
			title: __("Unlink {0}?", [whatsapp.ui.phone(doc.phone_e164)]),
			message: __("The number stays in the list as not linked, and it is removed from the contact's numbers. The contact itself is kept."),
			impact: [
				{ label: __("Contact"), value: doc.contact },
				{ label: __("Number"), value: whatsapp.ui.phone(doc.phone_e164) },
			],
			danger: true,
			confirm_label: __("Unlink"),
			on_confirm: () => whatsapp.ui.call("numbers.unlink_number", { phone_e164: doc.phone_e164 }),
		})
			.then(() => {
				whatsapp.ui.Toast.success(__("Number unlinked"));
				listview && listview.refresh();
			})
			.catch(() => {});
	}

	/** Link / convert dialog: link an existing Contact, or create one from the number. */
	function link_convert_dialog(doc, on_done) {
		const phone_e164 = doc.phone_e164 || doc.name;
		// a group links to a contact or gets a new one (named after its subject, with no phone row)
		const group = doc.number_type === "Group";
		const action_label = (mode) => (mode === "create" ? __("Add as contact") : __("Link", null, "Link a number to a contact"));
		let party_search = null;
		const dialog = new frappe.ui.Dialog({
			// a group's name is whatever its members called it: escaped, a dialog title is HTML
			title: __("Add {0} as a contact", [frappe.utils.escape_html(doc.display_name || whatsapp.ui.phone(phone_e164))]),
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
					change: () => dialog.get_primary_btn().text(action_label(dialog.get_value("mode"))),
				},
				{ fieldtype: "Data", fieldname: "phone_e164", label: group ? __("WhatsApp group") : __("WhatsApp number"), default: group ? doc.display_name || whatsapp.ui.phone(phone_e164) : whatsapp.ui.phone(phone_e164), read_only: 1 },
				{ fieldtype: "Section Break", fieldname: "link_section", depends_on: "eval:doc.mode=='link'" },
				{
					// searched through the contextual layer (`contacts.list_contacts`): a Link on
					// Contact asks Desk's search, which refuses a WhatsApp Contact User
					fieldtype: "Autocomplete",
					fieldname: "contact",
					label: __("Contact"),
					mandatory_depends_on: "eval:doc.mode=='link'",
					description: __("Search by name, email or number."),
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
			primary_action_label: action_label("link"),
			primary_action: (values) => {
				set_error("");
				const $btn = dialog.get_primary_btn().prop("disabled", true);
				const call =
					values.mode === "link"
						? whatsapp.ui.call("numbers.link_number", { phone_e164, contact: values.contact })
						: whatsapp.ui.call("numbers.convert_number", {
								phone_e164,
								first_name: values.first_name,
								last_name: values.last_name || null,
								party_type: values.party_type || null,
								party_name: values.party_type ? values.party_name || null : null,
						  });
				call
					.then((r) => {
						dialog.hide();
						whatsapp.ui.Toast.success(__("Linked to contact {0}", [r.contact]), {
							action: { label: __("Open contact"), onclick: () => whatsapp.ui.ConversationDrawer.open_contact(r.contact) },
						});
						on_done && on_done(r);
					})
					.catch((err) => {
						$btn.prop("disabled", false);
						set_error((err && err.message) || __("Something went wrong. Please try again."));
					});
			},
		});
		dialog.$wrapper.addClass("whatsapp-kit whatsapp-kit-sheet");
		// Server errors stay visible inside the dialog (a toast alone disappears after 8 s).
		const $error = dialog.get_field("error_html").$wrapper;
		const set_error = (message) => {
			if (!message) {
				$error.empty();
				return;
			}
			$error.html(`<div class="alert alert-danger whatsapp-kit-link-dialog__error" role="alert" tabindex="-1">${frappe.utils.escape_html(message)}</div>`);
			$error.find("[role=alert]").trigger("focus");
		};
		// Party search goes through the contextual permission layer, not a direct Link on the party DocType.
		party_search = frappe.utils.debounce((txt) => {
			const party_type = dialog.get_value("party_type");
			if (!party_type) return;
			whatsapp.ui
				.call("contacts.search_party", { party_type, txt: txt || "" }, { silent: true })
				.then((rows) => dialog.fields_dict.party_name.set_data((rows || []).map((r) => ({ value: r.name, label: r.title || r.name }))))
				.catch((err) => set_error((err && err.message) || __("Could not search {0}.", [__(party_type)])));
		}, 250);
		dialog.fields_dict.party_name.$input.on("input focus", (e) => party_search(e.target.value));
		const contact_search = frappe.utils.debounce((txt) => {
			whatsapp.ui
				.call("contacts.list_contacts", { search: txt || "", page_length: 10, order_by: "full_name asc" }, { silent: true })
				.then((r) =>
					dialog.fields_dict.contact.set_data(
						((r && r.rows) || []).map((c) => {
							const phone = ((c.phone_nos || []).find((p) => cint(p.is_primary_mobile_no)) || (c.phone_nos || [])[0] || {}).wa_phone_e164;
							return { value: c.name, label: c.full_name || c.name, description: phone ? whatsapp.ui.phone(phone) : c.name };
						})
					)
				)
				.catch((err) => set_error((err && err.message) || __("Could not search contacts.")));
		}, 250);
		dialog.fields_dict.contact.$input.on("input focus", (e) => contact_search(e.target.value));
		dialog.show();
		return dialog;
	}

	/**
	 * "Fetch from WhatsApp": pick a device, then `numbers.sync_from_device` fetches its address book
	 * in a job — a number already here is updated, a new one is added, and one a system contact
	 * already carries is linked to it. The counts come back on `wa:numbers:synced`.
	 */
	async function sync_from_whatsapp(listview) {
		let devices;
		try {
			devices = await whatsapp.ui.call("numbers.list_sync_devices", {});
		} catch (err) {
			return whatsapp.ui.Toast.error(err);
		}
		if (!devices || !devices.length) {
			return whatsapp.ui.Toast.warning(__("No device is registered on the platform yet. Link a device first."));
		}
		// an <option> holds text only, so the number is kept left-to-right with Unicode isolates
		// (LRI … PDI); in an Arabic line its groups otherwise came out in reverse order
		const label = (d) =>
			[d.device_name || d.name, d.phone ? whatsapp.ui.phone(d.phone) : null, d.status !== "Connected" ? __(d.status) : null].filter(Boolean).join(" · ");
		const when = (d) => (d.synced_at ? __("Last fetched {0}", [frappe.datetime.prettyDate(d.synced_at)]) : __("Never fetched from this device"));
		const dialog = new frappe.ui.Dialog({
			title: __("Fetch contacts from WhatsApp"),
			fields: [
				{
					fieldtype: "HTML",
					fieldname: "intro",
					options: `<p class="text-muted">${frappe.utils.escape_html(
						__("The contacts saved on the device's phone are brought into this list: a number already here gets the name it is saved under, a new one is added, and one that a system contact already carries is linked to it. Messages and links you made are kept.")
					)}</p>`,
				},
				{
					fieldtype: "Select",
					fieldname: "device",
					label: __("Device"),
					reqd: 1,
					options: devices.map((d) => ({ value: d.name, label: label(d) })),
					default: devices[0].name,
					description: when(devices[0]),
					onchange() {
						const d = devices.find((x) => x.name === dialog.get_value("device"));
						dialog.set_df_property("device", "description", d ? when(d) : "");
					},
				},
			],
			primary_action_label: __("Fetch"),
			primary_action: async ({ device }) => {
				const d = devices.find((x) => x.name === device);
				if (d && d.status !== "Connected") {
					return whatsapp.ui.Toast.warning(__("{0} is not connected. Connect it first, then fetch.", [d.device_name || d.name]));
				}
				dialog.get_primary_btn().prop("disabled", true);
				try {
					await whatsapp.ui.call("numbers.sync_from_device", { device });
					dialog.hide();
					whatsapp.ui.Toast.info(__("Fetching the contacts of {0}… you will be told when it is done.", [(d && d.device_name) || device]));
					watch_sync(listview, device);
				} catch (err) {
					dialog.get_primary_btn().prop("disabled", false);
					whatsapp.ui.Toast.error(err);
				}
			},
		});
		dialog.show();
	}

	/**
	 * The job's answer reaches the page through the `wa:numbers:synced` event. Pages never ask the
	 * server on a timer (owner: webhook + realtime, no polling): a page that may have missed the
	 * event — its realtime connection came back, or the tab was in the background — asks
	 * `numbers.get_sync_state` once at that moment, and once more after ten minutes before saying
	 * the fetch is taking long. Whichever answer comes first is shown, once.
	 */
	function watch_sync(listview, device) {
		const run = (listview._wa_sync_run = { device, shown: false });
		const live = () => !run.shown && listview._wa_sync_run === run;
		const ask = () => {
			if (!live()) return Promise.resolve(null);
			return whatsapp.ui
				.call("numbers.get_sync_state", { device }, { silent: true })
				.then((state) => {
					if (!live()) return null;
					if (state.status === "done") show_sync_result(listview, Object.assign({ device }, state.stats));
					else if (state.status === "failed") show_sync_result(listview, { device, error: state.error });
					return state;
				})
				.catch(() => null);
		};
		const on_visible = () => document.visibilityState === "visible" && ask();
		const socket = frappe.realtime && frappe.realtime.socket;
		const stop = () => {
			document.removeEventListener("visibilitychange", on_visible);
			socket && socket.off && socket.off("connect", ask);
		};
		document.addEventListener("visibilitychange", on_visible);
		socket && socket.on && socket.on("connect", ask);
		run.stop = stop;
		window.setTimeout(() => {
			ask().then((state) => {
				if (live() && state && state.status !== "done" && state.status !== "failed")
					whatsapp.ui.Toast.warning(__("The fetch is taking long. Refresh the list later to see the numbers."));
				stop();
			});
		}, 10 * 60 * 1000);
	}

	function show_sync_result(listview, data) {
		const run = listview._wa_sync_run;
		if (run) {
			if (run.shown) return;
			run.shown = true;
			run.stop && run.stop();
		}
		if (data.error) {
			whatsapp.ui.Toast.error(__("Fetching the contacts failed: {0}", [data.error]));
			return;
		}
		const n = (v) => whatsapp.ui.format_int(v || 0);
		// one sentence with its own context: Frappe's own "{0} added" / "{0} updated" would win otherwise
		whatsapp.ui.Toast.success(
			__("{0} contacts and {4} groups fetched: {1} added, {2} updated, {3} linked to a contact.", [n(data.fetched), n(data.added), n(data.updated), n(data.linked), n(data.groups)], "Numbers sync")
		);
		if (data.link_skipped) whatsapp.ui.Toast.warning(__("{0} matching contacts were not linked: you may not edit contacts.", [whatsapp.ui.format_int(data.link_skipped)]));
		listview._whatsapp_header && listview._whatsapp_header.refresh(true);
		// show what was just fetched: a filter left on (a "last 7 days" on the last message) would
		// hide every address-book number, since none has exchanged a message yet
		const bar = listview._whatsapp_filterbar;
		if (bar && data.device && (data.added || data.updated || data.unchanged)) {
			bar.clear().then(() => bar.set_filter_value("synced_device", data.device));
		} else {
			listview.refresh();
		}
	}

	/** Once per list: the realtime answer, when the connection is up. */
	function listen_for_sync(listview) {
		if (listview._wa_sync_listening) return;
		listview._wa_sync_listening = true;
		frappe.realtime.on("wa:numbers:synced", (data) => show_sync_result(listview, data));
	}

	Object.assign(whatsapp_next.numbers, { open_conversation, quick_send, confirm_conversation, unlink_number, link_convert_dialog, sync_from_whatsapp, listen_for_sync });
})();

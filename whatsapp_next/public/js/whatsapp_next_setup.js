// whatsapp_next kit configuration — the only place kit components learn this app's API paths
// (backend-plan §4, D-031). Kit code refers to keys ("messages.get_conversation"); this map
// resolves them to dotted methods, so the kit folder stays free of `whatsapp_next` references.

const V1 = "whatsapp_next.api.v1";

const api = {};
const areas = {
	settings: ["get_settings", "save_settings", "get_main_menu", "save_main_menu", "get_whatsapp_link", "test_connection", "sync_subscription", "get_usage", "get_site_usage", "setup_webhook", "set_webhook_status", "set_webhook_events", "rotate_webhook_secret", "test_webhook", "list_webhook_events_available", "list_audit_log", "list_picker_sources", "get_doctype_fields", "list_picker_candidates", "analyze_picker_doctype", "preview_picker_source", "export_backup", "preview_backup", "import_backup"],
	onboarding: ["sign_out", "get_status", "start_signup", "get_signup_status", "verify_code", "complete_signup", "start_password_reset", "get_password_reset_status", "finish_password_reset", "save_credentials", "complete_setup", "login", "validate_coupon", "get_referral_coupon", "get_signup_bootstrap", "get_account_switch", "resolve_account_switch"],
	home: ["get_dashboard", "get_activity"],
	devices: ["list_devices", "import_history", "get_history_status", "create_device", "start_pairing", "poll_status", "disconnect_device", "delete_device", "update_device", "set_default", "set_disabled", "get_device_stats", "get_device_impact"],
	quick_send: ["get_context", "preview", "send"],
	number_check: ["check_selection", "refresh_profiles"],
	status_posts: ["post_now", "schedule", "unschedule", "delete_post", "refresh_views"],
	wa_groups: ["members_from", "create_group"],
	messages: ["fetch_media", "get_outbound", "get_inbound", "get_inbound_summary", "get_conversation", "resend", "resend_many", "cancel", "get_poll_results", "get_poll_summary"],
	simulator: ["get_context", "simulate_inbound", "send_test", "dry_run_command", "list_conversations", "get_identity"],
	bulk_send: ["get_context", "estimate", "search_contacts", "send"],
	queue: ["list_queue", "get_summary", "get_limits", "get_throughput", "pause_queue", "resume_queue", "set_rate", "pause_items", "resume_items", "delete_items", "retry_dead_letter"],
	campaigns: ["start", "schedule", "get_overview", "unschedule", "pause", "resume", "cancel", "pause_many", "resume_many", "cancel_many", "get_progress", "get_sending_now", "get_recipients_page", "preview_message", "get_poll_results", "get_readiness", "get_failures", "get_message_stats", "get_timeline", "retry_failed"],
	picker: ["list_sources", "search_groups", "get_group_members", "search_contacts", "search_whatsapp_numbers", "list_doctype_rows", "parse_upload", "parse_manual", "preview", "classify", "commit_add", "commit_remove"],
	contacts: ["list_contacts", "get_stats", "get_contact", "create_contact", "update_contact", "search_party", "search_company", "get_activity", "toggle_blacklist", "get_contact_numbers", "link_many", "unlink_account"],
	numbers: ["get_number", "link_number", "convert_number", "convert_many", "unlink_number", "confirm_conversation", "search_numbers", "get_conversation_log", "list_sync_devices", "sync_from_device", "get_sync_state"],
	templates: ["preview", "list_variables", "pick_sample", "get_editor", "save_editor", "delete_template"],
	groups: ["get_editor", "save_editor"],
	notifications: ["preview", "get_document_fields", "send_now", "get_editor", "get_document_setup", "preview_draft", "send_test", "save_editor", "delete_notification", "search"],
	alerts: ["preview", "run_now", "get_report_columns", "get_dynamic_filter_reference", "get_editor", "preview_draft", "send_test", "save_editor", "set_enabled", "delete_alert", "search", "get_report_info"],
	functions: ["get_catalog", "get_manifest", "preview_install", "install", "update", "update_many", "remove", "set_status", "set_status_many", "save_values", "try_function", "check_updates"],
	commands: ["list_commands", "get_defaults", "save_command", "set_status", "set_status_many", "restore_defaults", "test_command", "get_editor", "get_function_spec", "save_editor", "preview_command", "delete_command", "search_groups", "search_contacts"],
	testlab: ["get_context", "get_health", "identify", "search_documents", "preview", "start_run", "run_check", "get_status", "list_runs"],
	// the calling regions, out of the library the server validates with
	phone: ["get_countries"],
};
Object.entries(areas).forEach(([area, fns]) => fns.forEach((fn) => (api[`${area}.${fn}`] = `${V1}.${area}.${fn}`)));

sanad.ui.configure({
	api,
	defaults: {
		roles: {
			quick_send: ["WhatsApp Agent", "WhatsApp Manager", "System Manager"],
			confirm: ["WhatsApp Agent", "WhatsApp Manager", "System Manager"],
		},
		// The prototype's phone field opens on Saudi Arabia (+966). The site's own country setting
		// would otherwise decide it, and this product's numbers are Saudi by default.
		country: "SA",
		group_doctype: "WhatsApp Contact Group",
		contact_link_doctypes: ["Customer", "Supplier", "Employee"],
		simulator_route: "wa-simulator",
		devices_route: "wa-devices",
		contacts_route: "wa-contacts",
	},

	// How this app's records look wherever the kit draws them — a list cell, a drawer identity,
	// a picker row, a card. `doctypes` picks the renderer family, `profiles` says which field
	// plays which part; everything not named here is read from the DocType's own meta.
	renderers: {
		doctypes: {
			"WhatsApp Log": "document",
			"WhatsApp Inbound Message": "document",
			"WhatsApp Queue Item": "document",
			"WhatsApp Campaign": "document",
			"WhatsApp Number": "person",
			"WhatsApp Contact Group": "generic",
			"WhatsApp Device": "generic",
			"WhatsApp Template": "generic",
			"WhatsApp Command": "generic",
		},
		profiles: {
			// A message is known by who it went to, not by its hash of a name.
			"WhatsApp Log": {
				icon: "es-line-chat",
				title: { field: "display_name", value: (doc) => doc.display_name || sanad.ui.phone(doc.phone_e164 || doc.jid || doc.name) },
				title_ltr: false,
				lines: [{ field: "phone_e164", ltr: true, icon: "es-line-call" }],
				value: false,
			},
			"WhatsApp Inbound Message": {
				icon: "es-line-chat-alt",
				title: { field: "display_name", value: (doc) => doc.display_name || sanad.ui.phone(doc.phone_e164 || doc.jid || doc.name) },
				lines: [{ field: "phone_e164", ltr: true, icon: "es-line-call" }],
				value: false,
			},
			"WhatsApp Number": {
				icon: "es-line-call",
				title: { field: "display_name", value: (doc) => doc.display_name || sanad.ui.phone(doc.phone_e164 || doc.name) },
				lines: [{ field: "phone_e164", ltr: true }, "link_status"],
				value: false,
			},
			"WhatsApp Device": {
				icon: "es-line-laptop",
				title: { field: "device_name", value: (doc) => doc.device_name || doc.name },
				lines: ["phone_e164"],
				value: false,
			},
			"WhatsApp Campaign": {
				icon: "es-line-plan",
				title: { field: "campaign_name", value: (doc) => doc.campaign_name || doc.name },
				progress: "progress",
				value: false,
			},
			"WhatsApp Contact Group": {
				icon: "es-line-group",
				title: { field: "group_name", value: (doc) => doc.group_name || doc.name },
				value: "member_count",
			},
			"WhatsApp Template": { icon: "es-line-template", title: { field: "template_name", value: (doc) => doc.template_name || doc.name }, value: false },
			"WhatsApp Command": { icon: "es-line-zap", title: { field: "keyword", value: (doc) => doc.keyword || doc.name }, value: false },
			Contact: {
				lines: [{ field: "mobile_no", ltr: true, icon: "es-line-call" }, { field: "email_id", ltr: true, icon: "es-line-email" }],
			},
		},
	},
});

frappe.provide("whatsapp_next");
whatsapp_next.api = api;

// A Link to a doctype that shows its title in links (Contact) makes Desk join its title
// (`contact.full_name`) into the list query, and the joined doctype's read restrictions then
// filter the whole list. The product's roles read Contact only as its owner (the `All` role's
// if-owner rule; spec §4), so the join added "contact owner = me" and WhatsApp Log, Inbound and
// Numbers came back empty. Drop only the joins the reader cannot read without such a rule; the
// cell then shows the linked name itself.
whatsapp_next.drop_unreadable_link_titles = (listview) => {
	const get_fields = listview.get_fields.bind(listview);
	listview.get_fields = () => {
		const titles = listview.link_field_title_fields || {};
		Object.keys(titles).forEach((fieldname) => {
			const df = frappe.meta.get_docfield(listview.doctype, fieldname);
			if (df && df.options && (!frappe.model.can_read(df.options) || frappe.perm.get_match_rules(df.options).length)) delete titles[fieldname];
		});
		return get_fields();
	};
};

// Creating WhatsApp groups (sanad.ui.GroupCreate): a Manager's verb, offered only when the plan
// includes groups. Every screen that offers it asks here, so the rule lives in one place.
whatsapp_next.wa_groups = {
	can_create: () =>
		!!(((frappe.boot.whatsapp_next || {}).features || {}).groups) &&
		frappe.user.has_role(["WhatsApp Manager", "System Manager"]) &&
		typeof sanad.ui.GroupCreate === "function",
	open: (opts) => new sanad.ui.GroupCreate(opts || {}),
};

// "Check on WhatsApp": the numbers behind a selection of contacts, contact groups or WhatsApp
// Numbers, asked through a connected device; the answer is shown and remembered (number_check).
whatsapp_next.check_numbers = (source_doctype, names, { on_done } = {}) =>
	sanad.ui
		.call("number_check.check_selection", { source_doctype, names }, { freeze: true, freeze_message: __("Checking the numbers with WhatsApp…") })
		.then((r) => {
			const esc = frappe.utils.escape_html;
			const rows = (r.results || [])
				.map((m) => `<li><span class="sanad-groupcreate__name">${esc(m.display_name || "")}</span>
					<bdi class="sanad-tabular" dir="ltr">${esc(sanad.ui.phone ? sanad.ui.phone(m.phone_e164) : m.phone_e164)}</bdi>
					${sanad.ui.StatusBadge.html(m.on_whatsapp ? { label: __("Registered on WhatsApp"), colour: "green" } : { label: __("Not on WhatsApp"), colour: "gray" })}</li>`)
				.join("");
			const d = new frappe.ui.Dialog({
				title: __("WhatsApp check"),
				size: "large",
				fields: [{ fieldtype: "HTML", fieldname: "body" }],
				primary_action_label: __("Done"),
				primary_action: () => d.hide(),
			});
			d.$wrapper.addClass("sanad-kit sanad-sheet sanad-groupcreate");
			d.get_field("body").$wrapper.html(
				r.checked
					? `<p>${esc(__("{0} of {1} numbers are on WhatsApp.", [r.on_whatsapp, r.checked]))}</p><ul class="sanad-groupcreate__list">${rows}</ul>`
					: `<p>${esc(__("The selection has no individual numbers to check."))}</p>`
			);
			d.show();
			if (on_done) on_done(r);
			return r;
		})
		.catch((err) => sanad.ui.Toast.error(err));

// "Refresh WhatsApp profile": photo, about and business details of the numbers behind a selection.
whatsapp_next.refresh_profiles = (source_doctype, names, { on_done } = {}) =>
	sanad.ui
		.call("number_check.refresh_profiles", { source_doctype, names }, { freeze: true, freeze_message: __("Reading the WhatsApp profiles…") })
		.then((r) => {
			sanad.ui.Toast.success(__("{0} profiles read, {1} new photos", [r.updated || 0, r.photos || 0]));
			if (on_done) on_done(r);
			return r;
		})
		.catch((err) => sanad.ui.Toast.error(err));

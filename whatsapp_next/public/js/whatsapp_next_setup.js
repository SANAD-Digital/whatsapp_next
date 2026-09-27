// whatsapp_next kit configuration — the only place kit components learn this app's API paths
// (backend-plan §4, D-031). Kit code refers to keys ("messages.get_conversation"); this map
// resolves them to dotted methods, so the kit folder stays free of `whatsapp_next` references.

const V1 = "whatsapp_next.api.v1";

const api = {};
const areas = {
	settings: ["get_settings", "save_settings", "test_connection", "sync_subscription", "get_usage", "setup_webhook", "set_webhook_status", "set_webhook_events", "rotate_webhook_secret", "test_webhook", "list_webhook_events_available", "list_audit_log", "list_picker_sources", "get_doctype_fields"],
	onboarding: ["get_status", "start_signup", "get_signup_status", "complete_signup", "start_password_reset", "save_credentials", "complete_setup", "login", "validate_coupon", "get_referral_coupon", "get_signup_bootstrap"],
	home: ["get_dashboard", "get_activity"],
	devices: ["list_devices", "create_device", "start_pairing", "poll_status", "disconnect_device", "delete_device", "update_device", "set_default", "set_disabled", "get_device_stats"],
	quick_send: ["get_context", "preview", "send"],
	messages: ["get_outbound", "get_inbound", "get_inbound_summary", "get_conversation", "resend", "resend_many", "cancel"],
	simulator: ["get_context", "simulate_inbound", "send_test", "dry_run_command"],
	queue: ["list_queue", "get_summary", "get_limits", "get_throughput", "pause_queue", "resume_queue", "set_rate", "pause_items", "resume_items", "delete_items", "retry_dead_letter"],
	campaigns: ["start", "schedule", "get_overview", "unschedule", "pause", "resume", "cancel", "pause_many", "resume_many", "cancel_many", "get_progress", "get_sending_now", "get_recipients_page", "preview_message", "get_poll_results", "get_readiness", "get_failures", "get_message_stats", "get_timeline", "retry_failed"],
	picker: ["list_sources", "search_groups", "get_group_members", "search_contacts", "list_doctype_rows", "parse_upload", "parse_manual", "preview", "commit_add", "commit_remove"],
	contacts: ["list_contacts", "get_stats", "get_contact", "create_contact", "update_contact", "search_party", "search_company", "get_activity", "toggle_blacklist", "get_contact_numbers", "link_many"],
	numbers: ["get_number", "link_number", "convert_number", "convert_many", "unlink_number", "confirm_conversation", "search_numbers", "get_conversation_log"],
	templates: ["preview", "list_variables", "pick_sample"],
	notifications: ["preview", "get_document_fields", "send_now"],
	alerts: ["preview", "run_now", "get_report_columns", "get_dynamic_filter_reference"],
	functions: ["get_catalog", "get_manifest", "preview_install", "install", "update", "update_many", "remove", "set_status", "set_status_many", "save_settings"],
	commands: ["list_commands", "get_defaults", "save_command", "set_status", "set_status_many", "restore_defaults", "test_command", "get_editor", "get_function_spec", "save_editor", "preview_command", "delete_command", "search_groups", "search_contacts"],
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
				title: { field: "display_name", value: (doc) => doc.display_name || doc.phone_e164 || doc.jid || doc.name },
				title_ltr: false,
				lines: [{ field: "phone_e164", ltr: true, icon: "es-line-call" }],
				value: false,
			},
			"WhatsApp Inbound Message": {
				icon: "es-line-chat-alt",
				title: { field: "display_name", value: (doc) => doc.display_name || doc.phone_e164 || doc.jid || doc.name },
				lines: [{ field: "phone_e164", ltr: true, icon: "es-line-call" }],
				value: false,
			},
			"WhatsApp Number": {
				icon: "es-line-call",
				title: { field: "display_name", value: (doc) => doc.display_name || doc.phone_e164 || doc.name },
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

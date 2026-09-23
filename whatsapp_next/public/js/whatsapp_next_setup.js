// whatsapp_next kit configuration — the only place kit components learn this app's API paths
// (backend-plan §4, D-031). Kit code refers to keys ("messages.get_conversation"); this map
// resolves them to dotted methods, so the kit folder stays free of `whatsapp_next` references.

const V1 = "whatsapp_next.api.v1";

const api = {};
const areas = {
	settings: ["get_settings", "save_settings", "test_connection", "sync_subscription", "get_usage", "setup_webhook", "set_webhook_status", "set_webhook_events", "rotate_webhook_secret", "test_webhook", "list_webhook_events_available", "list_audit_log", "list_picker_sources", "get_doctype_fields"],
	onboarding: ["get_status", "start_signup", "get_signup_status", "complete_signup", "start_password_reset", "save_credentials", "complete_setup"],
	home: ["get_dashboard"],
	devices: ["list_devices", "create_device", "start_pairing", "poll_status", "disconnect_device", "delete_device", "update_device", "set_default", "set_disabled", "get_device_stats"],
	quick_send: ["get_context", "preview", "send"],
	messages: ["get_outbound", "get_inbound", "get_conversation", "resend", "resend_many", "cancel"],
	simulator: ["get_context", "simulate_inbound", "send_test", "dry_run_command"],
	queue: ["list_queue", "get_summary", "pause_queue", "resume_queue", "set_rate", "pause_items", "resume_items", "delete_items", "retry_dead_letter"],
	campaigns: ["start", "schedule", "unschedule", "pause", "resume", "cancel", "pause_many", "resume_many", "cancel_many", "get_progress", "get_sending_now", "get_recipients_page", "preview_message", "get_poll_results"],
	picker: ["list_sources", "search_groups", "get_group_members", "search_contacts", "list_doctype_rows", "parse_upload", "parse_manual", "preview", "commit_add", "commit_remove"],
	contacts: ["list_contacts", "get_contact", "create_contact", "update_contact", "search_party", "toggle_blacklist", "get_contact_numbers", "link_many"],
	numbers: ["get_number", "link_number", "convert_number", "convert_many", "unlink_number", "confirm_conversation", "search_numbers"],
	templates: ["preview", "list_variables", "pick_sample"],
	notifications: ["preview", "get_document_fields", "send_now"],
	alerts: ["preview", "run_now", "get_report_columns", "get_dynamic_filter_reference"],
	functions: ["get_catalog", "preview_install", "install", "update", "update_many", "remove", "set_status", "set_status_many", "save_settings"],
	commands: ["list_commands", "get_defaults", "save_command", "set_status", "set_status_many", "restore_defaults", "test_command"],
};
Object.entries(areas).forEach(([area, fns]) => fns.forEach((fn) => (api[`${area}.${fn}`] = `${V1}.${area}.${fn}`)));

sanad.ui.configure({
	api,
	defaults: {
		roles: {
			quick_send: ["WhatsApp Agent", "WhatsApp Manager", "System Manager"],
			confirm: ["WhatsApp Agent", "WhatsApp Manager", "System Manager"],
		},
		group_doctype: "WhatsApp Contact Group",
		contact_link_doctypes: ["Customer", "Supplier", "Employee"],
		simulator_route: "wa-simulator",
		devices_route: "wa-devices",
		contacts_route: "wa-contacts",
	},
});

frappe.provide("whatsapp_next");
whatsapp_next.api = api;

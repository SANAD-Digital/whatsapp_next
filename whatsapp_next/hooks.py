# Module role: Frappe app hooks for whatsapp_next — provider registry, fixtures, doc events,
# install/migrate hooks. Scheduler entries are registered in phase 4 (build order B-17) once the
# services exist; nothing here references a function that does not exist yet.

app_name = "whatsapp_next"
app_title = "WhatsApp Next"
app_publisher = "Sanad Digital"
app_description = "WhatsApp integration for ERPNext built on a provider abstraction (SND Platform first)"
app_email = "sanad@digital.info"
app_license = "mit"

required_apps = ["frappe", "erpnext"]

# Provider registry (architecture.md) — nothing outside providers/ imports a provider module.
whatsapp_providers = {
	"snd_platform": "whatsapp_next.providers.snd_platform.SndPlatformProvider",
	"meta_cloud": "whatsapp_next.providers.meta_cloud.MetaCloudProvider",
}

# Function catalogs (backend-plan §13); other apps may append their own dotted module path.
whatsapp_function_catalogs = ["whatsapp_next.functions.catalog"]

# Installation / migration
after_install = "whatsapp_next.install.after_install"
after_migrate = "whatsapp_next.install.after_migrate"

# Fixtures: the four product roles and the single custom field on a core DocType (D-028).
fixtures = [
	{
		"dt": "Role",
		"filters": [
			[
				"name",
				"in",
				["WhatsApp Manager", "WhatsApp Agent", "WhatsApp Viewer", "WhatsApp Contact User"],
			]
		],
	},
	{"dt": "Custom Field", "filters": [["name", "in", ["Contact Phone-wa_phone_e164"]]]},
	# Dashboard sources for the DashboardBlock (phase 5): created on the site, exported here. The
	# "WhatsApp" Workspace is a module document (whatsapp_next/workspace/whatsapp/) — a public
	# module workspace shipped only as a fixture is deleted by migrate's orphan-entity sweep.
	{"dt": "Number Card", "filters": [["name", "like", "WA %"]]},
	{"dt": "Dashboard Chart", "filters": [["name", "like", "WA %"]]},
	{"dt": "Custom HTML Block", "filters": [["name", "like", "WA %"]]},
]

# Document events.
# - Contact.validate keeps Contact Phone.wa_phone_e164 normalized (D-028).
# - "*" events feed WhatsApp Notification (D-016); the handler short-circuits per DocType via cache
#   and is a no-op until phase 4 (backend-plan §11).
# - Message tables enqueue the Numbers incremental upsert (architecture.md); no-op until phase 4.
doc_events = {
	"Contact": {
		"validate": "whatsapp_next.services.phone.sync_contact_phones",
	},
	"*": {
		"validate": "whatsapp_next.services.notifications.on_doc_event",
		"on_update": "whatsapp_next.services.notifications.on_doc_event",
		"on_submit": "whatsapp_next.services.notifications.on_doc_event",
		"on_cancel": "whatsapp_next.services.notifications.on_doc_event",
		"after_insert": "whatsapp_next.services.notifications.on_doc_event",
		"on_change": "whatsapp_next.services.notifications.on_doc_event",
	},
	"WhatsApp Log": {
		"after_insert": "whatsapp_next.services.numbers_materializer.on_message_insert",
	},
	"WhatsApp Inbound Message": {
		"after_insert": "whatsapp_next.services.numbers_materializer.on_message_insert",
	},
}

# Log / derived tables must never pin a Device, Contact, Campaign or Outbound row against deletion
# (backend-plan §13): message history and the materialized Numbers table keep dangling links.
ignore_links_on_delete = [
	"WhatsApp Webhook Event",
	"WhatsApp Queue Item",
	"WhatsApp Audit Log",
	"WhatsApp Log",
	"WhatsApp Inbound Message",
	"WhatsApp Number",
]

# Scheduler events are added in phase 4 (B-17) together with the services they call.
scheduler_events = {
	# backend-plan §5.2 — every job is idempotent and dedup-guarded by its own job_id
	"cron": {
		"* * * * *": [
			"whatsapp_next.services.dispatch.dispatch_tick",
			"whatsapp_next.services.campaign_runner.promote_scheduled",
		],
		"*/5 * * * *": [
			"whatsapp_next.services.reconcile.reconcile_statuses",
			"whatsapp_next.services.notifications.trigger_offset",
		],
		"*/10 * * * *": ["whatsapp_next.webhooks.handlers.reprocess_failed"],
		"*/15 * * * *": ["whatsapp_next.services.alerts.run_due_alerts"],
		"30 2 * * *": ["whatsapp_next.services.numbers_materializer.nightly_reconcile"],
		"0 3 * * *": ["whatsapp_next.services.retention.purge"],
	},
	"hourly": [
		"whatsapp_next.services.devices.sync_from_provider",
		"whatsapp_next.services.usage_sync.sync_subscription",
		"whatsapp_next.services.webhook_setup.sync_status",
	],
	"daily": [
		"whatsapp_next.services.notifications.trigger_daily",
		"whatsapp_next.services.functions_catalog.check_updates",
	],
}


# Desk assets (phase 5): the portable kit (`public/js/ui/`, namespace `sanad.ui`) plus the app
# setup that maps kit API keys to `whatsapp_next.api.v1.*` (D-031). Per-DocType list/form scripts
# are registered below as they land (phase 5 live uses, phase 7 customisation).
app_include_js = ["whatsapp_next.bundle.js"]
app_include_css = ["whatsapp_next.bundle.css"]
doctype_js = {
	"WhatsApp Log": "public/js/form/whatsapp_log.js",
	"WhatsApp Campaign": "public/js/form/whatsapp_campaign.js",
	"WhatsApp Contact Group": "public/js/form/whatsapp_contact_group.js",
	"WhatsApp Command": "public/js/form/whatsapp_command.js",
	"WhatsApp Template": "public/js/form/whatsapp_template.js",
	"WhatsApp Number": "public/js/form/whatsapp_number.js",
	"WhatsApp Notification": "public/js/form/whatsapp_notification.js",
	"WhatsApp Notification Alert": "public/js/form/whatsapp_notification_alert.js",
	"WhatsApp Device": "public/js/form/whatsapp_device.js",
	"WhatsApp Inbound Message": "public/js/form/whatsapp_inbound_message.js",
	"WhatsApp Function": "public/js/form/whatsapp_function.js",
}
doctype_list_js = {
	"WhatsApp Log": "public/js/listview/whatsapp_log_list.js",
	"WhatsApp Inbound Message": "public/js/listview/whatsapp_inbound_message_list.js",
	"WhatsApp Number": "public/js/listview/whatsapp_number_list.js",
	"WhatsApp Campaign": "public/js/listview/whatsapp_campaign_list.js",
	"WhatsApp Contact Group": "public/js/listview/whatsapp_contact_group_list.js",
	"WhatsApp Command": "public/js/listview/whatsapp_command_list.js",
	"WhatsApp Queue Item": "public/js/listview/whatsapp_queue_item_list.js",
	"WhatsApp Template": "public/js/listview/whatsapp_template_list.js",
	"WhatsApp Notification": "public/js/listview/whatsapp_notification_list.js",
	"WhatsApp Notification Alert": "public/js/listview/whatsapp_notification_alert_list.js",
	"WhatsApp Device": "public/js/listview/whatsapp_device_list.js",
	"WhatsApp Function": "public/js/listview/whatsapp_function_list.js",
}

# Translation
ignore_translatable_strings_from = []

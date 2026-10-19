# Module role: Frappe app hooks for whatsapp_next — provider registry, fixtures, doc events,
# install/migrate hooks. Scheduler entries are registered in phase 4 (build order B-17) once the
# services exist; nothing here references a function that does not exist yet.

app_name = "whatsapp_next"
app_title = "WhatsappNext"
app_publisher = "Sanad Digital"
app_description = "WhatsApp integration for ERPNext built on a provider abstraction (SND Platform first)"
app_email = "sanad@digital.info"
app_license = "mit"

required_apps = ["frappe"]

# The app's tile on the Desk desktop is a file: `whatsapp_next/desktop_icon/whatsapp.json` (a
# standard Desktop Icon that opens the WhatsApp sidebar; the sidebar header draws its `logo_url`).
# `add_to_apps_screen` is off: with it Frappe adds an App icon of its own at install — a second
# tile for the same product. Switching it back on needs that icon shipped as a file too.
app_home = "/app/wa-home"
app_logo_url = "/assets/whatsapp_next/images/whatsapp-next-icon.svg"
# add_to_apps_screen = [
# 	{
# 		"name": app_name,
# 		"logo": app_logo_url,
# 		"title": app_title,
# 		"route": app_home,
# 		"has_permission": "whatsapp_next.install.has_app_permission",
# 	}
# ]

# Provider registry (architecture.md) — nothing outside providers/ imports a provider module.
whatsapp_providers = {
	"snd_platform": "whatsapp_next.providers.snd_platform.SndPlatformProvider",
	"meta_cloud": "whatsapp_next.providers.meta_cloud.MetaCloudProvider",
}

# Functions are Server Scripts (API, method `wa_fn_…`) with a WA-FUNCTION header
# (services/functions_catalog.py); a saved or deleted script drops the read cache.

# Installation / migration
after_install = "whatsapp_next.install.after_install"
after_migrate = "whatsapp_next.install.after_migrate"
before_uninstall = "whatsapp_next.install.before_uninstall"

# Desk boot: `frappe.boot.whatsapp_next.setup_redirect` drives Home → Onboarding Wizard (spec #1).
boot_session = "whatsapp_next.boot.boot_session"

# Fixtures: only what Frappe has no folder of its own for — the four product roles, one Custom HTML
# Block and the standard content. Everything else is a file in the folder Frappe syncs it from
# (the list is at the top of `install.py`); customizations of core DocTypes live in
# `whatsapp_next/custom/<doctype>.json` (`Contact Phone.wa_phone_e164`, D-028).
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
	# The HTML block of the DashboardBlock (phase 5). Custom HTML Block has no module folder in
	# Frappe, so it is a fixture; the Number Cards and Dashboard Charts it draws are standard
	# module documents (`whatsapp_next/{number_card,dashboard_chart}/`, synced by `sync_dashboards`),
	# as the Workspace is (`whatsapp_next/workspace/whatsapp/`).
	{"dt": "Custom HTML Block", "filters": [["name", "like", "WA %"]]},
	# Standard content (developer-docs/standard-content.md): Arabic templates, notifications and
	# report alerts for a trading company on ERPNext. Notifications and alerts ship switched off.
	# The names are the records' identity for good — never rename one. `services/standards.py`
	# decides what a sync may change on a site (the owner's on/off, device, recipients and edits
	# survive every migrate). The `prefix` orders the files: templates before what links to them.
	# Keep these three last: Frappe's export carries a prefix over to the entries after it.
	# Do not run `bench export-fixtures` on a site in use: it would write that site's state
	# (enabled, device, recipients, counters) into the files — `tests/test_standards.py` fails then.
	{
		"dt": "WhatsApp Template",
		"prefix": "standard_1",
		"filters": [
			[
				"name",
				"in",
				[
					"إشعار فاتورة مبيعات",
					"إشعار سند قبض",
					"شكر على سداد فاتورة",
					"تذكير قبل استحقاق فاتورة",
					"تذكير بفاتورة متأخرة",
					"تأكيد طلب بيع",
					"تذكير بموعد تسليم طلب",
					"إشعار تسليم بضاعة",
					"عرض سعر",
					"أمر شراء للمورد",
					"رسالة ترحيب",
					"عرض ترويجي",
				],
			]
		],
	},
	{
		"dt": "WhatsApp Notification",
		"prefix": "standard_2",
		"filters": [
			[
				"name",
				"in",
				[
					"فاتورة مبيعات عند الاعتماد",
					"سند قبض عند الاعتماد",
					"شكر عند سداد الفاتورة كاملة",
					"تذكير قبل استحقاق الفاتورة",
					"تذكير بعد استحقاق الفاتورة",
					"تأكيد طلب بيع عند الاعتماد",
					"تذكير قبل تسليم الطلب",
					"إشعار تسليم عند الاعتماد",
					"عرض سعر عند الاعتماد",
					"أمر شراء للمورد عند الاعتماد",
				],
			]
		],
	},
	{
		"dt": "WhatsApp Notification Alert",
		"prefix": "standard_3",
		"filters": [
			[
				"name",
				"in",
				[
					"أرصدة العملاء المدينة",
					"أرصدة الموردين الدائنة",
					"ملخص المبيعات اليومي",
					"حركة الحسابات لليوم السابق",
				],
			]
		],
	},
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
		# a Method notification may pick it (the controller offers it)
		"on_update_after_submit": "whatsapp_next.services.notifications.on_doc_event",
		"after_insert": "whatsapp_next.services.notifications.on_doc_event",
		"on_change": "whatsapp_next.services.notifications.on_doc_event",
	},
	"WhatsApp Log": {
		"after_insert": "whatsapp_next.services.numbers_materializer.on_message_insert",
	},
	"WhatsApp Inbound Message": {
		"after_insert": "whatsapp_next.services.numbers_materializer.on_message_insert",
	},
	"Server Script": {
		"on_update": "whatsapp_next.services.functions_catalog.clear_cache",
		"on_trash": "whatsapp_next.services.functions_catalog.clear_cache",
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
			"whatsapp_next.services.status_posts.post_due",
		],
		"*/5 * * * *": [
			"whatsapp_next.services.reconcile.reconcile_statuses",
			"whatsapp_next.services.notifications.trigger_offset",
		],
		"*/10 * * * *": ["whatsapp_next.webhooks.handlers.reprocess_failed"],
		"*/15 * * * *": ["whatsapp_next.services.alerts.run_due_alerts"],
		"*/30 * * * *": ["whatsapp_next.services.status_posts.refresh_views"],
		"30 2 * * *": ["whatsapp_next.services.numbers_materializer.nightly_reconcile"],
		"0 3 * * *": ["whatsapp_next.services.retention.purge"],
	},
	"hourly": [
		"whatsapp_next.services.devices.sync_from_provider",
		"whatsapp_next.services.usage_sync.sync_subscription",
		"whatsapp_next.services.webhook_setup.sync_status",
		"whatsapp_next.services.history_import.catch_up",
	],
	"daily": [
		"whatsapp_next.services.contact_profiles.refresh_due",
		"whatsapp_next.services.notifications.trigger_daily",
		"whatsapp_next.services.functions_catalog.check_updates",
	],
}


# Desk assets (phase 5): the portable kit (`public/js/ui/`, namespace `sanad.ui`) plus the app
# setup that maps kit API keys to `whatsapp_next.api.v1.*` (D-031). Per-DocType list/form scripts
# are registered below as they land (phase 5 live uses, phase 7 customisation).
app_include_js = ["whatsapp_next.bundle.js"]
app_include_css = ["whatsapp_next.bundle.css"]
# Print formats: `{{ whatsapp_qr("كشف") }}` / `{{ whatsapp_link("…") }}` — a chat with the business
# number and a message typed (services/wa_links).
jinja = {
	"methods": [
		"whatsapp_next.services.wa_links.whatsapp_link",
		"whatsapp_next.services.wa_links.whatsapp_qr",
	],
}

doctype_js = {
	"Contact": "public/js/form/contact.js",
	"WhatsApp Status Post": "public/js/form/whatsapp_status_post.js",
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
	"WhatsApp Queue Item": "public/js/form/whatsapp_queue_item.js",
	"WhatsApp Settings": "public/js/form/whatsapp_settings.js",
}
doctype_list_js = {
	"WhatsApp Status Post": "public/js/listview/whatsapp_status_post_list.js",
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

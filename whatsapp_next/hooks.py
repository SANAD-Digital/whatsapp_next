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

# Log tables must never pin a Device / Campaign / Outbound row against deletion (backend-plan §13).
ignore_links_on_delete = ["WhatsApp Webhook Event", "WhatsApp Queue Item", "WhatsApp Audit Log"]

# Scheduler events are added in phase 4 (B-17) together with the services they call.
scheduler_events = {}

# Desk assets (phase 5–7): app_include_js = "whatsapp_next.bundle.js"

# Translation
ignore_translatable_strings_from = []

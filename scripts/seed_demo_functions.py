"""Demo data for the Functions Center.

Gives the storefront the life the prototype draws it with: both catalog functions installed and
active, a handful of commands bound to them, and a month of inbound messages that ran those
commands — so the readings (active, calls in 30 days, average run) and the drawer's facts and
linked commands show numbers instead of dashes.

Dev sites only — it writes real documents. Run it from the bench:

    cd /home/snd/frappe-bench
    cp apps/whatsapp_next/scripts/seed_demo_functions.py apps/whatsapp_next/whatsapp_next/_seed_f.py
    bench --site whatsapp.dev.sanad.digital execute whatsapp_next._seed_f.run
    bench --site whatsapp.dev.sanad.digital execute whatsapp_next._seed_f.clear   # to undo
    bench --site whatsapp.dev.sanad.digital execute whatsapp_next._seed_f.enable_commands  # after a test run
    rm apps/whatsapp_next/whatsapp_next/_seed_f.py

Every inbound row it creates carries `DEMOF-` in `provider_message_id` and every command it
creates carries `DEMOF-` in `description`, so `clear()` can take it all back out. The functions
themselves are left installed: they are the catalog's own, not demo data.
"""

import random

import frappe
from frappe.utils import add_to_date, now_datetime

from whatsapp_next.services import functions_catalog
from whatsapp_next.services.command_router import clear_map

random.seed(20260925)

TAG = "DEMOF-"
FUNCTIONS = {"ping": 14, "document_info": 31}  # average run in ms
COMMANDS = [
	# code, function, title, synonyms, runs in the last 30 days
	("ping", "ping", "Ping", "بنق", 38),
	("doc", "document_info", "Document status", "invoice\nstatus", 61),
	("فاتورة", "document_info", "حالة الفاتورة", "فاتورتي\nحالة الطلب", 47),
]
NAMES = [
	"أسماء السبيعي",
	"سارة القحطاني",
	"محمد العتيبي",
	"نورة الدوسري",
	"خالد الشهري",
	"ريم الغامدي",
	"عبدالله الحربي",
	"لمى الزهراني",
	"فيصل المالكي",
	"هند العنزي",
	"Omar Haddad",
	"Lina Khoury",
	"Tariq Nasser",
	"Dana Saleh",
	"Yousef Amin",
]
ARGS = ["SINV-2026-00012", "SINV-2026-00031", "SO-2026-00107", "SINV-2026-00044", ""]


def _device():
	rows = [d.name for d in frappe.get_all("WhatsApp Device", fields=["name"], limit=1)]
	if not rows:
		frappe.throw("Seed a WhatsApp Device first.")
	return rows[0]


def _install(key: str) -> None:
	if not frappe.db.exists("WhatsApp Function", key):
		functions_catalog.install(key, user="Administrator")
	frappe.db.set_value("WhatsApp Function", key, "status", "Active", update_modified=False)


def _command(code: str, function: str, title: str, synonyms: str) -> str:
	if frappe.db.exists("WhatsApp Command", code):
		frappe.db.set_value("WhatsApp Command", code, "status", "Active", update_modified=False)
		return code
	doc = frappe.new_doc("WhatsApp Command")
	doc.code = code
	doc.title = title
	doc.function = function
	doc.synonyms = synonyms
	doc.status = "Inactive"
	doc.description = f"{TAG} demo command"
	doc.insert(ignore_permissions=True)
	frappe.db.set_value("WhatsApp Command", doc.name, "status", "Active", update_modified=False)
	return doc.name


def _inbound(i: int, device: str, command: str, when) -> None:
	name = random.choice(NAMES)
	phone = "05" + str(random.randint(10000000, 99999999))
	text = (command + " " + random.choice(ARGS)).strip()
	doc = frappe.new_doc("WhatsApp Inbound Message")
	doc.device = device
	doc.phone = phone
	doc.display_name = name
	doc.message_type = "Text"
	doc.body = text
	doc.provider_message_id = f"{TAG}{i:05d}"
	doc.received_at = when
	doc.command_status = "Executed"
	doc.command = command
	doc.command_text = text
	doc.replied_at = add_to_date(when, seconds=random.randint(1, 4))
	doc.is_simulated = 1
	doc.insert(ignore_permissions=True)


def enable_commands() -> str:
	"""Turn commands on with the service user the install seeded (owner, Gate 2: "فعّل مستخدم
	خدمة الأوامر"). It is enabled with no roles — the catalog functions read through
	`frappe.db`, and Settings refuses Administrator or a System Manager (D-012)."""
	from whatsapp_next.install import ensure_command_service_user

	email = frappe.db.get_single_value("WhatsApp Settings", "command_service_user") or ensure_command_service_user()
	frappe.db.set_value("User", email, "enabled", 1)
	settings = frappe.get_single("WhatsApp Settings")
	settings.command_service_user = email
	settings.enable_commands = 1
	settings.flags.ignore_permissions = True
	settings.save(ignore_permissions=True)
	return email


def run(days: int = 30):
	"""Install and activate both catalog functions, bind three commands, seed a month of runs."""
	frappe.flags.wa_system_writer = True
	functions_catalog.clear_cache()
	enable_commands()
	device = _device()
	for key in FUNCTIONS:
		_install(key)
	clear()
	now = now_datetime()
	n = 0
	total = {k: 0 for k in FUNCTIONS}
	for code, function, title, synonyms, runs in COMMANDS:
		name = _command(code, function, title, synonyms)
		for _ in range(runs):
			n += 1
			when = add_to_date(now, hours=-random.uniform(1, days * 24))
			_inbound(n, device, name, when)
		total[function] += runs
		frappe.db.set_value(
			"WhatsApp Command", name, {"run_count": runs * 3, "last_run_at": now}, update_modified=False
		)
	for key, avg_ms in FUNCTIONS.items():
		frappe.db.set_value(
			"WhatsApp Function",
			key,
			{
				"call_count": total[key] * 3,
				"avg_ms": avg_ms,
				"error_count": 2 if key == "document_info" else 0,
				"last_called_at": now,
			},
			update_modified=False,
		)
	clear_map()
	frappe.db.commit()
	print(f"seeded {n} inbound runs over {len(COMMANDS)} commands")


def clear():
	"""Take out every seeded run and command; the functions stay installed."""
	frappe.flags.wa_system_writer = True
	for row in frappe.get_all(
		"WhatsApp Inbound Message", filters={"provider_message_id": ("like", f"{TAG}%")}, pluck="name"
	):
		frappe.delete_doc("WhatsApp Inbound Message", row, ignore_permissions=True, force=True)
	for row in frappe.get_all("WhatsApp Command", filters={"description": ("like", f"{TAG}%")}, pluck="name"):
		frappe.db.set_value("WhatsApp Command", row, "status", "Inactive", update_modified=False)
		frappe.delete_doc("WhatsApp Command", row, ignore_permissions=True, force=True)
	clear_map()
	frappe.db.commit()

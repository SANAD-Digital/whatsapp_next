"""The standard command set on the Server Script functions (WHATSAPP_NEXT_INTEGRATION §12.3 step 5).

Installs (or updates) every function script on the site (`scripts/setup_functions.py` puts the scripts
there first), then writes the eight Arabic commands below through `services.commands.save` — the same
validation and audit as the editor — and starts them. A command keeps its word, so its run history
follows it onto the new function; the old catalog functions no command uses any more are removed.
Running it again only rewrites the same values.

Customer commands require a number linked to a customer. Staff commands are gated by the
`فريق المحاسبة` group alone: they allow every party type, because a sender linked to a type the
command does not list is refused before the group is read, and a site may have no Employee at all.
`فحص` answers any sender.

`company`: the company the accounting functions read (their `company` value on the site); empty keeps
the header's default (`@default_company`).

Dev sites only — it writes real documents. Run it from the bench:

    cd /home/snd/frappe-bench
    cp apps/whatsapp_next/scripts/setup_commands.py apps/whatsapp_next/whatsapp_next/_setup_cmds.py
    bench --site whatsapp.dev.sanad.digital execute whatsapp_next._setup_cmds.run --kwargs '{"company": "SANAD Digital (Demo)"}'
    rm apps/whatsapp_next/whatsapp_next/_setup_cmds.py
"""

import frappe

from whatsapp_next.services import commands, functions_catalog

DT = "WhatsApp Command"
STAFF_GROUP = "فريق المحاسبة"
STAFF_TYPES = ["Customer", "Supplier", "Employee", "Sales Person"]

# (old name, new name): renamed with `merge` when the new one already exists
RENAMES = (("doc", "فاتورة"), ("ping", "فحص"))

# the function scripts the commands run, by the header's @function
FUNCTION_SCRIPTS = {
	"ping": "wa_fn_ping",
	"document_info": "wa_fn_document_info",
	"party_balance": "wa_fn_party_balance",
	"party_statement": "wa_fn_party_statement",
	"party_trial_balance": "wa_fn_party_trial_balance",
	"cash_bank_balances": "wa_fn_cash_bank_balances",
}
# the catalog functions of the Python handlers, removed once no command uses them
OLD_FUNCTIONS = (
	"customer_balance",
	"customer_statement",
	"customer_trial_balance",
	"supplier_trial_balance",
	"cash_balances",
	"bank_balances",
)
ACCOUNTING = ("party_balance", "party_statement", "party_trial_balance", "cash_bank_balances")

COMMANDS = (
	{
		"code": "رصيد",
		"description": "رصيد حسابك اليوم أو حتى تاريخ تحدده.",
		"title": "رصيد العميل",
		"function": "party_balance",
		"synonyms": "رصيدي\nكم علي\nbalance",
		"allowed_party_types": ["Customer"],
		"requires_linked_contact": 1,
		# the sender may name the end date; the rest is the site's
		"disabled_inputs": ["company", "fiscal_year", "account", "show_zero_values", "from_date"],
	},
	{
		"code": "كشف",
		"description": "آخر حركات حسابك خلال الأشهر الأخيرة مع الرصيد الختامي.",
		"title": "كشف حساب العميل",
		"function": "party_statement",
		"synonyms": "كشف حساب\nكشفي\nstatement",
		"allowed_party_types": ["Customer"],
		"requires_linked_contact": 1,
		"disabled_inputs": ["company", "limit", "send_pdf"],
		"ask_inputs": "months: 1=شهر, 3=3 أشهر, 6=6 أشهر, 12=سنة",
	},
	{
		"code": "فاتورة",
		"description": "حالة فاتورة أو طلب برقمه، إن كان يخص حسابك.",
		"title": "حالة الفاتورة",
		"function": "document_info",
		"synonyms": "فاتورتي\nحالة الطلب\ninvoice\ndoc",
		"allowed_party_types": ["Customer", "Supplier"],
		"requires_linked_contact": 1,
		"disabled_inputs": ["document_type", "party_field"],
	},
	{
		"code": "عملاء",
		"description": "أكبر أرصدة العملاء وإجماليها (للموظفين).",
		"title": "أرصدة العملاء",
		"function": "party_trial_balance",
		"synonyms": "أرصدة العملاء\ncustomers",
		"allowed_party_types": STAFF_TYPES,
		"allowed_group": STAFF_GROUP,
		"settings_overrides": {"party_type": "Customer"},
		"disabled_inputs": ["company"],
	},
	{
		"code": "موردين",
		"description": "أكبر أرصدة الموردين وإجماليها (للموظفين).",
		"title": "أرصدة الموردين",
		"function": "party_trial_balance",
		"synonyms": "أرصدة الموردين\nsuppliers",
		"allowed_party_types": STAFF_TYPES,
		"allowed_group": STAFF_GROUP,
		"settings_overrides": {"party_type": "Supplier"},
		"disabled_inputs": ["company"],
	},
	{
		"code": "صندوق",
		"description": "رصيد كل صندوق وإجمالي الصناديق (للموظفين).",
		"title": "أرصدة الصناديق",
		"function": "cash_bank_balances",
		"synonyms": "الصندوق\ncash",
		"allowed_party_types": STAFF_TYPES,
		"allowed_group": STAFF_GROUP,
		"settings_overrides": {"account_type": "cash"},
		"disabled_inputs": ["company"],
	},
	{
		"code": "بنك",
		"description": "رصيد كل حساب بنكي والإجمالي (للموظفين).",
		"title": "أرصدة البنوك",
		"function": "cash_bank_balances",
		"synonyms": "البنوك\nbank",
		"allowed_party_types": STAFF_TYPES,
		"allowed_group": STAFF_GROUP,
		"settings_overrides": {"account_type": "bank"},
		"disabled_inputs": ["company"],
	},
	{
		"code": "فحص",
		"description": "يعيد النص الذي ترسله، للتأكد من أن الأوامر تصل وتُجاب.",
		"title": "فحص الاتصال",
		"function": "ping",
		"synonyms": "ping\nبنق",
		"allowed_party_types": ["Customer", "Supplier", "Employee"],
		"requires_linked_contact": 0,
	},
)


def _rename(old: str, new: str) -> None:
	if not frappe.db.exists(DT, old):
		return
	merge = bool(frappe.db.exists(DT, new))
	frappe.db.set_value(DT, old, "status", "Inactive", update_modified=False)
	if merge:
		frappe.db.set_value(DT, new, "status", "Inactive", update_modified=False)
		runs = sum(frappe.db.get_value(DT, n, "run_count") or 0 for n in (old, new))
	frappe.rename_doc(DT, old, new, merge=merge, force=True, show_alert=False)
	frappe.db.set_value(DT, new, "code", new, update_modified=False)
	if merge:
		frappe.db.set_value(DT, new, "run_count", runs, update_modified=False)
	print(f"{'merged' if merge else 'renamed'} {old} → {new}")


def _install_functions(company: str | None) -> None:
	"""Install or update each function from its Server Script; a catalog-era row of the same key
	(no script) is replaced. Accounting functions read `company` when given."""
	for key, script in FUNCTION_SCRIPTS.items():
		if not frappe.db.exists("Server Script", script):
			frappe.throw(f"Server Script {script} is missing: run scripts/setup_functions.py first")
		row = frappe.db.get_value("WhatsApp Function", key, ["server_script", "manifest_checksum"], as_dict=True)
		if row and not row.server_script:
			# the old catalog row: its commands are stopped and moved below, the row is re-made
			for cmd in frappe.get_all(DT, filters={"function": key}, pluck="name"):
				frappe.db.set_value(DT, cmd, "status", "Inactive", update_modified=False)
			frappe.db.set_value("WhatsApp Function", key, {"server_script": script}, update_modified=False)
			functions_catalog.update(key, user="Administrator")
			print(f"converted {key} → {script}")
		elif row:
			_spec, checksum = functions_catalog.script_spec(script)
			if checksum != row.manifest_checksum:
				functions_catalog.update(key, user="Administrator")
				print(f"updated {key}")
		else:
			functions_catalog.install(script, user="Administrator")
			print(f"installed {key} ← {script}")
		if company and key in ACCOUNTING:
			functions_catalog.save_values(key, {"company": company})


def _remove_old_functions() -> None:
	for key in OLD_FUNCTIONS:
		if not frappe.db.exists("WhatsApp Function", key):
			continue
		if frappe.db.exists(DT, {"function": key}):
			print(f"kept {key}: a command still uses it")
			continue
		frappe.delete_doc("WhatsApp Function", key, ignore_permissions=True, force=True)
		print(f"removed {key}")


def run(company: str | None = None) -> None:
	if not frappe.db.exists("WhatsApp Contact Group", STAFF_GROUP):
		frappe.throw(f"Contact group {STAFF_GROUP} is missing")
	frappe.set_user("Administrator")
	functions_catalog.clear_cache()
	_install_functions(company)
	for old, new in RENAMES:
		_rename(old, new)
	for spec in COMMANDS:
		payload = {
			"code": spec["code"],
			"title": spec["title"],
			"function": spec["function"],
			"synonyms": spec["synonyms"],
			"allowed_party_types": spec["allowed_party_types"],
			"requires_linked_contact": spec.get("requires_linked_contact", 0),
			"allowed_group": spec.get("allowed_group"),
			"blocked_group": None,
			"description": spec.get("description"),
			"settings_overrides": spec.get("settings_overrides") or {},
			"disabled_inputs": spec.get("disabled_inputs") or [],
			"ask_inputs": spec.get("ask_inputs") or "",
			"templates": [],
			"disabled_replies": [],
		}
		if frappe.db.exists(DT, spec["code"]):
			commands.set_status(spec["code"], "Inactive")
			payload["name"] = spec["code"]
		name = commands.save(payload, user="Administrator")
		commands.set_status(name, "Active")
		print(f"ok {name} → {spec['function']}")
	_remove_old_functions()
	frappe.db.commit()

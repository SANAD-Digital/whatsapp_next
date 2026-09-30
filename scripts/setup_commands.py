"""The standard command set: one Arabic word per installed function, English words as synonyms.

Tidies whatever an earlier seed left behind — `doc` is merged into `فاتورة` (same function, so its
run history follows it) and `ping` becomes `فحص` — then writes every command below through
`services.commands.save`, so the same validation and audit apply as in the editor, and starts it.
Running it again only rewrites the same values.

Customer commands require a number linked to a customer. Staff commands are gated by the
`فريق المحاسبة` group alone: they allow every party type, because a sender linked to a type the
command does not list is refused before the group is read, and a site may have no Employee at all.
`فحص` answers any sender.

Dev sites only — it writes real documents. Run it from the bench:

    cd /home/snd/frappe-bench
    cp apps/whatsapp_next/scripts/setup_commands.py apps/whatsapp_next/whatsapp_next/_setup_cmds.py
    bench --site whatsapp.dev.sanad.digital execute whatsapp_next._setup_cmds.run
    rm apps/whatsapp_next/whatsapp_next/_setup_cmds.py
"""

import frappe

from whatsapp_next.services import commands

DT = "WhatsApp Command"
STAFF_GROUP = "فريق المحاسبة"
STAFF_TYPES = ["Customer", "Supplier", "Employee", "Sales Person"]

# (old name, new name): renamed with `merge` when the new one already exists
RENAMES = (("doc", "فاتورة"), ("ping", "فحص"))

COMMANDS = (
	{
		"code": "رصيد",
		"description": "رصيد حسابك اليوم أو حتى تاريخ تحدده.",
		"title": "رصيد العميل",
		"function": "customer_balance",
		"synonyms": "رصيدي\nكم علي\nbalance",
		"allowed_party_types": ["Customer"],
		"requires_linked_contact": 1,
	},
	{
		"code": "كشف",
		"description": "آخر حركات حسابك خلال الأشهر الأخيرة مع الرصيد الختامي.",
		"title": "كشف حساب العميل",
		"function": "customer_statement",
		"synonyms": "كشف حساب\nكشفي\nstatement",
		"allowed_party_types": ["Customer"],
		"requires_linked_contact": 1,
	},
	{
		"code": "فاتورة",
		"description": "حالة فاتورة أو طلب برقمه، إن كان يخص حسابك.",
		"title": "حالة الفاتورة",
		"function": "document_info",
		"synonyms": "فاتورتي\nحالة الطلب\ninvoice\ndoc",
		"allowed_party_types": ["Customer", "Supplier"],
		"requires_linked_contact": 1,
	},
	{
		"code": "عملاء",
		"description": "أكبر أرصدة العملاء وإجماليها (للموظفين).",
		"title": "أرصدة العملاء",
		"function": "customer_trial_balance",
		"synonyms": "أرصدة العملاء\ncustomers",
		"allowed_party_types": STAFF_TYPES,
		"allowed_group": STAFF_GROUP,
	},
	{
		"code": "موردين",
		"description": "أكبر أرصدة الموردين وإجماليها (للموظفين).",
		"title": "أرصدة الموردين",
		"function": "supplier_trial_balance",
		"synonyms": "أرصدة الموردين\nsuppliers",
		"allowed_party_types": STAFF_TYPES,
		"allowed_group": STAFF_GROUP,
	},
	{
		"code": "صندوق",
		"description": "رصيد كل صندوق وإجمالي الصناديق (للموظفين).",
		"title": "أرصدة الصناديق",
		"function": "cash_balances",
		"synonyms": "الصندوق\ncash",
		"allowed_party_types": STAFF_TYPES,
		"allowed_group": STAFF_GROUP,
	},
	{
		"code": "بنك",
		"description": "رصيد كل حساب بنكي والإجمالي (للموظفين).",
		"title": "أرصدة البنوك",
		"function": "bank_balances",
		"synonyms": "البنوك\nbank",
		"allowed_party_types": STAFF_TYPES,
		"allowed_group": STAFF_GROUP,
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


def _missing_functions() -> list[str]:
	wanted = {c["function"] for c in COMMANDS}
	return sorted(wanted - set(frappe.get_all("WhatsApp Function", filters={"name": ("in", list(wanted))}, pluck="name")))


def run() -> None:
	missing = _missing_functions()
	if missing:
		frappe.throw(f"Install these functions first: {', '.join(missing)}")
	if not frappe.db.exists("WhatsApp Contact Group", STAFF_GROUP):
		frappe.throw(f"Contact group {STAFF_GROUP} is missing")
	frappe.set_user("Administrator")
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
		}
		if frappe.db.exists(DT, spec["code"]):
			commands.set_status(spec["code"], "Inactive")
			payload["name"] = spec["code"]
		name = commands.save(payload, user="Administrator")
		commands.set_status(name, "Active")
		print(f"ok {name} → {spec['function']}")
	frappe.db.commit()

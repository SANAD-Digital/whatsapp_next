"""Demo data for the Contacts screen (screen 12).

The screen's whole subject is the meeting point of three things — a person, a WhatsApp number and
a ledger account — and a fresh site has contacts with none of them. This fills that in from data
that already exists: it takes real `WhatsApp Number` rows (so the counters, "last message" and the
conversation state are true), gives them a name and a phone row, links most of them to a real
Customer / Supplier / Employee, confirms a conversation on a couple and blocks one, so every state
the screen can draw appears at least once.

Dev sites only — it writes real documents. Run it from the bench:

    cd /home/snd/frappe-bench
    cp apps/whatsapp_next/scripts/seed_demo_contacts.py apps/whatsapp_next/whatsapp_next/_seed_c.py
    bench --site whatsapp.dev.sanad.digital execute whatsapp_next._seed_c.run
    bench --site whatsapp.dev.sanad.digital execute whatsapp_next._seed_c.clear   # to undo
    rm apps/whatsapp_next/whatsapp_next/_seed_c.py

Every contact it creates carries `department = "DEMOC"`, a field this screen never reads, so
`clear()` can take exactly its own rows back out.
"""

import random

import frappe

from whatsapp_next.services import permissions

random.seed(20260924)

TAG = "DEMOC"
PARTY_TYPES = ("Customer", "Supplier", "Employee")

NAMES = [
    ("أسماء", "السبيعي", "مؤسسة الساحل للتبريد"),
    ("سارة", "القحطاني", "مؤسسة البيان للتوريدات"),
    ("محمد", "العتيبي", "مجموعة الخليج الغذائية"),
    ("نورة", "الدوسري", "شركة الجوف للتمور"),
    ("خالد", "الشهري", "مؤسسة ركن الإنشاء"),
    ("ريم", "الغامدي", "شركة المدار للتجزئة"),
    ("عبدالله", "الحربي", "مؤسسة الصفوة للمعدات"),
    ("لمى", "الزهراني", "مصنع النخبة للبلاستيك"),
    ("فيصل", "المالكي", "شركة نجد للحلول التقنية"),
    ("هند", "العنزي", "شركة البحر الأحمر اللوجستية"),
    ("Omar", "Haddad", "Cedar Trading"),
    ("Lina", "Khoury", "Levant Foods"),
    ("Tariq", "Nasser", "Nasser Logistics"),
    ("Dana", "Saleh", "Saleh Retail"),
    ("Yousef", "Amin", "Amin Contracting"),
    ("Maya", "Fadel", "Fadel Medical"),
    ("Karim", "Aziz", "Aziz Electronics"),
    ("Rana", "Hakim", "Hakim Textiles"),
]


def _parties() -> list[tuple[str, str]]:
    """Real party documents to link to, so the type and account columns are not all dashes."""
    out: list[tuple[str, str]] = []
    for doctype in PARTY_TYPES:
        if not frappe.db.exists("DocType", doctype):
            continue
        for row in frappe.get_all(doctype, fields=["name"], limit=8):
            out.append((doctype, row.name))
    return out


def _numbers(count: int) -> list[dict]:
    """Individual numbers with the most traffic — their counters make the screen readable."""
    return frappe.get_all(
        "WhatsApp Number",
        filters={"number_type": "Individual", "contact": ("is", "not set")},
        fields=["name", "phone_e164", "outbound_count", "inbound_count", "last_seen"],
        order_by="outbound_count desc, inbound_count desc, last_seen desc",
        limit=count,
    )


def run():
    """Create the demo contacts, link them and set the states the screen draws."""
    parties = _parties()
    numbers = _numbers(len(NAMES))
    if not numbers:
        frappe.throw("No free individual WhatsApp Number rows to seed from.")
    created = []
    for i, number in enumerate(numbers):
        first, last, company = NAMES[i % len(NAMES)]
        doc = frappe.get_doc(
            {
                "doctype": "Contact",
                "first_name": first,
                "last_name": last,
                "company_name": company,
                "department": TAG,
                "email_id": f"demo{i + 1}@example.com" if i % 3 == 0 else None,
            }
        )
        doc.append("phone_nos", {"phone": number.phone_e164, "is_primary_mobile_no": 1})
        # three in four carry a ledger account; one in six carries two (the "more than one" case)
        if parties and i % 4 != 3:
            doc.append("links", dict(zip(("link_doctype", "link_name"), parties[i % len(parties)])))
            if i % 6 == 0 and len(parties) > 1:
                doc.append("links", dict(zip(("link_doctype", "link_name"), parties[(i + 3) % len(parties)])))
        doc.flags.ignore_permissions = True
        doc.insert(ignore_permissions=True)
        created.append(doc.name)
        if doc.get("links"):
            permissions.link_number(number.phone_e164, doc.name)
        if i % 5 == 2:
            permissions.confirm_conversation(
                number.phone_e164, True, note="Talked to on the sales phone before this system."
            )
    if created:
        permissions.toggle_blacklist(
            numbers[1].phone_e164, True, note="Asked us to stop sending notifications."
        )
    frappe.db.commit()
    print(f"seeded {len(created)} demo contacts")  # noqa: T201
    return created


def clear():
    """Remove every contact this script created, and unlink the numbers it touched."""
    names = frappe.get_all("Contact", filters={"department": TAG}, pluck="name")
    for name in names:
        for key in permissions.contact_phones(name):
            try:
                permissions.toggle_blacklist(key, False, note="Demo data removed.")
            except Exception:  # noqa: BLE001 — the blacklist group may be gone
                pass
            if frappe.db.exists("WhatsApp Number", key):
                permissions.unlink_number(key)
        frappe.delete_doc("Contact", name, force=True, ignore_permissions=True)
    frappe.db.commit()
    print(f"removed {len(names)} demo contacts")  # noqa: T201
    return names

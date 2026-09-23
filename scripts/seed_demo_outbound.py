"""Demo data for the Outbound list.

Creates ~100 `WhatsApp Log` rows spread over devices, statuses, document types, errors and the
last four weeks, so grouping, pinning, paging and the phone layout can be exercised against
something realistic. Dev sites only — it writes real documents.

Run it from the bench:

    cd /home/snd/frappe-bench
    cp apps/whatsapp_next/scripts/seed_demo_outbound.py apps/whatsapp_next/whatsapp_next/_seed.py
    bench --site whatsapp.dev.sanad.digital execute whatsapp_next._seed.run
    rm apps/whatsapp_next/whatsapp_next/_seed.py

Reference documents are only linked when they exist, because the Dynamic Link is validated.
"""
import random
import frappe
from frappe.utils import add_to_date, now_datetime

random.seed(20260923)

DEVICES = [d.name for d in frappe.get_all("WhatsApp Device", fields=["name"])]
NAMES = [
    "أسماء السبيعي", "سارة القحطاني", "محمد العتيبي", "نورة الدوسري", "خالد الشهري",
    "ريم الغامدي", "عبدالله الحربي", "لمى الزهراني", "فيصل المالكي", "هند العنزي",
    "Omar Haddad", "Lina Khoury", "Tariq Nasser", "Dana Saleh", "Yousef Amin",
]
REFS = ["Sales Order", "Sales Invoice", "Delivery Note", "Payment Entry", "Quotation", None]
STATUS_WEIGHTS = [
    ("Sent", 26), ("Delivered", 22), ("Read", 16), ("Queued", 10),
    ("Failed", 10), ("Sending", 5), ("Cancelled", 4), ("Held", 4), ("Unsent", 3),
]
ERRORS = ["auth", "rate_limit", "not_on_whatsapp", "device_offline", "media_too_large"]
MSG_TYPES = ["Text", "Document", "Image", "Text", "Text", "Video"]

statuses = [s for s, w in STATUS_WEIGHTS for _ in range(w)]


def make(i):
    status = random.choice(statuses)
    device = random.choice(DEVICES)
    name = random.choice(NAMES)
    ref = random.choice(REFS)
    created = add_to_date(now_datetime(), hours=-random.randint(1, 24 * 28), minutes=-random.randint(0, 59))
    doc = frappe.new_doc("WhatsApp Log")
    doc.device = device
    doc.recipient_type = "Individual"
    doc.display_name = name
    doc.phone = f"05{random.randint(10000000, 99999999)}"
    doc.phone_e164 = "+966" + doc.phone[1:]
    doc.message_type = random.choice(MSG_TYPES)
    doc.body = f"Demo message {i} for {name}."
    doc.status = status
    doc.source_type = "Manual" if not ref else "Document"
    if ref:
        doc.reference_doctype = ref
        doc.reference_name = f"{ref[:3].upper()}-{random.randint(10000, 99999)}"
    doc.is_simulated = 1 if random.random() < 0.12 else 0
    doc.is_test = 1 if random.random() < 0.08 else 0
    doc.queued_at = created
    if status in ("Sent", "Delivered", "Read"):
        doc.sent_at = add_to_date(created, minutes=random.randint(1, 20))
    if status in ("Delivered", "Read"):
        doc.delivered_at = add_to_date(doc.sent_at, minutes=random.randint(1, 30))
    if status == "Read":
        doc.read_at = add_to_date(doc.delivered_at, minutes=random.randint(1, 120))
    if status == "Failed":
        doc.failed_at = add_to_date(created, minutes=random.randint(1, 10))
        doc.error_code = random.choice(ERRORS)
        doc.error_message = f"Provider rejected the message ({doc.error_code})."
    if status == "Cancelled":
        doc.cancelled_at = add_to_date(created, minutes=random.randint(1, 10))
    doc.flags.ignore_permissions = True
    doc.flags.ignore_mandatory = True
    doc.insert(ignore_permissions=True)
    doc.db_set("creation", created, update_modified=False)
    return doc.name


def run():
    made = []
    for i in range(1, 101):
        try:
            made.append(make(i))
        except Exception as e:
            print("skip", i, type(e).__name__, str(e)[:160])
    frappe.db.commit()
    print("created", len(made), "rows; total now", frappe.db.count("WhatsApp Log"))

"""Demo devices for the Devices screen (`page/wa_devices`).

The site's own devices are all `Connected`, so the card grid never shows the three states the
screen has to be judged on: a device waiting to be paired, one that dropped off the network and
one that was signed out on the phone. This adds those, plus a default device with real traffic,
so the offline banner, the status chips, the "pending pairing" notice and the tinted failure
numbers can be seen side by side.

Dev sites only — it writes real documents. Run it from the bench:

    cd /home/snd/frappe-bench
    cp apps/whatsapp_next/scripts/seed_demo_devices.py apps/whatsapp_next/whatsapp_next/_seed_d.py
    bench --site whatsapp.dev.sanad.digital execute whatsapp_next._seed_d.run
    bench --site whatsapp.dev.sanad.digital execute whatsapp_next._seed_d.clear   # to undo
    rm apps/whatsapp_next/whatsapp_next/_seed_d.py

Every device it creates carries `DEMOD-` in `platform_device`, and its messages hang off those
devices, so `clear()` can take it all back out.
"""
import random

import frappe
from frappe.utils import add_to_date, now_datetime

random.seed(20260924)

TAG = "DEMOD-"
NAMES = [
    "أسماء السبيعي", "سارة القحطاني", "محمد العتيبي", "نورة الدوسري", "خالد الشهري",
    "Omar Haddad", "Lina Khoury", "Dana Saleh",
]

# device_name, phone, status, minutes since the last event, is_default, traffic (sent, failed)
DEVICES = [
    ("DEMO Sales device", "0501234567", "Connected", 0, 1, (290, 26)),
    ("DEMO Jeddah branch", "0559028814", "Disconnected", 42, 0, (769, 63)),
    ("DEMO Accounting", None, "Pending QR", 4, 0, (0, 0)),
    ("DEMO Support desk", "0567713390", "Logged Out", 190, 0, (120, 3)),
]


def _log(device, status, when, i):
    """One outbound row, so the card's 30-day tiles read a real number."""
    phone = f"05{random.randint(10000000, 99999999)}"
    doc = frappe.new_doc("WhatsApp Log")
    doc.device = device
    doc.recipient_type = "Individual"
    doc.display_name = random.choice(NAMES)
    doc.phone = phone
    doc.phone_e164 = "+966" + phone[1:]
    doc.message_type = "Text"
    doc.body = "Demo device message."
    doc.status = status
    doc.source_type = "Campaign"
    doc.is_test = 1  # `WhatsApp Log` has no client_ref; the demo rows hang off their demo device
    doc.queued_at = when
    if status in ("Sent", "Delivered", "Read"):
        doc.sent_at = when
    doc.flags.ignore_permissions = True
    doc.flags.ignore_mandatory = True
    doc.insert(ignore_permissions=True)
    doc.db_set("creation", when, update_modified=False)
    return doc.name


def run(scale: int = 12):
    """Create the four demo devices; `scale` divides the prototype's message counts so the seed
    stays small while the ratios (and the failure rate) stay true."""
    now = now_datetime()
    made = []
    for device_name, phone, status, minutes, is_default, (sent, failed) in DEVICES:
        if frappe.db.exists("WhatsApp Device", {"device_name": device_name}):
            continue
        seen = add_to_date(now, minutes=-minutes)
        doc = frappe.new_doc("WhatsApp Device")
        doc.device_name = device_name
        doc.phone = phone
        doc.status = status
        doc.platform_device = f"{TAG}{len(made) + 1:04d}"
        doc.is_default = is_default
        doc.last_seen = seen if status != "Pending QR" else None
        doc.connected_at = add_to_date(seen, days=-3) if status != "Pending QR" else None
        doc.disconnected_at = seen if status == "Disconnected" else None
        doc.logged_out_at = seen if status == "Logged Out" else None
        doc.last_status_event_at = seen
        doc.webhook_registered = 1 if status == "Connected" else 0
        doc.last_error = (
            "The phone lost its internet connection." if status == "Disconnected" else None
        )
        doc.flags.ignore_permissions = True
        doc.insert(ignore_permissions=True)
        made.append(doc.name)
        for i in range(max(0, sent // scale)):
            _log(doc.name, random.choice(["Sent", "Delivered", "Read"]), add_to_date(now, minutes=-random.randint(1, 43200)), i)
        for i in range(max(0, failed // scale)):
            _log(doc.name, "Failed", add_to_date(now, minutes=-random.randint(1, 43200)), 1000 + i)
    frappe.db.commit()
    print("created", len(made), "demo devices:", ", ".join(made))


def clear():
    """Take back every device this script made, and its messages."""
    rows = frappe.get_all(
        "WhatsApp Device", filters={"platform_device": ("like", f"{TAG}%")}, pluck="name"
    )
    logs = frappe.get_all("WhatsApp Log", filters={"device": ("in", rows)}, pluck="name") if rows else []
    for name in logs:
        frappe.delete_doc("WhatsApp Log", name, force=True, ignore_permissions=True)
    for name in rows:
        frappe.db.set_value("WhatsApp Device", name, "is_default", 0, update_modified=False)
        frappe.delete_doc("WhatsApp Device", name, force=True, ignore_permissions=True)
    frappe.db.commit()
    print("removed", len(rows), "demo devices and", len(logs), "messages")

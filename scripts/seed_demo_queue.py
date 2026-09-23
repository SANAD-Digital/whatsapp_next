"""Demo data for the Queue console.

Fills the screen the way a busy hour would: a wave of messages that already left the queue over
the last sixty minutes (what the throughput sparkline draws), a live backlog of `Queued` rows
spread over devices, campaigns and the next hour, a few `Paused` rows and a couple that gave up,
plus a seeded platform-plan reading so "Plan left" shows a number instead of a dash.

Dev sites only — it writes real documents. Run it from the bench:

    cd /home/snd/frappe-bench
    cp apps/whatsapp_next/scripts/seed_demo_queue.py apps/whatsapp_next/whatsapp_next/_seed_q.py
    bench --site whatsapp.dev.sanad.digital execute whatsapp_next._seed_q.run
    bench --site whatsapp.dev.sanad.digital execute whatsapp_next._seed_q.clear   # to undo
    rm apps/whatsapp_next/whatsapp_next/_seed_q.py

Everything it creates carries `DEMOQ-` in `client_ref`, so `clear()` can take it all back out.
"""
import math
import random

import frappe
from frappe.utils import add_to_date, now_datetime

from whatsapp_next.services import dispatch

random.seed(20260924)

TAG = "DEMOQ-"
NAMES = [
    "أسماء السبيعي", "سارة القحطاني", "محمد العتيبي", "نورة الدوسري", "خالد الشهري",
    "ريم الغامدي", "عبدالله الحربي", "لمى الزهراني", "فيصل المالكي", "هند العنزي",
    "Omar Haddad", "Lina Khoury", "Tariq Nasser", "Dana Saleh", "Yousef Amin",
]
REFS: list = []  # filled by `_refs()` with documents that really exist (the Dynamic Link is validated)
DEAD_REASONS = [
    "The number is not on WhatsApp.",
    "The device was logged out before the message could be handed over.",
]


def _refs():
    """Real documents to reference, so the Document type / no. columns are not all dashes."""
    found = []
    for doctype in ("Sales Invoice", "Sales Order", "Delivery Note", "Payment Entry", "Quotation"):
        if not frappe.db.exists("DocType", doctype):
            continue
        for row in frappe.get_all(doctype, fields=["name"], limit=8):
            found.append((doctype, row.name))
    return found or [(None, None)]


def _devices():
    rows = [d.name for d in frappe.get_all("WhatsApp Device", fields=["name"], limit=6)]
    if not rows:
        frappe.throw("Seed a WhatsApp Device first.")
    return rows


def _campaigns():
    return [c.name for c in frappe.get_all("WhatsApp Campaign", fields=["name"], limit=4)] or [None]


def _log(device, name, phone, status, when):
    """The outbound the queue row points at — the queue never exists without one."""
    doc = frappe.new_doc("WhatsApp Log")
    doc.device = device
    doc.recipient_type = "Individual"
    doc.display_name = name
    doc.phone = phone
    doc.phone_e164 = "+966" + phone[1:]
    doc.message_type = "Text"
    doc.body = f"Demo queue message for {name}."
    doc.status = status
    ref_doctype, ref_name = random.choice(REFS) if random.random() < 0.55 else (None, None)
    doc.source_type = "Form" if ref_doctype else random.choice(["Quick Send", "Campaign", "API"])
    if ref_doctype:
        doc.reference_doctype = ref_doctype
        doc.reference_name = ref_name
    doc.queued_at = when
    if status in ("Sent", "Delivered", "Read"):
        doc.sent_at = when
    doc.flags.ignore_permissions = True
    doc.flags.ignore_mandatory = True
    doc.insert(ignore_permissions=True)
    doc.db_set("creation", when, update_modified=False)
    return doc.name


def _item(i, device, campaign, status, scheduled, **extra):
    name = random.choice(NAMES)
    phone = f"05{random.randint(10000000, 99999999)}"
    log_status = "Sent" if status == "Completed" else "Failed" if status == "Dead Letter" else "Queued"
    doc = frappe.new_doc("WhatsApp Queue Item")
    doc.outbound_message = _log(device, name, phone, log_status, scheduled)
    doc.client_ref = f"{TAG}{i:04d}"
    doc.device = device
    doc.campaign = campaign
    doc.phone_e164 = "+966" + phone[1:]
    doc.display_name = name
    doc.priority = random.choice([1, 1, 2, 3, 5])
    doc.scheduled_at = scheduled
    doc.status = status
    doc.max_attempts = 3
    for key, value in extra.items():
        setattr(doc, key, value)
    doc.flags.ignore_permissions = True
    doc.flags.ignore_mandatory = True
    doc.insert(ignore_permissions=True)
    doc.db_set("creation", scheduled, update_modified=False)
    return doc.name


def run(sent: int = 150, waiting: int = 46):
    """`sent` rows spread over the last hour + `waiting` rows still to go out."""
    now = now_datetime()
    devices, campaigns = _devices(), _campaigns()
    REFS[:] = _refs()
    made = 0

    # the hour behind us: a wave, so the sparkline has a shape and not a flat wall
    weights = [max(0.05, 0.55 + 0.45 * math.sin(m / 7.0) + random.uniform(-0.2, 0.2)) for m in range(60)]
    total = sum(weights)
    for minute, weight in enumerate(weights):
        for _ in range(int(round(sent * weight / total))):
            at = add_to_date(now, minutes=-(59 - minute), seconds=-random.randint(0, 59))
            _item(made, random.choice(devices), random.choice(campaigns), "Completed", at, completed_at=at)
            made += 1

    # the backlog in front of us
    for _ in range(waiting):
        at = add_to_date(now, minutes=random.randint(0, 45), seconds=random.randint(0, 59))
        _item(made, random.choice(devices), random.choice(campaigns), "Queued", at)
        made += 1

    # a handful held back by hand, and two the queue gave up on
    for _ in range(5):
        at = add_to_date(now, minutes=random.randint(1, 30))
        _item(
            made, random.choice(devices), random.choice(campaigns), "Paused", at,
            paused_by=frappe.session.user, paused_at=now, pause_reason="Demo: held for review.",
        )
        made += 1
    for _ in range(2):
        at = add_to_date(now, minutes=-random.randint(5, 50))
        _item(
            made, random.choice(devices), random.choice(campaigns), "Dead Letter", at,
            attempts=3, last_error_code="not_on_whatsapp", dead_letter_reason=random.choice(DEAD_REASONS),
        )
        made += 1

    # the provider's plan reading, so "Plan left" is a number on a site with no real platform link
    frappe.cache.set_value(
        dispatch.PLATFORM_QUEUE_CACHE_KEY,
        {
            "counts": {"queued": waiting},
            "messages_per_minute": 60,
            "messages_remaining": 4820,
            "held_reason": None,
            "fetched_at": str(now),
        },
        expires_in_sec=60 * 60 * 24,
    )
    frappe.db.commit()
    print(f"created {made} queue rows (+ one outbound each); queue now holds", frappe.db.count("WhatsApp Queue Item"))


def plan(remaining: int = 4820):
    """Re-arm the platform plan reading on its own.

    Frappe wipes the site cache on plenty of ordinary events (a meta reload, a migrate), and the
    reading lives only there, so "Plan left" falls back to a dash. Call this to put it back.
    """
    frappe.cache.set_value(
        dispatch.PLATFORM_QUEUE_CACHE_KEY,
        {
            "counts": {"queued": frappe.db.count("WhatsApp Queue Item", {"status": "Queued"})},
            "messages_per_minute": 60,
            "messages_remaining": remaining,
            "held_reason": None,
            "fetched_at": str(now_datetime()),
        },
        expires_in_sec=60 * 60 * 24,
    )
    print("plan reading armed:", remaining, "messages remaining")


def clear():
    """Take back every row this script made, and its outbound."""
    rows = frappe.get_all(
        "WhatsApp Queue Item", filters={"client_ref": ("like", f"{TAG}%")}, fields=["name", "outbound_message"]
    )
    for row in rows:
        frappe.delete_doc("WhatsApp Queue Item", row.name, force=True, ignore_permissions=True)
        if row.outbound_message:
            frappe.delete_doc("WhatsApp Log", row.outbound_message, force=True, ignore_permissions=True)
    frappe.cache.delete_value(dispatch.PLATFORM_QUEUE_CACHE_KEY)
    frappe.db.commit()
    print("removed", len(rows), "demo queue rows")

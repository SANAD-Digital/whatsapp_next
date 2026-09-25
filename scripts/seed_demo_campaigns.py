"""Demo data for the Campaigns console.

Creates a spread of campaigns the way a working month looks: one running with its recipients part
sent, one paused mid-way, two scheduled ahead, two drafts, and a handful finished (one of them
partially failed), each with recipients and counters that add up. The outbound rows of the
finished and running campaigns are written too, so "Delivered %", "Read %" and the campaign
counters read from real messages rather than from numbers typed into the campaign.

Dev sites only — it writes real documents. Run it from the bench:

    cd /home/snd/frappe-bench
    cp apps/whatsapp_next/scripts/seed_demo_campaigns.py apps/whatsapp_next/whatsapp_next/_seed_c.py
    bench --site whatsapp.dev.sanad.digital execute whatsapp_next._seed_c.run
    bench --site whatsapp.dev.sanad.digital execute whatsapp_next._seed_c.clear   # to undo
    rm apps/whatsapp_next/whatsapp_next/_seed_c.py

Everything it creates is named with the `DEMO` prefix, so `clear()` can take it all back out.
"""
import random

import frappe
from frappe.utils import add_to_date, now_datetime

random.seed(20260924)

TAG = "DEMO "
NAMES = [
    "أسماء السبيعي", "سارة القحطاني", "محمد العتيبي", "نورة الدوسري", "خالد الشهري",
    "ريم الغامدي", "عبدالله الحربي", "لمى الزهراني", "فيصل المالكي", "هند العنزي",
    "Omar Haddad", "Lina Khoury", "Tariq Nasser", "Dana Saleh", "Yousef Amin",
]

# name, status, recipients, share handed over, share of those that failed, days since it started.
# The counters of a campaign are four *disjoint* buckets (a message that was read is not also
# counted as sent), so every seeded message gets a real `WhatsApp Log` row and the campaign's
# counters are exactly what those rows say. That keeps the totals under the recipients, the way
# the running system writes them.
# A campaign being written is a sequence, not one message: the builder's second step draws the
# waits between them, so at least one demo draft has to have some.
SEQUENCE = [
    {"message_type": "Text", "body": "مرحباً {{ recipient.display_name }} 👋\nنقاط الولاء لديك تنتهي نهاية هذا الشهر."},
    {"message_type": "Text", "body": "يمكنك استبدال النقاط بخصم فوري على طلبك القادم.", "delay_seconds": 45},
    {
        "message_type": "Poll",
        "poll_question": "ما الذي يهمك أكثر؟",
        "poll_options": '["خصم فوري", "شحن مجاني", "هدية"]',
        "delay_seconds": 120,
    },
    {"message_type": "Text", "body": "ردّ بكلمة «نقاط» في أي وقت لمعرفة رصيدك.", "delay_seconds": 60},
]

# name, status, recipients, share handed over, share of those that failed, days since it started,
# and whether it carries the full message sequence.
PLAN = [
    ("DEMO Eid offer — all customers", "Running", 320, 0.62, 0.03, 0, False),
    ("DEMO Invoice reminder — overdue", "Paused", 180, 0.41, 0.06, 0, False),
    ("DEMO New branch in Jeddah", "Scheduled", 240, 0.0, 0.0, None, False),
    ("DEMO Weekly offers — subscribers", "Scheduled", 420, 0.0, 0.0, None, False),
    ("DEMO Customer satisfaction survey", "Draft", 0, 0.0, 0.0, None, False),
    ("DEMO Ramadan working hours", "Draft", 0, 0.0, 0.0, None, False),
    # the draft the builder is for: an audience, a sequence, and nothing sent yet
    ("DEMO Loyalty points expiring — draft", "Draft", 220, 0.0, 0.0, None, True),
    ("DEMO Back to school", "Completed", 260, 1.0, 0.02, 6, False),
    ("DEMO National Day offer", "Completed", 300, 1.0, 0.01, 12, False),
    ("DEMO Loyalty points expiring", "Partially Failed", 220, 1.0, 0.14, 19, False),
    ("DEMO Delivery delay apology", "Cancelled", 120, 0.22, 0.0, 24, False),
]


def _rate_cap():
    from whatsapp_next.whatsapp_next.doctype.whatsapp_campaign.whatsapp_campaign import settings_rate_limit

    return settings_rate_limit() or 60


def _device():
    row = frappe.get_all("WhatsApp Device", fields=["name"], limit=1)
    if not row:
        frappe.throw("Seed a WhatsApp Device first.")
    return row[0].name


def _log(campaign, device, name, phone, status, when):
    """The outbound the campaign's counters are computed from."""
    doc = frappe.new_doc("WhatsApp Log")
    doc.device = device
    doc.campaign = campaign
    doc.recipient_type = "Individual"
    doc.display_name = name
    doc.phone = phone
    doc.phone_e164 = "+966" + phone[1:]
    doc.message_type = "Text"
    doc.body = f"Demo campaign message for {name}."
    doc.status = status
    doc.source_type = "Campaign"
    doc.queued_at = when
    if status in ("Sent", "Delivered", "Read"):
        doc.sent_at = when
    if status in ("Delivered", "Read"):
        doc.delivered_at = add_to_date(when, minutes=1)
    if status == "Read":
        doc.read_at = add_to_date(when, minutes=random.randint(2, 90))
    if status == "Failed":
        doc.failed_at = when
        # the canonical vocabulary (`services/errors.ERROR_CODES`) — the screens read it to say
        # what a failure means and whether the dispatcher may retry it
        doc.error_code = random.choice(["recipient_not_registered", "device_disconnected", "timeout"])
        doc.error_message = "Demo failure."
    doc.flags.ignore_permissions = True
    doc.flags.ignore_mandatory = True
    doc.insert(ignore_permissions=True)
    doc.db_set("creation", when, update_modified=False)
    return doc.name


def _recipient_status(index, sample, status, sent_share, fail_share):
    """The sampled recipients, spread the way the campaign's own counters are spread."""
    if status in ("Draft", "Scheduled"):
        return "Pending"
    if status == "Cancelled":
        return "Cancelled" if index >= int(sample * sent_share) else "Sent"
    handed = int(sample * sent_share)
    failed = int(handed * fail_share)
    if index < failed:
        return "Failed"
    if index < handed:
        return random.choice(["Sent", "Delivered", "Read", "Read"])
    return "Queued" if status in ("Running", "Paused") else "Pending"


def _campaign(device, title, status, total, sent_share, fail_share, days_ago, sequence=False, logs=True):
    started = None if days_ago is None else add_to_date(now_datetime(), days=-days_ago, hours=-random.randint(0, 6))
    doc = frappe.new_doc("WhatsApp Campaign")
    doc.campaign_name = title
    doc.device = device
    doc.status = "Draft"  # the status writer owns the field; set the real one after insert
    # a campaign may not be faster than the queue's own rate (`check_rate_limit`), and a dev site
    # is often set well below the demo's favourite numbers
    doc.messages_per_minute = min(random.choice([20, 25, 30]), _rate_cap())
    if sequence:
        for row in SEQUENCE:
            doc.append("messages", dict(row))
    else:
        doc.append("messages", {"message_type": "Text", "body": f"{title} — demo body for {{{{ name }}}}."})
    # The recipients table shows a real sample, not 1500 rows — and the sample carries the same
    # spread of statuses as the campaign's counters, so the panel and the console never contradict
    # each other (a campaign 60 % handed over whose every recipient reads "Pending").
    # A draft carrying the full sequence is the one the builder is demonstrated on, so it gets its
    # whole audience: the readiness check and the audience step count the rows, not the counter.
    sample = total if sequence else min(total, 25)
    for i in range(sample):
        name = random.choice(NAMES)
        doc.append(
            "recipients",
            {
                "recipient_type": "Individual",
                "display_name": name,
                "phone": f"05{random.randint(10000000, 99999999)}",
                "source_type": "Contact",
                "status": _recipient_status(i, sample, status, sent_share, fail_share),
            },
        )
    doc.flags.ignore_permissions = True
    doc.flags.ignore_mandatory = True
    doc.insert(ignore_permissions=True)

    handed = int(total * sent_share)
    failed = int(handed * fail_share)
    left = max(0, handed - failed)
    # of what went out: some have been read, more have been delivered, the rest only sent
    read = int(left * random.uniform(0.28, 0.45))
    delivered = int((left - read) * random.uniform(0.55, 0.8))
    sent = max(0, left - read - delivered)

    if logs:
        when = started or now_datetime()
        buckets = [("Read", read), ("Delivered", delivered), ("Sent", sent), ("Failed", failed)]
        for status_log, count in buckets:
            for _ in range(count):
                at = add_to_date(when, minutes=random.randint(0, 50), seconds=random.randint(0, 59))
                _log(doc.name, device, random.choice(NAMES), f"05{random.randint(10000000, 99999999)}", status_log, at)

    frappe.db.set_value(
        "WhatsApp Campaign",
        doc.name,
        {
            "status": status,
            "total_recipients": total,
            "initial_recipients": total,
            "sent_count": sent,
            "delivered_count": delivered,
            "read_count": read,
            "failed_count": failed,
            "queued_count": max(0, total - handed) if status in ("Running", "Paused") else 0,
            "first_message_at": add_to_date(started, minutes=1) if (started and handed) else None,
            "last_message_at": add_to_date(started, minutes=50) if (started and handed) else None,
            "ended_at": add_to_date(started, minutes=random.randint(55, 240))
            if (started and status in ("Completed", "Partially Failed", "Cancelled"))
            else None,
            "pause_count": random.choice([0, 0, 1, 2]),
            "started_at": started,
            # a campaign exists before it runs — the timeline reads `creation` as its first event
            "creation": add_to_date(started, minutes=-random.randint(15, 180)) if started else None,
            "scheduled_at": None if status != "Scheduled" else add_to_date(now_datetime(), hours=random.randint(3, 72)),
        },
        update_modified=False,
    )
    return doc.name


def run():
    device = _device()
    made = []
    for title, status, total, sent_share, fail_share, days_ago, sequence in PLAN:
        try:
            made.append(_campaign(device, title, status, total, sent_share, fail_share, days_ago, sequence=sequence))
        except Exception as exc:  # a dev site may miss a template or a permission
            print("skip", title, type(exc).__name__, str(exc)[:160])
    frappe.db.commit()
    print("created", len(made), "campaigns; total now", frappe.db.count("WhatsApp Campaign"))


def clear():
    """Take back every campaign this script made, with its outbound rows."""
    rows = frappe.get_all("WhatsApp Campaign", filters={"campaign_name": ("like", f"{TAG}%")}, fields=["name"])
    for row in rows:
        for log in frappe.get_all("WhatsApp Log", filters={"campaign": row.name}, fields=["name"]):
            frappe.delete_doc("WhatsApp Log", log.name, force=True, ignore_permissions=True)
        frappe.delete_doc("WhatsApp Campaign", row.name, force=True, ignore_permissions=True)
    frappe.db.commit()
    print("removed", len(rows), "demo campaigns")
